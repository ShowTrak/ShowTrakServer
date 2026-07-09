// Client selection primitives (select / deselect / toggle / clear / count).
// Extracted from 14-selection-init.ts (REFACTOR_PLAN.md Phase 7). This is a
// leaf module: it depends only on shared state + utils, so the ~6 modules that
// import these keep working via the 14-selection-init barrel re-export.
import { AlertActionsEnabled, GroupUUIDCache, Selected, setSelected } from './01-state';
import { HandleNonFatalError } from './04-utils';

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
    .text(`${Selected.length} ${Selected.length == 1 ? 'Client' : 'Clients'} Selected`)
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
  UpdateSelectionCount();
  return;
}

export function Deselect(UUID: string) {
  setSelected(Selected.filter((id) => id !== UUID));
  $(`.SHOWTRAK_PC[data-uuid='${UUID}']`).removeClass('SELECTED');
  UpdateSelectionCount();
  return;
}

export function ClearSelection() {
  Selected.forEach((uuid) => {
    $(`.SHOWTRAK_PC[data-uuid='${uuid}']`).removeClass('SELECTED');
  });
  setSelected([]);
  UpdateSelectionCount();
  return;
}

// Select every selectable tile: adopted clients plus monitoring and dummy
// tiles (which carry prefixed data-uuid values). Groups are not selectable.
export function SelectAll() {
  $('.SHOWTRAK_PC[data-uuid]').each(function () {
    if ($(this).hasClass('GROUP')) return;
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
  } else {
    Selected.push(String(UUID));
    $(`.SHOWTRAK_PC[data-uuid='${UUID}']`).addClass('SELECTED');
  }
  UpdateSelectionCount();
}

export function SelectByGroup(GroupID: string | number | undefined) {
  if (!GroupUUIDCache.has(`${GroupID}`)) return;
  const UUIDs: string[] = GroupUUIDCache.get(`${GroupID}`);

  if (UUIDs.every((UUID) => IsSelected(UUID))) {
    UUIDs.forEach((UUID) => Deselect(UUID));
  } else {
    UUIDs.forEach((UUID) => Select(UUID));
  }
  return;
}
