// Group Manager modal (renderer). Extracted verbatim from modals.ts.
//
// Owns the group-manager overview + per-group editor: membership resolution,
// drag-reorder persistence, inline rename, and delete. Depends only on shared
// renderer modules (no back-reference into modals), so it carries the
// group-manager editing state that was previously module-level in modals.
import { closeAllModals, closeModal, openModal } from './lib/modal';
import { buildModalHeader } from './lib/modal-header';
import { Safe } from './utils';
import { Notify, Wait } from './selection-init';
import { DummyClients, GroupUUIDCache, MonitoringTargets, __LastClients } from './state';
import type { ClientView, GroupView } from '@showtrak/protocol';

// Close every open modal, then wait for the CSS transition to settle. Inlined
// from modals' CloseAllModals so this module has no back-reference into it.
async function CloseAllModals(): Promise<void> {
  closeAllModals();
  await Wait(300);
}

export async function OpenGroupCreationModal() {
  await CloseAllModals();

  let Groups = await window.API.GetAllGroups();
  if (!Groups) Groups = [];

  openModal('SHOWTRAL_MODAL_GROUPCREATION');

  $('#GROUP_CREATION_SUBMIT')
    .off('click')
    .on('click', async () => {
      const GroupName = $('#GROUP_CREATION_TITLE').val() as string;
      if (!GroupName) return Notify('Please enter a group name', 'error');
      if (GroupName.length < 3)
        return Notify('Group name must be at least 3 characters long', 'error');
      if (Groups.some((g) => String(g.Title || '').toLowerCase() === GroupName.toLowerCase())) {
        return Notify('A group with this name already exists', 'error');
      }
      if (GroupName.length > 32) return Notify('Group name must be 32 characters or less', 'error');

      // Clear the input field
      $('#GROUP_CREATION_TITLE').val('');

      await window.API.CreateGroup(GroupName);
      OpenGroupManager();
      closeModal('SHOWTRAL_MODAL_GROUPCREATION');
    });
}

/** A member row shown in the group-manager overview list. */
interface GroupManagerMember {
  Kind: string;
  ID: string;
  DisplayName: string;
  Subtitle: string;
}

/** An entity row shown in the group-manager editor member list. */
interface GroupManagerEntity {
  Kind: string;
  ID: string;
  Name: string;
  Hostname: string;
  IP: string;
}

export let GroupManagerEditingGroupID: number | null = null;
export let GroupManagerRenameDebounceTimer: ReturnType<typeof setTimeout> | null = null;
export let GroupManagerRenameLastSavedTitle = '';

export function GroupManagerInGroup(
  EntityGroupID: number | null | undefined,
  GroupID: number | null
) {
  if (GroupID == null) return EntityGroupID == null;
  if (EntityGroupID == null) return false;
  return Number(EntityGroupID) === Number(GroupID);
}

export function GetGroupManagerMembers(GroupID: number | null) {
  const Members: GroupManagerMember[] = [];

  const Clients = Array.isArray(__LastClients) ? __LastClients : [];
  for (const Client of Clients) {
    if (!GroupManagerInGroup(Client.GroupID, GroupID)) continue;
    const UUID = String(Client.UUID || '').trim();
    if (!UUID) continue;
    const DisplayName =
      (Client.Nickname && String(Client.Nickname).trim()) ||
      (Client.Hostname && String(Client.Hostname).trim()) ||
      (Client.IP && String(Client.IP).trim()) ||
      UUID;
    Members.push({
      Kind: 'client',
      ID: UUID,
      DisplayName,
      Subtitle: UUID,
    });
  }

  const Dummies = Array.isArray(DummyClients) ? DummyClients : [];
  for (const Dummy of Dummies) {
    if (!GroupManagerInGroup(Dummy.GroupID, GroupID)) continue;
    const UUID = String(Dummy.UUID || '').trim();
    if (!UUID) continue;
    const DummyID = String(Dummy.DummyID || '').trim();
    Members.push({
      Kind: 'dummy',
      ID: UUID,
      DisplayName: String(Dummy.Nickname || DummyID || 'Dummy').trim(),
      Subtitle: `Dummy: ${DummyID || UUID}`,
    });
  }

  const Targets = Array.isArray(MonitoringTargets) ? MonitoringTargets : [];
  for (const Target of Targets) {
    if (!GroupManagerInGroup(Target.GroupID, GroupID)) continue;
    const TargetID = Number(Target.TargetID);
    if (!Number.isFinite(TargetID)) continue;
    const Address = String(Target.Address || '').trim();
    Members.push({
      Kind: 'monitor',
      ID: String(TargetID),
      DisplayName: String(Target.Nickname || Address || `Monitor ${TargetID}`).trim(),
      Subtitle: `Monitor: ${Address || `#${TargetID}`}`,
    });
  }

  return Members;
}

