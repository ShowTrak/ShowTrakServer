// One FreeKiosk terminal: its persisted configuration, its live readings, and
// the loop that polls it.
//
// The loop mechanics are lifted from MonitoringTarget deliberately rather than
// reinvented — the generation counter and the overlap guard exist because a poll
// that is already awaiting the network cannot be cancelled, and without them a
// restarted loop leaves two live timer chains racing each other.
//
// ToJSON() is the only thing that ever leaves this object. It crosses Electron's
// IPC by structured clone and is JSON-stringified into alert history, so it must
// stay plain data: no timers, no class instances, no cycles. The timer and the
// previous-readings map are therefore instance fields that the snapshot never
// touches — and the API key is deliberately absent from it, because the snapshot
// also reaches the Web UI and the alert log.
import { Manager as BroadcastManager } from '../Broadcast';
import { CreateLogger } from '../Logger';
import { MONITORING_TICK_INTERVAL_MS } from '../Config/constants';
import { GetStatus } from '../FreeKiosk/client';
import { ExtractMetricValues, FREEKIOSK_METRICS } from '../FreeKiosk/metrics';
import { EvaluateAllAlarms, BuildDegradedReason } from '../FreeKiosk/alarms';
import type { FreeKioskAlarmResult, FreeKioskReading } from '../FreeKiosk/alarms';
import {
  ClampInterval,
  ClampPort,
  ClampTimeout,
  NormalizeAddress,
  ParseSettings,
} from './normalize';
import type { FreeKioskTerminalRow } from '../DB/rows';

const Logger = CreateLogger('FreeKiosk');

export type FreeKioskState = 'IDLE' | 'ONLINE' | 'DEGRADED' | 'OFFLINE';

export interface FreeKioskAlarmSummary {
  Key: string;
  Label: string;
  Value: FreeKioskReading;
  Reason: string;
}

export interface FreeKioskTerminalSnapshot {
  UUID: string;
  Slug: string | null;
  Nickname: string;
  Hostname: string;
  Address: string;
  Port: number;
  HasApiKey: boolean;
  IP: string | null;
  Version: 'FreeKiosk';
  Interval: number;
  TimeoutMs: number;
  GroupID: number | null;
  Weight: number;
  Timestamp: number;
  Settings: Record<string, unknown>;
  State: FreeKioskState;
  Online: boolean;
  Degraded: boolean;
  DegradedWarnings: string[];
  Alarms: FreeKioskAlarmSummary[];
  Metrics: Record<string, FreeKioskReading>;
  LastError: string | null;
  LastChecked: number | null;
  LastSuccessAt: number | null;
  LastLatencyMs: number | null;
  ControlEnabled: boolean | null;
  Type: 'freekiosk';
}

export interface FreeKioskTerminalInput {
  UUID: string;
  Nickname?: string | null;
  Address: string;
  Port?: number | null;
  ApiKey?: string | null;
  Interval?: number | null;
  TimeoutMs?: number | null;
  Settings?: unknown;
  GroupID?: number | null;
  Weight?: number | null;
  LastSuccessAt?: number | null;
  Slug?: string | null;
  Timestamp?: number | null;
}

function EmptyMetrics(): Record<string, FreeKioskReading> {
  const Values: Record<string, FreeKioskReading> = {};
  for (const Metric of FREEKIOSK_METRICS) Values[Metric.Key] = null;
  return Values;
}

class FreeKioskTerminal {
  UUID: string;
  Slug: string | null;
  Nickname: string;
  Address: string;
  Port: number;
  ApiKey: string | null;
  Interval: number;
  TimeoutMs: number;
  Settings: Record<string, unknown>;
  GroupID: number | null;
  Weight: number;
  Timestamp: number;

