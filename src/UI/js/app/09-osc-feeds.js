const HttpApiRoutes = [
  {
    Methods: 'GET, POST',
    Path: '/API/Dummy/:id/Heartbeat',
    Title: 'Deliver a heartbeat to a Dummy Client by its Dummy ID',
  },
];

const OSC_HTTP_DEBUG_MAX_LINES = 300;
let OscHttpDebugEntries = [];
let OscHttpDebugModalOpen = false;

function FormatDebugTime(timestamp) {
  const date = new Date(Number(timestamp) || Date.now());
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function EscapeHtml(value) {
  return Safe(value == null ? '' : String(value));
}

function RenderOscHttpDebugTerminal() {
  const $terminal = $('#OSC_HTTP_DEBUG_TERMINAL');
  if (!$terminal.length) return;

  if (!OscHttpDebugEntries.length) {
    $terminal.html(
      '<div class="osc-http-debug-empty">Open this terminal and send OSC or /API traffic to inspect requests.</div>'
    );
    return;
  }

  $terminal.html(
    OscHttpDebugEntries.map((entry) => {
      const stateClass = entry.valid ? 'is-valid' : 'is-invalid';
      const icon = entry.valid ? '&#10003;' : '&#10005;';
      const protocol = EscapeHtml(String(entry.protocol || '').toUpperCase());
      const summary = EscapeHtml(entry.summary || 'Unknown request');
      const detail = entry.detail ? `<span class="osc-http-debug-detail">${EscapeHtml(entry.detail)}</span>` : '';
      return `
		<div class="osc-http-debug-line ${stateClass}">
			<div class="osc-http-debug-status">${icon}</div>
			<div class="osc-http-debug-meta">[${EscapeHtml(FormatDebugTime(entry.timestamp))}] ${protocol}</div>
			<div class="osc-http-debug-text"><span class="osc-http-debug-summary">${summary}</span>${detail}</div>
		</div>
	`;
    }).join('')
  );

  const terminal = $terminal.get(0);
  if (terminal) terminal.scrollTop = terminal.scrollHeight;
}

function AppendOscHttpDebugEntry(entry) {
  if (!OscHttpDebugModalOpen) return;
  OscHttpDebugEntries.push(entry);
  if (OscHttpDebugEntries.length > OSC_HTTP_DEBUG_MAX_LINES) {
    OscHttpDebugEntries = OscHttpDebugEntries.slice(-OSC_HTTP_DEBUG_MAX_LINES);
  }
  RenderOscHttpDebugTerminal();
}

function RenderRouteEntry($Container, Route) {
  let PathFiller = '';
  for (const Segment of String(Route.Path || '').split('/').filter((s) => s.length > 0)) {
    PathFiller += `<span class="">/</span>`;
    if (Segment.startsWith(':')) {
      PathFiller += `<span class="text-info">[${Safe(Segment.substring(1))}]</span>`;
    } else {
      PathFiller += `<span>${Safe(Segment)}</span>`;
    }
  }

  const MethodLabel = Route.Methods ? `<div class="text-uppercase small text-muted">${Safe(Route.Methods)}</div>` : '';

  $Container.append(`
		<div class="d-grid gap-2 p-2 rounded bg-ghost rounded-3">
			${MethodLabel}
			<code class="bg-ghost rounded p-2">${PathFiller}</code>
			<p class="mb-0">${Safe(Route.Title)}</p>
		</div>
	`);
}

async function OpenOSCDictionary() {
  await CloseAllModals();
  $('#OSC_ROUTE_LIST_MODAL').modal('show');
}

async function OpenOscHttpDebugTerminal() {
  await CloseAllModals();
  $('#OSC_HTTP_DEBUG_MODAL').modal('show');
}

$('#OSC_HTTP_DEBUG_MODAL')
  .off('shown.bs.modal.oschttpdebug hidden.bs.modal.oschttpdebug')
  .on('shown.bs.modal.oschttpdebug', () => {
    OscHttpDebugEntries = [];
    OscHttpDebugModalOpen = true;
    RenderOscHttpDebugTerminal();
  })
  .on('hidden.bs.modal.oschttpdebug', () => {
    OscHttpDebugModalOpen = false;
    OscHttpDebugEntries = [];
    RenderOscHttpDebugTerminal();
  });

window.API.Notify(async (Message, Type, Duration) => {
  Notify(Message, Type, Duration);
});

window.API.DebugTrafficEntry(async (Entry) => {
  AppendOscHttpDebugEntry({
    protocol: Entry && Entry.protocol ? Entry.protocol : 'unknown',
    timestamp: Entry && Entry.timestamp ? Entry.timestamp : Date.now(),
    valid: !!(Entry && Entry.valid),
    summary: Entry && Entry.summary ? Entry.summary : 'Unknown request',
    detail: Entry && Entry.detail ? Entry.detail : '',
  });
});

window.API.SetOSCList(async (Routes) => {
  $('#OSC_ROUTE_LIST').html('');
  $('#OSC_ROUTE_LIST').append(`
		<div class="d-grid gap-2 p-2 rounded bg-ghost-light rounded-3">
			<div class="fw-semibold">HTTP API</div>
			<div class="text-muted small">The following HTTP API routes are accessible on port 3000.</div>
		</div>
	`);
  for (const Route of HttpApiRoutes) {
    RenderRouteEntry($('#OSC_ROUTE_LIST'), Route);
  }

  $('#OSC_ROUTE_LIST').append(`
		<div class="d-grid gap-2 p-2 rounded bg-ghost-light rounded-3 mt-2">
			<div class="fw-semibold">OSC Routes</div>
			<div class="text-muted small">The following OSC routes are accessible on port 3333.</div>
		</div>
	`);
  for (const Route of Routes) {
    RenderRouteEntry($('#OSC_ROUTE_LIST'), Route);
  }
  return;
});

window.API.ClientUpdated(async (Data) => {
  // Keep cached full-client list in sync with live heartbeat updates so
  // secondary views (e.g. Update Manager) reflect current Online state.
  try {
    if (Array.isArray(__LastClients) && Data && Data.UUID) {
      const idx = __LastClients.findIndex((client) => client && client.UUID === Data.UUID);
      if (idx >= 0) {
        __LastClients[idx] = {
          ...__LastClients[idx],
          ...Data,
        };
      }
    }

    if (
      typeof RenderUpdateManagerClientList === 'function' &&
      $('#SHOWTRAK_MODAL_UPDATE_MANAGER').hasClass('show')
    ) {
      RenderUpdateManagerClientList();
    }
  } catch (err) {
    HandleNonFatalError('ClientUpdated:UpdateManagerCacheSync', err);
  }

  // Online transition handling: auto-dismiss any pending offline alerts when a
  // client comes back online. Offline transitions intentionally do not raise a
  // UI notification.
  try {
    if (!window.__CLIENT_ONLINE_STATE) window.__CLIENT_ONLINE_STATE = new Map();
    const prev = window.__CLIENT_ONLINE_STATE.get(Data.UUID);
    if (typeof prev === 'boolean' && prev !== Data.Online && Data.Online) {
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
      } catch (err) {
        HandleNonFatalError('ClientUpdated:DismissOfflineAlert', err);
      }
    }
    window.__CLIENT_ONLINE_STATE.set(Data.UUID, !!Data.Online);
  } catch (err) {
    HandleNonFatalError('ClientUpdated:TransitionAlerts', err);
  }
  const { UUID, Nickname, Hostname, Version, IP, Online, Vitals } = Data;
  const Degraded = !!Data.Degraded;
  const DegradedWarning =
    Array.isArray(Data.DegradedWarnings) && Data.DegradedWarnings.length
      ? String(Data.DegradedWarnings[0])
      : 'Missing USB Device';

  $(`[data-uuid='${UUID}']`).toggleClass('ONLINE', Online && !Degraded);
  $(`[data-uuid='${UUID}']`).toggleClass('DEGRADED', Degraded);
  $(`[data-uuid='${UUID}']>[data-type='INDICATOR_DEGRADED']>[data-type='DEGRADED_WARNING']`).text(
    DegradedWarning
  );

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

  const CompactOnlineStatus = $(`[data-uuid='${UUID}']>[data-type="COMPACT_ONLINE_STATUS"]`);
  if (CompactOnlineStatus.length) {
    CompactOnlineStatus.text('Online');
    CompactOnlineStatus.toggleClass('d-none', !Online);
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

    $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_DEGRADED"]`).toggleClass(
      'd-grid',
      Degraded
    );
    $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_DEGRADED"]`).toggleClass(
      'd-none',
      !Degraded
    );
    $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_ONLINE"]`).toggleClass(
      'd-none',
      Degraded
    );
    $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_ONLINE"]`).toggleClass(
      'd-grid',
      !Degraded
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
    $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_DEGRADED"]`).addClass(
      'd-none'
    );
    $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_DEGRADED"]`).removeClass(
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
  } catch (err) {
    HandleNonFatalError('ClientUpdated:RenderClientInfoDetails', err);
  }
  return;
});

