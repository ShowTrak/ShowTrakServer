// Phase 7 decomposition: extracted modules re-exported so the ~14 importers of
// this (now barrel) file keep working. The global bootstrap that used to live
// here (the document-ready IIFE and Init()) is in ./init.ts, called explicitly
// by main.ts — importing this file has no side effects.
export { UpdateOfflineIndicators } from './offline-indicators';
export { OpenClientInfo, RenderClientInfoDetails } from './client-info-modal';
// Selection primitives live in the leaf module ./selection; re-exported for
// the consumers that still import them from this barrel.
export {
  ClearSelection,
  Deselect,
  IsSelected,
  Select,
  SelectAll,
  SelectByGroup,
  ToggleSelection,
  UpdateSelectionCount,
} from './selection';
import { AllClients, IsIntegratedClientEntity, PendingAdoption } from './01-state';
import { HandleNonFatalError, Safe } from './04-utils';
import { RenderFullClientAndMonitorList } from './06-client-list';
import { DismissAlert, iconForAlert } from './10-alerts-tray';
export async function Wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Options accepted by {@link showAlertStyleToast}. */
interface AlertStyleToastOptions {
  id?: string | null;
  title?: unknown;
  message?: unknown;
  type?: string;
  duration?: number;
  linkAlert?: boolean;
  iconHtml?: string | null;
}

// --- Alert-style Toasts (Top Center) ---
export function ensureToastHost() {
  let host = document.getElementById('ALERTS_TOAST_HOST');
  if (!host) {
    host = document.createElement('div');
    host.id = 'ALERTS_TOAST_HOST';
    document.body.appendChild(host);
  }
  return host;
}

export function iconForType(type: unknown) {
  const t = String(type || 'info').toLowerCase();
  if (t === 'success') return '<i class="bi bi-check-circle-fill"></i>';
  if (t === 'warning') return '<i class="bi bi-exclamation-triangle-fill"></i>';
  if (t === 'error') return '<i class="bi bi-x-circle-fill"></i>';
  return '<i class="bi bi-info-circle-fill"></i>';
}

export function RemoveAlertToastById(id: unknown) {
  try {
    const host = document.getElementById('ALERTS_TOAST_HOST');
    if (!host) return;
    const node = host.querySelector(`.alert-toast[data-alert-id="${CSS.escape(String(id))}"]`);
    if (node) node.remove();
  } catch (e) {
    HandleNonFatalError('RemoveAlertToastById', e);
  }
}

export function showAlertStyleToast({
  id = null,
  title = '',
  message = '',
  type = 'info',
  duration = 5000,
  linkAlert = false,
  iconHtml = null,
}: AlertStyleToastOptions) {
  const host = ensureToastHost();
  const el = document.createElement('div');
  el.className = 'alert-item alert-toast';
  el.setAttribute('data-severity', String(type || 'info').toLowerCase());
  if (id && linkAlert) el.setAttribute('data-alert-id', id);
  const hasMessage = Boolean(message && String(message).trim().length > 0);
  if (!hasMessage) el.classList.add('single-line');
  el.innerHTML = `
		<div class="alert-icon">${iconHtml ? iconHtml : linkAlert ? iconForAlert({ type }) : iconForType(type)}</div>
		<div class="alert-content">
			<div><strong>${Safe(title || 'Notice')}</strong></div>
			${message ? `<div class="alert-meta">${Safe(message)}</div>` : ''}
		</div>
		<div class="alert-dismiss">
			<button class="btn-dismiss" title="Dismiss" aria-label="Dismiss">✕</button>
		</div>`;
  host.appendChild(el);

  // Dismiss interaction
  const btn = el.querySelector('.btn-dismiss');
  if (btn)
    btn.addEventListener('click', () => {
      el.remove();
      if (linkAlert && id) {
        // Sync with alerts tray
        DismissAlert(id);
      }
    });

  // Auto-remove after duration with hover pause
  if (duration && duration > 0) {
    let remaining = duration;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let lastStart = Date.now();
    const clear = () => {
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
    };
    const tick = () => {
      clear();
      lastStart = Date.now();
      timerId = setTimeout(() => {
        try {
          el.remove();
        } catch (e) {
          HandleNonFatalError('showAlertStyleToast:AutoRemove', e);
        }
      }, remaining);
    };
    const onMouseEnter = () => {
      // pause timer
      remaining -= Date.now() - lastStart;
      if (remaining < 0) remaining = 0;
      clear();
    };
    const onMouseLeave = () => {
      if (remaining === 0) {
        try {
          el.remove();
        } catch (e) {
          HandleNonFatalError('showAlertStyleToast:MouseLeaveRemove', e);
        }
      } else {
        tick();
      }
    };
    el.addEventListener('mouseenter', onMouseEnter);
    el.addEventListener('mouseleave', onMouseLeave);
    // start timer
    tick();
  }
}

