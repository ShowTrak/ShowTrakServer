// MonitoringTargetManager
// Owns the lifecycle of monitoring targets and their checks.
import { Manager as DB } from '../DB';
import { CreateLogger } from '../Logger';
import { CreateMonitoringTargetsRepository } from '../DB/repositories/monitoring-targets';
import { CreateMonitoringChecksRepository } from '../DB/repositories/monitoring-checks';
import { Manager as BroadcastManager } from '../Broadcast';
import { Manager as MonitoringMethods } from '../MonitoringMethods';
import { Ok, Fail } from '../Utils';
import * as SlugService from '../Slug';
import { createGroupOrdering } from '../Shared/group-ordering';
import type { Result } from '../../types/result';
import type { TxRun } from '../DB';
import type {
  MonitoringActionOutcome,
  MonitoringActionSummary,
  MonitoringTargetView,
} from '@showtrak/protocol';
import type { MonitoringTargetRow } from '../DB/rows';
import type { AuditChange } from '@showtrak/protocol';
import type { MonitoringSettingField } from '../MonitoringMethods/types';
import { RecordAction, RecordEdit, RecordUpdate } from '../AuditLog/edits';
import { Entity, Line, Value } from '../AuditLog/message';
import { DiffFields, FormatValue, type FieldSpec } from '../AuditLog/diff';
import { MonitorDisplayName } from '../AuditLog/status';
import {
  AuditBefore,
  AuditStep,
  DiffSettings,
  GroupTitle,
  RecordGroupMove,
  Seconds,
} from '../Shared/audit-names';

import {
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  ParseSettings,
  ClampInterval,
  ClampThreshold,
  ClampFailureThreshold,
} from './normalize';
import { MonitoringTarget, MonitoringCheck } from './target';
import type { MonitoringCheckInput } from './target';

const TargetsRepo = CreateMonitoringTargetsRepository(DB);
const ChecksRepo = CreateMonitoringChecksRepository(DB);

const Logger = CreateLogger('MonitoringTargetManager');

let TargetList: MonitoringTarget[] = [];

// In-flight Init(), so concurrent callers share one run instead of each building
// their own TargetList. `Initialized` only flips at the very end of Init, so
// every `if (!Initialized) await Init()` call site that fires during boot would
// otherwise start a competing rebuild — and the losing batch's targets stay in
// their StartLoop()'d state, broadcasting stale snapshots forever.
let InitPromise: Promise<void> | null = null;

// Incoming check description from the create/update payloads (already validated
// upstream; Method is guaranteed present).
interface MonitoringCheckPayload {
  CheckID?: unknown;
  Name?: string | null;
  Address?: string | null;
  Method: string;
  Settings?: unknown;
  DegradedThresholdMs?: unknown;
  FailureThreshold?: unknown;
}

// Validated target create/update payloads.
export interface MonitoringTargetCreatePayload {
  Nickname: string | null;
  Checks?: unknown;
  Interval?: unknown;
  GroupID?: number | null;
  Weight?: unknown;
  FailureThreshold?: unknown;
}
interface MonitoringTargetUpdatePayload {
  Nickname?: string | null;
  Checks?: unknown;
  Interval?: unknown;
  GroupID?: number | null;
  Slug?: unknown;
  FailureThreshold?: unknown;
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
  ConsecutiveFailures: number;
  EffectiveFailureThreshold: number;
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
  const FailureThreshold = ClampFailureThreshold(Check.FailureThreshold);
  const [Err, Res] = await ChecksRepo.Insert(
    TargetID,
    Check.Name || '',
    Check.Address || '',
    Check.Method,
    SettingsJson,
    Threshold,
    FailureThreshold,
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
    FailureThreshold,
    Weight,
    LastSuccessAt: null,
    Timestamp: Now,
  };
}

