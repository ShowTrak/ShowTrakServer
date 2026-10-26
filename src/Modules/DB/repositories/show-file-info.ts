// ShowFileInfo repository
// - Owns every SQL statement touching the `ShowFileInfo` table of the working
//   database. Reading the same facts from a .ShowTrak file on disk (before it
//   is opened) is DB.ReadFileInfo.
// - Writes never mark the show unsaved: they are bookkeeping stamped as part of
//   a save or a new show, not user edits.
import type { DBManager, DBResult } from '../index';

export function CreateShowFileInfoRepository(DB: DBManager) {
  return {
    Set(Key: string, Value: string): Promise<DBResult<unknown>> {
      return DB.Run(
        'INSERT OR REPLACE INTO ShowFileInfo (Key, Value) VALUES (?, ?)',
        [Key, Value],
        {
          markDirty: false,
        }
      );
    },
  };
}
