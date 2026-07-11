import { AppMode, ClientInfoOpenUUID, Config, DummyClients, FormatClientHostnameVersionLabel, GroupUUIDCache, MonitoringTargets, PendingAdoption, Selected, Settings, __LastClients, __LastGroups, setAllClients, setPendingAdoption, setScriptList, set__LastClients, set__LastGroups } from './01-state';
import { OfflineBadgeContent } from './lib/status-badges';
import type {
  ClientView,
  DummyClientView,
  MonitoringTargetView,
  ScriptExecutionView,
} from '@showtrak/protocol';
import { HandleNonFatalError, Safe } from './04-utils';
import { RenderMonitoringTargetTile } from './07-monitoring';
import { initializeEditInteractions } from './08-dnd';
import { AddAlert, DismissAlert, PendingAdoptionAlerts } from './10-alerts-tray';
import { CloseAllModals, UpdateManagerHandleExecutions } from './11-modals';
import { ConfirmationDialog, HideExecutionToast, RenderClientInfoDetails, ShowExecutionToast, UpdateIdentifyStatusBanner } from './14-selection-init';
import { RenderDummyClientTile } from './16-dummy-clients';

// Deployment-toast working state. This mirrors the runtime shape used below and
// cached on `window.__ShowTrakDeploymentUiState`; note the ambient window decl
// (types/global.d.ts) models `failed` as a count, whereas the live code keeps
// the full failed-request array here, so the window value is bridged once below.
interface DeploymentSummary {
  total: number;
  successful: number;
  failed: ScriptExecutionView[];
  finished: boolean;
  pending: number;
  percent: number;
}

interface DeploymentUiState {
  summary: DeploymentSummary | null;
  requests: ScriptExecutionView[];
  holdUntil: number;
  hadRenderableDeployment: boolean;
}

// A single tile in a group's merged (clients + monitors + dummies) render order.
type MergedTileEntry =
  | { kind: 'client'; weight: number; data: ClientView }
  | { kind: 'monitor'; weight: number; data: MonitoringTargetView }
  | { kind: 'dummy'; weight: number; data: DummyClientView };

// Called by the bootstrap orchestrator in main.ts — never at import time.
export function InitClientList() {
  window.API.ShutdownRequested(async () => {
    await CloseAllModals();
    const Confirmation = await ConfirmationDialog('Are you sure you want to shutdown ShowTrak?');
    if (!Confirmation) return;
    await window.API.Shutdown(true);
  });

  InitClientListPush();
  InitPendingAdoptionPush();

  window.API.USBDeviceAdded(async (Client, _Device) => {
  // If Client Info modal is open for this client, refresh its details
  try {
    const $modal = $('#SHOWTRAK_CLIENT_INFO');
    if (ClientInfoOpenUUID && ClientInfoOpenUUID === Client.UUID && $modal.hasClass('show')) {
      const fresh = await window.API.GetClient(Client.UUID);
      if (fresh) RenderClientInfoDetails(fresh);
    }
  } catch (e) {
    HandleNonFatalError('USBDeviceAdded:RefreshClientInfo', e);
  }
  });
  window.API.USBDeviceRemoved(async (Client, _Device) => {
  // If Client Info modal is open for this client, refresh its details
  try {
    const $modal = $('#SHOWTRAK_CLIENT_INFO');
    if (ClientInfoOpenUUID && ClientInfoOpenUUID === Client.UUID && $modal.hasClass('show')) {
      const fresh = await window.API.GetClient(Client.UUID);
      if (fresh) RenderClientInfoDetails(fresh);
    }
  } catch (e) {
    HandleNonFatalError('USBDeviceRemoved:RefreshClientInfo', e);
  }
  });
}

export function GetClientStatusDisplayText(Client: Partial<ClientView> | null | undefined) {
  if (Client && Client.Identifying) return 'Identifying';
  if (Client && Client.Online) return Client.Degraded ? 'Degraded' : 'Online';
  return 'Offline';
}

export function GetClientCompactStatusLabel(Client: Partial<ClientView> | null | undefined) {
  if (Client && Client.Identifying) return 'Identifying';
  if (Client && Client.Online) return Client.Degraded ? 'Degraded' : 'Online';
  return 'Offline';
}

