// Search: Ctrl/Cmd+F opens a box over the top right of the client list, in any
// view mode, and typing in it hides every row (or tile) that does not match
// (lib/list-filter.ts decides which), and every group left with nothing
// showing, empty groups included.
//
// The filter is a way of looking at the list, not part of it: Escape drops it,
// and it carries across a switch of view mode. It hides rows with a class
// rather than leaving them out of the render, so the full re-render, the live
// in-place patches and the selection all keep working on rows that are merely
// out of sight, and the filter is put back on the fresh DOM after each render.
//
// A selected row always shows, matched or not, so a search never hides what an
// action is about to run on; deselect it and it drops out. Select All and a
// group header's click select only what is showing.
import {
  DummyClients,
  FreeKioskTerminals,
  MonitoringTargets,
  PendingAdoption,
  Selected,
  Tags,
  __LastClients,
  __LastGroups,
} from './state';
import { HandleNonFatalError } from './utils';
import { BuildGroupRenderOrder } from './lib/client-list-layout';
import {
  BuildListSearchIndex,
  KeepSelectedRows,
  MatchListSearch,
  ParseListSearch,
} from './lib/list-filter';

const HIDDEN_CLASS = 'LIST_SEARCH_HIDDEN';

let Query = '';
let RefreshQueued = false;
let Wired = false;
/** data-uuid of every row the current search hides. */
const HiddenKeys = new Set<string>();

function SearchBox(): HTMLElement | null {
  return document.getElementById('LIST_SEARCH');
}

function SearchInput(): HTMLInputElement | null {
  return document.getElementById('LIST_SEARCH_INPUT') as HTMLInputElement | null;
}

/** Whether a search is hiding this row (by its data-uuid). */
export function IsHiddenByListSearch(Key: string): boolean {
  return HiddenKeys.has(String(Key));
}

/** Open the search box and put the cursor in it. */
export function OpenListSearch(): boolean {
  WireListSearch();
  const Box = SearchBox();
  const Input = SearchInput();
  if (!Box || !Input) return false;
  Box.classList.remove('d-none');
  Input.focus();
  Input.select();
  return true;
}

/** Drop the search and close the box. */
export function ClearListSearch(): void {
  const Box = SearchBox();
  const Input = SearchInput();
  if (Input) {
    Input.value = '';
    if (document.activeElement === Input) Input.blur();
  }
  if (Box) Box.classList.add('d-none');
  if (!Query && !HiddenKeys.size) return;
  Query = '';
  ApplyListSearch();
}

/**
 * Put the current search on the rendered list: hide the rows it neither matches
 * nor finds selected, then every group (and the Discover section) with no row
 * left showing.
 */
export function ApplyListSearch(): void {
  const Content = document.getElementById('APPLICATION_CONTENT');
  const Terms = ParseListSearch(Query);
  document.body.classList.toggle('list-searching', Terms.length > 0);
  HiddenKeys.clear();
  if (!Content) return;

  if (!Terms.length) {
    for (const El of Array.from(Content.querySelectorAll(`.${HIDDEN_CLASS}`))) {
      El.classList.remove(HIDDEN_CLASS);
    }
    RenderMatchCount(0, 0, false);
    return;
  }

  const Matched = MatchListSearch(
    BuildListSearchIndex({
      Groups: BuildGroupRenderOrder(__LastGroups),
      Tags,
      Clients: __LastClients,
      Monitors: MonitoringTargets,
      Dummies: DummyClients,
      Kiosks: FreeKioskTerminals,
      Pending: PendingAdoption,
    }),
    Terms
  );
  const Keep = KeepSelectedRows(Matched, Selected, MonitoringTargets);

  // Counted as matches: a selected row kept on show is not one.
  let Matches = 0;
  let Total = 0;
  for (const Row of Array.from(Content.querySelectorAll<HTMLElement>('.SHOWTRAK_PC[data-uuid]'))) {
    // A check row goes wherever its target goes.
    const IsCheck = Row.classList.contains('MONITOR_CHECK');
    const Key = IsCheck
      ? `monitor:${Row.getAttribute('data-target-id') || ''}`
      : Row.getAttribute('data-uuid') || '';
    const Hidden = !Keep.has(Key);
    Row.classList.toggle(HIDDEN_CLASS, Hidden);
    if (IsCheck) continue;
    Total++;
    if (Hidden) HiddenKeys.add(Key);
    if (Matched.has(Key)) Matches++;
  }
  const Sections = Content.querySelectorAll<HTMLElement>(
    '.group-column-item, #PENDING_ADOPTION_SECTION'
  );
  for (const Section of Array.from(Sections)) {
    const Showing = Section.querySelector(`.SHOWTRAK_PC[data-uuid]:not(.${HIDDEN_CLASS})`);
    Section.classList.toggle(HIDDEN_CLASS, !Showing);
  }
  RenderMatchCount(Matches, Total, true);
}

/**
 * Re-apply after a live in-place patch (a renamed client, a new IP) or a change
 * of selection, coalesced to one pass per frame however many land. Nothing to
 * do with no search.
 */
export function RefreshListSearch(): void {
  if (!Query || RefreshQueued) return;
  RefreshQueued = true;
  requestAnimationFrame(() => {
    RefreshQueued = false;
    try {
      ApplyListSearch();
    } catch (err) {
      HandleNonFatalError('ListSearch:Refresh', err);
    }
  });
}

function RenderMatchCount(Matches: number, Total: number, Searching: boolean): void {
  const Count = document.getElementById('LIST_SEARCH_COUNT');
  if (!Count) return;
  Count.textContent = !Searching ? '' : Matches ? `${Matches} of ${Total}` : 'No Matches';
  Count.classList.toggle('is-empty', Searching && !Matches);
}

function WireListSearch(): void {
  if (Wired) return;
  const Input = SearchInput();
  if (!Input) return;
  Wired = true;
  Input.addEventListener('input', () => {
    Query = Input.value;
    ApplyListSearch();
  });
  // The page's own shortcuts stand down while the cursor is in a text field
  // (keyboard.ts), so the box answers its own.
  Input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      ClearListSearch();
      return;
    }
    // Enter keeps the filter and hands the keyboard back to the list, so
    // Ctrl/Cmd+A and the rest act on the rows that are showing.
    if (e.key === 'Enter') {
      e.preventDefault();
      Input.blur();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      Input.select();
    }
  });
  // An empty box that loses focus has nothing to show; put it away.
  Input.addEventListener('blur', () => {
    if (!Input.value.trim()) ClearListSearch();
  });
  document.getElementById('LIST_SEARCH_CLEAR')?.addEventListener('click', () => ClearListSearch());
}
