import { CreateLogger } from '../Logger';
import { Manager as DB } from '../DB';
import { CreateAlertRulesRepository } from '../DB/repositories/alert-rules';
import { CreateAlertHistoryRepository } from '../DB/repositories/alert-history';
import { Manager as AlertActions } from '../AlertActions';
import { Manager as BroadcastManager } from '../Broadcast';
import { Manager as TagManager } from '../TagManager';
import { ScopeReferencesTags } from '../ScopeMatching';
import { Ok, Fail } from '../Utils';
import type { Result } from '../../types/result';
import type { AlertTriggerType, TagView } from '@showtrak/protocol';
import type { AlertRuleWriteRow } from '../DB/repositories/alert-rules';

import { TRIGGERS } from './triggers';
import {
  normalizeRuleRow,
  toRowScope,
  toRowActions,
  toRowTriggerConfig,
  toRowTriggerTypes,
} from './serialization';
import { isScopeMatch, triggerMatches, describeContext } from './evaluation';
import type { AlertContext, AlertRule } from './evaluation';

const Logger = CreateLogger('AlertsManager');

// Client/dummy-shaped entity as delivered to the alert event handlers. Fields
// are optional because the handlers guard on UUID before reading the rest.
interface AlertEntityLike {
  UUID?: string | null;
  Nickname?: string | null;
  Hostname?: string | null;
  GroupID?: number | null;
  IP?: string | null;
  Online?: boolean;
  Degraded?: boolean;
  Unassigned?: boolean;
  [key: string]: unknown;
}

// Monitoring-target snapshot delivered to HandleMonitoringTargetUpdated.
interface AlertTargetLike {
  TargetID?: number;
  Nickname?: string | null;
  Address?: string | null;
  GroupID?: number | null;
  Online?: boolean;
  Degraded?: boolean;
  LastLatencyMs?: number | null;
  LastError?: string | null;
  Checks?: unknown;
  [key: string]: unknown;
}

// Validated create/update payloads (IPCValidation guarantees Title/TriggerType
// on create; update is a partial patch).
interface AlertRuleCreatePayload {
  Title: string;
  Scope?: { Workspace?: unknown; Groups?: unknown; Clients?: unknown; Tags?: unknown };
  TriggerTypes: string[];
  TriggerConfig?: Record<string, unknown>;
  Actions?: unknown[];
  Enabled?: unknown;
}
type AlertRuleUpdatePayload = Partial<AlertRuleCreatePayload>;

// Per-action outcome recorded in alert history / broadcast payloads.
interface AlertActionResultSummary {
  Type: string;
  Success: boolean;
  Error: string | null;
}

type ClientEventHandler = (Client: AlertEntityLike, Payload?: unknown) => Promise<void>;

// Public surface of the AlertsManager. Methods are assigned below in definition
// order; the assertion is safe because every member is populated at module load.
interface AlertsManagerType {
  Init(): Promise<void>;
  GetAll(): Promise<Result<AlertRule[]>>;
  Get(RuleID: unknown): Promise<Result<AlertRule>>;
  GetTriggers(): AlertTriggerType[];
  GetActionTypes(): ReturnType<typeof AlertActions.GetAll>;
  Create(Payload: AlertRuleCreatePayload): Promise<Result<AlertRule>>;
  Update(RuleID: unknown, Payload: AlertRuleUpdatePayload): Promise<Result<AlertRule>>;
  Delete(RuleID: unknown): Promise<Result<boolean>>;
  SetEnabled(RuleID: unknown, Enabled: unknown): Promise<Result<AlertRule>>;
  GetActionsEnabled(): boolean;
  SetActionsEnabled(Enabled: unknown): boolean;
  HandleUSBDeviceConnected: ClientEventHandler;
  HandleUSBDeviceDisconnected: ClientEventHandler;
  HandleNonCriticalUSBDeviceConnected: ClientEventHandler;
  HandleNonCriticalUSBDeviceDisconnected: ClientEventHandler;
  HandleCriticalUSBDeviceConnected: ClientEventHandler;
  HandleCriticalUSBDeviceDisconnected: ClientEventHandler;
  HandleApplicationStarted: ClientEventHandler;
  HandleApplicationStopped: ClientEventHandler;
  HandleCriticalApplicationStarted: ClientEventHandler;
  HandleCriticalApplicationStopped: ClientEventHandler;
  HandleNonCriticalApplicationStarted: ClientEventHandler;
  HandleNonCriticalApplicationStopped: ClientEventHandler;
  HandleClientUpdated(Client: AlertEntityLike): Promise<void>;
  HandleMonitoringTargetUpdated(Target: AlertTargetLike): Promise<void>;
  HandleFreeKioskTerminalUpdated(Terminal: AlertEntityLike): Promise<void>;
  HandleScriptExecutionUpdated(Executions: unknown): Promise<void>;
  FlushSettledBaselineFaults(MinAgeMs: number, Clients?: AlertEntityLike[]): Promise<number>;
  Reload(): Promise<void>;
}

