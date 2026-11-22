// Update Manager modal (renderer). Extracted verbatim from modals.ts.
//
// Owns the remote client-update flow: release/version eligibility, selection,
// download + deploy orchestration, and the live progress/status rendering. The
// single former call to modals' CloseAllModals is inlined here as
// closeAllModals()+Wait so this module has no back-reference into modals.
import { closeAllModals, openModal } from './lib/modal';
import { ErrorMessage, Safe } from './utils';
import { CriticalConfirmationDialog, Notify, Wait } from './selection-init';
import {
  GetReleaseOptionLabel,
  IsPrereleaseTag,
  IsReleaseOptionSelectable,
  PickDefaultReleaseTag,
} from './lib/update-release-options';
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
} from './state';
import type { ClientView, ScriptExecutionView } from '@showtrak/protocol';
import { ArrayOrEmpty } from './lib/guards';

// The script name the server gives a client-update execution. Its progress is
// shown per client in the Update Manager, never in the script executions panel.
export const UPDATE_EXECUTION_SCRIPT_NAME = 'Updating Client Software';

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
    // A pre-release suffix ("-beta.1") is allowed; only the core is compared.
    .match(/^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9a-z.-]+)?$/i);
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
  // Exactly the minimum: a pre-release of it (3.4.0-rc1) came before it.
  return !/-/.test(String(value || '').trim());
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

  // Flag a pre-release selection, so nobody deploys one without noticing.
  const options = Array.isArray(UpdateManagerReleaseOptions) ? UpdateManagerReleaseOptions : [];
  $('#UPDATE_MANAGER_PRERELEASE_FLAG').toggleClass(
    'd-none',
    !(selectedTag && IsPrereleaseTag(options, selectedTag))
  );
}

// The update channel the release picker was last drawn for.
let PickerChannel: string | null = null;