export async function Notify(Message: unknown, Type = 'info', Duration = 5000) {
  showAlertStyleToast({
    title: Message,
    message: '',
    type: Type,
    duration: Duration,
    linkAlert: false,
  });
}

export async function ConfirmationDialog(Message: unknown) {
  return new Promise((resolve) => {
    // Create or reuse toast container
    const existing = document.getElementById('SHOWTRAK_CONFIRM_TOAST');
    if (existing) {
      try {
        existing.remove();
      } catch (err) {
        HandleNonFatalError('SelectionInit:NonFatal', err);
      }
    }

    const toastHtml = `
			<div id="SHOWTRAK_CONFIRM_TOAST" role="dialog" aria-live="assertive" aria-modal="true" class="confirm-toast no-drag">
				<div class="confirm-toast-body">
					<div class="confirm-toast-msg">${Safe(Message)}</div>
					<div class="confirm-toast-actions">
						<button type="button" class="btn btn-sm btn-secondary" id="CONFIRM_TOAST_CANCEL" tabindex="0">Cancel</button>
						<button type="button" class="btn btn-sm btn-danger" id="CONFIRM_TOAST_CONFIRM" tabindex="0">Confirm</button>
					</div>
				</div>
			</div>`;

    $('body').append(toastHtml);
    const $toast = $('#SHOWTRAK_CONFIRM_TOAST');
    const $btnCancel = $('#CONFIRM_TOAST_CANCEL');
    const $btnConfirm = $('#CONFIRM_TOAST_CONFIRM');

    window.__SHOWTRAK_CONFIRM_ACTIVE = true;
    UpdateIdentifyStatusBanner();

    const cleanup = () => {
      $(document).off('keydown.confirmToast');
      $btnCancel.off('click.confirmToast');
      $btnConfirm.off('click.confirmToast');
      try {
        $toast.remove();
      } catch (err) {
        HandleNonFatalError('SelectionInit:NonFatal', err);
      }
      window.__SHOWTRAK_CONFIRM_ACTIVE = false;
      UpdateIdentifyStatusBanner();
    };

    $btnCancel.on('click.confirmToast', () => {
      cleanup();
      resolve(false);
    });
    $btnConfirm.on('click.confirmToast', () => {
      cleanup();
      resolve(true);
    });

    // Keyboard controls while toast is visible
    $(document).on('keydown.confirmToast', function (e) {
      // If context menu is open/visible, ignore Enter/Space here
      const $ctx = $('#SHOWTRAK_CONTEXT_MENU');
      if ($ctx && $ctx.is(':visible')) {
        return;
      }
      const key = e.key;
      if (key === 'Enter' || key === ' ') {
        e.preventDefault();
        const active = document.activeElement;
        if (active === $btnConfirm.get(0)) return $btnConfirm.trigger('click');
        if (active === $btnCancel.get(0)) return $btnCancel.trigger('click');
        // default to confirm if focus is elsewhere
        return $btnConfirm.trigger('click');
      }
      if (key === 'Escape') {
        e.preventDefault();
        return $btnCancel.trigger('click');
      }
      if (key === 'ArrowLeft') {
        e.preventDefault();
        return $btnCancel.trigger('focus');
      }
      if (key === 'ArrowRight') {
        e.preventDefault();
        return $btnConfirm.trigger('focus');
      }
    });

    // Default focus on Confirm so Enter activates it naturally
    setTimeout(() => {
      try {
        $btnConfirm.trigger('focus');
      } catch (err) {
        HandleNonFatalError('SelectionInit:NonFatal', err);
      }
    }, 0);
  });
}

export const MINIMUM_IDENTIFY_VERSION = [3, 7, 0];
export const MINIMUM_DISPLAY_MONITORING_VERSION = [3, 8, 0];

