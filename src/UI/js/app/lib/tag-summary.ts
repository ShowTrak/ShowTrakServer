// Pure summary of a tag's membership scope.
//
// Extracted from 19-tag-manager.ts (which was a private function in an
// otherwise entirely DOM-bound module) so the one line the operator reads to
// understand what a tag covers can be tested.
//
// Tags are cross-cutting client collections used to target scripts and
// wake-on-LAN, so this line is how someone confirms a tag means what they
// think before firing an action at it.

import type { TagView } from '@showtrak/protocol';

/**
 * Describe a tag's scope in one phrase.
 *
 * Workspace short-circuits: a workspace tag covers every client, including ones
 * adopted later, so listing counts alongside it would understate its reach.
 */
export function SummarizeTagScope(Tag: TagView | null | undefined): string {
  const Scope = (Tag && Tag.Scope) || { Workspace: false, Groups: [], Clients: [] };
  if (Scope.Workspace) return 'All clients';

  const Parts: string[] = [];
  const GroupCount = Array.isArray(Scope.Groups) ? Scope.Groups.length : 0;
  const ClientCount = Array.isArray(Scope.Clients) ? Scope.Clients.length : 0;

  if (GroupCount) Parts.push(`${GroupCount} group${GroupCount === 1 ? '' : 's'}`);
  if (ClientCount) Parts.push(`${ClientCount} client${ClientCount === 1 ? '' : 's'}`);

  // An empty scope is a real and confusing state — a tag that exists but
  // targets nothing — so it has to say so rather than render blank.
  return Parts.length ? Parts.join(' + ') : 'No clients';
}
