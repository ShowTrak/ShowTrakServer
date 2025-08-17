var Config = {};

let Selected = [];
let AllClients = [];
let ScriptList = [];
const GroupUUIDCache = new Map();
// Pending adoption devices (unadopted clients discovered by the server)
let PendingAdoption = [];
// Cache last full lists to allow partial re-render when only pending changes
let __LastClients = [];
let __LastGroups = [];

let SettingsGroups = [];
let Settings = [];
let SettingDebounceTimers = new Map();
// Track which client is open in the Client Info modal for live updates
let ClientInfoOpenUUID = null;
let ClientInfoRefreshTimer = null;
let __clientInfoRefreshInFlight = false;

// --- Application Mode (SHOW | EDIT) ---
let AppMode = 'SHOW'; // default visual state until backend confirms
function RenderMode(mode) {
  AppMode = String(mode).toUpperCase() === 'EDIT' ? 'EDIT' : 'SHOW';
  // Highlight the active button
  const btnShow = document.getElementById('MODE_BTN_SHOW');
  const btnEdit = document.getElementById('MODE_BTN_EDIT');
  if (btnShow && btnEdit) {
    const activeClasses = ['btn-light', 'text-dark'];
    const inactiveClasses = ['btn-outline-light', 'text-light'];

    // reset
    btnShow.classList.remove(...activeClasses, ...inactiveClasses);
    btnEdit.classList.remove(...activeClasses, ...inactiveClasses);

    if (AppMode === 'SHOW') {
      btnShow.classList.add(...activeClasses);
      btnEdit.classList.add(...inactiveClasses);
    } else {
      btnEdit.classList.add(...activeClasses);
      btnShow.classList.add(...inactiveClasses);
    }
  }
  document.body.classList.toggle('mode-edit', AppMode === 'EDIT');
}

// Subscribe to backend push updates
window.API.OnModeUpdated((mode) => {
  RenderMode(mode);
  // Re-evaluate drag state when mode changes
  if (typeof initializeEditInteractions === 'function') {
    try {
      initializeEditInteractions();
    } catch {}
  }
  // Refresh discover/adopt section visibility when mode changes
  try {
    const html = RenderPendingAdoptionSection();
    const $existing = $('#PENDING_ADOPTION_SECTION');
    if ($existing.length) {
      $existing.replaceWith(html);
    } else if (AppMode === 'EDIT' && $('#APPLICATION_CONTENT').length) {
      $('#APPLICATION_CONTENT').append(html);
    }
  } catch {}
});

// Wire the toggle to backend
document.addEventListener('DOMContentLoaded', async () => {
  // Wire new button group
  const btnShow = document.getElementById('MODE_BTN_SHOW');
  const btnEdit = document.getElementById('MODE_BTN_EDIT');
  if (btnShow && !btnShow.dataset.bound) {
    btnShow.addEventListener('click', async () => {
      await window.API.SetMode('SHOW');
    });
    btnShow.dataset.bound = '1';
  }
  if (btnEdit && !btnEdit.dataset.bound) {
    btnEdit.addEventListener('click', async () => {
      await window.API.SetMode('EDIT');
    });
    btnEdit.dataset.bound = '1';
  }
  // Initialize with backend mode
  try {
    const mode = await window.API.GetMode();
    RenderMode(mode);
  } catch {}
});

async function GetSettingValue(Key) {
  if (Settings.length == 0) Settings = await window.API.GetSettings();
  let Setting = Settings.find((s) => s.Key === Key);
  if (!Setting) return null;
  return Setting.Value;
}

let Sounds = {
  Notification: new Howl({
    src: ['audio/alert_1.wav'],
    volume: 0.5,
  }),
  Alert: new Howl({
    src: ['audio/alert_2.wav'],
    volume: 0.5,
  }),
  Warning: new Howl({
    src: ['audio/alert_3.wav'],
    volume: 0.5,
  }),
};

window.API.PlaySound(async (SoundName) => {
  let sound = Sounds[SoundName] || Sounds.Notification;
  sound.play();
});

window.API.UpdateSettings(async (NewSettings, NewSettingsGroups) => {
  Settings = NewSettings;
  SettingsGroups = NewSettingsGroups;

  $('#SETTINGS').html('');

  for (const Group of SettingsGroups) {
    $(`#SETTINGS`).append(`<div class="bg-ghost-light p-2 rounded">
			<strong class="text-start">
				${Group.Title}
			</strong>
		</div>`);
    let GroupSettings = Settings.filter((s) => s.Group == Group.Name);
    for (const Setting of GroupSettings) {
      if (Setting.Type === 'BOOLEAN') {
        $(`#SETTINGS`)
          .append(`<div class="bg-ghost p-2 rounded d-flex justify-content-between text-start">
					<div class="d-grid">
						<span>${Setting.Title}</span>
						<span class="text-sm mb-0">${Setting.Description}</span>
					</div>
					<div class="form-check form-switch">
						<input class="form-check-input" style="margin-top: 0.6em !important;" type="checkbox" id="SETTING_${Setting.Key}" ${
              Setting.Value ? 'checked' : ''
            }>
					</div>
				</div>`);
        $(`#SETTING_${Setting.Key}`)
          .off('change')
          .on('change', async function () {
            let NewValue = $(this).is(':checked');
            if (NewValue === Setting.Value) return;
            let Set = Settings.find((s) => s.Key === Setting.Key);
            Set.Value = NewValue;
            Setting.Value = NewValue;
            await window.API.SetSetting(Setting.Key, NewValue);
            Notify(
              `[${Setting.Title}] ${NewValue ? 'Enabled' : 'Disabled'}`,
              NewValue ? 'success' : 'error'
            );
          });
      } else if (Setting.Type === 'STRING') {
        $(`#SETTINGS`).append(`<div class="bg-ghost p-2 rounded d-grid gap-1 text-start">
					<div class="d-grid">
						<span>${Setting.Title}</span>
						<span class="text-sm mb-0">${Setting.Description}</span>
					</div>
					<input type="text" class="form-control form-control-sm bg-ghost-light text-light border-0" id="SETTING_${
            Setting.Key
          }" value="${Safe(Setting.Value)}" placeholder="Enter text..." />
				</div>`);
        $(`#SETTING_${Setting.Key}`)
          .off('input')
          .on('input', function () {
            let el = $(this);
            let NewValue = el.val();
            if (SettingDebounceTimers.has(Setting.Key))
              clearTimeout(SettingDebounceTimers.get(Setting.Key));
            SettingDebounceTimers.set(
              Setting.Key,
              setTimeout(async () => {
                if (NewValue === Setting.Value) return;
                let Set = Settings.find((s) => s.Key === Setting.Key);
                Set.Value = NewValue;
                Setting.Value = NewValue;
                await window.API.SetSetting(Setting.Key, NewValue);
                Notify(`[${Setting.Title}] Saved`, 'success', 1200);
              }, 600)
            );
          });
      } else if (Setting.Type === 'INTEGER') {
        $(`#SETTINGS`).append(`<div class="bg-ghost p-2 rounded d-grid gap-1 text-start">
					<div class="d-grid">
						<span>${Setting.Title}</span>
						<span class="text-sm mb-0">${Setting.Description}</span>
					</div>
					<input type="number" class="form-control form-control-sm bg-ghost-light text-light border-0" id="SETTING_${
            Setting.Key
          }" value="${Safe(Setting.Value)}" step="1" />
				</div>`);
        $(`#SETTING_${Setting.Key}`)
          .off('input')
          .on('input', function () {
            let el = $(this);
            let Raw = el.val();
            if (SettingDebounceTimers.has(Setting.Key))
              clearTimeout(SettingDebounceTimers.get(Setting.Key));
            SettingDebounceTimers.set(
              Setting.Key,
              setTimeout(async () => {
                let NewValue = parseInt(Raw, 10);
                if (isNaN(NewValue)) NewValue = Setting.Value; // keep previous until valid
                if (NewValue === Setting.Value) return;
                let Set = Settings.find((s) => s.Key === Setting.Key);
                Set.Value = NewValue;
                Setting.Value = NewValue;
                await window.API.SetSetting(Setting.Key, NewValue);
                Notify(`[${Setting.Title}] Saved (${NewValue})`, 'success', 1200);
              }, 600)
            );
          });
      } else if (Setting.Type === 'OPTION') {
        let optionsHtml = '';
        if (Array.isArray(Setting.Options)) {
          for (const opt of Setting.Options) {
            optionsHtml += `<option value="${Safe(opt)}" ${Setting.Value === opt ? 'selected' : ''}>${Safe(
              opt
            )}</option>`;
          }
        }
        $(`#SETTINGS`).append(`<div class="bg-ghost p-2 rounded d-grid gap-1 text-start">
					<div class="d-grid">
						<span>${Setting.Title}</span>
						<span class="text-sm mb-0">${Setting.Description}</span>
					</div>
					<select class="form-select form-select-sm bg-ghost-light text-light border-0" id="SETTING_${Setting.Key}">${optionsHtml}</select>
				</div>`);
        $(`#SETTING_${Setting.Key}`)
          .off('change')
          .on('change', async function () {
            let NewValue = $(this).val();
            if (NewValue === Setting.Value) return;
            let Set = Settings.find((s) => s.Key === Setting.Key);
            Set.Value = NewValue;
            Setting.Value = NewValue;
            await window.API.SetSetting(Setting.Key, NewValue);
            Notify(`[${Setting.Title}] ${NewValue}`, 'success', 1200);
          });
      }
    }
  }

  return;
});

function Safe(Input) {
  if (typeof Input === 'string') {
    return Input.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  if (typeof Input === 'number') {
    return Input.toString();
  }
  if (Array.isArray(Input)) {
    return Input.map(Safe);
  }
  return Input;
}

// Format bytes into a short human-readable string (e.g., 15.2 GB)
function FormatBytes(bytes) {
  const n = typeof bytes === 'number' ? bytes : parseFloat(bytes);
  if (!isFinite(n) || n < 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let idx = 0;
  let val = n;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  const precision = val >= 10 || idx === 0 ? 0 : 1; // keep 1 decimal for small MB/GB
  return `${val.toFixed(precision)} ${units[idx]}`;
}

document.addEventListener('keydown', function (e) {
  // Suppress global shortcuts while a confirmation prompt is active
  if (window.__SHOWTRAK_CONFIRM_ACTIVE) {
    return;
  }
  // Ctrl/Cmd + Q opens context menu centered
  if (
    (e.ctrlKey || e.metaKey) &&
    !e.shiftKey &&
    !e.altKey &&
    !e.repeat &&
    e.key.toLowerCase() === 'q'
  ) {
    e.preventDefault();
    try {
      const pageWidth = $(window).width();
      const pageHeight = $(window).height();
      const centerX = Math.floor(pageWidth / 2);
      const centerY = Math.floor(pageHeight / 2);
      const evt = $.Event('contextmenu');
      evt.pageX = centerX;
      evt.pageY = centerY;
      $('html').trigger(evt);
    } catch {}
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    return ClearSelection();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    return AllClients.map((UUID) => Select(UUID));
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    return ClearSelection();
  }
  // Open context menu via keyboard: standard Windows bindings
  if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
    e.preventDefault();
    try {
      const pageWidth = $(window).width();
      const pageHeight = $(window).height();
      const centerX = Math.floor(pageWidth / 2);
      const centerY = Math.floor(pageHeight / 2);
      const evt = $.Event('contextmenu');
      evt.pageX = centerX;
      evt.pageY = centerY;
      $('html').trigger(evt);
    } catch {}
    return;
  }

  // Alerts tray shortcuts
  try {
    // Keyboard Shortcuts menu: Ctrl+K
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      ShowShortcutsModal();
      return;
    }
    // Toggle alerts: Ctrl+Y
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      ToggleAlertsTray();
      return;
    }
    // Dismiss all alerts: Ctrl+U (global)
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'u') {
      e.preventDefault();
      DismissAllAlerts();
      return;
    }
    // Close alerts tray: Esc, only if open
    if (AlertsVisible && e.key === 'Escape') {
      e.preventDefault();
      ToggleAlertsTray(false);
      return;
    }
  } catch {}
});

window.API.ShutdownRequested(async () => {
  await CloseAllModals();
  let Confirmation = await ConfirmationDialog('Are you sure you want to shutdown ShowTrak?');
  if (!Confirmation) return;
  await window.API.Shutdown();
});

