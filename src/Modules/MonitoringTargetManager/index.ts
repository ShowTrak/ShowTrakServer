// MonitoringTargetManager
// Owns the lifecycle of monitoring targets and their checks.
import { Manager as DB } from '../DB';
import { CreateMonitoringTargetsRepository } from '../DB/repositories/monitoring-targets';
import { CreateMonitoringChecksRepository } from '../DB/repositories/monitoring-checks';
import { Manager as BroadcastManager } from '../Broadcast';
import { Manager as MonitoringMethods } from '../MonitoringMethods';
import { Ok, Fail } from '../Utils';
import { createGroupOrdering } from '../Shared/group-ordering';
import type { Result } from '../../types/result';
import type { TxRun } from '../DB';
import type { MonitoringTargetView } from '@showtrak/protocol';
import type { MonitoringTargetRow } from '../DB/rows';

import {
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  ParseSettings,
  ClampInterval,
  ClampThreshold,
} from './normalize';
import { MonitoringTarget, MonitoringCheck } from './target';
import type { MonitoringCheckInput } from './target';

const TargetsRepo = CreateMonitoringTargetsRepository(DB);
const ChecksRepo = CreateMonitoringChecksRepository(DB);

let TargetList: MonitoringTarget[] = [];

// Incoming check description from the create/update payloads (already validated
// upstream; Method is guaranteed present).
interface MonitoringCheckPayload {
  CheckID?: unknown;
  Name?: string | null;
  Address?: string | null;
  Method: string;
  Settings?: unknown;
  DegradedThresholdMs?: unknown;
}

// Validated target create/update payloads.
interface MonitoringTargetCreatePayload {
  Nickname: string | null;
  Checks?: unknown;
  Interval?: unknown;
  GroupID?: number | null;
  Weight?: unknown;
}
interface MonitoringTargetUpdatePayload {
  Nickname?: string | null;
  Checks?: unknown;
  Interval?: unknown;
  GroupID?: number | null;
}

// RAM-only debug snapshot returned by GetCheckDebug / RunCheckNow.
interface MonitoringCheckDebug {
  CheckID: number;
  Method: string;
  Html: string | null;
  Online: boolean;
  Degraded: boolean;
  LastError: string | null;
  LastChecked: number | null;
  LastLatencyMs: number | null;
  LastDebugAt: number | null;
}

function ToRowSettings(Method: string, Settings: unknown): string {
  const Normalized = MonitoringMethods.NormalizeSettings(Method, Settings || {});
  return JSON.stringify(Normalized);
}

// Insert a single check row for a target and return the persisted row shape.
// `run`, when supplied, enlists the insert in a caller-owned transaction.
async function InsertCheckRow(
  TargetID: number,
  Check: MonitoringCheckPayload,
  Weight: number,
  Now: number,
  run?: TxRun
): Promise<MonitoringCheckInput | null> {
  const SettingsJson = ToRowSettings(Check.Method, Check.Settings);
  const Threshold = ClampThreshold(Check.DegradedThresholdMs);
  const [Err, Res] = await ChecksRepo.Insert(
    TargetID,
    Check.Name || '',
    Check.Address || '',
    Check.Method,
    SettingsJson,
    Threshold,
    Weight,
    null,
    Now,
    run
  );
  if (Err || !Res) return null;
  return {
    CheckID: Res.lastID,
    TargetID,
    Name: Check.Name || '',
    Address: Check.Address || '',
    Method: Check.Method,
    Settings: SettingsJson,
    DegradedThresholdMs: Threshold,
    Weight,
    LastSuccessAt: null,
    Timestamp: Now,
  };
}

// Monitoring method IDs that have been renamed. Persisted checks and legacy
// migrations are normalized to the current ID so previously-created probes keep
// running after a rename (e.g. 'qlab' -> 'qlab-workspace').
const RENAMED_METHODS: Record<string, string> = { qlab: 'qlab-workspace' };

function NormalizeMethod(Method: string): string {
  return RENAMED_METHODS[Method] || Method;
}