export function ParseSemverTuple(value: unknown) {
  const Match = String(value || '')
    .trim()
    .match(/(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(?:[^0-9]|$)/);
  if (!Match) return null;
  return [Number(Match[1]), Number(Match[2]), Number(Match[3])];
}

export function IsVersionAtLeast(value: unknown, minimumTuple: number[]) {
  const Parsed = ParseSemverTuple(value);
  if (!Parsed) return false;
  for (let i = 0; i < minimumTuple.length; i++) {
    const Current = Parsed[i] || 0;
    const Minimum = minimumTuple[i] || 0;
    if (Current > Minimum) return true;
    if (Current < Minimum) return false;
  }
  return true;
}

export function GetIdentifyTargetByUUID(UUID: string) {
  const AdoptedTarget = Array.isArray(AllClients)
    ? AllClients.find((c) => c && c.UUID === UUID)
    : null;
  const PendingTarget = Array.isArray(PendingAdoption)
    ? PendingAdoption.find((d) => d && d.UUID === UUID)
    : null;

  if (AdoptedTarget) {
    const Eligible =
      !IsIntegratedClientEntity(AdoptedTarget) &&
      !!AdoptedTarget.Online &&
      IsVersionAtLeast(AdoptedTarget.Version, MINIMUM_IDENTIFY_VERSION);
    return {
      UUID,
      Eligible,
      IsIdentifying: !!AdoptedTarget.Identifying,
    };
  }

  if (PendingTarget) {
    return {
      UUID,
      Eligible: IsVersionAtLeast(PendingTarget.Version, MINIMUM_IDENTIFY_VERSION),
      IsIdentifying: !!PendingTarget.Identifying,
    };
  }

  return {
    UUID,
    Eligible: false,
    IsIdentifying: false,
  };
}

export function GetIdentifyingUUIDs() {
  // Primary source: live rendered tiles. This stays accurate even when an
  // incremental push updates classes before list caches are reconciled.
  const FromDom = new Set<string>();
  try {
    $('.SHOWTRAK_PC.IDENTIFYING[data-uuid]').each(function () {
      const UUID = String($(this).attr('data-uuid') || '').trim();
      if (UUID) FromDom.add(UUID);
    });
  } catch (err) {
    HandleNonFatalError('SelectionInit:GetIdentifyingUUIDs', err);
  }
  if (FromDom.size > 0) return Array.from(FromDom);

  // Fallback source: cached entity lists.
  const Identifying = new Set<string>();
  (Array.isArray(AllClients) ? AllClients : []).forEach((Client) => {
    if (Client && Client.UUID && Client.Identifying) Identifying.add(Client.UUID);
  });
  (Array.isArray(PendingAdoption) ? PendingAdoption : []).forEach((Device) => {
    if (Device && Device.UUID && Device.Identifying) Identifying.add(Device.UUID);
  });
  return Array.from(Identifying);
}

export function ApplyIdentifyStateLocally(UUIDs: string[], Identifying: boolean) {
  const Unique = new Set((Array.isArray(UUIDs) ? UUIDs : []).filter(Boolean));
  const Next = !!Identifying;
  if (!Unique.size) return;

  (Array.isArray(AllClients) ? AllClients : []).forEach((Client) => {
    if (!Client || !Client.UUID) return;
    if (!Unique.has(Client.UUID)) return;
    Client.Identifying = Next;
  });

  (Array.isArray(PendingAdoption) ? PendingAdoption : []).forEach((Device) => {
    if (!Device || !Device.UUID) return;
    if (!Unique.has(Device.UUID)) return;
    Device.Identifying = Next;
  });

  RenderFullClientAndMonitorList();
  UpdateIdentifyStatusBanner();
}

export async function StopIdentifyingForUUIDs(UUIDs: string[]) {
  const List = Array.from(new Set((Array.isArray(UUIDs) ? UUIDs : []).filter(Boolean)));
  if (!List.length) return { succeeded: [], failed: [] };
  const Results = await Promise.all(List.map((UUID) => window.API.StopIdentifyingClient(UUID)));
  const Succeeded: string[] = [];
  const Failed: Array<{ UUID: string; Error: unknown }> = [];
  Results.forEach((Result, Index) => {
    const Err: unknown = Array.isArray(Result) ? Result[0] : null;
    if (Err) {
      Failed.push({ UUID: List[Index], Error: Err });
    } else {
      Succeeded.push(List[Index]);
    }
  });
  if (Succeeded.length) ApplyIdentifyStateLocally(Succeeded, false);
  // If server says a target is missing, clear it locally to avoid a stuck
  // banner caused by stale UI state.
  const Missing = Failed.filter((Entry) => /not found/i.test(String(Entry.Error || ''))).map(
    (Entry) => Entry.UUID
  );
  if (Missing.length) ApplyIdentifyStateLocally(Missing, false);
  const Errors = Failed.map((Entry) => Entry.Error).filter(Boolean);
  if (Errors.length) {
    Notify(String(Errors[0]), 'danger');
  }
  return { succeeded: Succeeded, failed: Failed };
}

export function UpdateIdentifyStatusBanner() {
  const $Banner = $('#IDENTIFY_STATUS_BANNER');
  const $Text = $('#IDENTIFY_STATUS_TEXT');
  if (!$Banner.length || !$Text.length) return;
  const IdentifyingUUIDs = GetIdentifyingUUIDs();
  const Count = IdentifyingUUIDs.length;
  if (!Count) {
    $Banner.addClass('d-none');
    return;
  }
  $Text.text(`You are currently identifying ${Count} ${Count === 1 ? 'client' : 'clients'}`);
  const hasConfirmToast = $('#SHOWTRAK_CONFIRM_TOAST').length > 0;
  $Banner.toggleClass('stacked-above-confirm', hasConfirmToast);
  $Banner.removeClass('d-none');
}



export function ShowExecutionToast(title?: string) {
  const $existing = $('#EXECUTION_TOAST');
  if ($existing.length) {
    $existing.addClass('show');
    if (title) {
      $existing.find('.exec-toast-header .exec-title').text(title);
    }
    // Bind outside click to dismiss when reused
    enableExecToastOutsideClose();
    return;
  }
  const safeTitle = title ? Safe(title) : 'Script Executions';
  const html = `
	<div id="EXECUTION_TOAST" class="exec-toast show no-drag" role="region" aria-live="polite" aria-label="Script executions">
		<div class="exec-toast-header">
			<strong class="exec-title">${safeTitle}</strong>
			<button type="button" class="btn btn-sm btn-light exec-toast-close" aria-label="Close">✕</button>
		</div>
		<div id="SHOWTRAK_EXECUTION_LIST" class="exec-toast-body"></div>
	</div>`;
  $('body').append(html);
  $('.exec-toast-close').on('click', () => HideExecutionToast());
  // Bind outside click to dismiss on create
  enableExecToastOutsideClose();

  // No modal on click per requirements; ensure no handler is attached
  $(document).off('click.execInfo', '.exec-info-btn');
}

export function HideExecutionToast() {
  if (window.__ShowTrakExecutionAutoDismissTimer) {
    clearTimeout(window.__ShowTrakExecutionAutoDismissTimer);
    window.__ShowTrakExecutionAutoDismissTimer = null;
  }
  if (window.__ShowTrakDeploymentAutoDismissTimer) {
    clearTimeout(window.__ShowTrakDeploymentAutoDismissTimer);
    window.__ShowTrakDeploymentAutoDismissTimer = null;
  }
  const $t = $('#EXECUTION_TOAST');
  if ($t.length) {
    $t.removeClass('show');
    // Remove outside-click handler when closing
    $(document).off('mousedown.execToastOutside touchstart.execToastOutside');
    // keep in DOM for quick reopen; remove after short delay
    setTimeout(() => {
      try {
        $t.remove();
      } catch (err) {
        HandleNonFatalError('SelectionInit:NonFatal', err);
      }
    }, 150);
  }
}

// Enable click/touch outside toast to dismiss
export function enableExecToastOutsideClose() {
  $(document)
    .off('mousedown.execToastOutside touchstart.execToastOutside')
    .on('mousedown.execToastOutside touchstart.execToastOutside', function (e) {
      const $toast = $('#EXECUTION_TOAST');
      if (!$toast.length) {
        $(document).off('mousedown.execToastOutside touchstart.execToastOutside');
        return;
      }
      const $target = $(e.target);
      const inside = $target.closest('#EXECUTION_TOAST').length > 0;
      if (!inside) {
        HideExecutionToast();
      }
    });
}


