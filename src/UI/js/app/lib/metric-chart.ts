// Numeric metric charts.
//
// The app draws status history as a row of categorical blocks (online /
// degraded / offline). That reads perfectly for a verdict and not at all for a
// value: a battery draining from 90% to 12% over an hour is four hundred green
// blocks. So numeric metrics get a line, and everything else keeps the blocks.
//
// Pure and DOM-free, like lib/client-list-layout.ts and lib/qr-svg.ts: the model
// is built from plain data and the SVG is built from the model, so both are
// unit-testable without a browser. `now` is injectable for the same reason.
//
// Hand-rolled SVG rather than a charting library. The app vendors its
// dependencies for offline use, and one line series with a threshold band is not
// worth a bundle — nor the risk of a chart library's own idea of how to handle
// gaps, which is the detail that matters most here.
import type { FreeKioskMetricSample } from '@showtrak/protocol';
import { MONITOR_HISTORY_BLOCK_COUNT, MONITOR_HISTORY_WINDOW_MS } from './history-window';

export interface MetricChartThreshold {
  operator: 'below' | 'above' | 'outside' | 'inside';
  value: number;
  value2?: number | null;
}

export interface MetricChartOptions {
  windowMs?: number;
  bucketCount?: number;
  now?: number;
  width?: number;
  height?: number;
  padTop?: number;
  padBottom?: number;
  /** Registry Min/Max, where the metric has a known domain. */
  min?: number | null;
  max?: number | null;
  decimals?: number;
  threshold?: MetricChartThreshold | null;
}

export interface MetricChartBucket {
  index: number;
  start: number;
  end: number;
  count: number;
  /** At least one sample in this bucket carried a real reading. */
  ok: boolean;
  min: number | null;
  max: number | null;
  avg: number | null;
  last: number | null;
  breach: boolean;
}

export interface MetricChartModel {
  buckets: MetricChartBucket[];
  yMin: number;
  yMax: number;
  /** Multi-segment: a gap starts a fresh 'M' rather than interpolating across it. */
  linePath: string;
  areaPath: string;
  gridY: Array<{ y: number; value: number }>;
  bands: Array<{ y: number; height: number }>;
  thresholdLines: Array<{ y: number; value: number }>;
  gaps: Array<{ x: number; width: number }>;
  width: number;
  height: number;
  empty: boolean;
}

const DEFAULT_WIDTH = 1000;
const DEFAULT_HEIGHT = 120;
const DEFAULT_PAD_TOP = 8;
const DEFAULT_PAD_BOTTOM = 8;

function Round(Value: number, Decimals = 2): number {
  const Factor = Math.pow(10, Decimals);
  return Math.round(Value * Factor) / Factor;
}

/**
 * Bucket samples and derive the geometry.
 *
 * The bucketing is deliberately identical to BuildStatusBlocksFromSamples: same
 * window, same count, same half-open [start, end) membership. Bucket i of a
 * chart therefore spans the same instants as block i of a timeline, so a chart
 * stacked above one lines up column for column — which is the whole point of
 * mixing the two in a single modal.
 */
