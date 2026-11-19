// Renderer toast/notification systems, co-located.
//
// There are three transient-UI surfaces with genuinely different lifecycles,
// kept as distinct entry points but unified here behind shared helpers
// (`iconForType`, the hover-pause auto-dismiss timer) rather than forced into a
// single component:
//   1. Alert-style toasts:  top-center, stack in a host, hover-pausable
//      auto-dismiss (`showAlertStyleToast` / `Notify`).
//   2. Confirmation dialog: single modal toast, promise-based, keyboard-driven
//      (`ConfirmationDialog`), plus a centred red modal for critical actions
//      that defaults to Cancel (`CriticalConfirmationDialog`).
//   3. Execution toast:     persistent region holding a live execution list,
//      outside-click to dismiss (`ShowExecutionToast` / `HideExecutionToast`).
//
// Extracted verbatim from the old selection-init god-module so that file can
// become a pure re-export barrel.
import { setConfirmDialogActive } from '../state';
import { HandleNonFatalError, Safe, WithFullStop } from '../utils';
import { DismissAlert, iconForAlert } from '../alerts-tray';
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
  if (t === 'success') return '<i class="bi bi-check-circle"></i>';
  if (t === 'warning') return '<i class="bi bi-exclamation-triangle"></i>';
  if (t === 'error') return '<i class="bi bi-x-circle"></i>';
  return '<i class="bi bi-info-circle"></i>';
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

// Every toast reads as a sentence: dynamic messages (errors handed back by the
// server, labels joined at runtime) get the full stop literals carry already.
export async function Notify(Message: unknown, Type = 'info', Duration = 5000) {
  showAlertStyleToast({
    title: WithFullStop(Message),
    message: '',
    type: Type,
    duration: Duration,
    linkAlert: false,
  });
}

// --- 2. Confirmation dialog -------------------------------------------------

/** Options accepted by {@link ConfirmationDialog}. */
export interface ConfirmationDialogOptions {
  /**
   * The confirm button's label, naming the action in Title Case ("Delete Tag",
   * "Run Script"). Required so no dialog falls back to a vague "Confirm".
   */
  ConfirmLabel: string;
}

// The confirmation waiting for an answer, if any: only one at a time.
let ActiveConfirmation: { Finish: (Answer: boolean) => void } | null = null;

/**
 * Close a confirmation that is waiting, as if Cancel was chosen. Called when
 * whatever it was asked about goes away (every modal is closed for something
 * else), so a stale question can never be answered.
 */
export function CancelConfirmation(): void {
  ActiveConfirmation?.Finish(false);
}

/**
 * Ask a question with Cancel and a named confirm button. Resolves true or false.
 *
 * Keys go to the dialog's own buttons, as to any button: Enter or Space on the
 * focused one (Confirm, to start with), Tab and the arrow keys to move between
 * them, Escape to cancel. A key pressed anywhere else (typing in a field behind
 * the dialog) never answers it, and neither does a key held down from before
 * it opened: the old handler on `document` confirmed on Enter or Space wherever
 * the focus was. Inside an open modal the dialog is placed in that modal, which
 * is where Bootstrap keeps the focus, and closing the modal cancels it. Opening
 * a second dialog cancels the first (which used to stay live, so one Enter
 * answered both).
 */
