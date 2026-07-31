// Typed data access for the Workflows table. Constructed as a factory that
// receives the DB manager so test-injected DB mocks propagate through
// unchanged (repositories must never import '../index' at runtime).

import type { WorkflowRow } from '../rows';
import type { DBManager, DBResult } from '../index';

export interface WorkflowWriteResult {
  lastID: number;
  changes: number;
}

// Column values for an insert/update. The three section columns arrive
// pre-stringified; Enabled is 0|1.
export interface WorkflowWriteRow {
  Name: string;
  Description: string;
  Icon: string;
  Colour: number;
  Triggers: string;
  Steps: string;
  Return: string;
  Enabled: number;
  Weight: number;
  Timestamp: number;
  UpdatedAt: number;
}

export function CreateWorkflowsRepository(DB: DBManager) {
  return {
    // Weight-then-ID, NOT newest-first. Workflows are hand-ordered by the
    // operator like tags, unlike alert rules which have no ordering at all —
    // copying the AlertRules `ORDER BY RuleID DESC` here would silently ignore
    // every drag in the editor.
    GetAll(): Promise<DBResult<WorkflowRow[]>> {
      return DB.All<WorkflowRow>('SELECT * FROM Workflows ORDER BY Weight ASC, WorkflowID ASC', []);
    },

    GetByID(WorkflowID: number): Promise<DBResult<WorkflowRow>> {
      return DB.Get<WorkflowRow>('SELECT * FROM Workflows WHERE WorkflowID = ?', [WorkflowID]);
    },

    Insert(Row: WorkflowWriteRow): Promise<DBResult<WorkflowWriteResult>> {
      return DB.Run(
        'INSERT INTO Workflows (Name, Description, Icon, Colour, Triggers, Steps, Return, Enabled, Weight, Timestamp, UpdatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          Row.Name,
          Row.Description,
          Row.Icon,
          Row.Colour,
          Row.Triggers,
          Row.Steps,
          Row.Return,
          Row.Enabled,
          Row.Weight,
          Row.Timestamp,
          Row.UpdatedAt,
        ]
      ) as Promise<DBResult<WorkflowWriteResult>>;
    },

    Update(
      WorkflowID: number,
      Row: Omit<WorkflowWriteRow, 'Timestamp'>
    ): Promise<DBResult<WorkflowWriteResult>> {
      return DB.Run(
        'UPDATE Workflows SET Name = ?, Description = ?, Icon = ?, Colour = ?, Triggers = ?, Steps = ?, Return = ?, Enabled = ?, Weight = ?, UpdatedAt = ? WHERE WorkflowID = ?',
        [
          Row.Name,
          Row.Description,
          Row.Icon,
          Row.Colour,
          Row.Triggers,
          Row.Steps,
          Row.Return,
          Row.Enabled,
          Row.Weight,
          Row.UpdatedAt,
          WorkflowID,
        ]
      ) as Promise<DBResult<WorkflowWriteResult>>;
    },

    UpdateSlug(WorkflowID: number, Slug: string | null): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE Workflows SET Slug = ? WHERE WorkflowID = ?', [Slug, WorkflowID]);
    },

    UpdateWeight(WorkflowID: number, Weight: number): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE Workflows SET Weight = ? WHERE WorkflowID = ?', [Weight, WorkflowID]);
    },

    Delete(WorkflowID: number): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM Workflows WHERE WorkflowID = ?', [WorkflowID]);
    },
  };
}