// Constructed with this module's DB import so test-injected DB mocks flow
// through the repositories unchanged.
const RulesRepo = CreateAlertRulesRepository(DB);
const HistoryRepo = CreateAlertHistoryRepository(DB);

const Manager = {} as AlertsManagerType;

let Initialized = false;
let RuleList: AlertRule[] = [];
// Last known online/degraded state per entity. Alerts fire on TRANSITIONS
// between two observed states, so the absence of a key is meaningful: it means
// this process has never seen the entity, and the first snapshot establishes
// the baseline instead of firing.
//
// That is what keeps a server restart quiet. A rig that is still coming up has
// monitors failing and half its machines absent, and every one of those is a
// state that predates us rather than something that just happened — announcing
// them as fresh outages buries the one alert that matters. Anything that
// changes after that first observation is a real transition and alerts
// immediately, so an outage seconds into a show is still caught.
const EntityOnlineState = new Map<string, boolean>();
const EntityDegradedState = new Map<string, boolean>();
// Which metrics were breaching on a FreeKiosk terminal's previous poll, so an
// alarm fires once when it starts rather than on every poll while it persists.
const FreeKioskAlarmState = new Map<string, Set<string>>();
// Terminals seen at least once since boot. The first sighting establishes a
// baseline instead of alerting: a terminal that was already over threshold when
// ShowTrak started has not just gone wrong.
const FreeKioskSeenState = new Set<string>();
let AlertActionsEnabled = true;

// A fault that was already true the first time we looked at an entity.
//
// It is not announced as it is found — at server start that would fire for
// every monitor whose device is mid-boot — but it is not thrown away either,
// because a device that is genuinely dead would then only ever be discoverable
// by looking at the screen. Each one is held here and announced ONCE if it is
// still true when the settle period has passed (see FlushSettledBaselineFaults,
// driven by the main process). A fault that fixes itself while the rig comes up
// is dropped and never heard of.
interface BaselineFault {
  FirstSeenAt: number;
  // Refreshed on every snapshot that still shows the fault, so the alert
  // reports the current error/latency rather than the first one seen.
  Context: AlertContext;
}
const PendingBaselineFaults = new Map<string, BaselineFault>();
let StartedAt = Date.now();

function noteBaselineFault(FaultKey: string, Context: AlertContext) {
  const Existing = PendingBaselineFaults.get(FaultKey);
  if (Existing) {
    Existing.Context = Context;
    return;
  }
  PendingBaselineFaults.set(FaultKey, { FirstSeenAt: Date.now(), Context });
}

// Update a held fault's details without creating one. A fault that persists
// between snapshots must not become "pending" if it was announced the moment it
// happened — that would announce the same outage a second time when the settle
// sweep runs.
function refreshBaselineFault(FaultKey: string, Context: AlertContext) {
  const Existing = PendingBaselineFaults.get(FaultKey);
  if (Existing) Existing.Context = Context;
}

function clearBaselineFault(FaultKey: string) {
  PendingBaselineFaults.delete(FaultKey);
}

// AlertHistory retention. The table is append-only (a row per rule firing), so
// without a cap it grows without bound over a long-running show. Keep the newest
// ALERT_HISTORY_MAX_ROWS entries, pruned on a low-frequency unref'd timer (plus
// once at Init to bound histories carried over from a previous session).
const ALERT_HISTORY_MAX_ROWS = 10000;
const ALERT_HISTORY_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
let historyPruneTimer: ReturnType<typeof setInterval> | null = null;

async function pruneAlertHistory() {
  try {
    const [Err] = await HistoryRepo.PruneToMaxRows(ALERT_HISTORY_MAX_ROWS);
    if (Err) Logger.error('Failed to prune alert history', Err);
  } catch (error) {
    Logger.error('Failed to prune alert history', error);
  }
}

function startHistoryPruning() {
  if (historyPruneTimer) return;
  historyPruneTimer = setInterval(() => {
    void pruneAlertHistory();
  }, ALERT_HISTORY_PRUNE_INTERVAL_MS);
  if (typeof historyPruneTimer.unref === 'function') historyPruneTimer.unref();
  void pruneAlertHistory();
}

