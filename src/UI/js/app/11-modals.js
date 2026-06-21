async function ExecuteScript(Script, Targets) {
  let ScriptTarget = ScriptList.find((s) => s.ID === Script);
  if (!ScriptTarget) return Notify('Script not found', 'error');
  await window.API.ExecuteScript(Script, Targets, true);
  ShowExecutionToast();
}

window.API.OSCBulkAction(async (Type, Targets, Args = null) => {
  if (Type == 'ExecuteScript') return await ExecuteScript(Args, Targets);
  if (Type == 'WOL') {
    window.API.WakeOnLan(Targets);
    ShowExecutionToast();
    return;
  }
  if (Type == 'InternalScript') return;
  if (Type == 'Select') return Targets.map((UUID) => Select(UUID));
  if (Type == 'Deselect') return Targets.map((UUID) => Deselect(UUID));
});

async function CloseAllModals() {
  $('.modal').modal('hide');
  await Wait(300);
  return;
}

function FormatDependencyVersion(Version) {
  const RawVersion = Version ? String(Version) : '';
  const SemverMatch = RawVersion.match(/(\d+)\.(\d+)/);
  if (SemverMatch) return `${SemverMatch[1]}.${SemverMatch[2]}`;
  return RawVersion.replace(/^[~^<>=\s]+/, '') || '-';
}

function RenderAboutDependencyList(Dependencies = []) {
  const Group = $('<div class="SHOWTRAK_ABOUT_DEPENDENCY_GROUP"></div>');

  if (!Dependencies.length) {
    Group.append($('<div class="text-muted"></div>').text('None'));
    return Group;
  }

  for (const Dependency of Dependencies) {
    const Name = Dependency && Dependency.name ? String(Dependency.name) : 'unknown';
    const Version = FormatDependencyVersion(Dependency && Dependency.version);
    const Item = $('<div class="SHOWTRAK_ABOUT_DEPENDENCY_ITEM"></div>');
    const PackageLink = $(
      '<button type="button" class="btn btn-link p-0 SHOWTRAK_ABOUT_DEPENDENCY_LINK"></button>'
    )
      .text(Name)
      .attr('data-package-name', Name);

    Item.append($('<span class="SHOWTRAK_ABOUT_DEPENDENCY_NAME"></span>').append(PackageLink));
    Item.append($('<span class="SHOWTRAK_ABOUT_DEPENDENCY_VERSION"></span>').text(Version));
    Group.append(Item);
  }

  return Group;
}

async function OpenAboutModal() {
  await CloseAllModals();
  try {
    const Version = Config && Config.Application ? Config.Application.Version : null;
    $('#SHOWTRAK_ABOUT_VERSION').text(Version ? `Version ${Version}` : '');
  } catch {
    $('#SHOWTRAK_ABOUT_VERSION').text('');
  }

  const DependenciesContainer = $('#SHOWTRAK_ABOUT_DEPENDENCIES');
  const DependenciesCount = $('#SHOWTRAK_ABOUT_DEPENDENCY_COUNT');
  DependenciesContainer.empty().text('Loading dependencies...');
  DependenciesCount.text('');

  try {
    const [Err, Payload] = await window.API.GetProjectDependencies();
    if (Err) throw new Error(Err);

    const RuntimeDependencies = Array.isArray(Payload && Payload.dependencies)
      ? Payload.dependencies
      : [];

    DependenciesContainer.empty();
    DependenciesContainer.append(RenderAboutDependencyList(RuntimeDependencies));
    DependenciesCount.text(`${RuntimeDependencies.length} total`);
  } catch {
    DependenciesContainer.empty().text('Could not load dependencies.');
    DependenciesCount.text('Unavailable');
  }

  $('#SHOWTRAK_MODAL_ABOUT').modal('show');
}

async function OpenGroupCreationModal() {
  await CloseAllModals();

  let Groups = await window.API.GetAllGroups();
  if (!Groups) Groups = [];

  $('#SHOWTRAL_MODAL_GROUPCREATION').modal('show');

  $('#GROUP_CREATION_SUBMIT')
    .off('click')
    .on('click', async () => {
      let GroupName = $('#GROUP_CREATION_TITLE').val();
      if (!GroupName) return Notify('Please enter a group name', 'error');
      if (GroupName.length < 3)
        return Notify('Group name must be at least 3 characters long', 'error');
      if (Groups.some((g) => g.Title.toLowerCase() === GroupName.toLowerCase())) {
        return Notify('A group with this name already exists', 'error');
      }
      if (GroupName.length > 12)
        return Notify('Group name must be less than 12 characters long', 'error');

      // Clear the input field
      $('#GROUP_CREATION_TITLE').val('');

      await window.API.CreateGroup(GroupName);
      OpenGroupManager();
      $('#SHOWTRAL_MODAL_GROUPCREATION').modal('hide');
    });
}

async function OpenShow() {
  console.log('Opening ShowTrak file');
  const [Err] = await window.API.OpenShow();
  if (Err) {
    if (/cancelled by user/i.test(String(Err))) return;
    await Notify(String(Err), 'error');
    return;
  }
  await Notify('Opened ShowTrak file.', 'success');
}

