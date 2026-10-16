// Monitoring history store (main process)
// Keeps rolling, in-memory time series for monitor targets and dummy clients
// so the renderer can draw recent uptime graphs. Samples older than MAX_AGE
// are pruned. The backing Maps are encapsulated here; callers interact only
// through exported helpers.
import { HISTORY_RETENTION_MS } from '../Modules/Config/constants';

const MONITORING_HISTORY_MAX_AGE_MS = HISTORY_RETENTION_MS;
// Readings closer together than this collapse into one: a burst of updates for
// the same event is a single observation.
const DUPLICATE_UPDATE_WINDOW_MS = 900;
// While nothing changes, keep at most one reading per this interval. A ShowTrak
// client heartbeats every second and every heartbeat re-records its status, so
// without this a healthy client stored ~43,000 identical readings over the 12h
// window. The timeline draws one-minute blocks and leaves a block with no
// reading grey, so a steady run still needs a reading in every block — this
// keeps four, while any change of state is still recorded the moment it lands.
const STEADY_STATE_SAMPLE_INTERVAL_MS = 15 * 1000;
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
  LastChecked?: unknown;
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
  Foreground?: unknown;
  Capabilities?: unknown;
}
interface ClientHardwareTelemetryLike {
  UUID?: unknown;
  Online?: unknown;
  Degraded?: unknown;
  RunningApplications?: RunningApplicationsLike | null;
  USBDeviceList?: unknown;
  DisplayList?: unknown;
  AudioDevices?: { Endpoints?: unknown } | null;
  NetworkStatus?: { Interfaces?: unknown } | null;
  SystemChecks?: unknown;
  ResourceAlarms?: unknown;
  PowerStatus?: unknown;
  Temperatures?: unknown;
  UptimeSeconds?: unknown;
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

// Whether `next` repeats what the series already says, so recording it would
// add nothing. Extends the newest reading in place when it does: a quick
// repeat is the same observation, and a steady run keeps its first reading
// fixed and drags its latest forward until the run is due another point.
function absorbRepeatSample(samples: HistorySample[], next: HistorySample): boolean {
  const last = samples.length ? samples[samples.length - 1]! : null;
  if (
    !last ||
    last.online !== next.online ||
    last.degraded !== next.degraded ||
    !(
      (last.latencyMs == null && next.latencyMs == null) ||
      Math.round(last.latencyMs || 0) === Math.round(next.latencyMs || 0)
    )
  ) {
    return false;
  }
  if (next.ts - last.ts < DUPLICATE_UPDATE_WINDOW_MS) {
    last.ts = next.ts;
    return true;
  }
  const previous = samples.length > 1 ? samples[samples.length - 2]! : null;
  if (
    previous &&
    previous.online === last.online &&
    previous.degraded === last.degraded &&
    next.ts - previous.ts < STEADY_STATE_SAMPLE_INTERVAL_MS
  ) {
    last.ts = next.ts;
    return true;
  }
  return false;
}

// Every named per-entity store (critical applications, USB, displays, audio,
// network), so the retention sweep can reach them too. Registered by the
// factory below.
const NamedHistoryStores: Array<Pick<NamedHistoryStore, 'prune'>> = [];

// Drop everything older than the 12h window from EVERY store — not only the
// series that happen to be recorded into. A client that goes offline stops
// recording, and its last readings would otherwise outlive the window for as
// long as the server runs. Called on read, on list sync, and by the periodic
// retention sweep (see ./history-retention).
function pruneMonitoringHistoryStore(now: number = Date.now()): void {
  const cutoff = now - MONITORING_HISTORY_MAX_AGE_MS;
  for (const named of NamedHistoryStores) named.prune(now);
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
  if (!absorbRepeatSample(samples, normalized)) samples.push(normalized);

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

// Every series in one store from `sinceTs` on, keyed by its entity id. Feeds the
// list view's history column, which draws a timeline for every row at once —
// one call for the lot rather than one per row.
function getEntityHistorySamplesSince(
  entityType: string,
  sinceTs: number
): Record<string, HistorySample[]> {
  pruneMonitoringHistoryStore();
  const store = getHistoryStore(entityType);
  const out: Record<string, HistorySample[]> = {};
  if (!store) return out;
  for (const [key, samples] of store.entries()) {
    const recent = samples.filter((s) => s && s.ts >= sinceTs);
    if (recent.length) out[String(key)] = recent.map((s) => ({ ...s }));
  }
  return out;
}

// The overall-status series for every client, dummy client and monitoring
// check. Checks rather than targets: a target's overall timeline is combined
// from its checks in the renderer, exactly as the view modal does it.
function getStatusHistoryOverviewSamples(sinceTs: number): {
  Clients: Record<string, HistorySample[]>;
  Dummies: Record<string, HistorySample[]>;
  Checks: Record<string, HistorySample[]>;
} {
  return {
    Clients: getEntityHistorySamplesSince(ENTITY_CLIENT, sinceTs),
    Dummies: getEntityHistorySamplesSince(ENTITY_DUMMY_CLIENT, sinceTs),
    Checks: getEntityHistorySamplesSince(ENTITY_MONITOR_TARGET, sinceTs),
  };
}

function recordMonitoringHistorySample(target: MonitoringTargetLike | null | undefined): void {
  if (!target || !target.TargetID) return;
  const checks = Array.isArray(target.Checks) ? target.Checks : [];
  for (const check of checks) {
    if (!check || check.CheckID == null) continue;
    // A check still inside its failure threshold on first contact has no
    // verdict; charting that gap as offline would draw an outage that never was.
    if (check.LastChecked == null) continue;
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
/** One entity's series as the renderer receives it, its id under `KeyField`. */
type NamedHistorySeries<KeyField extends string> = { [Field in KeyField]: string } & {
  Name: string;
  samples: HistorySample[];
};

interface NamedHistoryStore<KeyField extends string = string> {
  record(client: ClientHardwareTelemetryLike | null | undefined, sampledAt?: number | null): void;
  sync(list: unknown): void;
  get(uuid: unknown): Array<NamedHistorySeries<KeyField>>;
  prune(now?: number): void;
}

function createNamedHistoryStore<KeyField extends string>(
  extract: (client: ClientHardwareTelemetryLike | null | undefined) => NamedEntityState[] | null,
  outputKeyField: KeyField
): NamedHistoryStore<KeyField> {
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
      // Collapse a repeat of the same reading (see absorbRepeatSample). The
      // degraded comparison is a no-op for domains that never set it (USB /
      // applications), and correctly separates matched/mismatched display bars.
      // The newest point is copied before it can be extended: a series handed
      // out by get() shares its point objects, and must not move under a reader.
      const nextSamples = previousSamples.slice();
      if (nextSamples.length) {
        nextSamples[nextSamples.length - 1] = { ...nextSamples[nextSamples.length - 1]! };
      }
      if (!absorbRepeatSample(nextSamples, sample)) nextSamples.push(sample);
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

  function get(uuid: unknown): Array<NamedHistorySeries<KeyField>> {
    const key = normalizeDummyUUID(uuid);
    if (!key) return [];
    const perEntity = store.get(key);
    if (!perEntity) return [];
    const now = Date.now();
    const cutoff = now - MONITORING_HISTORY_MAX_AGE_MS;
    const out: Array<NamedHistorySeries<KeyField>> = [];
    for (const [entityKey, entry] of perEntity.entries()) {
      const samples = (Array.isArray(entry.Points) ? entry.Points : []).filter(
        (s: HistorySample) => s && Number(s.ts) >= cutoff
      );
      out.push({
        [outputKeyField]: entityKey,
        Name: entry.Name || entityKey,
        samples,
      } as NamedHistorySeries<KeyField>);
    }
    return out;
  }

  function prune(now: number = Date.now()): void {
    const cutoff = now - MONITORING_HISTORY_MAX_AGE_MS;
    for (const [uuid, perEntity] of Array.from(store.entries())) {
      for (const [entityKey, entry] of Array.from(perEntity.entries())) {
        const kept = (Array.isArray(entry.Points) ? entry.Points : []).filter(
          (s: HistorySample) => s && Number(s.ts) >= cutoff
        );
        if (kept.length) perEntity.set(entityKey, { Name: entry.Name, Points: kept });
        else perEntity.delete(entityKey);
      }
      if (!perEntity.size) store.delete(uuid);
    }
  }

  const named = { record, sync, get, prune };
  NamedHistoryStores.push(named);
  return named;
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
  const capabilities = (
    running.Capabilities && typeof running.Capabilities === 'object' ? running.Capabilities : {}
  ) as { Foreground?: unknown };
  // Only a named owner is evidence that the application lost focus (see
  // Client._isOutOfForeground).
  const focusKnown =
    capabilities.Foreground === true &&
    typeof running.Foreground === 'string' &&
    !!running.Foreground;
  const states: NamedEntityState[] = [];
  for (const item of items) {
    if (!item || !item.IsCritical) continue;
    const name = typeof item.Name === 'string' && item.Name.trim() ? item.Name.trim() : null;
    const key = typeof item.Key === 'string' && item.Key.trim() ? item.Key.trim() : name;
    if (!key) continue;
    const isRunning = item.IsRunning !== false;
    // Running but breaking a condition — hung, or not holding the foreground it
    // must — is "online but degraded" (orange), as for a USB device.
    const hung = item.RequireResponding !== false && item.Responding === false;
    const unfocused = item.RequireForeground === true && focusKnown && !item.IsForeground;
    states.push({
      key,
      name: name || key,
      online: isRunning,
      degraded: isRunning && (hung || unfocused),
    });
  }
  return states;
}

const ClientApplicationHistory = createNamedHistoryStore(extractCriticalApplicationStates, 'Key');

const recordClientApplicationHistorySamples = ClientApplicationHistory.record;
const syncClientApplicationHistoryStore = ClientApplicationHistory.sync;
const getClientApplicationHistorySamples = ClientApplicationHistory.get;

// Serial-less critical USB devices are guarded by name + quantity rather than a
// serial number, so their history is keyed by NameKey. This prefix keeps those
// synthetic keys from colliding with real serials in the shared USB store; the
// renderer (monitoring.ts) builds the same key to join the samples back in.
const CRITICAL_USB_NAME_HISTORY_PREFIX = 'usbname:';

// Resolve the current state for every critical USB device on a client. Returns
// null (skip this sample, leaving an idle gap) when the client is offline so we
// never paint "disconnected" red bars for a device whose real state we could not
// observe. Devices with a serial are tracked per serial; serial-less devices
// marked critical-by-name are tracked once per name. Missing (or, by name, short
// of the expected quantity) is "offline" (red); connected but breaking another
// condition — port, firmware, a device error — is "online but degraded"
// (orange). A device absent but allowed to be leaves a gap.
function extractCriticalUSBStates(
  client: ClientHardwareTelemetryLike | null | undefined
): NamedEntityState[] | null {
  if (!client || !client.Online) return null;
  const devices = Array.isArray(client.USBDeviceList) ? client.USBDeviceList : [];
  const states: NamedEntityState[] = [];
  const byNameKey = new Map<string, NamedEntityState>();
  for (const device of devices) {
    if (!device || !device.IsCritical) continue;
    const manufacturer =
      typeof device.ManufacturerName === 'string' ? device.ManufacturerName.trim() : '';
    const product = typeof device.ProductName === 'string' ? device.ProductName.trim() : '';
    const name = [manufacturer, product].filter(Boolean).join(' ') || 'USB Device';
    const issues: Array<{ Kind?: unknown }> = Array.isArray(device.Issues) ? device.Issues : [];
    const missingIssue = issues.some((issue) => issue && issue.Kind === 'missing');
    const otherIssue = issues.some((issue) => issue && issue.Kind !== 'missing');
    const isConnected = device.IsConnected !== false;
    const serial =
      device.SerialNumber != null && String(device.SerialNumber).trim()
        ? String(device.SerialNumber).trim()
        : null;
    if (serial) {
      if (!isConnected && !device.Missing) continue;
      const online = isConnected && !device.Missing;
      states.push({ key: serial, name, online, degraded: online && otherIssue });
      continue;
    }
    // Serial-less, name-guarded: one series per distinct name, folding every
    // card of the name together. "Online" only when the expected quantity is met.
    if (!device.IsCriticalByName) continue;
    const nameKey =
      typeof device.NameKey === 'string' && device.NameKey.trim()
        ? device.NameKey.trim().toLowerCase()
        : '';
    if (!nameKey) continue;
    // Short of its quantity, unless its presence is not required.
    const presenceRequired =
      !device.Critical ||
      (device.Critical as { RequirePresent?: unknown }).RequirePresent !== false;
    const short = missingIssue || !!device.Missing || (!!device.Shortfall && presenceRequired);
    if (!isConnected && !short) continue;
    const existing = byNameKey.get(nameKey);
    if (existing) {
      existing.online = existing.online && !short;
      existing.degraded = existing.online && (existing.degraded || otherIssue);
      continue;
    }
    const state: NamedEntityState = {
      key: `${CRITICAL_USB_NAME_HISTORY_PREFIX}${nameKey}`,
      name,
      online: !short,
      degraded: !short && otherIssue,
    };
    byNameKey.set(nameKey, state);
    states.push(state);
  }
  return states;
}

const ClientUSBHistory = createNamedHistoryStore(extractCriticalUSBStates, 'Serial');

const recordClientUSBHistorySamples = ClientUSBHistory.record;
const syncClientUSBHistoryStore = ClientUSBHistory.sync;
const getClientUSBHistorySamples = ClientUSBHistory.get;

// Resolve the current state for every critical display on a client. Returns
// null (skip this sample, leaving an idle gap) when the client is offline so we
// never paint "missing" red bars for a display whose real state we could not
// observe. A connected display meeting its conditions is "online" (green); a
// connected one breaking any is "online but degraded" (orange); a missing one is
// "offline" (red). One that is absent but allowed to be, or not reported yet,
// leaves a gap. Keyed by the critical entry's id, which stays put when the
// display is recognised under another tier of identity.
function extractCriticalDisplayStates(
  client: ClientHardwareTelemetryLike | null | undefined
): NamedEntityState[] | null {
  if (!client || !client.Online) return null;
  const displays = Array.isArray(client.DisplayList) ? client.DisplayList : [];
  const states: NamedEntityState[] = [];
  for (const display of displays) {
    if (!display || !display.IsCritical) continue;
    const critical =
      display.Critical && typeof display.Critical === 'object'
        ? (display.Critical as { DisplayID?: unknown })
        : null;
    const rawID = critical && critical.DisplayID != null ? critical.DisplayID : display.DisplayID;
    const id = rawID != null && String(rawID).trim() ? String(rawID).trim() : null;
    if (!id) continue;
    const label =
      typeof display.Label === 'string' && display.Label.trim() ? display.Label.trim() : null;
    const isConnected = display.IsConnected !== false && !display.Missing;
    if (!isConnected && !display.Missing) continue;
    const issues = Array.isArray(display.Issues) ? display.Issues : [];
    states.push({
      key: id,
      name: label || 'Display',
      online: isConnected,
      degraded: isConnected && (issues.length > 0 || !!display.Mismatch),
    });
  }
  return states;
}

const ClientDisplayHistory = createNamedHistoryStore(extractCriticalDisplayStates, 'DisplayID');

const recordClientDisplayHistorySamples = ClientDisplayHistory.record;
const syncClientDisplayHistoryStore = ClientDisplayHistory.sync;
const getClientDisplayHistorySamples = ClientDisplayHistory.get;

// Resolve the current state for every critical audio endpoint on a client.
// Null (an idle gap) while the client is offline, for the reason the display
// extractor gives. Connected and healthy is "online"; connected but breaking one
// of its conditions (not default, muted, wrong format, level out of range) is
// "online but degraded"; not reported at all is "offline". An endpoint whose
// state is not yet judged (no trusted sample this connection) is skipped rather
// than painted, so a reconnect never draws a false red bar.
function extractCriticalAudioStates(
  client: ClientHardwareTelemetryLike | null | undefined
): NamedEntityState[] | null {
  if (!client || !client.Online) return null;
  const endpoints = Array.isArray(client.AudioDevices?.Endpoints)
    ? (client.AudioDevices.Endpoints as Array<Record<string, unknown> | null>)
    : [];
  const states: NamedEntityState[] = [];
  for (const endpoint of endpoints) {
    if (!endpoint || !endpoint.IsCritical) continue;
    const id = typeof endpoint.EndpointID === 'string' ? endpoint.EndpointID.trim() : '';
    if (!id) continue;
    const isConnected = endpoint.IsConnected !== false;
    if (!isConnected && !endpoint.Missing) continue;
    const name =
      typeof endpoint.Name === 'string' && endpoint.Name.trim()
        ? endpoint.Name.trim()
        : 'Audio Device';
    const issues = Array.isArray(endpoint.Issues) ? endpoint.Issues : [];
    states.push({
      key: id,
      name,
      online: isConnected,
      degraded: isConnected && issues.length > 0,
    });
  }
  return states;
}

const ClientAudioHistory = createNamedHistoryStore(extractCriticalAudioStates, 'EndpointID');

const recordClientAudioHistorySamples = ClientAudioHistory.record;
const syncClientAudioHistoryStore = ClientAudioHistory.sync;
const getClientAudioHistorySamples = ClientAudioHistory.get;

// Resolve the current state for every critical network interface on a client,
// on the audio extractor's rules: connected and meeting its conditions is
// "online", connected but not is "online but degraded", missing is "offline".
// An interface that is absent but allowed to be (presence not required), or not
// yet judged on this connection, is skipped — an idle gap, never a red bar.
function extractCriticalNetworkStates(
  client: ClientHardwareTelemetryLike | null | undefined
): NamedEntityState[] | null {
  if (!client || !client.Online) return null;
  const interfaces = Array.isArray(client.NetworkStatus?.Interfaces)
    ? (client.NetworkStatus.Interfaces as Array<Record<string, unknown> | null>)
    : [];
  const states: NamedEntityState[] = [];
  for (const iface of interfaces) {
    if (!iface || !iface.IsCritical) continue;
    const name = typeof iface.Name === 'string' ? iface.Name.trim() : '';
    if (!name) continue;
    const isConnected = iface.IsConnected !== false;
    if (!isConnected && !iface.Missing) continue;
    const issues = Array.isArray(iface.Issues) ? iface.Issues : [];
    states.push({
      key: name,
      name,
      online: isConnected,
      degraded: isConnected && issues.length > 0,
    });
  }
  return states;
}

const ClientNetworkHistory = createNamedHistoryStore(extractCriticalNetworkStates, 'InterfaceName');

const recordClientNetworkHistorySamples = ClientNetworkHistory.record;
const syncClientNetworkHistoryStore = ClientNetworkHistory.sync;
const getClientNetworkHistorySamples = ClientNetworkHistory.get;

// Resolve each monitored system check (CPU, memory, uptime, power, thermal) to
// healthy or failing. A check with nothing to judge — the client offline, or a
// power/thermal collector that has not reported or cannot — leaves a gap, so a
// machine without the hardware never paints a verdict.
const SYSTEM_CHECKS: Array<{ key: string; field: string; name: string }> = [
  { key: 'cpu', field: 'Cpu', name: 'CPU' },
  { key: 'ram', field: 'Ram', name: 'Memory' },
  { key: 'uptime', field: 'Uptime', name: 'Uptime' },
  { key: 'power', field: 'Power', name: 'Power' },
  { key: 'thermal', field: 'Thermal', name: 'Thermal' },
];
const ALARM_CHECK: Record<string, string> = {
  cpu: 'cpu',
  ram: 'ram',
  uptime: 'uptime',
  power: 'power',
  battery: 'power',
  charging: 'power',
  temperature: 'thermal',
  thermal: 'thermal',
};

function collectorReporting(snapshot: unknown): boolean {
  const status =
    snapshot && typeof snapshot === 'object'
      ? (snapshot as { Status?: { State?: unknown } }).Status
      : null;
  return !!status && status.State === 'ok';
}

function extractSystemCheckStates(
  client: ClientHardwareTelemetryLike | null | undefined
): NamedEntityState[] | null {
  if (!client || !client.Online) return null;
  const checks = (
    client.SystemChecks && typeof client.SystemChecks === 'object' ? client.SystemChecks : {}
  ) as Record<string, unknown>;
  const failing = new Set<string>();
  for (const alarm of Array.isArray(client.ResourceAlarms) ? client.ResourceAlarms : []) {
    const check = alarm && ALARM_CHECK[String((alarm as { Key?: unknown }).Key)];
    if (check) failing.add(check);
  }
  const states: NamedEntityState[] = [];
  for (const check of SYSTEM_CHECKS) {
    if (!checks[check.field]) continue;
    if (check.key === 'power' && !collectorReporting(client.PowerStatus)) continue;
    if (check.key === 'thermal' && !collectorReporting(client.Temperatures)) continue;
    if (check.key === 'uptime' && typeof client.UptimeSeconds !== 'number') continue;
    states.push({
      key: check.key,
      name: check.name,
      online: true,
      degraded: failing.has(check.key),
    });
  }
  return states;
}

const ClientSystemCheckHistory = createNamedHistoryStore(extractSystemCheckStates, 'CheckKey');

const recordClientSystemCheckHistorySamples = ClientSystemCheckHistory.record;
const syncClientSystemCheckHistoryStore = ClientSystemCheckHistory.sync;
const getClientSystemCheckHistorySamples = ClientSystemCheckHistory.get;

export {
  recordClientSystemCheckHistorySamples,
  syncClientSystemCheckHistoryStore,
  getClientSystemCheckHistorySamples,
  MONITORING_HISTORY_MAX_AGE_MS,
  pruneMonitoringHistoryStore,
  recordEntityHistorySample,
  syncEntityHistoryStore,
  getEntityHistorySamples,
  getStatusHistoryOverviewSamples,
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
  recordClientAudioHistorySamples,
  syncClientAudioHistoryStore,
  getClientAudioHistorySamples,
  recordClientNetworkHistorySamples,
  syncClientNetworkHistoryStore,
  getClientNetworkHistorySamples,
};
