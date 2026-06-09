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
  if (MonitorHistoryModalTargetID && Number(MonitorHistoryModalTargetID) === Number(Target.TargetID)) {
    await LoadMonitoringTargetHistory(Target.TargetID);
    RenderMonitoringHistoryModal();
  }
});

window.API.SetFullAlertRuleList(async (List) => {
  AlertRulesCache = Array.isArray(List) ? List : [];
  RenderAlertRuleManagerList();
});

window.API.AlertTriggered(async (Event) => {
  if (!Event || !Event.Context) return;
  const Ctx = Event.Context;
  const TriggerLabel = String(Event.TriggerType || '').replace(/_/g, ' ').toLowerCase();
  AddAlert({
    type: 'warning',
    severity: Ctx.Severity || 'warning',
    title: Event.RuleTitle || `Alert (${TriggerLabel})`,
    message: Ctx.Description || `${Ctx.EntityName || 'Unknown'} (${TriggerLabel})`,
    clientUUID: Ctx.UUID || null,
  });
});

