// List view: the extra cells a tile carries for its table row, and the
// overall-status history drawn in each row's far-right column.
//
// The list is not a second rendering of the page. Every tile renders the same
// element in all three view modes, and body.list-mode lays it out as a table
// row (07-list-view.css). That is deliberate: selection, the context menu,
// double-click, the edit cog, drag-and-drop, the offline counters and every
// live in-place patch already target the tile, so they all keep working in the
// list without knowing it exists. This module only adds what a row has and a
// tile does not — a selection checkbox, a status word, and the history graph.
//
// The checkbox has no state of its own: CSS draws it from the tile's SELECTED
// class, so it cannot drift from the selection.
//
// A monitoring target can also be expanded into one row per check (rendered by
// monitoring.ts, beside the target's tile). Those rows exist only here, so a
// check's selection never outlives the list: collapsing a target, or leaving
// the list, drops it — an action must never land on a row nobody can see.
import {
  AllClients,
  DummyClients,
  FreeKioskTerminals,
  MonitoringTargets,
  Selected,
  ViewMode,
} from './state';
import { HandleNonFatalError, Safe } from './utils';
import { Deselect } from './selection';
import {
  HideStatusTimelineTooltip,
  RenderStatusTimeline,
  ShowStatusTimelineTooltip,
} from './monitoring';
import { BuildListHistoryBlocks, CHECK_SELECTION_PREFIX } from './lib/list-view';
import { ClearListSearch } from './list-filter';

/** How often the history column is refetched while the list is showing. */
const LIST_HISTORY_REFRESH_MS = 20 * 1000;
const LIST_HISTORY_TOOLTIP_ID = 'LIST_HISTORY_TOOLTIP';

// A track with no blocks, shown until a row's first history read lands so the
// column holds its shape rather than popping in.
const PENDING_TIMELINE = '<div class="status-timeline is-pending" aria-hidden="true"></div>';

/** Rendered timeline markup per row key (the tile's data-uuid). */
const HistoryCache = new Map<string, string>();
/** What each cell was last given, so an unchanged row is not rebuilt. */
const CellContent = new WeakMap<Element, string>();

// Which targets are expanded into their checks. Per viewer, remembered across
// restarts: it is a reading preference, not show data.
const EXPANDED_STORAGE_KEY = 'showtrak.ui.listExpandedTargets';
let ExpandedTargets: Set<string> | null = null;

function LoadExpandedTargets(): Set<string> {
  if (ExpandedTargets) return ExpandedTargets;
  ExpandedTargets = new Set();
  try {
    const Stored = JSON.parse(localStorage.getItem(EXPANDED_STORAGE_KEY) || '[]');
    if (Array.isArray(Stored)) for (const ID of Stored) ExpandedTargets.add(String(ID));
  } catch {
    // Unreadable or unavailable storage: start with everything collapsed.
  }
  return ExpandedTargets;
}

export function IsTargetExpanded(TargetID: number | string): boolean {
  return LoadExpandedTargets().has(String(TargetID));
}

/** The chevron on a target's row that shows and hides its checks. */
export function RenderListExpandToggle(TargetID: number | string, CheckCount: number): string {
  if (!CheckCount) return '';
  const Expanded = IsTargetExpanded(TargetID);
  const Label = `${Expanded ? 'Hide' : 'Show'} ${CheckCount} check${CheckCount === 1 ? '' : 's'}`;
  return `<button type="button" class="LIST_EXPAND" data-target-id="${Safe(String(TargetID))}" aria-expanded="${
    Expanded ? 'true' : 'false'
  }" title="${Label}" aria-label="${Label}"><i class="bi bi-chevron-right"></i></button>`;
}

function PersistExpandedTargets(): void {
  try {
    localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify([...LoadExpandedTargets()]));
  } catch (err) {
    HandleNonFatalError('ListView:PersistExpanded', err);
  }
}

