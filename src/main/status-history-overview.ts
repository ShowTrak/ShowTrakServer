// The overall-status history of everything on the page, in one read.
//
// Backs the list view's history column, which draws a one-hour timeline on
// every row. The per-entity readers (GetClientHistory, GetMonitoringCheckHistory,
// ...) would mean one round-trip per row on every refresh — and per CHECK for a
// monitoring target — so this gathers the same series from the same stores in
// a single call.
//
// Only the samples the timeline can draw are returned. The renderer buckets
// them with the same arithmetic the view modal uses, so a row's graph and the
// modal's Status tab always agree.
import { getStatusHistoryOverviewSamples } from './monitoring-history';
import { getFreeKioskReachabilitySince } from './freekiosk-history';
import type { StatusHistoryOverview } from '@showtrak/protocol';

/**
 * How far back the overview reaches. The renderer's timeline window is one
 * hour (MONITOR_HISTORY_WINDOW_MS); the extra minute covers the drift between
 * this read and the moment the renderer buckets it, so the oldest block is
 * never drawn from a partial minute.
 */
export const STATUS_HISTORY_OVERVIEW_WINDOW_MS = 61 * 60 * 1000;

export function getStatusHistoryOverview(Now: number = Date.now()): StatusHistoryOverview {
  const SinceTs = Now - STATUS_HISTORY_OVERVIEW_WINDOW_MS;
  return {
    ...getStatusHistoryOverviewSamples(SinceTs),
    Kiosks: getFreeKioskReachabilitySince(SinceTs),
  };
}
