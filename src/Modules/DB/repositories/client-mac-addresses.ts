// ClientMacAddresses repository — every SQL statement touching the per-client
// MAC address table. Factory receives the DB manager (never imports '../index'
// at runtime) so test-injected DB mocks in ClientManager propagate through.
//
// Callers are expected to pass MacAddress already normalized (upper-case,
// colon-separated) via Modules/MacAddress — this repository does no formatting,
// mirroring how ScriptWhitelists leaves JSON parsing to its manager.
import type { DBManager, DBResult } from '../index';
import type { ClientMacAddressRow } from '../rows';

export function CreateClientMacAddressesRepository(DB: DBManager) {
  return {
    LoadAll(): Promise<DBResult<ClientMacAddressRow[]>> {
      return DB.All<ClientMacAddressRow>(
        'SELECT UUID, MacAddress, Source, InterfaceName, FirstSeen, LastSeen FROM ClientMacAddresses ORDER BY FirstSeen ASC, MacAddress ASC'
      );
    },

    GetForClient(UUID: string): Promise<DBResult<ClientMacAddressRow[]>> {
      return DB.All<ClientMacAddressRow>(
        'SELECT UUID, MacAddress, Source, InterfaceName, FirstSeen, LastSeen FROM ClientMacAddresses WHERE UUID = ? ORDER BY FirstSeen ASC, MacAddress ASC',
        [UUID]
      );
    },

    // Insert a newly seen address. Deliberately does nothing when the row
    // already exists: an address first added by hand must not be relabelled
    // 'Reported' (nor its FirstSeen rewritten) just because the client later
    // reported it. Touch() carries the liveness update instead.
    Add(
      UUID: string,
      MacAddress: string,
      Source: 'Reported' | 'Manual',
      InterfaceName: string | null,
      Timestamp: number,
      Options: { markUnsaved?: boolean } = {}
    ): Promise<DBResult<unknown>> {
      const Run = ResolveRun(DB, Options);
      return Run(
        'INSERT OR IGNORE INTO ClientMacAddresses (UUID, MacAddress, Source, InterfaceName, FirstSeen, LastSeen) VALUES (?, ?, ?, ?, ?, ?)',
        [UUID, MacAddress, Source, InterfaceName, Timestamp, Timestamp]
      );
    },

    // Refresh liveness for an address already on file. InterfaceName is only
    // overwritten when the caller has one, so a manual entry keeps its null
    // rather than flickering as the client roams between adapters.
    Touch(
      UUID: string,
      MacAddress: string,
      InterfaceName: string | null,
      Timestamp: number,
      Options: { markUnsaved?: boolean } = {}
    ): Promise<DBResult<unknown>> {
      const Run = ResolveRun(DB, Options);
      return Run(
        'UPDATE ClientMacAddresses SET LastSeen = ?, InterfaceName = COALESCE(?, InterfaceName) WHERE UUID = ? AND MacAddress = ?',
        [Timestamp, InterfaceName, UUID, MacAddress]
      );
    },

    Remove(UUID: string, MacAddress: string): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM ClientMacAddresses WHERE UUID = ? AND MacAddress = ?', [
        UUID,
        MacAddress,
      ]);
    },

    DeleteAllForClient(UUID: string): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM ClientMacAddresses WHERE UUID = ?', [UUID]);
    },
  };
}

// Ingest writes ride RunWithoutDirtyTracking so a client merely reporting the
// NICs it already had does not mark the workspace unsaved — matching how
// Hostname/OperatingSystem/MacAddress are persisted from SystemInfo.
function ResolveRun(DB: DBManager, { markUnsaved = true }: { markUnsaved?: boolean }) {
  return markUnsaved === false && typeof DB.RunWithoutDirtyTracking === 'function'
    ? DB.RunWithoutDirtyTracking.bind(DB)
    : DB.Run.bind(DB);
}
