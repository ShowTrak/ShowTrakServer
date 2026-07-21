// GroupManager
// - CRUD for groups (title, weight)
// - Reassigns clients to null on group deletion and notifies listeners
import { CreateLogger } from '../Logger';
import { Manager as DB } from '../DB';
import { CreateGroupsRepository } from '../DB/repositories/groups';
import { Manager as BroadcastManager } from '../Broadcast';
import * as SlugService from '../Slug';
import { Ok, Fail } from '../Utils';
import type { Result } from '../../types/result';
import type { GroupRow } from '../DB/rows';

const Logger = CreateLogger('GroupManager');

const GroupsRepo = CreateGroupsRepository(DB);

// Group-reconciliation surface GroupManager depends on from the entity managers.
import { Manager as ClientManager } from '../ClientManager';
import { Manager as MonitoringTargetManager } from '../MonitoringTargetManager';
import { Manager as DummyClientManager } from '../DummyClientManager';

// Groups default to full width (span every column) so existing and migrated
// groups keep filling the row until an operator explicitly narrows them.
function NormalizeFullWidth(Value: unknown): boolean {
  if (Value === null || Value === undefined) return true;
  if (typeof Value === 'boolean') return Value;
  return Value === 1 || Value === '1' || Value === 'true';
}

// Allowed selection-toggle keybinds: keyboard number row (Digit0-9) and numpad
// numbers (Numpad0-9). Stored as KeyboardEvent.code values. Anything else
// (including empty selections) normalizes to null (no keybind).
const VALID_KEYBINDS = new Set([
  'Digit0',
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Digit5',
  'Digit6',
  'Digit7',
  'Digit8',
  'Digit9',
  'Numpad0',
  'Numpad1',
  'Numpad2',
  'Numpad3',
  'Numpad4',
  'Numpad5',
  'Numpad6',
  'Numpad7',
  'Numpad8',
  'Numpad9',
]);

function NormalizeKeyBind(Value: unknown): string | null {
  if (Value === null || Value === undefined) return null;
  const KeyBind = String(Value).trim();
  if (!KeyBind) return null;
  return VALID_KEYBINDS.has(KeyBind) ? KeyBind : null;
}

class Group {
  GroupID: number;
  Title: string | null;
  Weight: number;
  isFullWidth: boolean;
  KeyBind: string | null;
  // Stable, human-friendly OSC/API identifier; unique among groups. Back-filled
  // non-null on boot.
  Slug: string | null;

  constructor(Data: GroupRow) {
    this.GroupID = Data.GroupID;
    this.Title = Data.Title || null;
    this.Weight = Data.Weight || 0;
    this.isFullWidth = NormalizeFullWidth(Data.FullWidth);
    this.KeyBind = NormalizeKeyBind(Data.KeyBind);
    this.Slug = Data.Slug || null;
  }

  // Persist an already-validated/de-collided slug (GroupManager.SetSlug owns the
  // validation against the group namespace).
  async SetSlug(Slug: string): Promise<Result<boolean>> {
    if (this.Slug === Slug) return Ok(true);
    this.Slug = Slug;
    const [Err] = await GroupsRepo.UpdateSlug(this.GroupID, Slug);
    if (Err) {
      Logger.error('Failed to update group Slug');
      return Fail('Failed to update group slug');
    }
    Logger.debug(`Group ${this.GroupID} Slug updated to ${Slug}`);
    return Ok(true);
  }

