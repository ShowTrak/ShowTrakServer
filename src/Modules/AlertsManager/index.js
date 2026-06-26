const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('AlertsManager');

const { Manager: DB } = require('../DB');
const { Manager: AlertActions } = require('../AlertActions');
const { Manager: BroadcastManager } = require('../Broadcast');
const { Ok, Fail } = require('../Utils');

const { TRIGGERS } = require('./triggers');
const {
  normalizeRuleRow,
  toRowScope,
  toRowActions,
  toRowTriggerConfig,
} = require('./serialization');
const { isScopeMatch, triggerMatches, describeContext } = require('./evaluation');

const Manager = {};

let Initialized = false;
let RuleList = [];
const EntityOnlineState = new Map();
const EntityDegradedState = new Map();
let AlertActionsEnabled = true;

async function writeHistory(Rule, Context, Results) {
  const ResultPayload = {
    Actions: Results,
  };
  const Run =
    typeof DB.RunWithoutDirtyTracking === 'function'
      ? DB.RunWithoutDirtyTracking.bind(DB)
      : DB.Run.bind(DB);
  const [Err] = await Run(
    'INSERT INTO AlertHistory (RuleID, TriggerType, TriggerSource, Context, Result, Timestamp) VALUES (?, ?, ?, ?, ?, ?)',
    [
      Rule.RuleID,
      Rule.TriggerType,
      Context.EntityType,
      JSON.stringify(Context),
      JSON.stringify(ResultPayload),
      Date.now(),
    ]
  );
  if (Err) Logger.error('Failed to persist alert history', Err);
}

async function executeRule(Rule, Context) {
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

  const Results = Settled.map((Result, Index) => {
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
    TriggerType: Rule.TriggerType,
    Context: EventContext,
    Results,
    Timestamp: Date.now(),
  });
}

async function evaluateAgainstRules(Context) {
  for (const Rule of RuleList) {
    if (!Rule.Enabled) continue;
    if (!isScopeMatch(Rule, Context)) continue;
    if (!triggerMatches(Rule, Context)) continue;
    await executeRule(Rule, Context);
  }
}

Manager.Init = async () => {
  if (Initialized) return;
  const [Err, Rows] = await DB.All('SELECT * FROM AlertRules ORDER BY RuleID DESC', []);
  if (Err) {
    Logger.error('Failed to load alert rules', Err);
    RuleList = [];
    Initialized = true;
    return;
  }
  RuleList = (Rows || []).map(normalizeRuleRow);
  Initialized = true;
};

Manager.GetAll = async () => {
  if (!Initialized) await Manager.Init();
  return Ok(RuleList);
};

Manager.Get = async (RuleID) => {
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

Manager.Create = async (Payload) => {
  if (!Initialized) await Manager.Init();

  const Timestamp = Date.now();
  const Row = {
    Title: Payload.Title,
    Scope: toRowScope(Payload.Scope || {}),
    TriggerType: Payload.TriggerType,
    TriggerConfig: toRowTriggerConfig(Payload.TriggerConfig || {}),
    Actions: toRowActions(Payload.Actions || []),
    Enabled: Payload.Enabled ? 1 : 0,
    Timestamp,
    UpdatedAt: Timestamp,
  };

  const [Err, Res] = await DB.Run(
    'INSERT INTO AlertRules (Title, Scope, TriggerType, TriggerConfig, Actions, Enabled, Timestamp, UpdatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      Row.Title,
      Row.Scope,
      Row.TriggerType,
      Row.TriggerConfig,
      Row.Actions,
      Row.Enabled,
      Row.Timestamp,
      Row.UpdatedAt,
    ]
  );
  if (Err || !Res) return Fail('Failed to create alert rule');

  const Created = normalizeRuleRow({
    RuleID: Res.lastID,
    ...Row,
  });

  RuleList.unshift(Created);
  BroadcastManager.emit('AlertRuleListChanged');
  return Ok(Created);
};

