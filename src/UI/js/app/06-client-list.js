window.API.ShutdownRequested(async () => {
  await CloseAllModals();
  let Confirmation = await ConfirmationDialog('Are you sure you want to shutdown ShowTrak?');
  if (!Confirmation) return;
  await window.API.Shutdown(true);
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
  RenderFullClientAndMonitorList();
});

function RenderFullClientAndMonitorList() {
  const Clients = Array.isArray(__LastClients) ? __LastClients.slice() : [];
  let Groups = Array.isArray(__LastGroups) ? __LastGroups.slice() : [];
  const Monitors = Array.isArray(MonitoringTargets) ? MonitoringTargets.slice() : [];
  let Filler = '';

  Groups.push({
    GroupID: null,
    Title: 'No Group',
    Weight: 100000,
  });

  // Sort groups by weight
  Groups = Groups.sort((a, b) => (a.Weight || 0) - (b.Weight || 0));

  if (Groups.length == 1 && Clients.length == 0 && Monitors.length == 0) {
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
    let GroupMonitors = Monitors.filter((M) => (M.GroupID || null) === GroupID);

    GroupUUIDCache.set(
      `${GroupID}`,
      GroupClients.map((c) => c.UUID)
    );

    if (GroupClients.length == 0 && GroupMonitors.length == 0 && GroupID == null) continue;

    // Merge clients + monitors and sort by Weight so a unified ordering set
    // by drag/drop is preserved.
    const Merged = []
      .concat(
        GroupClients.map((c) => ({ kind: 'client', weight: c.Weight || 0, data: c })),
        GroupMonitors.map((m) => ({ kind: 'monitor', weight: m.Weight || 0, data: m }))
      )
      .sort((a, b) => a.weight - b.weight);

    Filler += `<div class="d-flex justify-content-start">
		<div class="GROUP_TITLE_CLICKABLE m-3 me-0 mb-0 rounded" onclick="SelectByGroup('${GroupID}')">
			<div class="d-flex align-items-center text-center h-100">
				<span class="GROUP_TITLE py-2">
					${Safe(Title)}
				</span>
			</div>
		</div>
	<div class="bg-ghost rounded m-3 mb-0 d-flex flex-wrap justify-content-start align-items-center p-3 gap-3 w-100 group-drop-zone" data-groupid="${GroupID}">`;

    if (Merged.length == 0) {
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
      for (const Item of Merged) {
        if (Item.kind === 'client') {
          const { Nickname, Hostname, IP, UUID, Version, Online, LastSeen } = Item.data;
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
        } else {
          Filler += RenderMonitoringTargetTile(Item.data);
        }
      }
    }

    Filler += `</div></div>`;
  }

  // Append Pending Adoption section after groups, if any
  Filler += RenderPendingAdoptionSection();

  $('#APPLICATION_CONTENT').html(Filler);
  // Initialize or teardown edit-mode interactions after render
  if (typeof initializeEditInteractions === 'function') {
    try {
      initializeEditInteractions();
    } catch {}
  }
}

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

