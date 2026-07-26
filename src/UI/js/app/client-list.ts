import {
  AppMode,
  ClientInfoOpenUUID,
  Config,
  DummyClients,
  FormatClientHostnameVersionLabel,
  GroupSelectableUUIDCache,
  GroupUUIDCache,
  MonitoringTargets,
  PendingAdoption,
  Selected,
  Settings,
  __LastClients,
  __LastGroups,
  setAllClients,
  setPendingAdoption,
  setScriptList,
  set__LastClients,
  set__LastGroups,
} from './state';
import { OfflineBadgeContent, UnassignedBadgeContent } from './lib/status-badges';
import {
  BuildGroupRenderOrder,
  BuildGroupSelectableIDs,
  BuildMergedTiles,
  GetClientCompactStatusLabel,
  GetClientTileStateClass,
  GetGroupSpan,
  GetTileWarningText,
  ParseGroupColumnCount,
  SelectGroupMembers,
  ShouldRenderGroup,
  ShouldShowWelcomePanel,
  TruncateGroupLabel,
} from './lib/client-list-layout';
import type { ClientView, ScriptExecutionView } from '@showtrak/protocol';
import { HandleNonFatalError, Safe } from './utils';
import { RenderMonitoringTargetTile } from './monitoring';
import { initializeEditInteractions } from './dnd';
import { AddAlert, DismissAlert, PendingAdoptionAlerts } from './alerts-tray';
import { CloseAllModals, UpdateManagerHandleExecutions } from './modals';
import {
  ConfirmationDialog,
  HideExecutionToast,
  RenderClientInfoDetails,
  ShowExecutionToast,
  UpdateIdentifyStatusBanner,
} from './selection-init';
import { RenderDummyClientTile } from './dummy-clients';

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

