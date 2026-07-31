// Undo the history store's flat-run compression for anything that buckets by
// time.
//
// The store deliberately does not keep one sample per poll. Once two consecutive
// samples say the same thing it just moves the second one's timestamp forward,
// so a screen that has been on for twelve hours costs two samples rather than
// fourteen hundred. A sample therefore means "this reading held from here until
// the next sample" — not "this is the only instant anybody looked".
//
// Both bucketers disagreed with that. They count samples per bucket and treat an
// empty bucket as no data, so a terminal with a steady battery level drew one
// live column and fifty-nine grey ones. Expanding here, rather than storing
// uncompressed, keeps the store compact and puts the interpretation next to the
// code that depends on it.
import type { FreeKioskMetricSample } from '@showtrak/protocol';
import { MONITOR_HISTORY_BLOCK_COUNT, MONITOR_HISTORY_WINDOW_MS } from './history-window';

export interface ExpandMetricSeriesOptions {
  now?: number;
  windowMs?: number;
  bucketCount?: number;
}

/**
 * Return the series with one synthetic sample added per otherwise-empty bucket,
 * carrying the most recent earlier reading forward.
 *
 * Buckets before the first sample stay empty: nothing was ever recorded for
 * them, and inventing a reading there would claim knowledge of a period the app
 * was not running for. A carried-forward `ok: false` stays false, so a genuine
 * outage still paints as a gap rather than being filled in green.
 *
 * Pure, and `now` is injectable — the same contract as BuildMetricChartModel,
 * whose bucket boundaries this must match exactly.
 */
export function ExpandMetricSeries(
  Samples: readonly FreeKioskMetricSample[] | null | undefined,
  Options: ExpandMetricSeriesOptions = {}
): FreeKioskMetricSample[] {
  const Sorted = (Array.isArray(Samples) ? Samples : [])
    .filter((Sample) => Sample && Number.isFinite(Number(Sample.ts)))
    .slice()
    .sort((a, b) => a.ts - b.ts);
  if (!Sorted.length) return [];

  const WindowMs = Options.windowMs ?? MONITOR_HISTORY_WINDOW_MS;
  const BucketCount = Math.max(1, Options.bucketCount ?? MONITOR_HISTORY_BLOCK_COUNT);
  const Now = Options.now ?? Date.now();
  const WindowStart = Now - WindowMs;
  const BucketMs = WindowMs / BucketCount;

  const Out = Sorted.slice();
  let Cursor = 0;
  let Carry: FreeKioskMetricSample | null = null;

  for (let i = 0; i < BucketCount; i += 1) {
    const Start = WindowStart + i * BucketMs;
    const End = Start + BucketMs;

    // Everything strictly before this bucket becomes the value to carry. On the
    // first pass this also consumes samples older than the window, which is the
    // whole point: a run that started three hours ago still holds now.
    while (Cursor < Sorted.length && Sorted[Cursor]!.ts < Start) {
      Carry = Sorted[Cursor]!;
      Cursor += 1;
    }

    let Occupied = false;
    while (Cursor < Sorted.length && Sorted[Cursor]!.ts < End) {
      Occupied = true;
      Carry = Sorted[Cursor]!;
      Cursor += 1;
    }

    if (!Occupied && Carry) Out.push({ ...Carry, ts: Start + BucketMs / 2 });
  }

  return Out.sort((a, b) => a.ts - b.ts);
}