async function writeHistory(
  Rule: AlertRule,
  Context: AlertContext,
  Results: AlertActionResultSummary[]
) {
  const ResultPayload = {
    Actions: Results,
  };
  const [Err] = await HistoryRepo.Insert({
    RuleID: Rule.RuleID,
    // Record the specific stimulus that fired, not the rule's whole trigger list.
    TriggerType: Context.TriggerType,
    TriggerSource: Context.EntityType,
    Context: JSON.stringify(Context),
    Result: JSON.stringify(ResultPayload),
    Timestamp: Date.now(),
  });
  if (Err) Logger.error('Failed to persist alert history', Err);
}

async function executeRule(Rule: AlertRule, Context: AlertContext) {
  if (!AlertActionsEnabled) return;

  const Actions = Array.isArray(Rule.Actions) ? Rule.Actions : [];
  if (!Actions.length) return;

  const Description = describeContext(Context);
  const EventContext = {
    ...Context,
    Description,
  };

  const Settled = await Promise.allSettled(
    Actions.map((Action) =>
      AlertActions.Execute(Action, {
        ...EventContext,
      })
    )
  );

  const Results: AlertActionResultSummary[] = Settled.map((Result, Index) => {
    const ActionType = Actions[Index] && Actions[Index].Type ? Actions[Index].Type : 'unknown';
    if (Result.status === 'fulfilled') {
      return {
        Type: ActionType,
        Success: !!(Result.value && Result.value.Success),
        Error: Result.value && Result.value.Error ? Result.value.Error : null,
      };
    }
    return {
      Type: ActionType,
      Success: false,
      Error: Result.reason && Result.reason.message ? Result.reason.message : String(Result.reason),
    };
  });

  await writeHistory(Rule, Context, Results);

  BroadcastManager.emit('AlertTriggered', {
    RuleID: Rule.RuleID,
    RuleTitle: Rule.Title,
    TriggerType: Context.TriggerType,
    Context: EventContext,
    Results,
    Timestamp: Date.now(),
  });
}

async function evaluateAgainstRules(Context: AlertContext) {
  // Rules that target tags need the tag list to resolve membership. Reading it
  // costs a query, so it is fetched once per event and only when some enabled
  // rule actually names a tag — the common case (no tag-targeted rules) still
  // evaluates without touching the DB.
  let Tags: TagView[] | undefined;
  if (RuleList.some((Rule) => Rule.Enabled && ScopeReferencesTags(Rule.Scope))) {
    Tags = await TagManager.GetAllViews();
  }

  for (const Rule of RuleList) {
    if (!Rule.Enabled) continue;
    if (!isScopeMatch(Rule, Context, Tags)) continue;
    if (!triggerMatches(Rule, Context)) continue;
    await executeRule(Rule, Context);
  }
}

Manager.Init = async () => {
  if (Initialized) return;
  const [Err, Rows] = await RulesRepo.GetAll();
  if (Err) {
    Logger.error('Failed to load alert rules', Err);
    RuleList = [];
    Initialized = true;
    return;
  }
  RuleList = (Rows || []).map(normalizeRuleRow);
  Initialized = true;
  StartedAt = Date.now();
  startHistoryPruning();
};

Manager.GetAll = async () => {
  if (!Initialized) await Manager.Init();
  return Ok(RuleList);
};

Manager.Get = async (RuleID: unknown) => {
  if (!Initialized) await Manager.Init();
  const Rule = RuleList.find((R) => R.RuleID === Number(RuleID));
  if (!Rule) return Fail('Alert rule not found');
  return Ok(Rule);
};

Manager.GetTriggers = () => {
  return [
    { ID: TRIGGERS.CLIENT_OFFLINE, Name: 'Client Offline' },
    { ID: TRIGGERS.CLIENT_DEGRADED, Name: 'Client Degraded' },
    { ID: TRIGGERS.CLIENT_ONLINE, Name: 'Client Online' },
    { ID: TRIGGERS.SCRIPT_EXECUTION_FAILED, Name: 'Script Execution Failed' },
    { ID: TRIGGERS.FREEKIOSK_METRIC_ALARM, Name: 'FreeKiosk Metric Alarm' },
    { ID: TRIGGERS.USB_DEVICE_CONNECTED, Name: 'USB Device Connected' },
    { ID: TRIGGERS.USB_DEVICE_DISCONNECTED, Name: 'USB Device Disconnected' },
    {
      ID: TRIGGERS.NON_CRITICAL_USB_DEVICE_CONNECTED,
      Name: 'Non Critical USB Device Connected',
    },
    {
      ID: TRIGGERS.NON_CRITICAL_USB_DEVICE_DISCONNECTED,
      Name: 'Non Critical USB Device Disconnected',
    },
    { ID: TRIGGERS.CRITICAL_USB_DEVICE_CONNECTED, Name: 'Critical USB Device Connected' },
    {
      ID: TRIGGERS.CRITICAL_USB_DEVICE_DISCONNECTED,
      Name: 'Critical USB Device Disconnected',
    },
    { ID: TRIGGERS.APPLICATION_STARTED, Name: 'Application Started' },
    { ID: TRIGGERS.APPLICATION_STOPPED, Name: 'Application Stopped' },
    { ID: TRIGGERS.CRITICAL_APPLICATION_STARTED, Name: 'Critical Application Started' },
    { ID: TRIGGERS.CRITICAL_APPLICATION_STOPPED, Name: 'Critical Application Stopped' },
    {
      ID: TRIGGERS.NON_CRITICAL_APPLICATION_STARTED,
      Name: 'Non Critical Application Started',
    },
    {
      ID: TRIGGERS.NON_CRITICAL_APPLICATION_STOPPED,
      Name: 'Non Critical Application Stopped',
    },
  ];
};

