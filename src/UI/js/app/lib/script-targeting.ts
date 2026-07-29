// Pure targeting rules for offering a script to a client.
//
// Extracted from wire-context-menu.ts so the two conditions that decide whether
// a script appears against a machine can be tested without a DOM or a context
// menu. The menu construction stays where it was; these keep the decision.
//
// Worth being explicit about what this is and is not: the AUTHORITATIVE
// whitelist gate lives server-side in ScriptWhitelistManager.IsClientAllowed.
// This copy exists so a client that is not permitted never appears in the menu
// in the first place — it is a usability guard, not the security boundary. It
// still matters: a script offered against the wrong machine is a script an
// operator will run on the wrong machine.

import type { ClientView, ScriptWhitelistScope, TagView } from '@showtrak/protocol';
import { ScopeCoversEntity } from './scope-matching';

/**
 * Whether a client is admitted by a script's per-show whitelist.
 *
 * An absent scope, or `Workspace: true`, means unrestricted — that is the
 * default for a script nobody has narrowed. Otherwise the client must be named
 * directly, belong to a whitelisted group, or carry a whitelisted tag.
 *
 * `Tags` is the full tag list, needed only to expand a tag-based whitelist
 * (tags nest). Omitting it under-matches such a whitelist, which here hides a
 * script the client may in fact run — so callers pass it.
 */
export function IsClientWhitelisted(
  Scope: ScriptWhitelistScope | null | undefined,
  Client: Pick<ClientView, 'UUID' | 'GroupID'> | null | undefined,
  Tags?: TagView[] | null
): boolean {
  if (!Scope || Scope.Workspace) return true;
  if (!Client || !Client.UUID) return false;
  return ScopeCoversEntity(
    Scope,
    { ScopedID: String(Client.UUID), GroupID: Client.GroupID ?? null },
    Tags
  );
}

/**
 * Whether a script can run on this client at all: its OS must be supported AND
 * the whitelist must admit it.
 *
 * Both conditions are required. Dropping either produces a menu entry that
 * either fails on execution (wrong OS) or runs somewhere it was explicitly
 * restricted away from.
 */
export function IsScriptTargetable(
  Script: { CompatiblePlatforms?: unknown; Whitelist?: ScriptWhitelistScope | null },
  Client: Pick<ClientView, 'UUID' | 'GroupID' | 'OperatingSystem'> | null | undefined,
  Tags?: TagView[] | null
): boolean {
  if (!Client || !Client.OperatingSystem) return false;
  const Compatible = Array.isArray(Script && Script.CompatiblePlatforms)
    ? (Script.CompatiblePlatforms as string[])
    : [];
  if (!Compatible.includes(Client.OperatingSystem)) return false;
  return IsClientWhitelisted(Script && Script.Whitelist, Client, Tags);
}

/**
 * The subset of clients a script may be dispatched to.
 *
 * An empty result means the script is not offered at all, rather than offered
 * and then silently doing nothing.
 */
export function ResolveScriptTargets(
  Script: { CompatiblePlatforms?: unknown; Whitelist?: ScriptWhitelistScope | null },
  Clients: Array<Pick<ClientView, 'UUID' | 'GroupID' | 'OperatingSystem'>> | null | undefined,
  Tags?: TagView[] | null
): string[] {
  return (Array.isArray(Clients) ? Clients : [])
    .filter((Client) => IsScriptTargetable(Script, Client, Tags))
    .map((Client) => Client.UUID);
}