// Bring one target's row and its check rows in line with its expanded state.
function ApplyTargetExpanded(TargetID: string, Expanded: boolean): void {
  const Tile = document.getElementById(`MONITOR_TILE_${TargetID}`);
  if (Tile) Tile.classList.toggle('CHECKS_EXPANDED', Expanded);
  const Toggle = Tile ? Tile.querySelector<HTMLElement>('.LIST_EXPAND') : null;
  if (Toggle) {
    Toggle.setAttribute('aria-expanded', Expanded ? 'true' : 'false');
    const Label = String(Toggle.getAttribute('title') || '').replace(
      /^(Show|Hide)/,
      Expanded ? 'Hide' : 'Show'
    );
    Toggle.setAttribute('title', Label);
    Toggle.setAttribute('aria-label', Label);
  }
  const Rows = document.querySelectorAll<HTMLElement>(
    `.MONITOR_CHECK[data-target-id="${CSS.escape(TargetID)}"]`
  );
  for (const Row of Array.from(Rows)) {
    Row.classList.toggle('is-collapsed', !Expanded);
    const ID = Row.getAttribute('data-uuid') || '';
    if (!Expanded && ID && Selected.includes(ID)) Deselect(ID);
  }
}

function SetTargetsExpanded(TargetIDs: string[], Expanded: boolean): void {
  const Targets = LoadExpandedTargets();
  for (const TargetID of TargetIDs) {
    if (Expanded) Targets.add(TargetID);
    else Targets.delete(TargetID);
    ApplyTargetExpanded(TargetID, Expanded);
  }
  PersistExpandedTargets();
}

function SetTargetExpanded(TargetID: string, Expanded: boolean): void {
  SetTargetsExpanded([TargetID], Expanded);
}

/**
 * Expand or collapse targets from the keyboard (Ctrl/Cmd+Right / Left): the
 * selected monitoring targets when there are any, otherwise every target on
 * the page. List view only — nowhere else shows checks. Returns whether it
 * applied, so the shortcut can leave the keys alone when it did not.
 */
export function SetListTargetsExpanded(Expanded: boolean): boolean {
  if (ViewMode !== 'list') return false;
  const WithChecks = MonitoringTargets.filter(
    (Target) => Array.isArray(Target.Checks) && Target.Checks.length > 0
  ).map((Target) => String(Target.TargetID));
  const SelectedTargets = Selected.filter((ID) => String(ID).startsWith('monitor:')).map((ID) =>
    String(ID).slice('monitor:'.length)
  );
  const Scope = SelectedTargets.length
    ? WithChecks.filter((ID) => SelectedTargets.includes(ID))
    : WithChecks;
  SetTargetsExpanded(Scope, Expanded);
  return true;
}

/** Drop every check row from the selection (leaving the list view). */
function DeselectCheckRows(): void {
  for (const ID of Selected.filter((Entry) => String(Entry).startsWith(CHECK_SELECTION_PREFIX))) {
    Deselect(ID);
  }
}

let RefreshTimer: ReturnType<typeof setInterval> | null = null;
let RefreshInFlight = false;
let Wired = false;

/** The history cell's content for a row, or nothing outside the list view. */
export function ListHistoryCellHtml(Key: string): string {
  if (ViewMode !== 'list') return '';
  return HistoryCache.get(Key) || PENDING_TIMELINE;
}

/**
 * The cells every tile carries for its list row: selection checkbox, status
 * word, history graph. Hidden in Grid and Compact. Pending-adoption tiles pass
 * `History: false` — a device not yet adopted has no history to show.
 */
export function RenderListRowCells(
  Key: string,
  StateLabel: string,
  Options: { History?: boolean } = {}
): string {
  const History =
    Options.History === false
      ? ''
      : `<div class="LIST_HISTORY" data-history-key="${Safe(Key)}">${ListHistoryCellHtml(Key)}</div>`;
  return (
    `<span class="LIST_CHECK" aria-hidden="true"><i class="bi bi-check-lg"></i></span>` +
    `<span class="LIST_STATE" data-type="LIST_STATE">${Safe(StateLabel)}</span>` +
    History
  );
}

/** Patch a rendered tile's status word after a live update. */
export function UpdateListRowState($tile: JQuery<HTMLElement>, StateLabel: string): void {
  const $State = $tile.children('[data-type="LIST_STATE"]');
  if ($State.length && $State.text() !== StateLabel) $State.text(StateLabel);
}

/** The checkbox in a group's header bar in the list view. */
export function RenderListGroupHeaderCells(): string {
  return `<span class="LIST_CHECK LIST_GROUP_CHECK" aria-hidden="true"><i class="bi bi-check-lg"></i><i class="bi bi-dash-lg"></i></span>`;
}

/**
 * The list's one row of column headings, rendered once above every group and
 * pinned to the top while the list scrolls. Hidden in Grid and Compact.
 */