// --- Monitoring Targets ---
window.API.SetFullMonitoringTargetList(async (List) => {
  MonitoringTargets = Array.isArray(List) ? List : [];
  // Re-render the full client+monitor view so monitors slot back into their groups.
  if (typeof RenderFullClientAndMonitorList === 'function') {
    RenderFullClientAndMonitorList();
  }
});

window.API.MonitoringTargetUpdated(async (Target) => {
  if (!Target || !Target.TargetID) return;
  const idx = MonitoringTargets.findIndex((t) => t.TargetID === Target.TargetID);
  const prev = idx === -1 ? null : MonitoringTargets[idx];
  if (idx === -1) {
    MonitoringTargets.push(Target);
  } else {
    MonitoringTargets[idx] = Target;
  }
  // If a monitor changed groups, re-render. Otherwise update in place.
  if (!prev || (prev.GroupID || null) !== (Target.GroupID || null)) {
    if (typeof RenderFullClientAndMonitorList === 'function') {
      RenderFullClientAndMonitorList();
    }
  } else {
    UpdateMonitoringTargetTile(Target);
  }
  if (
    MonitorHistoryModalTargetID &&
    Number(MonitorHistoryModalTargetID) === Number(Target.TargetID)
  ) {
    await LoadMonitoringTargetHistory(Target.TargetID);
    RenderMonitoringHistoryModal();
  }
});

