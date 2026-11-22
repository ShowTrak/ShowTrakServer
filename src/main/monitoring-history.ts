// Monitoring history store (main process)
// Keeps rolling, in-memory time series for monitor targets and dummy clients
// so the renderer can draw recent uptime graphs. Samples older than MAX_AGE
// are pruned. The backing Maps are encapsulated here; callers interact only
// through exported helpers.
import { HISTORY_RETENTION_MS } from '../Modules/Config/constants';
import { IsArray, IsObject } from '../Modules/Utils/guards';

const MONITORING_HISTORY_MAX_AGE_MS = HISTORY_RETENTION_MS;
// Readings closer together than this collapse into one: a burst of updates for
// the same event is a single observation.
const DUPLICATE_UPDATE_WINDOW_MS = 900;
// While nothing changes, keep at most one reading per this interval. A ShowTrak
// client heartbeats every second and every heartbeat re-records its status, so
// without this a healthy client stored ~43,000 identical readings over the 12h
// window. The timeline draws one-minute blocks and leaves a block with no
// reading grey, so a steady run still needs a reading in every block; this
// keeps four, while any change of state is still recorded the moment it lands.
const STEADY_STATE_SAMPLE_INTERVAL_MS = 15 * 1000;
// A latency reading only starts a new point when it moves away from the newest
// point's running mean by more than this many ms AND this fraction of it. Below
// that it is jitter: it is averaged into the newest point instead. Recording a
// point for every probe whose latency merely rounded differently grew a
// jittering check by one point per probe (~890 points an hour for a 3 s check,
// ~300 MB of heap for 300 checks over the 12 h window), when the timeline draws
// one-minute blocks that average latency anyway.
const LATENCY_CHANGE_MIN_MS = 5;
const LATENCY_CHANGE_FRACTION = 0.25;
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

// One entity's series. Points are in recording order, which is time order, so
// reads and the retention sweep can binary-search the window instead of walking
// 12 h of points. `LastCount` is how many readings the newest point stands for,
// so a folded-in latency can keep a running mean (see absorbRepeatSample). Only
// the newest point is ever changed in place.
interface HistorySeries {
  Points: HistorySample[];
  LastCount: number;
}

type EntityHistoryStore = Map<EntityHistoryKey, HistorySeries>;

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
interface NamedHistoryEntry extends HistorySeries {
  Name: string;
  // The record() call that last reported this entity (see record()).
  Stamp: number;
}

