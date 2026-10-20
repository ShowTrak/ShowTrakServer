import {
  AlertActionsEnabled,
  AppMode,
  COMPACT_MODE_STORAGE_KEY,
  Capabilities,
  CompactMode,
  VIEW_MODE_STORAGE_KEY,
  ViewMode,
  setAlertActionsEnabled,
  setAppMode,
  setViewMode,
} from './state';
import type { ViewMode as ViewModeValue } from './state';
import type { AppMode as AppModeValue } from '@showtrak/protocol';
import { HandleNonFatalError } from './utils';
import { RenderPendingAdoptionSection } from './client-list';
import { initializeEditInteractions } from './dnd';
import { UpdateSelectionCount } from './selection-init';
import { SyncListView } from './list-view';
import { ClearListSearch } from './list-filter';
import { ApplyClientInfoEditMode } from './client-info-edit';
import { ApplyMonitorInfoEditMode } from './monitor-info-edit';
import { ApplyDummyInfoEditMode } from './dummy-info-edit';
import { ApplyFreeKioskInfoEditMode } from './freekiosk-info-edit';
import { ParseViewMode, ResolveStoredViewMode } from './lib/list-view';

// --- View mode (Grid | Compact | List) ---------------------------------------

const VIEW_MODE_LABELS: Record<ViewModeValue, string> = {
  grid: 'Grid',
  compact: 'Compact',
  list: 'List',
};

// The fade between the tile layouts and the table. Out is quicker than in: the
// old layout only has to get out of the way, the new one is what is read.
const VIEW_FADE_OUT_MS = 140;

// The mode a fade is heading to while it runs. Comparing a new request against
// this rather than ViewMode is what lets a second click mid-fade redirect the
// switch instead of being mistaken for a no-op.
let PendingViewMode: ViewModeValue | null = null;
let ViewTransitionToken = 0;

function RenderViewModeToggle(Mode: ViewModeValue) {
  const Buttons = document.querySelectorAll<HTMLButtonElement>(
    '#VIEW_MODE_TOGGLE [data-view-mode]'
  );
  for (const Btn of Array.from(Buttons)) {
    const Active = Btn.dataset.viewMode === Mode;
    Btn.classList.toggle('is-active', Active);
    Btn.setAttribute('aria-pressed', Active ? 'true' : 'false');
  }
}

/** Apply a view mode to the page at once, with no transition. */
export function RenderViewMode(Mode: ViewModeValue) {
  setViewMode(Mode);
  document.body.classList.toggle('compact-mode', Mode === 'compact');
  document.body.classList.toggle('list-mode', Mode === 'list');
  RenderViewModeToggle(Mode);
  try {
    SyncListView();
  } catch (err) {
    HandleNonFatalError('Mode:SyncListView', err);
  }
}

