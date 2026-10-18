import type { DummyClientView } from '@showtrak/protocol';
import { openModal } from './lib/modal';
import { OfflineBadgeContent } from './lib/status-badges';
import { AppMode, Selected, Tags } from './state';
import { ResolveEntityTags } from './lib/tag-badges';
import { RenderTagBadgeRow } from './lib/tag-badge-view';
import { DummyListState } from './lib/list-view';
import { RenderListRowCells, UpdateListRowState } from './list-view';
import { ErrorMessage, Safe } from './utils';
import { FormatInterval, OpenDummyClientHistory } from './monitoring';
import { CloseAllModals } from './modals';
import { Notify } from './selection-init';
import { BuildDummyPayload } from './lib/dummy-settings';
// Dummy Clients (renderer)
// Renders virtual heartbeat-driven dummy clients inline within their group's
// drop zone alongside real clients and monitoring targets, and provides the
// Add Dummy Client modal (an existing dummy is edited on its Settings tab). Where a real client shows its version, a dummy shows the
// literal label "Dummy".

// Compute the compact-mode status shown to the right of the dummy's name.
// Offline dummies hide this label and show the offline timer instead.
export const DUMMY_TYPE_LABEL = 'DUMMY';

export function DummyCompactStatus(D: DummyClientView) {
  const State = String(D.State || 'IDLE');
  const Online = !!D.Online;
  const Degraded = !!D.Degraded;
  if (State === 'OFFLINE') return { text: '', color: 'text-light', offline: true };
  if (Online && Degraded) {
    const Warning =
      Array.isArray(D.DegradedWarnings) && D.DegradedWarnings.length
        ? String(D.DegradedWarnings[0])
        : 'Missed Heartbeat';
    return { text: Warning, color: 'text-warning', offline: false };
  }
  if (Online) return { text: 'Online', color: 'text-light', offline: false };
  return { text: 'Idle', color: 'text-light', offline: false };
}

// Display helper for heartbeat source IP.
// Local loopback variants should always render as "localhost" in the UI.
export function DummyDisplayIP(IP: string | null) {
  const Raw = typeof IP === 'string' ? IP.trim() : '';
  if (!Raw) return 'Unknown IP';

  let Display = Raw;
  if (Display.startsWith('::ffff:')) Display = Display.substring(7);
  if (Display.startsWith('[') && Display.endsWith(']')) {
    Display = Display.substring(1, Display.length - 1);
  }

  const Normalized = Display.toLowerCase();
  if (
    Normalized === 'localhost' ||
    Normalized === '127.0.0.1' ||
    Normalized === '::1' ||
    Normalized === '0:0:0:0:0:0:0:1'
  ) {
    return 'localhost';
  }

  return Display;
}

