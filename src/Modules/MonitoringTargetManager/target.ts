// MonitoringTarget + MonitoringCheck
// A MonitoringTarget is a user-facing "monitored thing" that owns one or more
// independent checks (e.g. two DNS probes plus a QLab workspace check). The
// target owns the single shared check loop + interval; each check runs its own
// probe against its own Address/Settings and tracks its own online/degraded
// state. The target's overall status is aggregated from its checks:
//   - OFFLINE  only when every check is failing
//   - DEGRADED when any check is failing or degraded (but not all failing)
//   - ONLINE   when every check is healthy
// Checks that have not reached a verdict yet (see MonitoringCheck.Run's failure
// threshold) are left out of the aggregate: unknown is not the same as down.
import { CreateLogger } from '../Logger';
import { MONITORING_TICK_INTERVAL_MS } from '../Config/constants';
import { Manager as DB } from '../DB';
import { CreateMonitoringChecksRepository } from '../DB/repositories/monitoring-checks';
import { Manager as BroadcastManager } from '../Broadcast';
import { Manager as MonitoringMethods } from '../MonitoringMethods';
import type {
  MonitoringActionOptions,
  MonitoringCheckView,
  MonitoringTargetView,
} from '@showtrak/protocol';

import {
  ParseSettings,
  ClampInterval,
  ClampThreshold,
  ClampFailureThreshold,
  GetDefaultFailureThreshold,
} from './normalize';

const Logger = CreateLogger('MonitoringTargetManager');

const ChecksRepo = CreateMonitoringChecksRepository(DB);

// Row/record consumed by the MonitoringCheck constructor. Rows arrive either
// from the MonitoringChecks table or from the manager's insert/migrate helpers;
// the JSON/loose fields are re-normalized defensively, so they are accepted
// loosely here.
interface MonitoringCheckInput {
  CheckID: number;
  TargetID: number;
  Name?: string | null;
  Address?: string | null;
  Method?: string | null;
  Settings?: unknown;
  DegradedThresholdMs?: unknown;
  FailureThreshold?: unknown;
  Weight?: number;
  LastSuccessAt?: number | null;
  Timestamp: number;
}

// Row/record consumed by the MonitoringTarget constructor.
interface MonitoringTargetInput {
  TargetID: number;
  Nickname?: string | null;
  Interval?: unknown;
  GroupID?: number | null;
  Weight?: unknown;
  Slug?: string | null;
  FailureThreshold?: unknown;
  Timestamp: number;
}

// A single probe within a target. Owns its own address/settings/threshold and
// its own runtime state. Does not own timing — the parent target ticks it.
class MonitoringCheck {
  CheckID: number;
  TargetID: number;
  Name: string;
  Address: string;
  Method: string;
  Settings: Record<string, unknown>;
  DegradedThresholdMs: number;
  // Consecutive failed probes before this check reads offline; null inherits
  // the parent target's value (see MonitoringTarget.InheritedFailureThreshold).
  FailureThreshold: number | null;
  Weight: number;
  LastSuccessAt: number | null;
  Timestamp: number;
  ConsecutiveFailures: number;
  Online: boolean;
  Degraded: boolean;
  LastChecked: number | null;
  LastLatencyMs: number | null;
  LastError: string | null;
  LastDebugHtml: string | null;
  LastDebugAt: number | null;
  LastActionOptions: MonitoringActionOptions;

  constructor(Row: MonitoringCheckInput) {
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
    this.FailureThreshold = ClampFailureThreshold(Row.FailureThreshold);
    this.Weight = typeof Row.Weight === 'number' ? Row.Weight : 100;
    this.LastSuccessAt = Row.LastSuccessAt || null;
    this.Timestamp = Row.Timestamp;

    // RAM-only runtime state
    this.ConsecutiveFailures = 0;
    this.Online = false;
    this.Degraded = false;
    this.LastChecked = null;
    this.LastLatencyMs = null;
    this.LastError = null;
    // Most recent method-rendered debug panel (HTML). Cached in memory only —
    // never persisted — and overwritten on every run.
    this.LastDebugHtml = null;
    this.LastDebugAt = null;
    // Dynamic choices for this check's action parameters, refreshed on every
    // run (see MonitoringMethods.GetActionOptions). RAM-only.
    this.LastActionOptions = {};
  }

  EffectiveFailureThreshold(Inherited: number = GetDefaultFailureThreshold()): number {
    return this.FailureThreshold ?? Inherited;
  }

