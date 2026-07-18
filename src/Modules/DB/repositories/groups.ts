// Groups repository
// - Owns every SQL statement touching the `Groups` table.
// - Factory receives the DB manager (never imports '../index' at runtime) so
//   test-injected DB mocks in the managers propagate through unchanged.
import type { DBManager, DBResult } from '../index';
import type { GroupRow } from '../rows';

export function CreateGroupsRepository(DB: DBManager) {
  return {
    GetAll(): Promise<DBResult<GroupRow[]>> {
      return DB.All<GroupRow>('SELECT * FROM Groups ORDER BY Weight ASC, GroupID ASC');
    },
    GetByID(GroupID: number): Promise<DBResult<GroupRow>> {
      return DB.Get<GroupRow>('SELECT * FROM Groups WHERE GroupID = ?', [GroupID]);
    },
    GetAllIDs(): Promise<DBResult<Pick<GroupRow, 'GroupID'>[]>> {
      return DB.All<Pick<GroupRow, 'GroupID'>>(
        'SELECT GroupID FROM Groups ORDER BY Weight ASC, GroupID ASC'
      );
    },
    Insert(Title: string, Weight: number): Promise<DBResult<unknown>> {
      return DB.Run('INSERT INTO Groups (Title, Weight) VALUES (?, ?)', [Title, Weight]);
    },
    UpdateTitle(GroupID: number, Title: string): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE Groups SET Title = ? WHERE GroupID = ?', [Title, GroupID]);
    },
    UpdateWeight(GroupID: number, Weight: number): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE Groups SET Weight = ? WHERE GroupID = ?', [Weight, GroupID]);
    },
    UpdateFullWidth(GroupID: number, FullWidth: number): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE Groups SET FullWidth = ? WHERE GroupID = ?', [FullWidth, GroupID]);
    },
    UpdateKeyBind(GroupID: number, KeyBind: string | null): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE Groups SET KeyBind = ? WHERE GroupID = ?', [KeyBind, GroupID]);
    },
    UpdateSlug(GroupID: number, Slug: string): Promise<DBResult<unknown>> {
      return DB.Run('UPDATE Groups SET Slug = ? WHERE GroupID = ?', [Slug, GroupID]);
    },
    Delete(GroupID: number): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM Groups WHERE GroupID = ?', [GroupID]);
    },
  };
}
