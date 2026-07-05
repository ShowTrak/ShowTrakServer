// Monitoring history store (main process)
// Keeps rolling, in-memory time series for monitor targets and dummy clients
// so the renderer can draw recent uptime graphs. Samples older than MAX_AGE
// are pruned. The backing Maps are encapsulated here; callers interact only
// through exported helpers.
const MONITORING_HISTORY_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const ENTITY_MONITOR_TARGET = 'monitor-target';
const ENTITY_DUMMY_CLIENT = 'dummy-client';
const ENTITY_CLIENT = 'client';

const MonitoringHistoryStores = Object.freeze({
  [ENTITY_MONITOR_TARGET]: new Map(),
  [ENTITY_DUMMY_CLIENT]: new Map(),
  [ENTITY_CLIENT]: new Map(),
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
  if (entityType === ENTITY_CLIENT) return normalizeDummyUUID(id);
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
  const checks = Array.isArray(target.Checks) ? target.Checks : [];
  for (const check of checks) {
    if (!check || check.CheckID == null) continue;
    recordEntityHistorySample(ENTITY_MONITOR_TARGET, check.CheckID, {
      online: !!check.Online,
      degraded: !!check.Degraded,
      latencyMs: check.LastLatencyMs,
    });
  }
}

function syncMonitoringHistoryStore(list) {
  // Flatten every target's checks into a single per-check sample list so the
  // shared sync helper can prune history for checks that no longer exist.
  const checks = [];
  for (const target of Array.isArray(list) ? list : []) {
    for (const check of Array.isArray(target && target.Checks) ? target.Checks : []) {
      if (check && check.CheckID != null) checks.push(check);
    }
  }
  syncEntityHistoryStore(
    ENTITY_MONITOR_TARGET,
    checks,
    (check) => check && check.CheckID,
    (check) => ({
      online: !!(check && check.Online),
      degraded: !!(check && check.Degraded),
      latencyMs: check && check.LastLatencyMs,
    })
  );
}

function getMonitoringCheckHistory(checkID) {
  return getEntityHistorySamples(ENTITY_MONITOR_TARGET, checkID);
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

// Real ShowTrak clients record online/degraded status history so the client
// info modal can render the same status timeline as monitoring targets and
// dummy clients. Integrated SDK clients are included too (they report an
// online/degraded state), only their extra hardware panes are hidden in the UI.
function recordClientHistorySample(client) {
  if (!client || !client.UUID) return;
  recordEntityHistorySample(ENTITY_CLIENT, client.UUID, {
    online: !!client.Online,
    degraded: !!client.Degraded,
    latencyMs: null,
  });
}

function syncClientHistoryStore(list) {
  syncEntityHistoryStore(
    ENTITY_CLIENT,
    list,
    (client) => client && client.UUID,
    (client) => ({
      online: !!(client && client.Online),
      degraded: !!(client && client.Degraded),
      latencyMs: null,
    })
  );
}

function getClientHistorySamples(uuid) {
  return getEntityHistorySamples(ENTITY_CLIENT, uuid);
}

// Per-critical-application status history for real ShowTrak clients. Each
// critical application gets its own online (running) / offline (not running)
// timeline so the client info modal can render them the same way monitoring
// targets render individual checks. This data is RAM-only (never persisted to
// the DB or show file) and is sampled on a fixed cadence (see main.js) that
// mirrors the ShowTrakClient application poll interval (20s).
//
// Store shape: Map<UUID, Map<ApplicationKey, { Name, samples: [] }>>
const ClientApplicationHistoryStore = new Map();

// Resolve the current running/not-running state for every critical application
// on a client, but only when the state can be trusted. Returns null (skip this
// sample, leaving an idle gap) when the client is offline or its application
// monitoring status is not 'ok' (e.g. permission denied / error / unknown) so
// we never paint "not running" red bars for data we could not actually read.
function extractCriticalApplicationStates(client) {
  if (!client || !client.Online) return null;
  const running =
    client.RunningApplications && typeof client.RunningApplications === 'object'
      ? client.RunningApplications
      : null;
  if (!running) return null;
  const status = running.Status && typeof running.Status === 'object' ? running.Status : {};
  const state = String(status.State || 'unknown').toLowerCase();
  if (state !== 'ok') return null;
  const items = Array.isArray(running.Items) ? running.Items : [];
  const states = [];
  for (const item of items) {
    if (!item || !item.IsCritical) continue;
    const name = typeof item.Name === 'string' && item.Name.trim() ? item.Name.trim() : null;
    const key = typeof item.Key === 'string' && item.Key.trim() ? item.Key.trim() : name;
    if (!key) continue;
    states.push({ key, name: name || key, isRunning: item.IsRunning !== false });
  }
  return states;
}

function recordClientApplicationHistorySamples(client, sampledAt = null) {
  const uuid = normalizeDummyUUID(client && client.UUID);
  if (!uuid) return;
  const states = extractCriticalApplicationStates(client);
  if (!states) return; // Not evaluable right now; leave an idle gap.

  const now =
    sampledAt != null && Number.isFinite(Number(sampledAt)) ? Number(sampledAt) : Date.now();
  const cutoff = now - MONITORING_HISTORY_MAX_AGE_MS;
  let perApp = ClientApplicationHistoryStore.get(uuid);
  if (!perApp) {
    perApp = new Map();
    ClientApplicationHistoryStore.set(uuid, perApp);
  }

  const seenKeys = new Set();
  for (const state of states) {
    seenKeys.add(state.key);
    const existing = perApp.get(state.key);
    const previousSamples = Array.isArray(existing && existing.Points) ? existing.Points : [];
    const sample = { ts: now, online: !!state.isRunning, degraded: false, latencyMs: null };
    const last = previousSamples.length ? previousSamples[previousSamples.length - 1] : null;
    let nextSamples;
    if (last && now - last.ts < 900 && last.online === sample.online) {
      nextSamples = previousSamples.slice(0, -1).concat({ ...last, ts: now });
    } else {
      nextSamples = previousSamples.concat(sample);
    }
    while (nextSamples.length && nextSamples[0].ts < cutoff) nextSamples.shift();
    perApp.set(state.key, {
      Name: state.name || (existing && existing.Name) || state.key,
      Points: nextSamples,
    });
  }

  // Drop history for applications that are no longer marked critical so the
  // modal only shows currently-tracked applications.
  for (const key of Array.from(perApp.keys())) {
    if (!seenKeys.has(key)) perApp.delete(key);
  }
  if (!perApp.size) ClientApplicationHistoryStore.delete(uuid);
}

function syncClientApplicationHistoryStore(list) {
  const safeList = Array.isArray(list) ? list : [];
  const validUUIDs = new Set();
  for (const client of safeList) {
    const uuid = normalizeDummyUUID(client && client.UUID);
    if (!uuid) continue;
    validUUIDs.add(uuid);
    recordClientApplicationHistorySamples(client);
  }
  for (const uuid of Array.from(ClientApplicationHistoryStore.keys())) {
    if (!validUUIDs.has(uuid)) ClientApplicationHistoryStore.delete(uuid);
  }
}

function getClientApplicationHistorySamples(uuid) {
  const key = normalizeDummyUUID(uuid);
  if (!key) return [];
  const perApp = ClientApplicationHistoryStore.get(key);
  if (!perApp) return [];
  const now = Date.now();
  const cutoff = now - MONITORING_HISTORY_MAX_AGE_MS;
  const out = [];
  for (const [appKey, entry] of perApp.entries()) {
    const samples = (Array.isArray(entry.Points) ? entry.Points : []).filter(
      (s) => s && Number(s.ts) >= cutoff
    );
    out.push({ Key: appKey, Name: entry.Name || appKey, samples });
  }
  return out;
}

// Per-critical-USB-device connected/disconnected history. Mirrors the critical
// application history above: RAM-only, keyed by device serial number, and
// rendered in the client info modal the same way individual monitoring checks
// are. Store shape: Map<UUID, Map<SerialNumber, { Name, Points: [] }>>
const ClientUSBHistoryStore = new Map();

// Resolve the current connected/disconnected state for every critical USB
// device on a client. Returns null (skip this sample, leaving an idle gap) when
// the client is offline so we never paint "disconnected" red bars for a device
// whose real state we could not observe.
function extractCriticalUSBStates(client) {
  if (!client || !client.Online) return null;
  const devices = Array.isArray(client.USBDeviceList) ? client.USBDeviceList : [];
  const states = [];
  for (const device of devices) {
    if (!device || !device.IsCritical) continue;
    const serial =
      device.SerialNumber != null && String(device.SerialNumber).trim()
        ? String(device.SerialNumber).trim()
        : null;
    if (!serial) continue;
    const manufacturer =
      typeof device.ManufacturerName === 'string' ? device.ManufacturerName.trim() : '';
    const product = typeof device.ProductName === 'string' ? device.ProductName.trim() : '';
    const name = [manufacturer, product].filter(Boolean).join(' ') || 'USB Device';
    const isConnected = device.IsConnected !== false && !device.Missing;
    states.push({ key: serial, name, isConnected });
  }
  return states;
}

function recordClientUSBHistorySamples(client, sampledAt = null) {
  const uuid = normalizeDummyUUID(client && client.UUID);
  if (!uuid) return;
  const states = extractCriticalUSBStates(client);
  if (!states) return; // Not evaluable right now; leave an idle gap.

  const now =
    sampledAt != null && Number.isFinite(Number(sampledAt)) ? Number(sampledAt) : Date.now();
  const cutoff = now - MONITORING_HISTORY_MAX_AGE_MS;
  let perDevice = ClientUSBHistoryStore.get(uuid);
  if (!perDevice) {
    perDevice = new Map();
    ClientUSBHistoryStore.set(uuid, perDevice);
  }

  const seenKeys = new Set();
  for (const state of states) {
    seenKeys.add(state.key);
    const existing = perDevice.get(state.key);
    const previousSamples = Array.isArray(existing && existing.Points) ? existing.Points : [];
    const sample = { ts: now, online: !!state.isConnected, degraded: false, latencyMs: null };
    const last = previousSamples.length ? previousSamples[previousSamples.length - 1] : null;
    let nextSamples;
    if (last && now - last.ts < 900 && last.online === sample.online) {
      nextSamples = previousSamples.slice(0, -1).concat({ ...last, ts: now });
    } else {
      nextSamples = previousSamples.concat(sample);
    }
    while (nextSamples.length && nextSamples[0].ts < cutoff) nextSamples.shift();
    perDevice.set(state.key, {
      Name: state.name || (existing && existing.Name) || state.key,
      Points: nextSamples,
    });
  }

  // Drop history for devices that are no longer marked critical so the modal
  // only shows currently-tracked devices.
  for (const key of Array.from(perDevice.keys())) {
    if (!seenKeys.has(key)) perDevice.delete(key);
  }
  if (!perDevice.size) ClientUSBHistoryStore.delete(uuid);
}

function syncClientUSBHistoryStore(list) {
  const safeList = Array.isArray(list) ? list : [];
  const validUUIDs = new Set();
  for (const client of safeList) {
    const uuid = normalizeDummyUUID(client && client.UUID);
    if (!uuid) continue;
    validUUIDs.add(uuid);
    recordClientUSBHistorySamples(client);
  }
  for (const uuid of Array.from(ClientUSBHistoryStore.keys())) {
    if (!validUUIDs.has(uuid)) ClientUSBHistoryStore.delete(uuid);
  }
}

function getClientUSBHistorySamples(uuid) {
  const key = normalizeDummyUUID(uuid);
  if (!key) return [];
  const perDevice = ClientUSBHistoryStore.get(key);
  if (!perDevice) return [];
  const now = Date.now();
  const cutoff = now - MONITORING_HISTORY_MAX_AGE_MS;
  const out = [];
  for (const [serial, entry] of perDevice.entries()) {
    const samples = (Array.isArray(entry.Points) ? entry.Points : []).filter(
      (s) => s && Number(s.ts) >= cutoff
    );
    out.push({ Serial: serial, Name: entry.Name || serial, samples });
  }
  return out;
}

// Per-critical-display connected / mismatched / missing history. Mirrors the
// critical USB history above: RAM-only, keyed by the stable DisplayID, and
// rendered in the client info modal the same way individual monitoring checks
// are. A connected display whose resolution/refresh matches its captured
// baseline is "online" (green); a connected-but-changed display is "online but
// degraded" (orange); a missing display is "offline" (red).
// Store shape: Map<UUID, Map<DisplayID, { Name, Points: [] }>>
const ClientDisplayHistoryStore = new Map();

// Resolve the current state for every critical display on a client. Returns
// null (skip this sample, leaving an idle gap) when the client is offline so we
// never paint "missing" red bars for a display whose real state we could not
// observe.
function extractCriticalDisplayStates(client) {
  if (!client || !client.Online) return null;
  const displays = Array.isArray(client.DisplayList) ? client.DisplayList : [];
  const states = [];
  for (const display of displays) {
    if (!display || !display.IsCritical) continue;
    const id =
      display.DisplayID != null && String(display.DisplayID).trim()
        ? String(display.DisplayID).trim()
        : null;
    if (!id) continue;
    const label =
      typeof display.Label === 'string' && display.Label.trim() ? display.Label.trim() : null;
    const isConnected = display.IsConnected !== false && !display.Missing;
    const isMismatch = !!display.Mismatch;
    states.push({ key: id, name: label || 'Display', isConnected, isMismatch });
  }
  return states;
}

function recordClientDisplayHistorySamples(client, sampledAt = null) {
  const uuid = normalizeDummyUUID(client && client.UUID);
  if (!uuid) return;
  const states = extractCriticalDisplayStates(client);
  if (!states) return; // Not evaluable right now; leave an idle gap.

  const now =
    sampledAt != null && Number.isFinite(Number(sampledAt)) ? Number(sampledAt) : Date.now();
  const cutoff = now - MONITORING_HISTORY_MAX_AGE_MS;
  let perDisplay = ClientDisplayHistoryStore.get(uuid);
  if (!perDisplay) {
    perDisplay = new Map();
    ClientDisplayHistoryStore.set(uuid, perDisplay);
  }

  const seenKeys = new Set();
  for (const state of states) {
    seenKeys.add(state.key);
    const existing = perDisplay.get(state.key);
    const previousSamples = Array.isArray(existing && existing.Points) ? existing.Points : [];
    const sample = {
      ts: now,
      online: !!state.isConnected,
      degraded: !!state.isConnected && !!state.isMismatch,
      latencyMs: null,
    };
    const last = previousSamples.length ? previousSamples[previousSamples.length - 1] : null;
    let nextSamples;
    if (
      last &&
      now - last.ts < 900 &&
      last.online === sample.online &&
      last.degraded === sample.degraded
    ) {
      nextSamples = previousSamples.slice(0, -1).concat({ ...last, ts: now });
    } else {
      nextSamples = previousSamples.concat(sample);
    }
    while (nextSamples.length && nextSamples[0].ts < cutoff) nextSamples.shift();
    perDisplay.set(state.key, {
      Name: state.name || (existing && existing.Name) || state.key,
      Points: nextSamples,
    });
  }

  // Drop history for displays that are no longer marked critical so the modal
  // only shows currently-tracked displays.
  for (const key of Array.from(perDisplay.keys())) {
    if (!seenKeys.has(key)) perDisplay.delete(key);
  }
  if (!perDisplay.size) ClientDisplayHistoryStore.delete(uuid);
}

function syncClientDisplayHistoryStore(list) {
  const safeList = Array.isArray(list) ? list : [];
  const validUUIDs = new Set();
  for (const client of safeList) {
    const uuid = normalizeDummyUUID(client && client.UUID);
    if (!uuid) continue;
    validUUIDs.add(uuid);
    recordClientDisplayHistorySamples(client);
  }
  for (const uuid of Array.from(ClientDisplayHistoryStore.keys())) {
    if (!validUUIDs.has(uuid)) ClientDisplayHistoryStore.delete(uuid);
  }
}

function getClientDisplayHistorySamples(uuid) {
  const key = normalizeDummyUUID(uuid);
  if (!key) return [];
  const perDisplay = ClientDisplayHistoryStore.get(key);
  if (!perDisplay) return [];
  const now = Date.now();
  const cutoff = now - MONITORING_HISTORY_MAX_AGE_MS;
  const out = [];
  for (const [displayID, entry] of perDisplay.entries()) {
    const samples = (Array.isArray(entry.Points) ? entry.Points : []).filter(
      (s) => s && Number(s.ts) >= cutoff
    );
    out.push({ DisplayID: displayID, Name: entry.Name || displayID, samples });
  }
  return out;
}

module.exports = {
  MONITORING_HISTORY_MAX_AGE_MS,
  pruneMonitoringHistoryStore,
  recordEntityHistorySample,
  syncEntityHistoryStore,
  getEntityHistorySamples,
  recordMonitoringHistorySample,
  syncMonitoringHistoryStore,
  getMonitoringCheckHistory,
  recordDummyHistorySample,
  syncDummyHistoryStore,
  getDummyHistorySamples,
  recordClientHistorySample,
  syncClientHistoryStore,
  getClientHistorySamples,
  recordClientApplicationHistorySamples,
  syncClientApplicationHistoryStore,
  getClientApplicationHistorySamples,
  recordClientUSBHistorySamples,
  syncClientUSBHistoryStore,
  getClientUSBHistorySamples,
  recordClientDisplayHistorySamples,
  syncClientDisplayHistoryStore,
  getClientDisplayHistorySamples,
};