// Registers the script-execution / script-list / full-client-list push
// handlers. Bodies unchanged from the former import-time subscriptions.
function InitClientListPush() {
  window.API.UpdateScriptExecutions(async (Executions) => {
  try {
    UpdateManagerHandleExecutions(Executions || []);
  } catch (e) {
    HandleNonFatalError('UpdateManagerHandleExecutions', e);
  }

  // Close any open popovers before re-render to prevent duplicates
  try {
    $('.exec-info.open').removeClass('open');
  } catch (e) {
    HandleNonFatalError('UpdateScriptExecutions:ClosePopovers', e);
  }
  Executions = Executions.reverse();

  // Determine if all executions are for the same action/script
  const names = Array.from(
    new Set(
      Executions.map((r) =>
        r && r.Script && r.Script.Name ? String(r.Script.Name).trim() : null
      ).filter(Boolean)
    )
  );
  const uniformScriptName = names.length === 1 ? names[0] : null;
  const nonDeploymentExecutions = Executions.filter((Request) => {
    const Name =
      Request && Request.Script && Request.Script.Name ? String(Request.Script.Name).trim() : '';
    return Name !== 'Deploying Scripts';
  });

  if (!window.__ShowTrakExecutionAutoDismissTimer) {
    window.__ShowTrakExecutionAutoDismissTimer = null;
  }

  // Suppress deployment-only execution toasts. Deployments still run server-side,
  // but they should not hijack the execution UI on app load or integrated actions.
  if (nonDeploymentExecutions.length === 0) {
    if (window.__ShowTrakExecutionAutoDismissTimer) {
      clearTimeout(window.__ShowTrakExecutionAutoDismissTimer);
      window.__ShowTrakExecutionAutoDismissTimer = null;
    }
    HideExecutionToast();
    return;
  }

  const shouldAutoDismissNonDeployment =
    nonDeploymentExecutions.length > 0 &&
    nonDeploymentExecutions.every(
      (Request) => Request && Request.Status === 'Completed' && !Request.Error
    );

  if (shouldAutoDismissNonDeployment) {
    if (!window.__ShowTrakExecutionAutoDismissTimer) {
      window.__ShowTrakExecutionAutoDismissTimer = setTimeout(() => {
        window.__ShowTrakExecutionAutoDismissTimer = null;
        HideExecutionToast();
      }, 1000);
    }
  } else if (window.__ShowTrakExecutionAutoDismissTimer) {
    clearTimeout(window.__ShowTrakExecutionAutoDismissTimer);
    window.__ShowTrakExecutionAutoDismissTimer = null;
  }

  let deploymentRequests = Executions.filter(
    (Request) =>
      Request &&
      Request.Script &&
      typeof Request.Script.Name === 'string' &&
      Request.Script.Name.trim() === 'Deploying Scripts'
  );
  const hasFreshDeploymentData = deploymentRequests.length > 0;

  let deploymentSummary: DeploymentSummary = {
    total: deploymentRequests.length,
    successful: deploymentRequests.filter((Request) => Request.Status === 'Completed').length,
    failed: deploymentRequests.filter((Request) => Request.Status === 'Failed'),
    finished: false,
    pending: 0,
    percent: 0,
  };
  deploymentSummary.finished =
    deploymentSummary.total > 0 &&
    deploymentSummary.successful + deploymentSummary.failed.length === deploymentSummary.total;
  deploymentSummary.pending =
    deploymentSummary.total - deploymentSummary.successful - deploymentSummary.failed.length;
  deploymentSummary.percent =
    deploymentSummary.total > 0
      ? Math.round(
          ((deploymentSummary.successful + deploymentSummary.failed.length) /
            deploymentSummary.total) *
            100
        )
      : 0;

  if (!window.__ShowTrakDeploymentUiState) {
    window.__ShowTrakDeploymentUiState = {
      summary: null,
      requests: [],
      holdUntil: 0,
      hadRenderableDeployment: false,
    };
  }
  // Bridge the ambient window type (which models `summary.failed` as a count and
  // `requests` as unknown[]) to the richer runtime shape actually stored here.
  const deploymentUiState = window.__ShowTrakDeploymentUiState as unknown as DeploymentUiState;
  const now = Date.now();

  if (deploymentSummary.total > 0) {
    deploymentUiState.summary = {
      total: deploymentSummary.total,
      successful: deploymentSummary.successful,
      failed: deploymentSummary.failed,
      finished: deploymentSummary.finished,
      pending: deploymentSummary.pending,
      percent: deploymentSummary.percent,
    };
    deploymentUiState.requests = deploymentRequests;
    // Hold briefly so queue reset/reenqueue does not cause visible flicker.
    deploymentUiState.holdUntil = deploymentSummary.finished ? now + 3200 : now + 15000;
  } else if (
    !hasFreshDeploymentData &&
    deploymentUiState.summary &&
    deploymentUiState.summary.finished === false &&
    now < (deploymentUiState.holdUntil || 0)
  ) {
    deploymentSummary = deploymentUiState.summary;
    deploymentRequests = Array.isArray(deploymentUiState.requests)
      ? (deploymentUiState.requests as typeof deploymentRequests)
      : [];
  }

  const hasActiveDeployment = deploymentSummary.total > 0 && !deploymentSummary.finished;
  const hasDeploymentIssues = deploymentSummary.finished && deploymentSummary.failed.length > 0;
  const hasDeploymentSuccess =
    deploymentSummary.total > 0 &&
    deploymentSummary.finished &&
    deploymentSummary.failed.length === 0;
  const hasOnlyDeploymentExecutions = nonDeploymentExecutions.length === 0;
  const shouldDisplayDeploymentToast =
    hasActiveDeployment ||
    hasDeploymentIssues ||
    (hasDeploymentSuccess && hasOnlyDeploymentExecutions);
  const hasRenderableDeploymentToast =
    shouldDisplayDeploymentToast &&
    Array.isArray(deploymentRequests) &&
    deploymentRequests.length > 0;

  if (hasRenderableDeploymentToast) {
    deploymentUiState.hadRenderableDeployment = true;
  }

  if (!window.__ShowTrakDeploymentAutoDismissTimer) {
    window.__ShowTrakDeploymentAutoDismissTimer = null;
  }

  if (
    deploymentSummary.total > 0 &&
    deploymentSummary.finished &&
    deploymentSummary.failed.length === 0 &&
    nonDeploymentExecutions.length === 0
  ) {
    if (!window.__ShowTrakDeploymentAutoDismissTimer) {
      window.__ShowTrakDeploymentAutoDismissTimer = setTimeout(() => {
        window.__ShowTrakDeploymentAutoDismissTimer = null;
        HideExecutionToast();
      }, 3000);
    }
  } else if (window.__ShowTrakDeploymentAutoDismissTimer) {
    clearTimeout(window.__ShowTrakDeploymentAutoDismissTimer);
    window.__ShowTrakDeploymentAutoDismissTimer = null;
  }

  // Ensure toast exists and is visible with dynamic title
  if (hasRenderableDeploymentToast || nonDeploymentExecutions.length > 0) {
    const ToastTitle = hasRenderableDeploymentToast
      ? 'Deploying Scripts'
      : uniformScriptName || 'Script Executions';
    ShowExecutionToast(ToastTitle);
  }

  // Ignore transient empty updates so we don't flash an empty deployment toast.
  if (!hasRenderableDeploymentToast && nonDeploymentExecutions.length === 0) {
    // Ignore empty transient updates while deployment has recently been visible.
    if (
      !hasFreshDeploymentData &&
      deploymentUiState.hadRenderableDeployment &&
      deploymentUiState.summary &&
      now < (deploymentUiState.holdUntil || 0)
    ) {
      return;
    }
    if (!window.__ShowTrakDeploymentAutoDismissTimer) {
      deploymentUiState.hadRenderableDeployment = false;
      HideExecutionToast();
    }
    return;
  }

  const $list = $('#SHOWTRAK_EXECUTION_LIST');
  if ($list.length === 0) return;

  let Filler = '';

  if (hasRenderableDeploymentToast) {
    const ExpandFailures = deploymentSummary.finished && deploymentSummary.failed.length > 0;
    const FailedItems = deploymentSummary.failed
      .map((Request) => {
        const Name =
          Request && Request.Client
            ? Request.Client.Nickname ||
              Request.Client.Hostname ||
              Request.Client.UUID ||
              'Unknown Client'
            : 'Unknown Client';
        const Reason =
          Request && Request.Error ? String(Request.Error) : 'Unknown deployment error';
        return `<li><span class="badge bg-ghost-light text-light">${Safe(
          Name
        )}</span><span class="exec-deploy-fail-reason">${Safe(Reason)}</span></li>`;
      })
      .join('');

    Filler += `
      <div class="exec-deploy-summary ${ExpandFailures ? 'open' : ''}">
        <div class="exec-deploy-title-row">
          <strong>Deploying Scripts</strong>
          <span class="badge bg-ghost-light text-light">${deploymentSummary.successful}/${deploymentSummary.total} Updated</span>
        </div>
        <div class="progress exec-deploy-progress">
          <div
            class="progress-bar ${deploymentSummary.failed.length > 0 ? 'bg-warning' : 'bg-success'}"
            role="progressbar"
            style="width: ${deploymentSummary.percent}%"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow="${deploymentSummary.percent}"
          ></div>
        </div>
        <div class="exec-deploy-meta">
          <span>${deploymentSummary.percent}% complete</span>
          <span>${deploymentSummary.pending} pending</span>
          <span>${deploymentSummary.failed.length} failed</span>
        </div>
        ${deploymentSummary.failed.length > 0 ? `<div class="exec-deploy-failures ${ExpandFailures ? '' : 'd-none'}"><div class="exec-deploy-failures-title">Failed Clients</div><ul>${FailedItems}</ul></div>` : ''}
      </div>`;
  }

  function durationText(ms: number) {
    let cls = 'text-success';
    if (ms > 2000) cls = 'text-danger';
    else if (ms > 800) cls = 'text-warning';
    return `<small class="exec-duration ${cls}">${Safe(ms)}ms</small>`;
  }

  function truncateExecutionLabel(value: string | null | undefined, maxLen = 34) {
    const text = value == null ? '' : String(value).trim();
    if (!text) return '';
    if (text.length <= maxLen) return text;
    return `${text.substring(0, Math.max(1, maxLen - 1))}…`;
  }

  const renderExecutions = hasRenderableDeploymentToast
    ? deploymentRequests
    : nonDeploymentExecutions;

  for (let i = 0; i < renderExecutions.length; i++) {
    const Request = renderExecutions[i];
    const rawScriptName =
      Request && Request.Script && Request.Script.Name ? String(Request.Script.Name).trim() : '';
    const rawClientName = Request.Client.Nickname
      ? Request.Client.Nickname
      : Request.Client.Hostname;
    const clientName = Safe(truncateExecutionLabel(rawClientName, 40));
    const scriptName = rawScriptName ? Safe(truncateExecutionLabel(rawScriptName, 28)) : '';
    const fullClientName = Safe(rawClientName || 'Unknown Client');
    const fullScriptName = Safe(rawScriptName || '');
    const statusBadge = ''; // Remove visual badges; use icon instead
    let timeBadge = '';
    let actionsHtml = ''; // right-side icon area (only rendered if non-empty)
    let errorBlock = ''; // error details below the row

    if (Request.Timer && typeof Request.Timer.Duration === 'number') {
      timeBadge = durationText(Request.Timer.Duration);
    }

    if (Request.Status === 'Completed') {
      // Success check icon in the actions area
      actionsHtml = `<span class="exec-btn-icon exec-success" role="img" aria-label="Completed"><i class="bi bi-check-circle-fill"></i></span>`;
    } else if (Request.Status === 'Failed') {
      // Passive info icon (no click behavior)
      actionsHtml = `<span class="exec-btn-icon" role="img" aria-label="Failed"><i class="bi bi-info-circle"></i></span>`;
      if (Request.Error && rawScriptName !== 'Deploying Scripts') {
        const err = Safe(Request.Error);
        errorBlock = `<pre class="exec-error">${err}</pre>`;
      }
    }

    Filler += `
			<div class="exec-item">
				<div class="exec-row">
					<div class="exec-left">
            <span class="badge bg-ghost-light text-light exec-chip" title="${fullClientName}">${clientName}</span>
            ${uniformScriptName ? '' : `<span class="badge bg-ghost-light text-light exec-chip" title="${fullScriptName}">${scriptName}</span>`}
					</div>
					<div class="exec-right">
						${timeBadge}
						${statusBadge}
						${actionsHtml ? `<div class="exec-actions">${actionsHtml}</div>` : ''}
					</div>
				</div>
				${errorBlock}
			</div>`;
  }

  $list.html(Filler);
  return;
  });

  window.API.SetScriptList(async (Scripts) => {
    setScriptList(Scripts);
    return;
  });

  window.API.SetFullClientList(async (Clients, Groups) => {
    // cache latest full lists
    set__LastClients(Array.isArray(Clients) ? Clients : []);
    set__LastGroups(Array.isArray(Groups) ? Groups : []);
    setAllClients(Array.isArray(Clients) ? Clients.slice() : []);
    RenderFullClientAndMonitorList();
  });
}

