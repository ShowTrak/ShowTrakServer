// The history window shared by the block timeline and the metric charts.
//
// Both bucket samples with the same arithmetic, so a chart stacked above a
// timeline lines up column for column. Defining the window in one leaf module
// is what guarantees that: monitoring.ts re-exports these, so nothing that
// imports them today changes.
export const MONITOR_HISTORY_WINDOW_MS = 60 * 60 * 1000;
export const MONITOR_HISTORY_BLOCK_COUNT = 60;
