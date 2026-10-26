// One kind of monitored ("critical") thing on a client: USB devices by serial,
// USB devices by name, applications, displays, audio endpoints, network
// interfaces.
//
// Every kind is the same structure: a per-client list of entries, each stored
// under one identity, held in three places that must agree: the DB side table,
// the manager's warm index (./critical-index) and the Client entity's own array,
// from which its renderer view is rebuilt. Each kind used to carry its own copy
// of the code keeping those in step, and the copies had begun to drift (some
// gained an Is* lookup, others did not). A CriticalKind names only what differs:
// how an identity is normalised, how an entry is read back, and the words used
// in an operator-facing error. The helpers below do the rest.
//
// What a kind MEANS (how a mark request resolves its conditions, how a reported
// item is matched and judged) stays in that kind's own module; this file only
// owns the bookkeeping.
import type { CriticalRowProjection } from './critical-index';

export interface CriticalKind<Entry> {
  /** The identity an entry is stored under. */
  KeyOf(Entry: Entry): string;
  /** A request's or a row's identity, normalised; null when it carries none. */
  NormalizeKey(Raw: unknown): string | null;
  /** A whole entry from a stored row or a client-side record; null when unusable. */
  NormalizeEntry(Raw: unknown): Entry | null;
  /** Operator-facing wording. */
  Messages: {
    /** A request named nothing usable. */
    KeyRequired: string;
    SaveFailed: string;
    RemoveFailed: string;
    LookupFailed: string;
  };
}

// --- The Client's own list -----------------------------------------------------
// Plain arrays in, plain arrays out: the Client entity is broadcast as data, so
// it holds no helper objects of its own.

/** A stored or pushed list, normalised and de-duplicated (the first of a key wins). */
export function CriticalListFrom<Entry>(Kind: CriticalKind<Entry>, Raw: unknown): Entry[] {
  const Out: Entry[] = [];
  const Seen = new Set<string>();
  for (const Item of Array.isArray(Raw) ? Raw : []) {
    const Entry = Kind.NormalizeEntry(Item);
    if (!Entry) continue;
    const Key = Kind.KeyOf(Entry);
    if (Seen.has(Key)) continue;
    Seen.add(Key);
    Out.push(Entry);
  }
  return Out;
}

export function HasCriticalEntry<Entry>(
  Kind: CriticalKind<Entry>,
  List: readonly Entry[],
  RawKey: unknown
): boolean {
  const Key = Kind.NormalizeKey(RawKey);
  return !!Key && List.some((Entry) => Kind.KeyOf(Entry) === Key);
}

/** The list with one entry added, or replacing the entry under the same key. Null when the entry is unusable. */
export function WithCriticalEntry<Entry>(
  Kind: CriticalKind<Entry>,
  List: readonly Entry[],
  Raw: unknown
): { List: Entry[]; Added: boolean } | null {
  const Entry = Kind.NormalizeEntry(Raw);
  if (!Entry) return null;
  const Key = Kind.KeyOf(Entry);
  const Index = List.findIndex((Existing) => Kind.KeyOf(Existing) === Key);
  if (Index === -1) return { List: [...List, Entry], Added: true };
  const Next = [...List];
  Next[Index] = Entry;
  return { List: Next, Added: false };
}

/** The list without the entry under a key, or null when there was none to remove. */
export function WithoutCriticalEntry<Entry>(
  Kind: CriticalKind<Entry>,
  List: readonly Entry[],
  RawKey: unknown
): Entry[] | null {
  const Key = Kind.NormalizeKey(RawKey);
  if (!Key) return null;
  const Next = List.filter((Entry) => Kind.KeyOf(Entry) !== Key);
  return Next.length === List.length ? null : Next;
}

// --- The manager's warm index ----------------------------------------------------

/** Project a stored row into the index: which client owns it, its key and its entry. */
export function ProjectCriticalRow<Entry>(
  Kind: CriticalKind<Entry>,
  Row: { UUID?: unknown } | null | undefined
): CriticalRowProjection<Entry> | null {
  const UUID = Row && Row.UUID ? String(Row.UUID) : '';
  const Entry = Kind.NormalizeEntry(Row);
  if (!UUID || !Entry) return null;
  return { UUID, Key: Kind.KeyOf(Entry), Entry };
}
