import {
  AppMode,
  ClientInfoOpenUUID,
  Config,
  DummyClients,
  FreeKioskTerminals,
  FormatClientHostnameVersionLabel,
  GroupSelectableUUIDCache,
  GroupUUIDCache,
  MonitoringTargets,
  PendingAdoption,
  ScriptList,
  Selected,
  Settings,
  Tags,
  __LastClients,
  __LastGroups,
  setAllClients,
  setPendingAdoption,
  setScriptList,
  set__LastClients,
  set__LastGroups,
} from './state';
import { UpdateOfflineIndicators } from './offline-indicators';
import { OfflineBadgeContent, UnassignedBadgeContent } from './lib/status-badges';
import { ResolveEntityTags } from './lib/tag-badges';
import { RenderTagBadgeRow } from './lib/tag-badge-view';
import {
  BuildGroupRenderOrder,
  BuildGroupSelectableIDs,
  BuildMergedTiles,
  GetClientCompactStatusLabel,
  GetClientTileStateClass,
  GetGroupSpan,
  GetGroupTintHex,
  GetTileWarningText,
  ParseGroupColumnCount,
  SelectGroupMembers,
  ShouldAnimateBars,
  ShouldRenderGroup,
  ShouldShowWelcomePanel,
  TruncateGroupLabel,
  VitalsBarScale,
} from './lib/client-list-layout';
import type { ClientView, ScriptExecutionView } from '@showtrak/protocol';
import {
  CountCompletedExecutions,
  GetCompletedSectionLabel,
  GetExecutionVisualState,
  GetReportedProgress,
  AllExecutionsSettled,
  GetRetryAllLabel,
  IsRetryableExecution,
  ShouldAutoDismissExecutions,
} from './lib/execution-panel';
import { HandleNonFatalError, Safe } from './utils';
import { IsExecutionConsoleOpen, OpenExecutionConsole } from './execution-console';
import { RenderMonitoringTargetTile } from './monitoring';
import { initializeEditInteractions } from './dnd';
import { AddAlert, DismissAlert, PendingAdoptionAlerts } from './alerts-tray';
import { CloseAllModals, UpdateManagerHandleExecutions } from './modals';
import { UPDATE_EXECUTION_SCRIPT_NAME } from './update-manager';
import {
  ConfirmationDialog,
  HideExecutionToast,
  Notify,
  OnExecutionToastDismissed,
  RenderClientInfoDetails,
  SetExecutionsInProgress,
  ShowExecutionToast,
  UpdateIdentifyStatusBanner,
} from './selection-init';
import { RenderDummyClientTile } from './dummy-clients';
import { RenderFreeKioskTile } from './freekiosk';
import {
  RenderListGroupHeaderCells,
  RenderListRowCells,
  RenderListTableHeader,
  SyncListView,
} from './list-view';
import { ApplyListSearch } from './list-filter';
import { SyncTileWidgets } from './tile-widgets';
import { IndexClients } from './lib/client-patches';

// Every client of the last full list, by UUID. The values are the list's own
// objects (shared with __LastClients and AllClients), so a live patch applied
// through here (see osc-feeds) is seen by every reader without a scan or copy.
let ClientsByUUID = new Map<string, ClientView>();

/** The merged live client for a UUID, if it is in the current list. */
export function GetCachedClient(UUID: string): ClientView | undefined {
  return ClientsByUUID.get(UUID);
}

// --- Frame scheduling ---------------------------------------------------------
//
// Several pushes each ask for a full list render at startup and on a show
// switch (the client list, monitors, dummies, kiosks, tags, settings). They are
// coalesced into one render per frame. While the window is hidden no frame
// comes, so a short timer stands in: the list must still be drawn before the
// window is first revealed, and full renders are rare enough that this costs
// nothing while minimised.
const HIDDEN_RENDER_DELAY_MS = 100;
let FullRenderPending = false;

function RunPendingFullRender(): void {
  if (!FullRenderPending) return;
  RenderFullClientAndMonitorList();
}

/** Render the full list at the next frame, once however often it is asked. */
export function ScheduleFullRender(): void {
  if (FullRenderPending) return;
  FullRenderPending = true;
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(RunPendingFullRender);
  setTimeout(RunPendingFullRender, HIDDEN_RENDER_DELAY_MS);
}

/** Render now if a render is pending (for callers that read the DOM after it). */
export function FlushFullRender(): void {
  RunPendingFullRender();
}

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

