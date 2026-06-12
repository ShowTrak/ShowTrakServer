const { Manager: DB } = require('../DB');
const { Manager: BroadcastManager } = require('../Broadcast');
const { Manager: MonitoringMethods } = require('../MonitoringMethods');
const { Ok, Fail } = require('../Utils');

const {
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  ParseSettings,
  ClampInterval,
  ClampThreshold,
} = require('./normalize');
const { MonitoringTarget } = require('./target');

const Manager = {};

let TargetList = [];

function ToRowSettings(Method, Settings) {
  const Normalized = MonitoringMethods.NormalizeSettings(Method, Settings || {});
  return JSON.stringify(Normalized);
}

Manager.Initialized = false;

Manager.Init = async () => {
  const [Err, Rows] = await DB.All('SELECT * FROM MonitoringTargets');
  if (Err) {
    Manager.Initialized = true;
    TargetList = [];
    return;
  }
  TargetList = (Rows || []).map((Row) => new MonitoringTarget(Row));
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

Manager.Create = async (Payload) => {
  const Now = Date.now();
  const Method = Payload.Method;
  if (!MonitoringMethods.Has(Method)) return Fail(`Unknown monitoring method: ${Method}`);

  const Interval = ClampInterval(Payload.Interval);
  const SettingsJson = ToRowSettings(Method, Payload.Settings);
  const GroupID = Payload.GroupID == null ? null : Payload.GroupID;
  const Weight = typeof Payload.Weight === 'number' ? Payload.Weight : 100;
  const DegradedThresholdMs = ClampThreshold(Payload.DegradedThresholdMs);

  const [Err, Res] = await DB.Run(
    'INSERT INTO MonitoringTargets (Nickname, Address, Method, Interval, Settings, GroupID, Weight, LastSuccessAt, DegradedThresholdMs, Timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      Payload.Nickname,
      Payload.Address,
      Method,
      Interval,
      SettingsJson,
      GroupID,
      Weight,
      null,
      DegradedThresholdMs,
      Now,
    ]
  );
  if (Err || !Res) return Fail('Failed to create monitoring target');

  const Row = {
    TargetID: Res.lastID,
    Nickname: Payload.Nickname,
    Address: Payload.Address,
    Method,
    Interval,
    Settings: SettingsJson,
    GroupID,
    Weight,
    LastSuccessAt: null,
    DegradedThresholdMs,
    Timestamp: Now,
  };
  const Target = new MonitoringTarget(Row);
  TargetList.push(Target);
  Target.StartLoop();
  BroadcastManager.emit('MonitoringTargetListChanged');
  return Ok(Target.ToJSON());
};

Manager.Update = async (TargetID, Payload) => {
  const ID = Number(TargetID);
  const Target = TargetList.find((T) => T.TargetID === ID);
  if (!Target) return Fail('Monitoring target not found');

  const Method = Payload.Method || Target.Method;
  if (!MonitoringMethods.Has(Method)) return Fail(`Unknown monitoring method: ${Method}`);

  const NextInterval = ClampInterval(
    Object.prototype.hasOwnProperty.call(Payload, 'Interval') ? Payload.Interval : Target.Interval
  );
  const NextNickname = Object.prototype.hasOwnProperty.call(Payload, 'Nickname')
    ? Payload.Nickname
    : Target.Nickname;
  const NextAddress = Object.prototype.hasOwnProperty.call(Payload, 'Address')
    ? Payload.Address
    : Target.Address;
  const NextGroupID = Object.prototype.hasOwnProperty.call(Payload, 'GroupID')
    ? Payload.GroupID
    : Target.GroupID;
  const NextDegradedThresholdMs = ClampThreshold(
    Object.prototype.hasOwnProperty.call(Payload, 'DegradedThresholdMs')
      ? Payload.DegradedThresholdMs
      : Target.DegradedThresholdMs
  );

  // If method changed, drop old method-specific settings rather than mixing.
  const SettingsBase =
    Method === Target.Method
      ? { ...Target.Settings, ...(Payload.Settings || {}) }
      : Payload.Settings || {};
  const SettingsJson = ToRowSettings(Method, SettingsBase);

  const [Err] = await DB.Run(
    'UPDATE MonitoringTargets SET Nickname = ?, Address = ?, Method = ?, Interval = ?, Settings = ?, GroupID = ?, DegradedThresholdMs = ? WHERE TargetID = ?',
    [
      NextNickname,
      NextAddress,
      Method,
      NextInterval,
      SettingsJson,
      NextGroupID,
      NextDegradedThresholdMs,
      ID,
    ]
  );
  if (Err) return Fail('Failed to update monitoring target');

  Target.Nickname = NextNickname;
  Target.Address = NextAddress;
  Target.Method = Method;
  Target.Interval = NextInterval;
  Target.Settings = ParseSettings(SettingsJson);
  Target.GroupID = NextGroupID;
  Target.DegradedThresholdMs = NextDegradedThresholdMs;
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
  TargetList.splice(Idx, 1);
  BroadcastManager.emit('MonitoringTargetListChanged');
  return Ok(true);
};