  // ---- Runtime state (never persisted) ----
  /** Null before the first poll: unknown is not the same as offline. */
  Online: boolean | null = null;
  Degraded = false;
  DegradedWarnings: string[] = [];
  Alarms: FreeKioskAlarmSummary[] = [];
  Metrics: Record<string, FreeKioskReading> = EmptyMetrics();
  LastError: string | null = null;
  LastChecked: number | null = null;
  LastSuccessAt: number | null = null;
  LastLatencyMs: number | null = null;
  /** null until a control command has been attempted — see SetControlEnabled. */
  ControlEnabled: boolean | null = null;

  // ---- Loop internals (never serialised) ----
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _stopped = true;
  private _running = false;
  private _gen = 0;
  /** Last poll's readings, so the edge operators have something to compare to. */
  private _previous: Record<string, FreeKioskReading> | null = null;

  constructor(Row: FreeKioskTerminalRow | FreeKioskTerminalInput) {
    this.UUID = String(Row.UUID);
    this.Slug = Row.Slug == null ? null : String(Row.Slug);
    this.Nickname = String(Row.Nickname || '').trim() || 'FreeKiosk Terminal';
    this.Address = NormalizeAddress(Row.Address);
    this.Port = ClampPort(Row.Port);
    this.ApiKey = Row.ApiKey == null || Row.ApiKey === '' ? null : String(Row.ApiKey);
    this.Interval = ClampInterval(Row.Interval);
    this.TimeoutMs = ClampTimeout(Row.TimeoutMs);
    this.Settings = ParseSettings(Row.Settings);
    this.GroupID = Row.GroupID == null ? null : Number(Row.GroupID);
    this.Weight = Number.isFinite(Number(Row.Weight)) ? Number(Row.Weight) : 100;
    this.LastSuccessAt = Row.LastSuccessAt == null ? null : Number(Row.LastSuccessAt);
    this.Timestamp = Number(Row.Timestamp) || Date.now();
  }

  /** Connection details for the protocol client. */
  Connection() {
    return {
      Address: this.Address,
      Port: this.Port,
      ApiKey: this.ApiKey,
      TimeoutMs: this.TimeoutMs,
    };
  }

  /**
   * Record what a control attempt revealed about the device's remote-control
   * setting. It is unknowable until something is actually sent — the device only
   * discloses it by refusing — which is why this starts null rather than true.
   */
  SetControlEnabled(Enabled: boolean): boolean {
    const Changed = this.ControlEnabled !== Enabled;
    this.ControlEnabled = Enabled;
    return Changed;
  }

  get State(): FreeKioskState {
    if (this.Online == null) return 'IDLE';
    if (!this.Online) return 'OFFLINE';
    return this.Degraded ? 'DEGRADED' : 'ONLINE';
  }

  ToJSON(): FreeKioskTerminalSnapshot {
    return {
      UUID: this.UUID,
      Slug: this.Slug,
      Nickname: this.Nickname,
      // Falls back to the address so a tile is never blank before the first poll.
      Hostname: (this.Metrics.device_model as string) || this.Address,
      Address: this.Address,
      Port: this.Port,
      HasApiKey: !!this.ApiKey,
      IP: (this.Metrics.device_ip as string) || this.Address || null,
      Version: 'FreeKiosk',
      Interval: this.Interval,
      TimeoutMs: this.TimeoutMs,
      GroupID: this.GroupID,
      Weight: this.Weight,
      Timestamp: this.Timestamp,
      Settings: { ...this.Settings },
      State: this.State,
      Online: this.Online === true,
      Degraded: this.Degraded,
      DegradedWarnings: this.DegradedWarnings.slice(),
      Alarms: this.Alarms.map((Alarm) => ({ ...Alarm })),
      Metrics: { ...this.Metrics },
      LastError: this.LastError,
      LastChecked: this.LastChecked,
      LastSuccessAt: this.LastSuccessAt,
      LastLatencyMs: this.LastLatencyMs,
      ControlEnabled: this.ControlEnabled,
      Type: 'freekiosk',
    };
  }