  // Persistent fields (DB-backed)
  async SetTitle(Title: string): Promise<Result<boolean>> {
    if (this.Title === Title) return Ok(true);
    this.Title = Title;
    const [Err] = await GroupsRepo.UpdateTitle(this.GroupID, Title);
    if (Err) {
      Logger.error('Failed to update group Title');
      return Fail('Failed to update group title');
    }
    Logger.debug(`Group ${this.GroupID} Title updated to ${Title}`);
    return Ok(true);
  }
  async SetWeight(Weight: number): Promise<void> {
    if (this.Weight === Weight) return;
    this.Weight = Weight;
    const [Err] = await GroupsRepo.UpdateWeight(this.GroupID, Weight);
    if (Err) {
      Logger.error('Failed to update group Weight');
      return;
    }
    Logger.debug(`Group ${this.GroupID} Weight updated to ${Weight}`);
  }
  async SetFullWidth(FullWidth: unknown): Promise<Result<boolean>> {
    const Next = NormalizeFullWidth(FullWidth);
    if (this.isFullWidth === Next) return Ok(true);
    this.isFullWidth = Next;
    const [Err] = await GroupsRepo.UpdateFullWidth(this.GroupID, Next ? 1 : 0);
    if (Err) {
      Logger.error('Failed to update group FullWidth');
      return Fail('Failed to update group full width');
    }
    Logger.debug(`Group ${this.GroupID} FullWidth updated to ${Next}`);
    return Ok(true);
  }
  async SetKeyBind(KeyBind: unknown): Promise<Result<boolean>> {
    const Next = NormalizeKeyBind(KeyBind);
    if (this.KeyBind === Next) return Ok(true);
    this.KeyBind = Next;
    const [Err] = await GroupsRepo.UpdateKeyBind(this.GroupID, Next);
    if (Err) {
      Logger.error('Failed to update group KeyBind');
      return Fail('Failed to update group keybind');
    }
    Logger.debug(`Group ${this.GroupID} KeyBind updated to ${Next}`);
    return Ok(true);
  }
}

