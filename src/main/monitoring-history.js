// Monitoring history store (main process)
// Keeps rolling, in-memory time series for monitor targets and dummy clients
// so the renderer can draw recent uptime graphs. Samples older than MAX_AGE
// are pruned. The backing Maps are encapsulated here; callers interact only
// through exported helpers.
const MONITORING_HISTORY_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const ENTITY_MONITOR_TARGET = 'monitor-target';
const ENTITY_DUMMY_CLIENT = 'dummy-client';

const MonitoringHistoryStores = Object.freeze({
  [ENTITY_MONITOR_TARGET]: new Map(),
  [ENTITY_DUMMY_CLIENT]: new Map(),
});

function getHistoryStore(entityType) {
  return MonitoringHistoryStores[entityType] || null;
}

function normalizeMonitorTargetID(targetID) {
  const n = Number(targetID);
  return Number.isFinite(n) ? n : null;
}

function normalizeDummyUUID(uuid) {
  const trimmed = typeof uuid === 'string' ? uuid.trim() : '';
  return trimmed || null;
}

function resolveEntityKey(entityType, id) {
  if (entityType === ENTITY_MONITOR_TARGET) return normalizeMonitorTargetID(id);
  if (entityType === ENTITY_DUMMY_CLIENT) return normalizeDummyUUID(id);
  return null;
}

function normalizeLatency(latencyMs) {
  const parsed = Number(latencyMs);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function pruneMonitoringHistoryStore(now = Date.now()) {
  const cutoff = now - MONITORING_HISTORY_MAX_AGE_MS;
  for (const store of Object.values(MonitoringHistoryStores)) {
    for (const [key, samples] of store.entries()) {
      const next = Array.isArray(samples) ? samples.filter((s) => s && s.ts >= cutoff) : [];
      if (!next.length) {
        store.delete(key);
        continue;
      }
      store.set(key, next);
    }
  }
}

function recordEntityHistorySample(entityType, id, sample) {
  const store = getHistoryStore(entityType);
  if (!store || !sample) return;
  const key = resolveEntityKey(entityType, id);
  if (key == null) return;

  const now = Date.now();
  const normalized = {
    ts: now,
    online: !!sample.online,
    degraded: !!sample.degraded,
    latencyMs: normalizeLatency(sample.latencyMs),
  };

  const samples = store.get(key) || [];
  const last = samples.length ? samples[samples.length - 1] : null;
  const duplicateQuickUpdate =
    last &&
    now - last.ts < 900 &&
    last.online === normalized.online &&
    last.degraded === normalized.degraded &&
    ((last.latencyMs == null && normalized.latencyMs == null) ||
      Math.round(last.latencyMs || 0) === Math.round(normalized.latencyMs || 0));

  if (duplicateQuickUpdate) {
    last.ts = now;
  } else {
    samples.push(normalized);
  }

  const cutoff = now - MONITORING_HISTORY_MAX_AGE_MS;
  while (samples.length && samples[0].ts < cutoff) samples.shift();

  store.set(key, samples);
}

function syncEntityHistoryStore(entityType, list, keyResolver, sampleResolver) {
  const store = getHistoryStore(entityType);
  if (!store || typeof keyResolver !== 'function' || typeof sampleResolver !== 'function') return;

  const safeList = Array.isArray(list) ? list : [];
  const validKeys = new Set();

  for (const item of safeList) {
    const key = resolveEntityKey(entityType, keyResolver(item));
    if (key == null) continue;
    validKeys.add(key);
    recordEntityHistorySample(entityType, key, sampleResolver(item));
  }

  for (const existingKey of store.keys()) {
    if (!validKeys.has(existingKey)) store.delete(existingKey);
  }

  pruneMonitoringHistoryStore();
}

function getEntityHistorySamples(entityType, id) {
  pruneMonitoringHistoryStore();
  const store = getHistoryStore(entityType);
  if (!store) return [];
  const key = resolveEntityKey(entityType, id);
  if (key == null) return [];
  return store.get(key) || [];
}

function recordMonitoringHistorySample(target) {
  if (!target || !target.TargetID) return;
  recordEntityHistorySample(ENTITY_MONITOR_TARGET, target.TargetID, {
    online: !!target.Online,
    degraded: !!target.Degraded,
    latencyMs: target.LastLatencyMs,
  });
}

function syncMonitoringHistoryStore(list) {
  syncEntityHistoryStore(
    ENTITY_MONITOR_TARGET,
    list,
    (target) => target && target.TargetID,
    (target) => ({
      online: !!(target && target.Online),
      degraded: !!(target && target.Degraded),
      latencyMs: target && target.LastLatencyMs,
    })
  );
}

function getMonitoringHistorySamples(targetID) {
  return getEntityHistorySamples(ENTITY_MONITOR_TARGET, targetID);
}

function recordDummyHistorySample(dummy) {
  if (!dummy || !dummy.UUID) return;
  recordEntityHistorySample(ENTITY_DUMMY_CLIENT, dummy.UUID, {
    online: !!dummy.Online,
    degraded: !!dummy.Degraded,
    latencyMs: null,
  });
}

function syncDummyHistoryStore(list) {
  syncEntityHistoryStore(
    ENTITY_DUMMY_CLIENT,
    list,
    (dummy) => dummy && dummy.UUID,
    (dummy) => ({
      online: !!(dummy && dummy.Online),
      degraded: !!(dummy && dummy.Degraded),
      latencyMs: null,
    })
  );
}

function getDummyHistorySamples(uuid) {
  return getEntityHistorySamples(ENTITY_DUMMY_CLIENT, uuid);
}

module.exports = {
  MONITORING_HISTORY_MAX_AGE_MS,
  pruneMonitoringHistoryStore,
  recordEntityHistorySample,
  syncEntityHistoryStore,
  getEntityHistorySamples,
  recordMonitoringHistorySample,
  syncMonitoringHistoryStore,
  getMonitoringHistorySamples,
  recordDummyHistorySample,
  syncDummyHistoryStore,
  getDummyHistorySamples,
};
