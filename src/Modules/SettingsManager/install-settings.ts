// Install-level settings store
// - Backs settings declared with Scope: 'INSTALL' (see DefaultSettings).
// - Lives in a JSON file under the app data Storage folder, NOT in the show
//   database, so the value belongs to this machine and survives opening,
//   importing or swapping show files.
// - Mirrors the Settings repository's GetByKey/GetAll/Upsert shape so the
//   SettingsManager can use either store interchangeably.
import path from 'path';
import fs from 'fs';
import { Manager as AppDataManager } from '../AppData';
import { ReplaceFileSync } from '@showtrak/protocol/runtime';
import { IsArray, IsObject } from '@showtrak/protocol/common';
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
      const Parsed: unknown = JSON.parse(fs.readFileSync(GetFilePath(), 'utf8'));
      return IsObject(Parsed) && !IsArray(Parsed) ? Parsed : {};
    } catch {
      return {};
    }
  }

  // Merge Values into the file. Written to a temp file then renamed, so a crash
  // mid-write never leaves a truncated file that would silently reset every
  // install setting.
  function WriteValues(Values: Record<string, unknown>): DBResult<unknown> {
    try {
      const All = { ...ReadAll(), ...Values };
      ReplaceFileSync(GetFilePath(), JSON.stringify(All, null, 2));
      return [null, true];
    } catch (Err) {
      return [Err, null];
    }
  }

  return {
    async GetByKey(Key: string): Promise<DBResult<SettingRow>> {
      const All = ReadAll();
      if (!Object.prototype.hasOwnProperty.call(All, Key)) return [null, null];
      return [null, { Key, Value: All[Key] }];
    },

    // Every stored value from a single read of the file.
    async GetAll(): Promise<DBResult<SettingRow[]>> {
      return [null, Object.entries(ReadAll()).map(([Key, Value]) => ({ Key, Value }))];
    },

    async Upsert(Key: string, Value: unknown): Promise<DBResult<unknown>> {
      return WriteValues({ [Key]: Value });
    },

    // Several values in one write (the first-run adoption of settings that
    // used to live in the show file).
    async UpsertMany(Values: Record<string, unknown>): Promise<DBResult<unknown>> {
      return WriteValues(Values);
    },
  };
}
