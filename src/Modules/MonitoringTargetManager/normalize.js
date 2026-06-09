// Pure normalization helpers and interval bounds shared across the
// MonitoringTargetManager modules.
const MIN_INTERVAL_MS = 3000;
const MAX_INTERVAL_MS = 5 * 60 * 1000;

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

module.exports = {
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  ParseSettings,
  ClampInterval,
  ClampThreshold,
};
