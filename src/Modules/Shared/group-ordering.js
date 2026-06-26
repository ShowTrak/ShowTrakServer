// Shared group-ordering behavior for list-backed managers.
//
// DummyClientManager and MonitoringTargetManager kept byte-for-byte identical
// implementations of SetGroupAndWeight / MoveGroupToNoGroup /
// ReconcileOrphanedGroups, differing only in the backing table, key column,
// in-memory list, list-changed event and error wording. This factory captures
// that shared behavior so the logic lives in one place.
//
// Behavior is identical to the original inline implementations.
const { Ok, Fail } = require('../Utils');

// config:
//   DB                - DB manager (injected so unit tests can mock it)
//   BroadcastManager  - broadcast manager (injected for the same reason)
//   table             - SQL table name (constant, not user input)
//   keyColumn         - primary key column name (constant)
//   getList()         - returns the live in-memory entity array
//   getKey(entity)    - returns an entity's key value (matches keyColumn)
//   normalizeKey(raw) - canonicalizes an incoming key (default: identity)
//   listChangedEvent  - BroadcastManager event emitted after a change
//   ensureInitialized() - optional async guard that warms the cache
//   labels: { notFound, update, move, reconcile } - error messages
function createGroupOrdering(config) {
  const {
    DB,
    BroadcastManager,
    table,
    keyColumn,
    getList,
    getKey,
    normalizeKey = (value) => value,
    listChangedEvent,
    ensureInitialized,
    labels,
  } = config;

  const setGroupSql = `UPDATE ${table} SET GroupID = ?, Weight = ? WHERE ${keyColumn} = ?`;
  const clearGroupSql = `UPDATE ${table} SET GroupID = ? WHERE ${keyColumn} = ?`;

  // Move an entity to a group with a specific weight (used by drag/drop ordering).
  async function SetGroupAndWeight(RawKey, GroupID, Weight) {
    const Key = normalizeKey(RawKey);
    const Entity = getList().find((E) => getKey(E) === Key);
    if (!Entity) return Fail(labels.notFound);
    const NextGroupID = GroupID == null ? null : Number(GroupID);
    const NextWeight = Number.isFinite(Number(Weight)) ? Number(Weight) : 100;
    const [Err] = await DB.Run(setGroupSql, [NextGroupID, NextWeight, Key]);
    if (Err) return Fail(labels.update);
    Entity.GroupID = NextGroupID;
    Entity.Weight = NextWeight;
    return Ok(true);
  }

  // Move all entities in a group into the default no-group bucket (null).
  async function MoveGroupToNoGroup(GroupID) {
    if (ensureInitialized) await ensureInitialized();
    const TargetGroupID = Number(GroupID);
    if (!Number.isFinite(TargetGroupID)) return Fail('Invalid GroupID');

    let Changed = 0;
    for (const Entity of getList()) {
      if (Entity.GroupID == null) continue;
      if (Number(Entity.GroupID) !== TargetGroupID) continue;
      const [Err] = await DB.Run(clearGroupSql, [null, getKey(Entity)]);
      if (Err) return Fail(labels.move);
      Entity.GroupID = null;
      Changed += 1;
    }

    if (Changed > 0) BroadcastManager.emit(listChangedEvent);
    return Ok(Changed);
  }

  // Ensure all entities reference an existing group; unknown groups reset to null.
  async function ReconcileOrphanedGroups(ValidGroupIDs) {
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
      const [Err] = await DB.Run(clearGroupSql, [null, getKey(Entity)]);
      if (Err) return Fail(labels.reconcile);
      Entity.GroupID = null;
      Changed += 1;
    }

    if (Changed > 0) BroadcastManager.emit(listChangedEvent);
    return Ok(Changed);
  }

  return { SetGroupAndWeight, MoveGroupToNoGroup, ReconcileOrphanedGroups };
}

module.exports = { createGroupOrdering };
