// MonitoringTarget + MonitoringCheck
// A MonitoringTarget is a user-facing "monitored thing" that owns one or more
// independent checks (e.g. two DNS probes plus a QLab workspace check). The
// target owns the single shared check loop + interval; each check runs its own
// probe against its own Address/Settings and tracks its own online/degraded
// state. The target's overall status is aggregated from its checks:
//   - OFFLINE  only when every check is failing
//   - DEGRADED when any check is failing or degraded (but not all failing)
//   - ONLINE   when every check is healthy
const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('MonitoringTargetManager');

const { Manager: DB } = require('../DB');
const { Manager: BroadcastManager } = require('../Broadcast');
const { Manager: MonitoringMethods } = require('../MonitoringMethods');

const { ParseSettings, ClampInterval, ClampThreshold } = require('./normalize');

// A single probe within a target. Owns its own address/settings/threshold and
// its own runtime state. Does not own timing — the parent target ticks it.
class MonitoringCheck {
  constructor(Row) {
    this.CheckID = Row.CheckID;
    this.TargetID = Row.TargetID;
    this.Name = Row.Name || '';
    this.Address = Row.Address || '';
    let Method = Row.Method || 'ping';
    let Settings = ParseSettings(Row.Settings);

    // Migrate old 'https' method to unified 'http' method with Protocol='https'
    if (Method === 'https') {
      Method = 'http';
      Settings = Settings || {};
      Settings.Protocol = 'https';
    }
    // Migrate old 'http' method to explicitly use Protocol='http'
    else if (Method === 'http' && (!Settings || !Settings.Protocol)) {
      Settings = Settings || {};
      Settings.Protocol = 'http';
    }

    this.Method = Method;
    this.Settings = Settings;
    this.DegradedThresholdMs = ClampThreshold(Row.DegradedThresholdMs);
    this.Weight = typeof Row.Weight === 'number' ? Row.Weight : 100;
    this.LastSuccessAt = Row.LastSuccessAt || null;
    this.Timestamp = Row.Timestamp;

    // RAM-only runtime state
    this.Online = false;
    this.Degraded = false;
    this.LastChecked = null;
    this.LastLatencyMs = null;
    this.LastError = null;
    // Most recent method-rendered debug panel (HTML). Cached in memory only —
    // never persisted — and overwritten on every run.
    this.LastDebugHtml = null;
    this.LastDebugAt = null;
  }

  ToJSON() {
    return {
      CheckID: this.CheckID,
      TargetID: this.TargetID,
      Name: this.Name,
      Address: this.Address,
      Method: this.Method,
      Settings: this.Settings,
      DegradedThresholdMs: this.DegradedThresholdMs,
      Weight: this.Weight,
      LastSuccessAt: this.LastSuccessAt,
      Online: this.Online,
      Degraded: this.Degraded,
      LastChecked: this.LastChecked,
      LastLatencyMs: this.LastLatencyMs,
      LastError: this.LastError,
    };
  }

  // Run this check's probe once and update its own runtime state. The method
  // implementations read `.Address` and `.Settings` off the passed object, so
  // the check instance itself is a valid "target-like" argument.
  async Run() {
    const Result = await MonitoringMethods.Run(this.Method, this);
    const Now = Date.now();
    this.LastChecked = Now;
    if (Result && Result.Success) {
      this.Online = true;
      this.LastLatencyMs = typeof Result.LatencyMs === 'number' ? Result.LatencyMs : null;
      if (Result.Degraded) {
        // A method can report an explicit degraded state (e.g. reachable but
        // wrong QLab workspace) with a human-readable reason.
        this.Degraded = true;
        this.LastError = Result.DegradedReason || 'Degraded';
      } else {
        this.LastError = null;
        this.Degraded =
          this.DegradedThresholdMs > 0 &&
          typeof this.LastLatencyMs === 'number' &&
          this.LastLatencyMs > this.DegradedThresholdMs;
      }
      await this.SetLastSuccessAt(Now);
    } else {
      this.Online = false;
      this.Degraded = false;
      this.LastLatencyMs = null;
      this.LastError = (Result && Result.Error) || 'Check failed';
    }
    // Cache the rendered debug panel (RAM-only) from this run's raw result.
    this.LastDebugHtml = MonitoringMethods.BuildDebug(this.Method, Result, this);
    this.LastDebugAt = Now;
  }

  async SetLastSuccessAt(Ts) {
    this.LastSuccessAt = Ts;
    const Run =
      typeof DB.RunWithoutDirtyTracking === 'function'
        ? DB.RunWithoutDirtyTracking.bind(DB)
        : DB.Run.bind(DB);
    const [Err] = await Run('UPDATE MonitoringChecks SET LastSuccessAt = ? WHERE CheckID = ?', [
      Ts,
      this.CheckID,
    ]);
    if (Err) Logger.error('Failed to persist check LastSuccessAt');
  }
}

