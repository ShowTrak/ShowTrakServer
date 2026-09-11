// MonitoringMethods registry.
// Each method is a self-contained module that describes its UI-facing schema
// and provides a Run() implementation. New methods are added by dropping a new
// file into this folder, importing it below, and adding it to MethodModules.
//
// The imports are `import * as` rather than `require()` on purpose. `require()`
// returns `any`, so annotating the array as MonitoringMethod[] checked nothing:
// a method could rename Debug, change Run's signature or drop Settings entirely
// and still compile, failing only when a probe ran in production. A namespace
// import carries the module's real shape, so MethodModules now type-checks all
// of them against the contract in ./types.
import { CreateLogger } from '../Logger';
import { Manager as CacheManager } from '../CacheManager';
import { MethodInfo } from './info';
import { MethodGroups, DEFAULT_GROUP } from './groups';
import type {
  MonitoringActionDef,
  MonitoringActionOptions,
  MonitoringActionResult,
  MonitoringMethod,
  MonitoringResult,
  MonitoringSettingField,
  MonitoringTargetLike,
} from './types';

// General
import * as ping from './ping';
import * as tcpPort from './tcp-port';
import * as http from './http';
import * as httpJson from './http-json';
import * as dns from './dns';
// Lighting (DMX)
import * as sacnUniverse from './sacn-universe';
import * as sacnUniversePriority from './sacn-universe-priority';
import * as artnetUniverse from './artnet-universe';
// Lighting consoles — ETC Eos (OSC)
import * as eos from './eos';
// Lighting consoles — MA Lighting grandMA2 (Telnet remote) & grandMA3 (liveness)
import * as ma2 from './ma2';
import * as ma3 from './ma3';
// Lighting consoles — Avolites Titan (WebAPI)
import * as avolites from './avolites';
// Lighting consoles — ChamSys MagicQ (web server)
import * as chamsys from './chamsys';
// Video
import * as ndiSource from './ndi-source';
// Sound — cue playback & audio networking
import * as qlab5 from './qlab5';
import * as qlab4 from './qlab4';
import * as danteDevice from './dante-device';
// Media Servers
import * as watchoutStatus from './watchout-status';
import * as resolumeStatus from './resolume-status';
import * as disguiseStatus from './disguise-status';
import * as milluminStatus from './millumin-status';
// Control & Messaging
import * as companionStatus from './companion-status';
import * as mqttTopic from './mqtt-topic';
// Digital Signage
import * as brightsign from './brightsign';
// Projectors
import * as pjlink from './pjlink';
import * as snmpProjector from './snmp-projector';
// Power (UPS)
import * as nutUps from './nut-ups';
import * as snmpUps from './snmp-ups';
import * as snmpUpsV3 from './snmp-ups-v3';

const Logger = CreateLogger('MonitoringMethods');

const RUN_CACHE = CacheManager.GetBucket('MonitoringMethods:Run', {
  defaultTtlMs: 1000,
  maxEntries: 2000,
});

// Ordered so methods sharing a Group (see ./groups) are contiguous, which keeps
// the editor's grouped method picker tidy.
const MethodModules: MonitoringMethod[] = [
  // General
  ping,
  tcpPort,
  http,
  httpJson,
  dns,
  // Lighting (DMX)
  sacnUniverse,
  sacnUniversePriority,
  artnetUniverse,
  // Lighting consoles — ETC Eos (OSC)
  eos,
  // Lighting consoles — MA Lighting grandMA2 (Telnet remote) & grandMA3 (liveness)
  ma2,
  ma3,
  // Lighting consoles — Avolites Titan (WebAPI)
  avolites,
  // Lighting consoles — ChamSys MagicQ (web server)
  chamsys,
  // Video
  ndiSource,
  // Sound — cue playback & audio networking
  qlab5,
  qlab4,
  danteDevice,
  // Media Servers
  watchoutStatus,
  resolumeStatus,
  disguiseStatus,
  milluminStatus,
  // Control & Messaging
  companionStatus,
  mqttTopic,
  // Digital Signage
  brightsign,
  // Projectors
  pjlink,
  snmpProjector,
  // Power (UPS)
  nutUps,
  snmpUps,
  snmpUpsV3,
];

const Methods = new Map<string, MonitoringMethod>();

for (const Mod of MethodModules) {
  if (!Mod || !Mod.ID) {
    Logger.warn('Skipping monitoring method with missing ID');
    continue;
  }
  Methods.set(Mod.ID, Mod);
}

