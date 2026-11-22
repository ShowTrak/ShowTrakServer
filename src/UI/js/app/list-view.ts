// List view: the extra cells a tile carries for its table row, and the
// overall-status history drawn in each row's far-right column.
//
// The list is not a second rendering of the page. Every tile renders the same
// element in all three view modes, and body.list-mode lays it out as a table
// row (07-list-view.css). That is deliberate: selection, the context menu,
// double-click, the edit cog, drag-and-drop, the offline counters and every
// live in-place patch already target the tile, so they all keep working in the
// list without knowing it exists. This module only adds what a row has and a
// tile does not: a selection checkbox, a status word, and the history graph.
//
// The checkbox has no state of its own: CSS draws it from the tile's SELECTED
// class, so it cannot drift from the selection.
//
// A monitoring target can also be expanded into one row per check (rendered by
// monitoring.ts, beside the target's tile). Those rows exist only here, so a
// check's selection never outlives the list: collapsing a target, or leaving
// the list, drops it; an action must never land on a row nobody can see.
//
// A ShowTrak client or a FreeKiosk terminal (an item "owner") can likewise be
// expanded into one row per monitored item: a client's system checks,
// applications, USB devices, displays, audio endpoints, network interfaces and
// volumes; a terminal's armed readings. Each has its own history. Those rows
// are rendered here, only in the list, and are read-only: not selectable, not
// draggable, no menu of their own (a right-click is the owner's). Their
// history is gathered by the same overview read, for the expanded owners only.
// An owner is named by its tile's data-uuid: a client's UUID, `kiosk:<UUID>`.
import type { ClientView, FreeKioskTerminalView } from '@showtrak/protocol';
import {
  AllClients,
  DummyClients,
  FreeKioskMetricCatalogCache,
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
import {
  BuildClientItemHistoryBlocks,
  BuildFreeKioskItemHistoryBlocks,
  ClientItemRowKey,
  FreeKioskItemOwnerID,
  FreeKioskMonitoredItems,
  ClientItemsShapeKey,
  ClientItemStateClass,
  ClientItemStateWord,
  ClientMonitoredItems,
  type ClientItem,
} from './lib/client-items';
import { RefreshListSearch } from './list-filter';
import { IsArray } from '@showtrak/protocol/common';

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

// Which targets are expanded into their checks, and which owners (clients and
// terminals, by owner id) into their monitored items. Per viewer, remembered across restarts: they are a reading
// preference, not show data.
const EXPANDED_STORAGE_KEY = 'showtrak.ui.listExpandedTargets';
const EXPANDED_OWNERS_STORAGE_KEY = 'showtrak.ui.listExpandedOwners';
let ExpandedTargets: Set<string> | null = null;
let ExpandedOwners: Set<string> | null = null;

function LoadStoredSet(Key: string): Set<string> {
  const Out = new Set<string>();
  try {
    const Stored: unknown = JSON.parse(localStorage.getItem(Key) || '[]');
    if (IsArray(Stored)) for (const ID of Stored) Out.add(String(ID));
  } catch {
    // Unreadable or unavailable storage: start with everything collapsed.
  }
  return Out;
}

function LoadExpandedTargets(): Set<string> {
  if (!ExpandedTargets) ExpandedTargets = LoadStoredSet(EXPANDED_STORAGE_KEY);
  return ExpandedTargets;
}

function LoadExpandedOwners(): Set<string> {
  if (!ExpandedOwners) ExpandedOwners = LoadStoredSet(EXPANDED_OWNERS_STORAGE_KEY);
  return ExpandedOwners;
}

/** Whether an owner (a client UUID, or `kiosk:<UUID>`) is expanded into its items. */
export function IsOwnerExpanded(OwnerID: string): boolean {
  return LoadExpandedOwners().has(String(OwnerID));
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

function PersistExpandedOwners(): void {
  try {
    localStorage.setItem(EXPANDED_OWNERS_STORAGE_KEY, JSON.stringify([...LoadExpandedOwners()]));
  } catch (err) {
    HandleNonFatalError('ListView:PersistExpandedOwners', err);
  }
}

// Point a chevron's label at what a click will do now.
function SyncExpandToggle(Toggle: HTMLElement | null, Expanded: boolean): void {
  if (!Toggle) return;
  Toggle.setAttribute('aria-expanded', Expanded ? 'true' : 'false');
  const Label = String(Toggle.getAttribute('title') || '').replace(
    /^(Show|Hide)/,
    Expanded ? 'Hide' : 'Show'
  );
  Toggle.setAttribute('title', Label);
  Toggle.setAttribute('aria-label', Label);
}

// Bring one target's row and its check rows in line with its expanded state.
function ApplyTargetExpanded(TargetID: string, Expanded: boolean): void {
  const Tile = document.getElementById(`MONITOR_TILE_${TargetID}`);
  if (Tile) Tile.classList.toggle('CHECKS_EXPANDED', Expanded);
  SyncExpandToggle(Tile ? Tile.querySelector<HTMLElement>('.LIST_EXPAND') : null, Expanded);
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

function SetOwnersExpanded(OwnerIDs: string[], Expanded: boolean): void {
  const Owners = LoadExpandedOwners();
  let Opened = false;
  for (const OwnerID of OwnerIDs) {
    if (Expanded && !Owners.has(OwnerID)) Opened = true;
    if (Expanded) Owners.add(OwnerID);
    else Owners.delete(OwnerID);
    const Tile = OwnerTile(OwnerID);
    if (Tile) Tile.classList.toggle('CHECKS_EXPANDED', Expanded);
    SyncExpandToggle(
      Tile ? Tile.querySelector<HTMLElement>(':scope > .LIST_EXPAND') : null,
      Expanded
    );
    for (const Row of OwnerItemRows(OwnerID)) Row.classList.toggle('is-collapsed', !Expanded);
  }
  PersistExpandedOwners();
  // The rows have been drawn with the pending track until now: their history is
  // only read for expanded owners.
  if (Opened) void RefreshListHistory();
}

/**
 * Expand or collapse targets, clients and terminals from the keyboard (Ctrl/Cmd+Right /
 * Left): the selected ones when there are any, otherwise every one on the
 * page. List view only; nowhere else shows checks or items. Returns whether it
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
  const WithItems = AllOwners()
    .filter((Owner) => Owner.Items.length)
    .map((Owner) => Owner.ID);
  const SelectedOwners = Selected.map(String).filter((ID) => WithItems.includes(ID));
  // A selection narrows every kind: the selected targets and owners, or
  // (nothing selected of any) everything.
  const AnySelected = SelectedTargets.length > 0 || SelectedOwners.length > 0;
  const Scope = AnySelected ? WithChecks.filter((ID) => SelectedTargets.includes(ID)) : WithChecks;
  SetTargetsExpanded(Scope, Expanded);
  SetOwnersExpanded(AnySelected ? SelectedOwners : WithItems, Expanded);
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
 * `History: false`: a device not yet adopted has no history to show.
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
    const ItemClients = ExpandedClientList();
    const ItemKiosks = ExpandedKioskList();
    const Overview = await window.API.GetStatusHistoryOverview(
      ItemClients.length || ItemKiosks.length
        ? {
            Clients: ItemClients.map((Client) => Client.UUID),
            Kiosks: ItemKiosks.map((Terminal) => Terminal.UUID),
          }
        : undefined
    );
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
    const Now = Date.now();
    for (const ItemBlocks of [
      BuildClientItemHistoryBlocks(Overview.ClientItems, ItemClients, Now),
      BuildFreeKioskItemHistoryBlocks(
        Overview.KioskItems,
        ItemKiosks,
        FreeKioskMetricCatalogCache,
        Now
      ),
    ]) {
      for (const [Key, RowBlocks] of ItemBlocks) {
        HistoryCache.set(Key, RenderStatusTimeline(RowBlocks));
      }
    }
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
    // Item rows are only kept up to date while the list shows; bring them in
    // line with the clients and terminals as they are now.
    SyncAllItemRows();
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
      const OwnerID = String($(this).attr('data-owner-id') || '');
      if (OwnerID) SetOwnersExpanded([OwnerID], !IsOwnerExpanded(OwnerID));
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

// --- Monitored-item rows (ShowTrak clients and FreeKiosk terminals) ----------

/** An item owner as the rows need it: its id, its tile, its current items. */
interface ItemOwner {
  /** The tile's data-uuid: a client's UUID, or `kiosk:<UUID>`. */
  ID: string;
  TileID: string;
  Items: ClientItem[];
}

function ClientOwner(Client: ClientView): ItemOwner {
  const UUID = String(Client.UUID);
  return { ID: UUID, TileID: `CLIENT_TILE_${UUID}`, Items: ClientMonitoredItems(Client) };
}

function KioskOwner(Terminal: FreeKioskTerminalView): ItemOwner {
  const UUID = String(Terminal.UUID);
  return {
    ID: FreeKioskItemOwnerID(UUID),
    TileID: `FREEKIOSK_TILE_${UUID}`,
    Items: FreeKioskMonitoredItems(Terminal, FreeKioskMetricCatalogCache),
  };
}

function AllOwners(): ItemOwner[] {
  return [
    ...AllClients.filter((Client) => Client && Client.UUID).map(ClientOwner),
    ...FreeKioskTerminals.filter((Terminal) => Terminal && Terminal.UUID).map(KioskOwner),
  ];
}

function OwnerTile(OwnerID: string): HTMLElement | null {
  // Only tiles carry a data-uuid; item rows never do.
  return document.querySelector<HTMLElement>(
    `#APPLICATION_CONTENT .SHOWTRAK_PC[data-uuid="${CSS.escape(OwnerID)}"]`
  );
}

/** The expanded clients on the page, as they are now. */
function ExpandedClientList(): ClientView[] {
  const Expanded = LoadExpandedOwners();
  if (!Expanded.size) return [];
  return AllClients.filter((Client) => Client && Expanded.has(String(Client.UUID)));
}

/** The expanded FreeKiosk terminals on the page, as they are now. */
function ExpandedKioskList(): FreeKioskTerminalView[] {
  const Expanded = LoadExpandedOwners();
  if (!Expanded.size) return [];
  return FreeKioskTerminals.filter(
    (Terminal) => Terminal && Expanded.has(FreeKioskItemOwnerID(String(Terminal.UUID)))
  );
}

function OwnerItemRows(OwnerID: string): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(`.CLIENT_ITEM[data-owner-id="${CSS.escape(OwnerID)}"]`)
  );
}

/** The chevron on an owner's row that shows and hides its monitored items. */
function RenderOwnerExpandToggle(OwnerID: string, ItemCount: number): string {
  if (!ItemCount) return '';
  const Expanded = IsOwnerExpanded(OwnerID);
  const Label = `${Expanded ? 'Hide' : 'Show'} ${ItemCount} monitored item${ItemCount === 1 ? '' : 's'}`;
  return `<button type="button" class="LIST_EXPAND" data-owner-id="${Safe(OwnerID)}" aria-expanded="${
    Expanded ? 'true' : 'false'
  }" title="${Label}" aria-label="${Label}"><i class="bi bi-chevron-right"></i></button>`;
}

/**
 * One monitored item, as a row of the list view. A sibling of its owner's
 * tile, like a monitoring check's row, but read-only: it carries no data-uuid,
 * so nothing selects, drags or targets it.
 */
function ItemRowHtml(OwnerID: string, Item: ClientItem, Expanded: boolean): string {
  const Key = ClientItemRowKey(OwnerID, Item.Key);
  return `<div class="SHOWTRAK_PC CLIENT_ITEM ${ClientItemStateClass(Item.State)}${
    Expanded ? '' : ' is-collapsed'
  }" data-owner-id="${Safe(OwnerID)}" data-item-key="${Safe(Item.Key)}" data-flip-key="${Safe(
    Key
  )}" draggable="false">
      <h5 class="mb-0" data-type="Name">${Safe(Item.Name)}</h5>
      <label class="text-sm" data-type="Method">${Safe(Item.Kind)}</label>
      <small class="text-sm text-light" data-type="Address">${Safe(Item.Address)}</small>
      <div class="SHOWTRAK_PC_STATUS d-grid" data-type="CHECK_DETAIL">
        <h7 class="mb-0 text-light" data-type="CHECK_DETAIL_TEXT" title="${Safe(Item.Label)}">${Safe(
          Item.Label
        )}</h7>
      </div>
      ${RenderListRowCells(Key, ClientItemStateWord(Item.State))}
    </div>`;
}

/** What a tile carries for its monitored items in the list; see RenderClientItemParts. */
export interface ItemParts {
  /** The chevron, inside the tile. */
  Toggle: string;
  /** The item rows, after the tile. */
  Rows: string;
  /** What the rows were drawn for (the tile's data-item-shape). */
  Shape: string;
  /** Whether the tile should carry CHECKS_EXPANDED. */
  Expanded: boolean;
}

function RenderOwnerItemParts(Owner: ItemOwner): ItemParts {
  const Expanded = IsOwnerExpanded(Owner.ID);
  return {
    Toggle: RenderOwnerExpandToggle(Owner.ID, Owner.Items.length),
    Rows: Owner.Items.map((Item) => ItemRowHtml(Owner.ID, Item, Expanded)).join(''),
    Shape: ClientItemsShapeKey(Owner.Items),
    Expanded: Expanded && Owner.Items.length > 0,
  };
}

const NO_ITEM_PARTS: ItemParts = { Toggle: '', Rows: '', Shape: '', Expanded: false };

/**
 * A client tile's monitored-item parts. Nothing outside the list: the rows are
 * added when it is entered.
 */
export function RenderClientItemParts(Client: ClientView): ItemParts {
  return ViewMode === 'list' ? RenderOwnerItemParts(ClientOwner(Client)) : NO_ITEM_PARTS;
}

/** A FreeKiosk tile's monitored-item parts, as RenderClientItemParts. */
export function RenderFreeKioskItemParts(Terminal: FreeKioskTerminalView): ItemParts {
  return ViewMode === 'list' ? RenderOwnerItemParts(KioskOwner(Terminal)) : NO_ITEM_PARTS;
}

function SetText(El: Element | null, Text: string): void {
  if (El && El.textContent !== Text) El.textContent = Text;
}

function PatchItemRow(Row: HTMLElement, Item: ClientItem): void {
  const StateClass = ClientItemStateClass(Item.State);
  Row.classList.toggle('ONLINE', StateClass === 'ONLINE');
  Row.classList.toggle('DEGRADED', StateClass === 'DEGRADED');
  Row.classList.toggle('IDLE', StateClass === 'IDLE');
  for (const Child of Array.from(Row.children)) {
    switch (Child.getAttribute('data-type')) {
      case 'Name':
        SetText(Child, Item.Name);
        break;
      case 'Method':
        SetText(Child, Item.Kind);
        break;
      case 'Address':
        SetText(Child, Item.Address);
        break;
      case 'CHECK_DETAIL': {
        const Text = Child.firstElementChild;
        SetText(Text, Item.Label);
        if (Text && Text.getAttribute('title') !== Item.Label)
          Text.setAttribute('title', Item.Label);
        break;
      }
      case 'LIST_STATE':
        SetText(Child, ClientItemStateWord(Item.State));
        break;
    }
  }
}

/**
 * Bring an owner's item rows in line with it, after a live update. List view
 * only. The same items are patched in place; a different set (an item marked
 * or unmarked, a check armed or disarmed) redraws the rows and the chevron.
 */
function UpdateOwnerItemRows(Owner: ItemOwner): void {
  const Tile = document.getElementById(Owner.TileID);
  if (!Tile) return;
  const Items = Owner.Items;
  const Shape = ClientItemsShapeKey(Items);
  const Rows = OwnerItemRows(Owner.ID);
  if (Tile.getAttribute('data-item-shape') === Shape && Rows.length === Items.length) {
    Rows.forEach((Row, Index) => PatchItemRow(Row, Items[Index]!));
    return;
  }
  for (const Row of Rows) Row.remove();
  const Existing = Tile.querySelector(':scope > .LIST_EXPAND');
  if (Existing) Existing.remove();
  const Toggle = RenderOwnerExpandToggle(Owner.ID, Items.length);
  if (Toggle) {
    const Anchor = Tile.querySelector(':scope > .LIST_CHECK');
    if (Anchor) Anchor.insertAdjacentHTML('beforebegin', Toggle);
    else Tile.insertAdjacentHTML('beforeend', Toggle);
  }
  const Expanded = IsOwnerExpanded(Owner.ID);
  Tile.classList.toggle('CHECKS_EXPANDED', Expanded && Items.length > 0);
  Tile.setAttribute('data-item-shape', Shape);
  if (Items.length) {
    Tile.insertAdjacentHTML(
      'afterend',
      Items.map((Item) => ItemRowHtml(Owner.ID, Item, Expanded)).join('')
    );
    FillListHistoryCells();
    RefreshListSearch();
  }
}

/** Patch a client's item rows after a live update (list view only). */
export function UpdateClientItemRows(Client: ClientView): void {
  if (ViewMode !== 'list' || !Client || !Client.UUID) return;
  UpdateOwnerItemRows(ClientOwner(Client));
}

/** Patch a terminal's item rows after a poll (list view only). */
export function UpdateFreeKioskItemRows(Terminal: FreeKioskTerminalView): void {
  if (ViewMode !== 'list' || !Terminal || !Terminal.UUID) return;
  UpdateOwnerItemRows(KioskOwner(Terminal));
}

/**
 * Bring every owner's item rows in line (entering the list, or the FreeKiosk
 * metric catalogue arriving after the first render).
 */
export function SyncAllItemRows(): void {
  if (ViewMode !== 'list') return;
  for (const Owner of AllOwners()) {
    try {
      UpdateOwnerItemRows(Owner);
    } catch (err) {
      HandleNonFatalError('ListView:SyncItemRows', err);
    }
  }
}
