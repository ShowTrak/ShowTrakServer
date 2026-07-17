// Typed data access for the AlertHistory table. Constructed as a factory that
// receives the DB manager so test-injected DB mocks propagate through
// unchanged (repositories must never import '../index' at runtime).

import type { DBManager, DBResult } from '../index';

// Column values for a new AlertHistory row (HistoryID is auto-assigned;
// Context/Result arrive pre-stringified).
export interface AlertHistoryInsertRow {
  RuleID: number;
  TriggerType: string;
  TriggerSource: string;
  Context: string;
  Result: string;
  Timestamp: number;
}

export function CreateAlertHistoryRepository(DB: DBManager) {
  return {
    Insert(Row: AlertHistoryInsertRow): Promise<DBResult<unknown>> {
      // History writes must not flip the unsaved-changes flag; fall back to
      // DB.Run only when RunWithoutDirtyTracking is unavailable (e.g. minimal
      // DB mocks in tests).
      const Run =
        typeof DB.RunWithoutDirtyTracking === 'function'
          ? DB.RunWithoutDirtyTracking.bind(DB)
          : DB.Run.bind(DB);
      return Run(
        'INSERT INTO AlertHistory (RuleID, TriggerType, TriggerSource, Context, Result, Timestamp) VALUES (?, ?, ?, ?, ?, ?)',
        [Row.RuleID, Row.TriggerType, Row.TriggerSource, Row.Context, Row.Result, Row.Timestamp]
      );
    },

    // Retention: keep only the newest MaxRows entries, deleting everything
    // older. Runs on a low-frequency timer (not per-insert), so the whole-table
    // scan cost is negligible; the subquery picks the cutoff HistoryID via the
    // PK-ordered LIMIT. Like Insert, this must not flip the unsaved-changes flag.
    PruneToMaxRows(MaxRows: number): Promise<DBResult<unknown>> {
      const Run =
        typeof DB.RunWithoutDirtyTracking === 'function'
          ? DB.RunWithoutDirtyTracking.bind(DB)
          : DB.Run.bind(DB);
      return Run(
        'DELETE FROM AlertHistory WHERE HistoryID < (SELECT MIN(HistoryID) FROM (SELECT HistoryID FROM AlertHistory ORDER BY HistoryID DESC LIMIT ?))',
        [MaxRows]
      );
    },
  };
}