Manager.GetActionTypes = () => {
  return AlertActions.GetAll();
};

Manager.Create = async (Payload: AlertRuleCreatePayload) => {
  if (!Initialized) await Manager.Init();

  const Timestamp = Date.now();
  const Row: AlertRuleWriteRow = {
    Title: Payload.Title,
    Scope: toRowScope(Payload.Scope || {}),
    TriggerType: toRowTriggerTypes(Payload.TriggerTypes),
    TriggerConfig: toRowTriggerConfig(Payload.TriggerConfig || {}),
    Actions: toRowActions(Payload.Actions || []),
    Enabled: Payload.Enabled ? 1 : 0,
    Timestamp,
    UpdatedAt: Timestamp,
  };

  const [Err, Res] = await RulesRepo.Insert(Row);
  if (Err || !Res) return Fail('Failed to create alert rule');

  const Created = normalizeRuleRow({
    RuleID: Res.lastID,
    ...Row,
  });

  RuleList.unshift(Created);
  BroadcastManager.emit('AlertRuleListChanged');
  return Ok(Created);
};

Manager.Update = async (RuleID: unknown, Payload: AlertRuleUpdatePayload) => {
  if (!Initialized) await Manager.Init();
  const ID = Number(RuleID);
  const Existing = RuleList.find((R) => R.RuleID === ID);
  if (!Existing) return Fail('Alert rule not found');

  const Next = {
    Title: Object.prototype.hasOwnProperty.call(Payload, 'Title') ? Payload.Title : Existing.Title,
    Scope: Object.prototype.hasOwnProperty.call(Payload, 'Scope') ? Payload.Scope : Existing.Scope,
    TriggerTypes: Object.prototype.hasOwnProperty.call(Payload, 'TriggerTypes')
      ? Payload.TriggerTypes
      : Existing.TriggerTypes,
    TriggerConfig: Object.prototype.hasOwnProperty.call(Payload, 'TriggerConfig')
      ? Payload.TriggerConfig
      : Existing.TriggerConfig,
    Actions: Object.prototype.hasOwnProperty.call(Payload, 'Actions')
      ? Payload.Actions
      : Existing.Actions,
    Enabled: Object.prototype.hasOwnProperty.call(Payload, 'Enabled')
      ? !!Payload.Enabled
      : Existing.Enabled,
  };

  const UpdatedAt = Date.now();

  // Title/TriggerTypes are never absent at runtime (the ternary falls back to the
  // Existing rule's values), so the persisted row satisfies AlertRuleWriteRow.
  const [Err] = await RulesRepo.Update(ID, {
    Title: Next.Title,
    Scope: toRowScope(
      Next.Scope as { Workspace?: unknown; Groups?: unknown; Clients?: unknown; Tags?: unknown }
    ),
    TriggerType: toRowTriggerTypes(Next.TriggerTypes),
    TriggerConfig: toRowTriggerConfig(Next.TriggerConfig),
    Actions: toRowActions(Next.Actions),
    Enabled: Next.Enabled ? 1 : 0,
    UpdatedAt,
  } as Omit<AlertRuleWriteRow, 'Timestamp'>);

  if (Err) return Fail('Failed to update alert rule');

  const Updated = {
    ...Existing,
    ...Next,
    UpdatedAt,
  } as AlertRule;

  RuleList = RuleList.map((Rule) => (Rule.RuleID === ID ? Updated : Rule));
  BroadcastManager.emit('AlertRuleListChanged');
  return Ok(Updated);
};

Manager.Delete = async (RuleID: unknown) => {
  if (!Initialized) await Manager.Init();
  const ID = Number(RuleID);
  const [Err] = await RulesRepo.Delete(ID);
  if (Err) return Fail('Failed to delete alert rule');
  RuleList = RuleList.filter((Rule) => Rule.RuleID !== ID);
  BroadcastManager.emit('AlertRuleListChanged');
  return Ok(true);
};

