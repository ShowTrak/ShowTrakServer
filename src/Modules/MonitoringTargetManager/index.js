// MonitoringTargetManager
// - Persists monitoring targets (server-driven probes) in their own DB table
// - Schedules per-target check loops using the registered monitoring methods
// - Mirrors ClientManager broadcast semantics so the UI can react uniformly
const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('MonitoringTargetManager');

const { Manager: DB } = require('../DB');
const { Manager: BroadcastManager } = require('../Broadcast');
const { Manager: MonitoringMethods } = require('../MonitoringMethods');
const { Ok, Fail } = require('../Utils');

const Manager = {};

const MIN_INTERVAL_MS = 3000;
const MAX_INTERVAL_MS = 5 * 60 * 1000;

let TargetList = [];

function ParseSettings(Raw) {
  if (!Raw) return {};
  if (typeof Raw === 'object') return Raw;
  try {
    const Parsed = JSON.parse(Raw);
    return Parsed && typeof Parsed === 'object' ? Parsed : {};
  } catch {
    return {};
  }
}

function ClampInterval(Value) {
  let n = Number(Value);
  if (!Number.isFinite(n)) n = 30000;
  if (n < MIN_INTERVAL_MS) n = MIN_INTERVAL_MS;
  if (n > MAX_INTERVAL_MS) n = MAX_INTERVAL_MS;
  return Math.round(n);
}

// 0 = disabled. Threshold is compared against LastLatencyMs in Tick().
function ClampThreshold(Value) {
  let n = Number(Value);
  if (!Number.isFinite(n) || n < 0) n = 0;
  if (n > 600000) n = 600000;
  return Math.round(n);
}

class MonitoringTarget {
  constructor(Row) {
    this.TargetID = Row.TargetID;
    this.Nickname = Row.Nickname || '';
    this.Address = Row.Address || '';
    this.Method = Row.Method || 'ping';
    this.Interval = ClampInterval(Row.Interval);
    this.StoreHistory = !!Row.StoreHistory;
    this.Settings = ParseSettings(Row.Settings);
    this.GroupID = Row.GroupID == null ? null : Row.GroupID;
    this.Weight = typeof Row.Weight === 'number' ? Row.Weight : 100;
    this.LastSuccessAt = Row.LastSuccessAt || null;
    this.DegradedThresholdMs = ClampThreshold(Row.DegradedThresholdMs);
    this.Timestamp = Row.Timestamp;

    // RAM-only runtime state
    this.Online = false;
    this.Degraded = false;
    this.LastChecked = null;
    this.LastLatencyMs = null;
    this.LastError = null;
    this._timer = null;
    this._running = false;
  }

  // Snapshot used for IPC + broadcast payloads.
  ToJSON() {
    return {
      TargetID: this.TargetID,
      Nickname: this.Nickname,
      Address: this.Address,
      Method: this.Method,
      Interval: this.Interval,
      StoreHistory: this.StoreHistory,
      Settings: this.Settings,
      GroupID: this.GroupID,
      Weight: this.Weight,
      LastSuccessAt: this.LastSuccessAt,
      DegradedThresholdMs: this.DegradedThresholdMs,
      Timestamp: this.Timestamp,
      Online: this.Online,
      Degraded: this.Degraded,
      LastChecked: this.LastChecked,
      LastLatencyMs: this.LastLatencyMs,
      LastError: this.LastError,
      Type: 'monitor',
    };
  }

  StartLoop() {
    this.StopLoop();
    // Run an initial check shortly after boot so the UI doesn't sit "Unknown"
    // for a full interval.
    this._timer = setTimeout(() => this.Tick(), 1500);
  }

  StopLoop() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  async Tick() {
    if (this._running) {
      // overlap protection — schedule next tick and bail
      this._timer = setTimeout(() => this.Tick(), this.Interval);
      return;
    }
    this._running = true;
    try {
      const Result = await MonitoringMethods.Run(this.Method, this);
      const Now = Date.now();
      this.LastChecked = Now;
      if (Result && Result.Success) {
        this.Online = true;
        this.LastLatencyMs = typeof Result.LatencyMs === 'number' ? Result.LatencyMs : null;
        this.LastError = null;
        this.Degraded =
          this.DegradedThresholdMs > 0 &&
          typeof this.LastLatencyMs === 'number' &&
          this.LastLatencyMs > this.DegradedThresholdMs;
        await this.SetLastSuccessAt(Now);
      } else {
        this.Online = false;
        this.Degraded = false;
        this.LastLatencyMs = null;
        this.LastError = (Result && Result.Error) || 'Check failed';
      }
      BroadcastManager.emit('MonitoringTargetUpdated', this.ToJSON());
    } catch (Err) {
      Logger.error(`Tick failed for target ${this.TargetID}:`, Err);
    } finally {
      this._running = false;
      this._timer = setTimeout(() => this.Tick(), this.Interval);
    }
  }

  async SetLastSuccessAt(Ts) {
    this.LastSuccessAt = Ts;
    const [Err] = await DB.Run('UPDATE MonitoringTargets SET LastSuccessAt = ? WHERE TargetID = ?', [
      Ts,
      this.TargetID,
    ]);
    if (Err) Logger.error('Failed to persist LastSuccessAt');
  }
}

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
  const StoreHistory = Payload.StoreHistory ? 1 : 0;
  const GroupID = Payload.GroupID == null ? null : Payload.GroupID;
  const Weight = typeof Payload.Weight === 'number' ? Payload.Weight : 100;
  const DegradedThresholdMs = ClampThreshold(Payload.DegradedThresholdMs);

  const [Err, Res] = await DB.Run(
    'INSERT INTO MonitoringTargets (Nickname, Address, Method, Interval, StoreHistory, Settings, GroupID, Weight, LastSuccessAt, DegradedThresholdMs, Timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      Payload.Nickname,
      Payload.Address,
      Method,
      Interval,
      StoreHistory,
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
    StoreHistory,
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
  const NextStoreHistory = Object.prototype.hasOwnProperty.call(Payload, 'StoreHistory')
    ? !!Payload.StoreHistory
    : Target.StoreHistory;
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
    'UPDATE MonitoringTargets SET Nickname = ?, Address = ?, Method = ?, Interval = ?, StoreHistory = ?, Settings = ?, GroupID = ?, DegradedThresholdMs = ? WHERE TargetID = ?',
    [
      NextNickname,
      NextAddress,
      Method,
      NextInterval,
      NextStoreHistory ? 1 : 0,
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
  Target.StoreHistory = NextStoreHistory;
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

Manager.GetAllSync = () => TargetList.map((T) => T.ToJSON());

Manager.MIN_INTERVAL_MS = MIN_INTERVAL_MS;
Manager.MAX_INTERVAL_MS = MAX_INTERVAL_MS;

module.exports = { Manager };