export function GetGroupManagerClients(GroupID: number | null) {
  const Clients = Array.isArray(__LastClients) ? __LastClients : [];
  return Clients.filter((Client) => GroupManagerInGroup(Client.GroupID, GroupID)).sort(
    (a, b) => (a.Weight || 0) - (b.Weight || 0)
  );
}

export async function ResolveGroupManagerClients(GroupID: number | null) {
  const CachedClients = GetGroupManagerClients(GroupID);
  const CacheByUUID = new Map(
    CachedClients.map((Client): [string, ClientView] => [
      String(Client && Client.UUID ? Client.UUID : '').trim(),
      Client,
    ]).filter(([UUID]) => UUID.length > 0)
  );

  const CachedGroupUUIDs = GroupUUIDCache.get(`${GroupID}`);
  const GroupUUIDs: unknown[] = Array.isArray(CachedGroupUUIDs) ? CachedGroupUUIDs : [];
  const OrderedUUIDs = Array.from(
    new Set(GroupUUIDs.map((UUID) => String(UUID || '').trim()).filter((UUID) => UUID.length > 0))
  );

  const MissingUUIDs = OrderedUUIDs.filter((UUID) => !CacheByUUID.has(UUID));
  if (MissingUUIDs.length) {
    const Loaded = await Promise.all(
      MissingUUIDs.map(async (UUID) => {
        try {
          return await window.API.GetClient(UUID);
        } catch {
          return null;
        }
      })
    );

    for (const Client of Loaded) {
      if (!Client || !Client.UUID) continue;
      if (!GroupManagerInGroup(Client.GroupID, GroupID)) continue;
      CacheByUUID.set(String(Client.UUID).trim(), Client);
    }
  }

  const OrderedClients: ClientView[] = [];
  const Seen = new Set<string>();
  for (const UUID of OrderedUUIDs) {
    const Client = CacheByUUID.get(UUID);
    if (!Client) continue;
    OrderedClients.push(Client);
    Seen.add(UUID);
  }

  for (const Client of CachedClients) {
    const UUID = String(Client && Client.UUID ? Client.UUID : '').trim();
    if (!UUID || Seen.has(UUID)) continue;
    OrderedClients.push(Client);
  }

  return OrderedClients;
}