Manager.Update = async (RuleID, Payload) => {
  if (!Initialized) await Manager.Init();
  const ID = Number(RuleID);
  const Existing = RuleList.find((R) => R.RuleID === ID);
  if (!Existing) return Fail('Alert rule not found');

  const Next = {
    Title: Object.prototype.hasOwnProperty.call(Payload, 'Title') ? Payload.Title : Existing.Title,
    Scope: Object.prototype.hasOwnProperty.call(Payload, 'Scope') ? Payload.Scope : Existing.Scope,
    TriggerType: Object.prototype.hasOwnProperty.call(Payload, 'TriggerType')
      ? Payload.TriggerType
      : Existing.TriggerType,
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

  const [Err] = await DB.Run(
    'UPDATE AlertRules SET Title = ?, Scope = ?, TriggerType = ?, TriggerConfig = ?, Actions = ?, Enabled = ?, UpdatedAt = ? WHERE RuleID = ?',
    [
      Next.Title,
      toRowScope(Next.Scope),
      Next.TriggerType,
      toRowTriggerConfig(Next.TriggerConfig),
      toRowActions(Next.Actions),
      Next.Enabled ? 1 : 0,
      UpdatedAt,
      ID,
    ]
  );

  if (Err) return Fail('Failed to update alert rule');

  const Updated = {
    ...Existing,
    ...Next,
    UpdatedAt,
  };

  RuleList = RuleList.map((Rule) => (Rule.RuleID === ID ? Updated : Rule));
  BroadcastManager.emit('AlertRuleListChanged');
  return Ok(Updated);
};

Manager.Delete = async (RuleID) => {
  if (!Initialized) await Manager.Init();
  const ID = Number(RuleID);
  const [Err] = await DB.Run('DELETE FROM AlertRules WHERE RuleID = ?', [ID]);
  if (Err) return Fail('Failed to delete alert rule');
  RuleList = RuleList.filter((Rule) => Rule.RuleID !== ID);
  BroadcastManager.emit('AlertRuleListChanged');
  return Ok(true);
};

Manager.SetEnabled = async (RuleID, Enabled) => {
  return Manager.Update(RuleID, { Enabled: !!Enabled });
};

Manager.GetActionsEnabled = () => {
  return AlertActionsEnabled;
};

Manager.SetActionsEnabled = (Enabled) => {
  AlertActionsEnabled = !!Enabled;
  return AlertActionsEnabled;
};

// Many alert handlers share the same "client event with optional payload" shape:
// they ignore events without a UUID and forward a normalized client Context to
// the rule engine. This factory captures that shape; only the trigger type,
// severity and payload key differ.
function makeClientEventHandler(TriggerType, Severity, PayloadKey) {
  return async (Client, Payload) => {
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

Manager.HandleClientUpdated = async (Client) => {
  if (!Client || !Client.UUID) return;

  const Key = `client:${Client.UUID}`;
  const Prev = EntityOnlineState.get(Key);
  const Current = !!Client.Online;
  EntityOnlineState.set(Key, Current);

  if (typeof Prev === 'boolean' && Prev !== Current) {
    if (!Current) {
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
    } else {
      await evaluateAgainstRules({
        TriggerType: TRIGGERS.CLIENT_ONLINE,
        EntityType: 'client',
        EntityName: Client.Nickname || Client.Hostname || Client.UUID,
        UUID: Client.UUID,
        GroupID: Client.GroupID == null ? null : Client.GroupID,
        IP: Client.IP || null,
        Severity: 'success',
        RawData: Client,
      });
    }
  }

  const PrevDegraded = EntityDegradedState.get(Key) === true;
  const CurrentDegraded = Current && !!Client.Degraded;
  EntityDegradedState.set(Key, CurrentDegraded);

  if (CurrentDegraded && !PrevDegraded) {
    await evaluateAgainstRules({
      TriggerType: TRIGGERS.CLIENT_DEGRADED,
      EntityType: 'client',
      EntityName: Client.Nickname || Client.Hostname || Client.UUID,
      UUID: Client.UUID,
      GroupID: Client.GroupID == null ? null : Client.GroupID,
      IP: Client.IP || null,
      Severity: 'warning',
      Degraded: true,
      RawData: Client,
    });
  }
};

Manager.HandleMonitoringTargetUpdated = async (Target) => {
  if (!Target || !Target.TargetID) return;

  const Key = `monitor:${Target.TargetID}`;
  const Prev = EntityOnlineState.get(Key);
  const Current = !!Target.Online;
  EntityOnlineState.set(Key, Current);

  if (typeof Prev === 'boolean' && Prev !== Current) {
    if (!Current) {
      await evaluateAgainstRules({
        TriggerType: TRIGGERS.CLIENT_OFFLINE,
        EntityType: 'monitor',
        EntityName: Target.Nickname || Target.Address || `Target ${Target.TargetID}`,
        UUID: `monitor:${Target.TargetID}`,
        TargetID: Target.TargetID,
        GroupID: Target.GroupID == null ? null : Target.GroupID,
        IP: Target.Address || null,
        Severity: 'warning',
        RawData: Target,
      });
    } else {
      await evaluateAgainstRules({
        TriggerType: TRIGGERS.CLIENT_ONLINE,
        EntityType: 'monitor',
        EntityName: Target.Nickname || Target.Address || `Target ${Target.TargetID}`,
        UUID: `monitor:${Target.TargetID}`,
        TargetID: Target.TargetID,
        GroupID: Target.GroupID == null ? null : Target.GroupID,
        IP: Target.Address || null,
        Severity: 'success',
        RawData: Target,
      });
    }
  }

  const PrevDegraded = EntityDegradedState.get(Key) === true;
  const CurrentDegraded = Current && !!Target.Degraded;
  EntityDegradedState.set(Key, CurrentDegraded);

  if (CurrentDegraded && !PrevDegraded) {
    await evaluateAgainstRules({
      TriggerType: TRIGGERS.CLIENT_DEGRADED,
      EntityType: 'monitor',
      EntityName: Target.Nickname || Target.Address || `Target ${Target.TargetID}`,
      UUID: `monitor:${Target.TargetID}`,
      TargetID: Target.TargetID,
      GroupID: Target.GroupID == null ? null : Target.GroupID,
      IP: Target.Address || null,
      Severity: 'warning',
      Degraded: true,
      LastLatencyMs: Target.LastLatencyMs == null ? null : Target.LastLatencyMs,
      LastError: Target.LastError || null,
      RawData: Target,
    });
  }
};

Manager.HandleScriptExecutionUpdated = async (Executions) => {
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

// Rebuild in-memory rules after external bulk writes (e.g., config import).
Manager.Reload = async () => {
  Initialized = false;
  RuleList = [];
  EntityOnlineState.clear();
  EntityDegradedState.clear();
  await Manager.Init();
  BroadcastManager.emit('AlertRuleListChanged');
};

module.exports = {
  Manager,
};
