// Client selection primitives (select / deselect / toggle / clear / count).
// Extracted from selection-init.ts (REFACTOR_PLAN.md Phase 7). This is a
// leaf module: it depends only on shared state + utils, so the ~6 modules that
// import these keep working via the selection-init barrel re-export.
import { AlertActionsEnabled, GroupSelectableUUIDCache, Selected, setSelected } from './state';
import { HandleNonFatalError } from './utils';

// The list view's check rows show as selected for as long as their target is:
// a selected target acts on all of its checks, so the rows say so. The
// inheritance is display only — the check ids are not added to the selection,
// or every action would run twice on the same device, once per target and once
// per check. A check selected on its own keeps that selection underneath, and
// it shows again when the target is deselected.
function MarkCheckRowsOf(UUID: string | undefined, ParentSelected: boolean) {
  const Value = String(UUID || '');
  if (!Value.startsWith('monitor:')) return;
  $(`.MONITOR_CHECK[data-target-id='${Value.slice('monitor:'.length)}']`).toggleClass(
    'PARENT_SELECTED',
    ParentSelected
  );
}

export function IsSelected(UUID: string) {
  return Selected.includes(UUID);
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
  try {
    const $tiles = $(`.SHOWTRAK_PC[data-uuid='${UUID}']`);
    if (!$tiles || !$tiles.length) return;
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }
  if (Selected.includes(String(UUID))) return;
  Selected.push(String(UUID));
  $(`.SHOWTRAK_PC[data-uuid='${UUID}']`).addClass('SELECTED');
  MarkCheckRowsOf(UUID, true);
  UpdateSelectionCount();
  return;
}

export function Deselect(UUID: string) {
  setSelected(Selected.filter((id) => id !== UUID));
  $(`.SHOWTRAK_PC[data-uuid='${UUID}']`).removeClass('SELECTED');
  MarkCheckRowsOf(UUID, false);
  UpdateSelectionCount();
  return;
}

export function ClearSelection() {
  Selected.forEach((uuid) => {
    $(`.SHOWTRAK_PC[data-uuid='${uuid}']`).removeClass('SELECTED');
  });
  setSelected([]);
  $('.MONITOR_CHECK.PARENT_SELECTED').removeClass('PARENT_SELECTED');
  UpdateSelectionCount();
  return;
}

// Select every selectable tile: adopted clients plus monitoring and dummy
// tiles (which carry prefixed data-uuid values). Groups are not selectable, and
// nor are the list view's check rows: their target is already being selected,
// and an action on both would run twice on the same device.
export function SelectAll() {
  $('.SHOWTRAK_PC[data-uuid]').each(function () {
    if ($(this).hasClass('GROUP') || $(this).hasClass('MONITOR_CHECK')) return;
    const UUID = $(this).attr('data-uuid');
    if (UUID) Select(UUID);
  });
}

export function ToggleSelection(UUID: string | undefined) {
  // Allow toggling adopted clients and pending-adoption devices.
  try {
    const $tiles = $(`.SHOWTRAK_PC[data-uuid='${UUID}']`);
    if (!$tiles || !$tiles.length) return;
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }
  if (Selected.includes(String(UUID))) {
    setSelected(Selected.filter((id) => id !== UUID));
    $(`.SHOWTRAK_PC[data-uuid='${UUID}']`).removeClass('SELECTED');
    MarkCheckRowsOf(UUID, false);
  } else {
    Selected.push(String(UUID));
    $(`.SHOWTRAK_PC[data-uuid='${UUID}']`).addClass('SELECTED');
    MarkCheckRowsOf(UUID, true);
  }
  UpdateSelectionCount();
}

export function SelectByGroup(GroupID: string | number | undefined) {
  if (!GroupSelectableUUIDCache.has(`${GroupID}`)) return;
  const UUIDs: string[] = GroupSelectableUUIDCache.get(`${GroupID}`);

  if (UUIDs.every((UUID) => IsSelected(UUID))) {
    UUIDs.forEach((UUID) => Deselect(UUID));
  } else {
    UUIDs.forEach((UUID) => Select(UUID));
  }
  return;
}