export async function ResolveGroupManagerEntities(GroupID: number | null) {
  const Entities: GroupManagerEntity[] = [];

  const Clients = await ResolveGroupManagerClients(GroupID);
  for (const Client of Clients) {
    const UUID = String(Client && Client.UUID ? Client.UUID : '').trim();
    if (!UUID) continue;
    const Name =
      (Client.Nickname && String(Client.Nickname).trim()) ||
      (Client.Hostname && String(Client.Hostname).trim()) ||
      (Client.IP && String(Client.IP).trim()) ||
      UUID;
    const Hostname = String(Client && Client.Hostname ? Client.Hostname : '-').trim() || '-';
    const IP = String(Client && Client.IP ? Client.IP : '-').trim() || '-';
    Entities.push({
      Kind: 'client',
      ID: UUID,
      Name,
      Hostname,
      IP,
    });
  }

  let Dummies = Array.isArray(DummyClients) ? DummyClients : [];
  if (!Dummies.length) {
    try {
      Dummies = (await window.API.GetAllDummyClients()) || [];
    } catch {
      Dummies = [];
    }
  }
  for (const Dummy of Dummies) {
    if (!GroupManagerInGroup(Dummy.GroupID, GroupID)) continue;
    const UUID = String(Dummy && Dummy.UUID ? Dummy.UUID : '').trim();
    if (!UUID) continue;
    const DummyID = String(Dummy && Dummy.DummyID ? Dummy.DummyID : '').trim();
    const Name = String(Dummy && Dummy.Nickname ? Dummy.Nickname : DummyID || 'Dummy').trim();
    const Hostname = DummyID || '-';
    const IP = String(Dummy && Dummy.IP ? Dummy.IP : '-').trim() || '-';
    Entities.push({
      Kind: 'dummy',
      ID: UUID,
      Name,
      Hostname,
      IP,
    });
  }

  let Targets = Array.isArray(MonitoringTargets) ? MonitoringTargets : [];
  if (!Targets.length) {
    try {
      Targets = (await window.API.GetAllMonitoringTargets()) || [];
    } catch {
      Targets = [];
    }
  }
  for (const Target of Targets) {
    if (!GroupManagerInGroup(Target.GroupID, GroupID)) continue;
    const TargetID = Number(Target && Target.TargetID);
    if (!Number.isFinite(TargetID)) continue;
    const Address = String(Target && Target.Address ? Target.Address : '').trim();
    const Name = String((Target && Target.Nickname) || Address || `Monitor ${TargetID}`).trim();
    Entities.push({
      Kind: 'monitor',
      ID: String(TargetID),
      Name,
      Hostname: Address || '-',
      IP: Address || '-',
    });
  }

  return Entities;
}

export function RenderGroupManagerEditorClientRows(
  Entities: GroupManagerEntity[] = [],
  GroupID: number
) {
  if (!Entities.length) {
    return '<div class="text-muted text-sm">No members in this group.</div>';
  }

  return Entities.map(({ Kind, ID, Name, Hostname, IP }) => {
    const EntityKind = String(Kind || 'client').toLowerCase();
    const EntityID = String(ID || '').trim();
    if (!EntityID) return '';

    return `
      <div class="group-manager-member-row group-manager-client-row d-flex align-items-center">
        <span class="group-manager-client-col group-manager-client-col-name text-light text-truncate">${Safe(
          Name
        )}</span>
        <span class="group-manager-client-col group-manager-client-col-hostname text-muted text-truncate">${Safe(
          Hostname
        )}</span>
        <span class="group-manager-client-col group-manager-client-col-ip text-muted text-truncate">${Safe(
          IP
        )}</span>
        <span class="group-manager-client-col group-manager-client-col-action text-end">
          <button
            type="button"
            class="btn btn-sm group-manager-member-remove GROUP_MANAGER_MEMBER_REMOVE"
            data-groupid="${GroupID}"
            data-kind="${Safe(EntityKind)}"
            data-id="${Safe(EntityID)}"
            title="Remove from group"
            aria-label="Remove from group"
          >
            <i class="bi bi-dash-lg"></i>
          </button>
        </span>
      </div>
    `;
  }).join('');
}

export async function SaveGroupManagerName(
  Groups: GroupView[] = [],
  { notifyOnValidationError = false } = {}
) {
  const GroupID = Number(GroupManagerEditingGroupID);
  if (!Number.isFinite(GroupID)) return false;

  const NextTitle = String($('#GROUP_MANAGER_EDITOR_NAME').val() || '').trim();
  if (NextTitle === GroupManagerRenameLastSavedTitle) return true;

  if (NextTitle.length < 3) {
    if (notifyOnValidationError && NextTitle.length > 0) {
      await Notify('Group name must be at least 3 characters long', 'error');
    }
    return false;
  }
  if (NextTitle.length > 32) {
    if (notifyOnValidationError) {
      await Notify('Group name must be 32 characters or less', 'error');
    }
    return false;
  }

  const Duplicate = Groups.some(
    (Group) =>
      Number(Group.GroupID) !== GroupID &&
      String(Group.Title || '').toLowerCase() === NextTitle.toLowerCase()
  );
  if (Duplicate) {
    if (notifyOnValidationError) {
      await Notify('A group with this name already exists', 'error');
    }
    return false;
  }

  const [Err] = await window.API.RenameGroup(GroupID, NextTitle);
  if (Err) {
    await Notify(String(Err), 'error');
    return false;
  }

  GroupManagerRenameLastSavedTitle = NextTitle;
  const LocalGroup = Groups.find((Group) => Number(Group.GroupID) === GroupID);
  if (LocalGroup) LocalGroup.Title = NextTitle;
  return true;
}