// Called by the bootstrap orchestrator in main.ts, never at import time.
export function InitClientList() {
  window.API.ShutdownRequested(async () => {
    await CloseAllModals();
    const Confirmation = await ConfirmationDialog('Are you sure you want to close ShowTrak?', {
      ConfirmLabel: 'Close ShowTrak',
    });
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

/** How long the execution panel stays up once everything has settled. */
function ExecutionPanelDwellMs(): number {
  const Setting = (Array.isArray(Settings) ? Settings : []).find(
    (S) => S && S.Key === 'UI_EXECUTION_PANEL_DWELL_SECONDS'
  );
  const Seconds = Number(Setting ? Setting.Value : NaN);
  return (Number.isFinite(Seconds) && Seconds >= 0 ? Seconds : 5) * 1000;
}

// The execution panel's rows by RequestID, with the parts each push touches.
interface ExecutionRow {
  El: HTMLElement;
  Actions: HTMLElement | null;
  Time: HTMLElement | null;
  Inline: HTMLElement | null;
  // The fill scale last written, so an unchanged one is not re-set.
  Progress: string;
}
const ExecutionRows = new Map<string, ExecutionRow>();

const COMPLETED_SECTION_KEY = '__completed__';

// The executions the panel last showed (script runs, not deployments), read
// when the operator dismisses it.
let LastPanelExecutions: ScriptExecutionView[] = [];
// RequestIDs of the failures the panel currently offers to retry.
let RetryableExecutionIDs: string[] = [];
// Every execution the panel last rendered, by RequestID (for the console view).
let PanelExecutionsByID = new Map<string, ScriptExecutionView>();
// The executions push handler and the last list it saw: re-run when a console
// view closes, so a panel that settled while it was open can now auto-dismiss.
let ExecutionsHandler: ((All: ScriptExecutionView[]) => Promise<void>) | null = null;
let LastAllExecutions: ScriptExecutionView[] = [];

// Ask the server to retry these failed executions. The server re-checks what
// is retryable and replaces each failure's row with the new run.
async function RetryExecutions(RequestIDs: string[], Button: HTMLButtonElement | null) {
  if (!RequestIDs.length) return;
  if (Button) Button.disabled = true;
  try {
    const Result = await window.API.RetryScriptExecutions(RequestIDs);
    const Err = Array.isArray(Result) ? Result[0] : null;
    if (Err) Notify(`Retry failed: ${String(Err)}`, 'error', 6000);
  } catch (e) {
    HandleNonFatalError('RetryScriptExecutions', e);
  } finally {
    // The button is usually gone by now (its row was replaced); harmless if not.
    if (Button) Button.disabled = false;
  }
}

// The collapsed "completed" section, pinned to the top of the execution list
// (under the deployment summary when there is one). Completed rows are moved
// into its body, which stays hidden until the operator expands it, so the list
// only shows what is still queued, running or failed. Created on first use and
// reused after; the expanded state lives on the element, so a fresh batch (a
// new element) starts collapsed. Returns the body the completed rows go in.
function EnsureCompletedSection(
  ListEl: HTMLElement,
  Completed: number,
  Total: number
): HTMLElement {
  let Section = ListEl.querySelector<HTMLElement>(
    `:scope > [data-exec-key="${COMPLETED_SECTION_KEY}"]`
  );
  if (!Section) {
    Section = document.createElement('div');
    Section.className = 'exec-completed';
    Section.setAttribute('data-exec-key', COMPLETED_SECTION_KEY);
    Section.innerHTML = `
      <button type="button" class="exec-completed-toggle" aria-expanded="false">
        <i class="bi bi-chevron-right exec-completed-chevron" aria-hidden="true"></i>
        <i class="bi bi-check-circle-fill exec-completed-icon" aria-hidden="true"></i>
        <span class="exec-completed-label"></span>
      </button>
      <div class="exec-completed-list" hidden></div>`;
    const Toggle = Section.querySelector<HTMLElement>('.exec-completed-toggle');
    const Body = Section.querySelector<HTMLElement>('.exec-completed-list');
    const El = Section;
    if (Toggle && Body) {
      Toggle.addEventListener('click', () => {
        const Open = Toggle.getAttribute('aria-expanded') !== 'true';
        Toggle.setAttribute('aria-expanded', String(Open));
        Body.hidden = !Open;
        El.classList.toggle('open', Open);
      });
    }
  }
  const Deploy = ListEl.querySelector<HTMLElement>(':scope > [data-exec-key="__deploy__"]');
  const Anchor = Deploy ? Deploy.nextElementSibling : ListEl.firstElementChild;
  if (Section !== Anchor) ListEl.insertBefore(Section, Anchor);
  const Label = Section.querySelector<HTMLElement>('.exec-completed-label');
  const Text = GetCompletedSectionLabel(Completed, Total);
  if (Label && Label.textContent !== Text) Label.textContent = Text;
  return Section.querySelector<HTMLElement>('.exec-completed-list') || Section;
}

// Registers the script-execution / script-list / full-client-list push
// handlers. Bodies unchanged from the former import-time subscriptions.
function InitClientListPush() {
  // A batch that finished with failures stays up until the operator closes it.
  // Closing it then drops the settled rows, as the auto-dismiss does for a clean
  // batch, so the next push neither reopens the panel on old failures nor
  // stacks a new run under them. Anything still queued or running is kept.
  // Retry buttons: one per retryable failed row, plus "Retry N failed" in the
  // panel header. Delegated, so they survive the in-place row updates.
  $(document)
    .off('click.execRetry')
    .on('click.execRetry', '#EXECUTION_TOAST [data-retry-request]', function (e) {
      e.preventDefault();
      const RequestID = this.getAttribute('data-retry-request');
      if (RequestID) void RetryExecutions([RequestID], this as HTMLButtonElement);
    })
    .on('click.execRetry', '#EXECUTION_TOAST [data-console-request]', function (e) {
      e.preventDefault();
      const Execution = PanelExecutionsByID.get(this.getAttribute('data-console-request') || '');
      if (!Execution) return;
      // When the view closes, re-evaluate the panel: it may have settled (and
      // become due to close itself) while the operator was reading.
      OpenExecutionConsole(Execution, () => {
        if (ExecutionsHandler) void ExecutionsHandler(LastAllExecutions);
      });
    })
    .on('click.execRetry', '#EXECUTION_TOAST [data-retry-all]', function (e) {
      e.preventDefault();
      void RetryExecutions(RetryableExecutionIDs.slice(), this as HTMLButtonElement);
    });

  OnExecutionToastDismissed(() => {
    if (!AllExecutionsSettled(LastPanelExecutions)) return;
    window.API.ClearSettledScriptExecutions().catch((e: unknown) =>
      HandleNonFatalError('ClearSettledScriptExecutions:Dismiss', e)
    );
  });
  const HandleExecutions = async (AllExecutions: ScriptExecutionView[]) => {
    LastAllExecutions = AllExecutions || [];
    try {
      UpdateManagerHandleExecutions(AllExecutions || []);
    } catch (e) {
      HandleNonFatalError('UpdateManagerHandleExecutions', e);
    }
    // Client updates report their progress in the Update Manager, so they never
    // open, fill or hold open the executions panel.
    const Executions = (AllExecutions || []).filter(
      (Request) =>
        !(Request && Request.Script && Request.Script.Name === UPDATE_EXECUTION_SCRIPT_NAME)
    );

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

    SetExecutionsInProgress(
      nonDeploymentExecutions.some((Request) => Request && Request.Status === 'Pending')
    );

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

    // Auto-dismiss the execution panel a dwell time (UI_EXECUTION_PANEL_DWELL_SECONDS)
    // after every execution has SETTLED cleanly. Queued and running executions
    // are both Status='Pending', so the panel stays open while any work remains,
    // and if a new batch is started within the dwell the else-branch below
    // cancels the countdown; the panel only closes once the dwell has passed
    // since the LAST script finished. If anything failed it never closes itself:
    // the operator dismisses it (see OnExecutionToastDismissed below).
    LastPanelExecutions = nonDeploymentExecutions;
    const shouldAutoDismissNonDeployment = ShouldAutoDismissExecutions(nonDeploymentExecutions);

    // Never close the panel under an operator who is reading a console; the
    // view re-runs this check when it closes.
    if (shouldAutoDismissNonDeployment && !IsExecutionConsoleOpen()) {
      if (!window.__ShowTrakExecutionAutoDismissTimer) {
        window.__ShowTrakExecutionAutoDismissTimer = setTimeout(async () => {
          window.__ShowTrakExecutionAutoDismissTimer = null;
          HideExecutionToast();
          // Wipe the finished rows now the panel is gone, so the next run renders
          // into an empty list rather than stacking on the previous batch. Only
          // settled entries are dropped; anything queued or running in the
          // meantime survives.
          try {
            await window.API.ClearSettledScriptExecutions();
          } catch (e) {
            HandleNonFatalError('ClearSettledScriptExecutions', e);
          }
        }, ExecutionPanelDwellMs());
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
      nonDeploymentExecutions.length === 0 &&
      !IsExecutionConsoleOpen()
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

    const listEl = document.getElementById('SHOWTRAK_EXECUTION_LIST');
    if (!listEl) return;

    // Durations render white regardless of how long they took; the row's state
    // (fill colour + indicator) already carries success/failure, so colouring the
    // timing on top of it read as a second, conflicting signal.
    function durationText(ms: number) {
      return `<small class="exec-duration">${Safe(ms)}ms</small>`;
    }

    function truncateExecutionLabel(value: string | null | undefined, maxLen = 34) {
      const text = value == null ? '' : String(value).trim();
      if (!text) return '';
      if (text.length <= maxLen) return text;
      return `${text.substring(0, Math.max(1, maxLen - 3))}...`;
    }

    // The execution list is patched IN PLACE (keyed by RequestID) rather than
    // rebuilt with innerHTML on every push. Wholesale rebuilds recreate the
    // spinner and progress-fill DOM nodes, restarting their CSS animations; with
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

    // Which failures can be retried: a failed script still in the catalog, or a
    // failed integrated-device event (see lib/execution-panel).
    const knownScriptIDs = new Set(
      (Array.isArray(ScriptList) ? ScriptList : []).map((Script) => String(Script.ID))
    );
    RetryableExecutionIDs = renderExecutions
      .filter((Request) => IsRetryableExecution(Request, knownScriptIDs))
      .map((Request) => String(Request.RequestID));
    const retryAllButton = document.querySelector<HTMLElement>('#EXECUTION_TOAST [data-retry-all]');
    if (retryAllButton) {
      // A single failure has its own row button; the header one is for several.
      const ShowAll = RetryableExecutionIDs.length > 1;
      retryAllButton.classList.toggle('d-none', !ShowAll);
      const Label = GetRetryAllLabel(RetryableExecutionIDs.length);
      const LabelEl = retryAllButton.querySelector<HTMLElement>('.exec-retry-all-label');
      if (LabelEl && LabelEl.textContent !== Label) LabelEl.textContent = Label;
    }

    PanelExecutionsByID = new Map(
      renderExecutions.map((Request) => [String(Request.RequestID), Request])
    );
    // The execution a console is showing may have been cleared from the list
    // (a new batch, or replaced by a retry); the console says so itself.

    // Completed rows leave the list for the collapsed section at the top.
    const completedCount = CountCompletedExecutions(renderExecutions);
    const completedBody =
      completedCount > 0
        ? EnsureCompletedSection(listEl, completedCount, renderExecutions.length)
        : null;
    if (completedBody) desiredKeys.add(COMPLETED_SECTION_KEY);

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
      const reportedProgress = GetReportedProgress(Request);

      // Classify the execution into one visual state that drives the row's
      // background progress fill, the right-side indicator, (on failure) the
      // inline error, and where the row lives. Once the client reports the
      // process has spawned (progress reaches the Running stage), the row gets a
      // spinner; StatusText from that point is live console output, so the
      // spinner keys off progress, not text.
      const rawStatusText = Request.StatusText ? String(Request.StatusText).trim() : '';
      const state = GetExecutionVisualState(Request);
      const container = state === 'completed' && completedBody ? completedBody : listEl;
      const retryable = state === 'failed' && RetryableExecutionIDs.includes(key);
      // The indicator is rebuilt only when this changes (keeps the spinner alive).
      const indicatorKey = retryable ? 'failed-retry' : state;
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
        indicatorHtml = `<span class="exec-btn-icon exec-success" role="img" aria-label="Completed"><i class="bi bi-check-circle"></i></span>`;
      } else if (state === 'failed') {
        const Retry = retryable
          ? `<button type="button" class="exec-btn-icon exec-retry" data-retry-request="${Safe(key)}" title="Retry" aria-label="Retry on ${Safe(fullClientName)}"><i class="bi bi-arrow-clockwise"></i></button>`
          : '';
        indicatorHtml = `${Retry}<span class="exec-btn-icon exec-fail" role="img" aria-label="Failed"><i class="bi bi-exclamation-triangle"></i></span>`;
      } else if (state === 'running') {
        indicatorHtml = `<span class="exec-spinner" role="img" aria-label="Running"></span>`;
      } else {
        indicatorHtml = `<span class="exec-btn-icon exec-queued" role="img" aria-label="Queued"><i class="bi bi-hourglass-split"></i></span>`;
      }

      // Inline status/error text (sits on the same row, never a block below).
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
        inlineText = isConsole ? truncateExecutionLabel(rawStatusText, 64) : 'Running...';
        inlineTitle = rawStatusText;
      } else if (state === 'pending') {
        inlineClass = 'exec-inline exec-inline-stage';
        inlineText = rawStatusText && rawStatusText !== 'Pending' ? rawStatusText : 'Queued';
        inlineTitle = '';
      }

      // --- upsert the row ------------------------------------------------------
      // Looked up by RequestID in a Map rather than a selector query per row,
      // which made every push quadratic in the number of rows.
      let Row = ExecutionRows.get(key);
      if (Row && !listEl.contains(Row.El)) {
        ExecutionRows.delete(key);
        Row = undefined;
      }
      if (!Row) {
        const el = document.createElement('div');
        el.className = `exec-item state-${state}`;
        el.setAttribute('data-request-id', key);
        el.dataset.state = state;
        el.dataset.indicator = indicatorKey;
        el.style.setProperty('--exec-progress-scale', String(fillPercent / 100));
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
						<button type="button" class="exec-btn-icon exec-console-btn" data-console-request="${Safe(key)}" title="View console" aria-label="View console for ${Safe(fullClientName)}"><i class="bi bi-terminal"></i></button>
						<span class="exec-time"></span>
						<div class="exec-actions">${indicatorHtml}</div>
					</div>
				</div>`;
        container.appendChild(el);
        Row = {
          El: el,
          Actions: el.querySelector<HTMLElement>('.exec-actions'),
          Time: el.querySelector<HTMLElement>('.exec-time'),
          Inline: el.querySelector<HTMLElement>('[data-inline]'),
          Progress: String(fillPercent / 100),
        };
        ExecutionRows.set(key, Row);
      }

      // Volatile updates only: the .exec-fill and spinner nodes are never replaced
      // unless the state changes, so their animations run uninterrupted. The
      // fill is a transform (scaleX), so a progress step never relayouts.
      const el = Row.El;
      // A row that just completed moves into the completed section (appended,
      // so the section lists rows in the order they finished).
      if (el.parentElement !== container) container.appendChild(el);
      const Progress = String(fillPercent / 100);
      if (Row.Progress !== Progress) {
        Row.Progress = Progress;
        el.style.setProperty('--exec-progress-scale', Progress);
      }
      if (el.dataset.state !== state) {
        el.classList.remove('state-pending', 'state-running', 'state-completed', 'state-failed');
        el.classList.add(`state-${state}`);
        el.dataset.state = state;
      }
      if (el.dataset.indicator !== indicatorKey) {
        if (Row.Actions) Row.Actions.innerHTML = indicatorHtml;
        el.dataset.indicator = indicatorKey;
      }
      const timeEl = Row.Time;
      if (timeEl) {
        if (timeEl.innerHTML !== timeBadge) timeEl.innerHTML = timeBadge;
        timeEl.style.display = timeBadge ? '' : 'none';
      }
      const inlineEl = Row.Inline;
      if (inlineEl) {
        const nextClass = `exec-inline-slot${inlineClass ? ` ${inlineClass}` : ''}`;
        if (inlineEl.className !== nextClass) inlineEl.className = nextClass;
        if (inlineEl.textContent !== inlineText) inlineEl.textContent = inlineText;
        if (inlineEl.title !== inlineTitle) inlineEl.title = inlineTitle;
        inlineEl.style.display = inlineText ? '' : 'none';
      }
    }

    // Drop rows whose executions are no longer present (e.g. after ClearSettled),
    // including completed rows inside the collapsed section.
    const children = Array.from(listEl.children);
    if (completedBody) children.push(...Array.from(completedBody.children));
    for (const child of children) {
      const childKey =
        child.getAttribute('data-request-id') || child.getAttribute('data-exec-key') || '';
      if (!desiredKeys.has(childKey)) child.remove();
    }
    for (const Key of ExecutionRows.keys()) {
      if (!desiredKeys.has(Key)) ExecutionRows.delete(Key);
    }
    return;
  };
  ExecutionsHandler = HandleExecutions;
  window.API.UpdateScriptExecutions(HandleExecutions);

  window.API.SetScriptList(async (Scripts) => {
    setScriptList(Scripts);
    return;
  });

  window.API.SetFullClientList(async (Clients, Groups) => {
    // cache latest full lists
    const List = Array.isArray(Clients) ? Clients : [];
    set__LastClients(List);
    set__LastGroups(Array.isArray(Groups) ? Groups : []);
    // A copy of the array (callers may reorder it) holding the same objects.
    setAllClients(List.slice());
    ClientsByUUID = IndexClients(List);
    ScheduleFullRender();
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
  // Tag badges take the type line's place when the client carries any: both
  // elements are emitted and exactly one is display:none, so the tile keeps its
  // fixed height either way. See lib/tag-badge-view.
  const TagBadges = RenderTagBadgeRow(
    ResolveEntityTags(Tags, { ScopedID: String(UUID), GroupID: Client.GroupID ?? null })
  );
  return `<div ID="CLIENT_TILE_${UUID}" class="SHOWTRAK_PC ${TileStateClass} ${IdentifyingClass} ${
    UUID && Selected.includes(UUID) ? 'SELECTED' : ''
  }" data-uuid="${UUID}" data-flip-key="client:${UUID}" draggable="${AppMode === 'EDIT' ? 'true' : 'false'}">
				<button type="button" class="CLIENT_TILE_COG" aria-label="Edit Client" title="Edit Client">
					<i class="bi bi-gear"></i>
				</button>
				<label class="text-sm ${TagBadges ? 'd-none' : ''}" data-type="Hostname">
        ${Safe(HostnameVersionLabel)}
					</label>
				${TagBadges}
				<h5 class="mb-0" data-type="Nickname">
				${Nickname && Nickname.length ? Safe(Nickname) : Safe(Hostname)}
				</h5>
        <span class="CLIENT_TILE_COMPACT_STATUS" data-type="COMPACT_ONLINE_STATUS">${Safe(CompactStatusLabel)}</span>
				<small class="text-sm text-light" data-type="IP">
					${IP ? Safe(IP) : 'Unknown IP'}
				</small>
        <div class="SHOWTRAK_PC_STATUS ${Online && !Degraded ? 'd-grid' : 'd-none'} gap-2" data-type="INDICATOR_ONLINE">
					<div class="progress">
						<div data-type="CPU" class="progress-bar bg-white" role="progressbar" style="transform: scaleX(0);"></div>
					</div>
					<div class="progress">
						<div data-type="RAM" class="progress-bar bg-white" role="progressbar" style="transform: scaleX(0);"></div>
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
        ${RenderListRowCells(String(UUID), CompactStatusLabel)}
			</div>`;
}

// --- Live tile updates ---------------------------------------------------------
//
// A tile is patched in place on every live change of its client (the patches
// are applied in frame-sized batches, see osc-feeds). The elements it touches
// are found once per rendered tile and kept here, and every value written is
// remembered, so an update that changes nothing costs a few comparisons rather
// than a dozen child-selector scans and text rewrites.
interface ClientTileRefs {
  Tile: HTMLElement;
  Hostname: HTMLElement | null;
  Nickname: HTMLElement | null;
  IP: HTMLElement | null;
  Compact: HTMLElement | null;
  ListState: HTMLElement | null;
  IndicatorOnline: HTMLElement | null;
  IndicatorOffline: HTMLElement | null;
  IndicatorDegraded: HTMLElement | null;
  DegradedWarning: HTMLElement | null;
  Cpu: HTMLElement | null;
  Ram: HTMLElement | null;
  OfflineSince: HTMLElement | null;
  // What was last written to each slot by this module.
  Written: Map<string, string>;
}

const TileRefs = new Map<string, ClientTileRefs>();

function ChildByType(Parent: Element | null, Type: string): HTMLElement | null {
  if (!Parent) return null;
  const Children = Parent.children;
  for (let Index = 0; Index < Children.length; Index++) {
    const Child = Children[Index]!;
    if (Child.getAttribute('data-type') === Type) return Child as HTMLElement;
  }
  return null;
}

function ResolveTileRefs(UUID: string): ClientTileRefs | null {
  const Cached = TileRefs.get(UUID);
  if (Cached && Cached.Tile.isConnected) return Cached;
  const Tile = document.getElementById(`CLIENT_TILE_${UUID}`);
  if (!Tile) {
    TileRefs.delete(UUID);
    return null;
  }
  const IndicatorOnline = ChildByType(Tile, 'INDICATOR_ONLINE');
  const IndicatorOffline = ChildByType(Tile, 'INDICATOR_OFFLINE');
  const IndicatorDegraded = ChildByType(Tile, 'INDICATOR_DEGRADED');
  const Bar = (Type: string): HTMLElement | null =>
    IndicatorOnline
      ? IndicatorOnline.querySelector<HTMLElement>(`.progress > [data-type="${Type}"]`)
      : null;
  const Refs: ClientTileRefs = {
    Tile,
    Hostname: ChildByType(Tile, 'Hostname'),
    Nickname: ChildByType(Tile, 'Nickname'),
    IP: ChildByType(Tile, 'IP'),
    Compact: ChildByType(Tile, 'COMPACT_ONLINE_STATUS'),
    ListState: ChildByType(Tile, 'LIST_STATE'),
    IndicatorOnline,
    IndicatorOffline,
    IndicatorDegraded,
    DegradedWarning: ChildByType(IndicatorDegraded, 'DEGRADED_WARNING'),
    Cpu: Bar('CPU'),
    Ram: Bar('RAM'),
    OfflineSince: ChildByType(IndicatorOffline, 'OFFLINE_SINCE'),
    Written: new Map(),
  };
  TileRefs.set(UUID, Refs);
  return Refs;
}

// Whether a slot needs writing: false when it already holds what this module
// last wrote there. Records the new value.
function Changed(Refs: ClientTileRefs, Slot: string, Value: string): boolean {
  if (Refs.Written.get(Slot) === Value) return false;
  Refs.Written.set(Slot, Value);
  return true;
}

function SetTileText(Refs: ClientTileRefs, Slot: string, El: HTMLElement | null, Text: string) {
  if (!El || !Changed(Refs, Slot, Text)) return;
  if (El.textContent !== Text) El.textContent = Text;
}

// See VitalsBarScale (lib/client-list-layout).
function SetVitalsBar(
  Refs: ClientTileRefs,
  Slot: string,
  Bar: HTMLElement | null,
  Reading: { UsagePercentage?: unknown } | null | undefined
): void {
  const Scale = VitalsBarScale(Reading);
  // An empty value would REMOVE the inline transform and show a full bar.
  if (!Bar || Scale === null || !Changed(Refs, Slot, Scale)) return;
  Bar.style.transform = Scale;
}

// Show or hide one indicator panel.
function SetIndicator(El: HTMLElement | null, Visible: boolean): void {
  if (!El) return;
  El.classList.toggle('d-grid', Visible);
  El.classList.toggle('d-none', !Visible);
}

// Patch an already-rendered client tile in place from a live client (called by
// the osc-feeds flush). Counterpart to UpdateMonitoringTargetTile /
// UpdateDummyClientTile. Everything is resolved within the tile itself: a
// client UUID also appears on the Update Manager's rows, which that modal
// re-renders from its own state.
export function UpdateClientTile(Data: ClientView): void {
  const { UUID, Nickname, Hostname, IP, Online, Vitals } = Data;

  const Refs = ResolveTileRefs(String(UUID));
  // No tile rendered for this client (filtered out, or a push that arrived
  // mid-rebuild). Every operation below would have been a no-op anyway.
  if (!Refs) return;

  const Degraded = !!Data.Degraded;
  const DegradedWarning =
    Array.isArray(Data.DegradedWarnings) && Data.DegradedWarnings.length
      ? String(Data.DegradedWarnings[0])
      : 'Missing USB Device';

  // Mirrors GetClientTileStateClass: a client inside its start-up window is
  // greyed rather than green, because a guard is still outstanding.
  const Initialising = !!Data.Initialising && !!Online && !Degraded;
  const Identifying = !!Data.Identifying;
  const HasVitals = !!(Online && Vitals);

  if (
    Changed(Refs, 'state', `${!!Online}|${Degraded}|${Initialising}|${Identifying}|${HasVitals}`)
  ) {
    const Tile = Refs.Tile;
    Tile.classList.toggle('ONLINE', !!Online && !Degraded && !Initialising);
    Tile.classList.toggle('DEGRADED', Degraded);
    Tile.classList.toggle('IDLE', Initialising);
    Tile.classList.toggle('IDENTIFYING', Identifying);
    if (HasVitals) {
      SetIndicator(Refs.IndicatorOffline, false);
      SetIndicator(Refs.IndicatorDegraded, Degraded);
      SetIndicator(Refs.IndicatorOnline, !Degraded);
    } else {
      SetIndicator(Refs.IndicatorOffline, true);
      SetIndicator(Refs.IndicatorOnline, false);
      SetIndicator(Refs.IndicatorDegraded, false);
    }
  }

  SetTileText(Refs, 'warning', Refs.DegradedWarning, DegradedWarning);
  SetTileText(Refs, 'hostname', Refs.Hostname, FormatClientHostnameVersionLabel(Data));
  SetTileText(
    Refs,
    'nickname',
    Refs.Nickname,
    (Nickname && Nickname.length ? Nickname : Hostname) || ''
  );
  SetTileText(Refs, 'ip', Refs.IP, IP ? IP : 'Unknown IP');

  const CompactLabel = GetClientCompactStatusLabel(Data);
  if (Refs.Compact && Changed(Refs, 'compact', CompactLabel)) {
    if (Refs.Compact.textContent !== CompactLabel) Refs.Compact.textContent = CompactLabel;
    Refs.Compact.classList.remove('d-none');
  }
  // The list view's state cell (as list-view's UpdateListRowState writes it).
  SetTileText(Refs, 'list-state', Refs.ListState, CompactLabel);

  if (HasVitals && Vitals) {
    SetVitalsBar(Refs, 'cpu', Refs.Cpu, Vitals.CPU);
    SetVitalsBar(Refs, 'ram', Refs.Ram, Vitals.Ram);
  }

  // The offline counter reads this, and only while the client is offline; it
  // moves with every heartbeat, so it is left alone while online.
  if (!Online) {
    const LastSeen = String(Data.LastSeen ?? '');
    if (Refs.OfflineSince && Changed(Refs, 'offline-since', LastSeen)) {
      Refs.OfflineSince.setAttribute('data-offlinesince', LastSeen);
    }
    UpdateOfflineIndicators(Refs.Tile);
  }
}

export function RenderFullClientAndMonitorList() {
  // This render satisfies any that was scheduled.
  FullRenderPending = false;
  const Clients = Array.isArray(__LastClients) ? __LastClients.slice() : [];
  if (typeof document !== 'undefined' && document.body) {
    document.body.classList.toggle('st-static-bars', !ShouldAnimateBars(Clients.length));
  }
  const Monitors = Array.isArray(MonitoringTargets) ? MonitoringTargets.slice() : [];
  const Dummies = Array.isArray(DummyClients) ? DummyClients.slice() : [];
  const Kiosks = Array.isArray(FreeKioskTerminals) ? FreeKioskTerminals.slice() : [];
  let Filler = '';

  // Appends the synthetic "No Group" bucket and pins it to the bottom.
  const Groups = BuildGroupRenderOrder(__LastGroups);
  const ColumnCount = GetGroupColumnCount();

  if (ShouldShowWelcomePanel(Groups.length, Clients, Monitors, Dummies, Kiosks)) {
    // The first list push can land before init has fetched the config; render
    // without the version rather than throwing out of the whole list render.
    const AppVersion = Config && Config.Application ? Config.Application.Version : null;
    Filler += `<div class="bg-ghost rounded m-3 mb-0 d-grid gap-0 gap-3 p-3">
            <h5 class="text-light mb-0">
                Welcome to ShowTrak Server${AppVersion ? ` v${Safe(AppVersion)}` : ''}
            </h5>
            <p class="text-light mb-0">
                You do not have any checks or clients configured yet. Discover clients on the network or set up monitoring checks.
            </p>
        </div>`;
  }

  // Groups are laid out on a fixed column grid. Full-width groups span every
  // column; the rest span their ColumnSpan (clamped to ColumnCount). Grid
  // auto-flow (non-dense) preserves strict group order and wraps a group onto a
  // new row, leaving a blank slot, when it cannot fit in the columns remaining
  // on the current row.
  // The list view's column headings: one row for the whole list, sticky.
  Filler += RenderListTableHeader();

  Filler += `<div class="group-column-grid" style="grid-template-columns: repeat(${ColumnCount}, minmax(0, 1fr));">`;

  for (const Group of Groups) {
    const { GroupID, Title } = Group;
    const FullGroupTitle = Title == null ? '' : String(Title);
    const GroupLabel = TruncateGroupLabel(FullGroupTitle);
    const GroupSpan = GetGroupSpan(Group, ColumnCount);
    const GroupTint = GetGroupTintHex(Group);
    const TintClass = GroupTint ? ' group-tinted' : '';
    const TintStyle = GroupTint ? ` style="--group-tint: ${Safe(GroupTint)};"` : '';
    const Members = SelectGroupMembers(GroupID, Clients, Monitors, Dummies, Kiosks);

    GroupUUIDCache.set(
      `${GroupID}`,
      Members.Clients.map((c) => c.UUID)
    );

    // Selection cache mirrors the tile data-uuid values so the group-title
    // button toggles every client type in the group (ShowTrak clients plus
    // prefixed monitor:/dummy:/kiosk: tiles), not just ShowTrak clients.
    GroupSelectableUUIDCache.set(`${GroupID}`, BuildGroupSelectableIDs(Members));

    if (!ShouldRenderGroup(GroupID, Members)) continue;

    // Merged and weight-ordered so a unified ordering set by drag/drop across
    // clients, monitors, dummies and FreeKiosk terminals is preserved.
    const Merged = BuildMergedTiles(Members);

    Filler += `<div class="d-flex justify-content-start group-column-item" data-flip-key="group:${GroupID}" style="grid-column: span ${GroupSpan};">
    <div class="GROUP_TITLE_CLICKABLE m-3 me-0 mb-0 rounded" data-groupid="${GroupID}" title="${Safe(FullGroupTitle)}" aria-label="${Safe(FullGroupTitle)}">
			<div class="d-flex align-items-center text-center h-100">
				<span class="GROUP_TITLE py-2">
          ${Safe(GroupLabel)}
				</span>
				${RenderListGroupHeaderCells()}
			</div>
		</div>
	<div class="bg-ghost rounded m-3 mb-0 d-flex flex-wrap justify-content-start align-items-center p-3 gap-3 w-100 group-drop-zone${TintClass}"${TintStyle} data-groupid="${GroupID}">`;

    if (Merged.length == 0) {
      Filler += `<div class="SHOWTRAK_PC_PLACEHOLDER w-100 p-3">
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
        } else if (Item.kind === 'freekiosk') {
          Filler += RenderFreeKioskTile(Item.data);
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
  // The list's search is put back on the fresh rows before anything measures
  // them, so the reflow animation slides rows to where they actually end up.
  const Fill = () => {
    $('#APPLICATION_CONTENT').html(Filler);
    // Every tile is new; the cached element references are all stale.
    TileRefs.clear();
    try {
      ApplyListSearch();
    } catch (e) {
      HandleNonFatalError('RenderFullClientAndMonitorList:ApplyListSearch', e);
    }
  };
  if (
    ContentRoot &&
    window.ShowTrakFlip &&
    typeof window.ShowTrakFlip.AnimateReflow === 'function'
  ) {
    window.ShowTrakFlip.AnimateReflow(ContentRoot, Fill);
  } else {
    Fill();
  }
  // A row whose history was cached before this render already carries it; this
  // picks up any that were added or changed since.
  try {
    SyncListView();
  } catch (e) {
    HandleNonFatalError('RenderFullClientAndMonitorList:SyncListView', e);
  }
  // Monitor tile widgets: fill the fresh rows from what has already streamed, and
  // open or close the tile meter stream for the monitors now on the dashboard.
  try {
    SyncTileWidgets();
  } catch (e) {
    HandleNonFatalError('RenderFullClientAndMonitorList:SyncTileWidgets', e);
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
          ${RenderListRowCells(UUID, 'Discovered', { History: false })}
        </div>`;
    }
    html += `  </div>`;
    html += `</div>`;
    return html;
  } catch (e) {
    return '<div id="PENDING_ADOPTION_SECTION"></div>';
  }
}
