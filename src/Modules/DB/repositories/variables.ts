// Show Variables repository
// - Owns every SQL statement touching `Variables` and `ClientVariables`.
// - Factory receives the DB manager (never imports '../index' at runtime) so
//   test-injected DB mocks in the manager propagate through unchanged.
//
// Key normalization, prefixing and default-vs-override resolution are the
// manager's job; this layer stores and returns rows verbatim (mirrors Tags).
import type { DBManager, DBResult } from '../index';
import type { ClientVariableJoinRow, VariableRow } from '../rows';

export function CreateVariablesRepository(DB: DBManager) {
  return {
    GetAll(): Promise<DBResult<VariableRow[]>> {
      return DB.All<VariableRow>('SELECT * FROM Variables ORDER BY Weight ASC, VariableID ASC');
    },

    GetByID(VariableID: number): Promise<DBResult<VariableRow>> {
      return DB.Get<VariableRow>('SELECT * FROM Variables WHERE VariableID = ?', [VariableID]);
    },

    // Case-insensitive so the uniqueness check the manager runs before an insert
    // or rename matches what idx_variables_key will actually enforce.
    GetByKey(Key: string): Promise<DBResult<VariableRow>> {
      return DB.Get<VariableRow>('SELECT * FROM Variables WHERE Key = ? COLLATE NOCASE', [Key]);
    },

    Insert(
      Key: string,
      Description: string,
      DefaultValue: string,
      ExportToSystem: number,
      Weight: number,
      Timestamp: number
    ): Promise<DBResult<unknown>> {
      return DB.Run(
        'INSERT INTO Variables (Key, Description, DefaultValue, ExportToSystem, Weight, Timestamp) VALUES (?, ?, ?, ?, ?, ?)',
        [Key, Description, DefaultValue, ExportToSystem, Weight, Timestamp]
      );
    },

    UpdateKey(VariableID: number, Key: string): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE Variables SET Key = ? WHERE VariableID = ?', [Key, VariableID]);
    },

    UpdateDescription(VariableID: number, Description: string): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE Variables SET Description = ? WHERE VariableID = ?', [
        Description,
        VariableID,
      ]);
    },

    UpdateDefault(VariableID: number, DefaultValue: string): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE Variables SET DefaultValue = ? WHERE VariableID = ?', [
        DefaultValue,
        VariableID,
      ]);
    },

    UpdateExport(VariableID: number, ExportToSystem: number): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE Variables SET ExportToSystem = ? WHERE VariableID = ?', [
        ExportToSystem,
        VariableID,
      ]);
    },

    // Deleting a definition must take every client's override with it. SQLite
    // foreign keys are not enabled on this connection, so the cascade is
    // explicit — and transactional, because a definition that vanished while its
    // overrides survived would leave rows no UI can ever reach or clean up.
    Delete(VariableID: number): Promise<DBResult<void>> {
      return DB.WithTransaction(async (run) => {
        const [overrideErr] = await run('DELETE FROM ClientVariables WHERE VariableID = ?', [
          VariableID,
        ]);
        if (overrideErr) throw overrideErr;
        const [variableErr] = await run('DELETE FROM Variables WHERE VariableID = ?', [VariableID]);
        if (variableErr) throw variableErr;
      });
    },

    /**
     * Every definition with this client's override attached (NULL when it
     * inherits). A LEFT JOIN so a client that has overridden nothing still gets
     * the full list — the client editor renders one row per *definition*, not
     * one per override.
     */
    GetForClient(UUID: string): Promise<DBResult<ClientVariableJoinRow[]>> {
      return DB.All<ClientVariableJoinRow>(
        'SELECT V.*, CV.Value AS Value FROM Variables V \
         LEFT JOIN ClientVariables CV ON CV.VariableID = V.VariableID AND CV.UUID = ? \
         ORDER BY V.Weight ASC, V.VariableID ASC',
        [UUID]
      );
    },

    /** How many clients override each variable, for the manager's summary. */
    CountOverrides(): Promise<DBResult<{ VariableID: number; Overrides: number }[]>> {
      return DB.All<{ VariableID: number; Overrides: number }>(
        'SELECT VariableID, COUNT(*) AS Overrides FROM ClientVariables GROUP BY VariableID'
      );
    },

    SetClientValue(
      UUID: string,
      VariableID: number,
      Value: string,
      UpdatedAt: number
    ): Promise<DBResult<unknown>> {
      return DB.Run(
        'INSERT INTO ClientVariables (UUID, VariableID, Value, UpdatedAt) VALUES (?, ?, ?, ?) \
         ON CONFLICT(UUID, VariableID) DO UPDATE SET Value = excluded.Value, UpdatedAt = excluded.UpdatedAt',
        [UUID, VariableID, Value, UpdatedAt]
      );
    },

    /** Clearing an override is a delete, not an empty string — the client goes
     * back to inheriting the default, and must keep tracking it if it changes. */
    ClearClientValue(UUID: string, VariableID: number): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM ClientVariables WHERE UUID = ? AND VariableID = ?', [
        UUID,
        VariableID,
      ]);
    },

    /** Drop overrides whose client no longer exists. Run after opening a show
     * file recorded on a different rig, where UUIDs will not line up. */
    DeleteOrphaned(): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM ClientVariables WHERE UUID NOT IN (SELECT UUID FROM Clients)', []);
    },
  };
}