  // Forget any run of misses, e.g. when the check is re-pointed at a different
  // method and the old failures no longer describe it.
  ResetRuntimeState() {
    this.ConsecutiveFailures = 0;
    this.Online = false;
    this.Degraded = false;
    this.LastLatencyMs = null;
    this.LastError = null;
    this.LastChecked = null;
  }

  ToJSON(InheritedFailureThreshold: number = GetDefaultFailureThreshold()): MonitoringCheckView {
    return {
      CheckID: this.CheckID,
      TargetID: this.TargetID,
      Name: this.Name,
      Address: this.Address,
      Method: this.Method,
      Settings: this.Settings,
      DegradedThresholdMs: this.DegradedThresholdMs,
      FailureThreshold: this.FailureThreshold,
      EffectiveFailureThreshold: this.EffectiveFailureThreshold(InheritedFailureThreshold),
      ConsecutiveFailures: this.ConsecutiveFailures,
      Weight: this.Weight,
      LastSuccessAt: this.LastSuccessAt,
      Online: this.Online,
      Degraded: this.Degraded,
      LastChecked: this.LastChecked,
      LastLatencyMs: this.LastLatencyMs,
      LastError: this.LastError,
      ActionOptions: this.LastActionOptions,
    };
  }

  // Run this check's probe once and update its own runtime state. The method
  // implementations read `.Address` and `.Settings` off the passed object, so
  // the check instance itself is a valid "target-like" argument.
  //
  // A failed probe only marks the check offline once it has failed
  // `EffectiveFailureThreshold` times in a row. Below that the previous verdict
  // stands — an online check stays online, and a check that has never answered
  // stays "not checked yet" rather than being called down on a single dropped
  // packet. Any success resets the run.
  async Run(InheritedFailureThreshold: number = GetDefaultFailureThreshold()) {
    const Result = await MonitoringMethods.Run(this.Method, this);
    const Now = Date.now();
    if (Result && Result.Success) {
      this.ConsecutiveFailures = 0;
      this.LastChecked = Now;
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
      this.ConsecutiveFailures++;
      const AlreadyDown = this.LastChecked != null && !this.Online;
      const Confirmed =
        AlreadyDown ||
        this.ConsecutiveFailures >= this.EffectiveFailureThreshold(InheritedFailureThreshold);
      if (Confirmed) {
        this.LastChecked = Now;
        this.Online = false;
        this.Degraded = false;
        this.LastLatencyMs = null;
        this.LastError = (Result && Result.Error) || 'Check failed';
      } else if (this.LastChecked != null) {
        // Held: keep the last verdict but record that a probe did run.
        this.LastChecked = Now;
      }
    }
    // Cache the rendered debug panel (RAM-only) from this run's raw result.
    this.LastDebugHtml = MonitoringMethods.BuildDebug(this.Method, Result, this);
    this.LastDebugAt = Now;
    // Refresh the action parameter choices this device reports (e.g. the input
    // sources a projector lists). A failed probe keeps the last known set rather
    // than emptying the picker the moment the device blips.
    if (Result && Result.Success) {
      this.LastActionOptions = MonitoringMethods.GetActionOptions(this.Method, Result);
    }
  }

  async SetLastSuccessAt(Ts: number) {
    this.LastSuccessAt = Ts;
    const [Err] = await ChecksRepo.SetLastSuccessAt(Ts, this.CheckID);
    if (Err) Logger.error('Failed to persist check LastSuccessAt');
  }
}

class MonitoringTarget {
  TargetID: number;
  Nickname: string;
  Interval: number;
  GroupID: number | null;
  Weight: number;
  // Stable, human-friendly OSC/API identifier; unique across the shared client
  // namespace. Back-filled non-null on boot.
  Slug: string | null;
  // Target-wide failure threshold; null inherits the global setting. Checks
  // that set their own override this.
  FailureThreshold: number | null;
  Timestamp: number;
  Checks: MonitoringCheck[];
  Online: boolean;
  Degraded: boolean;
  LastChecked: number | null;
  LastLatencyMs: number | null;
  LastError: string | null;
  _timer: ReturnType<typeof setTimeout> | null;
  _running: boolean;
  _stopped: boolean;
  _gen: number;