window.API.SetFullAlertRuleList(async (List) => {
  AlertRulesCache = Array.isArray(List) ? List : [];
  RenderAlertRuleManagerList();
});

// --- Dummy Clients ---
window.API.SetFullDummyClientList(async (List) => {
  DummyClients = Array.isArray(List) ? List : [];
  // Re-render the full client+monitor view so dummies slot back into groups.
  if (typeof RenderFullClientAndMonitorList === 'function') {
    RenderFullClientAndMonitorList();
  }
});

window.API.DummyClientUpdated(async (Dummy) => {
  if (!Dummy || !Dummy.UUID) return;
  const idx = DummyClients.findIndex((d) => d.UUID === Dummy.UUID);
  const prev = idx === -1 ? null : DummyClients[idx];
  if (idx === -1) {
    DummyClients.push(Dummy);
  } else {
    DummyClients[idx] = Dummy;
  }
  // If a dummy changed groups (or is new), re-render. Otherwise update in place.
  if (!prev || (prev.GroupID || null) !== (Dummy.GroupID || null)) {
    if (typeof RenderFullClientAndMonitorList === 'function') {
      RenderFullClientAndMonitorList();
    }
  } else {
    UpdateDummyClientTile(Dummy);
  }
});

window.API.CreateShowTrakAlert(async (Payload) => {
  if (!Payload) return;
  AddAlert({
    type: 'warning',
    severity: Payload.Severity || 'info',
    title: Payload.Title || 'ShowTrak Alert',
    message: Payload.Message || '',
    clientUUID: Payload.UUID || null,
  });
});