// Read the configured number of group layout columns (clamped 2-6, default 2).
export function GetGroupColumnCount() {
  try {
    const Setting = Array.isArray(Settings)
      ? Settings.find((s) => s && s.Key === 'UI_GROUP_COLUMN_COUNT')
      : null;
    let Count = Setting ? parseInt(String(Setting.Value), 10) : 2;
    if (!Number.isFinite(Count)) Count = 2;
    return Math.min(6, Math.max(2, Count));
  } catch (_e) {
    return 2;
  }
}

export function TruncateGroupLabel(value: string, maxLen = 16) {
  const text = value == null ? '' : String(value).trim();
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return `${text.substring(0, Math.max(1, maxLen - 3))}...`;
}

// Build the HTML for a single client tile. Mirrors the monitor/dummy tile
// builders (RenderMonitoringTargetTile / RenderDummyClientTile); the live
// in-place counterpart is UpdateClientTile below.
export function RenderClientTile(Client: ClientView): string {
  const { Nickname, Hostname, IP, UUID, Online, LastSeen, Degraded } = Client;
  const HostnameVersionLabel = FormatClientHostnameVersionLabel(Client);
  const CompactStatusLabel = GetClientCompactStatusLabel(Client);
  const WarningText =
    Array.isArray(Client.DegradedWarnings) && Client.DegradedWarnings.length
      ? String(Client.DegradedWarnings[0])
      : 'Missing USB Device';
  const TileStateClass = Degraded ? 'DEGRADED' : Online ? 'ONLINE' : '';
  const IdentifyingClass = Client && Client.Identifying ? 'IDENTIFYING' : '';
  return `<div ID="CLIENT_TILE_${UUID}" class="SHOWTRAK_PC ${TileStateClass} ${IdentifyingClass} ${
    UUID && Selected.includes(UUID) ? 'SELECTED' : ''
  }" data-uuid="${UUID}" data-flip-key="client:${UUID}" draggable="${AppMode === 'EDIT' ? 'true' : 'false'}">
				<button type="button" class="CLIENT_TILE_COG" aria-label="Edit Client" title="Edit Client">
					<i class="bi bi-gear-fill"></i>
				</button>
				<label class="text-sm" data-type="Hostname">
        ${Safe(HostnameVersionLabel)}
					</label>
				<h5 class="mb-0" data-type="Nickname">
				${Nickname && Nickname.length ? Safe(Nickname) : Safe(Hostname)}
				</h5>
        <span class="CLIENT_TILE_COMPACT_STATUS" data-type="COMPACT_ONLINE_STATUS">${Safe(CompactStatusLabel)}</span>
				<small class="text-sm text-light" data-type="IP">
					${IP ? Safe(IP) : 'Unknown IP'}
				</small>
        <div class="SHOWTRAK_PC_STATUS ${Online && !Degraded ? 'd-grid' : 'd-none'} gap-2" data-type="INDICATOR_ONLINE">
					<div class="progress">
						<div data-type="CPU" class="progress-bar bg-white" role="progressbar" style="width: 0%;"></div>
					</div>
					<div class="progress">
						<div data-type="RAM" class="progress-bar bg-white" role="progressbar" style="width: 0%;"></div>
					</div>
				</div>
        <div class="SHOWTRAK_PC_STATUS ${Online && Degraded ? 'd-grid' : 'd-none'}" data-type="INDICATOR_DEGRADED">
          <h7 class="mb-0 text-warning" data-type="DEGRADED_WARNING">${Safe(WarningText)}</h7>
        </div>
				<div class="SHOWTRAK_PC_STATUS ${Online ? 'd-none' : 'd-grid'}" data-type="INDICATOR_OFFLINE">
					<h7 class="mb-0" data-type="OFFLINE_SINCE" data-offlinesince="${LastSeen}">
            ${OfflineBadgeContent()}
					</h7>
				</div>
			</div>`;
}

