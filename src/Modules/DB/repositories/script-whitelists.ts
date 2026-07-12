// Repository for the ScriptWhitelists table (per-show script access control).
// Receives the DB manager instead of importing it so test DB mocks injected
// into the manager propagate through unchanged (mirrors the other repos).
//
// A missing row means "unrestricted" (all clients) — callers treat a null Get()
// result as full access. Scope is stored verbatim as a JSON string; parsing is
// the manager's responsibility, not the repository's.
import type { DBManager, DBResult } from '../index';
import type { ScriptWhitelistRow } from '../rows';

export function CreateScriptWhitelistRepository(DB: DBManager) {
  return {
    LoadAll(): Promise<DBResult<ScriptWhitelistRow[]>> {
      return DB.All<ScriptWhitelistRow>(
        'SELECT ScriptID, Scope, UpdatedAt FROM ScriptWhitelists'
      );
    },
    Get(ScriptID: string): Promise<DBResult<ScriptWhitelistRow>> {
      return DB.Get<ScriptWhitelistRow>(
        'SELECT ScriptID, Scope, UpdatedAt FROM ScriptWhitelists WHERE ScriptID = ? LIMIT 1',
        [ScriptID]
      );
    },
    Set(ScriptID: string, Scope: string, UpdatedAt: number): Promise<DBResult<unknown>> {
      return DB.Run(
        'INSERT OR REPLACE INTO ScriptWhitelists (ScriptID, Scope, UpdatedAt) VALUES (?, ?, ?)',
        [ScriptID, Scope, UpdatedAt]
      );
    },
    Delete(ScriptID: string): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM ScriptWhitelists WHERE ScriptID = ?', [ScriptID]);
    },
    // Move a whitelist to a renamed script ID. REPLACE guards against a stale
    // row already sitting at the destination ID (e.g. a deleted-then-recreated
    // script). Returns without touching anything if the source has no row.
    Rename(OldScriptID: string, NewScriptID: string): Promise<DBResult<unknown>> {
      return DB.Run(
        'UPDATE OR REPLACE ScriptWhitelists SET ScriptID = ? WHERE ScriptID = ?',
        [NewScriptID, OldScriptID]
      );
    },
  };
}
