// Monitoring target history store (main process)
// Keeps a rolling, in-memory time series of monitoring probe results so the
// renderer can draw recent latency/availability sparklines. Samples older than
// MAX_AGE are pruned. The backing Map is encapsulated here; callers interact
// only through the exported helpers.
const MONITORING_HISTORY_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const MonitoringTargetHistoryStore = new Map();

function pruneMonitoringHistoryStore(now = Date.now()) {
  const cutoff = now - MONITORING_HISTORY_MAX_AGE_MS;
  for (const [targetID, samples] of MonitoringTargetHistoryStore.entries()) {
    const next = Array.isArray(samples) ? samples.filter((s) => s && s.ts >= cutoff) : [];
    if (!next.length) {
      MonitoringTargetHistoryStore.delete(targetID);
      continue;
    }
    MonitoringTargetHistoryStore.set(targetID, next);
  }
}

function recordMonitoringHistorySample(target) {
  if (!target || !target.TargetID) return;
  const targetID = Number(target.TargetID);
  if (!Number.isFinite(targetID)) return;

  const now = Date.now();
  const parsedLatency = Number(target.LastLatencyMs);
  const latencyMs = Number.isFinite(parsedLatency) && parsedLatency >= 0 ? parsedLatency : null;
  const sample = {
    ts: now,
    online: !!target.Online,
    degraded: !!target.Degraded,
    latencyMs,
  };

  const samples = MonitoringTargetHistoryStore.get(targetID) || [];
  const last = samples.length ? samples[samples.length - 1] : null;
  const duplicateQuickUpdate =
    last &&
    now - last.ts < 900 &&
    last.online === sample.online &&
    last.degraded === sample.degraded &&
    ((last.latencyMs == null && sample.latencyMs == null) ||
      Math.round(last.latencyMs || 0) === Math.round(sample.latencyMs || 0));

  if (duplicateQuickUpdate) {
    last.ts = now;
  } else {
    samples.push(sample);
  }

  const cutoff = now - MONITORING_HISTORY_MAX_AGE_MS;
  while (samples.length && samples[0].ts < cutoff) samples.shift();

  MonitoringTargetHistoryStore.set(targetID, samples);
}

function syncMonitoringHistoryStore(list) {
  const safeList = Array.isArray(list) ? list : [];
  const validIDs = new Set();

  for (const target of safeList) {
    const targetID = Number(target && target.TargetID);
    if (!Number.isFinite(targetID)) continue;
    validIDs.add(targetID);
    recordMonitoringHistorySample(target);
  }

  for (const existingID of MonitoringTargetHistoryStore.keys()) {
    if (!validIDs.has(existingID)) MonitoringTargetHistoryStore.delete(existingID);
  }

  pruneMonitoringHistoryStore();
}

// Prune stale samples and return the current series for a single target.
function getMonitoringHistorySamples(targetID) {
  pruneMonitoringHistoryStore();
  return MonitoringTargetHistoryStore.get(Number(targetID)) || [];
}

module.exports = {
  MONITORING_HISTORY_MAX_AGE_MS,
  pruneMonitoringHistoryStore,
  recordMonitoringHistorySample,
  syncMonitoringHistoryStore,
  getMonitoringHistorySamples,
};