export async function ConfirmationDialog(
  Message: unknown,
  Options: ConfirmationDialogOptions
): Promise<boolean> {
  CancelConfirmation();
  return new Promise<boolean>((resolve) => {
    const existing = document.getElementById('SHOWTRAK_CONFIRM_TOAST');
    if (existing) {
      try {
        existing.remove();
      } catch (err) {
        HandleNonFatalError('Toasts:NonFatal', err);
      }
    }

    const toastHtml = `
			<div id="SHOWTRAK_CONFIRM_TOAST" role="alertdialog" aria-modal="true" aria-labelledby="CONFIRM_TOAST_MESSAGE" class="confirm-toast no-drag">
				<div class="confirm-toast-body">
					<div class="confirm-toast-msg" id="CONFIRM_TOAST_MESSAGE">${Safe(Message)}</div>
					<div class="confirm-toast-actions">
						<button type="button" class="btn btn-sm btn-secondary" id="CONFIRM_TOAST_CANCEL">Cancel</button>
						<button type="button" class="btn btn-sm btn-danger" id="CONFIRM_TOAST_CONFIRM">${Safe(
              Options.ConfirmLabel
            )}</button>
					</div>
				</div>
			</div>`;

    // In the open modal, if there is one: Bootstrap pulls the focus back into
    // an open modal, so a dialog outside it could never hold the focus.
    const HostModal = document.querySelector<HTMLElement>('.modal.show');
    $(HostModal ?? document.body).append(toastHtml);
    const $toast = $('#SHOWTRAK_CONFIRM_TOAST');
    const $btnCancel = $('#CONFIRM_TOAST_CANCEL');
    const $btnConfirm = $('#CONFIRM_TOAST_CONFIRM');
    const Buttons = () => $toast.find('button').toArray() as HTMLElement[];
    const Previous = document.activeElement as HTMLElement | null;

    setConfirmDialogActive(true);
    UpdateIdentifyStatusBanner();

    let Done = false;
    const OnEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // An open context menu takes its own Escape.
      const $ctx = $('#SHOWTRAK_CONTEXT_MENU');
      if ($ctx.length && $ctx.is(':visible')) return;
      // Before the modal behind sees it: Escape cancels the question, not the modal.
      e.preventDefault();
      e.stopPropagation();
      Finish(false);
    };
    const Finish = (Answer: boolean) => {
      if (Done) return;
      Done = true;
      ActiveConfirmation = null;
      document.removeEventListener('keydown', OnEscape, true);
      if (HostModal) $(HostModal).off('hide.bs.modal.confirmToast');
      try {
        $toast.remove();
      } catch (err) {
        HandleNonFatalError('Toasts:NonFatal', err);
      }
      setConfirmDialogActive(false);
      UpdateIdentifyStatusBanner();
      // Back to where the focus was, if that is still on the page.
      if (Previous && Previous.isConnected) {
        try {
          Previous.focus();
        } catch {
          /* intentional: best-effort */
        }
      }
      resolve(Answer);
    };
    ActiveConfirmation = { Finish };

    $btnCancel.on('click', () => Finish(false));
    $btnConfirm.on('click', () => Finish(true));

    document.addEventListener('keydown', OnEscape, true);
    if (HostModal) $(HostModal).one('hide.bs.modal.confirmToast', () => Finish(false));

    $toast.on('keydown', (e) => {
      const Native = e.originalEvent as KeyboardEvent | undefined;
      // A key held down (from the button that opened the dialog) repeats into
      // it: never let a repeat answer it.
      if ((e.key === 'Enter' || e.key === ' ') && Native?.repeat) {
        e.preventDefault();
        return;
      }
      const List = Buttons();
      const Index = List.indexOf(document.activeElement as HTMLElement);
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const Step = e.key === 'ArrowLeft' ? -1 : 1;
        const Next = Index === -1 ? List.length - 1 : (Index + Step + List.length) % List.length;
        List[Next]?.focus();
        return;
      }
      // Tab stays among the dialog's buttons while it is open.
      if (e.key === 'Tab') {
        e.preventDefault();
        const Step = e.shiftKey ? -1 : 1;
        const Next = Index === -1 ? 0 : (Index + Step + List.length) % List.length;
        List[Next]?.focus();
      }
    });

    // Confirm starts with the focus, so Enter (on it) confirms.
    setTimeout(() => {
      try {
        if (!Done) $btnConfirm.trigger('focus');
      } catch (err) {
        HandleNonFatalError('Toasts:NonFatal', err);
      }
    }, 0);
  });
}

