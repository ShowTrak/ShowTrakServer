import { AlertActionsEnabled, AppMode, COMPACT_MODE_STORAGE_KEY, Capabilities, CompactMode, setAlertActionsEnabled, setAppMode, setCompactMode } from './01-state';
import type { AppMode as AppModeValue } from '@showtrak/protocol';
import { HandleNonFatalError } from './04-utils';
import { RenderPendingAdoptionSection } from './06-client-list';
import { UpdateMonitorHistoryEditButtonVisibility } from './07-monitoring';
import { initializeEditInteractions } from './08-dnd';
import { UpdateSelectionCount } from './14-selection-init';
export function RenderCompactMode(isCompact: boolean) {
    setCompactMode(!!isCompact);
  document.body.classList.toggle('compact-mode', CompactMode);

  const btn = document.getElementById('COMPACT_MODE_BTN') as HTMLButtonElement | null;
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

export function SetCompactMode(isCompact: boolean, options: { persist?: boolean } = {}) {
  const persist = options.persist !== false;
  RenderCompactMode(isCompact);
  if (persist) {
    try {
      localStorage.setItem(COMPACT_MODE_STORAGE_KEY, CompactMode ? '1' : '0');
    } catch (err) {
      HandleNonFatalError('Mode:SetCompactModePersist', err);
    }
  }
}

export function LoadCompactModePreference() {
  try {
    return localStorage.getItem(COMPACT_MODE_STORAGE_KEY) === '1';
  } catch (err) {
    HandleNonFatalError('Mode:LoadCompactModePreference', err);
    return false;
  }
}

const MOBILE_VIEW_MEDIA_QUERY = '(max-width: 768px)';

function ApplyMobileView(isMobile: boolean) {
  document.body.classList.toggle('mobile-view', isMobile);
  // Mobile is locked to compact mode; the toggle itself stays hidden on
  // mobile (see CSS), so this only needs to apply, never persist/revert.
  if (isMobile && !CompactMode) {
    SetCompactMode(true, { persist: false });
  }
}

export function InitMobileView() {
  const mql = window.matchMedia(MOBILE_VIEW_MEDIA_QUERY);
  ApplyMobileView(mql.matches);
  mql.addEventListener('change', (e) => ApplyMobileView(e.matches));
}

export function RenderAlertActionsToggle(isEnabled: boolean) {
    setAlertActionsEnabled(!!isEnabled);
  const btn = document.getElementById('ALERT_ACTIONS_TOGGLE_BTN') as HTMLButtonElement | null;
  if (btn) {
    btn.classList.toggle('alerts-enabled', AlertActionsEnabled);
    btn.classList.toggle('alerts-disabled', !AlertActionsEnabled);
    btn.setAttribute('aria-pressed', AlertActionsEnabled ? 'true' : 'false');
    const IsReadOnly = !Capabilities.canToggleAlertActions;
    btn.disabled = IsReadOnly;
    btn.setAttribute('aria-disabled', IsReadOnly ? 'true' : 'false');
    btn.title = IsReadOnly
      ? `Alert Actions: ${AlertActionsEnabled ? 'Enabled' : 'Disabled'} (Desktop controlled)`
      : AlertActionsEnabled
      ? 'Disable Alert Actions'
      : 'Enable Alert Actions';
  }
  UpdateSelectionCount();
}

export async function SetAlertActionsEnabled(isEnabled: boolean) {
  if (!Capabilities.canToggleAlertActions) {
    RenderAlertActionsToggle(AlertActionsEnabled);
    return;
  }
  RenderAlertActionsToggle(isEnabled);
  try {
    const NextEnabled = await window.API.SetAlertActionsEnabled(!!isEnabled);
    RenderAlertActionsToggle(NextEnabled);
  } catch (err) {
    HandleNonFatalError('Mode:SetAlertActionsEnabled', err);
  }
}

export function RenderMode(mode: AppModeValue) {
    setAppMode(String(mode).toUpperCase() === 'EDIT' ? 'EDIT' : 'SHOW');
  // Highlight the active button
  const btnShow = document.getElementById('MODE_BTN_SHOW') as HTMLButtonElement | null;
  const btnEdit = document.getElementById('MODE_BTN_EDIT') as HTMLButtonElement | null;
  if (btnShow && btnEdit) {
    // Segmented toggle: the active mode's button carries `.is-active`.
    btnShow.classList.toggle('is-active', AppMode === 'SHOW');
    btnEdit.classList.toggle('is-active', AppMode === 'EDIT');

    const IsReadOnly = !Capabilities.showModeToggle;
    btnShow.disabled = IsReadOnly;
    btnEdit.disabled = IsReadOnly;
    btnShow.setAttribute('aria-disabled', IsReadOnly ? 'true' : 'false');
    btnEdit.setAttribute('aria-disabled', IsReadOnly ? 'true' : 'false');
    if (IsReadOnly) {
      btnShow.title = 'Show mode is controlled by the desktop app';
      btnEdit.title = 'Edit mode is controlled by the desktop app';
    }
  }
  document.body.classList.toggle('mode-edit', AppMode === 'EDIT');
}

// Subscribe to backend push updates. Called by the bootstrap orchestrator in
// main.ts — never at import time.
export function InitMode() {
  window.API.OnModeUpdated((mode) => {
    RenderMode(mode);
    try {
      UpdateMonitorHistoryEditButtonVisibility();
    } catch (err) {
      HandleNonFatalError('Mode:UpdateMonitorHistoryEditButtonVisibility', err);
    }
    // Re-evaluate drag state when mode changes
    try {
      initializeEditInteractions();
    } catch (err) {
      HandleNonFatalError('Mode:initializeEditInteractions', err);
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
    } catch (err) {
      HandleNonFatalError('Mode:RenderPendingAdoptionSection', err);
    }
  });
}
