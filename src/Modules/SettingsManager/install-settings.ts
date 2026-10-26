// Install-level settings store
// - Backs settings declared with Scope: 'INSTALL' (see DefaultSettings).
// - Lives in a JSON file under the app data Storage folder, NOT in the show
//   database, so the value belongs to this machine and survives opening,
//   importing or swapping show files.
// - Mirrors the Settings repository's GetByKey/Upsert shape so the
//   SettingsManager can use either store interchangeably.
import path from 'path';
import fs from 'fs';
import { Manager as AppDataManager } from '../AppData';
import type { DBResult } from '../DB';
import type { SettingRow } from '../DB/rows';

function DefaultFilePath(): string {
  return path.join(AppDataManager.GetStorageDirectory(), 'install-settings.json');
}

export function CreateInstallSettingsStore(GetFilePath: () => string = DefaultFilePath) {
  // An unreadable or corrupt file reads as empty (every install setting falls
  // back to its default) rather than failing, which would stop the whole
  // SettingsManager from initialising. The next write replaces it.
  function ReadAll(): Record<string, unknown> {
    try {
      const FilePath = GetFilePath();
      if (!fs.existsSync(FilePath)) return {};
      const Parsed = JSON.parse(fs.readFileSync(FilePath, 'utf8'));
      return Parsed && typeof Parsed === 'object' && !Array.isArray(Parsed) ? Parsed : {};
    } catch {
      return {};
    }
  }

  return {
    async GetByKey(Key: string): Promise<DBResult<SettingRow>> {
      const All = ReadAll();
      if (!Object.prototype.hasOwnProperty.call(All, Key)) return [null, null];
      return [null, { Key, Value: All[Key] }];
    },

    // Write to a temp file then rename, so a crash mid-write never leaves a
    // truncated file that would silently reset every install setting.
    async Upsert(Key: string, Value: unknown): Promise<DBResult<unknown>> {
      try {
        const FilePath = GetFilePath();
        const All = ReadAll();
        All[Key] = Value;
        fs.mkdirSync(path.dirname(FilePath), { recursive: true });
        const TempPath = `${FilePath}.tmp`;
        fs.writeFileSync(TempPath, JSON.stringify(All, null, 2), 'utf8');
        fs.renameSync(TempPath, FilePath);
        return [null, true];
      } catch (Err) {
        return [Err, null];
      }
    },
  };
}
