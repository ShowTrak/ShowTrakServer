const { Manager: DB } = require('../DB');
const { Manager: BroadcastManager } = require('../Broadcast');
const { Manager: MonitoringMethods } = require('../MonitoringMethods');
const { Ok, Fail } = require('../Utils');
const { createGroupOrdering } = require('../Shared/group-ordering');

const {
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  ParseSettings,
  ClampInterval,
  ClampThreshold,
} = require('./normalize');
const { MonitoringTarget, MonitoringCheck } = require('./target');

const Manager = {};

let TargetList = [];

function ToRowSettings(Method, Settings) {
  const Normalized = MonitoringMethods.NormalizeSettings(Method, Settings || {});
  return JSON.stringify(Normalized);
}

// Insert a single check row for a target and return the persisted row shape.
async function InsertCheckRow(TargetID, Check, Weight, Now) {
  const SettingsJson = ToRowSettings(Check.Method, Check.Settings);
  const Threshold = ClampThreshold(Check.DegradedThresholdMs);
  const [Err, Res] = await DB.Run(
    'INSERT INTO MonitoringChecks (TargetID, Name, Address, Method, Settings, DegradedThresholdMs, Weight, LastSuccessAt, Timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      TargetID,
      Check.Name || '',
      Check.Address || '',
      Check.Method,
      SettingsJson,
      Threshold,
      Weight,
      null,
      Now,
    ]
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
const RENAMED_METHODS = { qlab: 'qlab-workspace' };

function NormalizeMethod(Method) {
  return RENAMED_METHODS[Method] || Method;
}

// Migrate a legacy single-method MonitoringTargets row into one MonitoringChecks
// row. Returns the persisted check row (or null on failure). Idempotent: only
// called for targets that currently have zero checks.
async function MigrateLegacyTargetToCheck(Row) {
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

  const [Err, Res] = await DB.Run(
    'INSERT INTO MonitoringChecks (TargetID, Name, Address, Method, Settings, DegradedThresholdMs, Weight, LastSuccessAt, Timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      Row.TargetID,
      '',
      Row.Address || '',
      Method,
      SettingsJson,
      Threshold,
      100,
      Row.LastSuccessAt || null,
      Row.Timestamp || Now,
    ]
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

Manager.Initialized = false;

Manager.Init = async () => {
  // Normalize any persisted checks that use a renamed method ID so existing
  // probes keep resolving to a registered method after a rename.
  for (const [OldMethod, NewMethod] of Object.entries(RENAMED_METHODS)) {
    await DB.Run('UPDATE MonitoringChecks SET Method = ? WHERE Method = ?', [NewMethod, OldMethod]);
  }

  const [Err, Rows] = await DB.All('SELECT * FROM MonitoringTargets');
  if (Err) {
    Manager.Initialized = true;
    TargetList = [];
    return;
  }

  const [CheckErr, CheckRows] = await DB.All('SELECT * FROM MonitoringChecks');
  const ChecksByTarget = new Map();
  if (!CheckErr) {
    for (const CR of CheckRows || []) {
      const list = ChecksByTarget.get(CR.TargetID) || [];
      list.push(CR);
      ChecksByTarget.set(CR.TargetID, list);
    }
  }

  TargetList = [];
  for (const Row of Rows || []) {
    let Checks = ChecksByTarget.get(Row.TargetID) || [];
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
};

// Rebuild runtime state from DB after external bulk changes (e.g., config import).
Manager.Reload = async () => {
  for (const Target of TargetList) Target.StopLoop();
  TargetList = [];
  Manager.Initialized = false;
  await Manager.Init();
};

Manager.Shutdown = async () => {
  for (const Target of TargetList) {
    try {
      Target.StopLoop();
    } catch {}
  }
};

Manager.GetAll = async () => {
  if (!Manager.Initialized) await Manager.Init();
  return [null, TargetList.map((T) => T.ToJSON())];
};

Manager.Get = async (TargetID) => {
  const ID = Number(TargetID);
  const Cached = TargetList.find((T) => T.TargetID === ID);
  if (!Cached) return ['Monitoring target not found', null];
  return [null, Cached.ToJSON()];
};

// Return the most recent (RAM-only) debug panel for a single check. Used by the
// check editor to show the last raw response without bloating the periodic
// MonitoringTargetUpdated broadcasts with debug HTML.
Manager.GetCheckDebug = async (CheckID) => {
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
};

// Run a single check immediately (outside its normal interval), refresh the
// parent target's aggregate + broadcast, and return the fresh debug snapshot.
// Used by the editor's "Check Now" button.
Manager.RunCheckNow = async (CheckID) => {
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
};

Manager.Create = async (Payload) => {
  const Now = Date.now();
  const Checks = Array.isArray(Payload.Checks) ? Payload.Checks : [];
  for (const C of Checks) {
    if (!MonitoringMethods.Has(C.Method)) return Fail(`Unknown monitoring method: ${C.Method}`);
  }

  const Interval = ClampInterval(Payload.Interval);
  const GroupID = Payload.GroupID == null ? null : Payload.GroupID;
  const Weight = typeof Payload.Weight === 'number' ? Payload.Weight : 100;

  // The legacy MonitoringTargets columns (Address/Method/Settings) are retained
  // for schema compatibility; the first check's method satisfies the NOT NULL
  // constraint on Method (empty string when the target has no checks yet). Live
  // config is stored per-check in MonitoringChecks.
  const [Err, Res] = await DB.Run(
    'INSERT INTO MonitoringTargets (Nickname, Address, Method, Interval, Settings, GroupID, Weight, LastSuccessAt, DegradedThresholdMs, Timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      Payload.Nickname,
      '',
      Checks.length ? Checks[0].Method : '',
      Interval,
      '{}',
      GroupID,
      Weight,
      null,
      0,
      Now,
    ]
  );
  if (Err || !Res) return Fail('Failed to create monitoring target');
  const TargetID = Res.lastID;

  const CheckRows = [];
  let CheckWeight = 100;
  for (const C of Checks) {
    const Row = await InsertCheckRow(TargetID, C, CheckWeight, Now);
    if (Row) CheckRows.push(Row);
    CheckWeight += 10;
  }

  const Target = new MonitoringTarget(
    { TargetID, Nickname: Payload.Nickname, Interval, GroupID, Weight, Timestamp: Now },
    CheckRows
  );
  TargetList.push(Target);
  Target.StartLoop();
  BroadcastManager.emit('MonitoringTargetListChanged');
  return Ok(Target.ToJSON());
};

// Reconcile a target's checks against an incoming list: checks that carry an
// existing CheckID are updated in place (preserving runtime state), checks with
// no CheckID are inserted, and existing checks absent from the list are deleted.
async function ReconcileChecks(Target, Incoming) {
  const Now = Date.now();
  const ExistingById = new Map(Target.Checks.map((C) => [Number(C.CheckID), C]));
  const KeepIds = new Set();
  const NextChecks = [];
  let CheckWeight = 100;

  for (const C of Incoming) {
    const CID = Number(C.CheckID);
    if (Number.isFinite(CID) && ExistingById.has(CID)) {
      KeepIds.add(CID);
      const Instance = ExistingById.get(CID);
      const MethodChanged = Instance.Method !== C.Method;
      const SettingsJson = ToRowSettings(C.Method, C.Settings);
      const Threshold = ClampThreshold(C.DegradedThresholdMs);
      await DB.Run(
        'UPDATE MonitoringChecks SET Name = ?, Address = ?, Method = ?, Settings = ?, DegradedThresholdMs = ?, Weight = ? WHERE CheckID = ?',
        [C.Name || '', C.Address || '', C.Method, SettingsJson, Threshold, CheckWeight, CID]
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
      await DB.Run('DELETE FROM MonitoringChecks WHERE CheckID = ?', [Existing.CheckID]);
    }
  }

  Target.Checks = NextChecks;
  Target.RecomputeAggregate();
}

Manager.Update = async (TargetID, Payload) => {
  const ID = Number(TargetID);
  const Target = TargetList.find((T) => T.TargetID === ID);
  if (!Target) return Fail('Monitoring target not found');

  const NextInterval = ClampInterval(
    Object.prototype.hasOwnProperty.call(Payload, 'Interval') ? Payload.Interval : Target.Interval
  );
  const NextNickname = Object.prototype.hasOwnProperty.call(Payload, 'Nickname')
    ? Payload.Nickname
    : Target.Nickname;
  const NextGroupID = Object.prototype.hasOwnProperty.call(Payload, 'GroupID')
    ? Payload.GroupID
    : Target.GroupID;

  let NextChecks = null;
  if (Object.prototype.hasOwnProperty.call(Payload, 'Checks')) {
    const Incoming = Array.isArray(Payload.Checks) ? Payload.Checks : [];
    for (const C of Incoming) {
      if (!MonitoringMethods.Has(C.Method)) return Fail(`Unknown monitoring method: ${C.Method}`);
    }
    NextChecks = Incoming;
  }

  const [Err] = await DB.Run(
    'UPDATE MonitoringTargets SET Nickname = ?, Interval = ?, GroupID = ? WHERE TargetID = ?',
    [NextNickname, NextInterval, NextGroupID, ID]
  );
  if (Err) return Fail('Failed to update monitoring target');

  Target.Nickname = NextNickname;
  Target.Interval = NextInterval;
  Target.GroupID = NextGroupID;

  if (NextChecks) await ReconcileChecks(Target, NextChecks);

  Target.StartLoop();
  BroadcastManager.emit('MonitoringTargetUpdated', Target.ToJSON());
  BroadcastManager.emit('MonitoringTargetListChanged');
  return Ok(Target.ToJSON());
};

Manager.Delete = async (TargetID) => {
  const ID = Number(TargetID);
  const Idx = TargetList.findIndex((T) => T.TargetID === ID);
  if (Idx === -1) return Fail('Monitoring target not found');
  const Target = TargetList[Idx];
  Target.StopLoop();
  const [Err] = await DB.Run('DELETE FROM MonitoringTargets WHERE TargetID = ?', [ID]);
  if (Err) return Fail('Failed to delete monitoring target');
  await DB.Run('DELETE FROM MonitoringChecks WHERE TargetID = ?', [ID]);
  TargetList.splice(Idx, 1);
  BroadcastManager.emit('MonitoringTargetListChanged');
  return Ok(true);
};

// Group ordering (SetGroupAndWeight / MoveGroupToNoGroup / ReconcileOrphanedGroups)
// is shared with other list-backed managers via the group-ordering helper.
const GroupOrdering = createGroupOrdering({
  DB,
  BroadcastManager,
  table: 'MonitoringTargets',
  keyColumn: 'TargetID',
  getList: () => TargetList,
  getKey: (Target) => Target.TargetID,
  normalizeKey: (raw) => Number(raw),
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

// Move a monitoring target to a group with a specific weight (used by drag/drop ordering).
Manager.SetGroupAndWeight = (TargetID, GroupID, Weight) =>
  GroupOrdering.SetGroupAndWeight(TargetID, GroupID, Weight);

// Move all monitoring targets from a specific group into the default no-group bucket (null).
Manager.MoveGroupToNoGroup = (GroupID) => GroupOrdering.MoveGroupToNoGroup(GroupID);

// Ensure all monitoring targets reference an existing group; unknown groups are reassigned to null.
Manager.ReconcileOrphanedGroups = (ValidGroupIDs) =>
  GroupOrdering.ReconcileOrphanedGroups(ValidGroupIDs);

Manager.GetAllSync = () => TargetList.map((T) => T.ToJSON());

Manager.MIN_INTERVAL_MS = MIN_INTERVAL_MS;
Manager.MAX_INTERVAL_MS = MAX_INTERVAL_MS;

module.exports = { Manager };