export function RenderDummyClientTile(D: DummyClientView) {
  const State = String(D.State || 'IDLE');
  const Online = !!D.Online;
  const Degraded = !!D.Degraded;
  const Name = D.Nickname || D.DummyID || 'Dummy';
  const WarningText =
    Array.isArray(D.DegradedWarnings) && D.DegradedWarnings.length
      ? String(D.DegradedWarnings[0])
      : 'Missed Heartbeat';
  const TileStateClass = Degraded ? 'DEGRADED' : Online ? 'ONLINE' : State === 'IDLE' ? 'IDLE' : '';
  const DragUUID = `dummy:${D.UUID}`;
  const Compact = DummyCompactStatus(D);
  // A dummy is scoped by its bare UUID (the `dummy:` prefix above is a drag/
  // selection key, not a scope ID) — the scope dropdown stores `client:<UUID>`
  // for dummies exactly as it does for ShowTrak clients.
  const TagBadges = RenderTagBadgeRow(
    ResolveEntityTags(Tags, { ScopedID: String(D.UUID), GroupID: D.GroupID ?? null })
  );
  return `
    <div id="DUMMY_TILE_${D.UUID}" class="SHOWTRAK_PC DUMMY ${TileStateClass}${
      Selected.includes(DragUUID) ? ' SELECTED' : ''
    }" data-dummy-uuid="${
      D.UUID
    }" data-uuid="${DragUUID}" data-flip-key="${DragUUID}" draggable="${AppMode === 'EDIT' ? 'true' : 'false'}">
      <button type="button" class="CLIENT_TILE_COG DUMMY_TILE_COG" aria-label="Edit Dummy Client" title="Edit Dummy Client">
        <i class="bi bi-gear-fill"></i>
      </button>
      <label class="text-sm ${TagBadges ? 'd-none' : ''}" data-type="DummyLabel">${DUMMY_TYPE_LABEL}</label>
      ${TagBadges}
      <h5 class="mb-0" data-type="Name">${Safe(Name)}</h5>
      <span class="CLIENT_TILE_COMPACT_STATUS DUMMY_COMPACT_STATUS ${Compact.color}${
        Compact.offline ? ' d-none' : ''
      }" data-type="DUMMY_COMPACT_STATUS">${Safe(Compact.text)}</span>
      <small class="text-sm text-light" data-type="IP">${Safe(DummyDisplayIP(D.IP))}</small>
      <div class="SHOWTRAK_PC_STATUS ${
        State === 'IDLE' ? 'd-grid' : 'd-none'
      }" data-type="INDICATOR_IDLE">
        <h7 class="mb-0 text-light" data-type="DUMMY_IDLE_LABEL">Idle</h7>
      </div>
      <div class="SHOWTRAK_PC_STATUS ${
        Online && !Degraded ? 'd-grid' : 'd-none'
      }" data-type="INDICATOR_ONLINE">
        <h7 class="mb-0 text-light" data-type="DUMMY_ONLINE_LABEL">Online</h7>
      </div>
      <div class="SHOWTRAK_PC_STATUS ${
        Online && Degraded ? 'd-grid' : 'd-none'
      }" data-type="INDICATOR_DEGRADED">
        <h7 class="mb-0 text-warning" data-type="DEGRADED_WARNING">${Safe(WarningText)}</h7>
      </div>
      <div class="SHOWTRAK_PC_STATUS ${
        State === 'OFFLINE' ? 'd-grid' : 'd-none'
      }" data-type="INDICATOR_OFFLINE">
        <h7 class="mb-0" data-type="OFFLINE_SINCE" data-offlinesince="${D.LastSeen || ''}">
          ${OfflineBadgeContent()}
        </h7>
      </div>
      ${RenderListRowCells(DragUUID, DummyListState(D))}
    </div>`;
}

export function UpdateDummyClientTile(D: DummyClientView) {
  const $tile = $(`#DUMMY_TILE_${D.UUID}`);
  if (!$tile.length) return;
  const State = String(D.State || 'IDLE');
  const Online = !!D.Online;
  const Degraded = !!D.Degraded;
  $tile.toggleClass('ONLINE', Online && !Degraded);
  $tile.toggleClass('DEGRADED', Degraded);
  $tile.toggleClass('IDLE', State === 'IDLE');
  $tile.find('[data-type="DummyLabel"]').text(DUMMY_TYPE_LABEL);
  $tile.find('[data-type="Name"]').text(D.Nickname || D.DummyID || 'Dummy');
  $tile.find('[data-type="IP"]').text(DummyDisplayIP(D.IP));

  const WarningText =
    Array.isArray(D.DegradedWarnings) && D.DegradedWarnings.length
      ? String(D.DegradedWarnings[0])
      : 'Missed Heartbeat';
  $tile.find('[data-type="DEGRADED_WARNING"]').text(WarningText);

  // Keep the compact-mode status label (name-row badge) in sync.
  const Compact = DummyCompactStatus(D);
  $tile
    .find('[data-type="DUMMY_COMPACT_STATUS"]')
    .text(Compact.text)
    .removeClass('text-light text-success text-warning')
    .addClass(Compact.color)
    .toggleClass('d-none', Compact.offline);
  UpdateListRowState($tile, DummyListState(D));

  const ToggleIndicator = (Type: string, Show: boolean) => {
    $tile
      .find(`.SHOWTRAK_PC_STATUS[data-type="${Type}"]`)
      .toggleClass('d-grid', Show)
      .toggleClass('d-none', !Show);
  };
  ToggleIndicator('INDICATOR_IDLE', State === 'IDLE');
  ToggleIndicator('INDICATOR_ONLINE', Online && !Degraded);
  ToggleIndicator('INDICATOR_DEGRADED', Online && Degraded);
  ToggleIndicator('INDICATOR_OFFLINE', State === 'OFFLINE');
  $tile.find('[data-type="OFFLINE_SINCE"]').attr('data-offlinesince', D.LastSeen || '');
}