export function BindGroupManagerEditorHandlers(Groups: GroupView[] = []) {
  // Back returns to the Group manager (its parent); the close X dismisses the
  // editor. Delete moved to the toolbar row beneath this header.
  $('#GROUP_EDITOR_HEADER')
    .empty()
    .append(
      buildModalHeader({
        title: 'Edit Group',
        onBack: async () => {
          closeModal('SHOWTRAK_MODAL_GROUP_EDITOR');
          await OpenGroupManager(true);
        },
        onClose: () => closeModal('SHOWTRAK_MODAL_GROUP_EDITOR'),
      }).$el
    );

  $('#GROUP_MANAGER_EDITOR_NAME')
    .off('input blur keydown')
    .on('input', function () {
      if (GroupManagerRenameDebounceTimer) {
        clearTimeout(GroupManagerRenameDebounceTimer);
      }
      GroupManagerRenameDebounceTimer = setTimeout(async () => {
        GroupManagerRenameDebounceTimer = null;
        await SaveGroupManagerName(Groups, { notifyOnValidationError: false });
      }, 450);
    })
    .on('blur', async function () {
      if (GroupManagerRenameDebounceTimer) {
        clearTimeout(GroupManagerRenameDebounceTimer);
        GroupManagerRenameDebounceTimer = null;
      }
      await SaveGroupManagerName(Groups, { notifyOnValidationError: true });
    })
    .on('keydown', function (Event) {
      if (Event.key !== 'Enter') return;
      Event.preventDefault();
      this.blur();
    });

  $('#GROUP_MANAGER_EDITOR_DELETE')
    .off('click')
    .on('click', async function () {
      const GroupID = Number(GroupManagerEditingGroupID);
      if (!Number.isFinite(GroupID)) return;
      closeModal('SHOWTRAK_MODAL_GROUP_EDITOR');
      await DeleteGroup(GroupID);
    });

  $('#GROUP_MANAGER_EDITOR_FULL_WIDTH')
    .off('change')
    .on('change', async function () {
      const GroupID = Number(GroupManagerEditingGroupID);
      if (!Number.isFinite(GroupID)) return;
      const NextFullWidth = $(this).is(':checked');
      const [Err] = await window.API.SetGroupFullWidth(GroupID, NextFullWidth);
      if (Err) {
        $(this).prop('checked', !NextFullWidth);
        await Notify(String(Err), 'error');
        return;
      }
      const LocalGroup = Groups.find((Group) => Number(Group.GroupID) === GroupID);
      if (LocalGroup) LocalGroup.isFullWidth = NextFullWidth;
      await Notify(`Group set to ${NextFullWidth ? 'full width' : 'single column'}.`, 'success');
    });

  $('#GROUP_MANAGER_EDITOR_KEYBIND')
    .off('change')
    .on('change', async function () {
      const GroupID = Number(GroupManagerEditingGroupID);
      if (!Number.isFinite(GroupID)) return;
      const LocalGroup = Groups.find((Group) => Number(Group.GroupID) === GroupID);
      const PreviousKeyBind = LocalGroup ? LocalGroup.KeyBind || '' : '';
      const NextKeyBind = String($(this).val() || '');
      const [Err] = await window.API.SetGroupKeyBind(GroupID, NextKeyBind || null);
      if (Err) {
        $(this).val(PreviousKeyBind);
        await Notify(String(Err), 'error');
        return;
      }
      if (LocalGroup) LocalGroup.KeyBind = NextKeyBind || null;
      await Notify(
        NextKeyBind ? 'Group selection keybind updated.' : 'Group selection keybind cleared.',
        'success'
      );
    });

  // Slug: saved on blur / Enter. A slug never auto-changes from a rename, so it
  // is edited independently here. Reverts to the last-saved value on error or an
  // empty box.
  $('#GROUP_MANAGER_EDITOR_SLUG')
    .off('blur keydown')
    .on('blur', async function () {
      const GroupID = Number(GroupManagerEditingGroupID);
      if (!Number.isFinite(GroupID)) return;
      const LocalGroup = Groups.find((Group) => Number(Group.GroupID) === GroupID);
      const PreviousSlug = LocalGroup ? LocalGroup.Slug || '' : '';
      const NextSlug = String($(this).val() || '').trim();
      if (!NextSlug || NextSlug === PreviousSlug) {
        $(this).val(PreviousSlug);
        return;
      }
      const [Err] = await window.API.SetGroupSlug(GroupID, NextSlug);
      if (Err) {
        $(this).val(PreviousSlug);
        await Notify(String(Err), 'error');
        return;
      }
      if (LocalGroup) LocalGroup.Slug = NextSlug;
      await Notify('Group slug updated.', 'success');
    })
    .on('keydown', function (Event) {
      if (Event.key !== 'Enter') return;
      Event.preventDefault();
      this.blur();
    });

  $('#GROUP_MANAGER_EDITOR_CLIENT_LIST')
    .off('click', '.GROUP_MANAGER_MEMBER_REMOVE')
    .on('click', '.GROUP_MANAGER_MEMBER_REMOVE', async function () {
      const Kind = String($(this).attr('data-kind') || '')
        .trim()
        .toLowerCase();
      const EntityID = String($(this).attr('data-id') || '').trim();
      const GroupID = parseInt($(this).attr('data-groupid') || '', 10);
      if (!EntityID || !Number.isFinite(GroupID)) return;

      let Err = null;
      if (Kind === 'dummy') {
        [Err] = await window.API.UpdateDummyClient(EntityID, { GroupID: null });
      } else if (Kind === 'monitor') {
        [Err] = await window.API.UpdateMonitoringTarget(parseInt(EntityID, 10), { GroupID: null });
      } else {
        [Err] = await window.API.UpdateClient(EntityID, { GroupID: null });
      }

      if (Err) {
        await Notify(String(Err), 'error');
        return;
      }

      await OpenGroupManagerEditor(GroupID, true, Groups);
      await Notify('Member moved to the default group.', 'success');
    });
}

