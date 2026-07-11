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

    // Atomically re-key a client from OldUUID to NewUUID across the clients row,
    // all three critical-entity tables, and any AlertRules whose Scope/Actions
    // JSON references the old UUID. The whole change runs in one transaction so a
    // partial rename can never persist. `rewriteRuleUUID` rewrites one parsed
    // JSON value (a rule's Scope or Actions) — ClientManager owns the recursive
    // UUID-swap logic; this repository owns the multi-table SQL. Returns [Err].
    ReplaceClientUUID(
      OldUUID: string,
      NewUUID: string,
      rewriteRuleUUID: (value: unknown) => unknown
    ): Promise<DBResult<void>> {
      return DB.WithTransaction(async (run) => {
        const [clientUpdateErr] = await run('UPDATE Clients SET UUID = ? WHERE UUID = ?', [
          NewUUID,
          OldUUID,
        ]);
        if (clientUpdateErr) throw clientUpdateErr;

        const [criticalUSBErr] = await run('UPDATE CriticalUSBDevices SET UUID = ? WHERE UUID = ?', [
          NewUUID,
          OldUUID,
        ]);
        if (criticalUSBErr) throw criticalUSBErr;

        const [criticalAppErr] = await run('UPDATE CriticalApplications SET UUID = ? WHERE UUID = ?', [
          NewUUID,
          OldUUID,
        ]);
        if (criticalAppErr) throw criticalAppErr;

        const [criticalDisplayErr] = await run('UPDATE CriticalDisplays SET UUID = ? WHERE UUID = ?', [
          NewUUID,
          OldUUID,
        ]);
        if (criticalDisplayErr) throw criticalDisplayErr;

        const [rulesErr, RuleRows] = await DB.All<{
          RuleID: number;
          Scope: string | null;
          Actions: string | null;
        }>('SELECT RuleID, Scope, Actions FROM AlertRules', []);
        if (rulesErr) throw rulesErr;

        for (const Row of RuleRows || []) {
          const RuleID = Number(Row && Row.RuleID);
          if (!Number.isFinite(RuleID)) continue;

          let ParsedScope: unknown = null;
          let ParsedActions: unknown = null;

          try {
            ParsedScope = JSON.parse(Row && Row.Scope ? Row.Scope : '{}');
          } catch {
            ParsedScope = null;
          }
          try {
            ParsedActions = JSON.parse(Row && Row.Actions ? Row.Actions : '[]');
          } catch {
            ParsedActions = null;
          }

          const NextScope = ParsedScope ? rewriteRuleUUID(ParsedScope) : ParsedScope;
          const NextActions = ParsedActions ? rewriteRuleUUID(ParsedActions) : ParsedActions;

          const ScopeChanged =
            ParsedScope != null && JSON.stringify(NextScope) !== JSON.stringify(ParsedScope);
          const ActionsChanged =
            ParsedActions != null && JSON.stringify(NextActions) !== JSON.stringify(ParsedActions);

          if (!ScopeChanged && !ActionsChanged) continue;

          const [ruleUpdateErr] = await run(
            'UPDATE AlertRules SET Scope = ?, Actions = ?, UpdatedAt = ? WHERE RuleID = ?',
            [
              ScopeChanged ? JSON.stringify(NextScope) : Row.Scope,
              ActionsChanged ? JSON.stringify(NextActions) : Row.Actions,
              Date.now(),
              RuleID,
            ]
          );
          if (ruleUpdateErr) throw ruleUpdateErr;
        }
      });
    },
  };
}
