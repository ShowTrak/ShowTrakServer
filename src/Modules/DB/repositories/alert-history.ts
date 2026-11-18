// Typed data access for the AlertHistory table. Constructed as a factory that
// receives the DB manager so test-injected DB mocks propagate through
// unchanged (repositories must never import '../index' at runtime).
//
// The table is a write-only audit trail: rows are appended when a rule fires
// and trimmed by retention, and nothing in the app reads them back. It still
// rides along in every saved show file, so what goes into a row is kept small
// (see AlertsManager's history projection). None of these writes are user
// edits, so none of them mark the show as unsaved.

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
      return DB.RunWithoutDirtyTracking(
        'INSERT INTO AlertHistory (RuleID, TriggerType, TriggerSource, Context, Result, Timestamp) VALUES (?, ?, ?, ?, ?, ?)',
        [Row.RuleID, Row.TriggerType, Row.TriggerSource, Row.Context, Row.Result, Row.Timestamp]
      );
    },

    // Retention by age: delete every entry recorded before `Timestamp`.
    PruneOlderThan(Timestamp: number): Promise<DBResult<unknown>> {
      return DB.RunWithoutDirtyTracking('DELETE FROM AlertHistory WHERE Timestamp < ?', [
        Timestamp,
      ]);
    },

    // Retention by count: keep only the newest MaxRows entries, deleting
    // everything older. Runs on a low-frequency timer (not per-insert), so the
    // whole-table scan cost is negligible; the subquery picks the cutoff
    // HistoryID via the PK-ordered LIMIT.
    PruneToMaxRows(MaxRows: number): Promise<DBResult<unknown>> {
      return DB.RunWithoutDirtyTracking(
        'DELETE FROM AlertHistory WHERE HistoryID < (SELECT MIN(HistoryID) FROM (SELECT HistoryID FROM AlertHistory ORDER BY HistoryID DESC LIMIT ?))',
        [MaxRows]
      );
    },
  };
}