window.API.USBDeviceAdded(async (Client, Device) => {
  AddAlert({
    type: 'usb',
    severity: 'info',
    title: `${Safe(Device.ManufacturerName || 'Generic')} ${Safe(Device.ProductName || 'USB Device')} connected`,
    message: `${Safe(Client.Nickname || Client.Hostname)} (${Safe(Client.Hostname)})`,
    clientUUID: Client.UUID,
  });
  // If Client Info modal is open for this client, refresh its details
  try {
    const $modal = $('#SHOWTRAK_CLIENT_INFO');
    if (ClientInfoOpenUUID && ClientInfoOpenUUID === Client.UUID && $modal.hasClass('show')) {
      const fresh = await window.API.GetClient(Client.UUID);
      if (fresh) RenderClientInfoDetails(fresh);
    }
  } catch {}
});
window.API.USBDeviceRemoved(async (Client, Device) => {
  AddAlert({
    type: 'usb',
    severity: 'warning',
    title: `${Safe(Device.ManufacturerName || 'Generic')} ${Safe(Device.ProductName || 'USB Device')} removed`,
    message: `${Safe(Client.Nickname || Client.Hostname)} (${Safe(Client.Hostname)})`,
    clientUUID: Client.UUID,
  });
  // If Client Info modal is open for this client, refresh its details
  try {
    const $modal = $('#SHOWTRAK_CLIENT_INFO');
    if (ClientInfoOpenUUID && ClientInfoOpenUUID === Client.UUID && $modal.hasClass('show')) {
      const fresh = await window.API.GetClient(Client.UUID);
      if (fresh) RenderClientInfoDetails(fresh);
    }
  } catch {}
});

window.API.UpdateScriptExecutions(async (Executions) => {
  // Close any open popovers before re-render to prevent duplicates
  try {
    $('.exec-info.open').removeClass('open');
  } catch {}
  Executions = Executions.reverse();

  // Determine if all executions are for the same action/script
  const names = Array.from(
    new Set(
      Executions.map((r) =>
        r && r.Script && r.Script.Name ? String(r.Script.Name).trim() : null
      ).filter(Boolean)
    )
  );
  const uniformScriptName = names.length === 1 ? names[0] : null;

  // Ensure toast exists and is visible with dynamic title
  ShowExecutionToast(uniformScriptName || 'Script Executions');

  const $list = $('#SHOWTRAK_EXECUTION_LIST');
  if ($list.length === 0) return;

  let Filler = '';

  function durationText(ms) {
    let cls = 'text-success';
    if (ms > 2000) cls = 'text-danger';
    else if (ms > 800) cls = 'text-warning';
    return `<small class="exec-duration ${cls}">${Safe(ms)}ms</small>`;
  }

  for (let i = 0; i < Executions.length; i++) {
    const Request = Executions[i];
    const clientName = Request.Client.Nickname
      ? Safe(Request.Client.Nickname)
      : Safe(Request.Client.Hostname);
    const scriptName = Request.Script && Request.Script.Name ? Safe(Request.Script.Name) : '';
    let statusBadge = ''; // Remove visual badges; use icon instead
    let timeBadge = '';
    let actionsHtml = ''; // right-side icon area (only rendered if non-empty)
    let errorBlock = ''; // error details below the row

    if (Request.Timer && typeof Request.Timer.Duration === 'number') {
      timeBadge = durationText(Request.Timer.Duration);
    }

    if (Request.Status === 'Completed') {
      // Success check icon in the actions area
      actionsHtml = `<span class="exec-btn-icon exec-success" role="img" aria-label="Completed"><i class="bi bi-check-circle-fill"></i></span>`;
    } else if (Request.Status === 'Failed') {
      // Passive info icon (no click behavior)
      actionsHtml = `<span class="exec-btn-icon" role="img" aria-label="Failed"><i class="bi bi-info-circle"></i></span>`;
      if (Request.Error) {
        const err = Safe(Request.Error);
        errorBlock = `<pre class="exec-error">${err}</pre>`;
      }
    }

    Filler += `
			<div class="exec-item">
				<div class="exec-row">
					<div class="exec-left">
						<span class="badge bg-ghost-light text-light">${clientName}</span>
						${uniformScriptName ? '' : `<span class="badge bg-ghost-light text-light">${scriptName}</span>`}
					</div>
					<div class="exec-right">
						${timeBadge}
						${statusBadge}
						${actionsHtml ? `<div class=\"exec-actions\">${actionsHtml}</div>` : ''}
					</div>
				</div>
				${errorBlock}
			</div>`;
  }

  $list.html(Filler);
  return;
});

window.API.SetScriptList(async (Scripts) => {
  ScriptList = Scripts;
  return;
});

window.API.SetFullClientList(async (Clients, Groups) => {
  // cache latest full lists
  __LastClients = Array.isArray(Clients) ? Clients : [];
  __LastGroups = Array.isArray(Groups) ? Groups : [];
  AllClients = Clients.map((Client) => Client.UUID);
  let Filler = '';

  Groups.push({
    GroupID: null,
    Title: 'No Group',
    Weight: 100000,
  });

  // Sort groups by weight
  Groups = Groups.sort((a, b) => (a.Weight || 0) - (b.Weight || 0));

  if (Groups.length == 1 && Clients.length == 0) {
    Filler += `<div class="bg-ghost rounded m-3 mb-0 d-grid gap-0 gap-3 p-3">
            <h5 class="text-light mb-0">
                Welcome to ShowTrak Server v${Safe(Config.Application.Version)}
            </h5>
            <p class="text-light mb-0">
                You don't have any clients configured yet. Discover clients on your network and adopt them with the Adoption Manager below.
            </p>
        </div>`;
  }

  for (const { GroupID, Title } of Groups) {
    let GroupClients = Clients.filter((Client) => Client.GroupID === GroupID).sort(
      (a, b) => (a.Weight || 0) - (b.Weight || 0)
    );

    GroupUUIDCache.set(
      `${GroupID}`,
      GroupClients.map((c) => c.UUID)
    );

    if (GroupClients.length == 0 && GroupID == null) continue;

    Filler += `<div class="d-flex justify-content-start">
		<div class="GROUP_TITLE_CLICKABLE m-3 me-0 mb-0 rounded" onclick="SelectByGroup('${GroupID}')">
			<div class="d-flex align-items-center text-center h-100">
				<span class="GROUP_TITLE py-2">
					${Safe(Title)}
				</span>
			</div>
		</div>
	<div class="bg-ghost rounded m-3 mb-0 d-flex flex-wrap justify-content-start align-items-center p-3 gap-3 w-100 group-drop-zone" data-groupid="${GroupID}">`;

    if (GroupClients.length == 0) {
      Filler += `<div class="SHOWTRAK_PC_PLACEHOLDER w-100 p-3"
				<h5 class="text-muted mb-0">
					Empty Group
				</h5>
				<p class="text-muted mb-0">
					This group has no clients assigned to it.
				</p>
				<p class="text-muted mb-0">
					You can add clients to this group via the client editor!
				</p>
			</div>`;
    } else {
      for (const { Nickname, Hostname, IP, UUID, Version, Online, LastSeen } of GroupClients) {
        Filler += `<div ID="CLIENT_TILE_${UUID}" class="SHOWTRAK_PC ${Online ? 'ONLINE' : ''} ${
          Selected.includes(UUID) ? 'SELECTED' : ''
        }" data-uuid="${UUID}" draggable="${AppMode === 'EDIT' ? 'true' : 'false'}">
					<button type="button" class="CLIENT_TILE_COG" aria-label="Edit Client" title="Edit Client">
						<i class="bi bi-gear-fill"></i>
					</button>
					<label class="text-sm" data-type="Hostname">
						${Nickname && Nickname.length ? Safe(Hostname) + ' - v' + Version : 'v' + Version}
					</label>
					<h5 class="mb-0" data-type="Nickname">
					${Nickname && Nickname.length ? Safe(Nickname) : Safe(Hostname)}
					</h5>
					<small class="text-sm text-light" data-type="IP">
						${IP ? Safe(IP) : 'Unknown IP'}
					</small>
					<div class="SHOWTRAK_PC_STATUS ${Online ? 'd-grid' : 'd-none'} gap-2" data-type="INDICATOR_ONLINE">
						<div class="progress">
							<div data-type="CPU" class="progress-bar bg-white" role="progressbar" style="width: 0%;"></div>
						</div>
						<div class="progress">
							<div data-type="RAM" class="progress-bar bg-white" role="progressbar" style="width: 0%;"></div>
						</div>
					</div>
					<div class="SHOWTRAK_PC_STATUS ${Online ? 'd-none' : 'd-grid'}" data-type="INDICATOR_OFFLINE">
						<h7 class="mb-0" data-type="OFFLINE_SINCE" data-offlinesince="${LastSeen}">
							OFFLINE <span class="badge bg-ghost">00:00:00</span>
						</h7>
					</div>
				</div>`;
      }
    }

    Filler += `</div></div>`;
  }

  // Filler += `<div class="d-flex justify-content-start">
	// 	<div class="GROUP_TITLE_CLICKABLE m-3 me-0 rounded" onclick="OpenGroupCreationModal()">
	// 		<div class="d-flex align-items-center text-center h-100">
	// 			<span class="GROUP_CREATE_BUTTON py-2">+</span>
	// 		</div>
	// 	</div>
	// </div>`;

  // Append Pending Adoption section after groups, if any
  Filler += RenderPendingAdoptionSection();

  $('#APPLICATION_CONTENT').html(Filler);
  // Initialize or teardown edit-mode interactions after render
  if (typeof initializeEditInteractions === 'function') {
    try {
      initializeEditInteractions();
    } catch {}
  }
});

// Renderer receives live updates for devices pending adoption
window.API.SetDevicesPendingAdoption(async (Devices) => {
  const previous = Array.isArray(PendingAdoption) ? PendingAdoption : [];
  const next = Array.isArray(Devices) ? Devices : [];
  // Build fast lookup maps
  const prevMap = new Map(previous.map((d) => [d.UUID, d]));
  const nextMap = new Map(next.map((d) => [d.UUID, d]));

  // 1) Add alerts for newly available devices
  for (const dev of next) {
    const uuid = dev && dev.UUID;
    if (!uuid) continue;
    if (!prevMap.has(uuid) && !PendingAdoptionAlerts.has(uuid)) {
      const title = 'Device available for adoption';
      const msg = `${Safe(dev.Hostname || 'Unknown Host')} (${Safe(dev.IP || 'Unknown IP')})`;
      const id = AddAlert({
        type: 'adoption',
        severity: 'info',
        title,
        message: msg,
        clientUUID: uuid,
        iconHtml: '<i class="bi bi-person-plus"></i>',
      });
      PendingAdoptionAlerts.set(uuid, id);
    }
  }

  // 2) Auto-dismiss alerts for devices that are no longer pending (adopted/removed) or state changed to Adopting
  for (const dev of previous) {
    const uuid = dev && dev.UUID;
    if (!uuid) continue;
    const stillPending = nextMap.has(uuid);
    const now = nextMap.get(uuid);
    const status = now && (now.State || now.status || now.state);
    const shouldDismiss = !stillPending || String(status).toLowerCase() === 'adopting';
    if (shouldDismiss && PendingAdoptionAlerts.has(uuid)) {
      const alertId = PendingAdoptionAlerts.get(uuid);
      DismissAlert(alertId);
      PendingAdoptionAlerts.delete(uuid);
    }
  }

  PendingAdoption = next;
  // If main content already rendered, update/insert the section in place
  try {
    if (AppMode !== 'EDIT') {
      const $existing = $('#PENDING_ADOPTION_SECTION');
      if ($existing.length) $existing.replaceWith('<div id="PENDING_ADOPTION_SECTION"></div>');
      return;
    }
    const html = RenderPendingAdoptionSection();
    const $existing = $('#PENDING_ADOPTION_SECTION');
    if ($existing.length) {
      $existing.replaceWith(html);
    } else {
      // If no section yet (e.g., first update before full list), append to content if present
      if ($('#APPLICATION_CONTENT').length) {
        $('#APPLICATION_CONTENT').append(html);
      }
    }
  } catch {}
});

function RenderPendingAdoptionSection() {
  try {
  if (AppMode !== 'EDIT') return '<div id="PENDING_ADOPTION_SECTION"></div>';
    const list = Array.isArray(PendingAdoption) ? PendingAdoption : [];
    if (!list.length) return '<div id="PENDING_ADOPTION_SECTION"></div>';
    let html = '';
    html += `<div id="PENDING_ADOPTION_SECTION" class="d-flex justify-content-start">`;
    html += `  <div class="GROUP_TITLE_CLICKABLE m-3 me-0 mb-0 rounded">`;
    html += `    <div class="d-flex align-items-center text-center h-100">`;
    html += `      <span class="GROUP_TITLE py-2">DISCOVER</span>`;
    html += `    </div>`;
    html += `  </div>`;
    html += `  <div class="bg-ghost rounded m-3 mb-0 d-flex flex-wrap justify-content-start align-items-center p-3 gap-3 w-100">`;
    for (const dev of list) {
      const Hostname = dev && dev.Hostname ? dev.Hostname : 'Unknown Host';
      const IP = dev && dev.IP ? dev.IP : 'Unknown IP';
      const Version = dev && dev.Version ? dev.Version : 'X.X.X';
      const UUID = dev && dev.UUID ? dev.UUID : '';
      html += `
        <div class="SHOWTRAK_PC PENDING" data-uuid="${Safe(UUID)}">
          <h5 class="mb-0">${Safe(Hostname)}</h5>
          <small class="text-sm text-light">${Safe(IP)}</small>
          <div class="d-grid">
            <button class="btn btn-sm btn-light SHOWTRAK_BTN_ROUNDED ADOPT_BTN" data-uuid="${Safe(
              UUID
            )}">Adopt</button>
          </div>
        </div>`;
    }
    html += `  </div>`;
    html += `</div>`;
    return html;
  } catch (e) {
    return '<div id="PENDING_ADOPTION_SECTION"></div>';
  }
}