// Derive a display name from a .ShowTrak path: basename without the extension.
function GetShowFileDisplayName(Path) {
  if (!Path) return '';
  const Base = String(Path).split(/[\\/]/).pop() || '';
  return Base.replace(/\.showtrak$/i, '');
}

// Show the currently open file name in the navbar (empty when none is open).
function RenderShowFileName(Path) {
  $('#APPLICATION_NAVBAR_FILE').text(GetShowFileDisplayName(Path));
}

async function SaveShow() {
  console.log('Saving ShowTrak file');
  const [Err] = await window.API.SaveShow();
  if (Err) {
    if (/cancelled by user/i.test(String(Err))) return;
    await Notify(String(Err), 'error');
    return;
  }
  await Notify('Saved ShowTrak file.', 'success');
}

async function SaveShowAs() {
  console.log('Saving ShowTrak file');
  const [Err] = await window.API.SaveShowAs();
  if (Err) {
    if (/cancelled by user/i.test(String(Err))) return;
    await Notify(String(Err), 'error');
    return;
  }
  await Notify('Saved ShowTrak file.', 'success');
}

async function NewShow() {
  const Confirmed = await ConfirmationDialog(
    'Create a new show? This clears the current working data.'
  );
  if (!Confirmed) return;
  const [Err] = await window.API.NewShow();
  if (Err) {
    await Notify(String(Err), 'error');
    return;
  }
  await Notify('Created new show.', 'success');
}

let GroupManagerEditingGroupID = null;
let GroupManagerRenameDebounceTimer = null;
let GroupManagerRenameLastSavedTitle = '';

function GroupManagerInGroup(EntityGroupID, GroupID) {
  if (GroupID == null) return EntityGroupID == null;
  if (EntityGroupID == null) return false;
  return Number(EntityGroupID) === Number(GroupID);
}