// Migrate a legacy single-method MonitoringTargets row into one MonitoringChecks
// row. Returns the persisted check row (or null on failure). Idempotent: only
// called for targets that currently have zero checks.
async function MigrateLegacyTargetToCheck(
  Row: MonitoringTargetRow
): Promise<MonitoringCheckInput | null> {
  const Now = Date.now();
  let SettingsJson =
    typeof Row.Settings === 'string' && Row.Settings ? Row.Settings : JSON.stringify({});
  const Threshold = ClampThreshold(Row.DegradedThresholdMs);
  let Method = NormalizeMethod(Row.Method);

  // Migrate old 'https' method to unified 'http' method with Protocol='https'
  if (Method === 'https') {
    Method = 'http';
    try {
      const Settings = JSON.parse(SettingsJson);
      Settings.Protocol = 'https';
      SettingsJson = JSON.stringify(Settings);
    } catch {
      // If parsing fails, create new settings with just the Protocol
      SettingsJson = JSON.stringify({ Protocol: 'https' });
    }
  }
  // Migrate old 'http' method to explicitly set Protocol='http'
  else if (Method === 'http') {
    try {
      const Settings = JSON.parse(SettingsJson);
      if (!Settings.Protocol) Settings.Protocol = 'http';
      SettingsJson = JSON.stringify(Settings);
    } catch {
      SettingsJson = JSON.stringify({ Protocol: 'http' });
    }
  }

  const [Err, Res] = await ChecksRepo.Insert(
    Row.TargetID,
    '',
    Row.Address || '',
    Method,
    SettingsJson,
    Threshold,
    100,
    Row.LastSuccessAt || null,
    Row.Timestamp || Now
  );
  if (Err || !Res) return null;
  return {
    CheckID: Res.lastID,
    TargetID: Row.TargetID,
    Name: '',
    Address: Row.Address || '',
    Method,
    Settings: SettingsJson,
    DegradedThresholdMs: Threshold,
    Weight: 100,
    LastSuccessAt: Row.LastSuccessAt || null,
    Timestamp: Row.Timestamp || Now,
  };
}

// Reconcile a target's checks against an incoming list: checks that carry an
// existing CheckID are updated in place (preserving runtime state), checks with
// no CheckID are inserted, and existing checks absent from the list are deleted.
async function ReconcileChecks(
  Target: MonitoringTarget,
  Incoming: MonitoringCheckPayload[]
): Promise<void> {
  const Now = Date.now();
  const ExistingById = new Map<number, MonitoringCheck>(
    Target.Checks.map((C) => [Number(C.CheckID), C])
  );
  const KeepIds = new Set<number>();
  const NextChecks: MonitoringCheck[] = [];
  let CheckWeight = 100;

  for (const C of Incoming) {
    const CID = Number(C.CheckID);
    if (Number.isFinite(CID) && ExistingById.has(CID)) {
      KeepIds.add(CID);
      const Instance = ExistingById.get(CID)!;
      const MethodChanged = Instance.Method !== C.Method;
      const SettingsJson = ToRowSettings(C.Method, C.Settings);
      const Threshold = ClampThreshold(C.DegradedThresholdMs);
      await ChecksRepo.UpdateDetails(
        C.Name || '',
        C.Address || '',
        C.Method,
        SettingsJson,
        Threshold,
        CheckWeight,
        CID
      );
      Instance.Name = C.Name || '';
      Instance.Address = C.Address || '';
      Instance.Method = C.Method;
      Instance.Settings = ParseSettings(SettingsJson);
      Instance.DegradedThresholdMs = Threshold;
      Instance.Weight = CheckWeight;
      if (MethodChanged) {
        // Drop stale status so the tile doesn't show the previous method's state
        Instance.Online = false;
        Instance.Degraded = false;
        Instance.LastLatencyMs = null;
        Instance.LastError = null;
        Instance.LastChecked = null;
      }
      NextChecks.push(Instance);
    } else {
      const Row = await InsertCheckRow(Target.TargetID, C, CheckWeight, Now);
      if (Row) NextChecks.push(new MonitoringCheck(Row));
    }
    CheckWeight += 10;
  }

  // Delete checks that were removed from the target.
  for (const Existing of Target.Checks) {
    if (!KeepIds.has(Number(Existing.CheckID))) {
      await ChecksRepo.Delete(Existing.CheckID);
    }
  }

  Target.Checks = NextChecks;
  Target.RecomputeAggregate();
}