// Global event delegation for Adopt buttons (works across re-renders)
document.addEventListener('click', async (e) => {
  const target = e.target;
  if (!(target && target.classList && target.classList.contains('ADOPT_BTN'))) return;
  // Prevent bubbling to tile click handler (which toggles selection)
  try { e.preventDefault(); e.stopPropagation(); } catch {}
  const btn = target;
  const UUID = btn.getAttribute('data-uuid');
  if (!UUID) return;
  try {
    btn.disabled = true;
    btn.textContent = 'Adopting…';
    // Auto-dismiss any existing adoption alert for this UUID immediately
    try {
      const id = PendingAdoptionAlerts.get(UUID);
      if (id) { DismissAlert(id); PendingAdoptionAlerts.delete(UUID); }
    } catch {}
    await window.API.AdoptDevice(UUID);
  } catch {
    btn.disabled = false;
    btn.textContent = 'Adopt';
  }
});

// Drag & Drop reordering/move (only active in EDIT mode)
let DnDState = {
  dragUUID: null,
  sourceGroupId: null,
  ghostEl: null,
  currentOverGroup: null,
  rowIndex: null,
};

function initializeEditInteractions() {
  const isEdit = AppMode === 'EDIT';
  $('.SHOWTRAK_PC').attr('draggable', isEdit);
  if (!isEdit) {
    teardownDnD();
    return;
  }
  setupDnD();
}

// Build and show the Keyboard Shortcuts modal
function ShowShortcutsModal() {
  try {
    $('#KEYBOARD_SHORTCUTS_LIST').html('');
  } catch {}
  const items = [];
  // Core selection/navigation (Ctrl or Cmd)
  items.push({ title: 'Select All', shortcut: 'Ctrl/Cmd+A' });
  items.push({ title: 'Clear Selection', shortcut: 'Ctrl/Cmd+D' });
  // Alerts
  items.push({ title: 'Toggle Alerts', shortcut: 'Ctrl/Cmd+Y' });
  items.push({ title: 'Dismiss All Alerts', shortcut: 'Ctrl/Cmd+U' });
  // Modals/UI
  items.push({ title: 'Open Keyboard Shortcuts', shortcut: 'Ctrl/Cmd+K' });
  items.push({ title: 'Close current modal / alerts tray', shortcut: 'Esc' });
  // Context menu
  items.push({ title: 'Open Context Menu (global)', shortcut: 'Ctrl/Cmd+Q' });
  items.push({ title: 'Open Context Menu', shortcut: 'Menu key/Shift+F10' });

  const $list = $('#KEYBOARD_SHORTCUTS_LIST');
  const formatShortcut = (text) => {
    const parts = String(text)
      .split('+')
      .map((p) => p.trim());
    const html = parts
      .map((part) => {
        if (part.includes('/')) {
          return part
            .split('/')
            .map((p) => `<kbd>${Safe(p.trim())}</kbd>`)
            .join('<span class="key-sep">/</span>');
        }
        return `<kbd>${Safe(part)}</kbd>`;
      })
      .join('<span class="key-plus"> + </span>');
    return html;
  };
  if ($list && $list.length) {
    for (const it of items) {
      $list.append(`
				<div class="bg-ghost rounded p-2 d-flex justify-content-between align-items-center">
					<div>${Safe(it.title)}</div>
					<div class="text-sm text-light">${formatShortcut(it.shortcut)}</div>
				</div>
			`);
    }
  }
  $('#SHOWTRAK_MODAL_SHORTCUTS').modal('show');
}

function teardownDnD() {
  if (DnDState.ghostEl && DnDState.ghostEl.remove) {
    try {
      DnDState.ghostEl.remove();
    } catch {}
  }
  DnDState = {
    dragUUID: null,
    sourceGroupId: null,
    ghostEl: null,
    currentOverGroup: null,
    rowIndex: null,
  };
  $(document).off('dragstart.dnd dragend.dnd dragover.dnd dragenter.dnd dragleave.dnd drop.dnd');
}

function setupDnD() {
  // Avoid duplicate bindings
  $(document).off('dragstart.dnd dragend.dnd dragover.dnd dragenter.dnd dragleave.dnd drop.dnd');

  $(document).on('dragstart.dnd', '.SHOWTRAK_PC', function (e) {
    if (AppMode !== 'EDIT') return;
    const uuid = $(this).attr('data-uuid');
    DnDState.dragUUID = uuid;
    const $group = $(this).closest('.group-drop-zone');
    DnDState.sourceGroupId = normalizeGroupId($group.attr('data-groupid'));
    try {
      e.originalEvent.dataTransfer.setData('text/plain', uuid);
      e.originalEvent.dataTransfer.effectAllowed = 'move';
    } catch {}
    $(this).addClass('dragging');
  });

  $(document).on('dragend.dnd', '.SHOWTRAK_PC', function () {
    $(this).removeClass('dragging');
    clearGhost();
    if (DnDState.currentOverGroup) $(DnDState.currentOverGroup).removeClass('dnd-over');
    DnDState.currentOverGroup = null;
    DnDState.rowIndex = null;
    DnDState.dragUUID = null;
  });

  $(document).on('dragover.dnd', '.group-drop-zone', function (e) {
    if (AppMode !== 'EDIT') return;
    e.preventDefault();
    const container = this;
    if (DnDState.currentOverGroup !== container) {
      $(DnDState.currentOverGroup).removeClass('dnd-over');
      $(container).addClass('dnd-over');
      DnDState.currentOverGroup = container;
    }
    const mouseX = e.originalEvent.clientX;
    const mouseY = e.originalEvent.clientY;
    positionGhostMarker(container, mouseX, mouseY);
  });

  $(document).on('dragleave.dnd', '.group-drop-zone', function (e) {
    if (AppMode !== 'EDIT') return;
    if (!this.contains(e.relatedTarget)) {
      $(this).removeClass('dnd-over');
      clearGhost();
      DnDState.currentOverGroup = null;
    }
  });

  $(document).on('drop.dnd', '.group-drop-zone', async function (e) {
    if (AppMode !== 'EDIT') return;
    e.preventDefault();
    const targetGroupId = normalizeGroupId($(this).attr('data-groupid'));
    const dragUUID = DnDState.dragUUID;
    if (!dragUUID) return;
    const order = computeOrderWithGhost(this, dragUUID);
    clearGhost();
    $(this).removeClass('dnd-over');
    DnDState.currentOverGroup = null;
    try {
      await window.API.SetGroupOrder(targetGroupId, order);
    } catch {}
  });
}

function normalizeGroupId(val) {
  if (val === undefined || val === null || String(val) === 'null' || String(val) === '')
    return null;
  const num = parseInt(val, 10);
  return isNaN(num) ? null : num;
}

function createGhostEl() {
  const el = document.createElement('div');
  el.className = 'dnd-ghost';
  el.setAttribute('aria-hidden', 'true');
  el.style.pointerEvents = 'none';
  return el;
}

function clearGhost() {
  if (DnDState.ghostEl && DnDState.ghostEl.parentNode) {
    DnDState.ghostEl.parentNode.removeChild(DnDState.ghostEl);
  }
  DnDState.ghostEl = null;
}

function positionGhostMarker(container, x, y) {
  const tiles = Array.from(container.querySelectorAll('.SHOWTRAK_PC:not(.dragging)')).filter(
    (el) => !el.classList.contains('dnd-ghost')
  );
  const HYSTERESIS_X = 6; // horizontal jitter buffer within a row
  const ROW_TOL = 14; // tolerance to group tiles into rows
  const ROW_STICKY = 16; // vertical stickiness to keep current row
  const EDGE_X = 12; // edge stickiness at start/end of rows
  const EDGE_Y = 12; // vertical edge tolerance for group start/end

  if (tiles.length === 0) {
    if (!DnDState.ghostEl) DnDState.ghostEl = createGhostEl();
    DnDState.ghostEl.style.width = '220px';
    DnDState.ghostEl.style.height = '110px';
    container.appendChild(DnDState.ghostEl);
    return;
  }

  // Compute rects and rows (group by top within tolerance)
  const rects = tiles
    .map((t) => ({ el: t, r: t.getBoundingClientRect() }))
    .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);
  const rows = [];
  for (const o of rects) {
    const last = rows[rows.length - 1];
    if (!last || Math.abs(o.r.top - last.top) > ROW_TOL) {
      rows.push({ top: o.r.top, bottom: o.r.bottom, tiles: [o], left: o.r.left, right: o.r.right });
    } else {
      last.tiles.push(o);
      last.top = Math.min(last.top, o.r.top);
      last.bottom = Math.max(last.bottom, o.r.bottom);
      last.left = Math.min(last.left, o.r.left);
      last.right = Math.max(last.right, o.r.right);
    }
  }
  // Useful group edges
  const firstRow = rows[0];
  const lastRow = rows[rows.length - 1];

  // Start-of-group zone: snap before first
  const firstTile = tiles[0];
  const firstRect = rects[0].r;
  if (
    (x <= firstRow.left + EDGE_X && y <= firstRow.bottom + EDGE_Y) ||
    y <= firstRect.top - EDGE_Y
  ) {
    if (!DnDState.ghostEl) DnDState.ghostEl = createGhostEl();
    const ghost = DnDState.ghostEl;
    ghost.style.width = `${firstRect.width}px`;
    ghost.style.height = `${firstRect.height}px`;
    firstTile.parentNode.insertBefore(ghost, firstTile);
    return;
  }

  // End-of-group zone: snap after last
  const lastTile = tiles[tiles.length - 1];
  const lastRect = rects[rects.length - 1].r;
  if ((x >= lastRow.right - EDGE_X && y >= lastRow.top - EDGE_Y) || y >= lastRow.bottom - 2) {
    if (!DnDState.ghostEl) DnDState.ghostEl = createGhostEl();
    const ghost = DnDState.ghostEl;
    ghost.style.width = `${lastRect.width}px`;
    ghost.style.height = `${lastRect.height}px`;
    container.appendChild(ghost);
    return;
  }

  // Determine active row with hysteresis
  let rowIdx = -1;
  // Keep previous row if cursor still within its sticky band
  if (DnDState.rowIndex !== null && rows[DnDState.rowIndex]) {
    const prev = rows[DnDState.rowIndex];
    if (y >= prev.top - ROW_STICKY && y <= prev.bottom + ROW_STICKY) {
      rowIdx = DnDState.rowIndex;
    }
  }
  if (rowIdx === -1) {
    // Prefer a row whose band contains the cursor
    for (let i = 0; i < rows.length; i++) {
      const rw = rows[i];
      if (y >= rw.top - ROW_STICKY && y <= rw.bottom + ROW_STICKY) {
        rowIdx = i;
        break;
      }
    }
  }
  if (rowIdx === -1) {
    // Fallback: closest by vertical distance to row center
    let bestD = Infinity;
    for (let i = 0; i < rows.length; i++) {
      const rw = rows[i];
      const cy = (rw.top + rw.bottom) / 2;
      const d = Math.abs(y - cy);
      if (d < bestD) {
        bestD = d;
        rowIdx = i;
      }
    }
  }
  if (rowIdx < 0) rowIdx = 0;
  DnDState.rowIndex = rowIdx;

  // Place within the selected row
  const row = rows[rowIdx];
  // Find nearest tile by x within the row
  let nearest = null;
  let nearestDist = Infinity;
  for (const { el, r } of row.tiles) {
    const cx = r.left + r.width / 2;
    const d = Math.abs(x - cx);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = { tile: el, rect: r };
    }
  }
  if (!nearest) return;

  // Snap to row ends with edge stickiness
  if (x <= row.left + EDGE_X) {
    if (!DnDState.ghostEl) DnDState.ghostEl = createGhostEl();
    const ghost = DnDState.ghostEl;
    ghost.style.width = `${nearest.rect.width}px`;
    ghost.style.height = `${nearest.rect.height}px`;
    const firstInRow = row.tiles[0].el;
    firstInRow.parentNode.insertBefore(ghost, firstInRow);
    return;
  }
  if (x >= row.right - EDGE_X) {
    if (!DnDState.ghostEl) DnDState.ghostEl = createGhostEl();
    const ghost = DnDState.ghostEl;
    ghost.style.width = `${nearest.rect.width}px`;
    ghost.style.height = `${nearest.rect.height}px`;
    const lastInRow = row.tiles[row.tiles.length - 1].el;
    lastInRow.parentNode.insertBefore(ghost, lastInRow.nextSibling);
    return;
  }

  // General within-row placement with horizontal hysteresis
  const centerX = (nearest.rect.left + nearest.rect.right) / 2;
  const before = x < centerX - HYSTERESIS_X;
  if (!DnDState.ghostEl) DnDState.ghostEl = createGhostEl();
  const ghost = DnDState.ghostEl;
  ghost.style.width = `${nearest.rect.width}px`;
  ghost.style.height = `${nearest.rect.height}px`;
  if (before) {
    nearest.tile.parentNode.insertBefore(ghost, nearest.tile);
  } else {
    nearest.tile.parentNode.insertBefore(ghost, nearest.tile.nextSibling);
  }
}

