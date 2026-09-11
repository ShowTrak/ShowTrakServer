// MonitoringActionFavourites-table repository. Receives the DB manager instead
// of importing it so test DB mocks injected into the manager propagate through
// unchanged, matching every other repository in this folder.
import type { DBManager, DBResult } from '../index';
import type { MonitoringActionFavouriteRow } from '../rows';

export function CreateMonitoringActionFavouritesRepository(DB: DBManager) {
  return {
    GetAll(): Promise<DBResult<MonitoringActionFavouriteRow[]>> {
      return DB.All<MonitoringActionFavouriteRow>(
        'SELECT * FROM MonitoringActionFavourites ORDER BY Weight ASC, FavouriteID ASC'
      );
    },

    // A favourite's identity is its method + action + parameters, and the unique
    // index enforces that. INSERT OR IGNORE therefore makes starring idempotent
    // without a read-then-write race: pressing the star twice leaves one row.
    Insert(
      Method: string,
      ActionID: string,
      Params: string,
      Weight: number,
      Timestamp: number
    ): Promise<DBResult<{ lastID: number }>> {
      return DB.Run(
        'INSERT OR IGNORE INTO MonitoringActionFavourites (Method, ActionID, Params, Weight, Timestamp) VALUES (?, ?, ?, ?, ?)',
        [Method, ActionID, Params, Weight, Timestamp]
      );
    },

    DeleteByIdentity(Method: string, ActionID: string, Params: string): Promise<DBResult<unknown>> {
      return DB.Run(
        'DELETE FROM MonitoringActionFavourites WHERE Method = ? AND ActionID = ? AND Params = ?',
        [Method, ActionID, Params]
      );
    },

    // Used when a method or one of its actions is removed: a favourite pointing
    // at something that no longer exists would render as a dead menu entry.
    Delete(FavouriteID: number): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM MonitoringActionFavourites WHERE FavouriteID = ?', [FavouriteID]);
    },
  };
}
