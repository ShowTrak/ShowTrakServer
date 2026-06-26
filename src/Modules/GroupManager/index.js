// GroupManager
// - CRUD for groups (title, weight)
// - Reassigns clients to null on group deletion and notifies listeners
const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('GroupManager');

// const { Config } = require('../Config');

const { Manager: DB } = require('../DB');

const { Manager: BroadcastManager } = require('../Broadcast');

const { Manager: ClientManager } = require('../ClientManager');
const { Manager: MonitoringTargetManager } = require('../MonitoringTargetManager');
const { Manager: DummyClientManager } = require('../DummyClientManager');
const { Ok, Fail } = require('../Utils');

const Manager = {};

class Group {
  constructor(Data) {
    this.GroupID = Data.GroupID;
    this.Title = Data.Title || null;
    this.Weight = Data.Weight || 0;
  }

  // Persistent fields (DB-backed)
  async SetTitle(Title) {
    if (this.Title === Title) return Ok(true);
    this.Title = Title;
    const [Err, _Res] = await DB.Run('UPDATE Groups SET Title = ? WHERE GroupID = ?', [
      Title,
      this.GroupID,
    ]);
    if (Err) {
      Logger.error('Failed to update group Title');
      return Fail('Failed to update group title');
    }
    Logger.debug(`Group ${this.GroupID} Title updated to ${Title}`);
    return Ok(true);
  }
  async SetWeight(Weight) {
    if (this.Weight === Weight) return;
    this.Weight = Weight;
    const [Err, _Res] = await DB.Run('UPDATE Groups SET Weight = ? WHERE GroupID = ?', [
      Weight,
      this.GroupID,
    ]);
    if (Err) return Logger.error('Failed to update group Weight');
    Logger.debug(`Group ${this.GroupID} Weight updated to ${Weight}`);
  }
}

Manager.Create = async (Title = 'New Group') => {
  if (!Title) return Fail('Group title is required');
  const [Err, _Res] = await DB.Run('INSERT INTO Groups (Title, Weight) VALUES (?, ?)', [Title, 100]);
  if (Err) {
    Logger.error('Failed to create group:', Err);
    return Fail('Failed to create group');
  }
  BroadcastManager.emit('GroupListChanged');
  return Ok(true);
};

Manager.Rename = async (GroupID, Title) => {
  if (!GroupID) return Fail('GroupID is required');
  if (!Title) return Fail('Group title is required');

  const [GetErr, Group] = await Manager.Get(GroupID);
  if (GetErr) return Fail(GetErr);
  if (!Group) return Fail('Group not found');

  const [SetErr] = await Group.SetTitle(Title);
  if (SetErr) return Fail(SetErr);

  BroadcastManager.emit('GroupListChanged');
  return Ok(true);
};

// Persist a new ordering by reassigning Group.Weight in display order.
Manager.SetOrder = async (OrderedGroupIDs = []) => {
  if (!Array.isArray(OrderedGroupIDs)) return { ok: false, errors: ['Invalid order'] };

  const [Err, Rows] = await DB.All('SELECT GroupID FROM Groups ORDER BY Weight ASC, GroupID ASC');
  if (Err) {
    Logger.error('Failed to fetch groups while reordering:', Err);
    return { ok: false, errors: ['Failed to reorder groups'] };
  }

  const Existing = (Rows || [])
    .map((Row) => Number(Row.GroupID))
    .filter((GroupID) => Number.isInteger(GroupID) && GroupID > 0);
  const ExistingSet = new Set(Existing);

  const Desired = [];
  for (const RawGroupID of OrderedGroupIDs) {
    const GroupID = Number(RawGroupID);
    if (!Number.isInteger(GroupID) || GroupID <= 0) continue;
    if (!ExistingSet.has(GroupID)) continue;
    if (Desired.includes(GroupID)) continue;
    Desired.push(GroupID);
  }

  const Remaining = Existing.filter((GroupID) => !Desired.includes(GroupID));
  const FinalOrder = Desired.concat(Remaining);

  let Weight = 10;
  for (const GroupID of FinalOrder) {
    const [SetErr] = await DB.Run('UPDATE Groups SET Weight = ? WHERE GroupID = ?', [
      Weight,
      GroupID,
    ]);
    if (SetErr) {
      Logger.error(`Failed to update group weight while reordering (${GroupID}):`, SetErr);
      return { ok: false, errors: ['Failed to reorder groups'] };
    }
    Weight += 10;
  }

  BroadcastManager.emit('GroupListChanged');
  return { ok: true };
};