export function BuildMetricChartModel(
  Samples: readonly FreeKioskMetricSample[] | null | undefined,
  Options: MetricChartOptions = {}
): MetricChartModel {
  const WindowMs = Options.windowMs ?? MONITOR_HISTORY_WINDOW_MS;
  const BucketCount = Math.max(1, Options.bucketCount ?? MONITOR_HISTORY_BLOCK_COUNT);
  const Now = Options.now ?? Date.now();
  const Width = Options.width ?? DEFAULT_WIDTH;
  const Height = Options.height ?? DEFAULT_HEIGHT;
  const PadTop = Options.padTop ?? DEFAULT_PAD_TOP;
  const PadBottom = Options.padBottom ?? DEFAULT_PAD_BOTTOM;
  const Decimals = Options.decimals ?? 0;

  const WindowStart = Now - WindowMs;
  const BucketMs = WindowMs / BucketCount;
  const BucketWidth = Width / BucketCount;

  const Sorted = (Array.isArray(Samples) ? Samples : [])
    .filter((S) => S && Number.isFinite(Number(S.ts)))
    .sort((a, b) => a.ts - b.ts);

  const Buckets: MetricChartBucket[] = [];
  for (let i = 0; i < BucketCount; i += 1) {
    const Start = WindowStart + i * BucketMs;
    const End = Start + BucketMs;
    let Count = 0;
    let Ok = false;
    let Min: number | null = null;
    let Max: number | null = null;
    let Sum = 0;
    let SumCount = 0;
    let Last: number | null = null;
    let Breach = false;

    for (const Sample of Sorted) {
      const Ts = Number(Sample.ts);
      if (Ts < Start || Ts >= End) continue;
      Count += 1;
      if (Sample.breach) Breach = true;
      if (!Sample.ok || Sample.n == null || !Number.isFinite(Number(Sample.n))) continue;
      const Value = Number(Sample.n);
      Ok = true;
      Min = Min == null ? Value : Math.min(Min, Value);
      Max = Max == null ? Value : Math.max(Max, Value);
      Sum += Value;
      SumCount += 1;
      Last = Value;
    }

    Buckets.push({
      index: i,
      start: Start,
      end: End,
      count: Count,
      ok: Ok,
      min: Min,
      max: Max,
      avg: SumCount ? Round(Sum / SumCount, Math.max(2, Decimals)) : null,
      last: Last,
      breach: Breach,
    });
  }

  const Readings = Buckets.filter((B) => B.ok);
  const Empty = Readings.length === 0;

  // Scale. A declared domain wins: a battery pinned at 100% must draw as a flat
  // line at the top, not as amplified noise across the full height.
  let YMin = Options.min ?? null;
  let YMax = Options.max ?? null;
  if (YMin == null || YMax == null) {
    let ObservedMin = Infinity;
    let ObservedMax = -Infinity;
    for (const Bucket of Readings) {
      if (Bucket.min != null) ObservedMin = Math.min(ObservedMin, Bucket.min);
      if (Bucket.max != null) ObservedMax = Math.max(ObservedMax, Bucket.max);
    }
    if (!Number.isFinite(ObservedMin)) {
      ObservedMin = 0;
      ObservedMax = 1;
    }
    // The threshold is always inside the scale, so its band stays visible even
    // when the data never approaches it.
    if (Options.threshold) {
      ObservedMin = Math.min(ObservedMin, Options.threshold.value);
      ObservedMax = Math.max(ObservedMax, Options.threshold.value);
      if (Options.threshold.value2 != null) {
        ObservedMin = Math.min(ObservedMin, Options.threshold.value2);
        ObservedMax = Math.max(ObservedMax, Options.threshold.value2);
      }
    }
    const Headroom = Math.max((ObservedMax - ObservedMin) * 0.1, Math.pow(10, -Decimals) / 2);
    if (YMin == null) YMin = ObservedMin - Headroom;
    if (YMax == null) YMax = ObservedMax + Headroom;
  }
  // A constant series would otherwise divide by zero.
  if (!(YMax > YMin)) {
    const Centre = YMin;
    YMin = Centre - 0.5;
    YMax = Centre + 0.5;
  }

  const PlotTop = PadTop;
  const PlotHeight = Math.max(1, Height - PadTop - PadBottom);
  const YFor = (Value: number): number => {
    const Ratio = (Value - YMin!) / (YMax! - YMin!);
    const Clamped = Math.min(1, Math.max(0, Ratio));
    return Round(PlotTop + (1 - Clamped) * PlotHeight, 2);
  };
  const XFor = (Index: number): number => Round(Index * BucketWidth + BucketWidth / 2, 2);

  // Path. A bucket with no reading BREAKS the line rather than interpolating
  // across it: a straight line over an outage is a claim about data nobody has.
  const LineSegments: string[] = [];
  const AreaSegments: string[] = [];
  const Gaps: Array<{ x: number; width: number }> = [];
  let Current: string[] = [];
  let CurrentArea: string[] = [];
  let SegmentStartX = 0;

  const FlushSegment = () => {
    if (Current.length) {
      LineSegments.push(Current.join(' '));
      if (CurrentArea.length) {
        const LastX = Current[Current.length - 1]!.split(',')[0]!.replace(/^[ML]/, '');
        AreaSegments.push(
          `M${SegmentStartX},${Round(PlotTop + PlotHeight, 2)} ${CurrentArea.join(' ')} L${LastX},${Round(
            PlotTop + PlotHeight,
            2
          )} Z`
        );
      }
    }
    Current = [];
    CurrentArea = [];
  };

  for (const Bucket of Buckets) {
    const Value = Bucket.avg ?? Bucket.last;
    if (!Bucket.ok || Value == null) {
      FlushSegment();
      Gaps.push({ x: Round(Bucket.index * BucketWidth, 2), width: Round(BucketWidth, 2) });
      continue;
    }
    const X = XFor(Bucket.index);
    const Y = YFor(Value);
    if (!Current.length) {
      SegmentStartX = X;
      Current.push(`M${X},${Y}`);
      CurrentArea.push(`L${X},${Y}`);
    } else {
      Current.push(`L${X},${Y}`);
      CurrentArea.push(`L${X},${Y}`);
    }
  }
  FlushSegment();

  // Threshold shading covers the region that would be in breach.
  const Bands: Array<{ y: number; height: number }> = [];
  const ThresholdLines: Array<{ y: number; value: number }> = [];
  const Threshold = Options.threshold;
  if (Threshold && Number.isFinite(Threshold.value)) {
    const PlotBottom = PlotTop + PlotHeight;
    const Y1 = YFor(Threshold.value);
    ThresholdLines.push({ y: Y1, value: Threshold.value });
    if (Threshold.operator === 'above') {
      Bands.push({ y: PlotTop, height: Round(Y1 - PlotTop, 2) });
    } else if (Threshold.operator === 'below') {
      Bands.push({ y: Y1, height: Round(PlotBottom - Y1, 2) });
    } else if (Threshold.value2 != null && Number.isFinite(Threshold.value2)) {
      const Y2 = YFor(Threshold.value2);
      ThresholdLines.push({ y: Y2, value: Threshold.value2 });
      const Upper = Math.min(Y1, Y2);
      const Lower = Math.max(Y1, Y2);
      if (Threshold.operator === 'inside') {
        Bands.push({ y: Upper, height: Round(Lower - Upper, 2) });
      } else {
        Bands.push({ y: PlotTop, height: Round(Upper - PlotTop, 2) });
        Bands.push({ y: Lower, height: Round(PlotBottom - Lower, 2) });
      }
    }
  }

  const GridY = [
    { y: YFor(YMax), value: Round(YMax, Math.max(1, Decimals)) },
    { y: YFor((YMax + YMin) / 2), value: Round((YMax + YMin) / 2, Math.max(1, Decimals)) },
    { y: YFor(YMin), value: Round(YMin, Math.max(1, Decimals)) },
  ];

  return {
    buckets: Buckets,
    yMin: YMin,
    yMax: YMax,
    linePath: LineSegments.join(' '),
    areaPath: AreaSegments.join(' '),
    gridY: GridY,
    bands: Bands,
    thresholdLines: ThresholdLines,
    gaps: Gaps,
    width: Width,
    height: Height,
    empty: Empty,
  };
}