// Loose client telemetry shape read by the critical-entity extractors. Every
// field is narrowed where it is read.
interface ClientHardwareTelemetryLike {
  UUID?: unknown;
  Online?: unknown;
  Degraded?: unknown;
  RunningApplications?: unknown;
  USBDeviceList?: unknown;
  DisplayList?: unknown;
  AudioDevices?: unknown;
  NetworkStatus?: unknown;
  StorageStatus?: unknown;
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
  [ENTITY_MONITOR_TARGET]: new Map<EntityHistoryKey, HistorySeries>(),
  [ENTITY_DUMMY_CLIENT]: new Map<EntityHistoryKey, HistorySeries>(),
  [ENTITY_CLIENT]: new Map<EntityHistoryKey, HistorySeries>(),
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
  // sample would record a zero, and the timeline averages latency per block,
  // dragging the mean toward zero for any block containing an outage, which is
  // precisely the block an operator inspects.
  if (latencyMs == null || latencyMs === '') return null;
  const parsed = Number(latencyMs);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

// Whether two latency readings say the same thing: both absent, or both present
// and within jitter of each other (see LATENCY_CHANGE_MIN_MS). `reference` is the
// newest point's running mean.
function sameLatency(reference: number | null, next: number | null): boolean {
  if (reference == null || next == null) return reference == null && next == null;
  return (
    Math.abs(next - reference) <=
    Math.max(LATENCY_CHANGE_MIN_MS, LATENCY_CHANGE_FRACTION * Math.abs(reference))
  );
}

// Whether `next` repeats what the series already says, so recording it would
// add nothing. Extends the newest reading in place when it does: a quick
// repeat is the same observation, and a steady run keeps its first reading
// fixed and drags its latest forward until the run is due another point. A
// latency that only jitters is averaged into the point it is folded into, so
// each point's latency is the mean of the readings it stands for, which is
// what the timeline's per-minute average then sees.
//
// A change of state (online, degraded, a latency reading gained or lost) always
// appends, however quickly it lands, as does a latency that really moved.
function absorbRepeatSample(series: HistorySeries, next: HistorySample): boolean {
  const samples = series.Points;
  const last = samples.length ? samples[samples.length - 1]! : null;
  if (
    !last ||
    last.online !== next.online ||
    last.degraded !== next.degraded ||
    !sameLatency(last.latencyMs, next.latencyMs)
  ) {
    return false;
  }
  if (next.ts - last.ts >= DUPLICATE_UPDATE_WINDOW_MS) {
    const previous = samples.length > 1 ? samples[samples.length - 2]! : null;
    if (
      !previous ||
      previous.online !== last.online ||
      previous.degraded !== last.degraded ||
      next.ts - previous.ts >= STEADY_STATE_SAMPLE_INTERVAL_MS
    ) {
      return false;
    }
  }
  last.ts = next.ts;
  if (last.latencyMs != null && next.latencyMs != null) {
    const count = Math.max(1, series.LastCount) + 1;
    last.latencyMs += (next.latencyMs - last.latencyMs) / count;
    series.LastCount = count;
  }
  return true;
}

// Record `next` into a series: fold it into the newest point or append it, then
// drop whatever fell out of the window.
function appendSample(series: HistorySeries, next: HistorySample, cutoff: number): void {
  if (!absorbRepeatSample(series, next)) {
    series.Points.push(next);
    series.LastCount = 1;
  }
  const samples = series.Points;
  while (samples.length && samples[0]!.ts < cutoff) samples.shift();
}

// Index of the first point at or after `fromTs`. Points are recorded in time
// order, so this is a binary search rather than a walk over the whole window.
// (A wall-clock step backwards can leave a few points out of order; the worst
// that does is draw them in the wrong minute, it never loses the series.)
function firstIndexAtOrAfter(samples: readonly HistorySample[], fromTs: number): number {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (samples[mid]!.ts < fromTs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// The points from `fromTs` on, as an array of the reader's own. Only the newest
// point is ever changed in place (see absorbRepeatSample), so that one is copied
// and the rest are shared: a reader's points never move under it.
function readSince(samples: readonly HistorySample[], fromTs: number): HistorySample[] {
  const from = firstIndexAtOrAfter(samples, fromTs);
  if (from >= samples.length) return [];
  const out = samples.slice(from);
  out[out.length - 1] = { ...out[out.length - 1]! };
  return out;
}

// Drop the points that fell out of the window from the front of a series.
// Returns whether anything is left.
function trimSeries(series: HistorySeries, cutoff: number): boolean {
  const samples = series.Points;
  if (samples.length && samples[0]!.ts >= cutoff) return true;
  const from = firstIndexAtOrAfter(samples, cutoff);
  if (from >= samples.length) return false;
  samples.splice(0, from);
  return true;
}

// Every named per-entity store (critical applications, USB, displays, audio,
// network, storage, system checks), so the retention sweep can reach them too. Registered by the
// factory below.
const NamedHistoryStores: Array<Pick<NamedHistoryStore, 'prune'>> = [];

// Drop everything older than the 12h window from EVERY store, not only the
// series that happen to be recorded into. A client that goes offline stops
// recording, and its last readings would otherwise outlive the window for as
// long as the server runs. Called by the periodic retention sweep (see
// ./history-retention). Not on reads or list syncs: every series already trims
// itself when written and is filtered when read, and walking every series of
// every store on each read (three times per status-overview poll) cost far more
// than the reads themselves on a large rig. A series whose oldest point is still
// inside the window costs one comparison: points are in time order.
function pruneMonitoringHistoryStore(now: number = Date.now()): void {
  const cutoff = now - MONITORING_HISTORY_MAX_AGE_MS;
  for (const named of NamedHistoryStores) named.prune(now);
  for (const store of Object.values(MonitoringHistoryStores)) {
    for (const [key, series] of store.entries()) {
      if (!trimSeries(series, cutoff)) store.delete(key);
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

  let series = store.get(key);
  if (!series) {
    series = { Points: [], LastCount: 0 };
    store.set(key, series);
  }
  appendSample(series, normalized, now - MONITORING_HISTORY_MAX_AGE_MS);
}

function syncEntityHistoryStore<T>(
  entityType: string,
  list: readonly T[] | null | undefined,
  keyResolver: (item: T) => unknown,
  sampleResolver: (item: T) => HistorySampleInput
): void {
  const store = getHistoryStore(entityType);
  if (!store || typeof keyResolver !== 'function' || typeof sampleResolver !== 'function') return;

  const safeList: readonly T[] = IsArray(list) ? list : [];
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
}

function getEntityHistorySamples(entityType: string, id: unknown): HistorySample[] {
  const store = getHistoryStore(entityType);
  if (!store) return [];
  const key = resolveEntityKey(entityType, id);
  if (key == null) return [];
  const series = store.get(key);
  if (!series) return [];
  return readSince(series.Points, Date.now() - MONITORING_HISTORY_MAX_AGE_MS);
}

// Every series in one store from `sinceTs` on, keyed by its entity id. Feeds the
// list view's history column, which draws a timeline for every row at once:
// one call for the lot rather than one per row. Each series is binary-searched
// to the window, so the cost follows the hour drawn, not the 12 h held.
function getEntityHistorySamplesSince(
  entityType: string,
  sinceTs: number
): Record<string, HistorySample[]> {
  const store = getHistoryStore(entityType);
  const out: Record<string, HistorySample[]> = {};
  if (!store) return out;
  const fromTs = Math.max(Number(sinceTs) || 0, Date.now() - MONITORING_HISTORY_MAX_AGE_MS);
  for (const [key, series] of store.entries()) {
    const recent = readSince(series.Points, fromTs);
    if (recent.length) out[String(key)] = recent;
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
  const checks = IsArray(target.Checks) ? target.Checks : [];
  for (const check of checks) {
    if (!IsObject(check) || check.CheckID == null) continue;
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
  for (const target of IsArray(list) ? list : []) {
    const targetChecks = IsObject(target) ? target.Checks : undefined;
    for (const check of IsArray(targetChecks) ? targetChecks : []) {
      if (IsObject(check) && check.CheckID != null) checks.push(check);
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
    IsArray(list) ? list : null,
    (dummy) => (IsObject(dummy) ? dummy.UUID : null),
    (dummy) => ({
      online: IsObject(dummy) && !!dummy.Online,
      degraded: IsObject(dummy) && !!dummy.Degraded,
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
    IsArray(list) ? list : null,
    (client) => (IsObject(client) ? client.UUID : null),
    (client) => ({
      online: IsObject(client) && !!client.Online,
      degraded: IsObject(client) && !!client.Degraded,
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
  // Identifies one record() call, so the entities it did not report can be found
  // without building a set of the ones it did.
  let recordStamp = 0;

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

    const stamp = ++recordStamp;
    let reported = 0;
    for (const state of states) {
      let entry = perEntity.get(state.key);
      if (!entry) {
        entry = { Name: state.key, Points: [], LastCount: 0, Stamp: 0 };
        perEntity.set(state.key, entry);
      }
      if (entry.Stamp !== stamp) {
        entry.Stamp = stamp;
        reported++;
      }
      if (state.name) entry.Name = state.name;
      // Collapse a repeat of the same reading (see absorbRepeatSample). The
      // degraded comparison is a no-op for domains that never set it (USB /
      // applications), and correctly separates matched/mismatched display bars.
      // The series is extended in place; get() copies the one point that can
      // change (the newest), so a point a reader holds never moves under it.
      appendSample(
        entry,
        { ts: now, online: !!state.online, degraded: !!state.degraded, latencyMs: null },
        cutoff
      );
    }

    // Drop history for entities that are no longer marked critical so the modal
    // only shows currently-tracked entities.
    if (perEntity.size > reported) {
      for (const [key, entry] of perEntity) {
        if (entry.Stamp !== stamp) perEntity.delete(key);
      }
    }
    if (!perEntity.size) store.delete(uuid);
  }

  function sync(list: unknown): void {
    const safeList = IsArray(list) ? list : [];
    const validUUIDs = new Set<string>();
    for (const client of safeList) {
      if (!IsObject(client)) continue;
      const uuid = normalizeDummyUUID(client.UUID);
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
    const cutoff = Date.now() - MONITORING_HISTORY_MAX_AGE_MS;
    const out: Array<NamedHistorySeries<KeyField>> = [];
    for (const [entityKey, entry] of perEntity.entries()) {
      out.push({
        [outputKeyField]: entityKey,
        Name: entry.Name || entityKey,
        samples: readSince(entry.Points, cutoff),
      } as NamedHistorySeries<KeyField>);
    }
    return out;
  }

  function prune(now: number = Date.now()): void {
    const cutoff = now - MONITORING_HISTORY_MAX_AGE_MS;
    for (const [uuid, perEntity] of store) {
      for (const [entityKey, entry] of perEntity) {
        if (!trimSeries(entry, cutoff)) perEntity.delete(entityKey);
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
  const running = IsObject(client.RunningApplications) ? client.RunningApplications : null;
  if (!running) return null;
  const status: { State?: unknown } = IsObject(running.Status) ? running.Status : {};
  const state = String(status.State || 'unknown').toLowerCase();
  if (state !== 'ok') return null;
  const items = IsArray(running.Items) ? running.Items : [];
  const capabilities: { Foreground?: unknown } = IsObject(running.Capabilities)
    ? running.Capabilities
    : {};
  // Only a named owner is evidence that the application lost focus (see
  // Client._isOutOfForeground).
  const focusKnown =
    capabilities.Foreground === true &&
    typeof running.Foreground === 'string' &&
    !!running.Foreground;
  const states: NamedEntityState[] = [];
  for (const item of items) {
    if (!IsObject(item) || !item.IsCritical) continue;
    const name = typeof item.Name === 'string' && item.Name.trim() ? item.Name.trim() : null;
    const key = typeof item.Key === 'string' && item.Key.trim() ? item.Key.trim() : name;
    if (!key) continue;
    const isRunning = item.IsRunning !== false;
    // Running but breaking a condition (hung, or not holding the foreground it
    // must) is "online but degraded" (orange), as for a USB device.
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
// condition (port, firmware, a device error) is "online but degraded"
// (orange). A device absent but allowed to be leaves a gap.
function extractCriticalUSBStates(
  client: ClientHardwareTelemetryLike | null | undefined
): NamedEntityState[] | null {
  if (!client || !client.Online) return null;
  const devices = IsArray(client.USBDeviceList) ? client.USBDeviceList : [];
  const states: NamedEntityState[] = [];
  const byNameKey = new Map<string, NamedEntityState>();
  for (const device of devices) {
    if (!IsObject(device) || !device.IsCritical) continue;
    const manufacturer =
      typeof device.ManufacturerName === 'string' ? device.ManufacturerName.trim() : '';
    const product = typeof device.ProductName === 'string' ? device.ProductName.trim() : '';
    const name = [manufacturer, product].filter(Boolean).join(' ') || 'USB Device';
    const issues = IsArray(device.Issues) ? device.Issues : [];
    // Any issue that is there at all and is not a missing one counts as another.
    const issueKind = (issue: unknown) => (IsObject(issue) ? issue.Kind : undefined);
    const missingIssue = issues.some((issue) => !!issue && issueKind(issue) === 'missing');
    const otherIssue = issues.some((issue) => !!issue && issueKind(issue) !== 'missing');
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
      !device.Critical || !IsObject(device.Critical) || device.Critical.RequirePresent !== false;
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
  const displays = IsArray(client.DisplayList) ? client.DisplayList : [];
  const states: NamedEntityState[] = [];
  for (const display of displays) {
    if (!IsObject(display) || !display.IsCritical) continue;
    const critical = IsObject(display.Critical) ? display.Critical : null;
    const rawID = critical && critical.DisplayID != null ? critical.DisplayID : display.DisplayID;
    const id = rawID != null && String(rawID).trim() ? String(rawID).trim() : null;
    if (!id) continue;
    const label =
      typeof display.Label === 'string' && display.Label.trim() ? display.Label.trim() : null;
    const isConnected = display.IsConnected !== false && !display.Missing;
    if (!isConnected && !display.Missing) continue;
    const issues = IsArray(display.Issues) ? display.Issues : [];
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
  const listed = IsObject(client.AudioDevices) ? client.AudioDevices.Endpoints : undefined;
  const endpoints = IsArray(listed) ? listed : [];
  const states: NamedEntityState[] = [];
  for (const endpoint of endpoints) {
    if (!IsObject(endpoint) || !endpoint.IsCritical) continue;
    const id = typeof endpoint.EndpointID === 'string' ? endpoint.EndpointID.trim() : '';
    if (!id) continue;
    const isConnected = endpoint.IsConnected !== false;
    if (!isConnected && !endpoint.Missing) continue;
    const name =
      typeof endpoint.Name === 'string' && endpoint.Name.trim()
        ? endpoint.Name.trim()
        : 'Audio Device';
    const issues = IsArray(endpoint.Issues) ? endpoint.Issues : [];
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
// yet judged on this connection, is skipped: an idle gap, never a red bar.
function extractCriticalNetworkStates(
  client: ClientHardwareTelemetryLike | null | undefined
): NamedEntityState[] | null {
  if (!client || !client.Online) return null;
  const listed = IsObject(client.NetworkStatus) ? client.NetworkStatus.Interfaces : undefined;
  const interfaces = IsArray(listed) ? listed : [];
  const states: NamedEntityState[] = [];
  for (const iface of interfaces) {
    if (!IsObject(iface) || !iface.IsCritical) continue;
    const name = typeof iface.Name === 'string' ? iface.Name.trim() : '';
    if (!name) continue;
    const isConnected = iface.IsConnected !== false;
    if (!isConnected && !iface.Missing) continue;
    const issues = IsArray(iface.Issues) ? iface.Issues : [];
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

// Resolve the current state for every monitored storage volume on a client, on
// the network extractor's rules: mounted and meeting its conditions is "online",
// mounted but not (low on space, read-only, unhealthy) is "online but degraded",
// missing is "offline". A volume not yet judged on this connection is skipped.
function extractCriticalStorageStates(
  client: ClientHardwareTelemetryLike | null | undefined
): NamedEntityState[] | null {
  if (!client || !client.Online) return null;
  const listed = IsObject(client.StorageStatus) ? client.StorageStatus.Volumes : undefined;
  const volumes = IsArray(listed) ? listed : [];
  const states: NamedEntityState[] = [];
  for (const volume of volumes) {
    if (!IsObject(volume) || !volume.IsCritical) continue;
    const mountPoint = typeof volume.MountPoint === 'string' ? volume.MountPoint.trim() : '';
    if (!mountPoint) continue;
    const isConnected = volume.IsConnected !== false;
    if (!isConnected && !volume.Missing) continue;
    const issues = IsArray(volume.Issues) ? volume.Issues : [];
    const name = typeof volume.Name === 'string' && volume.Name.trim() ? volume.Name.trim() : '';
    states.push({
      key: mountPoint,
      name: name || mountPoint,
      online: isConnected,
      degraded: isConnected && issues.length > 0,
    });
  }
  return states;
}

const ClientStorageHistory = createNamedHistoryStore(extractCriticalStorageStates, 'MountPoint');

const recordClientStorageHistorySamples = ClientStorageHistory.record;
const syncClientStorageHistoryStore = ClientStorageHistory.sync;
const getClientStorageHistorySamples = ClientStorageHistory.get;

// Resolve each monitored system check (CPU, memory, uptime, power, thermal) to
// healthy or failing. A check with nothing to judge (the client offline, or a
// power/thermal collector that has not reported or cannot) leaves a gap, so a
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
  const checks: Record<string, unknown> = IsObject(client.SystemChecks) ? client.SystemChecks : {};
  const failing = new Set<string>();
  for (const alarm of IsArray(client.ResourceAlarms) ? client.ResourceAlarms : []) {
    const check = IsObject(alarm) ? ALARM_CHECK[String(alarm.Key)] : undefined;
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
  recordClientStorageHistorySamples,
  syncClientStorageHistoryStore,
  getClientStorageHistorySamples,
};
