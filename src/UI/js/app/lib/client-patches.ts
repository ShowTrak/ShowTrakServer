// Live client changes, as the server pushes them (pure).
//
// The server batches client changes and sends each surface one ClientPatches
// message per flush: per client, its UUID and only the fields whose value
// changed since the last push, plus the names of any fields that went away
// (see src/Modules/Server/client-push.ts). The renderer keeps one merged
// client object per UUID and applies each patch to it in place, so every list
// that holds that object (the full list, the context menu's copy) sees it.
import type { ClientView } from '@showtrak/protocol';

export interface ClientPatch {
  UUID: string;
  $Removed?: string[];
  [Field: string]: unknown;
}

/** Apply one patch to the merged client, in place. */
export function ApplyClientPatch(Target: ClientView, Patch: ClientPatch): void {
  const Fields = Target as unknown as Record<string, unknown>;
  for (const Key of Object.keys(Patch)) {
    if (Key === '$Removed') continue;
    Fields[Key] = Patch[Key];
  }
  if (Array.isArray(Patch.$Removed)) {
    for (const Key of Patch.$Removed) delete Fields[Key];
  }
}

/**
 * Index a client list by UUID. The entries are the list's own objects, so a
 * patch applied through the index is visible through the list as well.
 */
export function IndexClients(Clients: readonly ClientView[]): Map<string, ClientView> {
  const Index = new Map<string, ClientView>();
  for (const Client of Clients) {
    if (Client && typeof Client.UUID === 'string') Index.set(Client.UUID, Client);
  }
  return Index;
}