// The status/layout rules now live in ./lib/client-list-layout (pure, tested).
// Re-exported here because the rest of the renderer imports them from this
// module; the definitions moved, the public surface did not.
export {
  GetClientStatusDisplayText,
  GetClientCompactStatusLabel,
  TruncateGroupLabel,
} from './lib/client-list-layout';

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
    // Keep the manager's insertion order so newly-started executions append at the
    // bottom of the list and each client visibly works down its own queue.

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

    // Auto-dismiss the execution panel 5 seconds after every execution has SETTLED
    // — whether it succeeded or failed. Queued and running executions are both
    // Status='Pending', so the panel stays open while any work remains, and if a
    // new batch is started within the 5s window the else-branch below cancels the
    // countdown — the panel only closes 5s after the LAST script finishes.
    const shouldAutoDismissNonDeployment =
      nonDeploymentExecutions.length > 0 &&
      nonDeploymentExecutions.every((Request) => Request && Request.Status !== 'Pending');

    if (shouldAutoDismissNonDeployment) {
      if (!window.__ShowTrakExecutionAutoDismissTimer) {
        window.__ShowTrakExecutionAutoDismissTimer = setTimeout(async () => {
          window.__ShowTrakExecutionAutoDismissTimer = null;
          HideExecutionToast();
          // Wipe the finished rows now the panel is gone, so the next run renders
          // into an empty list rather than stacking on the previous batch. Only
          // settled entries are dropped — anything queued or running in the
          // meantime survives.
          try {
            await window.API.ClearSettledScriptExecutions();
          } catch (e) {
            HandleNonFatalError('ClearSettledScriptExecutions', e);
          }
        }, 5000);
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
    const listEl = $list[0] as HTMLElement | undefined;
    if (!listEl) return;

    // Durations render white regardless of how long they took — the row's state
    // (fill colour + indicator) already carries success/failure, so colouring the
    // timing on top of it read as a second, conflicting signal.
    function durationText(ms: number) {
      return `<small class="exec-duration">${Safe(ms)}ms</small>`;
    }

    function truncateExecutionLabel(value: string | null | undefined, maxLen = 34) {
      const text = value == null ? '' : String(value).trim();
      if (!text) return '';
      if (text.length <= maxLen) return text;
      return `${text.substring(0, Math.max(1, maxLen - 1))}…`;
    }

    // The execution list is patched IN PLACE (keyed by RequestID) rather than
    // rebuilt with innerHTML on every push. Wholesale rebuilds recreate the
    // spinner and progress-fill DOM nodes, restarting their CSS animations — with
    // console-tail updates arriving several times a second that reads as glitchy
    // flicker. Reusing each row's nodes and touching only the volatile bits keeps
    // the spinner spinning and the gradient/width transition smooth.
    const desiredKeys = new Set<string>();

    // Deployment summary is a single keyed node pinned to the top of the list.
    if (hasRenderableDeploymentToast) {
      desiredKeys.add('__deploy__');
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

      let deployEl = listEl.querySelector<HTMLElement>('[data-exec-key="__deploy__"]');
      if (!deployEl) {
        deployEl = document.createElement('div');
        deployEl.setAttribute('data-exec-key', '__deploy__');
        listEl.insertBefore(deployEl, listEl.firstChild);
      }
      deployEl.className = `exec-deploy-summary ${ExpandFailures ? 'open' : ''}`;
      deployEl.innerHTML = `
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
        ${deploymentSummary.failed.length > 0 ? `<div class="exec-deploy-failures ${ExpandFailures ? '' : 'd-none'}"><div class="exec-deploy-failures-title">Failed Clients</div><ul>${FailedItems}</ul></div>` : ''}`;
    }

    const renderExecutions = hasRenderableDeploymentToast
      ? deploymentRequests
      : nonDeploymentExecutions;

    for (let i = 0; i < renderExecutions.length; i++) {
      const Request = renderExecutions[i];
      if (!Request) continue; // i is within renderExecutions bounds
      const key = String(Request.RequestID);
      desiredKeys.add(key);

      const rawScriptName =
        Request && Request.Script && Request.Script.Name ? String(Request.Script.Name).trim() : '';
      const rawClientName = Request.Client.Nickname
        ? Request.Client.Nickname
        : Request.Client.Hostname;
      const fullClientName = rawClientName || 'Unknown Client';

      let timeBadge = '';
      if (Request.Timer && typeof Request.Timer.Duration === 'number') {
        timeBadge = durationText(Request.Timer.Duration);
      }

      // Progress fill width. Completed always reads full; failed shows however far
      // it got (full if unknown) in red; pending/running follow the reported value
      // with a small floor so the row never looks empty.
      const reportedProgress =
        typeof Request.Progress === 'number' && Number.isFinite(Request.Progress)
          ? Math.max(0, Math.min(100, Request.Progress))
          : 0;

      // Classify the execution into one visual state that drives the row's
      // background progress fill, the right-side indicator, and (on failure) the
      // inline error. Once the client reports the process has spawned (progress
      // reaches the Running stage), the row gets a spinner; StatusText from that
      // point is live console output, so the spinner keys off progress, not text.
      const rawStatusText = Request.StatusText ? String(Request.StatusText).trim() : '';
      const isRunning = Request.Status === 'Pending' && reportedProgress >= 50;
      const state =
        Request.Status === 'Completed'
          ? 'completed'
          : Request.Status === 'Failed'
            ? 'failed'
            : isRunning
              ? 'running'
              : 'pending';
      let fillPercent: number;
      if (state === 'completed') fillPercent = 100;
      else if (state === 'failed') fillPercent = reportedProgress > 0 ? reportedProgress : 100;
      else if (state === 'running') fillPercent = reportedProgress > 0 ? reportedProgress : 65;
      else fillPercent = reportedProgress > 0 ? reportedProgress : 8;

      // Right-side indicator: check / spinner / info icon / queued dot. Swapped
      // only when the state changes, so the spinner element survives (and keeps
      // spinning) across the rapid console-tail updates while running.
      let indicatorHtml = '';
      if (state === 'completed') {
        indicatorHtml = `<span class="exec-btn-icon exec-success" role="img" aria-label="Completed"><i class="bi bi-check-circle-fill"></i></span>`;
      } else if (state === 'failed') {
        indicatorHtml = `<span class="exec-btn-icon exec-fail" role="img" aria-label="Failed"><i class="bi bi-exclamation-triangle-fill"></i></span>`;
      } else if (state === 'running') {
        indicatorHtml = `<span class="exec-spinner" role="img" aria-label="Running"></span>`;
      } else {
        indicatorHtml = `<span class="exec-btn-icon exec-queued" role="img" aria-label="Queued"><i class="bi bi-hourglass-split"></i></span>`;
      }

      // Inline status/error text (sits on the same row — never a block below).
      // Returned as data so it can be applied to a persistent span via textContent.
      let inlineClass = '';
      let inlineText = '';
      let inlineTitle = '';
      if (state === 'failed' && Request.Error && rawScriptName !== 'Deploying Scripts') {
        inlineClass = 'exec-inline exec-inline-error';
        inlineText = truncateExecutionLabel(Request.Error, 60);
        inlineTitle = String(Request.Error);
      } else if (state === 'running') {
        // While running, StatusText carries the live tail of the script's console
        // output. Show it monospace so it reads as terminal output; fall back to a
        // generic label until the first line arrives.
        const isConsole = !!rawStatusText && rawStatusText !== 'Running';
        inlineClass = `exec-inline exec-inline-stage${isConsole ? ' exec-inline-console' : ''}`;
        inlineText = isConsole ? truncateExecutionLabel(rawStatusText, 64) : 'Running…';
        inlineTitle = rawStatusText;
      } else if (state === 'pending') {
        inlineClass = 'exec-inline exec-inline-stage';
        inlineText = rawStatusText && rawStatusText !== 'Pending' ? rawStatusText : 'Queued';
        inlineTitle = '';
      }

      // --- upsert the row ------------------------------------------------------
      let el = listEl.querySelector<HTMLElement>(`.exec-item[data-request-id="${key}"]`);
      if (!el) {
        el = document.createElement('div');
        el.className = `exec-item state-${state}`;
        el.setAttribute('data-request-id', key);
        el.dataset.state = state;
        el.dataset.indicator = state;
        el.style.setProperty('--exec-progress', `${fillPercent}%`);
        const scriptChip =
          uniformScriptName || !rawScriptName
            ? ''
            : `<span class="badge bg-ghost-light text-light exec-chip" title="${Safe(rawScriptName)}">${Safe(truncateExecutionLabel(rawScriptName, 28))}</span>`;
        el.innerHTML = `
				<div class="exec-fill"></div>
				<div class="exec-row">
					<div class="exec-left">
            <span class="badge bg-ghost-light text-light exec-chip" title="${Safe(fullClientName)}">${Safe(truncateExecutionLabel(rawClientName, 40))}</span>
            ${scriptChip}
            <span class="exec-inline-slot" data-inline></span>
					</div>
					<div class="exec-right">
						<span class="exec-time"></span>
						<div class="exec-actions">${indicatorHtml}</div>
					</div>
				</div>`;
        listEl.appendChild(el);
      }

      // Volatile updates only — the .exec-fill and spinner nodes are never replaced
      // unless the state changes, so their animations run uninterrupted.
      el.style.setProperty('--exec-progress', `${fillPercent}%`);
      if (el.dataset.state !== state) {
        el.classList.remove('state-pending', 'state-running', 'state-completed', 'state-failed');
        el.classList.add(`state-${state}`);
        el.dataset.state = state;
      }
      if (el.dataset.indicator !== state) {
        const actions = el.querySelector('.exec-actions');
        if (actions) actions.innerHTML = indicatorHtml;
        el.dataset.indicator = state;
      }
      const timeEl = el.querySelector<HTMLElement>('.exec-time');
      if (timeEl) {
        if (timeEl.innerHTML !== timeBadge) timeEl.innerHTML = timeBadge;
        timeEl.style.display = timeBadge ? '' : 'none';
      }
      const inlineEl = el.querySelector<HTMLElement>('[data-inline]');
      if (inlineEl) {
        const nextClass = `exec-inline-slot${inlineClass ? ` ${inlineClass}` : ''}`;
        if (inlineEl.className !== nextClass) inlineEl.className = nextClass;
        if (inlineEl.textContent !== inlineText) inlineEl.textContent = inlineText;
        if (inlineEl.title !== inlineTitle) inlineEl.title = inlineTitle;
        inlineEl.style.display = inlineText ? '' : 'none';
      }
    }

    // Drop rows whose executions are no longer present (e.g. after ClearSettled).
    for (const child of Array.from(listEl.children)) {
      const childKey =
        child.getAttribute('data-request-id') || child.getAttribute('data-exec-key') || '';
      if (!desiredKeys.has(childKey)) child.remove();
    }
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
  return ParseGroupColumnCount(Settings);
}

// Build the HTML for a single client tile. Mirrors the monitor/dummy tile
// builders (RenderMonitoringTargetTile / RenderDummyClientTile); the live
// in-place counterpart is UpdateClientTile below.
export function RenderClientTile(Client: ClientView): string {
  const { Nickname, Hostname, IP, UUID, Online, LastSeen, Degraded, Unassigned } = Client;
  const HostnameVersionLabel = FormatClientHostnameVersionLabel(Client);
  const CompactStatusLabel = GetClientCompactStatusLabel(Client);
  const WarningText = GetTileWarningText(Client);
  const TileStateClass = GetClientTileStateClass(Client);
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
					${
            Unassigned
              ? // Deliberately not [data-type="OFFLINE_SINCE"]: that is the
                // selector the per-second offline counter ticks, and it would
                // overwrite this label within a second.
                `<h7 class="mb-0" data-type="UNASSIGNED_LABEL">
            ${UnassignedBadgeContent()}
					</h7>`
              : `<h7 class="mb-0" data-type="OFFLINE_SINCE" data-offlinesince="${LastSeen}">
            ${OfflineBadgeContent()}
					</h7>`
          }
				</div>
			</div>`;
}

// Patch an already-rendered client tile in place from a live ClientUpdated
// payload (called by the osc-feeds subscription). Counterpart to
// UpdateMonitoringTargetTile / UpdateDummyClientTile.
//
// Everything below is resolved through `$tile` rather than a repeated
// `[data-uuid='…']` lookup, which fixes two things at once:
//
//   Correctness — `[data-uuid='X']` is not tile-scoped. A client UUID also
//   appears on the Update Manager's row and its checkbox, so the class toggles
//   below used to land on those too. (Nothing is lost by scoping: the same
//   ClientUpdated handler re-renders that list from its own state when the
//   modal is open, which is the authoritative path.)
//
//   Cost — attribute selectors take jQuery's slow path, so each one was a
//   document-wide querySelectorAll. This ran ~29 of them per tile per update,
//   on every client's heartbeat. The id lookup is a single getElementById and
//   every child query is scoped to that subtree.
export function UpdateClientTile(Data: ClientView): void {
  const { UUID, Nickname, Hostname, IP, Online, Vitals } = Data;

  const $tile = $(`#CLIENT_TILE_${UUID}`);
  // No tile rendered for this client (filtered out, or a push that arrived
  // mid-rebuild). Every operation below would have been a no-op anyway.
  if (!$tile.length) return;

  const Degraded = !!Data.Degraded;
  const DegradedWarning =
    Array.isArray(Data.DegradedWarnings) && Data.DegradedWarnings.length
      ? String(Data.DegradedWarnings[0])
      : 'Missing USB Device';

  const $IndicatorOnline = $tile.children('.SHOWTRAK_PC_STATUS[data-type="INDICATOR_ONLINE"]');
  const $IndicatorOffline = $tile.children('.SHOWTRAK_PC_STATUS[data-type="INDICATOR_OFFLINE"]');
  const $IndicatorDegraded = $tile.children('.SHOWTRAK_PC_STATUS[data-type="INDICATOR_DEGRADED"]');

  $tile
    .toggleClass('ONLINE', Online && !Degraded)
    .toggleClass('DEGRADED', Degraded)
    .toggleClass('IDLE', !!Data.Unassigned && !Online && !Degraded)
    .toggleClass('IDENTIFYING', !!Data.Identifying);

  $IndicatorDegraded.children('[data-type="DEGRADED_WARNING"]').text(DegradedWarning);

  const $Hostname = $tile.children('[data-type="Hostname"]');
  const ComputedHostname = FormatClientHostnameVersionLabel(Data);
  if ($Hostname.text() !== ComputedHostname) $Hostname.text(ComputedHostname);

  const $Nickname = $tile.children('[data-type="Nickname"]');
  const ComputedNickname = (Nickname && Nickname.length ? Nickname : Hostname) || '';
  if ($Nickname.text() !== ComputedNickname) $Nickname.text(ComputedNickname);

  const $IP = $tile.children('[data-type="IP"]');
  const ComputedIP = IP ? IP : 'Unknown IP';
  if ($IP.text() !== ComputedIP) $IP.text(ComputedIP);

  const CompactOnlineStatus = $tile.children('[data-type="COMPACT_ONLINE_STATUS"]');
  if (CompactOnlineStatus.length) {
    CompactOnlineStatus.text(GetClientCompactStatusLabel(Data));
    CompactOnlineStatus.removeClass('d-none');
  }

  if (Online && Vitals) {
    const $Progress = $tile.children('div').children('.progress');
    $Progress.children('[data-type="CPU"]').css('width', `${Vitals.CPU.UsagePercentage}%`);
    $Progress.children('[data-type="RAM"]').css('width', `${Vitals.Ram.UsagePercentage}%`);

    $IndicatorOffline.addClass('d-none').removeClass('d-grid');
    $IndicatorDegraded.toggleClass('d-grid', Degraded).toggleClass('d-none', !Degraded);
    $IndicatorOnline.toggleClass('d-none', Degraded).toggleClass('d-grid', !Degraded);
  } else {
    $IndicatorOffline.addClass('d-grid').removeClass('d-none');
    $IndicatorOnline.addClass('d-none').removeClass('d-grid');
    $IndicatorDegraded.addClass('d-none').removeClass('d-grid');
  }

  $IndicatorOffline
    .children('[data-type="OFFLINE_SINCE"]')
    .attr('data-offlinesince', Data.LastSeen ?? '');
}

export function RenderFullClientAndMonitorList() {
  const Clients = Array.isArray(__LastClients) ? __LastClients.slice() : [];
  const Monitors = Array.isArray(MonitoringTargets) ? MonitoringTargets.slice() : [];
  const Dummies = Array.isArray(DummyClients) ? DummyClients.slice() : [];
  let Filler = '';

  // Appends the synthetic "No Group" bucket and pins it to the bottom.
  const Groups = BuildGroupRenderOrder(__LastGroups);
  const ColumnCount = GetGroupColumnCount();

  if (ShouldShowWelcomePanel(Groups.length, Clients, Monitors, Dummies)) {
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
    const GroupSpan = GetGroupSpan(Group, ColumnCount);
    const Members = SelectGroupMembers(GroupID, Clients, Monitors, Dummies);

    GroupUUIDCache.set(
      `${GroupID}`,
      Members.Clients.map((c) => c.UUID)
    );

    // Selection cache mirrors the tile data-uuid values so the group-title
    // button toggles every client type in the group (ShowTrak clients plus
    // prefixed monitor:/dummy: tiles), not just ShowTrak clients.
    GroupSelectableUUIDCache.set(`${GroupID}`, BuildGroupSelectableIDs(Members));

    if (!ShouldRenderGroup(GroupID, Members)) continue;

    // Merged and weight-ordered so a unified ordering set by drag/drop across
    // clients, monitors and dummies is preserved.
    const Merged = BuildMergedTiles(Members);

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
          iconHtml: '<i class="bi bi-person-plus-fill"></i>',
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
        { State?: string; status?: string; state?: string } | undefined;
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