Manager.SetEnabled = async (RuleID: unknown, Enabled: unknown) => {
  return Manager.Update(RuleID, { Enabled: !!Enabled });
};

Manager.GetActionsEnabled = () => {
  return AlertActionsEnabled;
};

Manager.SetActionsEnabled = (Enabled: unknown) => {
  AlertActionsEnabled = !!Enabled;
  // Notify integrations (e.g. the SDK control API) of the new global state so
  // their alert-actions feedback stays live regardless of who toggled it.
  BroadcastManager.emit('AlertActionsUpdated', AlertActionsEnabled);
  return AlertActionsEnabled;
};

// Many alert handlers share the same "client event with optional payload" shape.
function makeClientEventHandler(
  TriggerType: string,
  Severity: string,
  PayloadKey: string
): ClientEventHandler {
  return async (Client: AlertEntityLike, Payload?: unknown) => {
    if (!Client || !Client.UUID) return;
    await evaluateAgainstRules({
      TriggerType,
      EntityType: 'client',
      EntityName: Client.Nickname || Client.Hostname || Client.UUID,
      UUID: Client.UUID,
      GroupID: Client.GroupID == null ? null : Client.GroupID,
      IP: Client.IP || null,
      Severity,
      ...(PayloadKey ? { [PayloadKey]: Payload || null } : {}),
      RawData: Client,
    });
  };
}

Manager.HandleUSBDeviceConnected = makeClientEventHandler(
  TRIGGERS.USB_DEVICE_CONNECTED,
  'info',
  'Device'
);

Manager.HandleUSBDeviceDisconnected = makeClientEventHandler(
  TRIGGERS.USB_DEVICE_DISCONNECTED,
  'warning',
  'Device'
);

Manager.HandleNonCriticalUSBDeviceConnected = makeClientEventHandler(
  TRIGGERS.NON_CRITICAL_USB_DEVICE_CONNECTED,
  'info',
  'Device'
);

Manager.HandleNonCriticalUSBDeviceDisconnected = makeClientEventHandler(
  TRIGGERS.NON_CRITICAL_USB_DEVICE_DISCONNECTED,
  'warning',
  'Device'
);

Manager.HandleCriticalUSBDeviceConnected = makeClientEventHandler(
  TRIGGERS.CRITICAL_USB_DEVICE_CONNECTED,
  'warning',
  'Device'
);

Manager.HandleCriticalUSBDeviceDisconnected = makeClientEventHandler(
  TRIGGERS.CRITICAL_USB_DEVICE_DISCONNECTED,
  'warning',
  'Device'
);

Manager.HandleApplicationStarted = makeClientEventHandler(
  TRIGGERS.APPLICATION_STARTED,
  'info',
  'Application'
);

Manager.HandleApplicationStopped = makeClientEventHandler(
  TRIGGERS.APPLICATION_STOPPED,
  'warning',
  'Application'
);

Manager.HandleCriticalApplicationStarted = makeClientEventHandler(
  TRIGGERS.CRITICAL_APPLICATION_STARTED,
  'warning',
  'Application'
);

Manager.HandleCriticalApplicationStopped = makeClientEventHandler(
  TRIGGERS.CRITICAL_APPLICATION_STOPPED,
  'warning',
  'Application'
);

Manager.HandleNonCriticalApplicationStarted = makeClientEventHandler(
  TRIGGERS.NON_CRITICAL_APPLICATION_STARTED,
  'info',
  'Application'
);

Manager.HandleNonCriticalApplicationStopped = makeClientEventHandler(
  TRIGGERS.NON_CRITICAL_APPLICATION_STOPPED,
  'warning',
  'Application'
);