// Patch an already-rendered client tile in place from a live ClientUpdated
// payload (called by the 09-osc-feeds subscription). Counterpart to
// UpdateMonitoringTargetTile / UpdateDummyClientTile.
export function UpdateClientTile(Data: ClientView): void {
  const { UUID, Nickname, Hostname, IP, Online, Vitals } = Data;
  const Degraded = !!Data.Degraded;
  const DegradedWarning =
    Array.isArray(Data.DegradedWarnings) && Data.DegradedWarnings.length
      ? String(Data.DegradedWarnings[0])
      : 'Missing USB Device';

  $(`[data-uuid='${UUID}']`).toggleClass('ONLINE', Online && !Degraded);
  $(`[data-uuid='${UUID}']`).toggleClass('DEGRADED', Degraded);
  $(`[data-uuid='${UUID}']`).toggleClass('IDENTIFYING', !!Data.Identifying);
  $(`[data-uuid='${UUID}']>[data-type='INDICATOR_DEGRADED']>[data-type='DEGRADED_WARNING']`).text(
    DegradedWarning
  );

  const ComputedHostname = FormatClientHostnameVersionLabel(Data);
  if ($(`[data-uuid='${UUID}']>[data-type="Hostname"]`).text() !== ComputedHostname) {
    $(`[data-uuid='${UUID}']>[data-type="Hostname"]`).text(ComputedHostname);
  }

  const ComputedNickname = (Nickname && Nickname.length ? Nickname : Hostname) || '';
  if ($(`[data-uuid='${UUID}']>[data-type="Nickname"]`).text() !== ComputedNickname) {
    $(`[data-uuid='${UUID}']>[data-type="Nickname"]`).text(ComputedNickname);
  }

  const ComputedIP = IP ? IP : 'Unknown IP';
  if ($(`[data-uuid='${UUID}']>[data-type="IP"]`).text() !== ComputedIP) {
    $(`[data-uuid='${UUID}']>[data-type="IP"]`).text(ComputedIP);
  }

  const CompactOnlineStatus = $(`[data-uuid='${UUID}']>[data-type="COMPACT_ONLINE_STATUS"]`);
  if (CompactOnlineStatus.length) {
    CompactOnlineStatus.text(GetClientCompactStatusLabel(Data));
    CompactOnlineStatus.removeClass('d-none');
  }

  if (Online && Vitals) {
    $(`[data-uuid='${UUID}']>div>.progress>[data-type="CPU"]`).css(
      'width',
      `${Vitals.CPU.UsagePercentage}%`
    );
    $(`[data-uuid='${UUID}']>div>.progress>[data-type="RAM"]`).css(
      'width',
      `${Vitals.Ram.UsagePercentage}%`
    );
    $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_OFFLINE"]`).addClass(
      'd-none'
    );
    $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_OFFLINE"]`).removeClass(
      'd-grid'
    );
    $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_ONLINE"]`).addClass('d-grid');
    $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_ONLINE"]`).removeClass(
      'd-none'
    );

    $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_DEGRADED"]`).toggleClass(
      'd-grid',
      Degraded
    );
    $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_DEGRADED"]`).toggleClass(
      'd-none',
      !Degraded
    );
    $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_ONLINE"]`).toggleClass(
      'd-none',
      Degraded
    );
    $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_ONLINE"]`).toggleClass(
      'd-grid',
      !Degraded
    );
  } else {
    $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_OFFLINE"]`).addClass(
      'd-grid'
    );
    $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_OFFLINE"]`).removeClass(
      'd-none'
    );
    $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_ONLINE"]`).addClass('d-none');
    $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_ONLINE"]`).removeClass(
      'd-grid'
    );
    $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_DEGRADED"]`).addClass(
      'd-none'
    );
    $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_DEGRADED"]`).removeClass(
      'd-grid'
    );
  }

  $(
    `[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_OFFLINE"]>[data-type="OFFLINE_SINCE"]`
  ).attr('data-offlinesince', Data.LastSeen ?? '');
}

