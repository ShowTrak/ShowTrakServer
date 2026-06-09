function RenderCompactMode(isCompact) {
  CompactMode = !!isCompact;
  document.body.classList.toggle('compact-mode', CompactMode);

  const btn = document.getElementById('COMPACT_MODE_BTN');
  const icon = document.getElementById('COMPACT_MODE_ICON');
  if (btn) {
    btn.classList.toggle('btn-light', CompactMode);
    btn.classList.toggle('btn-outline-light', !CompactMode);
    btn.setAttribute('aria-pressed', CompactMode ? 'true' : 'false');
    btn.title = CompactMode ? 'Disable Compact Mode' : 'Enable Compact Mode';
  }
  if (icon) {
    icon.classList.remove('bi-arrows-angle-contract', 'bi-arrows-angle-expand');
    icon.classList.add(CompactMode ? 'bi-arrows-angle-expand' : 'bi-arrows-angle-contract');
  }
}

function SetCompactMode(isCompact, options = {}) {
  const persist = options.persist !== false;
  RenderCompactMode(isCompact);
  if (persist) {
    try {
      localStorage.setItem(COMPACT_MODE_STORAGE_KEY, CompactMode ? '1' : '0');
    } catch {}
  }
}

function LoadCompactModePreference() {
  try {
    return localStorage.getItem(COMPACT_MODE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function RenderAlertActionsToggle(isEnabled) {
  AlertActionsEnabled = !!isEnabled;
  const btn = document.getElementById('ALERT_ACTIONS_TOGGLE_BTN');
  if (btn) {
    btn.classList.toggle('alerts-enabled', AlertActionsEnabled);
    btn.classList.toggle('alerts-disabled', !AlertActionsEnabled);
    btn.setAttribute('aria-pressed', AlertActionsEnabled ? 'true' : 'false');
    btn.title = AlertActionsEnabled ? 'Disable Alert Actions' : 'Enable Alert Actions';
  }
  UpdateSelectionCount();
}

async function SetAlertActionsEnabled(isEnabled) {
  RenderAlertActionsToggle(isEnabled);
  try {
    const NextEnabled = await window.API.SetAlertActionsEnabled(!!isEnabled);
    RenderAlertActionsToggle(NextEnabled);
  } catch {}
}

function RenderMode(mode) {
  AppMode = String(mode).toUpperCase() === 'EDIT' ? 'EDIT' : 'SHOW';
  // Highlight the active button
  const btnShow = document.getElementById('MODE_BTN_SHOW');
  const btnEdit = document.getElementById('MODE_BTN_EDIT');
  if (btnShow && btnEdit) {
    const activeClasses = ['btn-light', 'text-dark'];
    const inactiveClasses = ['btn-outline-light', 'text-light'];

    // reset
    btnShow.classList.remove(...activeClasses, ...inactiveClasses);
    btnEdit.classList.remove(...activeClasses, ...inactiveClasses);

    if (AppMode === 'SHOW') {
      btnShow.classList.add(...activeClasses);
      btnEdit.classList.add(...inactiveClasses);
    } else {
      btnEdit.classList.add(...activeClasses);
      btnShow.classList.add(...inactiveClasses);
    }
  }
  document.body.classList.toggle('mode-edit', AppMode === 'EDIT');
}

// Subscribe to backend push updates
window.API.OnModeUpdated((mode) => {
  RenderMode(mode);
  // Re-evaluate drag state when mode changes
  if (typeof initializeEditInteractions === 'function') {
    try {
      initializeEditInteractions();
    } catch {}
  }
  // Refresh discover/adopt section visibility when mode changes
  try {
    const $existing = $('#PENDING_ADOPTION_SECTION');
    if ($existing && $existing.length) {
      if (AppMode !== 'EDIT') {
        $existing.replaceWith('<div id="PENDING_ADOPTION_SECTION"></div>');
      } else {
        $existing.replaceWith(RenderPendingAdoptionSection());
      }
    }
  } catch {}
});
