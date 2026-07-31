// FreeKioskTerminals-table repository. Receives the DB manager instead of
// importing it so test DB mocks injected into FreeKioskManager propagate through
// unchanged, matching every other repository here.
import type { DBManager, DBResult } from '../index';
import type { FreeKioskTerminalRow } from '../rows';

export function CreateFreeKioskTerminalsRepository(DB: DBManager) {
  return {
    GetAll(): Promise<DBResult<FreeKioskTerminalRow[]>> {
      return DB.All<FreeKioskTerminalRow>('SELECT * FROM FreeKioskTerminals');
    },

    Insert(
      UUID: string,
      Nickname: string,
      Address: string,
      Port: number,
      ApiKey: string | null,
      Interval: number,
      TimeoutMs: number,
      Settings: string,
      GroupID: number | null,
      Weight: number,
      Slug: string | null,
      Timestamp: number
    ): Promise<DBResult<unknown>> {
      return DB.Run(
        'INSERT INTO FreeKioskTerminals (UUID, Nickname, Address, Port, ApiKey, Interval, TimeoutMs, Settings, GroupID, Weight, Slug, Timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          UUID,
          Nickname,
          Address,
          Port,
          ApiKey,
          Interval,
          TimeoutMs,
          Settings,
          GroupID,
          Weight,
          Slug,
          Timestamp,
        ]
      );
    },

    UpdateDetails(
      Nickname: string,
      Address: string,
      Port: number,
      Interval: number,
      TimeoutMs: number,
      Settings: string,
      GroupID: number | null,
      UUID: string
    ): Promise<DBResult<unknown>> {
      return DB.Run(
        'UPDATE FreeKioskTerminals SET Nickname = ?, Address = ?, Port = ?, Interval = ?, TimeoutMs = ?, Settings = ?, GroupID = ? WHERE UUID = ?',
        [Nickname, Address, Port, Interval, TimeoutMs, Settings, GroupID, UUID]
      );
    },

    // Separate from UpdateDetails so an edit that leaves the key field blank
    // means "unchanged" rather than "clear it" — the editor never receives the
    // stored key back, so it cannot resubmit it.
    UpdateApiKey(ApiKey: string | null, UUID: string): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE FreeKioskTerminals SET ApiKey = ? WHERE UUID = ?', [ApiKey, UUID]);
    },

    UpdateSlug(Slug: string, UUID: string): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE FreeKioskTerminals SET Slug = ? WHERE UUID = ?', [Slug, UUID]);
    },

    Delete(UUID: string): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM FreeKioskTerminals WHERE UUID = ?', [UUID]);
    },

    // Persist quietly (no dirty tracking) — a successful poll is observed
    // runtime state, not a user edit, and marking the show dirty every 30
    // seconds would prompt to save a document nobody changed. Falls back to Run
    // on DB stubs that don't implement RunWithoutDirtyTracking.
    SetLastSuccessAt(LastSuccessAt: number | null, UUID: string): Promise<DBResult<unknown>> {
      const Run =
        typeof DB.RunWithoutDirtyTracking === 'function'
          ? DB.RunWithoutDirtyTracking.bind(DB)
          : DB.Run.bind(DB);
      return Run('UPDATE FreeKioskTerminals SET LastSuccessAt = ? WHERE UUID = ?', [
        LastSuccessAt,
        UUID,
      ]);
    },

    // Group-ordering statements consumed via the Shared/group-ordering helper.
    SetGroupAndWeight(
      GroupID: number | null,
      Weight: number,
      UUID: string
    ): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE FreeKioskTerminals SET GroupID = ?, Weight = ? WHERE UUID = ?', [
        GroupID,
        Weight,
        UUID,
      ]);
    },

    ClearGroup(UUID: string): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE FreeKioskTerminals SET GroupID = ? WHERE UUID = ?', [null, UUID]);
    },
  };
}
