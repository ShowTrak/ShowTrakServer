// MonitoringTargets-table repository. Receives the DB manager instead of
// importing it so test DB mocks injected into MonitoringTargetManager
// propagate through unchanged. SQL strings are byte-identical to the
// historical inline statements — tests match on them.
import type { DBManager, DBResult, TxRun } from '../index';
import type { MonitoringTargetRow } from '../rows';

export function CreateMonitoringTargetsRepository(DB: DBManager) {
  return {
    GetAll(): Promise<DBResult<MonitoringTargetRow[]>> {
      return DB.All<MonitoringTargetRow>('SELECT * FROM MonitoringTargets');
    },

    // Address/Settings/LastSuccessAt/DegradedThresholdMs are legacy columns on
    // the targets table (checks own the live values); new rows persist the
    // historical placeholder values.
    // `run`, when supplied, enlists this insert in a caller-owned transaction so
    // the target and its checks commit (or roll back) as one unit.
    Insert(
      Nickname: string | null,
      Method: string,
      Interval: number,
      GroupID: number | null,
      Weight: number,
      Timestamp: number,
      run?: TxRun
    ): Promise<DBResult<{ lastID: number }>> {
      const Exec: TxRun = run ?? ((Query, Params) => DB.Run(Query, Params));
      return Exec(
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

    // Delete a monitoring target and every check row keyed to it, atomically.
    // Both statements ride one transaction so a partial failure can never leave
    // the target row gone with its checks orphaned (or vice versa). Cross-table
    // SQL is inlined here — matching the DeleteClientCascade precedent — because
    // the target repository owns the target→checks cascade. Returns [Err].
    DeleteTargetCascade(TargetID: number): Promise<DBResult<void>> {
      return DB.WithTransaction(async (run) => {
        const [checksErr] = await run('DELETE FROM MonitoringChecks WHERE TargetID = ?', [TargetID]);
        if (checksErr) throw checksErr;
        const [targetErr] = await run('DELETE FROM MonitoringTargets WHERE TargetID = ?', [TargetID]);
        if (targetErr) throw targetErr;
      });
    },

    UpdateSlug(Slug: string, TargetID: number): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE MonitoringTargets SET Slug = ? WHERE TargetID = ?', [Slug, TargetID]);
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
