// FreeKiosk metric history (main process).
//
// A sibling of monitoring-history.ts rather than an addition to it: that store
// records a status verdict (online / degraded / latency), whereas a terminal
// records a VALUE per metric — a battery percentage, a temperature, an SSID.
// The 12h window is imported from there so the retention policy is stated once.
//
// One sample shape serves both chart kinds. `n` carries numeric metrics and `s`
// categorical ones, which means a single store, one IPC channel and one renderer
// fetch path cover the line charts and the block timelines alike.
//
// `breach` is recorded at sample time rather than derived later, so a chart's
// threshold shading always shows what the alarm engine actually decided at that
// instant. Deriving it in the renderer would silently rewrite history whenever
// somebody edited a threshold.
import { MONITORING_HISTORY_MAX_AGE_MS } from './monitoring-history';
import { FREEKIOSK_METRICS, RoundTo } from '../Modules/FreeKiosk/metrics';
import { ParseAlarmSettings } from '../Modules/FreeKiosk/alarms';

/** One point of one metric's series. */
export interface FreeKioskMetricSample {
  ts: number;
  /** The terminal answered AND this metric had a reading. */
  ok: boolean;
  n: number | null;
  s: string | null;
  breach: boolean;
}

export interface FreeKioskMetricSeries {
  MetricKey: string;
  Samples: FreeKioskMetricSample[];
}

/**
 * Per-series backstop. The window plus flat-run compression already keep a
 * well-behaved terminal in the low hundreds of points; this only bites on a
 * metric that flaps on every single poll, where an unbounded array would be the
 * one thing that could grow without limit.
 */
export const FREEKIOSK_HISTORY_MAX_SERIES_POINTS = 2000;

/** Collapse window for a repeat reading, matching the monitoring history store. */
const COALESCE_WINDOW_MS = 900;

/** Categorical values are capped — a kiosk URL can be arbitrarily long. */
const MAX_CATEGORICAL_LENGTH = 64;

/**
 * The one series recorded whether or not anything is armed on it.
 *
 * Poll latency is ShowTrak's own measurement rather than a device reading, and
 * it is what the terminal's overall status timeline is built from — gating it on
 * a check nobody has any reason to arm would blank that timeline.
 */
const STATUS_SERIES_KEY = 'poll_latencyMs';

type MetricStore = Map<string, FreeKioskMetricSample[]>;

// Two levels: terminal UUID -> metric key -> samples. Deleting a terminal is one
// delete, and dropping a metric the registry no longer declares is cheap.
const Store = new Map<string, MetricStore>();

/** Loose shape of the terminal snapshot this store reads. */
interface TerminalLike {
  UUID?: unknown;
  Online?: unknown;
  Metrics?: unknown;
  Alarms?: unknown;
  /** Carries the per-section monitoring switches. */
  Settings?: unknown;
}

function NormalizeUUID(Value: unknown): string | null {
  const Text = typeof Value === 'string' ? Value.trim() : '';
  return Text || null;
}

function SamplesEqual(A: FreeKioskMetricSample, B: FreeKioskMetricSample): boolean {
  return A.ok === B.ok && A.n === B.n && A.s === B.s && A.breach === B.breach;
}

function Trim(Samples: FreeKioskMetricSample[], Now: number): void {
  const Cutoff = Now - MONITORING_HISTORY_MAX_AGE_MS;
  while (Samples.length && Samples[0]!.ts < Cutoff) Samples.shift();
  while (Samples.length > FREEKIOSK_HISTORY_MAX_SERIES_POINTS) Samples.shift();
}

function Append(Samples: FreeKioskMetricSample[], Next: FreeKioskMetricSample): void {
  const Length = Samples.length;
  const Last = Length ? Samples[Length - 1]! : null;

  if (Last && SamplesEqual(Last, Next)) {
    const Previous = Length > 1 ? Samples[Length - 2]! : null;

    // A burst of identical readings inside the collapse window is one reading.
    if (Next.ts - Last.ts < COALESCE_WINDOW_MS) {
      Last.ts = Next.ts;
      Trim(Samples, Next.ts);
      return;
    }

    // Flat-run compression with a two-point anchor: once the last TWO samples
    // already say the same thing, extend the second rather than pushing a third.
    // The run keeps its first and last point, so a step signal is reproduced
    // exactly — while a screen that has been on for twelve hours costs two
    // samples instead of fourteen hundred.
    if (Previous && SamplesEqual(Previous, Last)) {
      Last.ts = Next.ts;
      Trim(Samples, Next.ts);
      return;
    }
  }

  Samples.push(Next);
  Trim(Samples, Next.ts);
}

/** Drop expired samples, then empty metrics, then empty terminals. */
export function pruneFreeKioskHistory(Now: number = Date.now()): void {
  for (const [UUID, Metrics] of Store) {
    for (const [Key, Samples] of Metrics) {
      Trim(Samples, Now);
      if (!Samples.length) Metrics.delete(Key);
    }
    if (!Metrics.size) Store.delete(UUID);
  }
}

/**
 * Record one sample per registry metric from a terminal snapshot.
 *
 * Iterates the REGISTRY rather than the snapshot's keys, so a metric the device
 * stopped reporting records an explicit "no reading" gap instead of quietly
 * vanishing from the chart and leaving a straight line across the outage.
 */
