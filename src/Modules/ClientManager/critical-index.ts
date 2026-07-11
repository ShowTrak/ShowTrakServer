// Shared per-client "critical entity" index for the ClientManager.
//
// USB devices, applications and displays each maintained a byte-for-byte
// parallel triple in index.ts: a `Map<clientUUID, Map<key, entry>>`, a
// `getCritical*MapForClient` accessor, an `applyCritical*State` projector, and
// a `loadCritical*Index` warm-up loader — differing only in the backing repo
// method, the row→entry projection, and which `SetCritical*` sink on the Client
// receives the collected entries. This factory captures that shared machinery
// (the `createGroupOrdering` pattern), leaving only the per-kind config inline.
//
// Behavior is identical to the original three implementations.
import type { DBResult } from '../DB';
import type { Client } from './client';

// The per-client projection of one DB row: which client owns it, the map key
// that dedupes it, and the entry object handed to the Client sink. Returning
// null skips a malformed row (matching the original `continue` guards).
export interface CriticalRowProjection<Entry> {
  UUID: string;
  Key: string;
  Entry: Entry;
}

export interface CriticalIndexConfig<Row, Entry> {
  /** Load every critical row across all clients (a CriticalRepo.LoadAll* call). */
  loadAll(): Promise<DBResult<Row[]>>;
  /** Project a DB row into a (UUID, Key, Entry) triple, or null to skip it. */
  fromRow(row: Row): CriticalRowProjection<Entry> | null;
  /** Push a client's collected entries onto the Client instance. */
  apply(client: Client, entries: Entry[]): void;
}

export interface CriticalIndex<Entry> {
  /** Raw `Map<clientUUID, Map<key, entry>>` for the Mark/Remove/rename paths. */
  readonly index: Map<string, Map<string, Entry>>;
  /** Per-client entry map, always created (the Mark path relies on this). */
  getForClient(UUID: unknown, createIfMissing: true): Map<string, Entry>;
  /** Per-client entry map; null when absent and not asked to create it. */
  getForClient(UUID: unknown, createIfMissing?: boolean): Map<string, Entry> | null;
  /** Upsert one entry into a client's map (creating the map if needed). */
  setForClient(UUID: unknown, Key: string, Entry: Entry): void;
  /** Remove one entry from a client's map, dropping the map when it empties. */
  removeForClient(UUID: unknown, Key: string): void;
  /** Drop a client's entire entry map (used when the client is deleted). */
  clearForClient(UUID: unknown): void;
  /** Move a client's whole entry map from one UUID to another (client replace). */
  rekeyClient(OldUUID: unknown, NewUUID: unknown): void;
  /** Re-derive the client's critical state from the index and apply it. */
  applyState(client: Client): void;
  /** Clear and reload the whole index from the database. */
  load(): Promise<void>;
  /** Empty the index (leaves the DB untouched). */
  clear(): void;
}

export function makeCriticalIndex<Row, Entry>(
  config: CriticalIndexConfig<Row, Entry>
): CriticalIndex<Entry> {
  const index = new Map<string, Map<string, Entry>>();

  function getForClient(UUID: unknown, createIfMissing: true): Map<string, Entry>;
  function getForClient(UUID: unknown, createIfMissing?: boolean): Map<string, Entry> | null;
  function getForClient(UUID: unknown, createIfMissing = false): Map<string, Entry> | null {
    const Key = String(UUID || '');
    let Existing = index.get(Key);
    if (!Existing && createIfMissing) {
      Existing = new Map<string, Entry>();
      index.set(Key, Existing);
    }
    return Existing || null;
  }

  function setForClient(UUID: unknown, Key: string, Entry: Entry): void {
    getForClient(UUID, true).set(Key, Entry);
  }

  function removeForClient(UUID: unknown, Key: string): void {
    const PerClient = getForClient(UUID, false);
    if (!PerClient) return;
    PerClient.delete(Key);
    if (PerClient.size === 0) index.delete(String(UUID || ''));
  }

  function clearForClient(UUID: unknown): void {
    index.delete(String(UUID || ''));
  }

  function rekeyClient(OldUUID: unknown, NewUUID: unknown): void {
    const OldKey = String(OldUUID || '');
    const Existing = index.get(OldKey);
    if (!Existing) return;
    index.set(String(NewUUID || ''), Existing);
    index.delete(OldKey);
  }

  function applyState(client: Client): void {
    if (!client || !client.UUID) return;
    const Entries = getForClient(client.UUID, false);
    config.apply(client, Entries ? Array.from(Entries.values()) : []);
  }

  async function load(): Promise<void> {
    index.clear();
    const [Err, Rows] = await config.loadAll();
    if (Err || !Rows) return;
    for (const Row of Rows) {
      const Projected = config.fromRow(Row);
      if (!Projected) continue;
      const PerClient = getForClient(Projected.UUID, true);
      if (!PerClient) continue;
      PerClient.set(Projected.Key, Projected.Entry);
    }
  }

  function clear(): void {
    index.clear();
  }

  return {
    index,
    getForClient,
    setForClient,
    removeForClient,
    clearForClient,
    rekeyClient,
    applyState,
    load,
    clear,
  };
}
