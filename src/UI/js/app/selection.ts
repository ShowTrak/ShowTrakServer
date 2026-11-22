// Client selection primitives (select / deselect / toggle / clear / count).
// Extracted from selection-init.ts (REFACTOR_PLAN.md Phase 7). This is a
// leaf module: it depends only on shared state + utils (and the search filter,
// itself a leaf), so the ~6 modules that
// import these keep working via the selection-init barrel re-export.
//
// The selection is the shared `Selected` array (other modules read it), with a
// Set kept beside it for membership. Bulk changes (Select All, a group header)
// look every tile up in one pass and update the count and the search once:
// selecting one tile at a time ran two page-wide queries, a linear search of
// the selection, a count update and a search refresh per tile, so Ctrl+A on
// 500 tiles was about a thousand scans of the page.
import { AlertActionsEnabled, GroupSelectableUUIDCache, Selected, setSelected } from './state';
import { HandleNonFatalError } from './utils';
import { IsHiddenByListSearch, RefreshListSearch } from './list-filter';

const MONITOR_PREFIX = 'monitor:';

// Membership index over `Selected`. Rebuilt whenever the array is replaced or
// its length moves without going through here, so it can never disagree.
let SelectedIndex = new Set<string>();
let IndexedArray: string[] | null = null;
let IndexedLength = -1;

function SelectedSet(): Set<string> {
  if (IndexedArray !== Selected || IndexedLength !== Selected.length) {
    SelectedIndex = new Set(Selected.map(String));
    IndexedArray = Selected;
    IndexedLength = Selected.length;
  }
  return SelectedIndex;
}

function AddToSelected(UUID: string) {
  const Index = SelectedSet();
  if (Index.has(UUID)) return;
  Selected.push(UUID);
  Index.add(UUID);
  IndexedLength = Selected.length;
}

function RemoveFromSelected(UUIDs: ReadonlySet<string>) {
  if (!UUIDs.size) return;
  setSelected(Selected.filter((id) => !UUIDs.has(String(id))));
}

function TilesFor(UUID: string | undefined): JQuery<HTMLElement> {
  return $(`.SHOWTRAK_PC[data-uuid='${UUID}']`);
}

/** Every tile and row on the page by data-uuid, from a single query. */
function TileMap(): Map<string, HTMLElement[]> {
  const Out = new Map<string, HTMLElement[]>();
  for (const El of Array.from(document.querySelectorAll<HTMLElement>('.SHOWTRAK_PC[data-uuid]'))) {
    const UUID = El.getAttribute('data-uuid') || '';
    const List = Out.get(UUID);
    if (List) List.push(El);
    else Out.set(UUID, [El]);
  }
  return Out;
}

// The list view's check rows show as selected for as long as their target is:
// a selected target acts on all of its checks, so the rows say so. The
// inheritance is display only: the check ids are not added to the selection,
// or every action would run twice on the same device, once per target and once
// per check. A check selected on its own keeps that selection underneath, and
// it shows again when the target is deselected.
function MarkCheckRowsOf(UUID: string | undefined, ParentSelected: boolean) {
  const Value = String(UUID || '');
  if (!Value.startsWith(MONITOR_PREFIX)) return;
  $(`.MONITOR_CHECK[data-target-id='${Value.slice(MONITOR_PREFIX.length)}']`).toggleClass(
    'PARENT_SELECTED',
    ParentSelected
  );
}

/** MarkCheckRowsOf for many targets, from a single query. */
function MarkCheckRowsOfMany(UUIDs: readonly string[], ParentSelected: boolean) {
  const TargetIDs = new Set(
    UUIDs.filter((UUID) => UUID.startsWith(MONITOR_PREFIX)).map((UUID) =>
      UUID.slice(MONITOR_PREFIX.length)
    )
  );
  if (!TargetIDs.size) return;
  for (const Row of Array.from(
    document.querySelectorAll<HTMLElement>('.MONITOR_CHECK[data-target-id]')
  )) {
    if (TargetIDs.has(Row.getAttribute('data-target-id') || '')) {
      Row.classList.toggle('PARENT_SELECTED', ParentSelected);
    }
  }
}

export function IsSelected(UUID: string) {
  return SelectedSet().has(String(UUID));
}

export function UpdateSelectionCount() {
  // Drive the mobile bottom-bar controls (clear-selection + Actions), which are
  // only shown while at least one client is selected.
  try {
    document.body.classList.toggle('has-selection', Selected.length > 0);
  } catch (err) {
    HandleNonFatalError('SelectionInit:UpdateSelectionCountBodyClass', err);
  }

  const $status = $('#SELECTION_STATUS');
  if (!$status || !$status.length) return;

  if (!AlertActionsEnabled) {
    $status.text('Alert actions are currently disabled').addClass('text-danger');
    return;
  }

  $status
    .text(`${Selected.length} ${Selected.length == 1 ? 'Target' : 'Targets'} Selected`)
    .removeClass('text-danger');
  return;
}

