// DummyClients-table repository. Receives the DB manager instead of importing
// it so test DB mocks injected into DummyClientManager propagate through
// unchanged. SQL strings are byte-identical to the historical inline
// statements — tests match on them.
import type { DBManager, DBResult } from '../index';
import type { DummyClientRow } from '../rows';

export function CreateDummyClientsRepository(DB: DBManager) {
  return {
    GetAll(): Promise<DBResult<DummyClientRow[]>> {
      return DB.All<DummyClientRow>('SELECT * FROM DummyClients');
    },

    Insert(
      UUID: string,
      DummyID: string,
      Nickname: string,
      Interval: number,
      GroupID: number | null,
      Weight: number,
      Timestamp: number
    ): Promise<DBResult<unknown>> {
      return DB.Run(
        'INSERT INTO DummyClients (UUID, DummyID, Nickname, Interval, GroupID, Weight, Timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [UUID, DummyID, Nickname, Interval, GroupID, Weight, Timestamp]
      );
    },

    UpdateDetails(
      DummyID: string,
      Nickname: string,
      Interval: number,
      GroupID: number | null,
      UUID: string
    ): Promise<DBResult<unknown>> {
      return DB.Run(
        'UPDATE DummyClients SET DummyID = ?, Nickname = ?, Interval = ?, GroupID = ? WHERE UUID = ?',
        [DummyID, Nickname, Interval, GroupID, UUID]
      );
    },

    Delete(UUID: string): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM DummyClients WHERE UUID = ?', [UUID]);
    },

    // Persist quietly (no dirty tracking) — the IP is auto-discovered runtime
    // data, not a user edit to the show document. Falls back to Run on DB
    // stubs that don't implement RunWithoutDirtyTracking.
    SetIP(IP: string | null, UUID: string): Promise<DBResult<unknown>> {
      const Run =
        typeof DB.RunWithoutDirtyTracking === 'function'
          ? DB.RunWithoutDirtyTracking.bind(DB)
          : DB.Run.bind(DB);
      return Run('UPDATE DummyClients SET IP = ? WHERE UUID = ?', [IP, UUID]);
    },

    // Group-ordering statements consumed via the Shared/group-ordering helper.
    SetGroupAndWeight(
      GroupID: number | null,
      Weight: number,
      UUID: string
    ): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE DummyClients SET GroupID = ?, Weight = ? WHERE UUID = ?', [
        GroupID,
        Weight,
        UUID,
      ]);
    },

    ClearGroup(UUID: string): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE DummyClients SET GroupID = ? WHERE UUID = ?', [null, UUID]);
    },
  };
}
