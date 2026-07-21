// Update Manager modal (renderer). Extracted verbatim from 11-modals.ts.
//
// Owns the remote client-update flow: release/version eligibility, selection,
// download + deploy orchestration, and the live progress/status rendering. The
// single former call to 11-modals' CloseAllModals is inlined here as
// closeAllModals()+Wait so this module has no back-reference into 11-modals.
import { closeAllModals, openModal } from './lib/modal';
import { ErrorMessage, Safe } from './04-utils';
import { Notify, ShowExecutionToast, Wait } from './14-selection-init';
import {
  FormatClientVersionLabel,
  UpdateManagerClientProgress,
  UpdateManagerDownloadInProgress,
  UpdateManagerReleaseOptions,
  UpdateManagerReleaseStatus,
  UpdateManagerRunning,
  UpdateManagerSelectedClients,
  UpdateManagerSelectedReleaseTag,
  __LastClients,
  setUpdateManagerClientProgress,
  setUpdateManagerDownloadInProgress,
  setUpdateManagerReleaseOptions,
  setUpdateManagerReleaseStatus,
  setUpdateManagerRunning,
  setUpdateManagerSelectedClients,
  setUpdateManagerSelectedReleaseTag,
} from './01-state';
import type { ClientView, ScriptExecutionView } from '@showtrak/protocol';

export function FindClientExecutionForUpdate(UUID: string): ScriptExecutionView | null {
  if (!UpdateManagerClientProgress || !(UpdateManagerClientProgress instanceof Map)) return null;
  return UpdateManagerClientProgress.get(UUID) || null;
}

export function GetUpdateStatusClass(status: string) {
  const value = String(status || '').toLowerCase();
  if (value === 'online') return 'text-success';
  if (value === 'offline') return 'text-danger';
  return 'text-muted';
}