const Manager = {
  async Create(Title: string = 'New Group'): Promise<Result<boolean>> {
    if (!Title) return Fail('Group title is required');
    const [Err, Res] = await GroupsRepo.Insert(Title, 100);
    if (Err) {
      Logger.error('Failed to create group:', Err);
      return Fail('Failed to create group');
    }
    // Seed a unique non-null slug from the title. Best-effort: a failure here
    // leaves the slug null to be back-filled on next boot rather than failing
    // the whole create.
    const GroupID = Number((Res as { lastID?: number } | null)?.lastID);
    if (Number.isFinite(GroupID) && GroupID > 0) {
      const Slug = await SlugService.GenerateUniqueGroupSlug(Title, `group:${GroupID}`);
      const [SlugErr] = await GroupsRepo.UpdateSlug(GroupID, Slug);
      if (SlugErr) Logger.error('Failed to persist new group slug:', SlugErr);
    }
    BroadcastManager.emit('GroupListChanged');
    return Ok(true);
  },

  // Set a group's slug (validated + de-collided against the group namespace).
  async SetSlug(GroupID: number, Slug: unknown): Promise<Result<boolean>> {
    if (!GroupID) return Fail('GroupID is required');

    const [GetErr, Group] = await Manager.Get(GroupID);
    if (GetErr) return Fail(GetErr);
    if (!Group) return Fail('Group not found');

    const [SlugErr, Resolved] = await SlugService.ResolveGroupSlugEdit(Slug, `group:${GroupID}`);
    if (SlugErr) return Fail(SlugErr);

    // SlugErr falsy => Resolved is the resolved string (tuple union isn't narrowed).
    const [SetErr] = await Group.SetSlug(Resolved as string);
    if (SetErr) return Fail(SetErr);

    BroadcastManager.emit('GroupListChanged');
    return Ok(true);
  },

  // Resolve a group by slug (case-insensitive), for OSC/API addressing.
  async GetBySlug(Slug: string): Promise<Group | null> {
    if (!Slug) return null;
    const [Err, Groups] = await Manager.GetAll();
    if (Err) return null;
    const Lower = String(Slug).toLowerCase();
    return (Groups || []).find((G) => (G.Slug || '').toLowerCase() === Lower) || null;
  },

  // Assign generated unique slugs to any group still lacking one. Idempotent.
  async BackfillSlugs(): Promise<number> {
    const [Err, Groups] = await Manager.GetAll();
    if (Err) return 0;
    let Count = 0;
    for (const Group of Groups || []) {
      if (Group.Slug) continue;
      const Slug = await SlugService.GenerateUniqueGroupSlug(
        Group.Title || 'group',
        `group:${Group.GroupID}`
      );
      const [SetErr] = await Group.SetSlug(Slug);
      if (!SetErr) Count++;
    }
    if (Count) Logger.log(`Back-filled slugs for ${Count} group(s)`);
    return Count;
  },

  async Rename(GroupID: number, Title: string): Promise<Result<boolean>> {
    if (!GroupID) return Fail('GroupID is required');
    if (!Title) return Fail('Group title is required');

    const [GetErr, Group] = await Manager.Get(GroupID);
    if (GetErr) return Fail(GetErr);
    if (!Group) return Fail('Group not found');

    const [SetErr] = await Group.SetTitle(Title);
    if (SetErr) return Fail(SetErr);

    BroadcastManager.emit('GroupListChanged');
    return Ok(true);
  },

  async SetFullWidth(GroupID: number, FullWidth: unknown): Promise<Result<boolean>> {
    if (!GroupID) return Fail('GroupID is required');

    const [GetErr, Group] = await Manager.Get(GroupID);
    if (GetErr) return Fail(GetErr);
    if (!Group) return Fail('Group not found');

    const [SetErr] = await Group.SetFullWidth(FullWidth);
    if (SetErr) return Fail(SetErr);

    BroadcastManager.emit('GroupListChanged');
    return Ok(true);
  },

  // Assign (or clear) the keyboard shortcut used to toggle a group's selection.
  // Keybinds must be unique across groups so the same key never targets two
  // groups. Passing null/empty clears the group's keybind.
  async SetKeyBind(GroupID: number, KeyBind: unknown): Promise<Result<boolean>> {
    if (!GroupID) return Fail('GroupID is required');

    const [GetErr, Group] = await Manager.Get(GroupID);
    if (GetErr) return Fail(GetErr);
    if (!Group) return Fail('Group not found');

    const Next = NormalizeKeyBind(KeyBind);

    if (Next) {
      const [AllErr, Groups] = await Manager.GetAll();
      if (AllErr) return Fail('Failed to load groups');
      const Conflict = (Groups || []).some(
        (Other) => Number(Other.GroupID) !== Number(GroupID) && Other.KeyBind === Next
      );
      if (Conflict) return Fail('That keybind is already assigned to another group');
    }

    const [SetErr] = await Group.SetKeyBind(Next);
    if (SetErr) return Fail(SetErr);

    BroadcastManager.emit('GroupListChanged');
    return Ok(true);
  },

  // Persist a new ordering by reassigning Group.Weight in display order.
  async SetOrder(OrderedGroupIDs: unknown[] = []): Promise<{ ok: boolean; errors?: string[] }> {
    if (!Array.isArray(OrderedGroupIDs)) return { ok: false, errors: ['Invalid order'] };

    const [Err, Rows] = await GroupsRepo.GetAllIDs();
    if (Err) {
      Logger.error('Failed to fetch groups while reordering:', Err);
      return { ok: false, errors: ['Failed to reorder groups'] };
    }

    const Existing: number[] = (Rows || [])
      .map((Row) => Number(Row.GroupID))
      .filter((GroupID: number) => Number.isInteger(GroupID) && GroupID > 0);
    const ExistingSet = new Set(Existing);

    const Desired: number[] = [];
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
      const [SetErr] = await GroupsRepo.UpdateWeight(GroupID, Weight);
      if (SetErr) {
        Logger.error(`Failed to update group weight while reordering (${GroupID}):`, SetErr);
        return { ok: false, errors: ['Failed to reorder groups'] };
      }
      Weight += 10;
    }

    BroadcastManager.emit('GroupListChanged');
    return { ok: true };
  },

  // Delete a group and move all assigned entities to the default no-group bucket.
  async Delete(GroupID: number): Promise<Result<string>> {
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

    const [Err] = await GroupsRepo.Delete(GroupID);
    if (Err) {
      Logger.error('Failed to delete group:', Err);
      return Fail('Failed to delete group');
    }
    Logger.debug(`Deleted group with ID ${GroupID}`);
    BroadcastManager.emit('GroupListChanged');
    return Ok('Group Deleted Successfully');
  },

  // Reassign entities whose GroupID points to a non-existent group.
  async ReconcileOrphanedGroups(): Promise<Result<boolean>> {
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
  },

  async Get(GroupID: number): Promise<Result<Group | null>> {
    if (!GroupID) return Fail('GroupID is required');
    const [Err, Rows] = await GroupsRepo.GetByID(GroupID);
    if (Err) {
      Logger.error('Failed to fetch group:', Err);
      return Fail('Failed to fetch group');
    }
    if (!Rows) return Ok(null);
    const GroupObj = new Group(Rows);
    return Ok(GroupObj);
  },

  // Ordered by Weight ascending so lower weight renders first.
  async GetAll(): Promise<Result<Group[]>> {
    const [Err, Rows] = await GroupsRepo.GetAll();
    if (Err) {
      Logger.error('Failed to fetch groups:', Err);
      return Fail('Failed to fetch groups', []);
    }
    return Ok((Rows || []).map((row) => new Group(row)));
  },
};

export { Manager };