// --- 2b. Critical confirmation ----------------------------------------------
// The loud sibling of ConfirmationDialog for actions that must never fire by
// accident: a centred red modal over a dimmed screen whose DEFAULT is Cancel.
// Focus starts on Cancel, Enter/Space only confirm when Confirm itself has
// focus, and Escape or a click outside both cancel.

interface CriticalConfirmationOptions {
  title: string;
  message: string;
  /** Optional names listed under the message (e.g. the target clients). */
  items?: string[];
  /** The confirm button's label, naming the action in Title Case ("Run Script"). */
  confirmLabel: string;
}

const CRITICAL_CONFIRM_MAX_ITEMS = 8;

// Settles the open dialog (as cancelled) if another one replaces it, so its
// caller is never left awaiting a promise that can no longer resolve.
let settleOpenCriticalConfirm: ((value: boolean) => void) | null = null;

export function CriticalConfirmationDialog(Options: CriticalConfirmationOptions): Promise<boolean> {
  if (settleOpenCriticalConfirm) settleOpenCriticalConfirm(false);

  return new Promise<boolean>((resolve) => {
    const Items = Array.isArray(Options.items) ? Options.items : [];
    const Shown = Items.slice(0, CRITICAL_CONFIRM_MAX_ITEMS);
    const Hidden = Items.length - Shown.length;
    const ItemsHtml = Shown.length
      ? `<ul class="critical-confirm-items">${Shown.map((Item) => `<li>${Safe(Item)}</li>`).join('')}${
          Hidden > 0 ? `<li class="critical-confirm-more">and ${Hidden} more</li>` : ''
        }</ul>`
      : '';

    const $dialog = $(`
			<div id="SHOWTRAK_CRITICAL_CONFIRM" class="critical-confirm no-drag">
				<div class="critical-confirm-panel" role="alertdialog" aria-modal="true"
					aria-labelledby="CRITICAL_CONFIRM_TITLE" aria-describedby="CRITICAL_CONFIRM_MSG">
					<div class="critical-confirm-icon"><i class="bi bi-exclamation-octagon"></i></div>
					<h2 class="critical-confirm-title" id="CRITICAL_CONFIRM_TITLE">${Safe(Options.title)}</h2>
					<div class="critical-confirm-msg" id="CRITICAL_CONFIRM_MSG">${Safe(Options.message)}</div>
					${ItemsHtml}
					<div class="critical-confirm-actions">
						<button type="button" class="btn critical-confirm-cancel" id="CRITICAL_CONFIRM_CANCEL">Cancel</button>
						<button type="button" class="btn critical-confirm-go" id="CRITICAL_CONFIRM_GO">${Safe(
              Options.confirmLabel
            )}</button>
					</div>
				</div>
			</div>`);

    $('body').append($dialog);
    const $btnCancel = $dialog.find('#CRITICAL_CONFIRM_CANCEL');
    const $btnGo = $dialog.find('#CRITICAL_CONFIRM_GO');

    setConfirmDialogActive(true);

    const settle = (value: boolean) => {
      settleOpenCriticalConfirm = null;
      $(document).off('keydown.criticalConfirm');
      try {
        $dialog.remove();
      } catch (err) {
        HandleNonFatalError('CriticalConfirm:Remove', err);
      }
      setConfirmDialogActive(false);
      resolve(value);
    };
    settleOpenCriticalConfirm = settle;

    $btnCancel.on('click', () => settle(false));
    $btnGo.on('click', () => settle(true));
    // A click on the dimmed backdrop (not the panel) cancels.
    $dialog.on('mousedown', (e) => {
      if (e.target === $dialog.get(0)) settle(false);
    });

    $(document).on('keydown.criticalConfirm', (e) => {
      const key = e.key;
      const onGo = document.activeElement === $btnGo.get(0);
      if (key === 'Enter' || key === ' ') {
        e.preventDefault();
        return settle(onGo);
      }
      if (key === 'Escape') {
        e.preventDefault();
        return settle(false);
      }
      // Keep focus trapped on the two buttons.
      if (key === 'Tab' || key === 'ArrowLeft' || key === 'ArrowRight') {
        e.preventDefault();
        const toGo = key === 'ArrowRight' || (key === 'Tab' && !onGo);
        return (toGo ? $btnGo : $btnCancel).trigger('focus');
      }
    });

    setTimeout(() => {
      try {
        $btnCancel.trigger('focus');
      } catch (err) {
        HandleNonFatalError('CriticalConfirm:Focus', err);
      }
    }, 0);
  });
}

