// Monitoring history store (main process)
// Keeps rolling, in-memory time series for monitor targets and dummy clients
// so the renderer can draw recent uptime graphs. Samples older than MAX_AGE
// are pruned. The backing Maps are encapsulated here; callers interact only
// through exported helpers.
const MONITORING_HISTORY_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const ENTITY_MONITOR_TARGET = 'monitor-target';
const ENTITY_DUMMY_CLIENT = 'dummy-client';
const ENTITY_CLIENT = 'client';

// ---- Types ---------------------------------------------------------------

// A single stored status sample. `latencyMs` is null for entities (dummy/real
// clients, applications, USB devices, displays) that report no latency.
interface HistorySample {
  ts: number;
  online: boolean;
  degraded: boolean;
  latencyMs: number | null;
}

// The loose `{ online, degraded, latencyMs }` shape callers hand in before it is
// normalized into a HistorySample; fields are validated/coerced at record time.
interface HistorySampleInput {
  online?: unknown;
  degraded?: unknown;
  latencyMs?: unknown;
}

// Store keys are numeric TargetIDs for monitor-target checks and UUID strings
// for dummy/real clients.
type EntityHistoryKey = string | number;
type EntityHistoryStore = Map<EntityHistoryKey, HistorySample[]>;

// Loose monitor-target/check shapes consumed by the monitoring history helpers.
interface MonitoringCheckLike {
  CheckID?: unknown;
  Online?: unknown;
  Degraded?: unknown;
  LastLatencyMs?: unknown;
}
interface MonitoringTargetLike {
  TargetID?: unknown;
  Checks?: unknown;
}

// Loose dummy/real client status shape (online/degraded timelines).
interface StatusEntityLike {
  UUID?: unknown;
  Online?: unknown;
  Degraded?: unknown;
}

// Named per-entity timeline entry shared by the per-application / per-USB /
// per-display history stores (the shape is identical across all three).
interface NamedHistoryEntry {
  Name: string;
  Points: HistorySample[];
}

// Loose client telemetry shape read by the critical-entity extractors.
interface RunningApplicationsLike {
  Status?: unknown;
  Items?: unknown;
}
interface ClientHardwareTelemetryLike {
  UUID?: unknown;
  Online?: unknown;
  Degraded?: unknown;
  RunningApplications?: RunningApplicationsLike | null;
  USBDeviceList?: unknown;
  DisplayList?: unknown;
}

// Resolved critical-entity state produced by the per-domain extractors below and
// consumed by the shared NamedHistoryStore: an online/degraded reading for one
// named entity (application, USB device, or display) at sample time.
interface NamedEntityState {
  key: string;
  name: string;
  online: boolean;
  degraded: boolean;
}

const MonitoringHistoryStores: Record<string, EntityHistoryStore> = Object.freeze({
  [ENTITY_MONITOR_TARGET]: new Map<EntityHistoryKey, HistorySample[]>(),
  [ENTITY_DUMMY_CLIENT]: new Map<EntityHistoryKey, HistorySample[]>(),
  [ENTITY_CLIENT]: new Map<EntityHistoryKey, HistorySample[]>(),
});

function getHistoryStore(entityType: string): EntityHistoryStore | null {
  return MonitoringHistoryStores[entityType] || null;
}

function normalizeMonitorTargetID(targetID: unknown): number | null {
  const n = Number(targetID);
  return Number.isFinite(n) ? n : null;
}

function normalizeDummyUUID(uuid: unknown): string | null {
  const trimmed = typeof uuid === 'string' ? uuid.trim() : '';
  return trimmed || null;
}

function resolveEntityKey(entityType: string, id: unknown): EntityHistoryKey | null {
  if (entityType === ENTITY_MONITOR_TARGET) return normalizeMonitorTargetID(id);
  if (entityType === ENTITY_DUMMY_CLIENT) return normalizeDummyUUID(id);
  if (entityType === ENTITY_CLIENT) return normalizeDummyUUID(id);
  return null;
}