export function Select(UUID: string | undefined) {
  // Allow selecting adopted clients and pending-adoption devices. Monitoring
  // and dummy tiles use prefixed data-uuid values so they never match here.
  let $tiles: JQuery<HTMLElement>;
  try {
    $tiles = TilesFor(UUID);
    if (!$tiles || !$tiles.length) return;
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
    return;
  }
  if (IsSelected(String(UUID))) return;
  AddToSelected(String(UUID));
  $tiles.addClass('SELECTED');
  MarkCheckRowsOf(UUID, true);
  UpdateSelectionCount();
  RefreshListSearch();
  return;
}

export function Deselect(UUID: string) {
  RemoveFromSelected(new Set([String(UUID)]));
  TilesFor(UUID).removeClass('SELECTED');
  MarkCheckRowsOf(UUID, false);
  UpdateSelectionCount();
  // A row kept on show only because it was selected drops out of a search.
  RefreshListSearch();
  return;
}

// Select every UUID in the list that has a tile on the page; one pass over the
// page, one count update and one search refresh however many there are.
function SelectMany(UUIDs: readonly string[], Tiles: Map<string, HTMLElement[]> = TileMap()) {
  const Added: string[] = [];
  for (const Raw of UUIDs) {
    const UUID = String(Raw);
    const Els = Tiles.get(UUID);
    if (!Els || !Els.length || IsSelected(UUID)) continue;
    AddToSelected(UUID);
    for (const El of Els) El.classList.add('SELECTED');
    Added.push(UUID);
  }
  if (!Added.length) return;
  MarkCheckRowsOfMany(Added, true);
  UpdateSelectionCount();
  RefreshListSearch();
}

// The bulk counterpart of Deselect.
function DeselectMany(UUIDs: readonly string[], Tiles: Map<string, HTMLElement[]> = TileMap()) {
  const Removed = new Set(UUIDs.map(String));
  if (!Removed.size) return;
  RemoveFromSelected(Removed);
  for (const UUID of Removed) {
    for (const El of Tiles.get(UUID) || []) El.classList.remove('SELECTED');
  }
  MarkCheckRowsOfMany([...Removed], false);
  UpdateSelectionCount();
  RefreshListSearch();
}

export function ClearSelection() {
  if (Selected.length) {
    const Tiles = TileMap();
    for (const UUID of Selected) {
      for (const El of Tiles.get(String(UUID)) || []) El.classList.remove('SELECTED');
    }
  }
  setSelected([]);
  $('.MONITOR_CHECK.PARENT_SELECTED').removeClass('PARENT_SELECTED');
  UpdateSelectionCount();
  RefreshListSearch();
  return;
}

// Select every selectable tile: adopted clients plus monitoring and dummy
// tiles (which carry prefixed data-uuid values). Groups are not selectable, and
// nor are the list view's check rows: their target is already being selected,
// and an action on both would run twice on the same device.
export function SelectAll() {
  const Tiles = TileMap();
  const UUIDs: string[] = [];
  for (const Els of Tiles.values()) {
    for (const El of Els) {
      if (El.classList.contains('GROUP') || El.classList.contains('MONITOR_CHECK')) continue;
      // A search's hidden rows are out of reach of Select All.
      if (El.classList.contains('LIST_SEARCH_HIDDEN')) continue;
      const UUID = El.getAttribute('data-uuid');
      if (UUID) UUIDs.push(UUID);
    }
  }
  SelectMany(UUIDs, Tiles);
}

export function ToggleSelection(UUID: string | undefined) {
  // Allow toggling adopted clients and pending-adoption devices.
  let $tiles: JQuery<HTMLElement>;
  try {
    $tiles = TilesFor(UUID);
    if (!$tiles || !$tiles.length) return;
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
    return;
  }
  if (IsSelected(String(UUID))) {
    RemoveFromSelected(new Set([String(UUID)]));
    $tiles.removeClass('SELECTED');
    MarkCheckRowsOf(UUID, false);
  } else {
    AddToSelected(String(UUID));
    $tiles.addClass('SELECTED');
    MarkCheckRowsOf(UUID, true);
  }
  UpdateSelectionCount();
  RefreshListSearch();
}

export function SelectByGroup(GroupID: string | number | undefined) {
  if (!GroupSelectableUUIDCache.has(`${GroupID}`)) return;
  // While the list is searched, the group is the rows of it that are showing.
  const UUIDs: string[] = GroupSelectableUUIDCache.get(`${GroupID}`)!.filter(
    (UUID: string) => !IsHiddenByListSearch(UUID)
  );

  if (UUIDs.every((UUID) => IsSelected(UUID))) {
    DeselectMany(UUIDs);
  } else {
    SelectMany(UUIDs);
  }
  return;
}
