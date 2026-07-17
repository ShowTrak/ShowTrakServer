// MonitoringChecks-table repository. Receives the DB manager instead of
// importing it so test DB mocks injected into MonitoringTargetManager
// propagate through unchanged. SQL strings are byte-identical to the
// historical inline statements — tests match on them.
import type { DBManager, DBResult, TxRun } from '../index';
import type { MonitoringCheckRow } from '../rows';

export function CreateMonitoringChecksRepository(DB: DBManager) {
  return {
    GetAll(): Promise<DBResult<MonitoringCheckRow[]>> {
      return DB.All<MonitoringCheckRow>('SELECT * FROM MonitoringChecks');
    },

    // `run`, when supplied, enlists this insert in a caller-owned transaction so
    // a target and its checks commit (or roll back) as one unit; omitted, the
    // insert autocommits on its own (e.g. legacy-target migration during Init).
    Insert(
      TargetID: number,
      Name: string,
      Address: string,
      Method: string,
      Settings: string,
      DegradedThresholdMs: number,
      Weight: number,
      LastSuccessAt: number | null,
      Timestamp: number,
      run?: TxRun
    ): Promise<DBResult<{ lastID: number }>> {
      const Exec: TxRun = run ?? ((Query, Params) => DB.Run(Query, Params));
      return Exec(
        'INSERT INTO MonitoringChecks (TargetID, Name, Address, Method, Settings, DegradedThresholdMs, Weight, LastSuccessAt, Timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          TargetID,
          Name,
          Address,
          Method,
          Settings,
          DegradedThresholdMs,
          Weight,
          LastSuccessAt,
          Timestamp,
        ]
      );
    },

    UpdateDetails(
      Name: string,
      Address: string,
      Method: string,
      Settings: string,
      DegradedThresholdMs: number,
      Weight: number,
      CheckID: number
    ): Promise<DBResult<unknown>> {
      return DB.Run(
        'UPDATE MonitoringChecks SET Name = ?, Address = ?, Method = ?, Settings = ?, DegradedThresholdMs = ?, Weight = ? WHERE CheckID = ?',
        [Name, Address, Method, Settings, DegradedThresholdMs, Weight, CheckID]
      );
    },

    Delete(CheckID: number): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM MonitoringChecks WHERE CheckID = ?', [CheckID]);
    },

    // Normalize persisted checks that use a renamed monitoring method ID.
    RenameMethod(NewMethod: string, OldMethod: string): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE MonitoringChecks SET Method = ? WHERE Method = ?', [
        NewMethod,
        OldMethod,
      ]);
    },

    // Persist quietly (no dirty tracking) — LastSuccessAt is telemetry-driven
    // runtime data, not a user edit to the show document. Falls back to Run on
    // DB stubs that don't implement RunWithoutDirtyTracking.
    SetLastSuccessAt(Ts: number, CheckID: number): Promise<DBResult<unknown>> {
      const Run =
        typeof DB.RunWithoutDirtyTracking === 'function'
          ? DB.RunWithoutDirtyTracking.bind(DB)
          : DB.Run.bind(DB);
      return Run('UPDATE MonitoringChecks SET LastSuccessAt = ? WHERE CheckID = ?', [Ts, CheckID]);
    },
  };
}