function normalizeLatency(latencyMs: unknown): number | null {
  // null and '' both coerce to a finite 0, so without this guard they would be
  // stored as "answered in 0ms" rather than "no timing". That is not academic:
  // a check sets LastLatencyMs to null on EVERY failure, so every offline
  // sample would record a zero, and the timeline averages latency per block —
  // dragging the mean toward zero for any block containing an outage, which is
  // precisely the block an operator inspects.
  if (latencyMs == null || latencyMs === '') return null;
  const parsed = Number(latencyMs);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function pruneMonitoringHistoryStore(now: number = Date.now()): void {
  const cutoff = now - MONITORING_HISTORY_MAX_AGE_MS;
  for (const store of Object.values(MonitoringHistoryStores)) {
    for (const [key, samples] of store.entries()) {
      const next = Array.isArray(samples)
        ? samples.filter((s: HistorySample) => s && s.ts >= cutoff)
        : [];
      if (!next.length) {
        store.delete(key);
        continue;
      }
      store.set(key, next);
    }
  }
}

function recordEntityHistorySample(
  entityType: string,
  id: unknown,
  sample: HistorySampleInput | null | undefined
): void {
  const store = getHistoryStore(entityType);
  if (!store || !sample) return;
  const key = resolveEntityKey(entityType, id);
  if (key == null) return;

  const now = Date.now();
  const normalized: HistorySample = {
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
    last!.ts = now;
  } else {
    samples.push(normalized);
  }

  const cutoff = now - MONITORING_HISTORY_MAX_AGE_MS;
  while (samples.length && samples[0]!.ts < cutoff) samples.shift();

  store.set(key, samples);
}

function syncEntityHistoryStore<T>(
  entityType: string,
  list: unknown,
  keyResolver: (item: T) => unknown,
  sampleResolver: (item: T) => HistorySampleInput
): void {
  const store = getHistoryStore(entityType);
  if (!store || typeof keyResolver !== 'function' || typeof sampleResolver !== 'function') return;

  const safeList: T[] = Array.isArray(list) ? list : [];
  const validKeys = new Set<EntityHistoryKey>();

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

function getEntityHistorySamples(entityType: string, id: unknown): HistorySample[] {
  pruneMonitoringHistoryStore();
  const store = getHistoryStore(entityType);
  if (!store) return [];
  const key = resolveEntityKey(entityType, id);
  if (key == null) return [];
  return store.get(key) || [];
}

function recordMonitoringHistorySample(target: MonitoringTargetLike | null | undefined): void {
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

function syncMonitoringHistoryStore(list: unknown): void {
  // Flatten every target's checks into a single per-check sample list so the
  // shared sync helper can prune history for checks that no longer exist.
  const checks: MonitoringCheckLike[] = [];
  for (const target of Array.isArray(list) ? list : []) {
    for (const check of Array.isArray(target && target.Checks) ? target.Checks : []) {
      if (check && check.CheckID != null) checks.push(check);
    }
  }
  syncEntityHistoryStore(
    ENTITY_MONITOR_TARGET,
    checks,
    (check: MonitoringCheckLike) => check && check.CheckID,
    (check: MonitoringCheckLike) => ({
      online: !!(check && check.Online),
      degraded: !!(check && check.Degraded),
      latencyMs: check && check.LastLatencyMs,
    })
  );
}

function getMonitoringCheckHistory(checkID: unknown): HistorySample[] {
  return getEntityHistorySamples(ENTITY_MONITOR_TARGET, checkID);
}

function recordDummyHistorySample(dummy: StatusEntityLike | null | undefined): void {
  if (!dummy || !dummy.UUID) return;
  recordEntityHistorySample(ENTITY_DUMMY_CLIENT, dummy.UUID, {
    online: !!dummy.Online,
    degraded: !!dummy.Degraded,
    latencyMs: null,
  });
}

function syncDummyHistoryStore(list: unknown): void {
  syncEntityHistoryStore(
    ENTITY_DUMMY_CLIENT,
    list,
    (dummy: StatusEntityLike) => dummy && dummy.UUID,
    (dummy: StatusEntityLike) => ({
      online: !!(dummy && dummy.Online),
      degraded: !!(dummy && dummy.Degraded),
      latencyMs: null,
    })
  );
}

function getDummyHistorySamples(uuid: unknown): HistorySample[] {
  return getEntityHistorySamples(ENTITY_DUMMY_CLIENT, uuid);
}

// Real ShowTrak clients record online/degraded status history so the client
// info modal can render the same status timeline as monitoring targets and
// dummy clients. Integrated SDK clients are included too (they report an
// online/degraded state), only their extra hardware panes are hidden in the UI.
function recordClientHistorySample(client: StatusEntityLike | null | undefined): void {
  if (!client || !client.UUID) return;
  recordEntityHistorySample(ENTITY_CLIENT, client.UUID, {
    online: !!client.Online,
    degraded: !!client.Degraded,
    latencyMs: null,
  });
}

function syncClientHistoryStore(list: unknown): void {
  syncEntityHistoryStore(
    ENTITY_CLIENT,
    list,
    (client: StatusEntityLike) => client && client.UUID,
    (client: StatusEntityLike) => ({
      online: !!(client && client.Online),
      degraded: !!(client && client.Degraded),
      latencyMs: null,
    })
  );
}

function getClientHistorySamples(uuid: unknown): HistorySample[] {
  return getEntityHistorySamples(ENTITY_CLIENT, uuid);
}

// Per-critical-entity status history for real ShowTrak clients. Each critical
// application / USB device / display gets its own online / offline timeline so
// the client info modal can render them the same way monitoring targets render
// individual checks. This data is RAM-only (never persisted to the DB or show
// file) and is sampled on a fixed cadence that mirrors the ShowTrakClient
// telemetry poll interval (20s).
//
// Store shape: Map<UUID, Map<entityKey, { Name, Points: [] }>>. The three
// domains differ only in how the current state is extracted from client
// telemetry and which stable identifier field the getter emits, so a single
// factory drives all three.
interface NamedHistoryStore {
  record(client: ClientHardwareTelemetryLike | null | undefined, sampledAt?: number | null): void;
  sync(list: unknown): void;
  get(uuid: unknown): Array<Record<string, string | HistorySample[]>>;
}

function createNamedHistoryStore(
  extract: (client: ClientHardwareTelemetryLike | null | undefined) => NamedEntityState[] | null,
  outputKeyField: string
): NamedHistoryStore {
  const store = new Map<string, Map<string, NamedHistoryEntry>>();

  function record(
    client: ClientHardwareTelemetryLike | null | undefined,
    sampledAt: number | null = null
  ): void {
    const uuid = normalizeDummyUUID(client && client.UUID);
    if (!uuid) return;
    const states = extract(client);
    if (!states) return; // Not evaluable right now; leave an idle gap.

    const now =
      sampledAt != null && Number.isFinite(Number(sampledAt)) ? Number(sampledAt) : Date.now();
    const cutoff = now - MONITORING_HISTORY_MAX_AGE_MS;
    let perEntity = store.get(uuid);
    if (!perEntity) {
      perEntity = new Map<string, NamedHistoryEntry>();
      store.set(uuid, perEntity);
    }

    const seenKeys = new Set<string>();
    for (const state of states) {
      seenKeys.add(state.key);
      const existing = perEntity.get(state.key);
      const previousSamples = Array.isArray(existing && existing.Points) ? existing!.Points : [];
      const sample: HistorySample = {
        ts: now,
        online: !!state.online,
        degraded: !!state.degraded,
        latencyMs: null,
      };
      const last = previousSamples.length ? previousSamples[previousSamples.length - 1] : null;
      // Collapse a rapid repeat of the same reading into the latest timestamp.
      // The degraded comparison is a no-op for domains that never set it (USB /
      // applications), and correctly separates matched/mismatched display bars.
      let nextSamples: HistorySample[];
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
      while (nextSamples.length && nextSamples[0]!.ts < cutoff) nextSamples.shift();
      perEntity.set(state.key, {
        Name: state.name || (existing && existing.Name) || state.key,
        Points: nextSamples,
      });
    }

    // Drop history for entities that are no longer marked critical so the modal
    // only shows currently-tracked entities.
    for (const key of Array.from(perEntity.keys())) {
      if (!seenKeys.has(key)) perEntity.delete(key);
    }
    if (!perEntity.size) store.delete(uuid);
  }

  function sync(list: unknown): void {
    const safeList = Array.isArray(list) ? list : [];
    const validUUIDs = new Set<string>();
    for (const client of safeList) {
      const uuid = normalizeDummyUUID(client && client.UUID);
      if (!uuid) continue;
      validUUIDs.add(uuid);
      record(client);
    }
    for (const uuid of Array.from(store.keys())) {
      if (!validUUIDs.has(uuid)) store.delete(uuid);
    }
  }

  function get(uuid: unknown): Array<Record<string, string | HistorySample[]>> {
    const key = normalizeDummyUUID(uuid);
    if (!key) return [];
    const perEntity = store.get(key);
    if (!perEntity) return [];
    const now = Date.now();
    const cutoff = now - MONITORING_HISTORY_MAX_AGE_MS;
    const out: Array<Record<string, string | HistorySample[]>> = [];
    for (const [entityKey, entry] of perEntity.entries()) {
      const samples = (Array.isArray(entry.Points) ? entry.Points : []).filter(
        (s: HistorySample) => s && Number(s.ts) >= cutoff
      );
      out.push({ [outputKeyField]: entityKey, Name: entry.Name || entityKey, samples });
    }
    return out;
  }

  return { record, sync, get };
}

// Resolve the current running/not-running state for every critical application
// on a client, but only when the state can be trusted. Returns null (skip this
// sample, leaving an idle gap) when the client is offline or its application
// monitoring status is not 'ok' (e.g. permission denied / error / unknown) so
// we never paint "not running" red bars for data we could not actually read.
function extractCriticalApplicationStates(
  client: ClientHardwareTelemetryLike | null | undefined
): NamedEntityState[] | null {
  if (!client || !client.Online) return null;
  const running =
    client.RunningApplications && typeof client.RunningApplications === 'object'
      ? client.RunningApplications
      : null;
  if (!running) return null;
  const status = (running.Status && typeof running.Status === 'object' ? running.Status : {}) as {
    State?: unknown;
  };
  const state = String(status.State || 'unknown').toLowerCase();
  if (state !== 'ok') return null;
  const items = Array.isArray(running.Items) ? running.Items : [];
  const states: NamedEntityState[] = [];
  for (const item of items) {
    if (!item || !item.IsCritical) continue;
    const name = typeof item.Name === 'string' && item.Name.trim() ? item.Name.trim() : null;
    const key = typeof item.Key === 'string' && item.Key.trim() ? item.Key.trim() : name;
    if (!key) continue;
    states.push({ key, name: name || key, online: item.IsRunning !== false, degraded: false });
  }
  return states;
}

const ClientApplicationHistory = createNamedHistoryStore(extractCriticalApplicationStates, 'Key');

function recordClientApplicationHistorySamples(
  client: ClientHardwareTelemetryLike | null | undefined,
  sampledAt: number | null = null
): void {
  ClientApplicationHistory.record(client, sampledAt);
}

function syncClientApplicationHistoryStore(list: unknown): void {
  ClientApplicationHistory.sync(list);
}

function getClientApplicationHistorySamples(
  uuid: unknown
): Array<{ Key: string; Name: string; samples: HistorySample[] }> {
  return ClientApplicationHistory.get(uuid) as Array<{
    Key: string;
    Name: string;
    samples: HistorySample[];
  }>;
}

// Serial-less critical USB devices are guarded by name + quantity rather than a
// serial number, so their history is keyed by NameKey. This prefix keeps those
// synthetic keys from colliding with real serials in the shared USB store; the
// renderer (monitoring.ts) builds the same key to join the samples back in.
const CRITICAL_USB_NAME_HISTORY_PREFIX = 'usbname:';

// Resolve the current connected/disconnected state for every critical USB
// device on a client. Returns null (skip this sample, leaving an idle gap) when
// the client is offline so we never paint "disconnected" red bars for a device
// whose real state we could not observe. Devices with a serial are tracked per
// serial; serial-less devices marked critical-by-name are tracked once per name
// (the expected quantity being satisfied is what counts as "connected").
function extractCriticalUSBStates(
  client: ClientHardwareTelemetryLike | null | undefined
): NamedEntityState[] | null {
  if (!client || !client.Online) return null;
  const devices = Array.isArray(client.USBDeviceList) ? client.USBDeviceList : [];
  const states: NamedEntityState[] = [];
  const seenNameKeys = new Set<string>();
  for (const device of devices) {
    if (!device || !device.IsCritical) continue;
    const manufacturer =
      typeof device.ManufacturerName === 'string' ? device.ManufacturerName.trim() : '';
    const product = typeof device.ProductName === 'string' ? device.ProductName.trim() : '';
    const name = [manufacturer, product].filter(Boolean).join(' ') || 'USB Device';
    const serial =
      device.SerialNumber != null && String(device.SerialNumber).trim()
        ? String(device.SerialNumber).trim()
        : null;
    if (serial) {
      const isConnected = device.IsConnected !== false && !device.Missing;
      states.push({ key: serial, name, online: isConnected, degraded: false });
      continue;
    }
    // Serial-less, name-guarded: one series per distinct name. "Online" only
    // when the expected quantity is met (not short, not fully missing).
    if (!device.IsCriticalByName) continue;
    const nameKey =
      typeof device.NameKey === 'string' && device.NameKey.trim()
        ? device.NameKey.trim().toLowerCase()
        : '';
    if (!nameKey || seenNameKeys.has(nameKey)) continue;
    seenNameKeys.add(nameKey);
    const satisfied = device.IsConnected !== false && !device.Missing && !device.Shortfall;
    states.push({
      key: `${CRITICAL_USB_NAME_HISTORY_PREFIX}${nameKey}`,
      name,
      online: satisfied,
      degraded: false,
    });
  }
  return states;
}

const ClientUSBHistory = createNamedHistoryStore(extractCriticalUSBStates, 'Serial');

function recordClientUSBHistorySamples(
  client: ClientHardwareTelemetryLike | null | undefined,
  sampledAt: number | null = null
): void {
  ClientUSBHistory.record(client, sampledAt);
}

function syncClientUSBHistoryStore(list: unknown): void {
  ClientUSBHistory.sync(list);
}

function getClientUSBHistorySamples(
  uuid: unknown
): Array<{ Serial: string; Name: string; samples: HistorySample[] }> {
  return ClientUSBHistory.get(uuid) as Array<{
    Serial: string;
    Name: string;
    samples: HistorySample[];
  }>;
}

// Resolve the current state for every critical display on a client. Returns
// null (skip this sample, leaving an idle gap) when the client is offline so we
// never paint "missing" red bars for a display whose real state we could not
// observe. A connected display whose resolution/refresh matches its captured
// baseline is "online" (green); a connected-but-changed display is "online but
// degraded" (orange); a missing display is "offline" (red).
function extractCriticalDisplayStates(
  client: ClientHardwareTelemetryLike | null | undefined
): NamedEntityState[] | null {
  if (!client || !client.Online) return null;
  const displays = Array.isArray(client.DisplayList) ? client.DisplayList : [];
  const states: NamedEntityState[] = [];
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
    states.push({
      key: id,
      name: label || 'Display',
      online: isConnected,
      degraded: isConnected && isMismatch,
    });
  }
  return states;
}

const ClientDisplayHistory = createNamedHistoryStore(extractCriticalDisplayStates, 'DisplayID');

function recordClientDisplayHistorySamples(
  client: ClientHardwareTelemetryLike | null | undefined,
  sampledAt: number | null = null
): void {
  ClientDisplayHistory.record(client, sampledAt);
}

function syncClientDisplayHistoryStore(list: unknown): void {
  ClientDisplayHistory.sync(list);
}

function getClientDisplayHistorySamples(
  uuid: unknown
): Array<{ DisplayID: string; Name: string; samples: HistorySample[] }> {
  return ClientDisplayHistory.get(uuid) as Array<{
    DisplayID: string;
    Name: string;
    samples: HistorySample[];
  }>;
}

export {
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
