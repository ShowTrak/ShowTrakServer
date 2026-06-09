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
    } catch {}
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    return ClearSelection();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    return AllClients.map((UUID) => Select(UUID));
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
    } catch {}
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
    // Toggle alerts: Ctrl+Y
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
  } catch {}
});