function PrefersReducedMotion() {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

interface ScrollAnchor {
  Key: string;
  Fraction: number;
}

// The group at the top of the viewport and how far through it the operator has
// scrolled. Tiles and rows are very different heights, so restoring the raw
// scrollTop would land somewhere else entirely; restoring the same point in the
// same group keeps them looking at what they were looking at.
function CaptureScrollAnchor(Scroller: HTMLElement): ScrollAnchor | null {
  if (Scroller.scrollTop <= 0) return null;
  const Top = Scroller.getBoundingClientRect().top;
  const Groups = Scroller.querySelectorAll<HTMLElement>('.group-column-item[data-flip-key]');
  for (const Group of Array.from(Groups)) {
    const Rect = Group.getBoundingClientRect();
    if (Rect.bottom <= Top) continue;
    const Fraction = Rect.height > 0 ? (Top - Rect.top) / Rect.height : 0;
    return {
      Key: Group.getAttribute('data-flip-key') || '',
      Fraction: Math.min(1, Math.max(0, Fraction)),
    };
  }
  return null;
}

function RestoreScrollAnchor(Scroller: HTMLElement, Anchor: ScrollAnchor | null) {
  if (!Anchor) return;
  const Group = Array.from(
    Scroller.querySelectorAll<HTMLElement>('.group-column-item[data-flip-key]')
  ).find((El) => El.getAttribute('data-flip-key') === Anchor.Key);
  if (!Group) return;
  const Top = Scroller.getBoundingClientRect().top;
  const Rect = Group.getBoundingClientRect();
  Scroller.scrollTop += Rect.top + Anchor.Fraction * Rect.height - Top;
}

// Fade the content out, swap the layout while it is invisible, fade back in.
// Tile transitions are suppressed for the swap itself (body.view-switching), or
// every tile would visibly grow into a row as the new layout faded up.
function TransitionViewMode(Apply: () => void) {
  const Content = document.getElementById('APPLICATION_CONTENT');
  const Scroller = document.getElementById('APPLICATION_CONTAINER');
  if (!Content || !Scroller || PrefersReducedMotion()) {
    Apply();
    return;
  }
  const Token = ++ViewTransitionToken;
  // Captured before the fade, while the old layout is still the one on screen.
  const Anchor = CaptureScrollAnchor(Scroller);
  Content.classList.add('view-fade-out');
  setTimeout(() => {
    // A later switch took over mid-fade; it will do the swap.
    if (Token !== ViewTransitionToken) return;
    document.body.classList.add('view-switching');
    Apply();
    RestoreScrollAnchor(Scroller, Anchor);
    // Commit the new layout while transitions are off, then let the fade run.
    void Content.offsetHeight;
    document.body.classList.remove('view-switching');
    Content.classList.remove('view-fade-out');
  }, VIEW_FADE_OUT_MS);
}

export function SetViewMode(
  Mode: ViewModeValue,
  Options: { persist?: boolean; animate?: boolean } = {}
) {
  const Next = ParseViewMode(Mode) ?? 'grid';
  if (Options.persist !== false) {
    try {
      localStorage.setItem(VIEW_MODE_STORAGE_KEY, Next);
    } catch (err) {
      HandleNonFatalError('Mode:SetViewModePersist', err);
    }
  }
  const Current = PendingViewMode ?? ViewMode;
  if (Next !== Current) ClearListSearch();
  if (Next === Current && PendingViewMode == null) {
    RenderViewMode(Next);
    return;
  }
  // Grid <-> Compact morph through the tiles' own size transitions, as they
  // always have. Anything to or from the table fades instead: there is no
  // sensible in-between for a tile becoming a row.
  const Fade =
    Options.animate !== false && (Next === 'list' || Current === 'list' || PendingViewMode != null);
  if (!Fade) {
    RenderViewMode(Next);
    return;
  }
  PendingViewMode = Next;
  // The switch answers the click at once; the page follows after the fade.
  RenderViewModeToggle(Next);
  TransitionViewMode(() => {
    PendingViewMode = null;
    RenderViewMode(Next);
  });
}

export function LoadViewModePreference(): ViewModeValue {
  try {
    return ResolveStoredViewMode(
      localStorage.getItem(VIEW_MODE_STORAGE_KEY),
      localStorage.getItem(COMPACT_MODE_STORAGE_KEY)
    );
  } catch (err) {
    HandleNonFatalError('Mode:LoadViewModePreference', err);
    return 'grid';
  }
}

/** Compact on/off, for callers that still think in those terms (the SDK). */
export function SetCompactMode(isCompact: boolean, options: { persist?: boolean } = {}) {
  SetViewMode(isCompact ? 'compact' : 'grid', options);
}

/** Wire the Grid / Compact / List switch in the bottom bar. */
export function WireViewModeToggle() {
  const Buttons = document.querySelectorAll<HTMLButtonElement>(
    '#VIEW_MODE_TOGGLE [data-view-mode]'
  );
  for (const Btn of Array.from(Buttons)) {
    if (Btn.dataset.bound) continue;
    const Mode = ParseViewMode(Btn.dataset.viewMode);
    if (!Mode) continue;
    Btn.title = `${VIEW_MODE_LABELS[Mode]} View`;
    Btn.addEventListener('click', () => SetViewMode(Mode));
    Btn.dataset.bound = '1';
  }
}

const MOBILE_VIEW_MEDIA_QUERY = '(max-width: 768px)';

function ApplyMobileView(isMobile: boolean) {
  document.body.classList.toggle('mobile-view', isMobile);
  // Mobile is locked to compact mode; the switch itself stays hidden on mobile
  // (see CSS), so this applies without persisting. Widening back out restores
  // whatever the operator chose, rather than leaving them stuck in compact.
  if (isMobile) {
    if (!CompactMode) SetViewMode('compact', { persist: false, animate: false });
    return;
  }
  const Preferred = LoadViewModePreference();
  if (Preferred !== ViewMode) SetViewMode(Preferred, { persist: false, animate: false });
}

export function InitMobileView() {
  const mql = window.matchMedia(MOBILE_VIEW_MEDIA_QUERY);
  if (mql.matches) ApplyMobileView(true);
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
    } else {
      btnShow.removeAttribute('title');
      btnEdit.removeAttribute('title');
    }
  }
  document.body.classList.toggle('mode-edit', AppMode === 'EDIT');
}

// Subscribe to backend push updates. Called by the bootstrap orchestrator in
// main.ts — never at import time.
export function InitMode() {
  window.API.OnModeUpdated((mode) => {
    RenderMode(mode);
    // An open view modal, whatever it is showing, flips between read-only and
    // editable in place.
    try {
      ApplyClientInfoEditMode();
      ApplyMonitorInfoEditMode();
      ApplyDummyInfoEditMode();
      void ApplyFreeKioskInfoEditMode().catch((err) =>
        HandleNonFatalError('Mode:ApplyFreeKioskInfoEditMode', err)
      );
    } catch (err) {
      HandleNonFatalError('Mode:ApplyViewModalEditMode', err);
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

  // Reflect alert-actions state whenever it changes anywhere (desktop click,
  // OSC, or the SDK control API) so the toggle never goes stale.
  window.API.OnAlertActionsUpdated((enabled) => {
    RenderAlertActionsToggle(!!enabled);
  });
}