// --- 3. Execution toast -----------------------------------------------------

// HideExecutionToast keeps the element in the DOM for 150ms so a quick reopen
// is instant, then removes it. That pending removal is tracked here so a Show
// arriving inside the window can cancel it; otherwise the timer would delete
// a toast we just re-showed (a transient empty executions push hides it, the
// next push shows it, then the stale timer fires), which reads as a flash.
let execToastRemoveTimer: ReturnType<typeof setTimeout> | null = null;

// Whether the last executions push held any queued or running (non-deployment)
// work. Kept by the push handler in client-list.ts.
let executionsInProgress = false;

export function SetExecutionsInProgress(InProgress: boolean) {
  executionsInProgress = InProgress;
}

/**
 * Open the panel straight after the operator runs an action, but only when work
 * is already in progress. Otherwise the executions push opens it once the action
 * has actually queued something, so an action that reached no devices (a tag or
 * selection with nothing applicable, Wake on LAN on machines already online)
 * never opens an empty box.
 */
export function ShowExecutionToastIfActive(title?: string) {
  if (executionsInProgress) ShowExecutionToast(title);
}

export function ShowExecutionToast(title?: string) {
  if (execToastRemoveTimer) {
    clearTimeout(execToastRemoveTimer);
    execToastRemoveTimer = null;
  }
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
			<div class="exec-toast-actions">
				<button type="button" class="btn btn-sm exec-retry-all d-none" data-retry-all><i class="bi bi-arrow-clockwise" aria-hidden="true"></i> <span class="exec-retry-all-label"></span></button>
				<button type="button" class="btn btn-sm btn-light exec-toast-close" aria-label="Close">✕</button>
			</div>
		</div>
		<div id="SHOWTRAK_EXECUTION_LIST" class="exec-toast-body"></div>
	</div>`;
  $('body').append(html);
  $('.exec-toast-close').on('click', () => DismissExecutionToast());
  // Bind outside click to dismiss on create
  enableExecToastOutsideClose();

  // No modal on click per requirements; ensure no handler is attached
  $(document).off('click.execInfo', '.exec-info-btn');
}

// Listeners told when the OPERATOR closes the panel (close button, a click
// outside it, Escape), as opposed to it closing itself after the dwell.
const execToastDismissListeners: Array<() => void> = [];
export function OnExecutionToastDismissed(Listener: () => void) {
  execToastDismissListeners.push(Listener);
}

/** Close the panel because the operator asked to. */
export function DismissExecutionToast() {
  const WasOpen = $('#EXECUTION_TOAST').hasClass('show');
  HideExecutionToast();
  if (!WasOpen) return;
  for (const Listener of execToastDismissListeners) {
    try {
      Listener();
    } catch (e) {
      console.error('Execution panel dismiss listener failed', e);
    }
  }
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
    // A console view open inside the panel goes with it (it stops polling once
    // its element is gone); the panel reopens on the list.
    $t.removeClass('console-open');
    $('#EXECUTION_CONSOLE').remove();
    // Remove outside-click handler when closing
    $(document).off('mousedown.execToastOutside touchstart.execToastOutside');
    // keep in DOM for quick reopen; remove after short delay. Tracked so a Show
    // inside this window cancels the removal instead of losing the toast.
    if (execToastRemoveTimer) clearTimeout(execToastRemoveTimer);
    execToastRemoveTimer = setTimeout(() => {
      execToastRemoveTimer = null;
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
        DismissExecutionToast();
      }
    });
}