Manager.HandleClientUpdated = async (Client: AlertEntityLike) => {
  if (!Client || !Client.UUID) return;

  const UUID = Client.UUID;
  const Key = `client:${UUID}`;
  const Prev = EntityOnlineState.get(Key);
  const Current = !!Client.Online;
  EntityOnlineState.set(Key, Current);

  // A reserved slot has no hardware behind it, so being offline is its normal
  // state rather than a fault worth alerting on. The tracked state above is
  // still updated so that filling the slot (which clears the flag) compares
  // against a truthful baseline instead of firing on a stale transition.
  if (Client.Unassigned) {
    EntityDegradedState.set(Key, false);
    return;
  }

  const ClientBase = {
    EntityType: 'client',
    EntityName: Client.Nickname || Client.Hostname || UUID,
    UUID,
    GroupID: Client.GroupID == null ? null : Client.GroupID,
    IP: Client.IP || null,
  };
  const OfflineContext = (): AlertContext => ({
    ...ClientBase,
    TriggerType: TRIGGERS.CLIENT_OFFLINE,
    Severity: 'warning',
    RawData: Client,
  });

  if (typeof Prev !== 'boolean') {
    if (!Current) noteBaselineFault(`offline:${Key}`, OfflineContext());
  } else if (Prev !== Current) {
    if (!Current) {
      await evaluateAgainstRules(OfflineContext());
    } else {
      clearBaselineFault(`offline:${Key}`);
      await evaluateAgainstRules({
        ...ClientBase,
        TriggerType: TRIGGERS.CLIENT_ONLINE,
        Severity: 'success',
        RawData: Client,
      });
    }
  } else if (!Current) {
    refreshBaselineFault(`offline:${Key}`, OfflineContext());
  }

  const SeenDegradedBefore = EntityDegradedState.has(Key);
  const PrevDegraded = EntityDegradedState.get(Key) === true;
  const CurrentDegraded = Current && !!Client.Degraded;
  EntityDegradedState.set(Key, CurrentDegraded);

  const DegradedContext = (): AlertContext => ({
    ...ClientBase,
    TriggerType: TRIGGERS.CLIENT_DEGRADED,
    Severity: 'warning',
    Degraded: true,
    RawData: Client,
  });

  if (!CurrentDegraded) {
    clearBaselineFault(`degraded:${Key}`);
  } else if (!SeenDegradedBefore) {
    noteBaselineFault(`degraded:${Key}`, DegradedContext());
  } else if (!PrevDegraded) {
    await evaluateAgainstRules(DegradedContext());
  } else {
    refreshBaselineFault(`degraded:${Key}`, DegradedContext());
  }
};

// Per-metric alarms for a FreeKiosk terminal.
//
// The terminal's online/offline/degraded lifecycle is NOT handled here: its
// snapshot is client-shaped, so broadcast-bridge routes it through
// HandleClientUpdated exactly as it does a dummy client, and CLIENT_OFFLINE /
// CLIENT_ONLINE / CLIENT_DEGRADED work unchanged. This adds only the finer
// signal — which specific metric started breaching.
Manager.HandleFreeKioskTerminalUpdated = async (Terminal: AlertEntityLike) => {
  if (!Terminal || !Terminal.UUID) return;

  const UUID = Terminal.UUID;
  const Alarms = Array.isArray(Terminal.Alarms)
    ? (Terminal.Alarms as Array<Record<string, unknown>>)
    : [];
  const Breaching = new Map<string, Record<string, unknown>>();
  for (const Alarm of Alarms) {
    const Key = Alarm && typeof Alarm.Key === 'string' ? Alarm.Key : null;
    if (Key) Breaching.set(Key, Alarm);
  }

  const Base = {
    EntityType: 'freekiosk',
    EntityName: Terminal.Nickname || Terminal.Hostname || UUID,
    UUID,
    GroupID: Terminal.GroupID == null ? null : Terminal.GroupID,
    IP: Terminal.IP || null,
  };

  const Tracked = FreeKioskAlarmState.get(UUID) || new Set<string>();

  for (const [MetricKey, Alarm] of Breaching) {
    const FaultKey = `metric:fk:${UUID}:${MetricKey}`;
    const Context = (): AlertContext => ({
      ...Base,
      TriggerType: TRIGGERS.FREEKIOSK_METRIC_ALARM,
      Severity: 'warning',
      Degraded: true,
      MetricKey,
      MetricLabel: Alarm.Label == null ? MetricKey : String(Alarm.Label),
      MetricValue: Alarm.Value == null ? null : Alarm.Value,
      Reason: Alarm.Reason == null ? null : String(Alarm.Reason),
      RawData: Terminal,
    });

    if (!FreeKioskSeenState.has(UUID)) {
      // First sighting of this terminal since boot. Something already breaching
      // is a pre-existing condition, not an event — suppress it the same way a
      // client that was already offline at start-up is suppressed.
      noteBaselineFault(FaultKey, Context());
    } else if (!Tracked.has(MetricKey)) {
      await evaluateAgainstRules(Context());
    } else {
      refreshBaselineFault(FaultKey, Context());
    }
  }

  for (const MetricKey of Tracked) {
    if (!Breaching.has(MetricKey)) clearBaselineFault(`metric:fk:${UUID}:${MetricKey}`);
  }

  FreeKioskAlarmState.set(UUID, new Set(Breaching.keys()));
  FreeKioskSeenState.add(UUID);
};

