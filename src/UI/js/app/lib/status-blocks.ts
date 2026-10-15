// Status timeline bucketing: a sample series in, one block per minute out.
//
// Shared by the view modal's Status tab and the list view's history column, so
// a row's graph and the modal it opens can never disagree about a minute. Moved
// here from monitoring.ts, which re-exports every name, so nothing that
// imported them from there changes. Pure: plain data in, plain data out.
import type { FreeKioskMetricSample, HistorySample } from '@showtrak/protocol';
import { MONITOR_HISTORY_BLOCK_COUNT, MONITOR_HISTORY_WINDOW_MS } from './history-window';
import { ExpandMetricSeries } from './metric-series';

// Per-state sample tallies inside a single timeline block.
export interface StatusStateCounts {
  ONLINE: number;
  DEGRADED: number;
  OFFLINE: number;
}

// A single one-hour-window timeline block (one per minute).
export interface StatusBlock {
  start: number;
  end: number;
  state: string;
  count: number;
  counts: StatusStateCounts;
  latencyMs: number | null;
}

// Possible timeline/status states. All resolve to a CSS variable driven colour
// (see main.css :root --status-*) so the palette lives in one place:
//   IDLE / UNAVAILABLE -> grey, OFFLINE -> red, DEGRADED -> orange, ONLINE -> green.
export const MONITOR_STATE_SEVERITY = {
  IDLE: -1,
  UNAVAILABLE: -1,
  ONLINE: 0,
  DEGRADED: 1,
  OFFLINE: 2,
};

export function DeriveSampleState(Sample: HistorySample | null | undefined) {
  if (!Sample) return null;
  if (!Sample.online) return 'OFFLINE' as const;
  if (Sample.degraded) return 'DEGRADED' as const;
  return 'ONLINE' as const;
}

// Bucket a single sample series into a fixed number of one-hour timeline
// blocks. Blocks with no samples stay IDLE (grey) so gaps read as "not enough
// data" instead of implying a state we never observed.
export function BuildStatusBlocksFromSamples(Samples: HistorySample[], Now: number = Date.now()) {
  const WindowStart = Now - MONITOR_HISTORY_WINDOW_MS;
  const BlockMs = MONITOR_HISTORY_WINDOW_MS / MONITOR_HISTORY_BLOCK_COUNT;
  const Sorted = (Array.isArray(Samples) ? Samples : [])
    .filter((S) => S && Number.isFinite(Number(S.ts)))
    .sort((a, b) => a.ts - b.ts);

  const Blocks: StatusBlock[] = [];
  for (let i = 0; i < MONITOR_HISTORY_BLOCK_COUNT; i++) {
    const Start = WindowStart + i * BlockMs;
    const End = Start + BlockMs;
    let State = 'IDLE';
    let Worst = -1;
    let Count = 0;
    let LatencySum = 0;
    let LatencyCount = 0;
    const Counts: StatusStateCounts = { ONLINE: 0, DEGRADED: 0, OFFLINE: 0 };
    for (const S of Sorted) {
      const Ts = Number(S.ts);
      if (Ts < Start || Ts >= End) continue;
      Count += 1;
      const SampleState = DeriveSampleState(S);
      if (SampleState) {
        Counts[SampleState] += 1;
        const Severity = MONITOR_STATE_SEVERITY[SampleState];
        if (Severity > Worst) {
          Worst = Severity;
          State = SampleState;
        }
      }
      if (S.latencyMs != null && Number.isFinite(Number(S.latencyMs))) {
        LatencySum += Number(S.latencyMs);
        LatencyCount += 1;
      }
    }
    Blocks.push({
      start: Start,
      end: End,
      state: State,
      count: Count,
      counts: Counts,
      latencyMs: LatencyCount ? LatencySum / LatencyCount : null,
    });
  }
  return Blocks;
}

// Combine per-check block timelines into a single overall timeline, mirroring
// the server aggregation: OFFLINE only when every reporting check is offline,
// DEGRADED when any is offline/degraded, otherwise ONLINE. Blocks where no
// check reported data stay IDLE (grey).
export function BuildOverallStatusBlocks(
  PerCheckBlocks: StatusBlock[][],
  Now: number = Date.now()
) {
  const WindowStart = Now - MONITOR_HISTORY_WINDOW_MS;
  const BlockMs = MONITOR_HISTORY_WINDOW_MS / MONITOR_HISTORY_BLOCK_COUNT;
  const Blocks: StatusBlock[] = [];
  for (let i = 0; i < MONITOR_HISTORY_BLOCK_COUNT; i++) {
    const States: string[] = [];
    const Counts = { ONLINE: 0, DEGRADED: 0, OFFLINE: 0 };
    for (const CheckBlocks of PerCheckBlocks) {
      const Block = CheckBlocks[i];
      if (Block && Block.state && Block.state !== 'IDLE' && Block.state !== 'UNAVAILABLE') {
        States.push(Block.state);
      }
      if (Block && Block.counts) {
        Counts.ONLINE += Block.counts.ONLINE || 0;
        Counts.DEGRADED += Block.counts.DEGRADED || 0;
        Counts.OFFLINE += Block.counts.OFFLINE || 0;
      }
    }
    let State = 'IDLE';
    if (States.length) {
      if (States.every((S) => S === 'OFFLINE')) State = 'OFFLINE';
      else if (States.some((S) => S === 'OFFLINE' || S === 'DEGRADED')) State = 'DEGRADED';
      else State = 'ONLINE';
    }
    Blocks.push({
      start: WindowStart + i * BlockMs,
      end: WindowStart + (i + 1) * BlockMs,
      state: State,
      count: States.length,
      counts: Counts,
      latencyMs: null,
    });
  }
  return Blocks;
}

/**
 * A FreeKiosk terminal's reachability series as status samples.
 *
 * Poll latency doubles as the reachability series: it is only ever recorded
 * with a reading when a poll actually answered. Expanded first, or a terminal
 * with steady latency shows one live block and fifty-nine grey ones.
 */
export function FreeKioskReachabilitySamples(
  Samples: readonly FreeKioskMetricSample[] | null | undefined,
  Now?: number
): HistorySample[] {
  return ExpandMetricSeries(Samples, Now == null ? {} : { now: Now }).map((Sample) => ({
    ts: Sample.ts,
    online: Sample.ok,
    degraded: Sample.breach,
    latencyMs: Sample.n,
  }));
}