// Strip the Run() implementation; the renderer only needs the schema.
function PublicShape(Method: MonitoringMethod) {
  return {
    ID: Method.ID,
    Name: Method.Name,
    Description: Method.Description || '',
    Info: Method.Info || MethodInfo[Method.ID] || null,
    // Grouping label for the editor's method picker. A method may export its own
    // Group; otherwise the central map decides, falling back to "Other".
    Group: Method.Group || MethodGroups[Method.ID] || DEFAULT_GROUP,
    Settings: Array.isArray(Method.Settings) ? Method.Settings : [],
    DefaultInterval: Method.DefaultInterval || 30000,
    // Capability flags default to true; a method opts out by exporting `false`.
    // The editor uses these to hide the Address / Degraded Threshold fields.
    UsesAddress: Method.UsesAddress !== false,
    SupportsLatencyThreshold: Method.SupportsLatencyThreshold !== false,
    // Controllable actions travel with the schema rather than on a channel of
    // their own: the renderer already loads the method catalogue to draw the
    // editor, so a method that gains actions grows a control panel with no
    // second round trip and no client change.
    Actions: Array.isArray(Method.Actions) ? Method.Actions : [],
  };
}

function stableStringify(Value: unknown): string {
  if (Value == null) return 'null';
  if (typeof Value !== 'object') return JSON.stringify(Value);
  if (Array.isArray(Value)) {
    return `[${Value.map((Item) => stableStringify(Item)).join(',')}]`;
  }
  const Obj = Value as Record<string, unknown>;
  const Keys = Object.keys(Obj).sort();
  return `{${Keys.map((Key) => `${JSON.stringify(Key)}:${stableStringify(Obj[Key])}`).join(',')}}`;
}

function getMethodRunCacheKey(
  ID: string,
  Method: MonitoringMethod,
  Target: MonitoringTargetLike
): string {
  // The key MUST be a pure function of exactly what Method.Run() receives, so a
  // cache hit only ever replays a probe computed from identical inputs. Run()
  // reads Address and Settings straight off the target (raw), so we key on those
  // raw values — NOT a normalized/clamped view. Keying on a normalized view was
  // unsound: two targets that merely normalize alike (a timeout past the same
  // clamp bound, or an address differing only in case) would collide onto one
  // cached result even though Run() would probe them differently.
  const Address = String((Target && Target.Address) != null ? Target.Address : '');
  const Settings = (Target && Target.Settings) || {};

  // Allow methods to contribute additional key parts when they use extra
  // target properties beyond Address/Settings.
  const Extra =
    Method && typeof Method.GetRunCacheKeyExtra === 'function'
      ? Method.GetRunCacheKeyExtra(Target, Settings)
      : null;

  return stableStringify({ ID, Address, Settings, Extra });
}

function getMethodRunCacheTtlMs(Method: MonitoringMethod, Target: MonitoringTargetLike): number {
  const DefaultTtl = 1000;
  if (!Method) return DefaultTtl;
  if (typeof Method.GetRunCacheTtlMs === 'function') {
    const Value = Number(Method.GetRunCacheTtlMs(Target));
    return Number.isFinite(Value) ? Math.max(0, Value | 0) : DefaultTtl;
  }
  if (Number.isFinite(Method.RunCacheTtlMs)) {
    return Math.max(0, (Method.RunCacheTtlMs as number) | 0);
  }
  return DefaultTtl;
}