Manager.HandleMonitoringTargetUpdated = async (Target: AlertTargetLike) => {
  if (!Target || !Target.TargetID) return;

  const Key = `monitor:${Target.TargetID}`;
  const Prev = EntityOnlineState.get(Key);
  const Current = !!Target.Online;
  EntityOnlineState.set(Key, Current);

  const TargetBase = {
    EntityType: 'monitor',
    EntityName: Target.Nickname || Target.Address || `Target ${Target.TargetID}`,
    UUID: `monitor:${Target.TargetID}`,
    TargetID: Target.TargetID,
    GroupID: Target.GroupID == null ? null : Target.GroupID,
    IP: Target.Address || null,
  };
  const TargetOfflineContext = (): AlertContext => ({
    ...TargetBase,
    TriggerType: TRIGGERS.CLIENT_OFFLINE,
    Severity: 'warning',
    LastError: Target.LastError || null,
    RawData: Target,
  });

  if (typeof Prev !== 'boolean') {
    if (!Current) noteBaselineFault(`offline:${Key}`, TargetOfflineContext());
  } else if (Prev !== Current) {
    if (!Current) {
      await evaluateAgainstRules(TargetOfflineContext());
    } else {
      clearBaselineFault(`offline:${Key}`);
      await evaluateAgainstRules({
        ...TargetBase,
        TriggerType: TRIGGERS.CLIENT_ONLINE,
        Severity: 'success',
        RawData: Target,
      });
    }
  } else if (!Current) {
    refreshBaselineFault(`offline:${Key}`, TargetOfflineContext());
  }

  const SeenDegradedBefore = EntityDegradedState.has(Key);
  const PrevDegraded = EntityDegradedState.get(Key) === true;
  const CurrentDegraded = Current && !!Target.Degraded;
  EntityDegradedState.set(Key, CurrentDegraded);

  const TargetDegradedContext = (): AlertContext => ({
    ...TargetBase,
    TriggerType: TRIGGERS.CLIENT_DEGRADED,
    Severity: 'warning',
    Degraded: true,
    LastLatencyMs: Target.LastLatencyMs == null ? null : Target.LastLatencyMs,
    LastError: Target.LastError || null,
    RawData: Target,
  });

  if (!CurrentDegraded) {
    clearBaselineFault(`degraded:${Key}`);
  } else if (!SeenDegradedBefore) {
    noteBaselineFault(`degraded:${Key}`, TargetDegradedContext());
  } else if (!PrevDegraded) {
    await evaluateAgainstRules(TargetDegradedContext());
  } else {
    refreshBaselineFault(`degraded:${Key}`, TargetDegradedContext());
  }

  // Per-check alerts (opt-in via check:<CheckID> scope).
  const TargetName = Target.Nickname || Target.Address || `Target ${Target.TargetID}`;
  const Checks = Array.isArray(Target.Checks) ? Target.Checks : [];
  for (const Check of Checks) {
    if (!Check || Check.CheckID == null) continue;
    const CheckKey = `check:${Check.CheckID}`;
    const CheckLabel =
      Check.Name || Check.Address || `${String(Check.Method || '').toUpperCase()} check`;
    const CheckName = `${TargetName} · ${CheckLabel}`;
    const BaseContext = {
      EntityType: 'monitor-check',
      EntityName: CheckName,
      UUID: CheckKey,
      TargetID: Target.TargetID,
      CheckID: Check.CheckID,
      GroupID: Target.GroupID == null ? null : Target.GroupID,
      IP: Check.Address || null,
    };

    const PrevCheck = EntityOnlineState.get(CheckKey);
    const CurrentCheck = !!Check.Online;
    EntityOnlineState.set(CheckKey, CurrentCheck);

    const CheckOfflineContext = (): AlertContext => ({
      ...BaseContext,
      TriggerType: TRIGGERS.CLIENT_OFFLINE,
      Severity: 'warning',
      LastError: Check.LastError || null,
      RawData: Check,
    });

    if (typeof PrevCheck !== 'boolean') {
      if (!CurrentCheck) noteBaselineFault(`offline:${CheckKey}`, CheckOfflineContext());
    } else if (PrevCheck !== CurrentCheck) {
      if (!CurrentCheck) {
        await evaluateAgainstRules(CheckOfflineContext());
      } else {
        clearBaselineFault(`offline:${CheckKey}`);
        await evaluateAgainstRules({
          ...BaseContext,
          TriggerType: TRIGGERS.CLIENT_ONLINE,
          Severity: 'success',
          RawData: Check,
        });
      }
    } else if (!CurrentCheck) {
      refreshBaselineFault(`offline:${CheckKey}`, CheckOfflineContext());
    }

    const SeenCheckDegradedBefore = EntityDegradedState.has(CheckKey);
    const PrevCheckDegraded = EntityDegradedState.get(CheckKey) === true;
    const CurrentCheckDegraded = CurrentCheck && !!Check.Degraded;
    EntityDegradedState.set(CheckKey, CurrentCheckDegraded);

    const CheckDegradedContext = (): AlertContext => ({
      ...BaseContext,
      TriggerType: TRIGGERS.CLIENT_DEGRADED,
      Severity: 'warning',
      Degraded: true,
      LastLatencyMs: Check.LastLatencyMs == null ? null : Check.LastLatencyMs,
      LastError: Check.LastError || null,
      RawData: Check,
    });

    if (!CurrentCheckDegraded) {
      clearBaselineFault(`degraded:${CheckKey}`);
    } else if (!SeenCheckDegradedBefore) {
      noteBaselineFault(`degraded:${CheckKey}`, CheckDegradedContext());
    } else if (!PrevCheckDegraded) {
      await evaluateAgainstRules(CheckDegradedContext());
    } else {
      refreshBaselineFault(`degraded:${CheckKey}`, CheckDegradedContext());
    }
  }
};