const Manager = {
  Initialized: false,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,

  async Init(): Promise<void> {
    // Normalize any persisted checks that use a renamed method ID so existing
    // probes keep resolving to a registered method after a rename.
    for (const [OldMethod, NewMethod] of Object.entries(RENAMED_METHODS)) {
      await ChecksRepo.RenameMethod(NewMethod, OldMethod);
    }

    const [Err, Rows] = await TargetsRepo.GetAll();
    if (Err) {
      Manager.Initialized = true;
      TargetList = [];
      return;
    }

    const [CheckErr, CheckRows] = await ChecksRepo.GetAll();
    const ChecksByTarget = new Map<number, MonitoringCheckInput[]>();
    if (!CheckErr) {
      for (const CR of CheckRows || []) {
        const list = ChecksByTarget.get(CR.TargetID) || [];
        list.push(CR);
        ChecksByTarget.set(CR.TargetID, list);
      }
    }

    TargetList = [];
    for (const Row of Rows || []) {
      let Checks: MonitoringCheckInput[] = ChecksByTarget.get(Row.TargetID) || [];
      if (!Checks.length && Row.Method) {
        const Migrated = await MigrateLegacyTargetToCheck(Row);
        if (Migrated) Checks = [Migrated];
      }
      Checks = Checks.slice().sort(
        (a, b) => (a.Weight || 0) - (b.Weight || 0) || (a.CheckID || 0) - (b.CheckID || 0)
      );
      TargetList.push(new MonitoringTarget(Row, Checks));
    }

    for (const T of TargetList) T.StartLoop();
    Manager.Initialized = true;
    BroadcastManager.emit('MonitoringTargetListChanged');
  },

  // Rebuild runtime state from DB after external bulk changes (e.g., config import).
  async Reload(): Promise<void> {
    for (const Target of TargetList) Target.StopLoop();
    TargetList = [];
    Manager.Initialized = false;
    await Manager.Init();
  },

  async Shutdown(): Promise<void> {
    for (const Target of TargetList) {
      try {
        Target.StopLoop();
      } catch {
        /* intentional: stopping each target loop during shutdown is best-effort */
      }
    }
  },

  async GetAll(): Promise<Result<MonitoringTargetView[]>> {
    if (!Manager.Initialized) await Manager.Init();
    return [null, TargetList.map((T) => T.ToJSON())];
  },

  async Get(TargetID: unknown): Promise<[string | null, MonitoringTargetView | null]> {
    const ID = Number(TargetID);
    const Cached = TargetList.find((T) => T.TargetID === ID);
    if (!Cached) return ['Monitoring target not found', null];
    return [null, Cached.ToJSON()];
  },

  // Return the most recent (RAM-only) debug panel for a single check.
  async GetCheckDebug(CheckID: unknown): Promise<[string | null, MonitoringCheckDebug | null]> {
    const ID = Number(CheckID);
    for (const Target of TargetList) {
      const Check = Target.Checks.find((C) => Number(C.CheckID) === ID);
      if (!Check) continue;
      return [
        null,
        {
          CheckID: Check.CheckID,
          Method: Check.Method,
          Html: Check.LastDebugHtml || null,
          Online: Check.Online,
          Degraded: Check.Degraded,
          LastError: Check.LastError,
          LastChecked: Check.LastChecked,
          LastLatencyMs: Check.LastLatencyMs,
          LastDebugAt: Check.LastDebugAt,
        },
      ];
    }
    return ['Monitoring check not found', null];
  },

  // Run a single check immediately (outside its normal interval), refresh the
  // parent target's aggregate + broadcast, and return the fresh debug snapshot.
  async RunCheckNow(CheckID: unknown): Promise<[string | null, MonitoringCheckDebug | null]> {
    const ID = Number(CheckID);
    for (const Target of TargetList) {
      const Check = Target.Checks.find((C) => Number(C.CheckID) === ID);
      if (!Check) continue;
      await Check.Run();
      Target.LastChecked = Date.now();
      Target.RecomputeAggregate();
      BroadcastManager.emit('MonitoringTargetUpdated', Target.ToJSON());
      return Manager.GetCheckDebug(ID);
    }
    return ['Monitoring check not found', null];
  },

  // Run every check on a target immediately (outside their normal intervals),
  // refresh the target's aggregate + broadcast once, and return the target
  // snapshot. Used by the "Run Checks Now" context-menu action.
  async RunAllChecksNow(TargetID: unknown): Promise<[string | null, MonitoringTargetView | null]> {
    const ID = Number(TargetID);
    const Target = TargetList.find((T) => Number(T.TargetID) === ID);
    if (!Target) return ['Monitoring target not found', null];
    await Promise.all(Target.Checks.map((Check) => Check.Run()));
    Target.LastChecked = Date.now();
    Target.RecomputeAggregate();
    BroadcastManager.emit('MonitoringTargetUpdated', Target.ToJSON());
    return [null, Target.ToJSON()];
  },

  async Create(Payload: MonitoringTargetCreatePayload): Promise<Result<MonitoringTargetView>> {
    const Now = Date.now();
    const Checks: MonitoringCheckPayload[] = Array.isArray(Payload.Checks) ? Payload.Checks : [];
    for (const C of Checks) {
      if (!MonitoringMethods.Has(C.Method)) return Fail(`Unknown monitoring method: ${C.Method}`);
    }

    const Interval = ClampInterval(Payload.Interval);
    const GroupID = Payload.GroupID == null ? null : Payload.GroupID;
    const Weight = typeof Payload.Weight === 'number' ? Payload.Weight : 100;

    // The target row and every check row insert together or not at all: a
    // partial failure must never persist a target whose check set is incomplete.
    const [TxErr, Created] = await DB.WithTransaction(async (run) => {
      const [Err, Res] = await TargetsRepo.Insert(
        Payload.Nickname,
        Checks.length ? Checks[0].Method : '',
        Interval,
        GroupID,
        Weight,
        Now,
        run
      );
      if (Err || !Res) throw Err || new Error('Failed to create monitoring target');
      const TargetID = Res.lastID;

      const CheckRows: MonitoringCheckInput[] = [];
      let CheckWeight = 100;
      for (const C of Checks) {
        const Row = await InsertCheckRow(TargetID, C, CheckWeight, Now, run);
        if (!Row) throw new Error('Failed to create monitoring check');
        CheckRows.push(Row);
        CheckWeight += 10;
      }
      return { TargetID, CheckRows };
    });
    if (TxErr || !Created) return Fail('Failed to create monitoring target');
    const { TargetID, CheckRows } = Created;

    const Target = new MonitoringTarget(
      { TargetID, Nickname: Payload.Nickname, Interval, GroupID, Weight, Timestamp: Now },
      CheckRows
    );
    TargetList.push(Target);
    Target.StartLoop();
    BroadcastManager.emit('MonitoringTargetListChanged');
    return Ok(Target.ToJSON());
  },

  async Update(
    TargetID: unknown,
    Payload: MonitoringTargetUpdatePayload
  ): Promise<Result<MonitoringTargetView>> {
    const ID = Number(TargetID);
    const Target = TargetList.find((T) => T.TargetID === ID);
    if (!Target) return Fail('Monitoring target not found');

    const NextInterval = ClampInterval(
      Object.prototype.hasOwnProperty.call(Payload, 'Interval') ? Payload.Interval : Target.Interval
    );
    // The hasOwnProperty guard guarantees a defined value at runtime; the
    // optional payload field only widens the type with `undefined`.
    const NextNickname = (
      Object.prototype.hasOwnProperty.call(Payload, 'Nickname')
        ? Payload.Nickname
        : Target.Nickname
    ) as string;
    const NextGroupID = (
      Object.prototype.hasOwnProperty.call(Payload, 'GroupID')
        ? Payload.GroupID
        : Target.GroupID
    ) as number | null;

    let NextChecks: MonitoringCheckPayload[] | null = null;
    if (Object.prototype.hasOwnProperty.call(Payload, 'Checks')) {
      const Incoming: MonitoringCheckPayload[] = Array.isArray(Payload.Checks) ? Payload.Checks : [];
      for (const C of Incoming) {
        if (!MonitoringMethods.Has(C.Method)) return Fail(`Unknown monitoring method: ${C.Method}`);
      }
      NextChecks = Incoming;
    }

    const [Err] = await TargetsRepo.UpdateDetails(NextNickname, NextInterval, NextGroupID, ID);
    if (Err) return Fail('Failed to update monitoring target');

    Target.Nickname = NextNickname;
    Target.Interval = NextInterval;
    Target.GroupID = NextGroupID;

    if (NextChecks) await ReconcileChecks(Target, NextChecks);

    Target.StartLoop();
    BroadcastManager.emit('MonitoringTargetUpdated', Target.ToJSON());
    BroadcastManager.emit('MonitoringTargetListChanged');
    return Ok(Target.ToJSON());
  },

  async Delete(TargetID: unknown): Promise<Result<boolean>> {
    const ID = Number(TargetID);
    const Idx = TargetList.findIndex((T) => T.TargetID === ID);
    if (Idx === -1) return Fail('Monitoring target not found');
    const Target = TargetList[Idx];
    Target.StopLoop();
    const [Err] = await TargetsRepo.DeleteTargetCascade(ID);
    if (Err) {
      // The transaction rolled back, so the row (and its checks) survived —
      // the target must keep polling.
      Target.StartLoop();
      return Fail('Failed to delete monitoring target');
    }
    TargetList.splice(Idx, 1);
    BroadcastManager.emit('MonitoringTargetListChanged');
    return Ok(true);
  },

  // Move a monitoring target to a group with a specific weight (used by drag/drop ordering).
  SetGroupAndWeight(TargetID: unknown, GroupID: number | null, Weight: unknown) {
    return GroupOrdering.SetGroupAndWeight(TargetID, GroupID, Weight);
  },

  // Move all monitoring targets from a specific group into the default no-group bucket (null).
  MoveGroupToNoGroup(GroupID: unknown) {
    return GroupOrdering.MoveGroupToNoGroup(GroupID);
  },

  // Ensure all monitoring targets reference an existing group; unknown groups are reassigned to null.
  ReconcileOrphanedGroups(ValidGroupIDs: unknown) {
    return GroupOrdering.ReconcileOrphanedGroups(ValidGroupIDs);
  },

  GetAllSync() {
    return TargetList.map((T) => T.ToJSON());
  },
};

// Group ordering (SetGroupAndWeight / MoveGroupToNoGroup / ReconcileOrphanedGroups)
// is shared with other list-backed managers via the group-ordering helper.
const GroupOrdering = createGroupOrdering({
  DB,
  BroadcastManager,
  table: 'MonitoringTargets',
  keyColumn: 'TargetID',
  getList: () => TargetList,
  getKey: (Target) => (Target as MonitoringTarget).TargetID,
  normalizeKey: (raw: unknown) => Number(raw),
  queries: {
    SetGroupAndWeight: (GroupID, Weight, Key) =>
      TargetsRepo.SetGroupAndWeight(GroupID, Weight, Number(Key)),
    ClearGroup: (Key) => TargetsRepo.ClearGroup(Number(Key)),
  },
  listChangedEvent: 'MonitoringTargetListChanged',
  ensureInitialized: async () => {
    if (!Manager.Initialized) await Manager.Init();
  },
  labels: {
    notFound: 'Monitoring target not found',
    update: 'Failed to update monitoring target',
    move: 'Failed to move monitoring targets to no group',
    reconcile: 'Failed to reconcile orphaned monitoring targets',
  },
});

export { Manager };
