// FreeKioskManager
//
// Owns the lifecycle of FreeKiosk terminals: persistence, CRUD, slugs, polling
// loops, group ordering, and the fan-out of control commands and captures.
// Every reading is kept in RAM by the FreeKioskTerminal instances and surfaced
// to the UI via the 'FreeKioskTerminalUpdated' / 'FreeKioskTerminalListChanged'
// broadcast events, matching how monitors and dummy clients behave.
import { Manager as DB } from '../DB';
import { CreateFreeKioskTerminalsRepository } from '../DB/repositories/freekiosk-terminals';
import { Manager as BroadcastManager } from '../Broadcast';
import { Ok, Fail } from '../Utils';
import { createGroupOrdering } from '../Shared/group-ordering';
import { CreateLogger } from '../Logger';
import * as SlugService from '../Slug';
import * as FreeKioskClient from '../FreeKiosk/client';
import { GetFreeKioskCommand } from '../FreeKiosk/commands';
import {
  BuildDefaultAlarmSettings,
  BuildFreeKioskAlarmFields,
  DisplayModeLabel,
  FREEKIOSK_METRICS_BY_KEY,
  GetDisplayMode,
  OPERATOR_LABELS,
} from '../FreeKiosk/metrics';
import type { FreeKioskOperator } from '../FreeKiosk/metrics';
import { RecordAction, RecordEdit, RecordUpdate } from '../AuditLog/edits';
import { Entity, Line, Value } from '../AuditLog/message';
import { DiffFields, FormatValue, type FieldSpec } from '../AuditLog/diff';
import {
  AuditBefore,
  AuditStep,
  DiffSettings,
  GroupTitle,
  RecordGroupMove,
  Seconds,
} from '../Shared/audit-names';
import type { Result } from '../../types/result';
import type { FreeKioskCamera, FreeKioskImage } from '../FreeKiosk/types';

import {
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  DEFAULT_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_PORT,
  ClampInterval,
  ClampTimeout,
  ClampPort,
  NormalizeAddress,
  IsValidAddress,
  RandomSuffix,
  ParseSettings,
} from './normalize';
import { FreeKioskTerminal } from './terminal';
import type { FreeKioskTerminalSnapshot } from './terminal';

const Logger = CreateLogger('FreeKiosk');
const TerminalsRepo = CreateFreeKioskTerminalsRepository(DB);

let TerminalList: FreeKioskTerminal[] = [];

function GenerateUUID(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return require('crypto').randomUUID();
}

export interface FreeKioskCommandOutcome {
  UUID: string;
  Success: boolean;
  Error: string | null;
}

export interface FreeKioskCommandSummary {
  Total: number;
  Succeeded: number;
  Failed: number;
  Results: FreeKioskCommandOutcome[];
}

function Summarize(Results: FreeKioskCommandOutcome[]): FreeKioskCommandSummary {
  const Succeeded = Results.filter((Result) => Result.Success).length;
  return {
    Total: Results.length,
    Succeeded,
    Failed: Results.length - Succeeded,
    Results,
  };
}

// --- Audit log ---------------------------------------------------------------

interface KioskAuditFields {
  Nickname: string;
  Address: string;
  Port: number;
  ApiKey: string | null;
  Slug: string | null;
  Group: string;
  Interval: string | null;
  Timeout: string | null;
}

const KIOSK_AUDIT_FIELDS: readonly FieldSpec<KioskAuditFields>[] = [
  { Key: 'Nickname', Label: 'Title' },
  { Key: 'Address', Label: 'IP address or hostname' },
  { Key: 'Port', Label: 'Port' },
  { Key: 'ApiKey', Label: 'API key', Secret: true },
  { Key: 'Slug', Label: 'Slug' },
  { Key: 'Group', Label: 'Group' },
  { Key: 'Interval', Label: 'Poll Interval' },
  { Key: 'Timeout', Label: 'Request Timeout' },
];

