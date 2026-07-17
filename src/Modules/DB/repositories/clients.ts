// Clients-table repository. Receives the DB manager instead of importing it so
// test DB mocks injected into ClientManager propagate through unchanged.
// SQL strings are byte-identical to the historical inline statements — tests
// match on them.
import type { DBManager, DBResult } from '../index';
import type { ClientRow } from '../rows';

// The only client columns a setter is permitted to persist. `Column` is string-
// interpolated into the UPDATE (SQLite cannot bind an identifier), so it must be
// constrained to a fixed set here — this allowlist is that guard, not any
// entity-level validation. Mirrors the DB-backed setters in ClientManager/client.ts.
const UPDATABLE_CLIENT_COLUMNS: ReadonlySet<string> = new Set([
  'Nickname',
  'GroupID',
  'Hostname',
  'OperatingSystem',
  'MacAddress',
  'Version',
  'Weight',
  'IP',
  'RunOnLaunchScriptID',
  'RunOnLaunchDelaySeconds',
]);

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

    // Insert a reserved slot for hardware that does not exist yet. Unlike
    // Insert (which describes a real machine mid-adoption), every descriptive
    // column here is filler the operator is expected to overwrite — either by
    // editing the client or by replacing it with a real device, which clears
    // the Unassigned flag.
    InsertUnassigned(
      UUID: string,
      Nickname: string,
      OperatingSystem: string,
      Timestamp: number
    ): Promise<DBResult<unknown>> {
      return DB.Run(
        'INSERT INTO Clients (UUID, Nickname, Hostname, OperatingSystem, Version, IP, Unassigned, Timestamp) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
        [UUID, Nickname, Nickname, OperatingSystem, 'X.X.X', null, Timestamp]
      );
    },

    Delete(UUID: string): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM Clients WHERE UUID = ?', [UUID]);
    },

    MoveGroupToNoGroup(GroupID: number): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE Clients SET GroupID = NULL WHERE GroupID = ?', [GroupID]);
    },

    // Persist a single column of a client row. `Column` is interpolated (not
    // bindable), so it is checked against UPDATABLE_CLIENT_COLUMNS first — an
    // unknown name is refused rather than concatenated into the SQL.
    UpdateColumn(
      UUID: string,
      Column: string,
      Value: unknown,
      { markUnsaved = true }: { markUnsaved?: boolean } = {}
    ): Promise<DBResult<unknown>> {
      if (!UPDATABLE_CLIENT_COLUMNS.has(Column)) {
        return Promise.resolve([`Refusing to update unknown client column: ${Column}`, null]);
      }
      const Run =
        markUnsaved === false && typeof DB.RunWithoutDirtyTracking === 'function'
          ? DB.RunWithoutDirtyTracking.bind(DB)
          : DB.Run.bind(DB);
      return Run(`UPDATE Clients SET ${Column} = ? WHERE UUID = ?`, [Value, UUID]);
    },

    // Delete a client and every critical-entity row keyed to it, atomically.
    // The five statements ride one transaction so a partial failure can never
    // leave the client row gone but its critical rows orphaned (or vice versa).
    // Table SQL is inlined here — matching the ReplaceClientUUID precedent —
    // because cross-table transactions are owned by this repository. Returns [Err].
    DeleteClientCascade(UUID: string): Promise<DBResult<void>> {
      return DB.WithTransaction(async (run) => {
        const [usbErr] = await run('DELETE FROM CriticalUSBDevices WHERE UUID = ?', [UUID]);
        if (usbErr) throw usbErr;
        const [usbNameErr] = await run('DELETE FROM CriticalUSBDeviceNames WHERE UUID = ?', [UUID]);
        if (usbNameErr) throw usbNameErr;
        const [appErr] = await run('DELETE FROM CriticalApplications WHERE UUID = ?', [UUID]);
        if (appErr) throw appErr;
        const [displayErr] = await run('DELETE FROM CriticalDisplays WHERE UUID = ?', [UUID]);
        if (displayErr) throw displayErr;
        const [clientErr] = await run('DELETE FROM Clients WHERE UUID = ?', [UUID]);
        if (clientErr) throw clientErr;
      });
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
        // Clearing Unassigned here is what "fills" a reserved slot: the row
        // stops being a placeholder the moment real hardware takes its UUID.
        // It rides the same transaction so a slot can never be left flagged
        // against a device that has already claimed it.
        const [clientUpdateErr] = await run(
          'UPDATE Clients SET UUID = ?, Unassigned = 0 WHERE UUID = ?',
          [NewUUID, OldUUID]
        );
        if (clientUpdateErr) throw clientUpdateErr;

        const [criticalUSBErr] = await run('UPDATE CriticalUSBDevices SET UUID = ? WHERE UUID = ?', [
          NewUUID,
          OldUUID,
        ]);
        if (criticalUSBErr) throw criticalUSBErr;

        const [criticalUSBNameErr] = await run(
          'UPDATE CriticalUSBDeviceNames SET UUID = ? WHERE UUID = ?',
          [NewUUID, OldUUID]
        );
        if (criticalUSBNameErr) throw criticalUSBNameErr;

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