// Coerce a loose object against a MonitoringSettingField schema: fill in
// defaults for anything absent, clamp numbers to Min/Max, force booleans, and
// reject select values that are not in Options. Shared by check settings and
// action parameters so an action's form obeys exactly the same rules as the
// editor's — a clamp that holds in one place cannot drift in the other.
function NormalizeFields(
  Schema: MonitoringSettingField[],
  Input: unknown
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const Source: Record<string, unknown> =
    Input && typeof Input === 'object' ? (Input as Record<string, unknown>) : {};
  for (const Field of Schema) {
    const Key = Field.Key;
    if (!Key) continue;
    let Value: unknown = Source[Key];
    // A 'list' field is an array; only fall back to the default when it is truly
    // absent (not for a legitimately empty array the user cleared).
    if (Field.Type === 'list') {
      const Raw = Array.isArray(Value)
        ? Value
        : Value === undefined || Value === null || Value === ''
          ? Array.isArray(Field.Default)
            ? Field.Default
            : []
          : [Value];
      const Seen = new Set<string>();
      const List: string[] = [];
      for (const Item of Raw as unknown[]) {
        let Entry = String(Item == null ? '' : Item).trim();
        if (Field.ItemType === 'number') {
          const N = Number(Entry);
          if (!Number.isFinite(N)) continue;
          Entry = String(N);
        }
        if (!Entry || Seen.has(Entry)) continue;
        Seen.add(Entry);
        List.push(Entry);
      }
      out[Key] = List;
      continue;
    }
    if (Value === undefined || Value === null || Value === '') {
      Value = Field.Default;
    }
    if (Field.Type === 'number') {
      Value = Number(Value);
      if (!Number.isFinite(Value)) Value = Field.Default;
      if (typeof Field.Min === 'number' && (Value as number) < Field.Min) Value = Field.Min;
      if (typeof Field.Max === 'number' && (Value as number) > Field.Max) Value = Field.Max;
    } else if (Field.Type === 'boolean') {
      Value = !!Value;
    } else if (Field.Type === 'select') {
      // For select fields, validate against options
      const Options = Field.Options || [];
      const ValidValues = Options.map((o) => (typeof o === 'object' ? o.value : o));
      Value = ValidValues.includes(Value as string) ? Value : Field.Default;
      Value = String(Value);
    } else {
      Value = String(Value == null ? '' : Value);
    }
    out[Key] = Value;
  }
  return out;
}

