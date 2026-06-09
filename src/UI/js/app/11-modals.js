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

async function DeleteGroup(GroupID) {
  await window.API.DeleteGroup(GroupID);
  await OpenGroupManager(true);
  await Notify('Group deleted.', 'success');
}

async function OpenGroupManager(Relaunching = false) {
  if (!Relaunching) await CloseAllModals();

  let Groups = await window.API.GetAllGroups();

  $('#GROUP_MANAGER_GROUP_LIST').html('');
  console.log(GroupUUIDCache);
  for (const Group of Groups) {
    let GroupMembers = GroupUUIDCache.has(`${Group.GroupID}`)
      ? GroupUUIDCache.get(`${Group.GroupID}`)
      : [];
    $('#GROUP_MANAGER_GROUP_LIST').append(`
            <div class="GROUP_MANAGER_GROUP_ITEM d-flex justify-content-between align-items-center p-3 rounded bg-ghost" data-groupid="${
              Group.GroupID
            }">
                <span class="GROUP_MANAGER_GROUP_TITLE text-bold">
                    ${Safe(Group.Title)} 
                </span>
                <div class="d-flex gap-2">
                    <span class="badge bg-ghost-light text-light">
                        ${GroupMembers.length} ${GroupMembers.length == 1 ? 'Client' : 'Clients'}
                    </span>
                    <button type="button" class="badge bg-danger text-light cursor-pointer text-decoration-none border-0 GROUP_MANAGER_GROUP_DELETE" data-groupid="${
                      Group.GroupID
                    }">
                        Delete
                    </button>
                </div>
            </div>
        `);
  }

  let GroupMembers = GroupUUIDCache.has(`null`) ? GroupUUIDCache.get(`null`) : [];
  $('#GROUP_MANAGER_GROUP_LIST').append(`
        <div class="GROUP_MANAGER_GROUP_ITEM d-flex justify-content-between align-items-center p-3 rounded bg-ghost">
            <span class="GROUP_MANAGER_GROUP_TITLE">
                Default Group
            </span>
            <span class="badge bg-ghost-light text-light">
                ${GroupMembers.length} ${GroupMembers.length == 1 ? 'Client' : 'Clients'}
            </span>
        </div>
    `);

  $('#GROUP_MANAGER_GROUP_LIST').append(`
        <div class="d-grid gap-2">
            <button type="button" class="btn btn-sm btn-success" id="GROUP_MANAGER_NEW_GROUP">New Group</button>
        </div>
    `);

  $('#GROUP_MANAGER_GROUP_LIST')
    .off('click', '.GROUP_MANAGER_GROUP_DELETE')
    .on('click', '.GROUP_MANAGER_GROUP_DELETE', async function () {
      const GroupID = parseInt($(this).attr('data-groupid'), 10);
      if (isNaN(GroupID)) return;
      await DeleteGroup(GroupID);
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

async function AdoptDevice(UUID) {
  await window.API.AdoptDevice(UUID);
}
