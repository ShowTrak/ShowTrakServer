// Shared group-ordering behavior for list-backed managers.
//
// DummyClientManager and MonitoringTargetManager kept byte-for-byte identical
// implementations of SetGroupAndWeight / MoveGroupToNoGroup /
// ReconcileOrphanedGroups, differing only in the backing table, key column,
// in-memory list, list-changed event and error wording. This factory captures
// that shared behavior so the logic lives in one place.
//
// Behavior is identical to the original inline implementations.
import { Ok, Fail } from '../Utils';
import type { Result } from '../../types/result';
import type { DBManager } from '../DB';

export interface GroupOrderingEntity {
  GroupID: number | null;
  Weight: number;
}

export interface GroupOrderingLabels {
  notFound: string;
  update: string;
  move: string;
  reconcile: string;
}

// Repository-backed persistence for the two group-ordering statements. When
// provided, these are used instead of building SQL from table/keyColumn, so
// the SQL lives in the caller's DB repository module.
export interface GroupOrderingQueries {
  /** UPDATE <table> SET GroupID = ?, Weight = ? WHERE <keyColumn> = ? */
  SetGroupAndWeight(
    GroupID: number | null,
    Weight: number,
    Key: unknown
  ): Promise<[unknown, unknown]>;
  /** UPDATE <table> SET GroupID = ? WHERE <keyColumn> = ? (GroupID bound to null) */
  ClearGroup(Key: unknown): Promise<[unknown, unknown]>;
}

export interface GroupOrderingConfig {
  /** DB manager (injected so unit tests can mock it). */
  DB: DBManager;
  /** Broadcast manager (injected for the same reason). */
  BroadcastManager: { emit(event: string): void };
  /** SQL table name (constant, not user input). */
  table: string;
  /** Primary key column name (constant). */
  keyColumn: string;
  /** Returns the live in-memory entity array. */
  getList(): GroupOrderingEntity[];
  /** Returns an entity's key value (matches keyColumn). */
  getKey(entity: GroupOrderingEntity): unknown;
  /** Canonicalizes an incoming key (default: identity). */
  normalizeKey?: (value: unknown) => unknown;
  /** Repository-backed persistence; falls back to inline SQL when omitted. */
  queries?: GroupOrderingQueries;
  /** BroadcastManager event emitted after a change. */
  listChangedEvent: string;
  /** Optional async guard that warms the cache. */
  ensureInitialized?: () => Promise<void> | void;
  /** Error messages. */
  labels: GroupOrderingLabels;
}

export function createGroupOrdering(config: GroupOrderingConfig) {
  const {
    DB,
    BroadcastManager,
    table,
    keyColumn,
    getList,
    getKey,
    normalizeKey = (value: unknown) => value,
    queries,
    listChangedEvent,
    ensureInitialized,
    labels,
  } = config;

  const setGroupSql = `UPDATE ${table} SET GroupID = ?, Weight = ? WHERE ${keyColumn} = ?`;
  const clearGroupSql = `UPDATE ${table} SET GroupID = ? WHERE ${keyColumn} = ?`;

  // Prefer the caller's repository methods; otherwise persist with the inline
  // SQL built above (identical statements either way).
  const RunSetGroupAndWeight = (GroupID: number | null, Weight: number, Key: unknown) =>
    queries
      ? queries.SetGroupAndWeight(GroupID, Weight, Key)
      : DB.Run(setGroupSql, [GroupID, Weight, Key]);
  const RunClearGroup = (Key: unknown) =>
    queries ? queries.ClearGroup(Key) : DB.Run(clearGroupSql, [null, Key]);

  // Move an entity to a group with a specific weight (used by drag/drop ordering).
  async function SetGroupAndWeight(
    RawKey: unknown,
    GroupID: number | null,
    Weight: unknown
  ): Promise<Result<boolean>> {
    const Key = normalizeKey(RawKey);
    const Entity = getList().find((E) => getKey(E) === Key);
    if (!Entity) return Fail(labels.notFound);
    const NextGroupID = GroupID == null ? null : Number(GroupID);
    const NextWeight = Number.isFinite(Number(Weight)) ? Number(Weight) : 100;
    const [Err] = await RunSetGroupAndWeight(NextGroupID, NextWeight, Key);
    if (Err) return Fail(labels.update);
    Entity.GroupID = NextGroupID;
    Entity.Weight = NextWeight;
    return Ok(true);
  }

  // Move all entities in a group into the default no-group bucket (null).
  async function MoveGroupToNoGroup(GroupID: unknown): Promise<Result<number>> {
    if (ensureInitialized) await ensureInitialized();
    const TargetGroupID = Number(GroupID);
    if (!Number.isFinite(TargetGroupID)) return Fail('Invalid GroupID');

    let Changed = 0;
    for (const Entity of getList()) {
      if (Entity.GroupID == null) continue;
      if (Number(Entity.GroupID) !== TargetGroupID) continue;
      const [Err] = await RunClearGroup(getKey(Entity));
      if (Err) return Fail(labels.move);
      Entity.GroupID = null;
      Changed += 1;
    }

    if (Changed > 0) BroadcastManager.emit(listChangedEvent);
    return Ok(Changed);
  }

  // Ensure all entities reference an existing group; unknown groups reset to null.
  async function ReconcileOrphanedGroups(ValidGroupIDs: unknown): Promise<Result<number>> {
    if (ensureInitialized) await ensureInitialized();
    const Valid = new Set(
      (Array.isArray(ValidGroupIDs) ? ValidGroupIDs : [])
        .map((ID) => Number(ID))
        .filter((ID) => Number.isFinite(ID))
    );

    let Changed = 0;
    for (const Entity of getList()) {
      if (Entity.GroupID == null) continue;
      if (Valid.has(Number(Entity.GroupID))) continue;
      const [Err] = await RunClearGroup(getKey(Entity));
      if (Err) return Fail(labels.reconcile);
      Entity.GroupID = null;
      Changed += 1;
    }

    if (Changed > 0) BroadcastManager.emit(listChangedEvent);
    return Ok(Changed);
  }

  return { SetGroupAndWeight, MoveGroupToNoGroup, ReconcileOrphanedGroups };
}