// Monitoring method IDs that have been renamed. Persisted checks and legacy
// migrations are normalized to the current ID so previously-created probes keep
// running after a rename (e.g. 'qlab-workspace' -> 'qlab5').
const RENAMED_METHODS: Record<string, string> = {
  // The QLab workspace check evolved and was renamed 'qlab-workspace' -> 'qlab5';
  // the earlier 'qlab' and interim health id map to the same current method.
  qlab: 'qlab5',
  'qlab-workspace': 'qlab5',
  'qlab-workspace-health': 'qlab5',
  'qlab4-workspace': 'qlab4',
};

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
    null,
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
      const FailureThreshold = ClampFailureThreshold(C.FailureThreshold);
      await ChecksRepo.UpdateDetails(
        C.Name || '',
        C.Address || '',
        C.Method,
        SettingsJson,
        Threshold,
        FailureThreshold,
        CheckWeight,
        CID
      );
      Instance.Name = C.Name || '';
      Instance.Address = C.Address || '';
      Instance.Method = C.Method;
      Instance.Settings = ParseSettings(SettingsJson);
      Instance.DegradedThresholdMs = Threshold;
      Instance.FailureThreshold = FailureThreshold;
      Instance.Weight = CheckWeight;
      if (MethodChanged) {
        // Drop stale status so the tile doesn't show the previous method's state
        Instance.ResetRuntimeState();
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

// Rebuild TargetList from the DB and start every target's polling loop. Always
// reached through Manager.Init(), which serialises concurrent callers.
async function RunInit(): Promise<void> {
  // Retire any loops from a previous TargetList before it is discarded —
  // an orphaned target keeps ticking and broadcasting a stale snapshot
  // (old Nickname, old check set) against the same TargetID.
  for (const T of TargetList) T.StopLoop();

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

  const Next: MonitoringTarget[] = [];
  for (const Row of Rows || []) {
    let Checks: MonitoringCheckInput[] = ChecksByTarget.get(Row.TargetID) || [];
    if (!Checks.length && Row.Method) {
      const Migrated = await MigrateLegacyTargetToCheck(Row);
      if (Migrated) Checks = [Migrated];
    }
    Checks = Checks.slice().sort(
      (a, b) => (a.Weight || 0) - (b.Weight || 0) || (a.CheckID || 0) - (b.CheckID || 0)
    );
    Next.push(new MonitoringTarget(Row, Checks));
  }

  // Publish the rebuilt list in one assignment: while the loop above awaits its
  // DB reads, a GetAll() landing mid-rebuild would otherwise see a half-filled
  // list and push it to every renderer as the complete set.
  TargetList = Next;

  for (const T of TargetList) T.StartLoop();
  Manager.Initialized = true;
  BroadcastManager.emit('MonitoringTargetListChanged');
}

// --- Audit log ---------------------------------------------------------------
// An edit is reported against the editor's own labels: the monitor's fields,
// then each check by its label, with its method's settings named as the method
// names them. A credential the method marks Sensitive never reaches the log.

interface MonitorAuditFields {
  Nickname: string;
  Slug: string | null;
  Group: string;
  Interval: string | null;
  FailureThreshold: string;
}

interface CheckAuditFields {
  CheckID: number;
  Name: string;
  Address: string;
  Method: string;
  Settings: Record<string, unknown>;
  DegradedThresholdMs: number;
  FailureThreshold: number | null;
}

const MONITOR_AUDIT_FIELDS: readonly FieldSpec<MonitorAuditFields>[] = [
  { Key: 'Nickname', Label: 'Name' },
  { Key: 'Slug', Label: 'Slug' },
  { Key: 'Group', Label: 'Group' },
  { Key: 'Interval', Label: 'Check Interval' },
  { Key: 'FailureThreshold', Label: 'Failures Before Offline' },
];

const CHECK_AUDIT_FIELDS: readonly FieldSpec<CheckAuditFields>[] = [
  { Key: 'Name', Label: 'Label' },
  { Key: 'Method', Label: 'Monitoring Method', Format: (Value) => MethodName(Value) },
  { Key: 'Address', Label: 'IP / Hostname / Domain' },
  {
    Key: 'DegradedThresholdMs',
    Label: 'Degraded Threshold',
    Format: (Value) => (Number(Value) > 0 ? `${Value} ms` : 'Off'),
  },
  {
    Key: 'FailureThreshold',
    Label: 'Failures Before Offline',
    Format: (Value) => (Value === null || Value === undefined ? 'Default' : String(Value)),
  },
];

function MethodName(ID: unknown): string | null {
  if (typeof ID !== 'string' || !ID) return null;
  const Method = MonitoringMethods.Get(ID);
  return Method ? Method.Name : ID;
}

function CheckName(Check: { Name: string; Method: string }): string {
  return Check.Name || MethodName(Check.Method) || 'Check';
}

async function MonitorAuditFieldsOf(Target: MonitoringTarget): Promise<MonitorAuditFields> {
  return {
    Nickname: Target.Nickname,
    Slug: Target.Slug,
    Group: await GroupTitle(Target.GroupID),
    Interval: Seconds(Target.Interval / 1000),
    FailureThreshold:
      Target.FailureThreshold === null ? 'Default' : String(Target.FailureThreshold),
  };
}

function CheckAuditFieldsOf(Check: MonitoringCheck): CheckAuditFields {
  return {
    CheckID: Number(Check.CheckID),
    Name: Check.Name,
    Address: Check.Address,
    Method: Check.Method,
    Settings: { ...(Check.Settings || {}) },
    DegradedThresholdMs: Check.DegradedThresholdMs,
    FailureThreshold: Check.FailureThreshold ?? null,
  };
}

function CheckSettingChanges(Before: CheckAuditFields, After: CheckAuditFields): AuditChange[] {
  // A new method brings a whole new settings schema; the method change says it.
  if (Before.Method !== After.Method) return [];
  const Method = MonitoringMethods.Get(After.Method);
  const Fields = new Map<string, MonitoringSettingField>(
    (Method && Array.isArray(Method.Settings) ? Method.Settings : []).map((Field) => [
      Field.Key,
      Field,
    ])
  );
  return DiffSettings(Before.Settings, After.Settings, {
    Label: (Key) => (Fields.get(Key) ? Fields.get(Key)!.Label : Key),
    Format: (Key, Value) => {
      const Option = (Fields.get(Key)?.Options || []).find(
        (Entry) => typeof Entry === 'object' && Entry.value === Value
      );
      return Option && typeof Option === 'object' && Option.label
        ? Option.label
        : FormatValue(Value);
    },
    // A key the schema no longer declares cannot be vouched for either.
    Secret: (Key) => !Fields.has(Key) || !!Fields.get(Key)!.Sensitive,
  });
}

function CheckListChanges(
  Before: readonly CheckAuditFields[],
  After: readonly CheckAuditFields[]
): AuditChange[] {
  const Changes: AuditChange[] = [];
  const Previous = new Map(Before.map((Check) => [Check.CheckID, Check]));
  const Kept = new Set<number>();
  for (const Check of After) {
    const Old = Previous.get(Check.CheckID);
    if (!Old) {
      Changes.push({ Field: 'Added check', From: null, To: CheckName(Check) });
      continue;
    }
    Kept.add(Check.CheckID);
    const Prefix = `${CheckName(Check)}: `;
    for (const Change of [
      ...DiffFields(Old, Check, CHECK_AUDIT_FIELDS),
      ...CheckSettingChanges(Old, Check),
    ]) {
      Changes.push({ ...Change, Field: Prefix + Change.Field });
    }
  }
  for (const Check of Before) {
    if (!Kept.has(Check.CheckID)) {
      Changes.push({ Field: 'Removed check', From: CheckName(Check), To: null });
    }
  }
  return Changes;
}

function MonitorAuditBase(Target: { TargetID: number; Nickname: string }) {
  return {
    EntityType: 'monitor' as const,
    EntityID: String(Target.TargetID),
    EntityName: MonitorDisplayName(Target),
  };
}

const Manager = {
  Initialized: false,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,

  async Init(): Promise<void> {
    if (Manager.Initialized) return;
    if (InitPromise) return InitPromise;
    InitPromise = RunInit().finally(() => {
      InitPromise = null;
    });
    return InitPromise;
  },

  // Rebuild runtime state from DB after external bulk changes (e.g., config import).
  async Reload(): Promise<void> {
    // Let any in-flight Init settle first, otherwise Manager.Init() below just
    // hands back that older run's promise and the reload reads pre-import rows.
    if (InitPromise) await InitPromise.catch(() => undefined);
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

  /**
   * GetAll() with every `Sensitive` check setting masked, for unauthenticated
   * readers such as the HTTP API. The editors keep reading GetAll(): they save
   * back the settings they loaded, so a masked value there would overwrite the
   * real credential.
   */
  async GetAllRedacted(): Promise<Result<MonitoringTargetView[]>> {
    const [Err, Views] = await Manager.GetAll();
    if (Err) return Fail(Err);
    return [
      null,
      (Views || []).map((View) => ({
        ...View,
        Checks: (View.Checks || []).map((Check) => ({
          ...Check,
          Settings: MonitoringMethods.RedactSettings(Check.Method, Check.Settings),
        })),
      })),
    ];
  },

  async Get(TargetID: unknown): Promise<[string | null, MonitoringTargetView | null]> {
    const ID = Number(TargetID);
    const Cached = TargetList.find((T) => T.TargetID === ID);
    if (!Cached) return ['Monitor not found', null];
    return [null, Cached.ToJSON()];
  },

  // Resolve a monitoring target by slug (case-insensitive), for OSC/API addressing.
  async GetBySlug(Slug: string): Promise<MonitoringTargetView | null> {
    if (!Slug) return null;
    if (!Manager.Initialized) await Manager.Init();
    const Lower = String(Slug).toLowerCase();
    const Found = TargetList.find((T) => (T.Slug || '').toLowerCase() === Lower);
    return Found ? Found.ToJSON() : null;
  },

  // Assign generated unique slugs to any target row still lacking one. Idempotent.
  async BackfillSlugs(): Promise<number> {
    if (!Manager.Initialized) await Manager.Init();
    let Count = 0;
    for (const Target of TargetList) {
      if (Target.Slug) continue;
      const Slug = await SlugService.GenerateUniqueClientSlug(
        Target.Nickname,
        SlugService.MonitorOwner(Target.TargetID),
        'monitor'
      );
      const [Err] = await TargetsRepo.UpdateSlug(Slug, Target.TargetID);
      if (!Err) {
        Target.Slug = Slug;
        Count++;
      }
    }
    if (Count) Logger.log(`Back-filled slugs for ${Count} monitoring target(s)`);
    return Count;
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
          ConsecutiveFailures: Check.ConsecutiveFailures,
          EffectiveFailureThreshold: Check.EffectiveFailureThreshold(
            Target.InheritedFailureThreshold()
          ),
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
      await Target.RunChecks([Check]);
      BroadcastManager.emit('MonitoringTargetUpdated', Target.ToJSON());
      await AuditStep(() =>
        RecordAction({
          ...MonitorAuditBase(Target),
          Summary: Line('Ran ', Value(CheckName(Check)), ' now'),
        })
      );
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
    if (!Target) return ['Monitor not found', null];
    await Target.RunChecks();
    BroadcastManager.emit('MonitoringTargetUpdated', Target.ToJSON());
    await AuditStep(() =>
      RecordAction({ ...MonitorAuditBase(Target), Summary: Line('Ran all checks now') })
    );
    return [null, Target.ToJSON()];
  },

  /**
   * Fan one check action out across the named targets.
   *
   * A target runs the action once per check that declares it, so a selection
   * mixing a projector with a DNS probe simply does nothing on the probe — the
   * same "offer it where it applies, run it where it applies" rule the script
   * and integrated-event menus already follow. A target with no matching check
   * is reported as a failure rather than skipped silently, so a selection that
   * quietly did less than the operator expected still says so.
   *
   * Failures are per-check and never fatal to the batch: one projector refusing
   * (warming up, wrong password) must not stop the other five from taking it.
   */
  async RunAction(
    TargetIDs: unknown,
    Method: string,
    ActionID: string,
    Params: Record<string, unknown> = {},
    // Narrows the action to these checks. Null runs it on every check of the
    // method on each target, which is what a selected TARGET means.
    CheckIDs: number[] | null = null
  ): Promise<Result<MonitoringActionSummary>> {
    if (!MonitoringMethods.Has(Method)) return Fail(`Unknown monitoring method: ${Method}`);
    const Action = MonitoringMethods.GetAction(Method, ActionID);
    if (!Action) return Fail(`Unknown action "${ActionID}" for method "${Method}"`);

    const IDs = Array.isArray(TargetIDs) ? TargetIDs : [TargetIDs];
    const Results: MonitoringActionOutcome[] = [];
    // Targets are handled in parallel but each target's checks in series: two
    // checks on one target may well address the same device, and a method whose
    // device takes a single session at a time (PJLink) would otherwise race.
    const Touched = new Set<MonitoringTarget>();

    await Promise.all(
      IDs.map(async (RawID) => {
        const ID = Number(RawID);
        const Target = TargetList.find((T) => Number(T.TargetID) === ID);
        if (!Target) {
          Results.push({
            TargetID: ID,
            CheckID: 0,
            Nickname: '',
            Success: false,
            Error: 'Monitor not found',
            Detail: null,
          });
          return;
        }

        const OnlyChecks = Array.isArray(CheckIDs) ? new Set(CheckIDs.map(Number)) : null;
        const Checks = Target.Checks.filter(
          (Check) =>
            Check.Method === Method && (!OnlyChecks || OnlyChecks.has(Number(Check.CheckID)))
        );
        if (!Checks.length) {
          Results.push({
            TargetID: ID,
            CheckID: 0,
            Nickname: Target.Nickname,
            Success: false,
            Error: OnlyChecks
              ? `None of the selected checks on this target is a ${Method} check`
              : `No ${Method} check on this target`,
            Detail: null,
          });
          return;
        }

        for (const Check of Checks) {
          const Outcome = await MonitoringMethods.RunAction(Method, Check, ActionID, Params);
          Results.push({
            TargetID: ID,
            CheckID: Check.CheckID,
            Nickname: Target.Nickname,
            Success: !!Outcome.Success,
            Error: Outcome.Success ? null : Outcome.Error || 'Action failed',
            Detail: Outcome.Detail || null,
          });
          if (Outcome.Success) Touched.add(Target);
        }
      })
    );

    // Re-probe whatever we just changed so the tiles reflect the new state
    // immediately instead of after up to a full interval. RunAction has already
    // dropped the caches that would otherwise replay the pre-action reading.
    await Promise.all(
      [...Touched].map(async (Target) => {
        await Target.RunChecks();
        BroadcastManager.emit('MonitoringTargetUpdated', Target.ToJSON());
      })
    );

    // One line per monitor it was sent to, failed or not.
    await AuditStep(() => {
      for (const ID of new Set(Results.map((Entry) => Entry.TargetID))) {
        const Target = TargetList.find((T) => Number(T.TargetID) === ID);
        if (!Target) continue;
        const Mine = Results.filter((Entry) => Entry.TargetID === ID);
        const Failed = Mine.filter((Entry) => !Entry.Success);
        RecordAction({
          ...MonitorAuditBase(Target),
          Summary: Line('Ran ', Value(Action.Label)),
          Severity: Failed.length === Mine.length ? 'error' : Failed.length ? 'warning' : 'info',
          Details: Failed.map((Entry) => Entry.Error || 'Action failed'),
        });
      }
    });

    const Succeeded = Results.filter((Entry) => Entry.Success).length;
    return Ok({
      Total: Results.length,
      Succeeded,
      Failed: Results.length - Succeeded,
      Results,
    });
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
    const FailureThreshold = ClampFailureThreshold(Payload.FailureThreshold);

    // The target row and every check row insert together or not at all: a
    // partial failure must never persist a target whose check set is incomplete.
    const [TxErr, Created] = await DB.WithTransaction(async (run) => {
      const [Err, Res] = await TargetsRepo.Insert(
        Payload.Nickname,
        Checks.length ? Checks[0]!.Method : '',
        Interval,
        GroupID,
        Weight,
        FailureThreshold,
        Now,
        run
      );
      if (Err || !Res) throw Err || new Error('Failed to create monitor');
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
    if (TxErr || !Created) return Fail('Failed to create monitor');
    const { TargetID, CheckRows } = Created;

    // Every target must carry a non-null slug for OSC/API addressing. Generate a
    // unique one from its nickname; the operator can rename it later.
    const Slug = await SlugService.GenerateUniqueClientSlug(
      Payload.Nickname,
      SlugService.MonitorOwner(TargetID),
      'monitor'
    );
    const [SlugErr] = await TargetsRepo.UpdateSlug(Slug, TargetID);
    if (SlugErr) Logger.error('Failed to persist monitoring target slug', SlugErr);

    const Target = new MonitoringTarget(
      {
        TargetID,
        Nickname: Payload.Nickname,
        Interval,
        GroupID,
        Weight,
        Slug,
        FailureThreshold,
        Timestamp: Now,
      },
      CheckRows
    );
    TargetList.push(Target);
    Target.StartLoop();
    BroadcastManager.emit('MonitoringTargetListChanged');
    await AuditStep(() =>
      RecordEdit({
        ...MonitorAuditBase(Target),
        Summary: Line('Created ', Entity(MonitorDisplayName(Target))),
        Details: Target.Checks.map((Check) => `Check: ${CheckName(Check)}`),
      })
    );
    return Ok(Target.ToJSON());
  },

  async Update(
    TargetID: unknown,
    Payload: MonitoringTargetUpdatePayload
  ): Promise<Result<MonitoringTargetView>> {
    const ID = Number(TargetID);
    const Target = TargetList.find((T) => T.TargetID === ID);
    if (!Target) return Fail('Monitor not found');
    const Before = await AuditBefore(async () => ({
      Fields: await MonitorAuditFieldsOf(Target),
      Checks: Target.Checks.map(CheckAuditFieldsOf),
    }));

    const NextInterval = ClampInterval(
      Object.prototype.hasOwnProperty.call(Payload, 'Interval') ? Payload.Interval : Target.Interval
    );
    // The hasOwnProperty guard guarantees a defined value at runtime; the
    // optional payload field only widens the type with `undefined`.
    const NextNickname = (
      Object.prototype.hasOwnProperty.call(Payload, 'Nickname') ? Payload.Nickname : Target.Nickname
    ) as string;
    const NextGroupID = (
      Object.prototype.hasOwnProperty.call(Payload, 'GroupID') ? Payload.GroupID : Target.GroupID
    ) as number | null;
    const NextFailureThreshold = Object.prototype.hasOwnProperty.call(Payload, 'FailureThreshold')
      ? ClampFailureThreshold(Payload.FailureThreshold)
      : Target.FailureThreshold;

    let NextChecks: MonitoringCheckPayload[] | null = null;
    if (Object.prototype.hasOwnProperty.call(Payload, 'Checks')) {
      const Incoming: MonitoringCheckPayload[] = Array.isArray(Payload.Checks)
        ? Payload.Checks
        : [];
      for (const C of Incoming) {
        if (!MonitoringMethods.Has(C.Method)) return Fail(`Unknown monitoring method: ${C.Method}`);
      }
      NextChecks = Incoming;
    }

    // Resolve/validate a slug edit before persisting anything else so a bad slug
    // rejects the whole update rather than half-applying it.
    let NextSlug: string | null = null;
    if (Object.prototype.hasOwnProperty.call(Payload, 'Slug')) {
      const [SlugErr, Resolved] = await SlugService.ResolveClientSlugEdit(
        Payload.Slug,
        SlugService.MonitorOwner(ID)
      );
      if (SlugErr) return Fail(SlugErr);
      NextSlug = Resolved;
    }

    const [Err] = await TargetsRepo.UpdateDetails(
      NextNickname,
      NextInterval,
      NextGroupID,
      NextFailureThreshold,
      ID
    );
    if (Err) return Fail('Failed to update monitor');

    if (NextSlug !== null) {
      const [SlugErr] = await TargetsRepo.UpdateSlug(NextSlug, ID);
      if (SlugErr) return Fail('Failed to update monitor slug');
      Target.Slug = NextSlug;
    }

    Target.Nickname = NextNickname;
    Target.Interval = NextInterval;
    Target.GroupID = NextGroupID;
    Target.FailureThreshold = NextFailureThreshold;

    if (NextChecks) await ReconcileChecks(Target, NextChecks);

    Target.StartLoop();
    BroadcastManager.emit('MonitoringTargetUpdated', Target.ToJSON());
    BroadcastManager.emit('MonitoringTargetListChanged');
    if (Before) {
      await AuditStep(async () =>
        RecordUpdate({
          ...MonitorAuditBase(Target),
          Summary: Line('Edited ', Entity(MonitorDisplayName(Target))),
          Changes: [
            ...DiffFields(Before.Fields, await MonitorAuditFieldsOf(Target), MONITOR_AUDIT_FIELDS),
            ...CheckListChanges(Before.Checks, Target.Checks.map(CheckAuditFieldsOf)),
          ],
        })
      );
    }
    return Ok(Target.ToJSON());
  },

  async Delete(TargetID: unknown): Promise<Result<boolean>> {
    const ID = Number(TargetID);
    const Idx = TargetList.findIndex((T) => T.TargetID === ID);
    if (Idx === -1) return Fail('Monitor not found');
    // Idx !== -1 (checked above) → in-bounds.
    const Target = TargetList[Idx]!;
    Target.StopLoop();
    const [Err] = await TargetsRepo.DeleteTargetCascade(ID);
    if (Err) {
      // The transaction rolled back, so the row (and its checks) survived —
      // the target must keep polling.
      Target.StartLoop();
      return Fail('Failed to delete monitor');
    }
    TargetList.splice(Idx, 1);
    BroadcastManager.emit('MonitoringTargetListChanged');
    await AuditStep(() =>
      RecordEdit({
        ...MonitorAuditBase(Target),
        Summary: Line('Deleted ', Entity(MonitorDisplayName(Target))),
        Severity: 'warning',
      })
    );
    return Ok(true);
  },

  // Move a monitoring target to a group with a specific weight (used by drag/drop ordering).
  async SetGroupAndWeight(TargetID: unknown, GroupID: number | null, Weight: unknown) {
    const Target = TargetList.find((T) => T.TargetID === Number(TargetID));
    const FromGroupID = Target ? Target.GroupID : null;
    const Result = await GroupOrdering.SetGroupAndWeight(TargetID, GroupID, Weight);
    if (Target && !Result[0]) {
      await RecordGroupMove(MonitorAuditBase(Target), FromGroupID, Target.GroupID);
    }
    return Result;
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
    notFound: 'Monitor not found',
    update: 'Failed to update monitor',
    move: 'Failed to move monitors to no group',
    reconcile: 'Failed to reconcile orphaned monitors',
  },
});

export { Manager };