export async function OpenGroupManagerEditor(
  GroupID: number,
  Relaunching = false,
  PrefetchedGroups: GroupView[] | null = null
) {
  let Groups = Array.isArray(PrefetchedGroups) ? PrefetchedGroups : await window.API.GetAllGroups();
  if (!Array.isArray(Groups)) Groups = [];

  const Group = Groups.find((G) => Number(G.GroupID) === Number(GroupID));
  if (!Group) {
    await Notify('Group not found', 'error');
    return;
  }

  GroupManagerEditingGroupID = Number(Group.GroupID);
  GroupManagerRenameLastSavedTitle = String(Group.Title || '').trim();
  if (GroupManagerRenameDebounceTimer) {
    clearTimeout(GroupManagerRenameDebounceTimer);
    GroupManagerRenameDebounceTimer = null;
  }

  $('#GROUP_MANAGER_EDITOR_NAME').val(Group.Title || '');
  $('#GROUP_MANAGER_EDITOR_GROUPID').val(String(Group.GroupID));
  $('#GROUP_MANAGER_EDITOR_SLUG').val(Group.Slug || '');
  $('#GROUP_MANAGER_EDITOR_FULL_WIDTH').prop('checked', Group.isFullWidth !== false);
  $('#GROUP_MANAGER_EDITOR_KEYBIND').val(Group.KeyBind || '');

  const Clients = await ResolveGroupManagerEntities(Group.GroupID);
  $('#GROUP_MANAGER_EDITOR_CLIENT_LIST').html(
    RenderGroupManagerEditorClientRows(Clients, Number(Group.GroupID))
  );

  BindGroupManagerEditorHandlers(Groups);

  if (!Relaunching) {
    closeModal('SHOWTRAK_MODAL_GROUPMANAGER');
  }
  openModal('SHOWTRAK_MODAL_GROUP_EDITOR');
}

