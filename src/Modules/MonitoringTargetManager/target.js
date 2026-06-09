// MonitoringTarget
// Runtime representation of a single server-driven probe. Owns its own check
// loop (StartLoop/StopLoop/Tick), tracks transient online/degraded state, and
// persists only its LastSuccessAt timestamp back to the database.
const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('MonitoringTargetManager');

const { Manager: DB } = require('../DB');
const { Manager: BroadcastManager } = require('../Broadcast');
const { Manager: MonitoringMethods } = require('../MonitoringMethods');

const { ParseSettings, ClampInterval, ClampThreshold } = require('./normalize');

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
    const Run =
      typeof DB.RunWithoutDirtyTracking === 'function'
        ? DB.RunWithoutDirtyTracking.bind(DB)
        : DB.Run.bind(DB);
    const [Err] = await Run('UPDATE MonitoringTargets SET LastSuccessAt = ? WHERE TargetID = ?', [
      Ts,
      this.TargetID,
    ]);
    if (Err) Logger.error('Failed to persist LastSuccessAt');
  }
}

module.exports = {
  MonitoringTarget,
};
