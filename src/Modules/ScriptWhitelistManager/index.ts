// ScriptWhitelistManager
// - Owns the per-show whitelist deciding which clients/groups may run each
//   script. Scripts live on disk (machine-global); *access* to them is
//   show-specific, so it is stored in the DB (and therefore the .ShowTrak file).
// - A script with NO stored row is unrestricted (all clients). This is the
//   default for every script and is what lets a brand-new client automatically
//   inherit access to any script that has not been explicitly restricted.
// - Selecting "All Clients" in the editor is normalized to the no-row state, so
//   an unrestricted script never enumerates its clients and therefore keeps
//   admitting future clients. A restricted script stores an explicit scope; new
//   clients are only admitted if they fall inside a whitelisted *group*.
import { CreateLogger } from '../Logger';
import { Manager as DB } from '../DB';
import { CreateScriptWhitelistRepository } from '../DB/repositories/script-whitelists';
import type { ScriptWhitelistScope } from '@showtrak/protocol';

const Logger = CreateLogger('ScriptWhitelistManager');

const Repo = CreateScriptWhitelistRepository(DB);

// Minimal client shape needed to resolve access (avoids a ClientManager import
// cycle; callers pass already-resolved clients).
interface WhitelistClient {
  UUID: string;
  GroupID?: number | null;
}

// Coerce arbitrary parsed JSON into a well-formed scope. Groups are numeric
// (GroupID); Clients are string UUIDs. Anything malformed is dropped rather
// than throwing so a single bad row can never break script dispatch.
function NormalizeScope(Raw: unknown): ScriptWhitelistScope {
  const Obj = Raw && typeof Raw === 'object' ? (Raw as Record<string, unknown>) : {};
  const Groups: number[] = [];
  for (const Value of Array.isArray(Obj.Groups) ? Obj.Groups : []) {
    const N = Number(Value);
    if (Number.isFinite(N) && !Groups.includes(N)) Groups.push(N);
  }
  const Clients: string[] = [];
  for (const Value of Array.isArray(Obj.Clients) ? Obj.Clients : []) {
    const S = String(Value == null ? '' : Value).trim();
    if (S && !Clients.includes(S)) Clients.push(S);
  }
  return { Workspace: !!Obj.Workspace, Groups, Clients };
}

// Parse a stored Scope JSON string. Returns a normalized scope, or null when the
// text is unusable (treated by callers as "unrestricted" — fail open, since this
// governs running scripts on the operator's own machines, not a trust boundary).
function ParseScopeText(Text: string | null | undefined): ScriptWhitelistScope | null {
  if (typeof Text !== 'string' || !Text.trim()) return null;
  try {
    return NormalizeScope(JSON.parse(Text));
  } catch (Err) {
    Logger.warn('Failed to parse stored script whitelist scope; treating as unrestricted', Err);
    return null;
  }
}

const Manager = {
  // Pure access decision. `Scope` null/undefined OR Workspace:true → allowed.
  // Otherwise the client must match a whitelisted UUID or belong to a
  // whitelisted group. Exposed static so callers can resolve a batch against a
  // single fetched scope without re-reading the DB per client.
  IsClientAllowed(Scope: ScriptWhitelistScope | null | undefined, Client: WhitelistClient): boolean {
    if (!Scope || Scope.Workspace) return true;
    if (!Client || !Client.UUID) return false;
    if (Scope.Clients.includes(Client.UUID)) return true;
    if (Client.GroupID != null && Scope.Groups.includes(Number(Client.GroupID))) return true;
    return false;
  },

  // Fetch the effective scope for a script, or null when unrestricted (no row).
  async GetScope(ScriptID: string): Promise<ScriptWhitelistScope | null> {
    if (!ScriptID) return null;
    const [Err, Row] = await Repo.Get(ScriptID);
    if (Err) {
      Logger.error(`Failed to read whitelist for script ${ScriptID}`, Err);
      return null;
    }
    if (!Row) return null;
    return ParseScopeText(Row.Scope);
  },

  // Persist a script's whitelist. "All Clients" (Workspace:true) is stored as
  // the canonical no-row state so the script stays unrestricted for future
  // clients. Any other scope (including an empty one meaning "nobody") is stored
  // verbatim.
  async SetScope(ScriptID: string, Scope: unknown): Promise<void> {
    if (!ScriptID) return;
    const Normalized = NormalizeScope(Scope);
    if (Normalized.Workspace) {
      const [Err] = await Repo.Delete(ScriptID);
      if (Err) Logger.error(`Failed to clear whitelist for script ${ScriptID}`, Err);
      return;
    }
    const [Err] = await Repo.Set(ScriptID, JSON.stringify(Normalized), Date.now());
    if (Err) Logger.error(`Failed to save whitelist for script ${ScriptID}`, Err);
  },

  // Remove a script's whitelist row (script deleted).
  async DeleteForScript(ScriptID: string): Promise<void> {
    if (!ScriptID) return;
    const [Err] = await Repo.Delete(ScriptID);
    if (Err) Logger.error(`Failed to delete whitelist for script ${ScriptID}`, Err);
  },

  // Follow a script folder rename so its whitelist is not silently orphaned —
  // an orphaned (lost) whitelist would revert a restricted script back to "all
  // clients", so this is a correctness/safety fix, not just cleanup.
  async RenameScript(OldScriptID: string, NewScriptID: string): Promise<void> {
    if (!OldScriptID || !NewScriptID || OldScriptID === NewScriptID) return;
    const [Err] = await Repo.Rename(OldScriptID, NewScriptID);
    if (Err) Logger.error(`Failed to move whitelist ${OldScriptID} -> ${NewScriptID}`, Err);
  },

  // Map of ScriptID -> scope for every restricted script, used to decorate the
  // catalog push. Scripts absent from the map are unrestricted (all clients).
  async GetAllScopes(): Promise<Record<string, ScriptWhitelistScope>> {
    const [Err, Rows] = await Repo.LoadAll();
    if (Err) {
      Logger.error('Failed to load script whitelists', Err);
      return {};
    }
    const Out: Record<string, ScriptWhitelistScope> = {};
    for (const Row of Rows || []) {
      const Scope = ParseScopeText(Row.Scope);
      if (Scope) Out[Row.ScriptID] = Scope;
    }
    return Out;
  },

  // Return plain copies of the catalog entries, each with a `Whitelist` field
  // (the scope, or null when unrestricted). Copies rather than mutating the
  // ScriptManager's cached instances. Used by every SetScriptList push so the
  // UI can hide a script for non-whitelisted clients.
  async DecorateCatalog<T extends { ID?: unknown }>(
    Scripts: T[]
  ): Promise<Array<T & { Whitelist: ScriptWhitelistScope | null }>> {
    const Scopes = await Manager.GetAllScopes();
    return (Array.isArray(Scripts) ? Scripts : []).map((Script) => ({
      ...Script,
      Whitelist: (Script && Scopes[String((Script as { ID?: unknown }).ID)]) || null,
    }));
  },
};

export { Manager };
export type { WhitelistClient };