const Manager = {
  GetAll: () => Array.from(Methods.values()).map(PublicShape),

  Get: (ID: string): MonitoringMethod | null => Methods.get(ID) || null,

  Has: (ID: string): boolean => Methods.has(ID),

  // Apply schema defaults to whatever the user submitted.
  NormalizeSettings: (ID: string, Input: unknown): Record<string, unknown> => {
    const Method = Methods.get(ID);
    if (!Method) return {};

    // Allow methods to apply custom normalization logic
    let MethodNormalized: unknown = Input;
    if (typeof Method.NormalizeSettings === 'function') {
      MethodNormalized = Method.NormalizeSettings(Input);
    }

    return NormalizeFields(Array.isArray(Method.Settings) ? Method.Settings : [], MethodNormalized);
  },

  // --- Controllable actions ------------------------------------------------

  GetActions: (ID: string): MonitoringActionDef[] => {
    const Method = Methods.get(ID);
    return Method && Array.isArray(Method.Actions) ? Method.Actions : [];
  },

  GetAction: (ID: string, ActionID: string): MonitoringActionDef | null => {
    const Method = Methods.get(ID);
    if (!Method || !Array.isArray(Method.Actions)) return null;
    return Method.Actions.find((Action) => Action.ID === ActionID) || null;
  },

  // The declared schema IS the allowlist: anything the action did not ask for is
  // dropped rather than handed to the method, so a parameter meant for one
  // action can never ride along with another.
  NormalizeActionParams: (
    ID: string,
    ActionID: string,
    Input: unknown
  ): Record<string, unknown> => {
    const Action = Manager.GetAction(ID, ActionID);
    if (!Action) return {};
    return NormalizeFields(Array.isArray(Action.Params) ? Action.Params : [], Input);
  },

  // Dynamic parameter choices for one check, derived from its latest probe
  // result. A method that offers none (or throws) simply reports nothing —
  // the renderer then falls back to the action's static field schema.
  GetActionOptions: (ID: string, Result: MonitoringResult): MonitoringActionOptions => {
    const Method = Methods.get(ID);
    if (!Method || typeof Method.GetActionOptions !== 'function') return {};
    try {
      const Options = Method.GetActionOptions(Result);
      return Options && typeof Options === 'object' ? Options : {};
    } catch (Err) {
      Logger.warn(
        `GetActionOptions failed for method ${ID}: ${Err && (Err as Error).message ? (Err as Error).message : Err}`
      );
      return {};
    }
  },

  // Label for one action with its parameters bound, as a starred favourite shows
  // it. Falls back to the plain action label, then to the raw id, so a method
  // that describes nothing still produces a usable menu entry.
  DescribeAction: (ID: string, ActionID: string, Params: Record<string, unknown>): string => {
    const Action = Manager.GetAction(ID, ActionID);
    const Method = Methods.get(ID);
    if (Method && typeof Method.DescribeAction === 'function') {
      try {
        const Described = Method.DescribeAction(ActionID, Params || {});
        if (Described && String(Described).trim()) return String(Described).trim();
      } catch (Err) {
        Logger.warn(
          `DescribeAction failed for method ${ID}: ${Err && (Err as Error).message ? (Err as Error).message : Err}`
        );
      }
    }
    return (Action && Action.Label) || ActionID;
  },

  // Perform one action against one target. Unlike Run() this is NEVER cached —
  // an action is a mutation, and replaying a cached "success" would silently
  // swallow the second press of a button.
  RunAction: async (
    ID: string,
    Target: MonitoringTargetLike,
    ActionID: string,
    Params: unknown
  ): Promise<MonitoringActionResult> => {
    const Method = Methods.get(ID);
    if (!Method) return { Success: false, Error: `Unknown method: ${ID}` };
    const Action = Manager.GetAction(ID, ActionID);
    if (!Action) {
      return { Success: false, Error: `"${Method.Name}" has no action "${ActionID}"` };
    }
    if (typeof Method.RunAction !== 'function') {
      return { Success: false, Error: `"${Method.Name}" cannot perform actions` };
    }

    const Normalized = NormalizeFields(Array.isArray(Action.Params) ? Action.Params : [], Params);

    let Result: MonitoringActionResult;
    try {
      Result = await Method.RunAction(Target, ActionID, Normalized);
    } catch (Err) {
      return {
        Success: false,
        Error: Err && (Err as Error).message ? (Err as Error).message : String(Err),
      };
    }

    // The device's state just changed, so every cached read of it is now a lie.
    // Drop both the shared run cache and whatever the method caches privately,
    // so the follow-up probe the caller fires reports the NEW state instead of
    // a snapshot taken moments before the action landed.
    if (Result && Result.Success) Manager.InvalidateRun(ID, Target);

    return Result;
  },

  // Forget the cached probe result for one target, so the next Run() re-probes.
  InvalidateRun: (ID: string, Target: MonitoringTargetLike): void => {
    const Method = Methods.get(ID);
    if (!Method) return;
    RUN_CACHE.Delete(getMethodRunCacheKey(ID, Method, Target));
    if (typeof Method.InvalidateCaches === 'function') {
      try {
        Method.InvalidateCaches(Target);
      } catch (Err) {
        Logger.warn(
          `InvalidateCaches failed for method ${ID}: ${Err && (Err as Error).message ? (Err as Error).message : Err}`
        );
      }
    }
  },

  Run: async (ID: string, Target: MonitoringTargetLike): Promise<MonitoringResult> => {
    const Method = Methods.get(ID);
    // A saved check whose method no longer exists (e.g. a removed/renamed method)
    // surfaces as Degraded rather than Offline, so the operator is alerted to fix
    // it instead of it silently reading as an outage.
    if (!Method) {
      return {
        Success: true,
        Degraded: true,
        DegradedReason: `Unknown method: ${ID}`,
        LatencyMs: null,
      };
    }

    const CacheKey = getMethodRunCacheKey(ID, Method, Target);
    const CacheTtlMs = getMethodRunCacheTtlMs(Method, Target);
    try {
      return (await RUN_CACHE.GetOrCreate(CacheKey, () => Method.Run(Target), {
        ttlMs: CacheTtlMs,
      })) as MonitoringResult;
    } catch (Err) {
      return {
        Success: false,
        Error: Err && (Err as Error).message ? (Err as Error).message : String(Err),
      };
    }
  },

  // Build the HTML "last response" debug panel for a check. Each method may
  // expose an optional Debug(Result, Target) returning an HTML string; the method
  // is responsible for escaping any untrusted values it embeds. Returns null when
  // the method provides no debug view or rendering fails.
  BuildDebug: (
    ID: string,
    Result: MonitoringResult,
    Target: MonitoringTargetLike
  ): string | null => {
    const Method = Methods.get(ID);
    if (!Method || typeof Method.Debug !== 'function') return null;
    try {
      const Html = Method.Debug(Result, Target);
      return typeof Html === 'string' && Html.length ? Html : null;
    } catch (Err) {
      Logger.warn(
        `Debug renderer failed for method ${ID}: ${Err && (Err as Error).message ? (Err as Error).message : Err}`
      );
      return null;
    }
  },
};

export { Manager, getMethodRunCacheKey, stableStringify };