function Escape(Value: unknown): string {
  return String(Value == null ? '' : Value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface MetricChartMeta {
  label: string;
  unit?: string;
  decimals?: number;
  formatted?: (value: number) => string;
}

/**
 * The SVG.
 *
 * Note the zero horizontal padding: `.status-timeline` has no gutters, so a
 * chart with a left axis column would sit a few pixels out of step with the
 * block timeline beneath it. The y-axis labels are overlaid inside the plot
 * instead, which keeps the two aligned.
 */
export function RenderMetricChartSvg(Model: MetricChartModel, Meta: MetricChartMeta): string {
  const Format = (Value: number): string =>
    Meta.formatted ? Meta.formatted(Value) : `${Value}${Meta.unit ? ` ${Meta.unit}` : ''}`;

  const BucketWidth = Model.width / Math.max(1, Model.buckets.length);

  const Bands = Model.bands
    .filter((Band) => Band.height > 0)
    .map(
      (Band) =>
        `<rect class="metric-chart-band" x="0" y="${Band.y}" width="${Model.width}" height="${Band.height}"/>`
    )
    .join('');

  const Gaps = Model.gaps
    .map(
      (Gap) =>
        `<rect class="metric-chart-gap" x="${Gap.x}" y="0" width="${Gap.width}" height="${Model.height}"/>`
    )
    .join('');

  const Grid = Model.gridY
    .map(
      (Line) =>
        `<line class="metric-chart-grid" x1="0" y1="${Line.y}" x2="${Model.width}" y2="${Line.y}"/>`
    )
    .join('');

  const Thresholds = Model.thresholdLines
    .map(
      (Line) =>
        `<line class="metric-chart-threshold" x1="0" y1="${Line.y}" x2="${Model.width}" y2="${Line.y}"/>`
    )
    .join('');

  const Labels = Model.gridY
    .map(
      (Line, Index) =>
        `<text class="metric-chart-label" x="6" y="${
          Index === 0 ? Line.y + 10 : Index === Model.gridY.length - 1 ? Line.y - 4 : Line.y - 3
        }">${Escape(Format(Line.value))}</text>`
    )
    .join('');

  // One transparent hit rect per bucket, carrying the same kind of data
  // attributes the timeline blocks carry so both can share one tooltip.
  const Columns = Model.buckets
    .map((Bucket) => {
      const X = Bucket.index * BucketWidth;
      return (
        `<g class="metric-chart-col">` +
        `<line class="metric-chart-cursor" x1="${X + BucketWidth / 2}" y1="0" x2="${
          X + BucketWidth / 2
        }" y2="${Model.height}"/>` +
        `<rect class="metric-chart-hit" x="${X}" y="0" width="${BucketWidth}" height="${
          Model.height
        }" data-ts="${Bucket.start}" data-ok="${Bucket.ok ? 1 : 0}" data-breach="${
          Bucket.breach ? 1 : 0
        }" data-count="${Bucket.count}" data-min="${Bucket.min ?? ''}" data-max="${
          Bucket.max ?? ''
        }" data-avg="${Bucket.avg ?? ''}" data-last="${Bucket.last ?? ''}" data-unit="${Escape(
          Meta.unit || ''
        )}" data-decimals="${Meta.decimals ?? 0}" data-label="${Escape(Meta.label)}"/>` +
        `</g>`
      );
    })
    .join('');

  const Body = Model.empty
    ? `<text class="metric-chart-empty" x="${Model.width / 2}" y="${
        Model.height / 2
      }">No readings yet</text>`
    : `${Model.areaPath ? `<path class="metric-chart-area" d="${Model.areaPath}"/>` : ''}` +
      `${Model.linePath ? `<path class="metric-chart-line" d="${Model.linePath}"/>` : ''}`;

  return (
    `<svg class="metric-chart" viewBox="0 0 ${Model.width} ${Model.height}" preserveAspectRatio="none" role="img" aria-label="${Escape(
      Meta.label
    )} history">` +
    Bands +
    Gaps +
    Grid +
    Thresholds +
    Body +
    Labels +
    Columns +
    `</svg>`
  );
}