export async function DeleteGroup(GroupID: number) {
  await window.API.DeleteGroup(GroupID);
  await OpenGroupManager(true);
  await Notify('Group deleted.', 'success');
}

export function GroupManagerDragAfterElement(Container: HTMLElement, Y: number) {
  const Items = [...Container.querySelectorAll('.GROUP_MANAGER_GROUP_ITEM:not(.dragging)')];
  let Closest: { offset: number; element: Element | null } = {
    offset: Number.NEGATIVE_INFINITY,
    element: null,
  };

  for (const Child of Items) {
    const Box = Child.getBoundingClientRect();
    const Offset = Y - Box.top - Box.height / 2;
    if (Offset < 0 && Offset > Closest.offset) {
      Closest = { offset: Offset, element: Child };
    }
  }

  return Closest.element;
}

export async function PersistGroupManagerOrder() {
  const Container = document.getElementById('GROUP_MANAGER_SORTABLE_LIST');
  if (!Container) return true;

  const OrderedGroupIDs = [...Container.querySelectorAll('.GROUP_MANAGER_GROUP_ITEM')]
    .map((el) => parseInt(el.getAttribute('data-groupid') || '', 10))
    .filter((id) => Number.isFinite(id));

  if (!OrderedGroupIDs.length) return true;

  const [Err] = await window.API.SetGroupListOrder(OrderedGroupIDs);
  if (Err) {
    await Notify(`Failed to reorder groups: ${Err}`, 'error');
    return false;
  }

  return true;
}