/** Fill a group <select> with every group, then No Group. */
export async function PopulateDummyGroupSelect(Selector: string, SelectedGroupID: number | null) {
  let Groups = await window.API.GetAllGroups();
  if (!Groups) Groups = [];
  Groups.push({
    GroupID: null,
    Title: 'No Group',
    Weight: 100000,
  } as unknown as (typeof Groups)[number]);
  const $select = $(Selector);
  $select.html('');
  for (const Group of Groups) {
    $select.append(
      `<option value="${Group.GroupID}" ${
        SelectedGroupID == Group.GroupID ? 'selected' : ''
      }>${Safe(Group.Title)}</option>`
    );
  }
}

/**
 * The Add Dummy Client modal. An existing dummy's settings live on the Settings
 * tab of its view modal (dummy-info-edit.ts), so a UUID opens that instead.
 */
export async function OpenDummyClientEditor(UUID: string | null | undefined = null) {
  if (UUID) return OpenDummyClientHistory(String(UUID), { Tab: 'settings' });
  await CloseAllModals();

  let Defaults = { DummyID: '', Nickname: '', Interval: 30000 };
  try {
    const Generated = await window.API.GenerateDummyClientDefaults();
    if (Generated) Defaults = Generated;
  } catch {
    // Non-fatal: fall back to empty defaults.
  }

  $('#DUMMY_CLIENT_TITLE').val(Defaults.Nickname || '');
  $('#DUMMY_CLIENT_ID').val(Defaults.DummyID || '');
  const Interval = Number(Defaults.Interval) || 30000;
  $('#DUMMY_CLIENT_INTERVAL').val(Interval);
  $('#DUMMY_CLIENT_INTERVAL_LABEL').text(FormatInterval(Interval));

  await PopulateDummyGroupSelect('#DUMMY_CLIENT_GROUPID', null);

  $('#DUMMY_CLIENT_INTERVAL')
    .off('input.dummy')
    .on('input.dummy', function () {
      $('#DUMMY_CLIENT_INTERVAL_LABEL').text(FormatInterval($(this).val()));
    });

  $('#DUMMY_CLIENT_SAVE')
    .off('click.dummy')
    .on('click.dummy', async () => {
      const { Payload, Error } = BuildDummyPayload({
        DummyID: String($('#DUMMY_CLIENT_ID').val() || ''),
        Nickname: String($('#DUMMY_CLIENT_TITLE').val() || ''),
        GroupID: String($('#DUMMY_CLIENT_GROUPID').val() ?? ''),
        Interval: String($('#DUMMY_CLIENT_INTERVAL').val() ?? ''),
      });
      if (!Payload) return Notify(Error, 'error');
      try {
        const [Err] = await window.API.CreateDummyClient(Payload);
        if (Err) return Notify(Err, 'error');
        await Notify('Dummy client created.', 'success');
        await CloseAllModals();
      } catch (e) {
        Notify(ErrorMessage(e, 'Failed to save dummy client'), 'error');
      }
    });

  openModal('SHOWTRAK_MODAL_DUMMY_CLIENT');
}
