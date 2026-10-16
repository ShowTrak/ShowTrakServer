// Pure normalization helpers and interval bounds shared across the
// MonitoringTargetManager modules.
import { DEFAULT_MONITORING_INTERVAL_MS, MAX_MONITORING_INTERVAL_MS } from '../Config/constants';

const MIN_INTERVAL_MS = 3000;
const MAX_INTERVAL_MS = MAX_MONITORING_INTERVAL_MS;

// How many failed probes in a row a check needs before it reads offline. 1 is
// the historical behaviour (the first miss is an outage); higher values ride out
// a single dropped packet or a device that is briefly slow to answer.
const MIN_FAILURE_THRESHOLD = 1;
const MAX_FAILURE_THRESHOLD = 10;
const DEFAULT_FAILURE_THRESHOLD = 1;

// Fallback interval applied when a target does not specify its own. Seeded from
// the compiled-in default and overridable at runtime by the
// MONITORING_DEFAULT_INTERVAL_MS setting (see main/live-settings).
let DefaultIntervalMs = DEFAULT_MONITORING_INTERVAL_MS;

function SetDefaultInterval(Value: unknown): void {
  const n = Number(Value);
  if (!Number.isFinite(n)) return;
  DefaultIntervalMs = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(n)));
}

// Server-wide failure threshold inherited by every target and check that does
// not set its own. Overridable at runtime by the MONITORING_FAILURE_THRESHOLD
// setting (see main/live-settings). Resolved on every probe, so a change applies
// from the next check onwards without a reload.
let DefaultFailureThreshold = DEFAULT_FAILURE_THRESHOLD;

function SetDefaultFailureThreshold(Value: unknown): void {
  const n = ClampFailureThreshold(Value);
  if (n !== null) DefaultFailureThreshold = n;
}

function GetDefaultFailureThreshold(): number {
  return DefaultFailureThreshold;
}

function ParseSettings(Raw: unknown): Record<string, unknown> {
  if (!Raw) return {};
  if (typeof Raw === 'object') return Raw as Record<string, unknown>;
  try {
    const Parsed = JSON.parse(Raw as string);
    return Parsed && typeof Parsed === 'object' ? Parsed : {};
  } catch {
    return {};
  }
}

function ClampInterval(Value: unknown): number {
  let n = Number(Value);
  if (!Number.isFinite(n)) n = DefaultIntervalMs;
  if (n < MIN_INTERVAL_MS) n = MIN_INTERVAL_MS;
  if (n > MAX_INTERVAL_MS) n = MAX_INTERVAL_MS;
  return Math.round(n);
}

// 0 = disabled. Threshold is compared against LastLatencyMs in Tick().
function ClampThreshold(Value: unknown): number {
  let n = Number(Value);
  if (!Number.isFinite(n) || n < 0) n = 0;
  if (n > 600000) n = 600000;
  return Math.round(n);
}

// Optional failure-threshold override. null/undefined/'' (and anything that is
// not a number) mean "inherit"; numbers are rounded and clamped to 1–10.
function ClampFailureThreshold(Value: unknown): number | null {
  if (Value === null || Value === undefined || Value === '') return null;
  const n = Number(Value);
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_FAILURE_THRESHOLD, Math.max(MIN_FAILURE_THRESHOLD, Math.round(n)));
}

export {
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  MIN_FAILURE_THRESHOLD,
  MAX_FAILURE_THRESHOLD,
  DEFAULT_FAILURE_THRESHOLD,
  ParseSettings,
  ClampInterval,
  ClampThreshold,
  ClampFailureThreshold,
  SetDefaultInterval,
  SetDefaultFailureThreshold,
  GetDefaultFailureThreshold,
};
