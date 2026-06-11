// Dummy Clients (renderer)
// Renders virtual heartbeat-driven dummy clients inline within their group's
// drop zone alongside real clients and monitoring targets, and provides the
// create/edit modal. Where a real client shows its version, a dummy shows the
// literal label "Dummy".

// Compute the compact-mode status shown to the right of the dummy's name.
// Offline dummies hide this label and show the offline timer instead.
function DummyCompactStatus(D) {
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
function DummyDisplayIP(IP) {
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

function RenderDummyClientTile(D) {
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
  return `
    <div id="DUMMY_TILE_${D.UUID}" class="SHOWTRAK_PC DUMMY ${TileStateClass}" data-dummy-uuid="${
      D.UUID
    }" data-uuid="${DragUUID}" draggable="${AppMode === 'EDIT' ? 'true' : 'false'}">
      <button type="button" class="CLIENT_TILE_COG DUMMY_TILE_COG" aria-label="Edit Dummy Client" title="Edit Dummy Client">
        <i class="bi bi-gear-fill"></i>
      </button>
      <label class="text-sm" data-type="DummyLabel">Dummy</label>
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
          Offline <span class="badge bg-ghost">00:00:00</span>
        </h7>
      </div>
    </div>`;
}

function UpdateDummyClientTile(D) {
  const $tile = $(`#DUMMY_TILE_${D.UUID}`);
  if (!$tile.length) return;
  const State = String(D.State || 'IDLE');
  const Online = !!D.Online;
  const Degraded = !!D.Degraded;
  $tile.toggleClass('ONLINE', Online && !Degraded);
  $tile.toggleClass('DEGRADED', Degraded);
  $tile.toggleClass('IDLE', State === 'IDLE');
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

  const ToggleIndicator = (Type, Show) => {
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

async function PopulateDummyGroupSelect(SelectedGroupID) {
  let Groups = await window.API.GetAllGroups();
  if (!Groups) Groups = [];
  Groups.push({ GroupID: null, Title: 'No Group', Weight: 100000 });
  const $select = $('#DUMMY_CLIENT_GROUPID');
  $select.html('');
  for (const Group of Groups) {
    $select.append(
      `<option value="${Group.GroupID}" ${
        SelectedGroupID == Group.GroupID ? 'selected' : ''
      }>${Safe(Group.Title)}</option>`
    );
  }
}

async function OpenDummyClientEditor(UUID = null) {
  await CloseAllModals();

  let Existing = null;
  if (UUID) {
    Existing = await window.API.GetDummyClient(UUID);
    if (!Existing) return Notify('Dummy client not found', 'error');
  }

  let Defaults = { DummyID: '', Nickname: '', Interval: 30000 };
  if (!Existing) {
    try {
      const Generated = await window.API.GenerateDummyClientDefaults();
      if (Generated) Defaults = Generated;
    } catch {
      // Non-fatal: fall back to empty defaults.
    }
  }

  DummyClientEditorUUID = Existing ? Existing.UUID : null;
  const D = Existing || Defaults;

  $('#DUMMY_CLIENT_MODAL_TITLE').text(Existing ? 'Edit Dummy Client' : 'Add Dummy Client');
  $('#DUMMY_CLIENT_DANGER_ZONE').toggleClass('d-none', !Existing);

  $('#DUMMY_CLIENT_TITLE').val(D.Nickname || '');
  $('#DUMMY_CLIENT_ID').val(D.DummyID || '');
  const Interval = Number(D.Interval) || 30000;
  $('#DUMMY_CLIENT_INTERVAL').val(Interval);
  $('#DUMMY_CLIENT_INTERVAL_LABEL').text(FormatInterval(Interval));

  await PopulateDummyGroupSelect(Existing ? Existing.GroupID : null);

  $('#DUMMY_CLIENT_INTERVAL')
    .off('input.dummy')
    .on('input.dummy', function () {
      $('#DUMMY_CLIENT_INTERVAL_LABEL').text(FormatInterval($(this).val()));
    });

  $('#DUMMY_CLIENT_SAVE')
    .off('click.dummy')
    .on('click.dummy', async () => {
      const DummyID = ($('#DUMMY_CLIENT_ID').val() || '').trim();
      const Nickname = ($('#DUMMY_CLIENT_TITLE').val() || '').trim();
      let GroupID = $('#DUMMY_CLIENT_GROUPID').val();
      if (GroupID == null || GroupID == 'null') {
        GroupID = null;
      } else {
        GroupID = parseInt(GroupID, 10);
      }
      const Interval = parseInt($('#DUMMY_CLIENT_INTERVAL').val(), 10);

      if (!DummyID) return Notify('Please enter an ID', 'error');
      if (!/^[A-Za-z0-9]+$/.test(DummyID))
        return Notify('ID must be alphanumeric with no spaces', 'error');

      const Payload = {
        DummyID,
        Nickname: Nickname || `Dummy ${DummyID.replace(/^DummyClient/, '')}`,
        Interval,
        GroupID,
      };

      try {
        if (DummyClientEditorUUID) {
          const [Err] = await window.API.UpdateDummyClient(DummyClientEditorUUID, Payload);
          if (Err) return Notify(Err, 'error');
          await Notify('Dummy client updated', 'success');
        } else {
          const [Err] = await window.API.CreateDummyClient(Payload);
          if (Err) return Notify(Err, 'error');
          await Notify('Dummy client created', 'success');
        }
        await CloseAllModals();
      } catch (e) {
        Notify(e && e.message ? e.message : 'Failed to save dummy client', 'error');
      }
    });

  $('#DUMMY_CLIENT_DELETE')
    .off('click.dummy')
    .on('click.dummy', async () => {
      if (!DummyClientEditorUUID) return;
      const Confirmation = await ConfirmationDialog(
        'Delete this dummy client? This cannot be undone.'
      );
      if (!Confirmation) return;
      const [Err] = await window.API.DeleteDummyClient(DummyClientEditorUUID);
      if (Err) return Notify(Err, 'error');
      await Notify('Dummy client deleted', 'success');
      await CloseAllModals();
    });

  $('#SHOWTRAK_MODAL_DUMMY_CLIENT').modal('show');
}