async function KioskAuditFieldsOf(Terminal: FreeKioskTerminal): Promise<KioskAuditFields> {
  return {
    Nickname: Terminal.Nickname,
    Address: Terminal.Address,
    Port: Terminal.Port,
    ApiKey: Terminal.ApiKey,
    Slug: Terminal.Slug,
    Group: await GroupTitle(Terminal.GroupID),
    Interval: Seconds(Terminal.Interval / 1000),
    Timeout: Seconds(Terminal.TimeoutMs / 1000),
  };
}

// Settings keys are the alarm editor's fields: a group switch or the display
// mode by its own label, an alarm's parts by the metric they belong to.
const ALARM_PART_LABELS: Record<string, string> = {
  On: 'alarm',
  Op: 'expected',
  V: 'value',
  V2: 'second value',
};
let KioskFieldLabels: Map<string, string> | null = null;

function KioskSettingLabel(Key: string): string {
  const Alarm = Key.match(/^A_(.+)_(On|Op|V|V2)$/);
  if (Alarm) {
    const Metric = FREEKIOSK_METRICS_BY_KEY.get(Alarm[1]!);
    return `${Metric ? Metric.Label : Alarm[1]} ${ALARM_PART_LABELS[Alarm[2]!]}`;
  }
  if (!KioskFieldLabels) {
    KioskFieldLabels = new Map(
      BuildFreeKioskAlarmFields().map((Field) => [Field.Key, Field.Label])
    );
  }
  return KioskFieldLabels.get(Key) || Key;
}

function KioskSettingValue(Key: string, Value: unknown): string | null {
  if (/_Op$/.test(Key) && typeof Value === 'string') {
    return OPERATOR_LABELS[Value as FreeKioskOperator] || Value;
  }
  return FormatValue(Value);
}

function KioskAuditBase(Terminal: FreeKioskTerminal) {
  return {
    EntityType: 'freekiosk' as const,
    EntityID: Terminal.UUID,
    EntityName: Terminal.Nickname,
  };
}

// One action line per terminal it reached, so each terminal's history shows it.
function RecordKioskActions(
  UUIDs: readonly string[],
  Summary: (Name: string) => ReturnType<typeof Line>
) {
  return AuditStep(() => {
    for (const UUID of UUIDs) {
      const Terminal = TerminalList.find((Entry) => Entry.UUID === UUID);
      if (!Terminal) continue;
      RecordAction({ ...KioskAuditBase(Terminal), Summary: Summary(Terminal.Nickname) });
    }
  });
}