  constructor(Row: MonitoringTargetInput, Checks: MonitoringCheckInput[] = []) {
    this.TargetID = Row.TargetID;
    this.Nickname = Row.Nickname || '';
    this.Interval = ClampInterval(Row.Interval);
    this.GroupID = Row.GroupID == null ? null : Row.GroupID;
    this.Weight = typeof Row.Weight === 'number' ? Row.Weight : 100;
    this.Slug = Row.Slug || null;
    this.FailureThreshold = ClampFailureThreshold(Row.FailureThreshold);
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
    this._stopped = false;
    this._gen = 0;

    // A target with no checks is idle — it has nothing to probe, so it
    // should not appear online, degraded, or offline.
    // (Online/Degraded already default to false above.)
  }

  // The tile UI still references a single Address/Method for the subtitle; we
  // surface the first check's values for backwards compatibility.
  get PrimaryCheck(): MonitoringCheck | null {
    return this.Checks.length ? this.Checks[0]! : null;
  }

  // The threshold a check without its own override uses: this target's, or the
  // global default. Resolved on demand so a settings change applies live.
  InheritedFailureThreshold(): number {
    return this.FailureThreshold ?? GetDefaultFailureThreshold();
  }

  // Probe the given checks (all of them by default) and refresh the aggregate.
  // Does not broadcast — callers decide whether the result is still wanted.
  async RunChecks(Checks: MonitoringCheck[] = this.Checks) {
    const Inherited = this.InheritedFailureThreshold();
    await Promise.all(Checks.map((Check) => Check.Run(Inherited)));
    this.RecomputeAggregate();
  }

  // Snapshot used for IPC + broadcast payloads.
  ToJSON(): MonitoringTargetView {
    const Primary = this.PrimaryCheck;
    const Inherited = this.InheritedFailureThreshold();
    return {
      TargetID: this.TargetID,
      Nickname: this.Nickname,
      Interval: this.Interval,
      GroupID: this.GroupID,
      Weight: this.Weight,
      Slug: this.Slug,
      FailureThreshold: this.FailureThreshold,
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
      Checks: this.Checks.map((C) => C.ToJSON(Inherited)),
      Type: 'monitor',
    };
  }

  _aggregateLastSuccessAt(): number | null {
    let latest: number | null = null;
    for (const Check of this.Checks) {
      const Ts = Number(Check.LastSuccessAt);
      if (Number.isFinite(Ts) && (latest == null || Ts > latest)) latest = Ts;
    }
    return latest;
  }

  // Recompute the aggregated Online/Degraded/Latency/Error/LastChecked from the
  // checks that have reached a verdict.
  RecomputeAggregate() {
    const Checks = this.Checks.filter((C) => C.LastChecked != null);
    this.LastChecked = Checks.length ? Math.max(...Checks.map((C) => C.LastChecked!)) : null;
    if (!Checks.length) {
      // No checks (idle) or none answered yet — either way, no verdict.
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
          ? Checks[0]!.LastError || 'Check failed'
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
    this._stopped = false;
    // Run an initial check shortly after boot so the UI doesn't sit "Unknown"
    // for a full interval.
    const Gen = this._gen;
    this._timer = setTimeout(() => this.Tick(Gen), MONITORING_TICK_INTERVAL_MS);
  }

  StopLoop() {
    // `_stopped` outlives the timer handle on purpose: a Tick already awaiting
    // its checks cannot be cancelled, so it has to observe the flag to know it
    // must not broadcast or re-arm once it lands.
    this._stopped = true;
    // Bumping the generation retires every timer and in-flight tick belonging to
    // the previous loop. Without it, a StartLoop() landing while a tick is still
    // awaiting its checks leaves two live chains: the new timer StartLoop armed,
    // plus the one the in-flight tick re-arms from its `finally`.
    this._gen++;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  async Tick(Gen: number = this._gen) {
    if (this._stopped || Gen !== this._gen) return;
    if (this._running) {
      // overlap protection — schedule next tick and bail
      this._timer = setTimeout(() => this.Tick(Gen), this.Interval);
      return;
    }
    this._running = true;
    try {
      await this.RunChecks();
      if (this._stopped || Gen !== this._gen) return;
      BroadcastManager.emit('MonitoringTargetUpdated', this.ToJSON());
    } catch (Err) {
      Logger.error(`Tick failed for target ${this.TargetID}:`, Err);
    } finally {
      this._running = false;
      if (!this._stopped && Gen === this._gen) {
        this._timer = setTimeout(() => this.Tick(Gen), this.Interval);
      }
    }
  }
}

export { MonitoringTarget, MonitoringCheck };
export type { MonitoringCheckInput, MonitoringTargetInput };
