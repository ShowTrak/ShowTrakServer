// Tags repository
// - Owns every SQL statement touching the `Tags` table.
// - Factory receives the DB manager (never imports '../index' at runtime) so
//   test-injected DB mocks in the manager propagate through unchanged.
// Scope is stored verbatim as a JSON string; parsing/serialising is the
// manager's responsibility, not the repository's (mirrors ScriptWhitelists).
import type { DBManager, DBResult } from '../index';
import type { TagRow } from '../rows';

export function CreateTagsRepository(DB: DBManager) {
  return {
    GetAll(): Promise<DBResult<TagRow[]>> {
      return DB.All<TagRow>('SELECT * FROM Tags ORDER BY Weight ASC, TagID ASC');
    },
    GetByID(TagID: number): Promise<DBResult<TagRow>> {
      return DB.Get<TagRow>('SELECT * FROM Tags WHERE TagID = ?', [TagID]);
    },
    GetAllIDs(): Promise<DBResult<Pick<TagRow, 'TagID'>[]>> {
      return DB.All<Pick<TagRow, 'TagID'>>('SELECT TagID FROM Tags ORDER BY Weight ASC, TagID ASC');
    },
    Insert(
      Slug: string,
      Colour: number,
      Icon: string,
      Display: string,
      Scope: string,
      Weight: number
    ): Promise<DBResult<unknown>> {
      return DB.Run(
        'INSERT INTO Tags (Slug, Colour, Icon, Display, Scope, Weight) VALUES (?, ?, ?, ?, ?, ?)',
        [Slug, Colour, Icon, Display, Scope, Weight]
      );
    },
    UpdateSlug(TagID: number, Slug: string): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE Tags SET Slug = ? WHERE TagID = ?', [Slug, TagID]);
    },
    UpdateColour(TagID: number, Colour: number): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE Tags SET Colour = ? WHERE TagID = ?', [Colour, TagID]);
    },
    UpdateIcon(TagID: number, Icon: string): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE Tags SET Icon = ? WHERE TagID = ?', [Icon, TagID]);
    },
    UpdateDisplay(TagID: number, Display: string): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE Tags SET Display = ? WHERE TagID = ?', [Display, TagID]);
    },
    UpdateScope(TagID: number, Scope: string): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE Tags SET Scope = ? WHERE TagID = ?', [Scope, TagID]);
    },
    UpdateWeight(TagID: number, Weight: number): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE Tags SET Weight = ? WHERE TagID = ?', [Weight, TagID]);
    },
    Delete(TagID: number): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM Tags WHERE TagID = ?', [TagID]);
    },
  };
}