class MonitoringTarget {
  constructor(Row, Checks = []) {
    this.TargetID = Row.TargetID;
    this.Nickname = Row.Nickname || '';
    this.Interval = ClampInterval(Row.Interval);
    this.GroupID = Row.GroupID == null ? null : Row.GroupID;
    this.Weight = typeof Row.Weight === 'number' ? Row.Weight : 100;
    this.Timestamp = Row.Timestamp;

    this.Checks = Array.isArray(Checks) ? Checks.map((C) => new MonitoringCheck(C)) : [];

    // Aggregated RAM-only runtime state
    this.Online = false;
    this.Degraded = false;
    this.LastChecked = null;
    this.LastLatencyMs = null;
    this.LastError = null;
    this._timer = null;
    this._running = false;

    // A target with no checks is idle — it has nothing to probe, so it
    // should not appear online, degraded, or offline.
    // (Online/Degraded already default to false above.)
  }

  // The tile UI still references a single Address/Method for the subtitle; we
  // surface the first check's values for backwards compatibility.
  get PrimaryCheck() {
    return this.Checks.length ? this.Checks[0] : null;
  }

  // Snapshot used for IPC + broadcast payloads.
  ToJSON() {
    const Primary = this.PrimaryCheck;
    return {
      TargetID: this.TargetID,
      Nickname: this.Nickname,
      Interval: this.Interval,
      GroupID: this.GroupID,
      Weight: this.Weight,
      Timestamp: this.Timestamp,
      // Legacy single-check fields (derived) so existing tiles / WebUI / alerts
      // that read Address/Method keep working.
      Address: Primary ? Primary.Address : '',
      Method: Primary ? Primary.Method : '',
      DegradedThresholdMs: Primary ? Primary.DegradedThresholdMs : 0,
      LastSuccessAt: this._aggregateLastSuccessAt(),
      // Aggregated runtime status
      Online: this.Online,
      Degraded: this.Degraded,
      LastChecked: this.LastChecked,
      LastLatencyMs: this.LastLatencyMs,
      LastError: this.LastError,
      CheckCount: this.Checks.length,
      Checks: this.Checks.map((C) => C.ToJSON()),
      Type: 'monitor',
    };
  }

  _aggregateLastSuccessAt() {
    let latest = null;
    for (const Check of this.Checks) {
      const Ts = Number(Check.LastSuccessAt);
      if (Number.isFinite(Ts) && (latest == null || Ts > latest)) latest = Ts;
    }
    return latest;
  }

  // Recompute the aggregated Online/Degraded/Latency/Error from the checks.
  RecomputeAggregate() {
    const Checks = this.Checks;
    if (!Checks.length) {
      // A target with no checks is idle — nothing to probe.
      this.Online = false;
      this.Degraded = false;
      this.LastLatencyMs = null;
      this.LastError = null;
      return;
    }

    const OnlineChecks = Checks.filter((C) => C.Online);
    const DownChecks = Checks.filter((C) => !C.Online);
    const DegradedChecks = Checks.filter((C) => C.Online && C.Degraded);
    const FaultCount = DownChecks.length + DegradedChecks.length;
    const AllOffline = OnlineChecks.length === 0;

    this.Online = !AllOffline;
    this.Degraded = this.Online && (DownChecks.length > 0 || DegradedChecks.length > 0);

    this.LastLatencyMs = OnlineChecks.length
      ? Math.max(...OnlineChecks.map((C) => Number(C.LastLatencyMs) || 0))
      : null;

    if (!this.Online) {
      // Fully offline: preserve a single check's classifiable error when there
      // is only one check, otherwise a concise summary.
      this.LastError =
        Checks.length === 1
          ? Checks[0].LastError || 'Check failed'
          : `Multiple faults (${Checks.length} checks down)`;
    } else if (this.Degraded) {
      if (FaultCount > 1) {
        if (DownChecks.length > 0 && DegradedChecks.length > 0) {
          this.LastError = `Multiple faults (${DownChecks.length} down, ${DegradedChecks.length} degraded)`;
        } else if (DownChecks.length > 0) {
          this.LastError = `Multiple faults (${DownChecks.length} checks down)`;
        } else {
          this.LastError = `Multiple faults (${DegradedChecks.length} degraded checks)`;
        }
      } else if (DownChecks.length > 0) {
        this.LastError = 'Check down';
      } else {
        const First = DegradedChecks[0];
        this.LastError = (First && First.LastError) || 'Degraded';
      }
    } else {
      this.LastError = null;
    }
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
      await Promise.all(this.Checks.map((Check) => Check.Run()));
      this.LastChecked = Date.now();
      this.RecomputeAggregate();
      BroadcastManager.emit('MonitoringTargetUpdated', this.ToJSON());
    } catch (Err) {
      Logger.error(`Tick failed for target ${this.TargetID}:`, Err);
    } finally {
      this._running = false;
      this._timer = setTimeout(() => this.Tick(), this.Interval);
    }
  }
}

module.exports = {
  MonitoringTarget,
  MonitoringCheck,
};
