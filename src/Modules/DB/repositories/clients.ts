// Clients-table repository. Receives the DB manager instead of importing it so
// test DB mocks injected into ClientManager propagate through unchanged.
// SQL strings are byte-identical to the historical inline statements — tests
// match on them.
import type { DBManager, DBResult } from '../index';
import type { ClientRow } from '../rows';

export function CreateClientsRepository(DB: DBManager) {
  return {
    GetByUUID(UUID: string): Promise<DBResult<ClientRow>> {
      return DB.Get<ClientRow>('SELECT * FROM Clients WHERE UUID = ?', [UUID]);
    },

    GetAll(): Promise<DBResult<ClientRow[]>> {
      return DB.All<ClientRow>('SELECT * FROM Clients');
    },

    Insert(UUID: string, Timestamp: number): Promise<DBResult<unknown>> {
      return DB.Run(
        'INSERT INTO Clients (UUID, Hostname, OperatingSystem, Version, IP, Timestamp) VALUES (?, ?, ?, ?, ?, ?)',
        [UUID, 'ShowTrak Client', null, null, null, Timestamp]
      );
    },

    Delete(UUID: string): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM Clients WHERE UUID = ?', [UUID]);
    },

    MoveGroupToNoGroup(GroupID: number): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE Clients SET GroupID = NULL WHERE GroupID = ?', [GroupID]);
    },

    // Persist a single column of a client row. `Column` is interpolated (not
    // bindable), so callers must pass a known persisted-field name — the Client
    // entity validates this against its field map before calling.
    UpdateColumn(
      UUID: string,
      Column: string,
      Value: unknown,
      { markUnsaved = true }: { markUnsaved?: boolean } = {}
    ): Promise<DBResult<unknown>> {
      const Run =
        markUnsaved === false && typeof DB.RunWithoutDirtyTracking === 'function'
          ? DB.RunWithoutDirtyTracking.bind(DB)
          : DB.Run.bind(DB);
      return Run(`UPDATE Clients SET ${Column} = ? WHERE UUID = ?`, [Value, UUID]);
    },
  };
}