export function RenderListTableHeader(): string {
  const Label = (Column: string, Text: string) =>
    `<span class="LIST_COLUMN_LABEL" data-list-column="${Column}">${Text}</span>`;
  return (
    `<div class="LIST_TABLE_HEADER" aria-hidden="true">` +
    Label('state', 'Status') +
    Label('name', 'Name') +
    Label('type', 'Type') +
    Label('address', 'Address') +
    Label('detail', 'Details') +
    Label('history', 'Last Hour') +
    `</div>`
  );
}

/** Push the cache into every history cell on the page. */
function FillListHistoryCells(): void {
  const Cells = document.querySelectorAll<HTMLElement>(
    '#APPLICATION_CONTENT .LIST_HISTORY[data-history-key]'
  );
  for (const Cell of Array.from(Cells)) {
    const Html = ListHistoryCellHtml(Cell.getAttribute('data-history-key') || '');
    if (CellContent.get(Cell) === Html) continue;
    Cell.innerHTML = Html;
    CellContent.set(Cell, Html);
  }
}

/** Fetch every row's history in one read and redraw the column. */
export async function RefreshListHistory(): Promise<void> {
  if (ViewMode !== 'list' || RefreshInFlight) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  RefreshInFlight = true;
  try {
    const Overview = await window.API.GetStatusHistoryOverview();
    // The operator may have left the list while the read was in flight.
    if (ViewMode !== 'list') return;
    const Blocks = BuildListHistoryBlocks(
      Overview,
      {
        Clients: AllClients,
        Monitors: MonitoringTargets,
        Dummies: DummyClients,
        Kiosks: FreeKioskTerminals,
      },
      Date.now()
    );
    HistoryCache.clear();
    for (const [Key, RowBlocks] of Blocks) HistoryCache.set(Key, RenderStatusTimeline(RowBlocks));
    HideStatusTimelineTooltip(LIST_HISTORY_TOOLTIP_ID);
    FillListHistoryCells();
  } catch (err) {
    HandleNonFatalError('ListView:RefreshHistory', err);
  } finally {
    RefreshInFlight = false;
  }
}

/**
 * Bring the history column in line with the current view mode: poll while the
 * list is showing, stop (and drop the cells' markup) when it is not.
 */
export function SyncListView(): void {
  WireListHistoryTooltip();
  if (ViewMode === 'list') {
    FillListHistoryCells();
    if (!RefreshTimer) {
      RefreshTimer = setInterval(() => void RefreshListHistory(), LIST_HISTORY_REFRESH_MS);
    }
    void RefreshListHistory();
    return;
  }
  if (RefreshTimer) {
    clearInterval(RefreshTimer);
    RefreshTimer = null;
  }
  HideStatusTimelineTooltip(LIST_HISTORY_TOOLTIP_ID);
  DeselectCheckRows();
  ClearListSearch();
  FillListHistoryCells();
}

// Hovering a block shows the same per-minute breakdown the view modal does, in
// a tooltip of its own: the modal's lives inside the modal and is hidden with it.
function WireListHistoryTooltip(): void {
  if (Wired) return;
  Wired = true;
  const Hide = () => HideStatusTimelineTooltip(LIST_HISTORY_TOOLTIP_ID);
  $(document)
    .on('mousemove.listHistory', '#APPLICATION_CONTENT .LIST_HISTORY', function (e) {
      const Block = (e.target as Element).closest('.status-timeline-block');
      if (Block) ShowStatusTimelineTooltip(Block, e.clientX, e.clientY, LIST_HISTORY_TOOLTIP_ID);
      else Hide();
    })
    .on('mouseleave.listHistory', '#APPLICATION_CONTENT .LIST_HISTORY', Hide)
    // The chevron is inside the target's row, whose own click toggles its
    // selection; returning false keeps the two apart.
    .on('click.listExpand', '#APPLICATION_CONTENT .LIST_EXPAND', function () {
      const TargetID = String($(this).attr('data-target-id') || '');
      if (TargetID) SetTargetExpanded(TargetID, !IsTargetExpanded(TargetID));
      return false;
    })
    .on('dblclick.listExpand', '#APPLICATION_CONTENT .LIST_EXPAND', () => false);
  // Scrolling moves the row out from under a pointer that never moved.
  document.addEventListener('scroll', Hide, true);
  // A hidden window skips its refreshes; catch up the moment it is back.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && ViewMode === 'list') void RefreshListHistory();
  });
}
