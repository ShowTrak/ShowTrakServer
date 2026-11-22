// Renderer toast/notification systems, co-located.
//
// There are three transient-UI surfaces with genuinely different lifecycles,
// kept as distinct entry points rather than forced into a single component:
//   1. Alert-style toasts:  top-center, stack in a host, hover-pausable
//      auto-dismiss (`showAlertStyleToast` / `Notify`).
//   2. Confirmation dialog: single modal toast, promise-based, keyboard-driven
//      (`ConfirmationDialog`), plus a centred red modal for critical actions
//      that defaults to Cancel (`CriticalConfirmationDialog`).
//   3. Execution toast:     persistent region holding a live execution list,
//      outside-click to dismiss (`ShowExecutionToast` / `HideExecutionToast`).
//
// The first two are the renderer kit's (@showtrak/protocol/ui/toasts and
// /confirm-dialog), shared with ShowTrak Timers and configured here for the
// Server: outline status icons, and a confirmation that stands the identify
// banner down while it is open. The critical confirmation and the execution
// panel are the Server's own.
import { CreateToasts, ensureToastHost, RemoveAlertToastById } from '@showtrak/protocol/ui/toasts';
import { CancelConfirmation, CreateConfirmationDialog } from '@showtrak/protocol/ui/confirm-dialog';
import { setConfirmDialogActive } from '../state';
import { HandleNonFatalError, Safe } from '../utils';
import { UpdateIdentifyStatusBanner } from '../identify';

// --- 1. Alert-style toasts (top center) -------------------------------------

export { ensureToastHost, RemoveAlertToastById };

export const { iconForType, showAlertStyleToast, Notify } = CreateToasts({
  IconStyle: 'outline',
});

// --- 2. Confirmation dialog -------------------------------------------------

export { CancelConfirmation };

/**
 * Ask a question with Cancel and a named confirm button. Resolves true or false.
 * Keys go to the dialog's own buttons; inside an open modal it sits in that
 * modal, and closing the modal cancels it. While it is open the identify banner
 * stands down.
 */
export const ConfirmationDialog = CreateConfirmationDialog({
  OnActiveChange: (Active) => {
    setConfirmDialogActive(Active);
    UpdateIdentifyStatusBanner();
  },
});

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
