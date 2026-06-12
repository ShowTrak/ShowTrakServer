document.addEventListener('keydown', function (e) {
  // Suppress global shortcuts while a confirmation prompt is active
  if (window.__SHOWTRAK_CONFIRM_ACTIVE) {
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
      const pageWidth = $(window).width();
      const pageHeight = $(window).height();
      const centerX = Math.floor(pageWidth / 2);
      const centerY = Math.floor(pageHeight / 2);
      const evt = $.Event('contextmenu');
      evt.pageX = centerX;
      evt.pageY = centerY;
      $('html').trigger(evt);
    } catch (err) {
      HandleNonFatalError('Keyboard:OpenContextMenuCenter', err);
    }
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    return ClearSelection();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    return AllClients.map((Client) => Select(Client.UUID));
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    return ClearSelection();
  }
  // Open context menu via keyboard: standard Windows bindings
  if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
    e.preventDefault();
    try {
      const pageWidth = $(window).width();
      const pageHeight = $(window).height();
      const centerX = Math.floor(pageWidth / 2);
      const centerY = Math.floor(pageHeight / 2);
      const evt = $.Event('contextmenu');
      evt.pageX = centerX;
      evt.pageY = centerY;
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
