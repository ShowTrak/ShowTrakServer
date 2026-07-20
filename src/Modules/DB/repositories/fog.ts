// FOG Project repository
// - Owns every SQL statement touching the `FogHosts` and `FogTasks` tables.
// - Factory receives the DB manager (never imports '../index' at runtime) so
//   test-injected DB mocks in the manager propagate through unchanged.
// No HTTP, no FOG semantics: this layer only stores and retrieves rows. Matching
// polled FOG tasks back onto our records is the manager's job.
import type { DBManager, DBResult } from '../index';
import type { FogHostRow, FogTaskRow } from '../rows';

export function CreateFogRepository(DB: DBManager) {
  return {
    // ---- Host links -------------------------------------------------------
    GetAllHostLinks(): Promise<DBResult<FogHostRow[]>> {
      return DB.All<FogHostRow>('SELECT * FROM FogHosts');
    },
    GetHostLink(UUID: string): Promise<DBResult<FogHostRow>> {
      return DB.Get<FogHostRow>('SELECT * FROM FogHosts WHERE UUID = ?', [UUID]);
    },
    GetHostLinkByFogHostID(FogHostID: number): Promise<DBResult<FogHostRow>> {
      return DB.Get<FogHostRow>('SELECT * FROM FogHosts WHERE FogHostID = ?', [FogHostID]);
    },
    // UUID is the PK, so this both creates and re-points a link in one statement.
    UpsertHostLink(
      UUID: string,
      FogHostID: number,
      FogHostName: string | null,
      Timestamp: number
    ): Promise<DBResult<unknown>> {
      return DB.Run(
        'INSERT OR REPLACE INTO FogHosts (UUID, FogHostID, FogHostName, Timestamp) VALUES (?, ?, ?, ?)',
        [UUID, FogHostID, FogHostName, Timestamp]
      );
    },
    DeleteHostLink(UUID: string): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM FogHosts WHERE UUID = ?', [UUID]);
    },

    // ---- Tasks ------------------------------------------------------------
    GetAllTasks(): Promise<DBResult<FogTaskRow[]>> {
      return DB.All<FogTaskRow>('SELECT * FROM FogTasks ORDER BY CreatedAt DESC');
    },
    GetTask(FogTaskRecordID: number): Promise<DBResult<FogTaskRow>> {
      return DB.Get<FogTaskRow>('SELECT * FROM FogTasks WHERE FogTaskRecordID = ?', [
        FogTaskRecordID,
      ]);
    },
    // Tasks still in a non-terminal state (see FOG_TASK_STATES): these are the ones
    // the poller tries to match against /fog/task/active.
    GetOpenTasks(): Promise<DBResult<FogTaskRow[]>> {
      return DB.All<FogTaskRow>(
        'SELECT * FROM FogTasks WHERE StateID IN (0, 1, 2, 3) ORDER BY CreatedAt ASC'
      );
    },
    InsertTask(
      UUID: string | null,
      FogHostID: number,
      FogHostName: string | null,
      TaskTypeID: number,
      TaskTypeName: string | null,
      Timestamp: number
    ): Promise<DBResult<unknown>> {
      // StateID starts at 0 ("Pending"): FOG's create endpoint returns no task ID
      // and no state, so the row is a placeholder until the first poll reconciles it.
      return DB.Run(
        'INSERT INTO FogTasks (UUID, FogHostID, FogHostName, FogTaskID, TaskTypeID, TaskTypeName, StateID, Percent, LastError, CreatedAt, UpdatedAt) \
         VALUES (?, ?, ?, NULL, ?, ?, 0, NULL, NULL, ?, ?)',
        [UUID, FogHostID, FogHostName, TaskTypeID, TaskTypeName, Timestamp, Timestamp]
      );
    },
    UpdateTaskProgress(
      FogTaskRecordID: number,
      FogTaskID: number | null,
      StateID: number,
      Percent: string | null,
      Timestamp: number
    ): Promise<DBResult<unknown>> {
      return DB.Run(
        'UPDATE FogTasks SET FogTaskID = ?, StateID = ?, Percent = ?, UpdatedAt = ? WHERE FogTaskRecordID = ?',
        [FogTaskID, StateID, Percent, Timestamp, FogTaskRecordID]
      );
    },
    SetTaskError(
      FogTaskRecordID: number,
      LastError: string | null,
      Timestamp: number
    ): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE FogTasks SET LastError = ?, UpdatedAt = ? WHERE FogTaskRecordID = ?', [
        LastError,
        Timestamp,
        FogTaskRecordID,
      ]);
    },
    DeleteTask(FogTaskRecordID: number): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM FogTasks WHERE FogTaskRecordID = ?', [FogTaskRecordID]);
    },
    // Age-based pruning of finished tasks. Open tasks are never pruned, however old,
    // because a queued FOG task can legitimately sit waiting for days until the host
    // next boots.
    PruneFinishedTasksBefore(Timestamp: number): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM FogTasks WHERE StateID NOT IN (0, 1, 2, 3) AND UpdatedAt < ?', [
        Timestamp,
      ]);
    },
  };
}