export function GetUpdateProgressPercent(Execution: ScriptExecutionView | null) {
  if (!Execution) return 0;
  if (Execution.Status === 'Completed') return 100;
  const raw = Number(Execution.Progress);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

export function GetUpdateStatusText(Execution: ScriptExecutionView | null) {
  if (!Execution) return 'Ready to update';
  if (Execution.Status === 'Failed') return Execution.Error || Execution.StatusText || 'Failed';
  if (Execution.Status === 'Completed') return 'Updated';
  return Execution.StatusText || 'Pending';
}

export function NormalizeVersionToken(value: unknown) {
  return String(value || '')
    .trim()
    .replace(/^v/i, '')
    .toLowerCase();
}

export function ParseSemverTuple(value: unknown) {
  const match = String(value || '')
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)$/i);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function IsVersionAtLeast(value: unknown, minimumTuple: number[]) {
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

export const MINIMUM_REMOTE_UPDATE_VERSION = [3, 4, 0];

export function IsClientEligibleForSelectedRelease(Client: ClientView, SelectedTag: string) {
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

export function ResetUpdateManagerClientSelectionDefaults() {
  const selectedTag = GetSelectedUpdateManagerReleaseTag();
  const Clients = Array.isArray(__LastClients) ? __LastClients : [];
  const next = new Set();

  for (const Client of Clients) {
    const eligibility = IsClientEligibleForSelectedRelease(Client, selectedTag);
    if (eligibility.eligible) {
      next.add(Client.UUID);
    }
  }

  setUpdateManagerSelectedClients(next);
}

export function GetSelectedUpdateManagerDeployTargets() {
  const selectedTag = GetSelectedUpdateManagerReleaseTag();
  const selectedSet =
    UpdateManagerSelectedClients instanceof Set
      ? UpdateManagerSelectedClients
      : new Set(UpdateManagerSelectedClients || []);

  const Clients = Array.isArray(__LastClients) ? __LastClients : [];
  const targets: string[] = [];

  for (const Client of Clients) {
    if (!Client || !Client.UUID) continue;
    if (!selectedSet.has(Client.UUID)) continue;
    const eligibility = IsClientEligibleForSelectedRelease(Client, selectedTag);
    if (!eligibility.eligible) continue;
    targets.push(Client.UUID);
  }

  return targets;
}

export function SetUpdateManagerDownloadProgress(Percent = 0, Message = '') {
  const safePercent = Math.max(0, Math.min(100, Math.round(Number(Percent) || 0)));
  $('#UPDATE_MANAGER_DOWNLOAD_PROGRESS_WRAPPER').removeClass('d-none');
  $('#UPDATE_MANAGER_DOWNLOAD_PROGRESS_BAR')
    .css('width', `${safePercent}%`)
    .attr('aria-valuenow', safePercent);
  $('#UPDATE_MANAGER_DOWNLOAD_PROGRESS_TEXT').text(Message || `Downloading... ${safePercent}%`);
}

export function GetSelectedUpdateManagerReleaseTag() {
  return String($('#UPDATE_MANAGER_RELEASE_SELECT').val() || '').trim();
}

export function RenderUpdateManagerReleaseBadge() {
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

export function RenderUpdateManagerReleaseOptions() {
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
    setUpdateManagerSelectedReleaseTag(String($select.val() || targetTag));
  }

  RenderUpdateManagerReleaseBadge();
}

export async function RefreshUpdateManagerReleaseOptions() {
  const [Err, List] = await window.API.GetUpdateManagerReleases();
  if (Err) {
    $('#UPDATE_MANAGER_STATUS').text(String(Err));
    return;
  }

  setUpdateManagerReleaseOptions(Array.isArray(List) ? List : []);
  RenderUpdateManagerReleaseOptions();
}

export function ApplyUpdateManagerButtonLocks() {
  const selectedTag = GetSelectedUpdateManagerReleaseTag();
  setUpdateManagerSelectedReleaseTag(selectedTag);
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

export function GetUpdateVersionHint(
  Client: ClientView,
  SelectedTag: string,
  Eligibility: { eligible: boolean; reason: string }
) {
  if (!SelectedTag) {
    return {
      text: 'Select release',
      className: 'MUTED',
      title: 'Pick a release to evaluate update compatibility',
    };
  }

  if (!Client || !Client.Online) {
    return {
      text: 'Offline',
      className: 'MUTED',
      title: 'Client must be online to receive updates',
    };
  }

  const reason = String((Eligibility && Eligibility.reason) || '').trim();
  if (reason.includes('Manual update required')) {
    return {
      text: 'Manual only',
      className: 'WARNING',
      title: 'Client is below v3.4.0 and needs a manual update first',
    };
  }

  if (reason === 'Already on selected version') {
    return {
      text: 'Current',
      className: 'SUCCESS',
      title: 'Client already matches the selected release',
    };
  }

  if (Eligibility && Eligibility.eligible) {
    return { text: 'Ready', className: 'INFO', title: 'Client can receive the selected release' };
  }

  return { text: reason || 'Unavailable', className: 'MUTED', title: reason || 'Not eligible' };
}

export function RenderUpdateManagerClientList() {
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
  const manualUpdateClients: ReturnType<typeof Safe>[] = [];
  if (!(UpdateManagerSelectedClients instanceof Set)) {
    setUpdateManagerSelectedClients(new Set(UpdateManagerSelectedClients || []));
  }

  for (const Client of Clients) {
    const UUID = Client.UUID;
    const Name = Safe(Client.Nickname || Client.Hostname || UUID);
    const Version = Safe(FormatClientVersionLabel(Client));
    const Online = !!Client.Online;
    const Execution = FindClientExecutionForUpdate(UUID);
    const Percent = GetUpdateProgressPercent(Execution);
    const Status = Online ? 'Online' : 'Offline';
    const eligibility = IsClientEligibleForSelectedRelease(Client, selectedTag);
    const versionHint = GetUpdateVersionHint(Client, selectedTag, eligibility);
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
            <div class="UPDATE_MANAGER_CLIENT_META">
              <span class="UPDATE_MANAGER_CLIENT_VERSION">${Version}</span>
              <span class="UPDATE_MANAGER_CLIENT_HINT ${Safe(versionHint.className)}" title="${Safe(versionHint.title)}">${Safe(versionHint.text)}</span>
            </div>
          </div>
          <div class="UPDATE_MANAGER_CLIENT_RIGHT">
            <div class="UPDATE_MANAGER_CLIENT_STATUS ${GetUpdateStatusClass(Status)}">${Safe(Status)}</div>
            <div class="progress UPDATE_MANAGER_CLIENT_PROGRESS">
              <div class="progress-bar ${Execution && Execution.Status === 'Failed' ? 'bg-danger' : 'bg-success'}" role="progressbar" style="width: ${Percent}%" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Percent}"></div>
            </div>
          </div>
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

export function UpdateManagerHandleExecutions(Executions: ScriptExecutionView[] = []) {
  if (!(UpdateManagerClientProgress instanceof Map)) {
    setUpdateManagerClientProgress(new Map());
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

export async function RefreshUpdateManagerStatus() {
  const [Err, Status] = await window.API.GetUpdateManagerStatus();
  if (Err) {
    $('#UPDATE_MANAGER_RELEASE').text('Release: unavailable');
    $('#UPDATE_MANAGER_STATUS').text(String(Err));
    ApplyUpdateManagerButtonLocks();
    return;
  }

  setUpdateManagerReleaseStatus(Status || null);
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

export async function RunUpdateManagerDownloadLatest() {
  if (UpdateManagerDownloadInProgress || UpdateManagerRunning) return;

  const selectedTag = GetSelectedUpdateManagerReleaseTag();
  if (!selectedTag) {
    await Notify('Select a release first', 'error');
    return;
  }

  setUpdateManagerDownloadInProgress(true);
  ApplyUpdateManagerButtonLocks();
  SetUpdateManagerDownloadProgress(0, `Preparing download for ${selectedTag}...`);
  $('#UPDATE_MANAGER_STATUS').text(`Downloading ${selectedTag} to ShowTrakServer...`);

  try {
    const [Err, Result] = await window.API.DownloadUpdateManagerRelease(selectedTag);
    if (Err || !Result) {
      await Notify(String(Err), 'error');
      $('#UPDATE_MANAGER_STATUS').text(String(Err));
      return;
    }

    SetUpdateManagerDownloadProgress(100, `Downloaded ${Result.ReleaseVersion}`);
    await Notify(`Downloaded build ${Result.ReleaseVersion}`, 'success');
    await RefreshUpdateManagerStatus();
    await RefreshUpdateManagerReleaseOptions();
  } catch (Err) {
    const Message = ErrorMessage(Err);
    $('#UPDATE_MANAGER_STATUS').text(Message);
    await Notify(Message, 'error');
  } finally {
    setUpdateManagerDownloadInProgress(false);
    ApplyUpdateManagerButtonLocks();
  }
}

export async function RunUpdateManagerDeployAll() {
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

  setUpdateManagerRunning(true);
  ApplyUpdateManagerButtonLocks();
  $('#UPDATE_MANAGER_STATUS').text(`Deploying ${selectedTag} to online clients...`);

  try {
    const [Err, Result] = await window.API.DeployUpdateManagerRelease(selectedTag, SelectedTargets);
    if (Err || !Result) {
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
    const Message = ErrorMessage(Err);
    $('#UPDATE_MANAGER_STATUS').text(Message);
    await Notify(Message, 'error');
  } finally {
    setUpdateManagerRunning(false);
    ApplyUpdateManagerButtonLocks();
  }
}

export async function OpenUpdateManagerModal() {
  closeAllModals();
  await Wait(300);
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
      setUpdateManagerSelectedReleaseTag(String($(this).val() || '').trim());
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
        setUpdateManagerSelectedClients(new Set(UpdateManagerSelectedClients || []));
      }
      if ($(this).is(':checked')) {
        UpdateManagerSelectedClients.add(uuid);
      } else {
        UpdateManagerSelectedClients.delete(uuid);
      }
      ApplyUpdateManagerButtonLocks();
    });

  ApplyUpdateManagerButtonLocks();

  openModal('SHOWTRAK_MODAL_UPDATE_MANAGER');
}