export function RenderFullClientAndMonitorList() {
  const Clients = Array.isArray(__LastClients) ? __LastClients.slice() : [];
  let Groups = Array.isArray(__LastGroups) ? __LastGroups.slice() : [];
  const Monitors = Array.isArray(MonitoringTargets) ? MonitoringTargets.slice() : [];
  const Dummies = Array.isArray(DummyClients) ? DummyClients.slice() : [];
  let Filler = '';

  Groups.push({
    GroupID: null as unknown as number,
    Title: 'No Group',
    Weight: 100000,
    isFullWidth: true,
  });

  const ColumnCount = GetGroupColumnCount();

  // Keep the synthetic no-group bucket pinned to the bottom.
  Groups = Groups.sort((a, b) => {
    const ADefault = a && a.GroupID == null;
    const BDefault = b && b.GroupID == null;
    if (ADefault !== BDefault) return ADefault ? 1 : -1;
    return (a.Weight || 0) - (b.Weight || 0);
  });

  if (Groups.length == 1 && Clients.length == 0 && Monitors.length == 0 && Dummies.length == 0) {
    Filler += `<div class="bg-ghost rounded m-3 mb-0 d-grid gap-0 gap-3 p-3">
            <h5 class="text-light mb-0">
                Welcome to ShowTrak Server v${Safe(Config.Application.Version)}
            </h5>
            <p class="text-light mb-0">
                You don't have any clients configured yet. Discover clients on your network and adopt them with the Adoption Manager below.
            </p>
        </div>`;
  }

  // Groups are laid out on a fixed column grid. Full-width groups span every
  // column; narrow groups take one column. Grid auto-flow (non-dense) preserves
  // strict group order and leaves a blank slot when a wide group cannot fit in
  // the columns remaining on the current row.
  Filler += `<div class="group-column-grid" style="grid-template-columns: repeat(${ColumnCount}, minmax(0, 1fr));">`;

  for (const Group of Groups) {
    const { GroupID, Title } = Group;
    const FullGroupTitle = Title == null ? '' : String(Title);
    const GroupLabel = TruncateGroupLabel(FullGroupTitle);
    const GroupSpan = Group.isFullWidth === false ? 1 : ColumnCount;
    const GroupClients = Clients.filter((Client) => Client.GroupID === GroupID).sort(
      (a, b) => (a.Weight || 0) - (b.Weight || 0)
    );
    const GroupMonitors = Monitors.filter((M) => (M.GroupID || null) === GroupID);
    const GroupDummies = Dummies.filter((D) => (D.GroupID || null) === GroupID);

    GroupUUIDCache.set(
      `${GroupID}`,
      GroupClients.map((c) => c.UUID)
    );

    if (
      GroupClients.length == 0 &&
      GroupMonitors.length == 0 &&
      GroupDummies.length == 0 &&
      GroupID == null
    )
      continue;

    // Merge clients + monitors and sort by Weight so a unified ordering set
    // by drag/drop is preserved.
    const Merged = ([] as MergedTileEntry[])
      .concat(
        GroupClients.map((c) => ({ kind: 'client' as const, weight: c.Weight || 0, data: c })),
        GroupMonitors.map((m) => ({ kind: 'monitor' as const, weight: m.Weight || 0, data: m })),
        GroupDummies.map((d) => ({ kind: 'dummy' as const, weight: d.Weight || 0, data: d }))
      )
      .sort((a, b) => a.weight - b.weight);

    Filler += `<div class="d-flex justify-content-start group-column-item" data-flip-key="group:${GroupID}" style="grid-column: span ${GroupSpan};">
    <div class="GROUP_TITLE_CLICKABLE m-3 me-0 mb-0 rounded" data-groupid="${GroupID}" title="${Safe(FullGroupTitle)}" aria-label="${Safe(FullGroupTitle)}">
			<div class="d-flex align-items-center text-center h-100">
				<span class="GROUP_TITLE py-2">
          ${Safe(GroupLabel)}
				</span>
			</div>
		</div>
	<div class="bg-ghost rounded m-3 mb-0 d-flex flex-wrap justify-content-start align-items-center p-3 gap-3 w-100 group-drop-zone" data-groupid="${GroupID}">`;

    if (Merged.length == 0) {
      Filler += `<div class="SHOWTRAK_PC_PLACEHOLDER w-100 p-3"
				<h5 class="text-muted mb-0">
					Empty Group
				</h5>
				<p class="text-muted mb-0">
					This group has no clients.
				</p>
			</div>`;
    } else {
      for (const Item of Merged) {
        if (Item.kind === 'client') {
          Filler += RenderClientTile(Item.data);
        } else if (Item.kind === 'dummy') {
          Filler += RenderDummyClientTile(Item.data);
        } else {
          Filler += RenderMonitoringTargetTile(Item.data);
        }
      }
    }

    Filler += `</div></div>`;
  }

  // Close the group column grid before appending non-group sections.
  Filler += `</div>`;

  // Append Pending Adoption section after groups, if any
  Filler += RenderPendingAdoptionSection();

  // Animate structural changes (clients moving groups, groups reordering) by
  // capturing tile/group positions before the DOM is rebuilt and sliding them
  // to their new positions afterwards. Falls back to a plain render when the
  // helper is unavailable or reduced-motion is preferred.
  const ContentRoot = document.getElementById('APPLICATION_CONTENT');
  if (
    ContentRoot &&
    window.ShowTrakFlip &&
    typeof window.ShowTrakFlip.AnimateReflow === 'function'
  ) {
    window.ShowTrakFlip.AnimateReflow(ContentRoot, () => {
      $('#APPLICATION_CONTENT').html(Filler);
    });
  } else {
    $('#APPLICATION_CONTENT').html(Filler);
  }
  // Initialize or teardown edit-mode interactions after render
  try {
    initializeEditInteractions();
  } catch (e) {
    HandleNonFatalError('RenderFullClientAndMonitorList:initializeEditInteractions', e);
  }
  UpdateIdentifyStatusBanner();
}

