// Renderer toast/notification systems, co-located.
//
// There are three transient-UI surfaces with genuinely different lifecycles,
// kept as distinct entry points but unified here behind shared helpers
// (`iconForType`, the hover-pause auto-dismiss timer) rather than forced into a
// single component:
//   1. Alert-style toasts  — top-center, stack in a host, hover-pausable
//      auto-dismiss (`showAlertStyleToast` / `Notify`).
//   2. Confirmation dialog — single modal toast, promise-based, keyboard-driven
//      (`ConfirmationDialog`).
//   3. Execution toast     — persistent region holding a live execution list,
//      outside-click to dismiss (`ShowExecutionToast` / `HideExecutionToast`).
//
// Extracted verbatim from the old 14-selection-init god-module so that file can
// become a pure re-export barrel.
import { setConfirmDialogActive } from '../01-state';
import { HandleNonFatalError, Safe } from '../04-utils';
import { DismissAlert, iconForAlert } from '../10-alerts-tray';
import { UpdateIdentifyStatusBanner } from '../identify';

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

// --- Shared helpers ---------------------------------------------------------

export function iconForType(type: unknown) {
  const t = String(type || 'info').toLowerCase();
  if (t === 'success') return '<i class="bi bi-check-circle-fill"></i>';
  if (t === 'warning') return '<i class="bi bi-exclamation-triangle-fill"></i>';
  if (t === 'error') return '<i class="bi bi-x-circle-fill"></i>';
  return '<i class="bi bi-info-circle-fill"></i>';
}

// Auto-remove `el` after `duration` ms, pausing the countdown while the pointer
// hovers it. Shared by the alert-style toasts; no-op for duration <= 0.
function attachHoverPauseDismiss(el: HTMLElement, duration: number) {
  if (!duration || duration <= 0) return;
  let remaining = duration;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let lastStart = Date.now();
  const clear = () => {
    if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }
  };
  const remove = (context: string) => {
    try {
      el.remove();
    } catch (e) {
      HandleNonFatalError(context, e);
    }
  };
  const tick = () => {
    clear();
    lastStart = Date.now();
    timerId = setTimeout(() => remove('showAlertStyleToast:AutoRemove'), remaining);
  };
  el.addEventListener('mouseenter', () => {
    remaining -= Date.now() - lastStart;
    if (remaining < 0) remaining = 0;
    clear();
  });
  el.addEventListener('mouseleave', () => {
    if (remaining === 0) remove('showAlertStyleToast:MouseLeaveRemove');
    else tick();
  });
  tick();
}

// --- 1. Alert-style toasts (top center) -------------------------------------

export function ensureToastHost() {
  let host = document.getElementById('ALERTS_TOAST_HOST');
  if (!host) {
    host = document.createElement('div');
    host.id = 'ALERTS_TOAST_HOST';
    document.body.appendChild(host);
  }
  return host;
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
  attachHoverPauseDismiss(el, duration);
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

// --- 2. Confirmation dialog -------------------------------------------------

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

    setConfirmDialogActive(true);
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
      setConfirmDialogActive(false);
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

// --- 3. Execution toast -----------------------------------------------------

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
