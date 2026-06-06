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
    if (this.Title === Title) return;
    this.Title = Title;
    let [Err, _Res] = await DB.Run('UPDATE Groups SET Title = ? WHERE GroupID = ?', [
      Title,
      this.GroupID,
    ]);
    if (Err) return Logger.error('Failed to update group Title');
    Logger.debug(`Group ${this.GroupID} Title updated to ${Title}`);
  }
  async SetWeight(Weight) {
    if (this.Weight === Weight) return;
    this.Weight = Weight;
    let [Err, _Res] = await DB.Run('UPDATE Groups SET Weight = ? WHERE GroupID = ?', [
      Weight,
      this.GroupID,
    ]);
    if (Err) return Logger.error('Failed to update group Weight');
    Logger.debug(`Group ${this.GroupID} Weight updated to ${Weight}`);
  }
}

Manager.Create = async (Title = 'New Group') => {
  if (!Title) return Fail('Group title is required');
  let [Err, _Res] = await DB.Run('INSERT INTO Groups (Title, Weight) VALUES (?, ?)', [Title, 100]);
  if (Err) {
    Logger.error('Failed to create group:', Err);
    return Fail('Failed to create group');
  }
  BroadcastManager.emit('GroupListChanged');
  return Ok(true);
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
    let ClientsWithGroup = await ClientManager.GetClientsInGroup(GroupID);
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

  let [Err, _Res] = await DB.Run('DELETE FROM Groups WHERE GroupID = ?', [GroupID]);
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

  return Ok(true);
};

Manager.Get = async (GroupID) => {
  if (!GroupID) return Fail('GroupID is required');
  let [Err, Rows] = await DB.Get('SELECT * FROM Groups WHERE GroupID = ?', [GroupID]);
  if (Err) {
    Logger.error('Failed to fetch group:', Err);
    return Fail('Failed to fetch group');
  }
  if (!Rows) return Ok(null);
  const GroupObj = new Group(Rows);
  return Ok(GroupObj);
};

// Ordered by Weight descending for display purposes (heavier first)
Manager.GetAll = async () => {
  let [Err, Rows] = await DB.All('SELECT * FROM Groups ORDER BY Weight DESC');
  if (Err) {
    Logger.error('Failed to fetch groups:', Err);
    return Fail('Failed to fetch groups', []);
  }
  return Ok(Rows.map((row) => new Group(row)));
};

module.exports = {
  Manager,
};
