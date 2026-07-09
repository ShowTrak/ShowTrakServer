// Client vitals telemetry, emitted on every heartbeat.
// Source of truth: ShowTrakClient `OS.GetVitals()`.

export interface CpuVitals {
  /** Smoothed CPU usage percentage (0-100). */
  UsagePercentage: number;
}

export interface RamVitals {
  /** Total physical memory in bytes. */
  Total: number;
  /** Used physical memory in bytes. */
  Used: number;
  /**
   * Used-memory percentage formatted to two decimals.
   * NOTE: this is transmitted as a STRING (produced via `Number#toFixed(2)`).
   */
  UsagePercentage: string;
}

export interface UptimeVitals {
  /** Uptime formatted as `HH:mm:ss`. */
  Formatted: string;
}

export interface Vitals {
  CPU: CpuVitals;
  Ram: RamVitals;
  Uptime: UptimeVitals;
}
