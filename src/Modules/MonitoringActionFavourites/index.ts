// MonitoringActionFavourites
//
// The starred check actions that appear in the right-click menu whenever
// monitoring targets are selected.
//
// A favourite is one (Method, ActionID, Params) triple. The parameters are part
// of its identity, so "Set Input -> Digital 1" and "Set Input -> HDMI 2" are two
// entries rather than one whose value has to be re-typed at the moment it is
// needed. They are GLOBAL, not per-check: a rig with eight projectors wants
// "Power On" on the menu once. Which targets a given press acts on is decided at
// run time from the selection (see MonitoringTargetManager.RunAction), so a
// favourite is a shortcut, never a permission.
import { Manager as DB } from '../DB';
import { CreateLogger } from '../Logger';
import { CreateMonitoringActionFavouritesRepository } from '../DB/repositories/monitoring-action-favourites';
import { Manager as BroadcastManager } from '../Broadcast';
import { Manager as MonitoringMethods, stableStringify } from '../MonitoringMethods';
import { Ok, Fail } from '../Utils';
import type { Result } from '../../types/result';
import type { MonitoringActionFavouriteView } from '@showtrak/protocol';

const Logger = CreateLogger('MonitoringActionFavourites');
const Repo = CreateMonitoringActionFavouritesRepository(DB);

interface Favourite {
  FavouriteID: number;
  Method: string;
  ActionID: string;
  Params: Record<string, unknown>;
  /** The canonical JSON the row is keyed on — see CanonicalParams. */
  ParamsKey: string;
  Weight: number;
}

let FavouriteList: Favourite[] = [];
let Initialized = false;
let InitPromise: Promise<void> | null = null;

/**
 * The exact string a favourite's Params column holds.
 *
 * Key order has to be deterministic or the same favourite would produce two
 * different rows depending on which order the renderer happened to build the
 * object in, and the unique index would never catch the duplicate. Parameters
 * are normalized through the action's own schema first, so a value that the
 * form would clamp is stored clamped — the identity matches what the action
 * will actually do, not what was typed.
 */
function CanonicalParams(Method: string, ActionID: string, Params: unknown): string {
  return stableStringify(MonitoringMethods.NormalizeActionParams(Method, ActionID, Params));
}

function ParseParams(Raw: unknown): Record<string, unknown> {
  if (!Raw) return {};
  if (typeof Raw === 'object') return Raw as Record<string, unknown>;
  try {
    const Parsed = JSON.parse(String(Raw));
    return Parsed && typeof Parsed === 'object' ? (Parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function ToView(Entry: Favourite): MonitoringActionFavouriteView {
  const Action = MonitoringMethods.GetAction(Entry.Method, Entry.ActionID);
  return {
    FavouriteID: Entry.FavouriteID,
    Method: Entry.Method,
    ActionID: Entry.ActionID,
    Params: Entry.Params,
    Label: MonitoringMethods.DescribeAction(Entry.Method, Entry.ActionID, Entry.Params),
    Icon: (Action && Action.Icon) || 'lightning',
    Weight: Entry.Weight,
  };
}

function Broadcast(): void {
  BroadcastManager.emit('SetFullMonitoringActionFavouriteList', Manager.GetAll());
}

const Manager = {
  async Init(): Promise<void> {
    if (InitPromise) return InitPromise;
    InitPromise = (async () => {
      const [Err, Rows] = await Repo.GetAll();
      if (Err) {
        Logger.error('Failed to load monitoring action favourites:', Err);
        FavouriteList = [];
        Initialized = true;
        return;
      }

      const Loaded: Favourite[] = [];
      for (const Row of Rows || []) {
        // A favourite whose method or action no longer exists would render as a
        // menu entry that silently does nothing, so it is dropped at load rather
        // than shown. Methods are only ever removed by a code change, so this is
        // a one-off cleanup, not a hot path.
        if (!MonitoringMethods.GetAction(Row.Method, Row.ActionID)) {
          Logger.warn(`Dropping favourite for unknown action "${Row.Method}/${Row.ActionID}"`);
          await Repo.Delete(Row.FavouriteID);
          continue;
        }
        const Params = ParseParams(Row.Params);
        Loaded.push({
          FavouriteID: Row.FavouriteID,
          Method: Row.Method,
          ActionID: Row.ActionID,
          Params,
          ParamsKey: String(Row.Params ?? '{}'),
          Weight: typeof Row.Weight === 'number' ? Row.Weight : 100,
        });
      }
      FavouriteList = Loaded;
      Initialized = true;
      Logger.log(`Loaded ${FavouriteList.length} starred check actions`);
    })();
    try {
      await InitPromise;
    } finally {
      InitPromise = null;
    }
  },

  async Reload(): Promise<void> {
    Initialized = false;
    FavouriteList = [];
    await Manager.Init();
    Broadcast();
  },

  GetAll(): MonitoringActionFavouriteView[] {
    return FavouriteList.map(ToView);
  },

  /** True when this exact action + parameter combination is starred. */
  Has(Method: string, ActionID: string, Params: unknown): boolean {
    const Key = CanonicalParams(Method, ActionID, Params);
    return FavouriteList.some(
      (Entry) => Entry.Method === Method && Entry.ActionID === ActionID && Entry.ParamsKey === Key
    );
  },

  /**
   * Star or unstar one action + parameter combination. Idempotent in both
   * directions — the star is a toggle in a UI that may be several clicks ahead
   * of the database, so setting a state it is already in must succeed quietly.
   */
  async Set(
    Method: string,
    ActionID: string,
    Params: unknown,
    Favourite: boolean
  ): Promise<Result<MonitoringActionFavouriteView[]>> {
    if (!Initialized) await Manager.Init();
    if (!MonitoringMethods.GetAction(Method, ActionID)) {
      return Fail(`Unknown action "${ActionID}" for method "${Method}"`);
    }

    const Key = CanonicalParams(Method, ActionID, Params);
    const Existing = FavouriteList.find(
      (Entry) => Entry.Method === Method && Entry.ActionID === ActionID && Entry.ParamsKey === Key
    );

    if (Favourite) {
      if (Existing) return Ok(Manager.GetAll());
      const Now = Date.now();
      // New favourites land at the end of the menu, which is where the operator
      // who just starred one expects to find it.
      const Weight = FavouriteList.reduce((Max, Entry) => Math.max(Max, Entry.Weight), 0) + 1;
      const [Err, Info] = await Repo.Insert(Method, ActionID, Key, Weight, Now);
      if (Err) return Fail('Failed to save the starred action');
      FavouriteList.push({
        FavouriteID: Info ? Info.lastID : 0,
        Method,
        ActionID,
        Params: ParseParams(Key),
        ParamsKey: Key,
        Weight,
      });
    } else {
      if (!Existing) return Ok(Manager.GetAll());
      const [Err] = await Repo.DeleteByIdentity(Method, ActionID, Key);
      if (Err) return Fail('Failed to remove the starred action');
      FavouriteList = FavouriteList.filter((Entry) => Entry !== Existing);
    }

    Broadcast();
    return Ok(Manager.GetAll());
  },
};

export { Manager, CanonicalParams };