function GetGroupManagerMembers(GroupID) {
  const Members = [];

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

function GetGroupManagerClients(GroupID) {
  const Clients = Array.isArray(__LastClients) ? __LastClients : [];
  return Clients.filter((Client) => GroupManagerInGroup(Client.GroupID, GroupID)).sort(
    (a, b) => (a.Weight || 0) - (b.Weight || 0)
  );
}

async function ResolveGroupManagerClients(GroupID) {
  const CachedClients = GetGroupManagerClients(GroupID);
  const CacheByUUID = new Map(
    CachedClients.map((Client) => [
      String(Client && Client.UUID ? Client.UUID : '').trim(),
      Client,
    ]).filter(([UUID]) => UUID.length > 0)
  );

  const GroupUUIDs = Array.isArray(GroupUUIDCache.get(`${GroupID}`))
    ? GroupUUIDCache.get(`${GroupID}`)
    : [];
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

  const OrderedClients = [];
  const Seen = new Set();
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

async function ResolveGroupManagerEntities(GroupID) {
  const Entities = [];

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

function RenderGroupManagerEditorClientRows(Entities = [], GroupID) {
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

async function SaveGroupManagerName(Groups = [], { notifyOnValidationError = false } = {}) {
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
  if (NextTitle.length > 50) {
    if (notifyOnValidationError) {
      await Notify('Group name must be 50 characters or less', 'error');
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

function BindGroupManagerEditorHandlers(Groups = []) {
  $('#GROUP_MANAGER_EDITOR_BACK')
    .off('click')
    .on('click', async function () {
      $('#SHOWTRAK_MODAL_GROUP_EDITOR').modal('hide');
      await OpenGroupManager(true);
    });

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
      $('#SHOWTRAK_MODAL_GROUP_EDITOR').modal('hide');
      await DeleteGroup(GroupID);
    });

  $('#GROUP_MANAGER_EDITOR_CLIENT_LIST')
    .off('click', '.GROUP_MANAGER_MEMBER_REMOVE')
    .on('click', '.GROUP_MANAGER_MEMBER_REMOVE', async function () {
      const Kind = String($(this).attr('data-kind') || '')
        .trim()
        .toLowerCase();
      const EntityID = String($(this).attr('data-id') || '').trim();
      const GroupID = parseInt($(this).attr('data-groupid'), 10);
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

async function OpenGroupManagerEditor(GroupID, Relaunching = false, PrefetchedGroups = null) {
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

  const Clients = await ResolveGroupManagerEntities(Group.GroupID);
  $('#GROUP_MANAGER_EDITOR_CLIENT_LIST').html(
    RenderGroupManagerEditorClientRows(Clients, Number(Group.GroupID))
  );

  BindGroupManagerEditorHandlers(Groups);

  if (!Relaunching) {
    $('#SHOWTRAK_MODAL_GROUPMANAGER').modal('hide');
  }
  $('#SHOWTRAK_MODAL_GROUP_EDITOR').modal('show');
}

async function DeleteGroup(GroupID) {
  await window.API.DeleteGroup(GroupID);
  await OpenGroupManager(true);
  await Notify('Group deleted.', 'success');
}

function GroupManagerDragAfterElement(Container, Y) {
  const Items = [...Container.querySelectorAll('.GROUP_MANAGER_GROUP_ITEM:not(.dragging)')];
  let Closest = { offset: Number.NEGATIVE_INFINITY, element: null };

  for (const Child of Items) {
    const Box = Child.getBoundingClientRect();
    const Offset = Y - Box.top - Box.height / 2;
    if (Offset < 0 && Offset > Closest.offset) {
      Closest = { offset: Offset, element: Child };
    }
  }

  return Closest.element;
}

async function PersistGroupManagerOrder() {
  const Container = document.getElementById('GROUP_MANAGER_SORTABLE_LIST');
  if (!Container) return true;

  const OrderedGroupIDs = [...Container.querySelectorAll('.GROUP_MANAGER_GROUP_ITEM')]
    .map((el) => parseInt(el.getAttribute('data-groupid'), 10))
    .filter((id) => Number.isFinite(id));

  if (!OrderedGroupIDs.length) return true;

  const [Err] = await window.API.SetGroupListOrder(OrderedGroupIDs);
  if (Err) {
    await Notify(`Failed to reorder groups: ${Err}`, 'error');
    return false;
  }

  return true;
}

async function OpenGroupManager(Relaunching = false) {
  if (!Relaunching) await CloseAllModals();

  let Groups = await window.API.GetAllGroups();
  if (!Array.isArray(Groups)) Groups = [];

  $('#GROUP_MANAGER_GROUP_LIST').html(
    '<div id="GROUP_MANAGER_SORTABLE_LIST" class="d-grid gap-2"></div>'
  );

  for (const Group of Groups) {
    const GroupMembers = GetGroupManagerMembers(Group.GroupID);
    const GroupID = parseInt(Group.GroupID, 10);

    $('#GROUP_MANAGER_SORTABLE_LIST').append(`
      <div class="GROUP_MANAGER_GROUP_ITEM p-3 rounded bg-ghost d-flex align-items-center gap-2" data-groupid="${GroupID}" draggable="true">
        <span class="group-manager-grip" title="Drag to reorder"><i class="bi bi-grip-vertical"></i></span>
        <button type="button" class="GROUP_MANAGER_GROUP_OPEN d-flex justify-content-between align-items-center w-100 border-0" draggable="false">
          <span class="GROUP_MANAGER_GROUP_TITLE text-bold text-start">${Safe(Group.Title)}</span>
          <div class="d-flex align-items-center gap-2">
            <span class="badge bg-ghost-light text-light">
              ${GroupMembers.length} ${GroupMembers.length == 1 ? 'Member' : 'Members'}
            </span>
            <i class="bi bi-chevron-right group-manager-chevron"></i>
          </div>
        </button>
      </div>
    `);
  }

  let DefaultGroupMembers = GetGroupManagerMembers(null);
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
        Event.originalEvent.dataTransfer.effectAllowed = 'move';
        Event.originalEvent.dataTransfer.setData('text/plain', this.getAttribute('data-groupid'));
      } catch {
        // Some platforms require setData; ignore failures.
      }
    })
    .on('dragend.groupmanager', '.GROUP_MANAGER_GROUP_ITEM', async function () {
      this.classList.remove('dragging');
      this.dataset.dragged = '1';
      await PersistGroupManagerOrder();
    })
    .off('click', '.GROUP_MANAGER_GROUP_OPEN')
    .on('click', '.GROUP_MANAGER_GROUP_OPEN', async function () {
      const Row = $(this).closest('.GROUP_MANAGER_GROUP_ITEM').get(0);
      if (Row && Row.dataset.dragged === '1') {
        Row.dataset.dragged = '';
        return;
      }

      const GroupID = parseInt(
        $(this).closest('.GROUP_MANAGER_GROUP_ITEM').attr('data-groupid'),
        10
      );
      if (!Number.isFinite(GroupID)) return;
      await OpenGroupManagerEditor(GroupID, false, Groups);
    });

  $('#GROUP_MANAGER_GROUP_LIST')
    .off('click', '#GROUP_MANAGER_NEW_GROUP')
    .on('click', '#GROUP_MANAGER_NEW_GROUP', function () {
      OpenGroupCreationModal();
    });

  $('#SHOWTRAK_MODAL_GROUPMANAGER').modal('show');
}

async function OpenClientEditor(UUID) {
  let Client = await window.API.GetClient(UUID);
  if (!Client) return console.error('Client not found:', UUID);

  let Groups = await window.API.GetAllGroups();
  if (!Groups) Groups = [];
  Groups.push({
    GroupID: null,
    Title: 'No Group',
    Weight: 100000,
  });

  $('#CLIENT_EDITOR_GROUPID').html('');
  for (const Group of Groups) {
    $('#CLIENT_EDITOR_GROUPID').append(
      `<option value="${Group.GroupID}" ${Client.GroupID == Group.GroupID ? 'selected' : ''}>${Safe(
        Group.Title
      )}</option>`
    );
  }

  ClearSelection();

  const { Nickname, Hostname, IP, Version, MacAddress } = Client;

  $('#CLIENT_EDITOR_NICKNAME').val(Nickname ? Nickname : Hostname);
  $('#CLIENT_EDITOR_HOSTNAME').val(Hostname);
  $('#CLIENT_EDITOR_IP').val(IP);
  if (MacAddress && String(MacAddress).trim().length > 0) {
    $('#CLIENT_EDITOR_MAC').val(MacAddress.toUpperCase());
    $('#CLIENT_EDITOR_MAC_WRAPPER').removeClass('d-none');
  } else {
    $('#CLIENT_EDITOR_MAC').val('');
    $('#CLIENT_EDITOR_MAC_WRAPPER').addClass('d-none');
  }
  $('#CLIENT_EDITOR_UUID').val(UUID);
  $('#CLIENT_EDITOR_VERSION').val(Version);

  $('#SHOWTRAK_CLIENT_EDITOR_USB_DEVICES').html('');
  // USB section moved to read-only Client Info modal
  $('#SHOWTRAK_CLIENT_EDITOR_USB_DEVICES').remove();

  $('#SHOWTRAK_CLIENT_EDITOR_UPDATE')
    .off('click')
    .on('click', async () => {
      await CloseAllModals();
      await window.API.CheckForUpdatesOnClient(UUID);
      ShowExecutionToast();
    });

  $('#SHOWTRAK_CLIENT_EDITOR_REMOVE')
    .off('click')
    .on('click', async () => {
      await CloseAllModals();
      let Confirmation = await ConfirmationDialog(
        `Are you sure you want to delete ${Nickname || Hostname}?`
      );
      if (!Confirmation) return;
      await window.API.UnadoptClient(UUID);
      await Notify(`Unadopted ${Nickname ? Nickname : Hostname}`, 'success');
    });

  const replacementCandidates = (Array.isArray(PendingAdoption) ? PendingAdoption : []).filter(
    (Device) => Device && Device.UUID && String(Device.UUID) !== String(UUID)
  );
  const canReplace = !Client.Online;
  $('#SHOWTRAK_CLIENT_EDITOR_REPLACE')
    .toggleClass('d-none', !canReplace)
    .prop('disabled', replacementCandidates.length === 0)
    .off('click')
    .on('click', async () => {
      await OpenClientReplacementModal(Client);
    });

  $('#SHOWTRAK_CLIENT_EDITOR_SAVE')
    .off('click')
    .on('click', async () => {
      let Nickname = $('#CLIENT_EDITOR_NICKNAME').val();
      if (!Nickname) Nickname = Hostname;

      let GroupID = $('#CLIENT_EDITOR_GROUPID').val();
      if (GroupID == null || GroupID == 'null') {
        GroupID = null;
      } else {
        GroupID = parseInt(GroupID);
      }

      await window.API.UpdateClient(UUID, {
        Nickname: Nickname,
        GroupID: GroupID,
      });
      await CloseAllModals();
    });

  $('#SHOWTRAK_CLIENT_EDITOR').modal('show');
}

async function OpenClientReplacementModal(Client) {
  if (!Client || !Client.UUID) return;
  const currentUUID = String(Client.UUID);
  const currentName = Client.Nickname || Client.Hostname || currentUUID;
  const candidates = (Array.isArray(PendingAdoption) ? PendingAdoption : []).filter(
    (Device) => Device && Device.UUID && String(Device.UUID) !== currentUUID
  );

  $('#CLIENT_REPLACE_MODAL_TITLE').text(`Replace ${currentName}`);

  if (!candidates.length) {
    $('#CLIENT_REPLACE_LIST').html(`
      <div class="rounded-3 p-3 bg-ghost text-muted text-center">
        No devices are pending adoption.
      </div>
    `);
  } else {
    let html = '';
    for (const Device of candidates) {
      const Name = Device.Hostname || 'Unknown Host';
      const IP = Device.IP || 'Unknown IP';
      const ReplacementUUID = String(Device.UUID);
      html += `
        <div class="SHOWTRAK_CLIENT_PENDING_ADOPTION rounded-3 d-flex justify-content-between align-items-center p-3">
          <div class="text-start">
            <h6 class="mb-1">${Safe(Name)}</h6>
            <small class="text-sm text-light">${Safe(IP)}</small>
          </div>
          <button
            type="button"
            class="btn btn-sm btn-warning SHOWTRAK_BTN_ROUNDED REPLACE_CLIENT_BTN"
            data-current-uuid="${Safe(currentUUID)}"
            data-replacement-uuid="${Safe(ReplacementUUID)}"
          >
            Replace
          </button>
        </div>
      `;
    }
    $('#CLIENT_REPLACE_LIST').html(html);
  }

  $('#CLIENT_REPLACE_LIST')
    .off('click.replace', '.REPLACE_CLIENT_BTN')
    .on('click.replace', '.REPLACE_CLIENT_BTN', async function () {
      const CurrentUUID = String($(this).attr('data-current-uuid') || '').trim();
      const ReplacementUUID = String($(this).attr('data-replacement-uuid') || '').trim();
      if (!CurrentUUID || !ReplacementUUID) return;

      $('#CLIENT_REPLACE_LIST .REPLACE_CLIENT_BTN').prop('disabled', true);
      const [Err] = await window.API.ReplaceClient(CurrentUUID, ReplacementUUID);
      if (Err) {
        await Notify(String(Err), 'error');
        $('#CLIENT_REPLACE_LIST .REPLACE_CLIENT_BTN').prop('disabled', false);
        return;
      }

      await CloseAllModals();
      await Notify('Client replaced successfully', 'success');
    });

  await CloseAllModals();
  $('#SHOWTRAK_MODAL_CLIENT_REPLACE').modal('show');
}

async function AdoptDevice(UUID) {
  await window.API.AdoptDevice(UUID);
}

function FindClientExecutionForUpdate(UUID) {
  if (!UpdateManagerClientProgress || !(UpdateManagerClientProgress instanceof Map)) return null;
  return UpdateManagerClientProgress.get(UUID) || null;
}

function GetUpdateStatusClass(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'online') return 'text-success';
  if (value === 'offline') return 'text-danger';
  return 'text-muted';
}

function GetUpdateProgressPercent(Execution) {
  if (!Execution) return 0;
  if (Execution.Status === 'Completed') return 100;
  const raw = Number(Execution.Progress);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function GetUpdateStatusText(Execution) {
  if (!Execution) return 'Ready to update';
  if (Execution.Status === 'Failed') return Execution.Error || Execution.StatusText || 'Failed';
  if (Execution.Status === 'Completed') return 'Updated';
  return Execution.StatusText || 'Pending';
}

function NormalizeVersionToken(value) {
  return String(value || '')
    .trim()
    .replace(/^v/i, '')
    .toLowerCase();
}

function ParseSemverTuple(value) {
  const match = String(value || '')
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)$/i);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function IsVersionAtLeast(value, minimumTuple) {
  const parsed = ParseSemverTuple(value);
  if (!parsed) return false;
  for (let i = 0; i < minimumTuple.length; i++) {
    const current = parsed[i] || 0;
    const minimum = minimumTuple[i] || 0;
    if (current > minimum) return true;
    if (current < minimum) return false;
  }
  return true;
}

const MINIMUM_REMOTE_UPDATE_VERSION = [3, 4, 0];

function IsClientEligibleForSelectedRelease(Client, SelectedTag) {
  if (!Client || !Client.UUID) {
    return { eligible: false, reason: 'Unknown client' };
  }
  if (!Client.Online) {
    return { eligible: false, reason: 'Offline' };
  }

  if (!IsVersionAtLeast(Client.Version, MINIMUM_REMOTE_UPDATE_VERSION)) {
    return { eligible: false, reason: 'Manual update required (< 3.4.0)' };
  }

  const targetVersion = NormalizeVersionToken(SelectedTag);
  if (!targetVersion) {
    return { eligible: false, reason: 'Select a release' };
  }

  const clientVersion = NormalizeVersionToken(Client.Version);
  if (clientVersion && clientVersion === targetVersion) {
    return { eligible: false, reason: 'Already on selected version' };
  }

  return { eligible: true, reason: 'Ready to deploy' };
}

function ResetUpdateManagerClientSelectionDefaults() {
  const selectedTag = GetSelectedUpdateManagerReleaseTag();
  const Clients = Array.isArray(__LastClients) ? __LastClients : [];
  const next = new Set();

  for (const Client of Clients) {
    const eligibility = IsClientEligibleForSelectedRelease(Client, selectedTag);
    if (eligibility.eligible) {
      next.add(Client.UUID);
    }
  }

  UpdateManagerSelectedClients = next;
}

function GetSelectedUpdateManagerDeployTargets() {
  const selectedTag = GetSelectedUpdateManagerReleaseTag();
  const selectedSet =
    UpdateManagerSelectedClients instanceof Set
      ? UpdateManagerSelectedClients
      : new Set(UpdateManagerSelectedClients || []);

  const Clients = Array.isArray(__LastClients) ? __LastClients : [];
  const targets = [];

  for (const Client of Clients) {
    if (!Client || !Client.UUID) continue;
    if (!selectedSet.has(Client.UUID)) continue;
    const eligibility = IsClientEligibleForSelectedRelease(Client, selectedTag);
    if (!eligibility.eligible) continue;
    targets.push(Client.UUID);
  }

  return targets;
}

function SetUpdateManagerDownloadProgress(Percent = 0, Message = '') {
  const safePercent = Math.max(0, Math.min(100, Math.round(Number(Percent) || 0)));
  $('#UPDATE_MANAGER_DOWNLOAD_PROGRESS_WRAPPER').removeClass('d-none');
  $('#UPDATE_MANAGER_DOWNLOAD_PROGRESS_BAR')
    .css('width', `${safePercent}%`)
    .attr('aria-valuenow', safePercent);
  $('#UPDATE_MANAGER_DOWNLOAD_PROGRESS_TEXT').text(Message || `Downloading... ${safePercent}%`);
}

function GetSelectedUpdateManagerReleaseTag() {
  return String($('#UPDATE_MANAGER_RELEASE_SELECT').val() || '').trim();
}

function RenderUpdateManagerReleaseBadge() {
  const selectedTag = GetSelectedUpdateManagerReleaseTag();
  const downloadedTag =
    UpdateManagerReleaseStatus && UpdateManagerReleaseStatus.ReleaseVersion
      ? String(UpdateManagerReleaseStatus.ReleaseVersion)
      : '';
  const isDownloaded = !!(
    selectedTag &&
    downloadedTag &&
    selectedTag === downloadedTag &&
    UpdateManagerReleaseStatus &&
    UpdateManagerReleaseStatus.Ready
  );

  const $badge = $('#UPDATE_MANAGER_RELEASE_BADGE');
  if (!$badge.length) return;

  $badge
    .removeClass('DOWNLOADED NOT_DOWNLOADED')
    .addClass(isDownloaded ? 'DOWNLOADED' : 'NOT_DOWNLOADED')
    .text(isDownloaded ? 'Downloaded' : 'Not downloaded');
}

function RenderUpdateManagerReleaseOptions() {
  const $select = $('#UPDATE_MANAGER_RELEASE_SELECT');
  if (!$select.length) return;

  const options = Array.isArray(UpdateManagerReleaseOptions) ? UpdateManagerReleaseOptions : [];
  const downloadedTag =
    UpdateManagerReleaseStatus && UpdateManagerReleaseStatus.ReleaseVersion
      ? String(UpdateManagerReleaseStatus.ReleaseVersion)
      : '';

  let html = '';
  for (const item of options) {
    const tag = String(item && item.tag ? item.tag : '').trim();
    if (!tag) continue;
    const name = String(item && item.name ? item.name : tag).trim();
    const isDownloaded = downloadedTag && downloadedTag === tag;
    html += `<option value="${Safe(tag)}">${Safe(name)}${isDownloaded ? ' (downloaded)' : ''}</option>`;
  }

  $select.html(html);

  const targetTag =
    UpdateManagerSelectedReleaseTag || downloadedTag || (options[0] && options[0].tag) || '';
  if (targetTag) {
    $select.val(targetTag);
    UpdateManagerSelectedReleaseTag = String($select.val() || targetTag);
  }

  RenderUpdateManagerReleaseBadge();
}

async function RefreshUpdateManagerReleaseOptions() {
  const [Err, List] = await window.API.GetUpdateManagerReleases();
  if (Err) {
    $('#UPDATE_MANAGER_STATUS').text(String(Err));
    return;
  }

  UpdateManagerReleaseOptions = Array.isArray(List) ? List : [];
  RenderUpdateManagerReleaseOptions();
}

function ApplyUpdateManagerButtonLocks() {
  const selectedTag = GetSelectedUpdateManagerReleaseTag();
  UpdateManagerSelectedReleaseTag = selectedTag;
  const SelectedTargets = GetSelectedUpdateManagerDeployTargets();
  const HasReadyBuild = !!(
    UpdateManagerReleaseStatus &&
    UpdateManagerReleaseStatus.Ready &&
    UpdateManagerReleaseStatus.ReleaseVersion &&
    selectedTag &&
    String(UpdateManagerReleaseStatus.ReleaseVersion) === selectedTag
  );
  const DisableDeploy =
    UpdateManagerDownloadInProgress ||
    UpdateManagerRunning ||
    !HasReadyBuild ||
    !selectedTag ||
    SelectedTargets.length === 0;
  const DisableDownload = UpdateManagerDownloadInProgress || UpdateManagerRunning;

  $('#UPDATE_MANAGER_DEPLOY_ALL').prop('disabled', DisableDeploy);
  $('#UPDATE_MANAGER_DOWNLOAD_LATEST').prop('disabled', DisableDownload);
  RenderUpdateManagerReleaseBadge();
}

function RenderUpdateManagerClientList() {
  const $list = $('#UPDATE_MANAGER_CLIENT_LIST');
  if (!$list.length) return;

  const Clients = Array.isArray(__LastClients) ? __LastClients.slice() : [];
  if (!Clients.length) {
    $list.html('<div class="text-muted small">No clients found.</div>');
    return;
  }

  Clients.sort((a, b) => {
    const aName = String(a.Nickname || a.Hostname || a.UUID || '').toLowerCase();
    const bName = String(b.Nickname || b.Hostname || b.UUID || '').toLowerCase();
    return aName.localeCompare(bName);
  });

  let html = '';
  const selectedTag = GetSelectedUpdateManagerReleaseTag();
  const manualUpdateClients = [];
  if (!(UpdateManagerSelectedClients instanceof Set)) {
    UpdateManagerSelectedClients = new Set(UpdateManagerSelectedClients || []);
  }

  for (const Client of Clients) {
    const UUID = Client.UUID;
    const Name = Safe(Client.Nickname || Client.Hostname || UUID);
    const Version = Safe(Client.Version || 'Unknown');
    const Online = !!Client.Online;
    const Execution = FindClientExecutionForUpdate(UUID);
    const Percent = GetUpdateProgressPercent(Execution);
    const Status = Online ? 'Online' : 'Offline';
    const eligibility = IsClientEligibleForSelectedRelease(Client, selectedTag);
    const IsSelectable = !!eligibility.eligible;
    const IsChecked = IsSelectable && UpdateManagerSelectedClients.has(UUID);

    if (!IsSelectable && String(eligibility.reason || '').includes('Manual update required')) {
      manualUpdateClients.push(Name);
    }

    const StatusText = Safe(
      IsSelectable
        ? Online
          ? GetUpdateStatusText(Execution)
          : eligibility.reason
        : eligibility.reason
    );

    html += `
      <div class="UPDATE_MANAGER_CLIENT_ITEM ${Online ? 'ONLINE' : 'OFFLINE'}" data-uuid="${Safe(UUID)}">
        <div class="UPDATE_MANAGER_CLIENT_HEADER">
          <div class="UPDATE_MANAGER_CLIENT_SELECT_WRAP">
            <input
              class="form-check-input UPDATE_MANAGER_CLIENT_SELECT"
              type="checkbox"
              data-uuid="${Safe(UUID)}"
              ${IsChecked ? 'checked' : ''}
              ${IsSelectable ? '' : 'disabled'}
            />
          </div>
          <div class="UPDATE_MANAGER_CLIENT_MAIN">
            <div class="UPDATE_MANAGER_CLIENT_NAME">${Name}</div>
            <div class="UPDATE_MANAGER_CLIENT_META">v${Version}</div>
          </div>
          <div class="UPDATE_MANAGER_CLIENT_STATUS ${GetUpdateStatusClass(Status)}">${Safe(Status)}</div>
        </div>
        <div class="progress UPDATE_MANAGER_CLIENT_PROGRESS">
          <div class="progress-bar ${Execution && Execution.Status === 'Failed' ? 'bg-danger' : 'bg-success'}" role="progressbar" style="width: ${Percent}%" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Percent}"></div>
        </div>
        <div class="UPDATE_MANAGER_CLIENT_STATUS_TEXT">${StatusText}</div>
      </div>`;
  }

  if (manualUpdateClients.length > 0) {
    const warningList = manualUpdateClients
      .map((displayName) => `<li>${displayName}</li>`)
      .join('');
    html = `
      <div class="UPDATE_MANAGER_WARNING">
        <div class="UPDATE_MANAGER_WARNING_TITLE">Manual Update Required</div>
        <div class="UPDATE_MANAGER_WARNING_TEXT">
          The following clients are running below v3.4.0 and do not support remote updates.
        </div>
        <ul class="UPDATE_MANAGER_WARNING_LIST">${warningList}</ul>
      </div>
      ${html}`;
  }

  $list.html(html);
}

function UpdateManagerHandleExecutions(Executions = []) {
  if (!(UpdateManagerClientProgress instanceof Map)) {
    UpdateManagerClientProgress = new Map();
  }

  UpdateManagerClientProgress.clear();

  for (const Execution of Executions) {
    if (!Execution || !Execution.Client || !Execution.Script) continue;
    if (String(Execution.Script.Name || '') !== 'Updating Client Software') continue;
    if (!Execution.Client.UUID) continue;
    UpdateManagerClientProgress.set(Execution.Client.UUID, Execution);
  }

  if ($('#SHOWTRAK_MODAL_UPDATE_MANAGER').hasClass('show')) {
    RenderUpdateManagerClientList();
  }
}

async function RefreshUpdateManagerStatus() {
  const [Err, Status] = await window.API.GetUpdateManagerStatus();
  if (Err) {
    $('#UPDATE_MANAGER_RELEASE').text('Release: unavailable');
    $('#UPDATE_MANAGER_STATUS').text(String(Err));
    ApplyUpdateManagerButtonLocks();
    return;
  }

  UpdateManagerReleaseStatus = Status || null;
  const Version = Status && Status.ReleaseVersion ? Status.ReleaseVersion : 'none downloaded';
  const DownloadedAt =
    Status && Status.DownloadedAt ? new Date(Status.DownloadedAt).toLocaleString() : null;

  $('#UPDATE_MANAGER_RELEASE').text(`Release: ${Version}`);
  $('#UPDATE_MANAGER_STATUS').text(
    DownloadedAt
      ? `Cached on server at ${DownloadedAt}`
      : 'No cached release yet. Run update to download the latest release.'
  );

  if (!UpdateManagerDownloadInProgress) {
    if (Status && Status.Ready) {
      $('#UPDATE_MANAGER_DOWNLOAD_PROGRESS_WRAPPER').addClass('d-none');
    } else {
      SetUpdateManagerDownloadProgress(0, 'No downloaded build yet');
    }
  }

  ApplyUpdateManagerButtonLocks();
}

async function RunUpdateManagerDownloadLatest() {
  if (UpdateManagerDownloadInProgress || UpdateManagerRunning) return;

  const selectedTag = GetSelectedUpdateManagerReleaseTag();
  if (!selectedTag) {
    await Notify('Select a release first', 'error');
    return;
  }

  UpdateManagerDownloadInProgress = true;
  ApplyUpdateManagerButtonLocks();
  SetUpdateManagerDownloadProgress(0, `Preparing download for ${selectedTag}...`);
  $('#UPDATE_MANAGER_STATUS').text(`Downloading ${selectedTag} to ShowTrakServer...`);

  try {
    const [Err, Result] = await window.API.DownloadUpdateManagerRelease(selectedTag);
    if (Err) {
      await Notify(String(Err), 'error');
      $('#UPDATE_MANAGER_STATUS').text(String(Err));
      return;
    }

    SetUpdateManagerDownloadProgress(100, `Downloaded ${Result.ReleaseVersion}`);
    await Notify(`Downloaded build ${Result.ReleaseVersion}`, 'success');
    await RefreshUpdateManagerStatus();
    await RefreshUpdateManagerReleaseOptions();
  } catch (Err) {
    const Message = Err && Err.message ? Err.message : String(Err);
    $('#UPDATE_MANAGER_STATUS').text(Message);
    await Notify(Message, 'error');
  } finally {
    UpdateManagerDownloadInProgress = false;
    ApplyUpdateManagerButtonLocks();
  }
}

async function RunUpdateManagerDeployAll() {
  if (UpdateManagerRunning) return;

  const selectedTag = GetSelectedUpdateManagerReleaseTag();
  if (!selectedTag) {
    await Notify('Select a release to deploy', 'error');
    return;
  }

  const SelectedTargets = GetSelectedUpdateManagerDeployTargets();
  if (SelectedTargets.length === 0) {
    await Notify('Select at least one eligible online client', 'error');
    return;
  }

  UpdateManagerRunning = true;
  ApplyUpdateManagerButtonLocks();
  $('#UPDATE_MANAGER_STATUS').text(`Deploying ${selectedTag} to online clients...`);

  try {
    const [Err, Result] = await window.API.DeployUpdateManagerRelease(selectedTag, SelectedTargets);
    if (Err) {
      await Notify(String(Err), 'error');
      $('#UPDATE_MANAGER_STATUS').text(String(Err));
      return;
    }

    await Notify(`Update sent to ${Result.TargetCount} online clients`, 'success');
    $('#UPDATE_MANAGER_STATUS').text(
      `Updating ${Result.TargetCount} online clients to ${Result.ReleaseVersion}.`
    );
    RenderUpdateManagerClientList();
    ShowExecutionToast('Updating Client Software');
  } catch (Err) {
    const Message = Err && Err.message ? Err.message : String(Err);
    $('#UPDATE_MANAGER_STATUS').text(Message);
    await Notify(Message, 'error');
  } finally {
    UpdateManagerRunning = false;
    ApplyUpdateManagerButtonLocks();
  }
}

async function OpenUpdateManagerModal() {
  await CloseAllModals();
  await RefreshUpdateManagerStatus();
  await RefreshUpdateManagerReleaseOptions();
  ResetUpdateManagerClientSelectionDefaults();
  RenderUpdateManagerClientList();

  $('#UPDATE_MANAGER_REFRESH')
    .off('click')
    .on('click', async () => {
      await RefreshUpdateManagerStatus();
      RenderUpdateManagerClientList();
    });

  $('#UPDATE_MANAGER_DOWNLOAD_LATEST')
    .off('click')
    .on('click', async () => {
      await RunUpdateManagerDownloadLatest();
    });

  $('#UPDATE_MANAGER_DEPLOY_ALL')
    .off('click')
    .on('click', async () => {
      await RunUpdateManagerDeployAll();
    });

  $('#UPDATE_MANAGER_RELEASE_SELECT')
    .off('change')
    .on('change', function () {
      UpdateManagerSelectedReleaseTag = String($(this).val() || '').trim();
      ResetUpdateManagerClientSelectionDefaults();
      RenderUpdateManagerClientList();
      RenderUpdateManagerReleaseBadge();
      ApplyUpdateManagerButtonLocks();
    });

  $('#UPDATE_MANAGER_CLIENT_LIST')
    .off('change', '.UPDATE_MANAGER_CLIENT_SELECT')
    .on('change', '.UPDATE_MANAGER_CLIENT_SELECT', function () {
      const uuid = String($(this).attr('data-uuid') || '').trim();
      if (!uuid) return;
      if (!(UpdateManagerSelectedClients instanceof Set)) {
        UpdateManagerSelectedClients = new Set(UpdateManagerSelectedClients || []);
      }
      if ($(this).is(':checked')) {
        UpdateManagerSelectedClients.add(uuid);
      } else {
        UpdateManagerSelectedClients.delete(uuid);
      }
      ApplyUpdateManagerButtonLocks();
    });

  ApplyUpdateManagerButtonLocks();

  $('#SHOWTRAK_MODAL_UPDATE_MANAGER').modal('show');
}