export function recordFreeKioskHistorySamples(
  Terminal: TerminalLike | null | undefined,
  SampledAt: number | null = null
): void {
  const UUID = NormalizeUUID(Terminal && Terminal.UUID);
  if (!UUID) return;

  const Now =
    SampledAt != null && Number.isFinite(Number(SampledAt)) ? Number(SampledAt) : Date.now();
  const Online = !!(Terminal && Terminal.Online);
  const Values = (
    Terminal && Terminal.Metrics && typeof Terminal.Metrics === 'object' ? Terminal.Metrics : {}
  ) as Record<string, unknown>;
  const Settings = Terminal && Terminal.Settings;

  const Breached = new Set<string>();
  for (const Alarm of Array.isArray(Terminal && Terminal.Alarms) ? (Terminal!.Alarms as []) : []) {
    const Key = Alarm && (Alarm as { Key?: unknown }).Key;
    if (typeof Key === 'string') Breached.add(Key);
  }

  let Metrics = Store.get(UUID);
  if (!Metrics) {
    Metrics = new Map<string, FreeKioskMetricSample[]>();
    Store.set(UUID, Metrics);
  }

  // What is being judged right now. ParseAlarmSettings is the same funnel the
  // evaluator uses, so a section switched off force-disables its checks here too
  // and needs no separate test.
  const Armed = ParseAlarmSettings(Settings);

  for (const Metric of FREEKIOSK_METRICS) {
    // Only record what is actually being judged.
    //
    // A sample from an unarmed metric carries breach:false — not because the
    // reading was good, but because nothing was assessing it. Keeping those and
    // then arming a check would hand the operator an hour of green that was
    // never judged, which is precisely the false reassurance the charts are
    // gated to avoid. So arming starts a clean series, and disarming releases
    // the old one rather than leaving a chart that stops dead mid-window.
    if (Metric.Key !== STATUS_SERIES_KEY && !Armed.get(Metric.Key)?.Enabled) {
      Metrics.delete(Metric.Key);
      continue;
    }

    const Raw = Values[Metric.Key];
    const Missing = !Online || Raw == null;

    let Numeric: number | null = null;
    let Categorical: string | null = null;
    if (!Missing) {
      if (Metric.Type === 'number') {
        const Parsed = Number(Raw);
        Numeric = Number.isFinite(Parsed) ? RoundTo(Parsed, Metric.Decimals ?? 0) : null;
      } else {
        Categorical = String(Raw).slice(0, MAX_CATEGORICAL_LENGTH);
      }
    }

    const Sample: FreeKioskMetricSample = {
      ts: Now,
      ok: !Missing && (Numeric != null || Categorical != null),
      n: Numeric,
      s: Categorical,
      breach: Breached.has(Metric.Key),
    };

    const Samples = Metrics.get(Metric.Key) || [];
    Append(Samples, Sample);
    Metrics.set(Metric.Key, Samples);
  }
}

/** Record for every terminal in a full list push, and forget deleted ones. */
export function syncFreeKioskHistoryStore(List: unknown): void {
  const Terminals: TerminalLike[] = Array.isArray(List) ? List : [];
  const Valid = new Set<string>();

  for (const Terminal of Terminals) {
    const UUID = NormalizeUUID(Terminal && Terminal.UUID);
    if (!UUID) continue;
    Valid.add(UUID);
    recordFreeKioskHistorySamples(Terminal);
  }

  for (const UUID of Array.from(Store.keys())) {
    if (!Valid.has(UUID)) Store.delete(UUID);
  }

  pruneFreeKioskHistory();
}

/**
 * Every series for one terminal, or just the ones asked for.
 *
 * One call returns them all on purpose. A terminal has around sixty metrics, and
 * the view modal reloads on every push while it is open — asking for them one at
 * a time would mean sixty IPC round-trips every poll.
 */
export function getFreeKioskMetricHistory(
  UUID: unknown,
  MetricKeys: unknown = null
): FreeKioskMetricSeries[] {
  pruneFreeKioskHistory();
  const Key = NormalizeUUID(UUID);
  if (!Key) return [];
  const Metrics = Store.get(Key);
  if (!Metrics) return [];

  const Wanted =
    Array.isArray(MetricKeys) && MetricKeys.length
      ? new Set(MetricKeys.map((Entry) => String(Entry)))
      : null;

  const Series: FreeKioskMetricSeries[] = [];
  for (const Metric of FREEKIOSK_METRICS) {
    if (Wanted && !Wanted.has(Metric.Key)) continue;
    const Samples = Metrics.get(Metric.Key);
    if (!Samples || !Samples.length) continue;
    Series.push({ MetricKey: Metric.Key, Samples: Samples.map((Sample) => ({ ...Sample })) });
  }
  return Series;
}

/** Forget a deleted terminal outright. */
export function dropFreeKioskHistory(UUID: unknown): void {
  const Key = NormalizeUUID(UUID);
  if (Key) Store.delete(Key);
}

export const _internal = { Store, Append, COALESCE_WINDOW_MS };
