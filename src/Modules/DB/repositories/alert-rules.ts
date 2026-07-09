// Typed data access for the AlertRules table. Constructed as a factory that
// receives the DB manager so test-injected DB mocks propagate through
// unchanged (repositories must never import '../index' at runtime).

import type { DBManager, DBResult } from '../index';
import type { AlertRuleRow } from '../rows';

// Result shape sqlite3 resolves for write statements.
export interface AlertRuleWriteResult {
  lastID: number;
  changes: number;
}

// Persisted (already stringified) column values for an AlertRules row,
// minus the auto-assigned RuleID.
export interface AlertRuleWriteRow {
  Title: string;
  Scope: string;
  TriggerType: string;
  TriggerConfig: string;
  Actions: string;
  Enabled: number;
  Timestamp: number;
  UpdatedAt: number;
}

export function CreateAlertRulesRepository(DB: DBManager) {
  return {
    GetAll(): Promise<DBResult<AlertRuleRow[]>> {
      return DB.All<AlertRuleRow>('SELECT * FROM AlertRules ORDER BY RuleID DESC', []);
    },

    Insert(Row: AlertRuleWriteRow): Promise<DBResult<AlertRuleWriteResult>> {
      return DB.Run(
        'INSERT INTO AlertRules (Title, Scope, TriggerType, TriggerConfig, Actions, Enabled, Timestamp, UpdatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          Row.Title,
          Row.Scope,
          Row.TriggerType,
          Row.TriggerConfig,
          Row.Actions,
          Row.Enabled,
          Row.Timestamp,
          Row.UpdatedAt,
        ]
      );
    },

    Update(
      RuleID: number,
      Row: Omit<AlertRuleWriteRow, 'Timestamp'>
    ): Promise<DBResult<AlertRuleWriteResult>> {
      return DB.Run(
        'UPDATE AlertRules SET Title = ?, Scope = ?, TriggerType = ?, TriggerConfig = ?, Actions = ?, Enabled = ?, UpdatedAt = ? WHERE RuleID = ?',
        [
          Row.Title,
          Row.Scope,
          Row.TriggerType,
          Row.TriggerConfig,
          Row.Actions,
          Row.Enabled,
          Row.UpdatedAt,
          RuleID,
        ]
      );
    },

    Delete(RuleID: number): Promise<DBResult<AlertRuleWriteResult>> {
      return DB.Run('DELETE FROM AlertRules WHERE RuleID = ?', [RuleID]);
    },
  };
}