// Renderer receives live updates for devices pending adoption. Body unchanged
// from the former import-time subscription.
function InitPendingAdoptionPush() {
  window.API.SetDevicesPendingAdoption(async (Devices) => {
  const previous = Array.isArray(PendingAdoption) ? PendingAdoption : [];
  const next = Array.isArray(Devices) ? Devices : [];
  // Build fast lookup maps
  const prevMap = new Map(previous.map((d) => [d.UUID, d]));
  const nextMap = new Map(next.map((d) => [d.UUID, d]));

  // 1) Add alerts for newly available devices
  for (const dev of next) {
    const uuid = dev && dev.UUID;
    if (!uuid) continue;
    if (!prevMap.has(uuid) && !PendingAdoptionAlerts.has(uuid)) {
      const title = 'Device available for adoption';
      const msg = `${Safe(dev.Hostname || 'Unknown Host')} (${Safe(dev.IP || 'Unknown IP')})`;
      const id = AddAlert({
        type: 'adoption',
        severity: 'info',
        title,
        message: msg,
        clientUUID: uuid,
        iconHtml: '<i class="bi bi-person-plus"></i>',
      });
      PendingAdoptionAlerts.set(uuid, id);
    }
  }

  // 2) Auto-dismiss alerts for devices that are no longer pending (adopted/removed) or state changed to Adopting
  for (const dev of previous) {
    const uuid = dev && dev.UUID;
    if (!uuid) continue;
    const stillPending = nextMap.has(uuid);
    const now = nextMap.get(uuid) as
      | { State?: string; status?: string; state?: string }
      | undefined;
    const status = now && (now.State || now.status || now.state);
    const shouldDismiss = !stillPending || String(status).toLowerCase() === 'adopting';
    if (shouldDismiss && PendingAdoptionAlerts.has(uuid)) {
      const alertId = PendingAdoptionAlerts.get(uuid);
      DismissAlert(alertId);
      PendingAdoptionAlerts.delete(uuid);
    }
  }

    setPendingAdoption(next);
  // If main content already rendered, update/insert the section in place
  try {
    if (AppMode !== 'EDIT') {
      const $existing = $('#PENDING_ADOPTION_SECTION');
      if ($existing.length) $existing.replaceWith('<div id="PENDING_ADOPTION_SECTION"></div>');
      UpdateIdentifyStatusBanner();
      return;
    }
    const html = RenderPendingAdoptionSection();
    const $existing = $('#PENDING_ADOPTION_SECTION');
    if ($existing.length) {
      $existing.replaceWith(html);
    } else {
      // If no section yet (e.g., first update before full list), append to content if present
      if ($('#APPLICATION_CONTENT').length) {
        $('#APPLICATION_CONTENT').append(html);
      }
    }
  } catch (e) {
    HandleNonFatalError('SetDevicesPendingAdoption:Render', e);
  }
  UpdateIdentifyStatusBanner();
  });
}

