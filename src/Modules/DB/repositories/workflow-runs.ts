// Typed data access for the WorkflowRuns table. Constructed as a factory that
// receives the DB manager so test-injected DB mocks propagate through
// unchanged (repositories must never import '../index' at runtime).

import type { WorkflowRunRow } from '../rows';
import type { DBManager, DBResult } from '../index';

export interface WorkflowRunInsertRow {
  WorkflowID: number;
  RunKey: string;
  TriggerSource: string;
  ContextScopedID: string | null;
  Status: string;
  Context: string;
  Steps: string;
  ReturnValue: string;
  StartedAt: number;
  FinishedAt: number;
}

// Run history must never flip the unsaved-changes flag — a workflow firing
// mid-show would otherwise leave the operator with a show file that looks
// edited. Falls back to DB.Run only when RunWithoutDirtyTracking is
// unavailable (e.g. minimal DB mocks in tests).
function writer(DB: DBManager) {
  return typeof DB.RunWithoutDirtyTracking === 'function'
    ? DB.RunWithoutDirtyTracking.bind(DB)
    : DB.Run.bind(DB);
}

export function CreateWorkflowRunsRepository(DB: DBManager) {
  return {
    Insert(Row: WorkflowRunInsertRow): Promise<DBResult<unknown>> {
      return writer(DB)(
        'INSERT INTO WorkflowRuns (WorkflowID, RunKey, TriggerSource, ContextScopedID, Status, Context, Steps, ReturnValue, StartedAt, FinishedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          Row.WorkflowID,
          Row.RunKey,
          Row.TriggerSource,
          Row.ContextScopedID,
          Row.Status,
          Row.Context,
          Row.Steps,
          Row.ReturnValue,
          Row.StartedAt,
          Row.FinishedAt,
        ]
      );
    },

    GetRecent(WorkflowID: number, Limit: number): Promise<DBResult<WorkflowRunRow[]>> {
      return DB.All<WorkflowRunRow>(
        'SELECT * FROM WorkflowRuns WHERE WorkflowID = ? ORDER BY RunID DESC LIMIT ?',
        [WorkflowID, Limit]
      );
    },

    GetRecentForContext(
      ContextScopedID: string,
      Limit: number
    ): Promise<DBResult<WorkflowRunRow[]>> {
      return DB.All<WorkflowRunRow>(
        'SELECT * FROM WorkflowRuns WHERE ContextScopedID = ? ORDER BY RunID DESC LIMIT ?',
        [ContextScopedID, Limit]
      );
    },

    DeleteForWorkflow(WorkflowID: number): Promise<DBResult<unknown>> {
      return writer(DB)('DELETE FROM WorkflowRuns WHERE WorkflowID = ?', [WorkflowID]);
    },

    // Retention: keep only the newest MaxRows entries. Runs on a low-frequency
    // timer, not per-insert, so the scan cost is negligible.
    PruneToMaxRows(MaxRows: number): Promise<DBResult<unknown>> {
      return writer(DB)(
        'DELETE FROM WorkflowRuns WHERE RunID < (SELECT MIN(RunID) FROM (SELECT RunID FROM WorkflowRuns ORDER BY RunID DESC LIMIT ?))',
        [MaxRows]
      );
    },
  };
}