// Delete a group and move all assigned entities to the default no-group bucket.
Manager.Delete = async (GroupID) => {
  if (!GroupID) return Fail('GroupID is required to delete a group');

  if (typeof ClientManager.MoveGroupToNoGroup === 'function') {
    const [ClientErr] = await ClientManager.MoveGroupToNoGroup(GroupID);
    if (ClientErr) {
      Logger.error('Failed to move clients to no group while deleting group:', ClientErr);
      return Fail('Failed to move clients to no group');
    }
  } else {
    // Backward-compatible fallback for older manager implementations.
    const ClientsWithGroup = await ClientManager.GetClientsInGroup(GroupID);
    for (const Client of ClientsWithGroup) {
      await Client.SetGroupID(null);
    }
  }

  if (typeof MonitoringTargetManager.MoveGroupToNoGroup === 'function') {
    const [TargetErr] = await MonitoringTargetManager.MoveGroupToNoGroup(GroupID);
    if (TargetErr) {
      Logger.error(
        'Failed to move monitoring targets to no group while deleting group:',
        TargetErr
      );
      return Fail('Failed to move monitoring targets to no group');
    }
  }

  if (typeof DummyClientManager.MoveGroupToNoGroup === 'function') {
    const [DummyErr] = await DummyClientManager.MoveGroupToNoGroup(GroupID);
    if (DummyErr) {
      Logger.error('Failed to move dummy clients to no group while deleting group:', DummyErr);
      return Fail('Failed to move dummy clients to no group');
    }
  }

  const [Err, _Res] = await DB.Run('DELETE FROM Groups WHERE GroupID = ?', [GroupID]);
  if (Err) {
    Logger.error('Failed to delete group:', Err);
    return Fail('Failed to delete group');
  }
  Logger.debug(`Deleted group with ID ${GroupID}`);
  BroadcastManager.emit('GroupListChanged');
  return Ok('Group Deleted Successfully');
};

// Reassign entities whose GroupID points to a non-existent group.
Manager.ReconcileOrphanedGroups = async () => {
  const [GroupsErr, Groups] = await Manager.GetAll();
  if (GroupsErr) return Fail('Failed to load groups for orphan reconciliation');

  const GroupIDs = (Groups || []).map((G) => G.GroupID);

  if (typeof ClientManager.ReconcileOrphanedGroups === 'function') {
    const [ClientErr] = await ClientManager.ReconcileOrphanedGroups(GroupIDs);
    if (ClientErr) {
      Logger.error('Failed to reconcile orphaned clients:', ClientErr);
      return Fail('Failed to reconcile orphaned clients');
    }
  }

  if (typeof MonitoringTargetManager.ReconcileOrphanedGroups === 'function') {
    const [TargetErr] = await MonitoringTargetManager.ReconcileOrphanedGroups(GroupIDs);
    if (TargetErr) {
      Logger.error('Failed to reconcile orphaned monitoring targets:', TargetErr);
      return Fail('Failed to reconcile orphaned monitoring targets');
    }
  }

  if (typeof DummyClientManager.ReconcileOrphanedGroups === 'function') {
    const [DummyErr] = await DummyClientManager.ReconcileOrphanedGroups(GroupIDs);
    if (DummyErr) {
      Logger.error('Failed to reconcile orphaned dummy clients:', DummyErr);
      return Fail('Failed to reconcile orphaned dummy clients');
    }
  }

  return Ok(true);
};

Manager.Get = async (GroupID) => {
  if (!GroupID) return Fail('GroupID is required');
  const [Err, Rows] = await DB.Get('SELECT * FROM Groups WHERE GroupID = ?', [GroupID]);
  if (Err) {
    Logger.error('Failed to fetch group:', Err);
    return Fail('Failed to fetch group');
  }
  if (!Rows) return Ok(null);
  const GroupObj = new Group(Rows);
  return Ok(GroupObj);
};

// Ordered by Weight ascending so lower weight renders first.
Manager.GetAll = async () => {
  const [Err, Rows] = await DB.All('SELECT * FROM Groups ORDER BY Weight ASC, GroupID ASC');
  if (Err) {
    Logger.error('Failed to fetch groups:', Err);
    return Fail('Failed to fetch groups', []);
  }
  return Ok(Rows.map((row) => new Group(row)));
};

module.exports = {
  Manager,
};