export function RenderPendingAdoptionSection() {
  try {
    if (AppMode !== 'EDIT') return '<div id="PENDING_ADOPTION_SECTION"></div>';
    const list = Array.isArray(PendingAdoption) ? PendingAdoption : [];
    if (!list.length) return '<div id="PENDING_ADOPTION_SECTION"></div>';
    let html = '';
    html += `<div id="PENDING_ADOPTION_SECTION" class="d-flex justify-content-start">`;
    html += `  <div class="GROUP_TITLE_CLICKABLE m-3 me-0 mb-0 rounded">`;
    html += `    <div class="d-flex align-items-center text-center h-100">`;
    html += `      <span class="GROUP_TITLE py-2">DISCOVER</span>`;
    html += `    </div>`;
    html += `  </div>`;
    html += `  <div class="bg-ghost rounded m-3 mb-0 d-flex flex-wrap justify-content-start align-items-center p-3 gap-3 w-100 group-drop-zone">`;
    for (const dev of list) {
      const Hostname = dev && dev.Hostname ? dev.Hostname : 'Unknown Host';
      const IP = dev && dev.IP ? dev.IP : 'Unknown IP';
      const UUID = dev && dev.UUID ? dev.UUID : '';
      const IdentifyingClass = dev && dev.Identifying ? 'IDENTIFYING' : '';
      const SelectedClass = UUID && Selected.includes(UUID) ? 'SELECTED' : '';
      html += `
        <div class="SHOWTRAK_PC PENDING ${IdentifyingClass} ${SelectedClass}" data-uuid="${Safe(UUID)}">
          <h5 class="mb-0" data-type="PENDING_HOSTNAME" title="${Safe(Hostname)}">${Safe(
            Hostname
          )}</h5>
          <small class="text-sm text-light" data-type="PENDING_IP">${Safe(IP)}</small>
          <div class="d-grid" data-type="PENDING_ACTION">
            <button class="btn btn-sm btn-light SHOWTRAK_BTN_ROUNDED ADOPT_BTN" data-uuid="${Safe(
              UUID
            )}">Adopt</button>
          </div>
        </div>`;
    }
    html += `  </div>`;
    html += `</div>`;
    return html;
  } catch (e) {
    return '<div id="PENDING_ADOPTION_SECTION"></div>';
  }
}