export async function OpenGroupManager(Relaunching = false) {
  if (!Relaunching) await CloseAllModals();

  let Groups = await window.API.GetAllGroups();
  if (!Array.isArray(Groups)) Groups = [];

  function FormatGroupKeyBindLabel(KeyBind: string | null | undefined) {
    const Code = String(KeyBind || '').trim();
    const Match = Code.match(/^(Digit|Numpad)([0-9])$/);
    if (!Match) return '';
    const Source = Match[1] === 'Numpad' ? 'NP' : 'KB';
    return `${Source} ${Match[2]}`;
  }

  $('#GROUP_MANAGER_GROUP_LIST').html(
    '<div id="GROUP_MANAGER_SORTABLE_LIST" class="d-grid gap-2"></div>'
  );

  for (const Group of Groups) {
    const GroupMembers = GetGroupManagerMembers(Group.GroupID);
    const GroupID = parseInt(String(Group.GroupID), 10);
    const KeyBindLabel = FormatGroupKeyBindLabel(Group.KeyBind);
    const KeyBindBadge = KeyBindLabel
      ? `<span class="group-manager-keybind-indicator" title="Selection keybind: ${Safe(
          Group.KeyBind
        )}">${Safe(KeyBindLabel)}</span>`
      : '';

    $('#GROUP_MANAGER_SORTABLE_LIST').append(`
      <div class="GROUP_MANAGER_GROUP_ITEM p-3 rounded bg-ghost d-flex align-items-center gap-2" data-groupid="${GroupID}" draggable="true">
        <span class="group-manager-grip" title="Drag to reorder"><i class="bi bi-grip-vertical"></i></span>
        <button type="button" class="GROUP_MANAGER_GROUP_OPEN d-flex justify-content-between align-items-center w-100 border-0" draggable="false">
          <span class="GROUP_MANAGER_GROUP_TITLE text-bold text-start">${Safe(Group.Title)}</span>
          <div class="d-flex align-items-center gap-2">
            ${KeyBindBadge}
            <span class="badge bg-ghost-light text-light">
              ${GroupMembers.length} ${GroupMembers.length == 1 ? 'Member' : 'Members'}
            </span>
            <i class="bi bi-chevron-right group-manager-chevron"></i>
          </div>
        </button>
      </div>
    `);
  }

  const DefaultGroupMembers = GetGroupManagerMembers(null);
  $('#GROUP_MANAGER_GROUP_LIST').append(`
    <div class="GROUP_MANAGER_GROUP_ITEM GROUP_MANAGER_GROUP_ITEM_DEFAULT d-flex justify-content-between align-items-center p-3 rounded bg-ghost">
      <span class="GROUP_MANAGER_GROUP_TITLE text-start">Default Group</span>
      <div class="d-flex align-items-center gap-2">
        <span class="badge bg-ghost-light text-light">
          ${DefaultGroupMembers.length} ${DefaultGroupMembers.length == 1 ? 'Member' : 'Members'}
        </span>
        <span class="text-muted text-sm">Locked</span>
      </div>
    </div>
  `);

  $('#GROUP_MANAGER_GROUP_LIST').append(`
    <div class="d-grid gap-2 GROUP_MANAGER_GROUP_NEW">
      <button type="button" class="btn btn-sm btn-success" id="GROUP_MANAGER_NEW_GROUP">New Group</button>
    </div>
  `);

  const SortableContainer = document.getElementById('GROUP_MANAGER_SORTABLE_LIST');
  if (SortableContainer) {
    SortableContainer.addEventListener('dragover', (Event) => {
      Event.preventDefault();
      const Dragging = SortableContainer.querySelector('.GROUP_MANAGER_GROUP_ITEM.dragging');
      if (!Dragging) return;
      const After = GroupManagerDragAfterElement(SortableContainer, Event.clientY);
      if (After == null) {
        SortableContainer.appendChild(Dragging);
      } else {
        SortableContainer.insertBefore(Dragging, After);
      }
    });
    SortableContainer.addEventListener('drop', (Event) => Event.preventDefault());
  }

  $('#GROUP_MANAGER_GROUP_LIST')
    .off('dragstart.groupmanager dragend.groupmanager', '.GROUP_MANAGER_GROUP_ITEM')
    .on('dragstart.groupmanager', '.GROUP_MANAGER_GROUP_ITEM', function (Event) {
      this.classList.add('dragging');
      this.dataset.dragged = '';
      try {
        const DragEv = Event.originalEvent as DragEvent | undefined;
        DragEv!.dataTransfer!.effectAllowed = 'move';
        DragEv!.dataTransfer!.setData('text/plain', this.getAttribute('data-groupid') || '');
      } catch {
        // Some platforms require setData; ignore failures.
      }
    })
    .on('dragend.groupmanager', '.GROUP_MANAGER_GROUP_ITEM', async function () {
      this.classList.remove('dragging');
      this.dataset.dragged = '1';
      await PersistGroupManagerOrder();
    })
    // Clicking anywhere on a (non-default) group row opens its editor, not just
    // the chevron button. A drag leaves dataset.dragged==='1' so the click that
    // ends a reorder does not also open the editor.
    .off('click', '.GROUP_MANAGER_GROUP_ITEM:not(.GROUP_MANAGER_GROUP_ITEM_DEFAULT)')
    .on(
      'click',
      '.GROUP_MANAGER_GROUP_ITEM:not(.GROUP_MANAGER_GROUP_ITEM_DEFAULT)',
      async function () {
        if (this.dataset.dragged === '1') {
          this.dataset.dragged = '';
          return;
        }

        const GroupID = parseInt(this.getAttribute('data-groupid') || '', 10);
        if (!Number.isFinite(GroupID)) return;
        await OpenGroupManagerEditor(GroupID, false, Groups);
      }
    );

  $('#GROUP_MANAGER_GROUP_LIST')
    .off('click', '#GROUP_MANAGER_NEW_GROUP')
    .on('click', '#GROUP_MANAGER_NEW_GROUP', function () {
      OpenGroupCreationModal();
    });

  openModal('SHOWTRAK_MODAL_GROUPMANAGER');
}
