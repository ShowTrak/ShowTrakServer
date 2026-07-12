// Pure normalization helpers and interval bounds shared across the
// MonitoringTargetManager modules.
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';

const MIN_INTERVAL_MS = 3000;
const MAX_INTERVAL_MS = 5 * 60 * 1000;

// Fallback interval applied when a target does not specify its own. Seeded from
// the compiled-in default and overridable at runtime by the
// MONITORING_DEFAULT_INTERVAL_MS setting (see main/live-settings).
let DefaultIntervalMs = DEFAULT_MONITORING_INTERVAL_MS;

function SetDefaultInterval(Value: unknown): void {
  const n = Number(Value);
  if (!Number.isFinite(n)) return;
  DefaultIntervalMs = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(n)));
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

export {
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  ParseSettings,
  ClampInterval,
  ClampThreshold,
  SetDefaultInterval,
};
