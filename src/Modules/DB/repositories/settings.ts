// Settings repository
// - Owns every SQL statement touching the `Settings` table.
// - Factory receives the DB manager (never imports '../index' at runtime) so
//   test-injected DB mocks in the managers propagate through unchanged.
import type { DBManager, DBResult } from '../index';
import type { SettingRow } from '../rows';

export function CreateSettingsRepository(DB: DBManager) {
  return {
    GetByKey(Key: string): Promise<DBResult<SettingRow>> {
      return DB.Get<SettingRow>('SELECT * FROM settings WHERE key = ?', [Key]);
    },
    Upsert(Key: string, Value: unknown): Promise<DBResult<unknown>> {
      return DB.Run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [Key, Value]);
    },
  };
}