const Manager = {
  Initialized: false,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  DEFAULT_PORT,

  async GenerateDefaults() {
    const Suffix = RandomSuffix();
    return {
      Nickname: `FreeKiosk ${Suffix}`,
      Address: '',
      Port: DEFAULT_PORT,
      Interval: DEFAULT_INTERVAL_MS,
      TimeoutMs: DEFAULT_TIMEOUT_MS,
      // "Not displaying content" is the one alarm armed out of the box: a
      // terminal whose API answers but whose screen shows nothing is the failure
      // this feature exists to catch, and it needs no configuration to be useful.
      Settings: BuildDefaultAlarmSettings(),
    };
  },

  async Init(): Promise<void> {
    const [Err, Rows] = await TerminalsRepo.GetAll();
    if (Err) {
      Logger.error('Failed to load FreeKiosk terminals', Err);
      Manager.Initialized = true;
      TerminalList = [];
      return;
    }
    TerminalList = (Rows || []).map((Row) => new FreeKioskTerminal(Row));
    Manager.Initialized = true;
    for (const Terminal of TerminalList) Terminal.StartLoop();
    BroadcastManager.emit('FreeKioskTerminalListChanged');
  },

  // Rebuild runtime state from the DB after external bulk changes (opening a
  // different show file, importing config).
  async Reload(): Promise<void> {
    for (const Terminal of TerminalList) Terminal.StopLoop();
    TerminalList = [];
    Manager.Initialized = false;
    await Manager.Init();
  },

  async Shutdown(): Promise<void> {
    for (const Terminal of TerminalList) {
      try {
        Terminal.StopLoop();
      } catch {
        /* intentional: stopping each loop during shutdown is best-effort */
      }
    }
  },

  async GetAll(): Promise<Result<FreeKioskTerminalSnapshot[]>> {
    if (!Manager.Initialized) await Manager.Init();
    return [null, TerminalList.map((Terminal) => Terminal.ToJSON())];
  },

  GetAllSync(): FreeKioskTerminalSnapshot[] {
    return TerminalList.map((Terminal) => Terminal.ToJSON());
  },

  async Get(UUID: string): Promise<[string | null, FreeKioskTerminalSnapshot | null]> {
    const Terminal = TerminalList.find((Entry) => Entry.UUID === UUID);
    if (!Terminal) return ['FreeKiosk terminal not found', null];
    return [null, Terminal.ToJSON()];
  },

  /**
   * The editor's read: the snapshot plus the stored API key.
   *
   * ToJSON() deliberately omits the key — it is pushed to every Web UI on every
   * poll and stringified into alert history. This is the one deliberate
   * exception, and it stays an exception by being a direct reply to a single
   * UUID rather than anything that gets broadcast.
   */
  async GetForEditor(
    UUID: string
  ): Promise<[string | null, (FreeKioskTerminalSnapshot & { ApiKey: string | null }) | null]> {
    const Terminal = TerminalList.find((Entry) => Entry.UUID === UUID);
    if (!Terminal) return ['FreeKiosk terminal not found', null];
    return [null, { ...Terminal.ToJSON(), ApiKey: Terminal.ApiKey }];
  },

  async GetBySlug(Slug: string): Promise<FreeKioskTerminalSnapshot | null> {
    if (!Slug) return null;
    if (!Manager.Initialized) await Manager.Init();
    const Lower = String(Slug).toLowerCase();
    const Found = TerminalList.find((Entry) => String(Entry.Slug || '').toLowerCase() === Lower);
    return Found ? Found.ToJSON() : null;
  },

  async Create(Payload: Record<string, unknown> = {}): Promise<Result<FreeKioskTerminalSnapshot>> {
    if (!Manager.Initialized) await Manager.Init();
    const Now = Date.now();
    const Defaults = await Manager.GenerateDefaults();

    const Address = NormalizeAddress(Payload.Address);
    if (!IsValidAddress(Address)) return Fail('Enter a valid IP address or hostname');

    const Nickname = String(Payload.Nickname ?? '').trim() || Defaults.Nickname;
    const Port = ClampPort(
      Object.prototype.hasOwnProperty.call(Payload, 'Port') ? Payload.Port : Defaults.Port
    );
    const Interval = ClampInterval(
      Object.prototype.hasOwnProperty.call(Payload, 'Interval')
        ? Payload.Interval
        : Defaults.Interval
    );
    const TimeoutMs = ClampTimeout(
      Object.prototype.hasOwnProperty.call(Payload, 'TimeoutMs')
        ? Payload.TimeoutMs
        : Defaults.TimeoutMs
    );
    const ApiKey = String(Payload.ApiKey ?? '').trim() || null;
    const Settings = Object.prototype.hasOwnProperty.call(Payload, 'Settings')
      ? ParseSettings(Payload.Settings)
      : Defaults.Settings;
    const GroupID = (Payload.GroupID == null ? null : Payload.GroupID) as number | null;
    const Weight = typeof Payload.Weight === 'number' ? Payload.Weight : 100;

    const UUID = GenerateUUID();
    const RequestedSlug = Object.prototype.hasOwnProperty.call(Payload, 'Slug')
      ? SlugService.Slugify(Payload.Slug)
      : '';
    // The slug namespace spans clients, monitors, dummies and terminals alike,
    // so a generated one has to be resolved through the shared service.
    const Slug = RequestedSlug
      ? RequestedSlug
      : await SlugService.GenerateUniqueClientSlug(Nickname || `FreeKiosk-${RandomSuffix()}`);
    if (!SlugService.IsValidSlug(Slug)) {
      return Fail('Slug must contain at least one letter, number, - or _');
    }
    if (await SlugService.IsClientSlugTaken(Slug)) {
      return Fail(`Slug "${Slug}" is already in use`);
    }

    const [Err] = await TerminalsRepo.Insert(
      UUID,
      Nickname,
      Address,
      Port,
      ApiKey,
      Interval,
      TimeoutMs,
      JSON.stringify(Settings),
      GroupID,
      Weight,
      Slug,
      Now
    );
    if (Err) return Fail('Failed to create FreeKiosk terminal');

    const Terminal = new FreeKioskTerminal({
      UUID,
      Nickname,
      Address,
      Port,
      ApiKey,
      Interval,
      TimeoutMs,
      Settings,
      GroupID,
      Weight,
      Slug,
      Timestamp: Now,
    });
    TerminalList.push(Terminal);
    Terminal.StartLoop();
    BroadcastManager.emit('FreeKioskTerminalListChanged');
    await AuditStep(() =>
      RecordEdit({ ...KioskAuditBase(Terminal), Summary: Line('Created ', Entity(Nickname)) })
    );
    return Ok(Terminal.ToJSON());
  },

  async Update(
    UUID: string,
    Payload: Record<string, unknown> = {}
  ): Promise<Result<FreeKioskTerminalSnapshot>> {
    const Terminal = TerminalList.find((Entry) => Entry.UUID === UUID);
    if (!Terminal) return Fail('FreeKiosk terminal not found');
    const Before = await AuditBefore(async () => ({
      Fields: await KioskAuditFieldsOf(Terminal),
      Settings: { ...Terminal.Settings },
    }));

    let NextSlug = Terminal.Slug;
    if (Object.prototype.hasOwnProperty.call(Payload, 'Slug')) {
      NextSlug = SlugService.Slugify(Payload.Slug);
      if (!SlugService.IsValidSlug(NextSlug)) {
        return Fail('Slug must contain at least one letter, number, - or _');
      }
      // IsClientSlugTaken excludes this terminal's own slot, so a no-op rename
      // passes rather than colliding with itself.
      if (await SlugService.IsClientSlugTaken(NextSlug, SlugService.KioskOwner(UUID))) {
        return Fail(`Slug "${NextSlug}" is already in use`);
      }
    }

    const NextAddress = Object.prototype.hasOwnProperty.call(Payload, 'Address')
      ? NormalizeAddress(Payload.Address)
      : Terminal.Address;
    if (!IsValidAddress(NextAddress)) return Fail('Enter a valid IP address or hostname');

    const NextNickname = String(Payload.Nickname ?? '').trim() || Terminal.Nickname;
    const NextPort = ClampPort(
      Object.prototype.hasOwnProperty.call(Payload, 'Port') ? Payload.Port : Terminal.Port
    );
    const NextInterval = ClampInterval(
      Object.prototype.hasOwnProperty.call(Payload, 'Interval')
        ? Payload.Interval
        : Terminal.Interval
    );
    const NextTimeout = ClampTimeout(
      Object.prototype.hasOwnProperty.call(Payload, 'TimeoutMs')
        ? Payload.TimeoutMs
        : Terminal.TimeoutMs
    );
    const NextSettings = Object.prototype.hasOwnProperty.call(Payload, 'Settings')
      ? ParseSettings(Payload.Settings)
      : Terminal.Settings;
    const NextGroupID = (
      Object.prototype.hasOwnProperty.call(Payload, 'GroupID') ? Payload.GroupID : Terminal.GroupID
    ) as number | null;

    const [Err] = await TerminalsRepo.UpdateDetails(
      NextNickname,
      NextAddress,
      NextPort,
      NextInterval,
      NextTimeout,
      JSON.stringify(NextSettings),
      NextGroupID,
      UUID
    );
    if (Err) return Fail('Failed to update FreeKiosk terminal');

    // The API key is written separately, and only when the payload actually
    // carries one. The editor never receives the stored key back, so treating a
    // blank field as "clear it" would wipe the key on every unrelated edit;
    // clearing is an explicit ClearApiKey flag instead.
    if (Object.prototype.hasOwnProperty.call(Payload, 'ClearApiKey') && Payload.ClearApiKey) {
      const [KeyErr] = await TerminalsRepo.UpdateApiKey(null, UUID);
      if (KeyErr) return Fail('Failed to clear the API key');
      Terminal.ApiKey = null;
    } else if (String(Payload.ApiKey ?? '').trim()) {
      const NextKey = String(Payload.ApiKey).trim();
      const [KeyErr] = await TerminalsRepo.UpdateApiKey(NextKey, UUID);
      if (KeyErr) return Fail('Failed to update the API key');
      Terminal.ApiKey = NextKey;
    }

    if (NextSlug !== Terminal.Slug && NextSlug) {
      const [SlugErr] = await TerminalsRepo.UpdateSlug(NextSlug, UUID);
      if (SlugErr) return Fail('Failed to update the slug');
      Terminal.Slug = NextSlug;
    }

    Terminal.Nickname = NextNickname;
    Terminal.Address = NextAddress;
    Terminal.Port = NextPort;
    Terminal.TimeoutMs = NextTimeout;
    Terminal.Settings = NextSettings;
    Terminal.GroupID = NextGroupID == null ? null : NextGroupID;
    Terminal.SetInterval(NextInterval);
    // Judge the readings already on screen against the edited conditions, so an
    // alarm raises or clears as the editor saves instead of on the next poll.
    // The broadcast below carries the new verdict to the tile and the alerts.
    Terminal.ReevaluateAlarms();

    BroadcastManager.emit('FreeKioskTerminalUpdated', Terminal.ToJSON());
    BroadcastManager.emit('FreeKioskTerminalListChanged');
    if (Before) {
      await AuditStep(async () =>
        RecordUpdate({
          ...KioskAuditBase(Terminal),
          Summary: Line('Edited ', Entity(Terminal.Nickname)),
          Changes: [
            ...DiffFields(Before.Fields, await KioskAuditFieldsOf(Terminal), KIOSK_AUDIT_FIELDS),
            ...DiffSettings(Before.Settings, Terminal.Settings, {
              Label: KioskSettingLabel,
              Format: KioskSettingValue,
            }),
          ],
        })
      );
    }
    return Ok(Terminal.ToJSON());
  },

  async Delete(UUID: string): Promise<Result<boolean>> {
    const Index = TerminalList.findIndex((Entry) => Entry.UUID === UUID);
    if (Index === -1) return Fail('FreeKiosk terminal not found');
    const Terminal = TerminalList[Index]!;
    Terminal.StopLoop();
    const [Err] = await TerminalsRepo.Delete(UUID);
    if (Err) return Fail('Failed to delete FreeKiosk terminal');
    TerminalList.splice(Index, 1);
    BroadcastManager.emit('FreeKioskTerminalListChanged');
    await AuditStep(() =>
      RecordEdit({
        ...KioskAuditBase(Terminal),
        Summary: Line('Deleted ', Entity(Terminal.Nickname)),
        Severity: 'warning',
      })
    );
    return Ok(true);
  },

  /** Poll now, outside the loop's schedule. Fans out over a selection. */
  async RunNow(UUIDs: string[]): Promise<Result<FreeKioskCommandSummary>> {
    if (!Manager.Initialized) await Manager.Init();
    const Results: FreeKioskCommandOutcome[] = [];
    await Promise.all(
      UUIDs.map(async (UUID) => {
        const Terminal = TerminalList.find((Entry) => Entry.UUID === UUID);
        if (!Terminal) {
          Results.push({ UUID, Success: false, Error: 'FreeKiosk terminal not found' });
          return;
        }
        const Success = await Terminal.RunNow();
        Results.push({
          UUID,
          Success,
          Error: Success ? null : Terminal.LastError,
        });
      })
    );
    await RecordKioskActions(UUIDs, (Name) => Line('Polled ', Entity(Name), ' now'));
    return Ok(Summarize(Results));
  },

  /**
   * Send one command to every named terminal.
   *
   * Failures are per-UUID and never fatal to the batch: a mixed selection where
   * one terminal has remote control disabled must still act on the others, and
   * the caller needs to be told which ones did not take it.
   */
  async SendCommand(
    UUIDs: string[],
    CommandID: string,
    Params: Record<string, unknown> = {}
  ): Promise<Result<FreeKioskCommandSummary>> {
    if (!Manager.Initialized) await Manager.Init();
    // The command map IS the allowlist — an unknown id never reaches the device.
    const Command = GetFreeKioskCommand(CommandID);
    if (!Command) return Fail(`Unknown FreeKiosk command "${CommandID}"`);

    const Results: FreeKioskCommandOutcome[] = [];
    await Promise.all(
      UUIDs.map(async (UUID) => {
        const Terminal = TerminalList.find((Entry) => Entry.UUID === UUID);
        if (!Terminal) {
          Results.push({ UUID, Success: false, Error: 'FreeKiosk terminal not found' });
          return;
        }
        // Refuse a command the terminal's mode makes meaningless, rather than
        // sending it and reporting whatever the device says. FreeKiosk accepts a
        // WebView command in app mode, answers executed:true and does nothing —
        // so forwarding it would turn a silent no-op into a reported success.
        if (Command.Modes && !Command.Modes.includes(GetDisplayMode(Terminal.Settings))) {
          Results.push({
            UUID,
            Success: false,
            Error: `${Command.Label} does nothing while this terminal is in ${DisplayModeLabel(
              GetDisplayMode(Terminal.Settings)
            )} mode`,
          });
          return;
        }

        const [Err] = await FreeKioskClient.SendCommand(
          Terminal.Connection(),
          Command.Method,
          Command.Path,
          Command.Method === 'POST' ? (Params as Record<string, unknown>) : null,
          !!Command.ExpectDisconnect
        );

        // A 403 is the device's remote-control kill switch, not an auth failure.
        // Recording it lets the UI disable its controls and say why, instead of
        // every button failing with an unexplained error.
        if (Err && /remote control is disabled/i.test(Err)) {
          if (Terminal.SetControlEnabled(false)) {
            BroadcastManager.emit('FreeKioskTerminalUpdated', Terminal.ToJSON());
          }
        } else if (!Err && Terminal.SetControlEnabled(true)) {
          BroadcastManager.emit('FreeKioskTerminalUpdated', Terminal.ToJSON());
        }

        Results.push({ UUID, Success: !Err, Error: Err });
      })
    );

    await AuditStep(() => {
      for (const Outcome of Results) {
        const Terminal = TerminalList.find((Entry) => Entry.UUID === Outcome.UUID);
        if (!Terminal) continue;
        RecordAction({
          ...KioskAuditBase(Terminal),
          Summary: Line('Sent ', Value(Command.Label), ' to ', Entity(Terminal.Nickname)),
          Severity: Outcome.Success ? 'info' : 'error',
          Details: Outcome.Error ? [Outcome.Error] : [],
        });
      }
    });
    return Ok(Summarize(Results));
  },

  /** Capture a screenshot or camera photo. Never persisted — see FetchImage. */
  async Capture(
    UUID: string,
    Kind: 'screenshot' | 'camera',
    Options: { Camera?: 'front' | 'back'; Quality?: number } = {}
  ): Promise<Result<FreeKioskImage>> {
    const Terminal = TerminalList.find((Entry) => Entry.UUID === UUID);
    if (!Terminal) return Fail('FreeKiosk terminal not found');
    const [Err, Image] = await FreeKioskClient.FetchImage(Terminal.Connection(), Kind, Options);
    if (Err || !Image) return Fail(Err || 'Capture failed');
    await RecordKioskActions([UUID], (Name) =>
      Line(Kind === 'camera' ? 'Took a camera photo on ' : 'Took a screenshot of ', Entity(Name))
    );
    return Ok(Image);
  },

  async GetCameraList(UUID: string): Promise<Result<FreeKioskCamera[]>> {
    const Terminal = TerminalList.find((Entry) => Entry.UUID === UUID);
    if (!Terminal) return Fail('FreeKiosk terminal not found');
    return FreeKioskClient.GetCameraList(Terminal.Connection());
  },

  /**
   * Give every terminal a slug. Runs once at boot, after the other managers'
   * back-fills, because they all draw from one namespace and must not race.
   */
  async BackfillSlugs(): Promise<void> {
    if (!Manager.Initialized) await Manager.Init();
    for (const Terminal of TerminalList) {
      if (Terminal.Slug) continue;
      const Slug = await SlugService.GenerateUniqueClientSlug(
        Terminal.Nickname || `FreeKiosk-${RandomSuffix()}`,
        SlugService.KioskOwner(Terminal.UUID)
      );
      const [Err] = await TerminalsRepo.UpdateSlug(Slug, Terminal.UUID);
      if (Err) {
        Logger.error(`Failed to back-fill slug for FreeKiosk terminal ${Terminal.UUID}`, Err);
        continue;
      }
      Terminal.Slug = Slug;
    }
  },

  async SetGroupAndWeight(UUID: string, GroupID: number | null, Weight: unknown) {
    const Terminal = TerminalList.find((Entry) => Entry.UUID === UUID);
    const FromGroupID = Terminal ? Terminal.GroupID : null;
    const Result = await GroupOrdering.SetGroupAndWeight(UUID, GroupID, Weight);
    if (Terminal && !Result[0]) {
      await RecordGroupMove(KioskAuditBase(Terminal), FromGroupID, Terminal.GroupID);
    }
    return Result;
  },

  MoveGroupToNoGroup(GroupID: unknown) {
    return GroupOrdering.MoveGroupToNoGroup(GroupID);
  },

  ReconcileOrphanedGroups(ValidGroupIDs: unknown) {
    return GroupOrdering.ReconcileOrphanedGroups(ValidGroupIDs);
  },
};

// Group ordering is shared with the other list-backed managers so a mixed
// drag-and-drop reorder lands on one consistent weight scale.
const GroupOrdering = createGroupOrdering({
  DB,
  BroadcastManager,
  table: 'FreeKioskTerminals',
  keyColumn: 'UUID',
  getList: () => TerminalList,
  getKey: (Terminal: FreeKioskTerminal) => Terminal.UUID,
  queries: {
    SetGroupAndWeight: (GroupID, Weight, Key) =>
      TerminalsRepo.SetGroupAndWeight(GroupID, Weight, String(Key)),
    ClearGroup: (Key) => TerminalsRepo.ClearGroup(String(Key)),
  },
  listChangedEvent: 'FreeKioskTerminalListChanged',
  ensureInitialized: async () => {
    if (!Manager.Initialized) await Manager.Init();
  },
  labels: {
    notFound: 'FreeKiosk terminal not found',
    update: 'Failed to update FreeKiosk terminal',
    move: 'Failed to move FreeKiosk terminals to no group',
    reconcile: 'Failed to reconcile orphaned FreeKiosk terminals',
  },
});

export { Manager };
export type { FreeKioskTerminalSnapshot };
