import { AlertActionsEnabled, Capabilities, CompactMode, ConfirmDialogActive } from './01-state';
import { SetAlertActionsEnabled, SetCompactMode } from './02-mode';
import { HandleNonFatalError } from './04-utils';
import { ShowShortcutsModal } from './08-dnd';
import { AlertsVisible, DismissAllAlerts, ToggleAlertsTray } from './10-alerts-tray';
import { ClearSelection, GetIdentifyingUUIDs, SelectAll, StopIdentifyingForUUIDs } from './14-selection-init';
// Called by the bootstrap orchestrator in main.ts — never at import time.
export function InitKeyboard() {
  document.addEventListener('keydown', function (e) {
  // Suppress global shortcuts while a confirmation prompt is active
  if (ConfirmDialogActive) {
    return;
  }

  const target = e.target;
  const isEditableTarget =
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
      Boolean(target.closest('[contenteditable=""], [contenteditable="true"]')));

  // Keep native text-editing shortcuts (e.g. Cmd/Ctrl+A) inside editable fields.
  if (isEditableTarget) {
    return;
  }

  // Core cogs menu shortcuts (Cmd on macOS, Ctrl on Windows/Linux)
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.repeat) {
    const key = e.key.toLowerCase();

    // Show Mode
    if (!e.shiftKey && key === '1') {
      e.preventDefault();
      document.getElementById('MODE_BTN_SHOW')?.click();
      return;
    }

    // Edit Mode
    if (!e.shiftKey && key === '2') {
      e.preventDefault();
      document.getElementById('MODE_BTN_EDIT')?.click();
      return;
    }

    // Save
    if (!e.shiftKey && key === 's') {
      e.preventDefault();
      document.getElementById('SHOWTRAK_MODEL_CORE_SAVE')?.click();
      return;
    }

    // Save As
    if (e.shiftKey && key === 's') {
      e.preventDefault();
      document.getElementById('SHOWTRAK_MODEL_CORE_SAVEAS')?.click();
      return;
    }

    // Open
    if (!e.shiftKey && key === 'o') {
      e.preventDefault();
      document.getElementById('SHOWTRAK_MODEL_CORE_OPEN')?.click();
      return;
    }

    // New Show
    if (!e.shiftKey && key === 'n') {
      e.preventDefault();
      document.getElementById('SHOWTRAK_MODEL_CORE_NEW')?.click();
      return;
    }

    // Preferences
    if (!e.shiftKey && key === ',') {
      e.preventDefault();
      document.getElementById('SHOWTRAK_MODEL_CORE_OPEN_SETTINGS')?.click();
      return;
    }

    // LAN Discovery Wizard
    if (!e.shiftKey && key === 'l') {
      e.preventDefault();
      document.getElementById('ADD_TARGET_BROWSE_ACTION')?.click();
      return;
    }

    // Toggle compact/expanded mode
    if (!e.shiftKey && key === 'e') {
      e.preventDefault();
      SetCompactMode(!CompactMode);
      return;
    }
  }

  // Ctrl/Cmd + Shift + M opens context menu centered
  if (
    (e.ctrlKey || e.metaKey) &&
    e.shiftKey &&
    !e.altKey &&
    !e.repeat &&
    e.key.toLowerCase() === 'm'
  ) {
    e.preventDefault();
    try {
      const pageWidth = $(window).width() || 0;
      const pageHeight = $(window).height() || 0;
      const centerX = Math.floor(pageWidth / 2);
      const centerY = Math.floor(pageHeight / 2);
      const evt = $.Event('contextmenu');
      evt.pageX = centerX;
      evt.pageY = centerY;
      // The menu is position:fixed and positions from clientX/clientY, so set
      // those too (the width/height here are already viewport-relative).
      evt.clientX = centerX;
      evt.clientY = centerY;
      $('html').trigger(evt);
    } catch (err) {
      HandleNonFatalError('Keyboard:OpenContextMenuCenter', err);
    }
    return;
  }

  // Best-effort global clear for identify mode. This intentionally does not
  // block other shortcut behavior.
  const clearIdentifyingViaShortcut = () => {
    try {
      const IDs = GetIdentifyingUUIDs();
      if (Array.isArray(IDs) && IDs.length > 0) {
        StopIdentifyingForUUIDs(IDs);
      }
    } catch (err) {
      HandleNonFatalError('Keyboard:ClearIdentifying', err);
    }
  };

  if (e.key === 'Escape') {
    e.preventDefault();
    clearIdentifyingViaShortcut();
    return ClearSelection();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    return SelectAll();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    clearIdentifyingViaShortcut();
    return ClearSelection();
  }
  // Open context menu via keyboard: standard Windows bindings
  if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
    e.preventDefault();
    try {
      const pageWidth = $(window).width() || 0;
      const pageHeight = $(window).height() || 0;
      const centerX = Math.floor(pageWidth / 2);
      const centerY = Math.floor(pageHeight / 2);
      const evt = $.Event('contextmenu');
      evt.pageX = centerX;
      evt.pageY = centerY;
      evt.clientX = centerX;
      evt.clientY = centerY;
      $('html').trigger(evt);
    } catch (err) {
      HandleNonFatalError('Keyboard:OpenContextMenuHotkey', err);
    }
    return;
  }

  // Alerts tray shortcuts
  try {
    // Keyboard Shortcuts menu: Ctrl+K
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      ShowShortcutsModal();
      return;
    }
    // Toggle alert actions enabled/disabled: Ctrl+T
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 't') {
      if (!Capabilities.canToggleAlertActions) return;
      e.preventDefault();
      SetAlertActionsEnabled(!AlertActionsEnabled);
      return;
    }
    // Toggle alerts panel: Ctrl+Y
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      ToggleAlertsTray();
      return;
    }
    // Dismiss all alerts: Ctrl+U (global)
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'u') {
      e.preventDefault();
      DismissAllAlerts();
      return;
    }
    // Close alerts tray: Esc, only if open
    if (AlertsVisible && e.key === 'Escape') {
      e.preventDefault();
      ToggleAlertsTray(false);
      return;
    }
  } catch (err) {
    HandleNonFatalError('Keyboard:AlertsShortcuts', err);
  }
  });
}