  /**
   * Poll once and fold the result into this terminal's live state.
   *
   * Returns true when the poll succeeded. Readings are deliberately RETAINED on
   * failure: an operator looking at a terminal that just dropped wants the last
   * thing it said, not a blank panel. LastSuccessAt is what marks them stale.
   */
  async Run(): Promise<boolean> {
    const [Err, Reading] = await GetStatus(this.Connection());
    this.LastChecked = Date.now();

    if (Err || !Reading) {
      this.Online = false;
      this.Degraded = false;
      this.DegradedWarnings = [];
      this.Alarms = [];
      this.LastLatencyMs = null;
      this.LastError = Err || 'No response from device';
      // A failed poll must not leave the previous readings looking current, and
      // must not let an edge operator fire against a stale comparison when the
      // device comes back.
      this._previous = null;
      return false;
    }

    const Values = ExtractMetricValues(Reading.Status, {
      poll_latencyMs: Reading.LatencyMs,
      control_enabled: this.ControlEnabled,
    });

    const Results = EvaluateAllAlarms(Values, this.Settings, this._previous);
    const Breaches = Results.filter((Result: FreeKioskAlarmResult) => Result.Breach);

    this.Online = true;
    this.Degraded = Breaches.length > 0;
    this.DegradedWarnings = Breaches.map((Result) => Result.Reason as string);
    this.Alarms = Breaches.map((Result) => ({
      Key: Result.Key,
      Label: Result.Label,
      Value: Result.Value,
      Reason: Result.Reason as string,
    }));
    this.LastError = this.Degraded ? BuildDegradedReason(Results) : null;
    this.LastLatencyMs = Reading.LatencyMs;
    this.LastSuccessAt = this.LastChecked;
    this.Metrics = Values;
    this._previous = Values;
    return true;
  }

  StartLoop(): void {
    this.StopLoop();
    this._stopped = false;
    // First poll shortly after boot so a tile does not sit unknown for a whole
    // interval — 30s is a long time to look broken.
    const Gen = this._gen;
    this._timer = setTimeout(() => this.Tick(Gen), MONITORING_TICK_INTERVAL_MS);
    this._timer.unref?.();
  }

  StopLoop(): void {
    // `_stopped` outlives the timer handle on purpose: a Tick already awaiting
    // the network cannot be cancelled, so it has to observe the flag to know it
    // must not broadcast or re-arm once it lands.
    this._stopped = true;
    // Bumping the generation retires every timer and in-flight tick belonging to
    // the previous loop. Without it, a StartLoop() landing while a tick is still
    // in flight leaves two live chains: the timer StartLoop armed, plus the one
    // the in-flight tick re-arms from its `finally`.
    this._gen++;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  async Tick(Gen: number = this._gen): Promise<void> {
    if (this._stopped || Gen !== this._gen) return;
    if (this._running) {
      // A device slower than the interval must not stack up requests.
      this._timer = setTimeout(() => this.Tick(Gen), this.Interval);
      this._timer.unref?.();
      return;
    }
    this._running = true;
    try {
      await this.Run();
      if (this._stopped || Gen !== this._gen) return;
      BroadcastManager.emit('FreeKioskTerminalUpdated', this.ToJSON());
    } catch (Err) {
      Logger.error(`Poll failed for FreeKiosk terminal ${this.UUID}:`, Err);
    } finally {
      this._running = false;
      if (!this._stopped && Gen === this._gen) {
        this._timer = setTimeout(() => this.Tick(Gen), this.Interval);
        this._timer.unref?.();
      }
    }
  }

  /** Poll immediately, outside the loop's schedule (Test Connection, Poll Now). */
  async RunNow(): Promise<boolean> {
    const Success = await this.Run();
    if (!this._stopped) BroadcastManager.emit('FreeKioskTerminalUpdated', this.ToJSON());
    return Success;
  }

  SetInterval(Interval: unknown): void {
    const Next = ClampInterval(Interval);
    if (Next === this.Interval) return;
    this.Interval = Next;
    if (!this._stopped) this.StartLoop();
  }
}

export { FreeKioskTerminal };