function computeOrderWithGhost(container, dragUUID) {
  const children = Array.from(container.children);
  let order = [];
  for (const el of children) {
    if (el.classList && el.classList.contains('dnd-ghost')) {
      order.push(dragUUID);
      continue;
    }
    if (el.classList && el.classList.contains('SHOWTRAK_PC')) {
      const id = el.getAttribute('data-uuid');
      if (id && id !== dragUUID) order.push(id);
    }
  }
  if (!order.includes(dragUUID)) order.push(dragUUID);
  return order;
}

async function OpenOSCDictionary() {
  await CloseAllModals();
  $('#OSC_ROUTE_LIST_MODAL').modal('show');
}

window.API.Notify(async (Message, Type, Duration) => {
  Notify(Message, Type, Duration);
});

window.API.SetOSCList(async (Routes) => {
  $('#OSC_ROUTE_LIST').html('');
  $('#OSC_ROUTE_LIST').append(`
		<div class="d-grid gap-2 p-2 rounded bg-ghost-light rounded-3">
			The following OSC routes are accessible on port 3333.
		</div>
	`);
  for (const Route of Routes) {
    let PathFiller = '';
    for (const Segment of Route.Path.split('/').filter((s) => s.length > 0)) {
      PathFiller += `<span class="">/</span>`;
      if (Segment.startsWith(':')) {
        PathFiller += `<span class="text-info">[${Safe(Segment.substring(1))}]</span>`;
      } else {
        PathFiller += `<span>${Safe(Segment)}</span>`;
      }
    }

    $('#OSC_ROUTE_LIST').append(`
			<div class="d-grid gap-2 p-2 rounded bg-ghost rounded-3">
				<code class="bg-ghost rounded p-2">${PathFiller}</code>
				<p class="mb-0">${Safe(Route.Title)}</p>
			</div>
		`);
  }
  return;
});

window.API.ClientUpdated(async (Data) => {
  // Online/offline transition alerts
  try {
    if (!window.__CLIENT_ONLINE_STATE) window.__CLIENT_ONLINE_STATE = new Map();
    const prev = window.__CLIENT_ONLINE_STATE.get(Data.UUID);
    if (typeof prev === 'boolean' && prev !== Data.Online) {
      if (!Data.Online) {
        AddAlert({
          type: 'offline',
          severity: 'warning',
          title: 'Client offline',
          message: Safe(Data.Nickname || Data.Hostname),
          clientUUID: Data.UUID,
        });
      } else {
        // Came back online: auto-dismiss any pending offline alerts for this client
        try {
          let changed = false;
          for (const a of Alerts) {
            if (!a.dismissed && a.type === 'offline' && a.clientUUID === Data.UUID) {
              a.dismissed = true;
              changed = true;
            }
          }
          if (changed) {
            UpdateAlertsIndicator();
            if (AlertsVisible) RenderAlerts();
          }
        } catch {}
      }
    }
    window.__CLIENT_ONLINE_STATE.set(Data.UUID, !!Data.Online);
  } catch {}
  const { UUID, Nickname, Hostname, Version, IP, Online, Vitals } = Data;
  $(`[data-uuid='${UUID}']`).toggleClass('ONLINE', Online);

  let ComputedHostname = Nickname && Nickname.length ? `${Hostname} - v${Version}` : 'v' + Version;
  if ($(`[data-uuid='${UUID}']>[data-type="Hostname"]`).text() !== ComputedHostname) {
    $(`[data-uuid='${UUID}']>[data-type="Hostname"]`).text(ComputedHostname);
  }

  let ComputedNickname = Nickname && Nickname.length ? Nickname : Hostname;
  if ($(`[data-uuid='${UUID}']>[data-type="Nickname"]`).text() !== ComputedNickname) {
    $(`[data-uuid='${UUID}']>[data-type="Nickname"]`).text(ComputedNickname);
  }

  let ComputedIP = IP ? IP : 'Unknown IP';
  if ($(`[data-uuid='${UUID}']>[data-type="IP"]`).text() !== ComputedIP) {
    $(`[data-uuid='${UUID}']>[data-type="IP"]`).text(ComputedIP);
  }

  if (Online) {
    $(`[data-uuid='${UUID}']>div>.progress>[data-type="CPU"]`).css(
      'width',
      `${Vitals.CPU.UsagePercentage}%`
    );
    $(`[data-uuid='${UUID}']>div>.progress>[data-type="RAM"]`).css(
      'width',
      `${Vitals.Ram.UsagePercentage}%`
    );
    $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_OFFLINE"]`).addClass(
      'd-none'
    );
    $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_OFFLINE"]`).removeClass(
      'd-grid'
    );
    $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_ONLINE"]`).addClass('d-grid');
    $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_ONLINE"]`).removeClass(
      'd-none'
    );
  } else {
    $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_OFFLINE"]`).addClass(
      'd-grid'
    );
    $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_OFFLINE"]`).removeClass(
      'd-none'
    );
    $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_ONLINE"]`).addClass('d-none');
    $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_ONLINE"]`).removeClass(
      'd-grid'
    );
  }

  $(
    `[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_OFFLINE"]>[data-type="OFFLINE_SINCE"]`
  ).attr('data-offlinesince', Data.LastSeen);
  // If Client Info modal is open for this client, refresh network interfaces (and USB if present)
  try {
    const $modal = $('#SHOWTRAK_CLIENT_INFO');
    if (ClientInfoOpenUUID && ClientInfoOpenUUID === UUID && $modal.hasClass('show')) {
      RenderClientInfoDetails(Data);
    }
  } catch {}
  return;
});

// --- Alerts Manager ---
const Alerts = [];
let AlertsVisible = false;
// Track adoption alerts per device UUID so we can auto-dismiss
const PendingAdoptionAlerts = new Map();

function AddAlert({
  type = 'info',
  severity = 'info',
  title = '',
  message = '',
  clientUUID = null,
  iconHtml = null,
}) {
  const alert = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    severity,
    title,
    message,
    clientUUID,
    iconHtml,
    time: Date.now(),
    dismissed: false,
  };
  Alerts.unshift(alert);
  UpdateAlertsIndicator();
  if (AlertsVisible) RenderAlerts();
  // Also show a top-center toast linked to this alert
  showAlertStyleToast({
    id: alert.id,
    title: alert.title || 'Alert',
    message: alert.message || '',
    type: alert.severity || alert.type || 'info',
    duration: 6000,
    linkAlert: true,
    iconHtml: alert.iconHtml,
  });
  return alert.id;
}

function DismissAlert(id) {
  const a = Alerts.find((x) => x.id === id);
  if (a) {
    a.dismissed = true;
  }
  UpdateAlertsIndicator();
  if (AlertsVisible) RenderAlerts();
  // Remove matching toast, if present
  RemoveAlertToastById(id);
}

function DismissAllAlerts() {
  Alerts.forEach((a) => (a.dismissed = true));
  UpdateAlertsIndicator();
  if (AlertsVisible) RenderAlerts();
}

function UndismissedCount() {
  return Alerts.filter((a) => !a.dismissed).length;
}

function UpdateAlertsIndicator() {
  const count = UndismissedCount();
  const btn = document.getElementById('ALERTS_BUTTON');
  if (!btn) return;
  const badge = btn.querySelector('.alerts-count');
  if (badge) {
    if (count > 0) {
      badge.textContent = String(count);
      badge.classList.remove('d-none');
    } else {
      badge.classList.add('d-none');
    }
  }
  if (count > 0) btn.classList.add('has-alerts');
  else btn.classList.remove('has-alerts');
}

