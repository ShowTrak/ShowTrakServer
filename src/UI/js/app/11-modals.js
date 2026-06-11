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
                    <button
                      type="button"
                      class="btn btn-sm btn-light copy-field-btn"
                      data-copy="${Group.GroupID}"
                      title="Copy Group ID"
                      aria-label="Copy Group ID"
                    >
                      <i class="bi bi-clipboard"></i>
                    </button>
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
  const isDownloaded =
    !!(
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

  const targetTag = UpdateManagerSelectedReleaseTag || downloadedTag || (options[0] && options[0].tag) || '';
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
  const HasReadyBuild =
    !!(
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
      IsSelectable ? (Online ? GetUpdateStatusText(Execution) : eligibility.reason) : eligibility.reason
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
  const DownloadedAt = Status && Status.DownloadedAt ? new Date(Status.DownloadedAt).toLocaleString() : null;

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