export function RenderUpdateManagerReleaseOptions() {
  const $select = $('#UPDATE_MANAGER_RELEASE_SELECT');
  if (!$select.length) return;

  const options = Array.isArray(UpdateManagerReleaseOptions) ? UpdateManagerReleaseOptions : [];
  const downloadedTag =
    UpdateManagerReleaseStatus && UpdateManagerReleaseStatus.ReleaseVersion
      ? String(UpdateManagerReleaseStatus.ReleaseVersion)
      : '';

  // Pre-releases are listed either way, but on the Stable channel they are
  // disabled: the server would refuse them (see UpdateManager:DeployRelease).
  let html = '';
  for (const item of options) {
    const tag = String(item && item.tag ? item.tag : '').trim();
    if (!tag) continue;
    const disabled = IsReleaseOptionSelectable(item) ? '' : ' disabled';
    html += `<option value="${Safe(tag)}"${disabled}>${Safe(GetReleaseOptionLabel(item, downloadedTag))}</option>`;
  }

  $select.html(html);

  // After a channel switch the earlier selection (and download) no longer
  // reflect the operator's intent: default to the new channel's newest release.
  const channel =
    UpdateManagerReleaseStatus && UpdateManagerReleaseStatus.Channel
      ? UpdateManagerReleaseStatus.Channel
      : 'stable';
  const channelChanged = PickerChannel !== null && PickerChannel !== channel;
  PickerChannel = channel;
  const targetTag = PickDefaultReleaseTag(
    options,
    channelChanged ? '' : UpdateManagerSelectedReleaseTag || '',
    channelChanged ? '' : downloadedTag
  );
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

// Stands in for a row checkbox's `checked` attribute in a row's template, so a
// row whose only change is its tick is not redrawn (see PlanUpdateManagerListPatch).
const ROW_CHECKED_TOKEN = '\u0000CHECKED\u0000';

/** One client row: the template it is drawn from and whether it is ticked. */
export interface UpdateManagerRowModel {
  UUID: string;
  /** The row's markup with ROW_CHECKED_TOKEN where `checked` goes. */
  Template: string;
  Checked: boolean;
}

/** Everything the client list shows, as markup, in display order. */
export interface UpdateManagerListModel {
  /** Markup shown in place of the rows when there are none. */
  EmptyHtml: string | null;
  /** The "Manual Update Required" box above the rows ('' when not needed). */
  WarningHtml: string;
  Rows: UpdateManagerRowModel[];
}

let NameCollator: Intl.Collator | null = null;

/** Markup of one row, ticked or not. */
export function UpdateManagerRowHtml(Row: UpdateManagerRowModel): string {
  return Row.Template.replace(ROW_CHECKED_TOKEN, Row.Checked ? 'checked' : '');
}

/**
 * The client list as markup: rows sorted by name, each row's template and
 * tick, and the manual-update warning. Pure apart from reading its arguments.
 */
export function BuildUpdateManagerListModel(
  ClientsIn: readonly ClientView[] | null | undefined,
  SelectedTag: string,
  SelectedClients: ReadonlySet<unknown>,
  FindExecution: (UUID: string) => ScriptExecutionView | null = FindClientExecutionForUpdate
): UpdateManagerListModel {
  const Clients = ArrayOrEmpty(ClientsIn).filter(Boolean);
  if (!Clients.length) {
    return {
      EmptyHtml: '<div class="text-muted small">No clients found.</div>',
      WarningHtml: '',
      Rows: [],
    };
  }

  // The sort key is worked out once per client rather than twice per
  // comparison; a collator compares exactly as localeCompare() does.
  if (!NameCollator) NameCollator = new Intl.Collator();
  const Collator = NameCollator;
  const Sorted = Clients.map((Client) => ({
    Client,
    Key: String(Client.Nickname || Client.Hostname || Client.UUID || '').toLowerCase(),
  })).sort((A, B) => Collator.compare(A.Key, B.Key));

  const manualUpdateClients: ReturnType<typeof Safe>[] = [];
  const Rows: UpdateManagerRowModel[] = [];

  for (const { Client } of Sorted) {
    const UUID = Client.UUID;
    const Name = Safe(Client.Nickname || Client.Hostname || UUID);
    const Version = Safe(FormatClientVersionLabel(Client));
    const Online = !!Client.Online;
    const Execution = FindExecution(UUID);
    const Percent = GetUpdateProgressPercent(Execution);
    const Status = Online ? 'Online' : 'Offline';
    const eligibility = IsClientEligibleForSelectedRelease(Client, SelectedTag);
    const versionHint = GetUpdateVersionHint(Client, SelectedTag, eligibility);
    const IsSelectable = !!eligibility.eligible;
    const IsChecked = IsSelectable && SelectedClients.has(UUID);

    if (!IsSelectable && String(eligibility.reason || '').includes('Manual update required')) {
      manualUpdateClients.push(Name);
    }

    // An eligible online client with nothing running has nothing to report, so
    // it gets no status line at all rather than a "Ready to update" filler. A
    // client already on the selected release gets none either: its "Current"
    // pill says so.
    // An offline client says so once, in the status on the right: the hint pill
    // and status line would only repeat it.
    const AlreadyCurrent = eligibility.reason === 'Already on selected version';
    const StatusText = Safe(
      !Online
        ? ''
        : IsSelectable
          ? Online
            ? Execution
              ? GetUpdateStatusText(Execution)
              : ''
            : eligibility.reason
          : AlreadyCurrent
            ? ''
            : eligibility.reason
    );

    Rows.push({
      UUID: String(UUID),
      Checked: IsChecked,
      Template: `<div class="UPDATE_MANAGER_CLIENT_ITEM ${Online ? 'ONLINE' : 'OFFLINE'}" data-uuid="${Safe(UUID)}">
        <div class="UPDATE_MANAGER_CLIENT_HEADER">
          <div class="UPDATE_MANAGER_CLIENT_SELECT_WRAP">
            <input
              class="form-check-input UPDATE_MANAGER_CLIENT_SELECT"
              type="checkbox"
              data-uuid="${Safe(UUID)}"
              ${ROW_CHECKED_TOKEN}
              ${IsSelectable ? '' : 'disabled'}
            />
          </div>
          <div class="UPDATE_MANAGER_CLIENT_MAIN">
            <div class="UPDATE_MANAGER_CLIENT_NAME">${Name}</div>
            ${
              Online
                ? `<div class="UPDATE_MANAGER_CLIENT_META">
              <span class="UPDATE_MANAGER_CLIENT_HINT ${Safe(versionHint.className)}" title="${Safe(versionHint.title)}">${Safe(versionHint.text)}</span>
            </div>`
                : ''
            }
          </div>
          <div class="UPDATE_MANAGER_CLIENT_RIGHT">
            <div class="UPDATE_MANAGER_CLIENT_STATUS_ROW">
              <span class="UPDATE_MANAGER_CLIENT_VERSION">${Version}</span>
              <div class="UPDATE_MANAGER_CLIENT_STATUS ${GetUpdateStatusClass(Status)}">${Safe(Status)}</div>
            </div>
            <div class="progress UPDATE_MANAGER_CLIENT_PROGRESS">
              <div class="progress-bar ${Execution && Execution.Status === 'Failed' ? 'bg-danger' : 'bg-success'}" role="progressbar" style="width: ${Percent}%" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Percent}"></div>
            </div>
          </div>
        </div>
        ${StatusText ? `<div class="UPDATE_MANAGER_CLIENT_STATUS_TEXT">${StatusText}</div>` : ''}
      </div>`,
    });
  }

  let WarningHtml = '';
  if (manualUpdateClients.length > 0) {
    const warningList = manualUpdateClients
      .map((displayName) => `<li>${displayName}</li>`)
      .join('');
    WarningHtml = `<div class="UPDATE_MANAGER_WARNING">
        <div class="UPDATE_MANAGER_WARNING_TITLE">Manual Update Required</div>
        <div class="UPDATE_MANAGER_WARNING_TEXT">
          The following clients are running below v3.4.0 and do not support remote updates.
        </div>
        <ul class="UPDATE_MANAGER_WARNING_LIST">${warningList}</ul>
      </div>`;
  }

  return { EmptyHtml: null, WarningHtml, Rows };
}

/** What the list on screen was drawn from, so the next draw can patch it. */
export interface UpdateManagerRenderedList {
  /** The warning plus the row order: any change to it redraws the whole list. */
  LayoutKey: string;
  /** Each row's template, by UUID. */
  Templates: Map<string, string>;
}

/** The layout key of a model (see UpdateManagerRenderedList.LayoutKey). */
export function UpdateManagerLayoutKey(Model: UpdateManagerListModel): string {
  if (Model.EmptyHtml != null) return `empty\u0000${Model.EmptyHtml}`;
  return `${Model.WarningHtml}\u0000${Model.Rows.map((Row) => Row.UUID).join('\u0000')}`;
}

/** Record a drawn model, for the next PlanUpdateManagerListPatch. */
export function UpdateManagerRenderedFrom(
  Model: UpdateManagerListModel
): UpdateManagerRenderedList {
  return {
    LayoutKey: UpdateManagerLayoutKey(Model),
    Templates: new Map(Model.Rows.map((Row) => [Row.UUID, Row.Template])),
  };
}

/**
 * How to bring the drawn list up to the model: redraw it all (the first draw,
 * a client added, removed or moved by a rename, the warning changing), or
 * replace just the rows whose markup changed. A heartbeat that changes nothing
 * the list shows (vitals, uptime) changes nothing on screen.
 */
export function PlanUpdateManagerListPatch(
  Previous: UpdateManagerRenderedList | null,
  Model: UpdateManagerListModel
): { Full: true } | { Full: false; Changed: number[] } {
  if (!Previous || Previous.LayoutKey !== UpdateManagerLayoutKey(Model)) return { Full: true };
  const Changed: number[] = [];
  Model.Rows.forEach((Row, Index) => {
    if (Previous.Templates.get(Row.UUID) !== Row.Template) Changed.push(Index);
  });
  return { Full: false, Changed };
}

// The list as last drawn into #UPDATE_MANAGER_CLIENT_LIST, and when.
let RenderedList: UpdateManagerRenderedList | null = null;
let LastListRenderAt = 0;
let ListRenderTimer: ReturnType<typeof setTimeout> | null = null;

// Live updates (every client heartbeat, every execution push) redraw the open
// list at most this often. Each used to sort and rebuild every row, so with N
// clients heartbeating each second the list was rebuilt N times a second, and
// a click landing between mousedown and mouseup on a just-replaced checkbox
// was lost.
export const UPDATE_MANAGER_LIVE_RENDER_INTERVAL_MS = 1000;

/**
 * Redraw the client list for a live change. Coalesced: the first call after a
 * quiet spell draws on the next tick, later ones at most once per
 * UPDATE_MANAGER_LIVE_RENDER_INTERVAL_MS, and only rows whose markup changed
 * are touched. A redraw that must land at once (opening the modal, picking a
 * release) uses RenderUpdateManagerClientListNow.
 */
export function RenderUpdateManagerClientList() {
  if (ListRenderTimer) return;
  const Delay = Math.max(0, LastListRenderAt + UPDATE_MANAGER_LIVE_RENDER_INTERVAL_MS - Date.now());
  ListRenderTimer = setTimeout(() => {
    ListRenderTimer = null;
    // Closed in the meantime: the next opening draws it fresh.
    if (!$('#SHOWTRAK_MODAL_UPDATE_MANAGER').hasClass('show')) return;
    RenderUpdateManagerClientListNow();
  }, Delay);
}

/** Draw the client list now, replacing only the rows that changed. */
export function RenderUpdateManagerClientListNow() {
  const $list = $('#UPDATE_MANAGER_CLIENT_LIST');
  if (!$list.length) return;
  const List = $list[0] as HTMLElement;
  LastListRenderAt = Date.now();

  if (!(UpdateManagerSelectedClients instanceof Set)) {
    setUpdateManagerSelectedClients(new Set(UpdateManagerSelectedClients || []));
  }
  const Model = BuildUpdateManagerListModel(
    __LastClients,
    GetSelectedUpdateManagerReleaseTag(),
    UpdateManagerSelectedClients
  );

  const Plan = PlanUpdateManagerListPatch(RenderedList, Model);
  const RowOffset = Model.WarningHtml ? 1 : 0;
  // A patch addresses rows by position, so the list on screen must still be
  // the one recorded; anything else is redrawn rather than patched blind.
  const DrawnIntact =
    !Plan.Full &&
    List.childElementCount === Model.Rows.length + RowOffset &&
    Model.Rows.every(
      (Row, Index) => List.children[Index + RowOffset]?.getAttribute('data-uuid') === Row.UUID
    );

  if (Plan.Full || !DrawnIntact) {
    List.innerHTML =
      Model.EmptyHtml != null
        ? Model.EmptyHtml
        : Model.WarningHtml + Model.Rows.map(UpdateManagerRowHtml).join('');
  } else {
    for (const Index of Plan.Changed) {
      const El = List.children[Index + RowOffset];
      if (El) El.outerHTML = UpdateManagerRowHtml(Model.Rows[Index]!);
    }
    // Ticks are synced in place rather than by redrawing the row, which would
    // take focus off a checkbox just clicked.
    Model.Rows.forEach((Row, Index) => {
      const Box = List.children[Index + RowOffset]?.querySelector<HTMLInputElement>(
        '.UPDATE_MANAGER_CLIENT_SELECT'
      );
      if (Box && Box.checked !== Row.Checked) Box.checked = Row.Checked;
    });
  }

  RenderedList = UpdateManagerRenderedFrom(Model);
}

export function UpdateManagerHandleExecutions(Executions: ScriptExecutionView[] = []) {
  if (!(UpdateManagerClientProgress instanceof Map)) {
    setUpdateManagerClientProgress(new Map());
  }

  UpdateManagerClientProgress.clear();

  for (const Execution of Executions) {
    if (!Execution || !Execution.Client || !Execution.Script) continue;
    if (String(Execution.Script.Name || '') !== UPDATE_EXECUTION_SCRIPT_NAME) continue;
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
    await Notify('Select a release first.', 'error');
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
    await Notify(`Downloaded build ${Result.ReleaseVersion}.`, 'success');
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
    await Notify('Select a release to deploy.', 'error');
    return;
  }

  const SelectedTargets = GetSelectedUpdateManagerDeployTargets();
  if (SelectedTargets.length === 0) {
    await Notify('Select at least one eligible online client.', 'error');
    return;
  }

  // A pre-release build needs an explicit confirmation (the server also
  // refuses one without it, and refuses it outright on the Stable channel).
  const options = Array.isArray(UpdateManagerReleaseOptions) ? UpdateManagerReleaseOptions : [];
  const IsPrerelease =
    IsPrereleaseTag(options, selectedTag) ||
    !!(
      UpdateManagerReleaseStatus &&
      UpdateManagerReleaseStatus.Prerelease &&
      String(UpdateManagerReleaseStatus.ReleaseVersion) === selectedTag
    );
  if (IsPrerelease) {
    const Plural = SelectedTargets.length === 1 ? '' : 's';
    const Confirmed = await CriticalConfirmationDialog({
      title: 'Deploy a pre-release?',
      message: `${selectedTag} is a pre-release build of ShowTrak Client. It has not had the testing a full release gets. Deploy it to ${SelectedTargets.length} client${Plural}?`,
      items: SelectedTargets.map((UUID) => {
        const Client = (Array.isArray(__LastClients) ? __LastClients : []).find(
          (Entry: ClientView) => Entry.UUID === UUID
        );
        return (Client && (Client.Nickname || Client.Hostname)) || UUID;
      }),
      confirmLabel: 'Deploy Pre-release',
    });
    if (!Confirmed) return;
  }

  setUpdateManagerRunning(true);
  ApplyUpdateManagerButtonLocks();
  $('#UPDATE_MANAGER_STATUS').text(`Deploying ${selectedTag} to online clients...`);

  try {
    const [Err, Result] = await window.API.DeployUpdateManagerRelease(
      selectedTag,
      SelectedTargets,
      IsPrerelease
    );
    if (Err || !Result) {
      await Notify(String(Err), 'error');
      $('#UPDATE_MANAGER_STATUS').text(String(Err));
      return;
    }

    await Notify(`Update sent to ${Result.TargetCount} online clients.`, 'success');
    $('#UPDATE_MANAGER_STATUS').text(
      `Updating ${Result.TargetCount} online clients to ${Result.ReleaseVersion}.`
    );
    RenderUpdateManagerClientListNow();
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
  // Drawn from scratch: a patch against the list from an earlier opening could
  // miss whatever changed while it was closed.
  RenderedList = null;
  RenderUpdateManagerClientListNow();

  $('#UPDATE_MANAGER_REFRESH')
    .off('click')
    .on('click', async () => {
      await RefreshUpdateManagerStatus();
      RenderUpdateManagerClientListNow();
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
      RenderUpdateManagerClientListNow();
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