function iconForAlert(a) {
  if (a && a.iconHtml) return a.iconHtml;
  if (a.type === 'usb') return '<i class="bi bi-usb-symbol"></i>';
  if (a.type === 'online') return '<i class="bi bi-wifi"></i>';
  if (a.type === 'offline') return '<i class="bi bi-wifi-off"></i>';
  return '<i class="bi bi-exclamation-circle"></i>';
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function RenderAlerts() {
  const tray = document.getElementById('ALERTS_TRAY');
  const list = document.getElementById('ALERTS_LIST');
  if (!tray || !list) return;
  const items = Alerts.filter((a) => !a.dismissed);
  if (items.length === 0) {
    list.innerHTML = `<div class="text-muted p-2 text-center">No alerts</div>`;
  } else {
    let html = '';
    for (const a of items) {
      html += `
			<div class="alert-item" data-id="${a.id}">
				<div class="alert-icon">${iconForAlert(a)}</div>
				<div class="alert-content">
					<div><strong>${Safe(a.title || 'Alert')}</strong></div>
					${a.message ? `<div class="alert-meta">${Safe(a.message)}</div>` : ''}
				</div>
				<div class="alert-dismiss">
					<small class="alert-meta">${timeAgo(a.time)}</small>
					<button class="btn-dismiss" title="Dismiss" aria-label="Dismiss">✕</button>
				</div>
			</div>`;
    }
    list.innerHTML = html;
    // Bind dismiss buttons
    $(list)
      .find('.alert-item .btn-dismiss')
      .off('click')
      .on('click', function () {
        const id = $(this).closest('.alert-item').attr('data-id');
        DismissAlert(id);
      });
  }
}

function ToggleAlertsTray(force) {
  const tray = document.getElementById('ALERTS_TRAY');
  if (!tray) return;
  const next = typeof force === 'boolean' ? force : !AlertsVisible;
  AlertsVisible = next;
  if (AlertsVisible) {
    tray.hidden = false;
    RenderAlerts();
    // Outside click to close
    $(document)
      .off('mousedown.alerts touchstart.alerts')
      .on('mousedown.alerts touchstart.alerts', function (e) {
        const inside = $(e.target).closest('#ALERTS_TRAY, #ALERTS_BUTTON').length > 0;
        if (!inside) ToggleAlertsTray(false);
      });
  } else {
    tray.hidden = true;
    $(document).off('mousedown.alerts touchstart.alerts');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('ALERTS_BUTTON');
  if (btn && !btn.dataset.bound) {
    btn.addEventListener('click', () => ToggleAlertsTray());
    btn.dataset.bound = '1';
  }
  const disAll = document.getElementById('ALERTS_DISMISS_ALL');
  if (disAll && !disAll.dataset.bound) {
    disAll.addEventListener('click', () => {
      DismissAllAlerts();
    });
    disAll.dataset.bound = '1';
  }
});

// window.API.SetDevicesPendingAdoption(async (Data) => {
//   let Filler = '';
//   for (const { Hostname, IP, UUID, Version, State } of Data) {
//     let VersionArr = Version.split('.');
//     let MyVersionArr = Config.Application.Version.split('.');

//     let VersionCompatible = true;
//     if (VersionArr[0] !== MyVersionArr[0]) VersionCompatible = false;
//     if (VersionArr[1] !== MyVersionArr[1]) VersionCompatible = false;

//     let ButtonState = ` <div class="d-flex flex-column justify-content-center gap-0">
//                 <a class="btn btn-light btn-sm" onclick="AdoptDevice('${UUID}')">Adopt</a>
//             </div>`;
//     if (!VersionCompatible) {
//       ButtonState = ` <div class="d-flex flex-column justify-content-center gap-0">
//                 <a class="btn btn-danger btn-sm disabled" disabled>Incompatible Version (v${Safe(Version)})</a>
//             </div>`;
//     }
//     if (State === 'Adopting') {
//       ButtonState = `<div class="d-flex flex-column justify-content-center gap-0">
//                 <button class="btn btn-secondary btn-sm" disabled>
//                 <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
//                     Adopting...
//                 </button>
//             </div>`;
//     }

//     Filler += `<div class="SHOWTRAK_CLIENT_PENDING_ADOPTION rounded-3 d-flex justify-content-between p-3" data-uuid="${UUID}">
//             <div class="d-flex flex-column justify-content-center gap-1 text-start">
//                 <h6 class="card-title mb-0">${Safe(Hostname)}</h6>
//                 <small class="text-muted">${Safe(IP)}</small>
//                 <small class="text-muted">${Safe(UUID)} - v${Safe(Version)}</small>
//             </div>
//             ${ButtonState}
//         </div>`;
//   }
//   if (Data.length === 0) {
//     Filler = `<div class="SHOWTRAK_CLIENT_PENDING_ADOPTION rounded-3 text-center text-muted p-3">No devices pending adoption</div>`;
//   }
//   $('#DEVICES_PENDING_ADOPTION').html(Filler);
// });

async function ExecuteScript(Script, Targets) {
  let ScriptTarget = ScriptList.find((s) => s.ID === Script);
  if (!ScriptTarget) return Notify('Script not found', 'error');
  await window.API.ExecuteScript(Script, Targets, true);
  ShowExecutionToast();
}

window.API.OSCBulkAction(async (Type, Targets, Args = null) => {
  if (Type == 'ExecuteScript') return await ExecuteScript(Args, Targets);
  if (Type == 'WOL') {
    window.API.WakeOnLan(Targets);
    ShowExecutionToast();
    return;
  }
  if (Type == 'InternalScript') {
  }
  if (Type == 'Select') return Targets.map((UUID) => Select(UUID));
  if (Type == 'Deselect') return Targets.map((UUID) => Deselect(UUID));
});

async function CloseAllModals() {
  $('.modal').modal('hide');
  await Wait(300);
  return;
}

async function OpenGroupCreationModal() {
  await CloseAllModals();

  let Groups = await window.API.GetAllGroups();
  if (!Groups) Groups = [];

  $('#SHOWTRAL_MODAL_GROUPCREATION').modal('show');

  $('#GROUP_CREATION_SUBMIT')
    .off('click')
    .on('click', async () => {
      let GroupName = $('#GROUP_CREATION_TITLE').val();
      if (!GroupName) return Notify('Please enter a group name', 'error');
      if (GroupName.length < 3)
        return Notify('Group name must be at least 3 characters long', 'error');
      if (Groups.some((g) => g.Title.toLowerCase() === GroupName.toLowerCase())) {
        return Notify('A group with this name already exists', 'error');
      }
      if (GroupName.length > 10)
        return Notify('Group name must be less than 50 characters long', 'error');

      // Clear the input field
      $('#GROUP_CREATION_TITLE').val('');

      await window.API.CreateGroup(GroupName);
      OpenGroupManager();
      $('#SHOWTRAL_MODAL_GROUPCREATION').modal('hide');
    });
}

async function ImportConfig() {
  console.log('Starting import');
  await window.API.ImportConfig();
  await Notify('Restored from backup.', 'success');
}

async function BackupConfig() {
  console.log('Starting backup');
  await window.API.BackupConfig();
  await Notify('Backup completed.', 'success');
}

async function DeleteGroup(GroupID) {
  await window.API.DeleteGroup(GroupID);
  await OpenGroupManager(true);
  await Notify('Group deleted.', 'success');
}

async function OpenGroupManager(Relaunching = false) {
  if (!Relaunching) await CloseAllModals();

  let Groups = await window.API.GetAllGroups();

  $('#GROUP_MANAGER_GROUP_LIST').html('');
  console.log(GroupUUIDCache);
  for (const Group of Groups) {
    let GroupMembers = GroupUUIDCache.has(`${Group.GroupID}`)
      ? GroupUUIDCache.get(`${Group.GroupID}`)
      : [];
    $('#GROUP_MANAGER_GROUP_LIST').append(`
            <div class="GROUP_MANAGER_GROUP_ITEM d-flex justify-content-between align-items-center p-3 rounded bg-ghost" data-groupid="${
              Group.GroupID
            }">
                <span class="GROUP_MANAGER_GROUP_TITLE text-bold">
                    ${Safe(Group.Title)} 
                </span>
                <div class="d-flex gap-2">
                    <span class="badge bg-ghost-light text-light">
                        ${GroupMembers.length} ${GroupMembers.length == 1 ? 'Client' : 'Clients'}
                    </span>
                    <a class="badge bg-danger text-light cursor-pointer text-decoration-none GROUP_MANAGER_GROUP_DELETE" onclick="DeleteGroup(${
                      Group.GroupID
                    })">
                        Delete
                    </a>
                </div>
            </div>
        `);
  }

  let GroupMembers = GroupUUIDCache.has(`null`) ? GroupUUIDCache.get(`null`) : [];
  $('#GROUP_MANAGER_GROUP_LIST').append(`
        <div class="GROUP_MANAGER_GROUP_ITEM d-flex justify-content-between align-items-center p-3 rounded bg-ghost">
            <span class="GROUP_MANAGER_GROUP_TITLE">
                Default Group
            </span>
            <span class="badge bg-ghost-light text-light">
                ${GroupMembers.length} ${GroupMembers.length == 1 ? 'Client' : 'Clients'}
            </span>
        </div>
    `);

  $('#GROUP_MANAGER_GROUP_LIST').append(`
        <div class="d-grid gap-2">
            <button class="btn btn-sm btn-success" onclick="OpenGroupCreationModal()">New Group</button>
        </div>
    `);

  $('#SHOWTRAK_MODAL_GROUPMANAGER').modal('show');
}

async function OpenClientEditor(UUID) {
  let Client = await window.API.GetClient(UUID);
  if (!Client) return console.error('Client not found:', UUID);

  let Groups = await window.API.GetAllGroups();
  if (!Groups) Groups = [];
  Groups.push({
    GroupID: null,
    Title: 'No Group',
    Weight: 100000,
  });

  $('#CLIENT_EDITOR_GROUPID').html('');
  for (const Group of Groups) {
    $('#CLIENT_EDITOR_GROUPID').append(
      `<option value="${Group.GroupID}" ${Client.GroupID == Group.GroupID ? 'selected' : ''}>${Safe(
        Group.Title
      )}</option>`
    );
  }

  ClearSelection();

  const { Nickname, Hostname, IP, Version, MacAddress } = Client;

  $('#CLIENT_EDITOR_NICKNAME').val(Nickname ? Nickname : Hostname);
  $('#CLIENT_EDITOR_HOSTNAME').val(Hostname);
  $('#CLIENT_EDITOR_IP').val(IP);
  if (MacAddress && String(MacAddress).trim().length > 0) {
    $('#CLIENT_EDITOR_MAC').val(MacAddress.toUpperCase());
    $('#CLIENT_EDITOR_MAC_WRAPPER').removeClass('d-none');
  } else {
    $('#CLIENT_EDITOR_MAC').val('');
    $('#CLIENT_EDITOR_MAC_WRAPPER').addClass('d-none');
  }
  $('#CLIENT_EDITOR_UUID').val(UUID);
  $('#CLIENT_EDITOR_VERSION').val(Version);

  $('#SHOWTRAK_CLIENT_EDITOR_USB_DEVICES').html('');
  // USB section moved to read-only Client Info modal
  $('#SHOWTRAK_CLIENT_EDITOR_USB_DEVICES').remove();

  $('#SHOWTRAK_CLIENT_EDITOR_UPDATE')
    .off('click')
    .on('click', async () => {
      await CloseAllModals();
      await window.API.CheckForUpdatesOnClient(UUID);
      ShowExecutionToast();
    });

  $('#SHOWTRAK_CLIENT_EDITOR_REMOVE')
    .off('click')
    .on('click', async () => {
      await CloseAllModals();
      let Confirmation = await ConfirmationDialog(
        `Are you sure you want to delete ${Nickname || Hostname}?`
      );
      if (!Confirmation) return;
      await window.API.UnadoptClient(UUID);
      await Notify(`Unadopted ${Nickname ? Nickname : Hostname}`, 'success');
    });

  $('#SHOWTRAK_CLIENT_EDITOR_SAVE')
    .off('click')
    .on('click', async () => {
      let Nickname = $('#CLIENT_EDITOR_NICKNAME').val();
      if (!Nickname) Nickname = Hostname;

      let GroupID = $('#CLIENT_EDITOR_GROUPID').val();
      if (GroupID == null || GroupID == 'null') {
        GroupID = null;
      } else {
        GroupID = parseInt(GroupID);
      }

      await window.API.UpdateClient(UUID, {
        Nickname: Nickname,
        GroupID: GroupID,
      });
      await CloseAllModals();
    });

  $('#SHOWTRAK_CLIENT_EDITOR').modal('show');
}

async function AdoptDevice(UUID) {
  await window.API.AdoptDevice(UUID);
}

function SelectByGroup(GroupID) {
  if (!GroupUUIDCache.has(`${GroupID}`)) return;
  let UUIDs = GroupUUIDCache.get(`${GroupID}`);

  if (UUIDs.every((UUID) => IsSelected(UUID))) {
    UUIDs.forEach((UUID) => Deselect(UUID));
  } else {
    UUIDs.forEach((UUID) => Select(UUID));
  }
  return;
}

async function Wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Alert-style Toasts (Top Center) ---
function ensureToastHost() {
  let host = document.getElementById('ALERTS_TOAST_HOST');
  if (!host) {
    host = document.createElement('div');
    host.id = 'ALERTS_TOAST_HOST';
    document.body.appendChild(host);
  }
  return host;
}

function iconForType(type) {
  const t = String(type || 'info').toLowerCase();
  if (t === 'success') return '<i class="bi bi-check-circle-fill"></i>';
  if (t === 'warning') return '<i class="bi bi-exclamation-triangle-fill"></i>';
  if (t === 'error') return '<i class="bi bi-x-circle-fill"></i>';
  return '<i class="bi bi-info-circle-fill"></i>';
}

function RemoveAlertToastById(id) {
  try {
    const host = document.getElementById('ALERTS_TOAST_HOST');
    if (!host) return;
    const node = host.querySelector(`.alert-toast[data-alert-id="${CSS.escape(id)}"]`);
    if (node) node.remove();
  } catch {}
}

function showAlertStyleToast({
  id = null,
  title = '',
  message = '',
  type = 'info',
  duration = 5000,
  linkAlert = false,
  iconHtml = null,
}) {
  const host = ensureToastHost();
  const el = document.createElement('div');
  el.className = 'alert-item alert-toast';
  if (id && linkAlert) el.setAttribute('data-alert-id', id);
  const hasMessage = Boolean(message && String(message).trim().length > 0);
  if (!hasMessage) el.classList.add('single-line');
  el.innerHTML = `
		<div class="alert-icon">${iconHtml ? iconHtml : linkAlert ? iconForAlert({ type }) : iconForType(type)}</div>
		<div class="alert-content">
			<div><strong>${Safe(title || 'Notice')}</strong></div>
			${message ? `<div class="alert-meta">${Safe(message)}</div>` : ''}
		</div>
		<div class="alert-dismiss">
			<button class="btn-dismiss" title="Dismiss" aria-label="Dismiss">✕</button>
		</div>`;
  host.appendChild(el);

  // Dismiss interaction
  const btn = el.querySelector('.btn-dismiss');
  if (btn)
    btn.addEventListener('click', () => {
      el.remove();
      if (linkAlert && id) {
        // Sync with alerts tray
        DismissAlert(id);
      }
    });

  // Auto-remove after duration with hover pause
  if (duration && duration > 0) {
    let remaining = duration;
    let timerId = null;
    let lastStart = Date.now();
    const clear = () => {
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
    };
    const tick = () => {
      clear();
      lastStart = Date.now();
      timerId = setTimeout(() => {
        try {
          el.remove();
        } catch {}
      }, remaining);
    };
    const onMouseEnter = () => {
      // pause timer
      remaining -= Date.now() - lastStart;
      if (remaining < 0) remaining = 0;
      clear();
    };
    const onMouseLeave = () => {
      if (remaining === 0) {
        try {
          el.remove();
        } catch {}
      } else {
        tick();
      }
    };
    el.addEventListener('mouseenter', onMouseEnter);
    el.addEventListener('mouseleave', onMouseLeave);
    // start timer
    tick();
  }
}

async function Notify(Message, Type = 'info', Duration = 5000) {
  showAlertStyleToast({
    title: Message,
    message: '',
    type: Type,
    duration: Duration,
    linkAlert: false,
  });
}

async function ConfirmationDialog(Message) {
  return new Promise((resolve) => {
    // Create or reuse toast container
    const existing = document.getElementById('SHOWTRAK_CONFIRM_TOAST');
    if (existing) {
      try {
        existing.remove();
      } catch {}
    }

    const toastHtml = `
			<div id="SHOWTRAK_CONFIRM_TOAST" role="dialog" aria-live="assertive" aria-modal="true" class="confirm-toast no-drag">
				<div class="confirm-toast-body">
					<div class="confirm-toast-msg">${Safe(Message)}</div>
					<div class="confirm-toast-actions">
						<button type="button" class="btn btn-sm btn-secondary" id="CONFIRM_TOAST_CANCEL" tabindex="0">Cancel</button>
						<button type="button" class="btn btn-sm btn-danger" id="CONFIRM_TOAST_CONFIRM" tabindex="0">Confirm</button>
					</div>
				</div>
			</div>`;

    $('body').append(toastHtml);
    const $toast = $('#SHOWTRAK_CONFIRM_TOAST');
    const $btnCancel = $('#CONFIRM_TOAST_CANCEL');
    const $btnConfirm = $('#CONFIRM_TOAST_CONFIRM');

    window.__SHOWTRAK_CONFIRM_ACTIVE = true;

    const cleanup = () => {
      $(document).off('keydown.confirmToast');
      $btnCancel.off('click.confirmToast');
      $btnConfirm.off('click.confirmToast');
      try {
        $toast.remove();
      } catch {}
      window.__SHOWTRAK_CONFIRM_ACTIVE = false;
    };

    $btnCancel.on('click.confirmToast', () => {
      cleanup();
      resolve(false);
    });
    $btnConfirm.on('click.confirmToast', () => {
      cleanup();
      resolve(true);
    });

    // Keyboard controls while toast is visible
    $(document).on('keydown.confirmToast', function (e) {
      // If context menu is open/visible, ignore Enter/Space here
      const $ctx = $('#SHOWTRAK_CONTEXT_MENU');
      if ($ctx && $ctx.is(':visible')) {
        return;
      }
      const key = e.key;
      if (key === 'Enter' || key === ' ') {
        e.preventDefault();
        const active = document.activeElement;
        if (active === $btnConfirm.get(0)) return $btnConfirm.trigger('click');
        if (active === $btnCancel.get(0)) return $btnCancel.trigger('click');
        // default to confirm if focus is elsewhere
        return $btnConfirm.trigger('click');
      }
      if (key === 'Escape') {
        e.preventDefault();
        return $btnCancel.trigger('click');
      }
      if (key === 'ArrowLeft') {
        e.preventDefault();
        return $btnCancel.trigger('focus');
      }
      if (key === 'ArrowRight') {
        e.preventDefault();
        return $btnConfirm.trigger('focus');
      }
    });

    // Default focus on Confirm so Enter activates it naturally
    setTimeout(() => {
      try {
        $btnConfirm.trigger('focus');
      } catch {}
    }, 0);
  });
}

function UpdateSelectionCount() {
  $('#SELECTION_STATUS').text(
    `${Selected.length} ${Selected.length == 1 ? 'Client' : 'Clients'} Selected`
  );
  return;
}

function IsSelected(UUID) {
  return Selected.includes(UUID);
}

function Select(UUID) {
  // Do not allow selecting pending-adoption tiles
  try {
    const $tile = $(`.SHOWTRAK_PC[data-uuid='${UUID}']`);
    if ($tile && $tile.hasClass('PENDING')) return;
  } catch {}
  if (Selected.includes(UUID)) return;
  Selected.push(UUID);
  $(`.SHOWTRAK_PC[data-uuid='${UUID}']`).addClass('SELECTED');
  UpdateSelectionCount();
  return;
}

function Deselect(UUID) {
  Selected = Selected.filter((id) => id !== UUID);
  $(`.SHOWTRAK_PC[data-uuid='${UUID}']`).removeClass('SELECTED');
  UpdateSelectionCount();
  return;
}

function ClearSelection() {
  Selected.forEach((uuid) => {
    $(`.SHOWTRAK_PC[data-uuid='${uuid}']`).removeClass('SELECTED');
  });
  Selected = [];
  UpdateSelectionCount();
  return;
}

function ToggleSelection(UUID) {
  // Do not toggle selection for pending-adoption tiles
  try {
    const $tile = $(`.SHOWTRAK_PC[data-uuid='${UUID}']`);
    if ($tile && $tile.hasClass('PENDING')) return;
  } catch {}
  if (Selected.includes(UUID)) {
    Selected = Selected.filter((id) => id !== UUID);
    $(`.SHOWTRAK_PC[data-uuid='${UUID}']`).removeClass('SELECTED');
  } else {
    Selected.push(UUID);
    $(`.SHOWTRAK_PC[data-uuid='${UUID}']`).addClass('SELECTED');
  }
  UpdateSelectionCount();
}

async function UpdateOfflineIndicators() {
  let CurrentTime = new Date().getTime();
  $('.SHOWTRAK_PC_STATUS[data-type="INDICATOR_OFFLINE"]>[data-type="OFFLINE_SINCE"]').each(
    function () {
      let LastSeen = $(this).attr('data-offlinesince');
      if (!LastSeen) return;
      LastSeen = parseInt(LastSeen);
      let OfflineDuration = CurrentTime - LastSeen;
      let Hours = Math.floor(OfflineDuration / (1000 * 60 * 60));
      let Minutes = Math.floor((OfflineDuration % (1000 * 60 * 60)) / (1000 * 60));
      let Seconds = Math.floor((OfflineDuration % (1000 * 60)) / 1000);
      let HH = String(Hours).padStart(2, '0');
      let MM = String(Minutes).padStart(2, '0');
      let SS = String(Seconds).padStart(2, '0');
      $(this).html(`OFFLINE <span class="badge bg-ghost">${HH}:${MM}:${SS}</span>`);
    }
  );
}

$(async function () {
  const $menu = $('#SHOWTRAK_CONTEXT_MENU');

  // Copy-to-clipboard for readonly editor fields and inline values
  $(document).on('click', '.copy-field-btn', async function (e) {
    e.preventDefault();
    e.stopPropagation();
    const direct = $(this).attr('data-copy');
    let value = null;
    if (direct && String(direct).length > 0) {
      value = String(direct);
    } else {
      const targetSel = $(this).attr('data-target');
      const $input = targetSel ? $(targetSel) : null;
      if (!$input || $input.length === 0) return false;
      value = String($input.val() || '').trim();
    }
    if (!value) return false;
    try {
      await navigator.clipboard.writeText(value);
      // quick feedback: icon swap
      const $icon = $(this).find('i');
      const prev = $icon.attr('class');
      $icon.attr('class', 'bi bi-clipboard-check');
      setTimeout(() => {
        $icon.attr('class', prev);
      }, 900);
    } catch {}
    return false;
  });

  // --- App Updates (manual check) ---
  try {
    // Bind Check for Updates button in core modal
    $('#SHOWTRAK_MODEL_CORE_CHECKUPDATES').off('click').on('click', async () => {
      try { await window.API.CheckForAppUpdates(); } catch {}
      // Ensure section visible while checking
      $('#UPDATE_SECTION').removeClass('d-none');
      $('#UPDATE_STATUS').text('Checking for updates...');
      $('#UPDATE_INSTALL_BTN').addClass('d-none');
      $('#UPDATE_LATER_BTN').addClass('d-none');
    });
    // Bind Install and Later buttons
    $('#UPDATE_INSTALL_BTN').off('click').on('click', async () => {
      try { await window.API.InstallAppUpdate(); } catch {}
    });
    $('#UPDATE_LATER_BTN').off('click').on('click', async () => {
      // Hide the section but keep state if needed later
      $('#UPDATE_SECTION').addClass('d-none');
    });

    // Listen for updater status from main
    window.API.OnAppUpdateStatus((payload) => {
      try {
        $('#UPDATE_SECTION').removeClass('d-none');
        const st = (payload && payload.state) || 'none';
        const $status = $('#UPDATE_STATUS');
        const $install = $('#UPDATE_INSTALL_BTN');
        const $later = $('#UPDATE_LATER_BTN');
        const $notesWrap = $('#UPDATE_NOTES_WRAPPER');
        const $notes = $('#UPDATE_CHANGELOG');
        $install.addClass('d-none');
        $later.addClass('d-none');
        $notesWrap.addClass('d-none');
        $notes.empty();
        const escapeHtml = (s) => String(s)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
        const sanitizeHref = (href) => {
          try {
            const h = String(href || '').trim();
            if (/^(https?:|mailto:)/i.test(h)) return h;
          } catch {}
          return '#';
        };
        const renderMarkdownSafe = (md) => {
          if (!md || typeof md !== 'string') return '';
          let text = md.replace(/\r\n/g, '\n');
          // Escape HTML first
          text = escapeHtml(text);
          // Extract fenced code blocks
          const codeBlocks = [];
          text = text.replace(/```([\s\S]*?)```/g, (_m, code) => {
            const idx = codeBlocks.push(code) - 1;
            return `%%CODEBLOCK_${idx}%%`;
          });
          // Headings
          text = text.replace(/^#{1,6}\s+(.+)$/gm, (m) => {
            const hashes = m.match(/^#+/)[0].length;
            const content = m.replace(/^#{1,6}\s+/, '');
            const level = Math.min(6, Math.max(1, hashes));
            return `<h${level} class="h${level+2}">${content}</h${level}>`;
          });
          // Inline code (after fences are removed)
          text = text.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
          // Links
          text = text.replace(/\[([^\]]+)\]\(([^\)]+)\)/g, (_m, label, href) => {
            const url = sanitizeHref(href);
            return `<a href="${url}" target="_blank" rel="noopener">${label}</a>`;
          });
          // Unordered lists (group contiguous items)
          text = text.replace(/(?:^|\n)((?:[\-\*\+]\s+.*(?:\n|$))+)/g, (_m, block) => {
            const items = block
              .trim()
              .split(/\n/)
              .map((line) => line.replace(/^[\-\*\+]\s+/, '').trim())
              .filter((x) => x.length > 0)
              .map((x) => `<li>${x}</li>`) 
              .join('');
            return `\n<ul>${items}</ul>`;
          });
          // Bold and italic (do after lists so we don't break bullets)
          text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                     .replace(/__(.+?)__/g, '<strong>$1</strong>')
                     .replace(/(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, '<em>$1</em>')
                     .replace(/_(?!\s)(.+?)(?<!\s)_/g, '<em>$1</em>');
          // Paragraphs: wrap blocks that are not already block-level tags
          const blocks = text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
          const html = blocks.map((b) => {
            if (/^<\/?(h\d|ul|ol|li|pre|blockquote|table|p|code)/i.test(b)) return b;
            return `<p>${b.replace(/\n/g, '<br/>')}</p>`;
          }).join('\n');
          // Restore fenced code blocks
          return html.replace(/%%CODEBLOCK_(\d+)%%/g, (_m, i) => {
            const code = codeBlocks[Number(i)] || '';
            return `<pre class="mb-2"><code>${code}</code></pre>`;
          });
        };
        const extractNotes = (info) => {
          if (!info) return '';
          // electron-updater passes release notes in different shapes across platforms
          // Prefer html: info.releaseNotes or markdown: info.notes
          const raw = info.releaseNotes || info.notes || info.body || '';
          if (Array.isArray(raw)) {
            // mac: array of releases, take the first entry's notes
            const first = raw.find(Boolean);
            return first && (first.releaseNotes || first.notes || first.body) || '';
          }
          return raw || '';
        };
    const showNotes = (info) => {
          const notes = extractNotes(info);
          if (notes && typeof notes === 'string') {
            // Allow basic HTML if present from GitHub; otherwise escape text
            const looksHtml = /<\w+[^>]*>/.test(notes);
            if (looksHtml) {
              $notes.html(notes);
            } else {
      $notes.html(renderMarkdownSafe(notes));
            }
            $notesWrap.removeClass('d-none');
          }
        };
        if (st === 'checking') {
          $status.text('Checking for updates...');
        } else if (st === 'available') {
          const v = payload.info && (payload.info.version || payload.info.tag || 'Update available');
          $status.text(`Update available: ${v}. Downloading...`);
          showNotes(payload.info);
        } else if (st === 'downloading') {
          const pct = payload.percent ? Math.floor(payload.percent) : 0;
          $status.text(`Downloading update... ${pct}%`);
        } else if (st === 'downloaded') {
          const v = payload.info && (payload.info.version || 'pending');
          $status.text(`Update ready to install: ${v}`);
          showNotes(payload.info);
          $install.removeClass('d-none');
          $later.removeClass('d-none');
        } else if (st === 'installing') {
          $status.text('Installing update...');
        } else if (st === 'installed') {
          $status.text('Update installed (simulated). Restart the app to finish.');
          $later.removeClass('d-none');
        } else if (st === 'none') {
          $status.text('No updates available');
        } else if (st === 'error') {
          $status.text(`Update error: ${payload.error || 'Unknown error'}`);
          $later.removeClass('d-none');
        }
      } catch {}
    });
  } catch {}

  // Open client editor from cog without affecting selection
  $(document).on('click', '.CLIENT_TILE_COG', function (e) {
    e.preventDefault();
    e.stopPropagation();
    const uuid = $(this).closest('.SHOWTRAK_PC').attr('data-uuid');
    if (uuid) {
      OpenClientEditor(uuid);
    }
    return false;
  });
  $(document).on('click', '.SHOWTRAK_PC', function (e) {
    e.preventDefault();
  // Ignore clicks on pending-adoption tiles (blue)
  if ($(this).hasClass('PENDING')) return false;
  let UUID = $(this).attr('data-uuid');
    ToggleSelection(UUID);
    return;
  });
  // Double-click opens read-only Client Info modal (not the editor)
  $(document).on('dblclick', '.SHOWTRAK_PC', function (e) {
    e.preventDefault();
    e.stopPropagation();
  // Ignore dblclick on pending-adoption tiles
  if ($(this).hasClass('PENDING')) return false;
    const uuid = $(this).attr('data-uuid');
    if (uuid) OpenClientInfo(uuid);
    return false;
  });
  $(document).on('contextmenu', 'html', async function (e) {
    e.preventDefault();
    let Options = [];

    if (Selected.length == 0) {
      Options.push({
        Type: 'Info',
        Title: 'No Selected Clients',
        Class: 'text-muted',
      });
    }

    if (Selected.length > 0) {
      ScriptList = ScriptList.sort((a, b) => (a.Weight || 0) - (b.Weight || 0));
      for (const Script of ScriptList) {
        Options.push({
          Type: 'Action',
          Title: `${Script.Name}`,
          Class: `text-${Script.LabelStyle}`,
          Action: async function () {
            if (Script.Confirmation) {
              let Confirmation = await ConfirmationDialog(
                `Are you sure you want to run "${Script.Name}" on ${Selected.length} ${
                  Selected.length == 1 ? 'Client' : 'Clients'
                }?`
              );
              if (!Confirmation) return;
            }
            await ExecuteScript(Script.ID, Selected, true);
          },
        });
      }
    }

    if (ScriptList.length > 0) {
      Options.push({
        Type: 'Divider',
      });
    }

    if (Selected.length > 0) {
      let SYSTEM_ALLOW_WOL = await GetSettingValue('SYSTEM_ALLOW_WOL');
      if (SYSTEM_ALLOW_WOL) {
        Options.push({
          Type: 'Action',
          Title: 'Wake On LAN',
          Class: 'text-light',
          Action: async function () {
            window.API.WakeOnLan(Selected);
            ShowExecutionToast();
          },
        });
      }
      let SYSTEM_ALLOW_SCRIPT_EDITS = await GetSettingValue('SYSTEM_ALLOW_SCRIPT_EDITS');
      if (SYSTEM_ALLOW_SCRIPT_EDITS && AppMode === 'EDIT') {
        Options.push({
          Type: 'Action',
          Title: 'Delete Scripts',
          Class: 'text-warning',
          Action: async function () {
            let Confirmation = await ConfirmationDialog(
              'Are you sure you want to delete scripts from clients?'
            );
            if (!Confirmation) return;
            window.API.DeleteScripts(Selected);
            ShowExecutionToast();
          },
        });
        Options.push({
          Type: 'Action',
          Title: 'Deploy Scripts',
          Class: 'text-warning',
          Action: async function () {
            window.API.UpdateScripts(Selected);
            ShowExecutionToast();
          },
        });
      }
      Options.push({
        Type: 'Action',
        Title: 'Clear Selection',
        Class: 'text-danger',
        Shortcut: 'Ctrl+D',
        Action: async function () {
          ClearSelection();
        },
      });
    }

    Options.push({
      Type: 'Action',
      Title: 'Select All',
      Class: 'text-light',
      Shortcut: 'Ctrl+A',
      Action: async function () {
        AllClients.map((UUID) => Select(UUID));
      },
    });

    $menu.html('');

    Options.forEach((option) => {
      if (option.Type === 'Divider') {
        $menu.append(`<hr class="my-2">`);
      }
      if (option.Type === 'Info') {
        $menu.append(
          `<a class="SHOWTRAK_CONTEXTMENU_BUTTON dropdown-item ${Safe(
            option.Class
          )}" role="menuitem" aria-disabled="true" tabindex="-1">` +
            `<span class="context-title">${Safe(option.Title)}</span>` +
            `<span class="context-shortcut">${Safe(option.Shortcut || '')}</span>` +
            `</a>`
        );
      }
      if (option.Type === 'Action') {
        $menu.append(
          `<a class="SHOWTRAK_CONTEXTMENU_BUTTON dropdown-item ${Safe(
            option.Class
          )}" role="menuitem" tabindex="-1">` +
            `<span class="context-title">${Safe(option.Title)}</span>` +
            `<span class="context-shortcut">${Safe(option.Shortcut || '')}</span>` +
            `</a>`
        );
        $menu.find('a:last').on('click', function () {
          option.Action();
        });
      }
    });

    // Calculate menu position to prevent overflow
    const menuWidth = $menu.outerWidth();
    const menuHeight = $menu.outerHeight();
    const pageWidth = $(window).width();
    const pageHeight = $(window).height();
    let left = e.pageX;
    let top = e.pageY;

    // If menu would overflow right, show to the left
    if (left + menuWidth > pageWidth) {
      left = Math.max(0, left - menuWidth);
    }
    // If menu would overflow bottom, show above
    if (top + menuHeight > pageHeight) {
      top = Math.max(0, top - menuHeight);
    }

    $menu.css({
      display: 'block',
      left: left,
      top: top,
    });

    // A11y roles and initial focus
    $menu.attr('role', 'menu');
    const $focusable = $menu.find(
      'a.SHOWTRAK_CONTEXTMENU_BUTTON[role="menuitem"]:not([aria-disabled="true"])'
    );
    if ($focusable.length > 0) {
      setTimeout(() => {
        try {
          $focusable.first().trigger('focus')[0].scrollIntoView({ block: 'nearest' });
        } catch {}
      }, 0);
    }

    // Keyboard navigation within context menu
    $menu.off('keydown').on('keydown', function (ev) {
      const key = ev.key;
      const $items = $menu.find(
        'a.SHOWTRAK_CONTEXTMENU_BUTTON[role="menuitem"]:not([aria-disabled="true"])'
      );
      if ($items.length === 0) return;
      const activeEl = document.activeElement;
      let idx = $items.index(activeEl);

      // Type-to-search (typeahead) for menu items by visible title
      const isChar =
        key && key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey && key !== ' ';
      if (isChar) {
        ev.preventDefault();
        const now = Date.now();
        let buf = ($menu.data('typeaheadBuffer') || '').toString();
        const lastTime = $menu.data('typeaheadTime') || 0;
        let cycleSingle = false;
        const lower = key.toLowerCase();
        if (now - lastTime > 700) {
          buf = lower; // start new buffer after pause
        } else if (buf.length === 1 && buf === lower) {
          // repeating the same char cycles matches
          buf = lower;
          cycleSingle = true;
        } else {
          buf = (buf + lower).slice(0, 64);
        }
        $menu.data('typeaheadBuffer', buf);
        $menu.data('typeaheadTime', now);
        const prevTimer = $menu.data('typeaheadTimer');
        if (prevTimer) {
          try {
            clearTimeout(prevTimer);
          } catch {}
        }
        $menu.data(
          'typeaheadTimer',
          setTimeout(() => {
            $menu.removeData('typeaheadBuffer');
            $menu.removeData('typeaheadTimer');
            $menu.removeData('typeaheadTime');
          }, 900)
        );

        const titles = $items
          .map((i, el) => $(el).find('.context-title').text().trim().toLowerCase())
          .get();
        let start = (idx >= 0 ? idx + 1 : 0) % $items.length;
        if (cycleSingle) start = (idx >= 0 ? idx + 1 : 0) % $items.length;

        let found = -1;
        for (let k = 0; k < titles.length; k++) {
          const pos = (start + k) % titles.length;
          if (titles[pos].startsWith(buf)) {
            found = pos;
            break;
          }
        }
        if (found === -1) {
          for (let k = 0; k < titles.length; k++) {
            const pos = (start + k) % titles.length;
            if (titles[pos].includes(buf)) {
              found = pos;
              break;
            }
          }
        }
        if (found !== -1) {
          const $t = $items.eq(found);
          $t.trigger('focus')[0].scrollIntoView({ block: 'nearest' });
        }
        return;
      }
      if (key === 'ArrowDown') {
        ev.preventDefault();
        idx = (idx + 1 + $items.length) % $items.length;
        $items.eq(idx).trigger('focus')[0].scrollIntoView({ block: 'nearest' });
        return;
      }
      if (key === 'ArrowUp') {
        ev.preventDefault();
        idx = (idx - 1 + $items.length) % $items.length;
        $items.eq(idx).trigger('focus')[0].scrollIntoView({ block: 'nearest' });
        return;
      }
      if (key === 'Home') {
        ev.preventDefault();
        $items.first().trigger('focus')[0].scrollIntoView({ block: 'nearest' });
        return;
      }
      if (key === 'End') {
        ev.preventDefault();
        $items.last().trigger('focus')[0].scrollIntoView({ block: 'nearest' });
        return;
      }
      if (key === 'Enter' || key === ' ') {
        ev.preventDefault();
        // Prevent bubbling to document-level handlers (e.g., confirmation toast)
        try {
          ev.stopImmediatePropagation();
        } catch {}
        try {
          ev.stopPropagation();
        } catch {}
        if (idx >= 0) {
          const $target = $items.eq(idx);
          // Defer the click so it occurs after keydown completes
          setTimeout(() => {
            try {
              $target.trigger('click');
            } catch {}
          }, 0);
        }
        return;
      }
      if (key === 'Escape') {
        ev.preventDefault();
        $menu.hide();
        return;
      }
    });

    // Hover-to-focus: hovering should take over keyboard control
    $menu
      .off('mouseenter', 'a.SHOWTRAK_CONTEXTMENU_BUTTON')
      .on('mouseenter', 'a.SHOWTRAK_CONTEXTMENU_BUTTON', function () {
        const $a = $(this);
        if ($a.attr('aria-disabled') === 'true') return;
        const prevTimer = $menu.data('typeaheadTimer');
        if (prevTimer) {
          try {
            clearTimeout(prevTimer);
          } catch {}
        }
        $menu.removeData('typeaheadBuffer');
        $menu.removeData('typeaheadTimer');
        $menu.removeData('typeaheadTime');
        $a.trigger('focus');
      });

    $menu.data('target', this);
    return;
  });
  $(document).on('click', function () {
    $menu.hide();
    return;
  });
  $menu.on('click', 'a', function (e) {
    e.stopPropagation();
    $menu.hide();
    return;
  });

  // Close execution toast on Escape
  $(document).on('keydown.execToast', function (e) {
    if (e.key === 'Escape') {
      HideExecutionToast();
    }
  });
});

setInterval(UpdateOfflineIndicators, 1000);

function ShowExecutionToast(title) {
  const $existing = $('#EXECUTION_TOAST');
  if ($existing.length) {
    $existing.addClass('show');
    if (title) {
      $existing.find('.exec-toast-header .exec-title').text(title);
    }
    // Bind outside click to dismiss when reused
    enableExecToastOutsideClose();
    return;
  }
  const safeTitle = title ? Safe(title) : 'Script Executions';
  const html = `
	<div id="EXECUTION_TOAST" class="exec-toast show no-drag" role="region" aria-live="polite" aria-label="Script executions">
		<div class="exec-toast-header">
			<strong class="exec-title">${safeTitle}</strong>
			<button type="button" class="btn btn-sm btn-light exec-toast-close" aria-label="Close">✕</button>
		</div>
		<div id="SHOWTRAK_EXECUTION_LIST" class="exec-toast-body"></div>
	</div>`;
  $('body').append(html);
  $('.exec-toast-close').on('click', () => HideExecutionToast());
  // Bind outside click to dismiss on create
  enableExecToastOutsideClose();

  // No modal on click per requirements; ensure no handler is attached
  $(document).off('click.execInfo', '.exec-info-btn');
}

function HideExecutionToast() {
  const $t = $('#EXECUTION_TOAST');
  if ($t.length) {
    $t.removeClass('show');
    // Remove outside-click handler when closing
    $(document).off('mousedown.execToastOutside touchstart.execToastOutside');
    // keep in DOM for quick reopen; remove after short delay
    setTimeout(() => {
      try {
        $t.remove();
      } catch {}
    }, 150);
  }
}

// Enable click/touch outside toast to dismiss
function enableExecToastOutsideClose() {
  $(document)
    .off('mousedown.execToastOutside touchstart.execToastOutside')
    .on('mousedown.execToastOutside touchstart.execToastOutside', function (e) {
      const $toast = $('#EXECUTION_TOAST');
      if (!$toast.length) {
        $(document).off('mousedown.execToastOutside touchstart.execToastOutside');
        return;
      }
      const $target = $(e.target);
      const inside = $target.closest('#EXECUTION_TOAST').length > 0;
      if (!inside) {
        HideExecutionToast();
      }
    });
}

async function Init() {
  Config = await window.API.GetConfig();
  $('#APPLICATION_NAVBAR_TITLE').text(`${Config.Application.Name}`);
  $('#APPLICATION_NAVBAR_STATUS').text(`v${Config.Application.Version}`);

  $('#SHOWTRAK_MODEL_CORE_OPEN_SETTINGS').on('click', async () => {
    await CloseAllModals();
    $('#SHOWTRAK_MODAL_SETTINGS').modal('show');
  });

  $('#NAVBAR_CORE_BUTTON').on('click', async () => {
    $('#SHOWTRAK_MODEL_CORE').modal('show');
  });

  $('#SHOWTRAK_MODEL_CORE_OSC_ROUTE_LIST_BUTTON').on('click', async () => {
    await OpenOSCDictionary();
  });

  $('#SHOWTRAK_MODEL_CORE_GROUP_MANAGER_BUTTON').on('click', async () => {
    await OpenGroupManager();
  });

  $('#SHOWTRAK_MODEL_CORE_LOGSFOLDER').on('click', async () => {
    await window.API.OpenLogsFolder();
  });

  $('#SHOWTRAK_MODEL_CORE_SCRIPTSFOLDER').on('click', async () => {
    await window.API.OpenScriptsFolder();
  });

  $('#SHOWTRAK_MODEL_CORE_BACKUPCONFIG').on('click', async () => {
    await BackupConfig();
  });

  $('#SHOWTRAK_MODEL_CORE_IMPORTCONFIG').on('click', async () => {
    await ImportConfig();
  });

  $('#SHOWTRAK_MODEL_CORE_SUPPORTDISCORD').on('click', async () => {
    await window.API.OpenDiscordInviteLinkInBrowser();
  });

  $('#SHOWTRAK_MODEL_CORE_SHUTDOWN_BUTTON').on('click', async () => {
    window.API.Shutdown();
  });

  // Initialize application mode from backend and wire toggle
  try {
    const mode = await window.API.GetMode();
    RenderMode(mode);
  } catch (_) {
    RenderMode('SHOW');
  }
  // legacy toggle binding removed

  await window.API.Loaded();
}

// Modal display removed per requirements

Init();

// Read-only Client Info modal
async function OpenClientInfo(UUID) {
  try {
    await CloseAllModals();
  } catch {}
  let Client = null;
  try {
    Client = await window.API.GetClient(UUID);
  } catch (e) {
    console.error('Failed to fetch client', e);
  }
  if (!Client) return Notify('Client not found', 'error');

  const { Nickname, Hostname, IP, Version, MacAddress, GroupID, Online } = Client;
  // Group title lookup
  let groupTitle = 'No Group';
  try {
    const groups = await window.API.GetAllGroups();
    if (Array.isArray(groups)) {
      const g = groups.find((x) => x && x.GroupID === GroupID);
      if (g && g.Title) groupTitle = g.Title;
    }
  } catch {}

  $('#CLIENT_INFO_NICKNAME').val(Nickname && Nickname.length ? Nickname : Hostname || '');
  $('#CLIENT_INFO_HOSTNAME').val(Hostname || '');
  $('#CLIENT_INFO_GROUP').val(groupTitle);
  $('#CLIENT_INFO_IP').val(IP || 'Unknown IP');
  if (MacAddress && String(MacAddress).trim().length > 0) {
    $('#CLIENT_INFO_MAC').val(String(MacAddress).toUpperCase());
    $('#CLIENT_INFO_MAC_WRAPPER').removeClass('d-none');
  } else {
    $('#CLIENT_INFO_MAC').val('');
    $('#CLIENT_INFO_MAC_WRAPPER').addClass('d-none');
  }
  $('#CLIENT_INFO_UUID').val(UUID);
  $('#CLIENT_INFO_VERSION').val(Version || '');
  $('#CLIENT_INFO_STATUS').val(Online ? 'Online' : 'Offline');

  RenderClientInfoDetails(Client);

  // mark modal as open for this UUID and clear when hidden
  ClientInfoOpenUUID = UUID;
  try {
    const $modal = $('#SHOWTRAK_CLIENT_INFO');
    $modal.off('hidden.bs.modal.clientinfo').on('hidden.bs.modal.clientinfo', function () {
      ClientInfoOpenUUID = null;
      if (ClientInfoRefreshTimer) {
        clearInterval(ClientInfoRefreshTimer);
        ClientInfoRefreshTimer = null;
      }
      __clientInfoRefreshInFlight = false;
    });
  } catch {}

  $('#SHOWTRAK_CLIENT_INFO').modal('show');

  // Start periodic refresh as a safety net in case events are missed
  try {
    if (ClientInfoRefreshTimer) {
      clearInterval(ClientInfoRefreshTimer);
      ClientInfoRefreshTimer = null;
    }
    ClientInfoRefreshTimer = setInterval(async () => {
      if (!ClientInfoOpenUUID) return;
      if (__clientInfoRefreshInFlight) return;
      __clientInfoRefreshInFlight = true;
      try {
        const fresh = await window.API.GetClient(ClientInfoOpenUUID);
        if (fresh) RenderClientInfoDetails(fresh);
      } catch {}
      __clientInfoRefreshInFlight = false;
    }, 4000);
  } catch {}
}

function RenderClientInfoDetails(Client) {
  // Vitals (CPU/RAM) progress bars
  try {
    const rawCpu = Client && Client.Vitals ? Client.Vitals.CPU?.UsagePercentage : 0;
    const cpuNum = typeof rawCpu === 'number' ? rawCpu : parseFloat(rawCpu);
    const cpuClamped = isNaN(cpuNum) ? 0 : Math.max(0, Math.min(100, cpuNum));

    const rawRam = Client && Client.Vitals ? Client.Vitals.Ram?.UsagePercentage : 0;
    const ramNum = typeof rawRam === 'number' ? rawRam : parseFloat(rawRam);
    const ramClamped = isNaN(ramNum) ? 0 : Math.max(0, Math.min(100, ramNum));

    $('#CLIENT_INFO_CPU_BAR')
      .css('width', `${cpuClamped}%`)
      .attr('aria-valuenow', cpuClamped.toFixed(0));
    $('#CLIENT_INFO_CPU_LABEL').text(`${cpuClamped.toFixed(0)}%`);
    $('#CLIENT_INFO_RAM_BAR')
      .css('width', `${ramClamped}%`)
      .attr('aria-valuenow', ramClamped.toFixed(0));
    // Compose RAM label: used/total (percent%) if we have byte counts
    const ramUsed =
      Client && Client.Vitals && typeof Client.Vitals.Ram?.Used !== 'undefined'
        ? Client.Vitals.Ram.Used
        : null;
    const ramTotal =
      Client && Client.Vitals && typeof Client.Vitals.Ram?.Total !== 'undefined'
        ? Client.Vitals.Ram.Total
        : null;
    if (ramUsed != null && ramTotal != null) {
      const usedStr = FormatBytes(ramUsed);
      const totalStr = FormatBytes(ramTotal);
      if (usedStr && totalStr) {
        $('#CLIENT_INFO_RAM_LABEL').text(`${usedStr} / ${totalStr} (${ramClamped.toFixed(0)}%)`);
      } else {
        $('#CLIENT_INFO_RAM_LABEL').text(`${ramClamped.toFixed(0)}%`);
      }
    } else {
      $('#CLIENT_INFO_RAM_LABEL').text(`${ramClamped.toFixed(0)}%`);
    }
  } catch {}

  // USB devices
  try {
    const $usbList = $('#SHOWTRAK_CLIENT_INFO_USB_DEVICES');
    $usbList.html('');
    const list = Array.isArray(Client.USBDeviceList) ? Client.USBDeviceList : [];
    if (list.length > 0) {
      for (const dev of list) {
        const ManufacturerName = dev.ManufacturerName;
        const ProductName = dev.ProductName;
        const SerialNumber = dev.SerialNumber;
        $usbList.append(`
          <div class="rounded-3 p-2 bg-ghost">
            <h6 class="mb-0">${ManufacturerName ? Safe(ManufacturerName) : 'Generic'} ${
              ProductName ? Safe(ProductName) : 'USB Device'
            }</h6>
            <small class="text-light">Serial Number: ${
              SerialNumber ? Safe(SerialNumber) : 'Unavailable'
            }</small>
          </div>
        `);
      }
    } else {
      $usbList.html(`
        <div class="rounded-3 p-2 bg-ghost">
          <h6 class="mb-0">No USB Devices Connected</h6>
          <p class="text-sm mb-0">Devices that do not comply with WebUSB 1.3 cannot be displayed.</p>
        </div>`);
    }
  } catch {}

  // Network Interfaces
  try {
    const $netList = $('#SHOWTRAK_CLIENT_INFO_NET_INTERFACES');
    $netList.html('');
    const ifaces = Array.isArray(Client.NetworkInterfaces) ? Client.NetworkInterfaces : [];
    if (ifaces.length === 0) {
      $netList.html(
        `<div class="rounded-3 p-2 bg-ghost"><h6 class="mb-0">No Interfaces Reported</h6></div>`
      );
    } else {
      // Sort active first: interfaces with any external (non-internal) address
      const sorted = [...ifaces].sort((a, b) => {
        const aActive =
          Array.isArray(a.addresses) && a.addresses.some((x) => x.address && !x.internal);
        const bActive =
          Array.isArray(b.addresses) && b.addresses.some((x) => x.address && !x.internal);
        return (bActive ? 1 : 0) - (aActive ? 1 : 0);
      });
      for (const iface of sorted) {
        const nameRaw = iface && iface.name ? String(iface.name) : 'unknown';
        const name = Safe(nameRaw || 'unknown');
        const addresses = Array.isArray(iface.addresses) ? iface.addresses : [];
        const macs = Array.from(
          new Set(addresses.map((a) => (a.mac ? String(a.mac).toUpperCase() : '')).filter(Boolean))
        );
        const v4 = addresses.filter((a) => String(a.family).includes('4'));
        const v6 = addresses.filter((a) => String(a.family).includes('6'));
        const displayedAddrs = v4.length > 0 ? v4 : v6; // show IPv6 only if no IPv4 available
        const activeCount = addresses.filter((a) => a.address && !a.internal).length;
        const isActive = activeCount > 0;
        let addrHtml = '';
        if (displayedAddrs.length > 0) {
          for (let i = 0; i < displayedAddrs.length; i++) {
            const a = displayedAddrs[i];
            const fam = Safe(a.family || '');
            const addr = Safe(a.address || '');
            const mask = Safe(a.netmask || '');
            const cidr = a.cidr ? Safe(a.cidr) : '';
            const prefix = cidr && cidr.includes('/') ? `/${cidr.split('/')[1]}` : '';
            const mac = a.mac ? Safe(String(a.mac).toUpperCase()) : '';
            const internalBadge = a.internal
              ? '<span class="badge bg-ghost-light text-light">Internal Only</span>'
              : '<span class="badge bg-ghost text-light">External</span>';
            const scopeEl =
              typeof a.scopeid !== 'undefined' && a.scopeid !== null
                ? `<div class=\"text-sm text-muted\">scope ${Safe(a.scopeid)}</div>`
                : '';
            const idBase = 'IFACE_' + nameRaw.replace(/[^a-zA-Z0-9_-]/g, '') + '_' + i;
            const addrId = idBase + '_ADDR';
            const maskId = idBase + '_MASK';
            const macId = idBase + '_MAC';
            addrHtml += `
              <div class="rounded p-2 d-grid gap-2">
                <div class="d-flex justify-content-between align-items-center">
                  <div class="d-flex gap-2 align-items-center">
                    <span class="badge bg-ghost text-light">${fam}</span>
                    ${internalBadge}
                  </div>
                  ${scopeEl}
                </div>
                <div class="form-floating has-copy">
                  <input type="text" class="form-control disabled" id="${addrId}" value="${addr}${prefix}" disabled />
                  <label for="${addrId}">Address</label>
                  <button type="button" class="copy-field-btn" data-target="#${addrId}" title="Copy">
                    <i class="bi bi-clipboard"></i>
                  </button>
                </div>
                ${
                  mask
                    ? `<div class=\"form-floating has-copy\">` +
                      `<input type=\"text\" class=\"form-control disabled\" id=\"${maskId}\" value=\"${mask}\" disabled />` +
                      `<label for=\"${maskId}\">Netmask</label>` +
                      `<button type=\"button\" class=\"copy-field-btn\" data-target=\"#${maskId}\" title=\"Copy\"><i class=\"bi bi-clipboard\"></i></button>` +
                      `</div>`
                    : ''
                }
                ${
                  mac
                    ? `<div class=\"form-floating has-copy\">` +
                      `<input type=\"text\" class=\"form-control disabled\" id=\"${macId}\" value=\"${mac}\" disabled />` +
                      `<label for=\"${macId}\">MAC Address</label>` +
                      `<button type=\"button\" class=\"copy-field-btn\" data-target=\"#${macId}\" title=\"Copy\"><i class=\"bi bi-clipboard\"></i></button>` +
                      `</div>`
                    : ''
                }
              </div>`;
          }
        } else {
          addrHtml =
            '<div class="text-sm text-muted rounded p-2">No addresses (adapter inactive)</div>';
        }
        const macSummary = macs.length
          ? `<div class="text-sm text-muted">${macs.map((m) => `<code>${Safe(m)}</code>`).join(' • ')}</div>`
          : '';
        $netList.append(`
          <div class="rounded-3 p-2 bg-ghost">
            <div class="d-flex justify-content-between align-items-center">
              <div class="text-start">
                <h6 class="mb-0">${name}</h6>
              </div>
              <div class="d-flex gap-1 align-items-center">
                <span class="badge ${isActive ? 'bg-success' : 'bg-secondary'}">${isActive ? 'Active' : 'Inactive'}</span>
              </div>
            </div>
            <div class="d-grid gap-1 mt-2">${addrHtml}</div>
          </div>`);
      }
    }
  } catch {}
}
