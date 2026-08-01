// Remote devices repository
// - Owns every SQL statement touching the `RemoteDevices` table.
// - Factory receives the DB manager (never imports '../index' at runtime) so
//   test-injected DB mocks in the manager propagate through unchanged.
// Tokens are only ever seen here as their SHA-256 hash; hashing is the manager's
// responsibility, not the repository's (mirrors Tags, where JSON parsing sits in
// the manager).
import type { DBManager, DBResult } from '../index';
import type { RemoteDeviceRow } from '../rows';

export function CreateRemoteDevicesRepository(DB: DBManager) {
  return {
    GetAll(): Promise<DBResult<RemoteDeviceRow[]>> {
      return DB.All<RemoteDeviceRow>('SELECT * FROM RemoteDevices ORDER BY PairedAt DESC');
    },
    GetByTokenHash(TokenHash: string): Promise<DBResult<RemoteDeviceRow>> {
      return DB.Get<RemoteDeviceRow>('SELECT * FROM RemoteDevices WHERE TokenHash = ?', [
        TokenHash,
      ]);
    },
    GetByID(DeviceID: string): Promise<DBResult<RemoteDeviceRow>> {
      return DB.Get<RemoteDeviceRow>('SELECT * FROM RemoteDevices WHERE DeviceID = ?', [DeviceID]);
    },
    Insert(
      DeviceID: string,
      TokenHash: string,
      DeviceName: string | null,
      Platform: string | null,
      PairedAt: number
    ): Promise<DBResult<unknown>> {
      return DB.Run(
        'INSERT INTO RemoteDevices (DeviceID, TokenHash, DeviceName, Platform, PairedAt, LastSeenAt) VALUES (?, ?, ?, ?, ?, NULL)',
        [DeviceID, TokenHash, DeviceName, Platform, PairedAt]
      );
    },
    // Touched on every successful handshake, so it is deliberately the narrowest
    // possible write — no read-modify-write, no other column touched.
    TouchLastSeen(DeviceID: string, LastSeenAt: number): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE RemoteDevices SET LastSeenAt = ? WHERE DeviceID = ?', [
        LastSeenAt,
        DeviceID,
      ]);
    },
    Delete(DeviceID: string): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM RemoteDevices WHERE DeviceID = ?', [DeviceID]);
    },
    DeleteAll(): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM RemoteDevices');
    },
  };
}