Manager.HandleScriptExecutionUpdated = async (Executions: unknown) => {
  if (!Array.isArray(Executions)) return;
  for (const Exe of Executions) {
    if (!Exe || Exe.Status !== 'Failed') continue;
    const Client = Exe.Client || {};
    await evaluateAgainstRules({
      TriggerType: TRIGGERS.SCRIPT_EXECUTION_FAILED,
      EntityType: 'client',
      EntityName: Client.Nickname || Client.Hostname || Client.UUID || 'Unknown Client',
      UUID: Client.UUID || null,
      GroupID: Client.GroupID == null ? null : Client.GroupID,
      IP: Client.IP || null,
      Severity: 'error',
      ScriptName: Exe.Script && Exe.Script.Name ? Exe.Script.Name : 'Unknown Script',
      ScriptID: Exe.Script && Exe.Script.ID ? Exe.Script.ID : null,
      Error: Exe.Error || 'Script execution failed',
      RawData: Exe,
    });
  }
};

/**
 * Announce the faults that were already true when we first looked, once they
 * have outlasted the settle period.
 *
 * Called on a low-frequency sweep by the main process (which owns the schedule
 * and the entity lists). Two kinds of fault qualify:
 *
 *   - one held by a handler above, because the entity's first snapshot already
 *     showed it offline or degraded. If the rig was simply still coming up, it
 *     has recovered by now and was dropped; if it is still faulty, it is real
 *     and gets announced once;
 *   - a client that never reported at all, which no handler can have seen. A
 *     machine that is off when the server starts produces no events whatsoever,
 *     so without this it would be discoverable only by looking at the screen.
 *
 * Reserved (unassigned) slots are skipped for the same reason they are skipped
 * everywhere else: being offline is what they are for.
 *
 * Returns how many alerts were raised, so the caller can log a summary.
 */
Manager.FlushSettledBaselineFaults = async (MinAgeMs: number, Clients: AlertEntityLike[] = []) => {
  if (!Initialized) await Manager.Init();

  const Now = Date.now();
  // The server's own start counts as the beginning of the settle period, so a
  // sweep that runs early (a fault seen seconds after boot) waits its turn.
  if (Now - StartedAt < MinAgeMs) return 0;

  let Raised = 0;

  for (const [FaultKey, Fault] of Array.from(PendingBaselineFaults.entries())) {
    if (Now - Fault.FirstSeenAt < MinAgeMs) continue;
    PendingBaselineFaults.delete(FaultKey);
    Raised += 1;
    await evaluateAgainstRules(Fault.Context);
  }

  for (const Client of Clients) {
    if (!Client || !Client.UUID) continue;
    if (Client.Unassigned) continue;
    if (Client.Online) continue;
    const Key = `client:${Client.UUID}`;
    // A tracked state means a handler has seen this client, so its offline was
    // either announced as a transition or is already held above.
    if (EntityOnlineState.has(Key)) continue;
    EntityOnlineState.set(Key, false);
    Raised += 1;
    await evaluateAgainstRules({
      TriggerType: TRIGGERS.CLIENT_OFFLINE,
      EntityType: 'client',
      EntityName: Client.Nickname || Client.Hostname || Client.UUID,
      UUID: Client.UUID,
      GroupID: Client.GroupID == null ? null : Client.GroupID,
      IP: Client.IP || null,
      Severity: 'warning',
      RawData: Client,
    });
  }

  return Raised;
};

// Rebuild in-memory rules after external bulk writes (e.g., config import).
Manager.Reload = async () => {
  Initialized = false;
  RuleList = [];
  EntityOnlineState.clear();
  EntityDegradedState.clear();
  PendingBaselineFaults.clear();
  // The reloaded state is as fresh as a boot, so give it the same settle period
  // rather than announcing everything the first sweep finds.
  StartedAt = Date.now();
  await Manager.Init();
  BroadcastManager.emit('AlertRuleListChanged');
};

export { Manager };
