// MonitoringTargets-table repository. Receives the DB manager instead of
// importing it so test DB mocks injected into MonitoringTargetManager
// propagate through unchanged. SQL strings are byte-identical to the
// historical inline statements — tests match on them.
import type { DBManager, DBResult } from '../index';
import type { MonitoringTargetRow } from '../rows';

export function CreateMonitoringTargetsRepository(DB: DBManager) {
  return {
    GetAll(): Promise<DBResult<MonitoringTargetRow[]>> {
      return DB.All<MonitoringTargetRow>('SELECT * FROM MonitoringTargets');
    },

    // Address/Settings/LastSuccessAt/DegradedThresholdMs are legacy columns on
    // the targets table (checks own the live values); new rows persist the
    // historical placeholder values.
    Insert(
      Nickname: string | null,
      Method: string,
      Interval: number,
      GroupID: number | null,
      Weight: number,
      Timestamp: number
    ): Promise<DBResult<{ lastID: number }>> {
      return DB.Run(
        'INSERT INTO MonitoringTargets (Nickname, Address, Method, Interval, Settings, GroupID, Weight, LastSuccessAt, DegradedThresholdMs, Timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [Nickname, '', Method, Interval, '{}', GroupID, Weight, null, 0, Timestamp]
      );
    },

    UpdateDetails(
      Nickname: string | null,
      Interval: number,
      GroupID: number | null,
      TargetID: number
    ): Promise<DBResult<unknown>> {
      return DB.Run(
        'UPDATE MonitoringTargets SET Nickname = ?, Interval = ?, GroupID = ? WHERE TargetID = ?',
        [Nickname, Interval, GroupID, TargetID]
      );
    },

    Delete(TargetID: number): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM MonitoringTargets WHERE TargetID = ?', [TargetID]);
    },

    // Group-ordering statements consumed via the Shared/group-ordering helper.
    SetGroupAndWeight(
      GroupID: number | null,
      Weight: number,
      TargetID: number
    ): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE MonitoringTargets SET GroupID = ?, Weight = ? WHERE TargetID = ?', [
        GroupID,
        Weight,
        TargetID,
      ]);
    },

    ClearGroup(TargetID: number): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE MonitoringTargets SET GroupID = ? WHERE TargetID = ?', [
        null,
        TargetID,
      ]);
    },
  };
}