// Move a monitoring target to a group with a specific weight (used by drag/drop ordering).
Manager.SetGroupAndWeight = async (TargetID, GroupID, Weight) => {
  const ID = Number(TargetID);
  const Target = TargetList.find((T) => T.TargetID === ID);
  if (!Target) return Fail('Monitoring target not found');
  const NextGroupID = GroupID == null ? null : Number(GroupID);
  const NextWeight = Number.isFinite(Number(Weight)) ? Number(Weight) : 100;
  const [Err] = await DB.Run(
    'UPDATE MonitoringTargets SET GroupID = ?, Weight = ? WHERE TargetID = ?',
    [NextGroupID, NextWeight, ID]
  );
  if (Err) return Fail('Failed to update monitoring target');
  Target.GroupID = NextGroupID;
  Target.Weight = NextWeight;
  return Ok(true);
};

// Move all monitoring targets from a specific group into the default no-group bucket (null).
Manager.MoveGroupToNoGroup = async (GroupID) => {
  if (!Manager.Initialized) await Manager.Init();
  const TargetGroupID = Number(GroupID);
  if (!Number.isFinite(TargetGroupID)) return Fail('Invalid GroupID');

  let Changed = 0;
  for (const Target of TargetList) {
    if (Target.GroupID == null) continue;
    if (Number(Target.GroupID) !== TargetGroupID) continue;
    const [Err] = await DB.Run('UPDATE MonitoringTargets SET GroupID = ? WHERE TargetID = ?', [
      null,
      Target.TargetID,
    ]);
    if (Err) return Fail('Failed to move monitoring targets to no group');
    Target.GroupID = null;
    Changed += 1;
  }

  if (Changed > 0) BroadcastManager.emit('MonitoringTargetListChanged');
  return Ok(Changed);
};

// Ensure all monitoring targets reference an existing group; unknown groups are reassigned to null.
Manager.ReconcileOrphanedGroups = async (ValidGroupIDs) => {
  if (!Manager.Initialized) await Manager.Init();
  const Valid = new Set(
    (Array.isArray(ValidGroupIDs) ? ValidGroupIDs : [])
      .map((ID) => Number(ID))
      .filter((ID) => Number.isFinite(ID))
  );

  let Changed = 0;
  for (const Target of TargetList) {
    if (Target.GroupID == null) continue;
    const TargetGroupID = Number(Target.GroupID);
    if (Valid.has(TargetGroupID)) continue;
    const [Err] = await DB.Run('UPDATE MonitoringTargets SET GroupID = ? WHERE TargetID = ?', [
      null,
      Target.TargetID,
    ]);
    if (Err) return Fail('Failed to reconcile orphaned monitoring targets');
    Target.GroupID = null;
    Changed += 1;
  }

  if (Changed > 0) BroadcastManager.emit('MonitoringTargetListChanged');
  return Ok(Changed);
};

Manager.GetAllSync = () => TargetList.map((T) => T.ToJSON());

Manager.MIN_INTERVAL_MS = MIN_INTERVAL_MS;
Manager.MAX_INTERVAL_MS = MAX_INTERVAL_MS;

module.exports = { Manager };
