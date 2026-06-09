// --- Monitoring Target Editor ---
async function EnsureMonitoringMethodsLoaded() {
  if (Array.isArray(MonitoringMethodsCache) && MonitoringMethodsCache.length) return;
  try {
    MonitoringMethodsCache = (await window.API.GetMonitoringMethods()) || [];
  } catch {
    MonitoringMethodsCache = [];
  }
}

function RenderMonitoringDynamicSettings(MethodID, CurrentSettings) {
  const Method = MonitoringMethodsCache.find((m) => m.ID === MethodID);
  const $host = $('#MONITORING_TARGET_DYNAMIC_SETTINGS');
  $host.empty();
  if (!Method || !Array.isArray(Method.Settings) || !Method.Settings.length) return;
  const Cur = CurrentSettings || {};
  for (const Field of Method.Settings) {
    const Val = Cur[Field.Key] !== undefined ? Cur[Field.Key] : Field.Default;
    if (Field.Type === 'boolean') {
      $host.append(`
        <div class="form-check form-switch ps-0 d-flex align-items-center justify-content-between bg-ghost-light rounded p-2">
          <label class="form-check-label mb-0" for="MON_DYN_${Safe(Field.Key)}">${Safe(
            Field.Label || Field.Key
          )}</label>
          <input class="form-check-input ms-2" type="checkbox" role="switch" id="MON_DYN_${Safe(
            Field.Key
          )}" data-key="${Safe(Field.Key)}" data-type="boolean" ${Val ? 'checked' : ''} />
        </div>`);
    } else if (Field.Type === 'number') {
      $host.append(`
        <div class="form-floating">
          <input type="number" class="form-control" id="MON_DYN_${Safe(Field.Key)}"
            data-key="${Safe(Field.Key)}" data-type="number"
            ${typeof Field.Min === 'number' ? `min="${Field.Min}"` : ''}
            ${typeof Field.Max === 'number' ? `max="${Field.Max}"` : ''}
            value="${Safe(String(Val))}" placeholder="${Safe(Field.Label || Field.Key)}" />
          <label for="MON_DYN_${Safe(Field.Key)}">${Safe(Field.Label || Field.Key)}</label>
        </div>`);
    } else {
      $host.append(`
        <div class="form-floating">
          <input type="text" class="form-control" id="MON_DYN_${Safe(Field.Key)}"
            data-key="${Safe(Field.Key)}" data-type="string"
            value="${Safe(String(Val == null ? '' : Val))}" placeholder="${Safe(
              Field.Label || Field.Key
            )}" />
          <label for="MON_DYN_${Safe(Field.Key)}">${Safe(Field.Label || Field.Key)}</label>
        </div>`);
    }
  }
}

function CollectMonitoringDynamicSettings() {
  const out = {};
  $('#MONITORING_TARGET_DYNAMIC_SETTINGS')
    .find('[data-key]')
    .each(function () {
      const $el = $(this);
      const key = $el.attr('data-key');
      const type = $el.attr('data-type');
      if (type === 'boolean') {
        out[key] = $el.is(':checked');
      } else if (type === 'number') {
        const n = Number($el.val());
        out[key] = Number.isFinite(n) ? n : null;
      } else {
        out[key] = $el.val();
      }
    });
  return out;
}

function ResolveMonitoringMethodHint(Hint) {
  const normalized = String(Hint || '')
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  const preferred = [normalized];
  if (normalized === 'web') preferred.push('http', 'https');
  if (normalized === 'http' || normalized === 'https') preferred.push('http-json', 'http', 'https');
  if (normalized === 'tcp') preferred.push('tcp-port');
  for (const candidate of preferred) {
    const match = MonitoringMethodsCache.find((m) => String(m.ID).toLowerCase() === candidate);
    if (match) return match.ID;
  }
  return null;
}

function SetNetworkDiscoveryStatus(label) {
  $('#NETWORK_DISCOVERY_STATUS').text(label || 'Idle');
}

function ParseIPv4ToNumber(address) {
  const parts = String(address || '')
    .trim()
    .split('.')
    .map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function RenderNetworkDiscoveryScanButton() {
  const $btn = $('#NETWORK_DISCOVERY_TOGGLE_SCAN');
  if (!$btn.length) return;
  $btn.prop('disabled', false);
  if (NetworkDiscoveryScanning) {
    $btn.addClass('is-scanning').text('Cancel Scan');
  } else {
    $btn.removeClass('is-scanning').text('Start Scan');
  }
}

function SetNetworkDiscoveryProgress(percent, current = 0, total = 0) {
  const p = Math.max(0, Math.min(100, Number.isFinite(Number(percent)) ? Number(percent) : 0));
  const cur = Number.isFinite(Number(current)) ? Number(current) : 0;
  const tot = Number.isFinite(Number(total)) ? Number(total) : 0;
  NetworkDiscoveryProgress = {
    percent: p,
    current: cur,
    total: tot,
  };
  const $btn = $('#NETWORK_DISCOVERY_TOGGLE_SCAN');
  if ($btn.length) {
    $btn.css('--scan-progress', `${p}%`);
  }
}

function RenderNetworkDiscoveryResults() {
  const $host = $('#NETWORK_DISCOVERY_RESULTS_BODY');
  if (!$host.length) return;
  const list = Array.from(NetworkDiscoveryResults.values()).sort((a, b) => {
    const aIp = ParseIPv4ToNumber(a.Address);
    const bIp = ParseIPv4ToNumber(b.Address);
    if (aIp != null && bIp != null) return aIp - bIp;
    if (aIp != null) return -1;
    if (bIp != null) return 1;
    return String(a.Address || '').localeCompare(String(b.Address || ''));
  });

  if (!list.length) {
    $host.html(`
      <tr>
        <td colspan="5" class="text-muted text-center py-3">
          No devices discovered yet. Start a scan to search your local network.
        </td>
      </tr>
    `);
    return;
  }

  let html = '';
  for (const item of list) {
    const id = Safe(item.ID);
    const sourceLabel =
      String(item.Source || 'unknown').toLowerCase() === 'bonjour' ? 'mDNS' : 'Scan';
    const serviceList = Array.isArray(item.Services) ? item.Services.slice(0, 5) : [];
    const details = [];
    if (item.Hostname) details.push(`host: ${Safe(item.Hostname)}`);
    if (serviceList.length) {
      details.push(`services: ${Safe(serviceList.map((s) => s.type).join(', '))}`);
    } else if (item.ServiceType) {
      details.push(`service: ${Safe(item.ServiceType)}`);
    }
    if (item.Port) details.push(`port: ${Safe(String(item.Port))}`);
    const detailsText = details.length ? details.join(' · ') : '-';
    html += `
      <tr>
        <td>
          <div class="nd-name">${Safe(item.Name || item.Address || 'Unnamed Device')}</div>
        </td>
        <td>
          <div class="nd-address">${Safe(item.Address || '')}</div>
        </td>
        <td>
          <span class="badge bg-ghost-light text-light">${Safe(sourceLabel)}</span>
        </td>
        <td>
          <div class="nd-details">${Safe(detailsText)}</div>
        </td>
        <td class="text-end">
          <button type="button" class="btn btn-light btn-sm NETWORK_DISCOVERY_ADD" data-id="${id}">
            Add
          </button>
        </td>
      </tr>`;
  }
  $host.html(html);
}

function ResetNetworkDiscoveryState() {
  NetworkDiscoveryScanID = null;
  NetworkDiscoveryScanning = false;
  NetworkDiscoveryResults = new Map();
  RenderNetworkDiscoveryScanButton();
  SetNetworkDiscoveryStatus('Idle');
  SetNetworkDiscoveryProgress(0, 0, 0);
  RenderNetworkDiscoveryResults();
}

function MergeNetworkDiscoveryResult(result) {
  if (!result || !result.Address) return;
  const addressKey = String(result.Address).trim().toLowerCase();
  if (!addressKey) return;
  const existing = NetworkDiscoveryResults.get(addressKey) || {};
  const existingServices = Array.isArray(existing.Services) ? existing.Services : [];
  const nextServices = existingServices.slice();
  if (result.Source === 'bonjour') {
    const serviceType = String(result.ServiceType || '').trim();
    const servicePort = result.Port == null ? null : Number(result.Port);
    const dedupeKey = `${serviceType.toLowerCase()}:${Number.isFinite(servicePort) ? servicePort : 0}`;
    if (
      serviceType &&
      !nextServices.some(
        (s) => `${String(s.type || '').toLowerCase()}:${Number(s.port) || 0}` === dedupeKey
      )
    ) {
      nextServices.push({
        type: serviceType,
        port: Number.isFinite(servicePort) ? servicePort : null,
      });
    }
  }

  NetworkDiscoveryResults.set(addressKey, {
    ...existing,
    ...result,
    Hostname: result.Hostname || existing.Hostname || null,
    Services: nextServices,
    ID: addressKey,
  });
  RenderNetworkDiscoveryResults();
}

function HandleNetworkDiscoveryEvent(event) {
  if (!event || !event.ScanID) return;
  if (!NetworkDiscoveryScanID || event.ScanID !== NetworkDiscoveryScanID) return;
  if (event.Type === 'status') {
    SetNetworkDiscoveryStatus(event.Status || 'Scanning');
    if (event.Progress) {
      SetNetworkDiscoveryProgress(
        event.Progress.Percent,
        event.Progress.Current,
        event.Progress.Total
      );
    }
    return;
  }
  if (event.Type === 'result' && event.Result) {
    MergeNetworkDiscoveryResult(event.Result);
    return;
  }
  if (event.Type === 'done') {
    NetworkDiscoveryScanning = false;
    RenderNetworkDiscoveryScanButton();
    SetNetworkDiscoveryStatus(event.Status || 'Completed');
    SetNetworkDiscoveryProgress(
      100,
      NetworkDiscoveryProgress.total,
      NetworkDiscoveryProgress.total
    );
  }
}

async function StopNetworkDiscoveryScan() {
  if (!NetworkDiscoveryScanID) {
    NetworkDiscoveryScanning = false;
    RenderNetworkDiscoveryScanButton();
    return;
  }
  const scanID = NetworkDiscoveryScanID;
  NetworkDiscoveryScanID = null;
  NetworkDiscoveryScanning = false;
  RenderNetworkDiscoveryScanButton();
  try {
    await window.API.StopNetworkDeviceScan(scanID);
  } catch {}
}

async function StartNetworkDiscoveryScan() {
  if (NetworkDiscoveryScanning) return;
  await EnsureMonitoringMethodsLoaded();
  NetworkDiscoveryResults = new Map();
  SetNetworkDiscoveryProgress(0, 0, 0);
  RenderNetworkDiscoveryResults();
  NetworkDiscoveryScanning = true;
  RenderNetworkDiscoveryScanButton();
  SetNetworkDiscoveryStatus('Starting...');

  try {
    const [Err, Result] = await window.API.StartNetworkDeviceScan({
      EnableBonjour: true,
      EnableProbe: true,
      TimeoutMs: 12000,
      MaxHostsPerSubnet: 512,
      ProbePorts: [80, 443, 22, 445, 3389, 8080],
    });
    if (Err) {
      NetworkDiscoveryScanning = false;
      RenderNetworkDiscoveryScanButton();
      SetNetworkDiscoveryStatus('Failed');
      return Notify(Err, 'error');
    }
    NetworkDiscoveryScanID = Result && Result.ScanID ? Result.ScanID : null;
    SetNetworkDiscoveryStatus('Scanning...');
  } catch (e) {
    NetworkDiscoveryScanning = false;
    RenderNetworkDiscoveryScanButton();
    SetNetworkDiscoveryStatus('Failed');
    Notify(e && e.message ? e.message : 'Failed to start scan', 'error');
  }
}

async function OpenNetworkDiscoveryModal() {
  await CloseAllModals();
  ResetNetworkDiscoveryState();
  $('#SHOWTRAK_MODAL_NETWORK_DISCOVERY').modal('show');
  await StartNetworkDiscoveryScan();
}

async function OpenMonitoringTargetEditor(TargetID, Prefill = null) {
  await CloseAllModals();
  await EnsureMonitoringMethodsLoaded();

  // Populate method dropdown
  const $method = $('#MONITORING_TARGET_METHOD');
  $method.empty();
  for (const M of MonitoringMethodsCache) {
    $method.append(`<option value="${Safe(M.ID)}">${Safe(M.Name)}</option>`);
  }

  let Existing = null;
  if (TargetID) {
    Existing = await window.API.GetMonitoringTarget(TargetID);
  }
  MonitoringEditorTargetID = Existing ? Existing.TargetID : null;

  $('#MONITORING_TARGET_MODAL_TITLE').text(
    Existing ? 'Edit Monitoring Target' : 'Add Monitoring Target'
  );
  $('#MONITORING_TARGET_DANGER_ZONE').toggleClass('d-none', !Existing);

  const Defaults = {
    Nickname: (Prefill && Prefill.Nickname) || '',
    Address: (Prefill && Prefill.Address) || '',
    Method: MonitoringMethodsCache[0] && MonitoringMethodsCache[0].ID,
    Interval: 30000,
    StoreHistory: false,
    DegradedThresholdMs: 0,
    Settings: {},
  };
  if (!Existing && Prefill && Prefill.Method) {
    const hinted = ResolveMonitoringMethodHint(Prefill.Method);
    if (hinted) Defaults.Method = hinted;
  }
  const T = Existing || Defaults;

  $('#MONITORING_TARGET_NICKNAME').val(T.Nickname || '');
  $('#MONITORING_TARGET_ADDRESS').val(T.Address || '');
  $method.val(T.Method || Defaults.Method);
  $('#MONITORING_TARGET_INTERVAL').val(T.Interval || 30000);
  $('#MONITORING_TARGET_INTERVAL_LABEL').text(FormatInterval(T.Interval || 30000));
  $('#MONITORING_TARGET_STORE_HISTORY').prop('checked', !!T.StoreHistory);
  $('#MONITORING_TARGET_DEGRADED_THRESHOLD').val(
    Number.isFinite(Number(T.DegradedThresholdMs)) ? Number(T.DegradedThresholdMs) : 0
  );

  RenderMonitoringDynamicSettings($method.val(), T.Settings || {});

  // Live label for the slider
  $('#MONITORING_TARGET_INTERVAL')
    .off('input.mon')
    .on('input.mon', function () {
      $('#MONITORING_TARGET_INTERVAL_LABEL').text(FormatInterval($(this).val()));
    });

  // Re-render dynamic settings when method changes (preserve overlapping keys)
  $method.off('change.mon').on('change.mon', function () {
    RenderMonitoringDynamicSettings($(this).val(), CollectMonitoringDynamicSettings());
  });

  $('#MONITORING_TARGET_SAVE')
    .off('click.mon')
    .on('click.mon', async () => {
      const Payload = {
        Nickname: ($('#MONITORING_TARGET_NICKNAME').val() || '').trim(),
        Address: ($('#MONITORING_TARGET_ADDRESS').val() || '').trim(),
        Method: $method.val(),
        Interval: parseInt($('#MONITORING_TARGET_INTERVAL').val(), 10),
        StoreHistory: $('#MONITORING_TARGET_STORE_HISTORY').is(':checked'),
        DegradedThresholdMs: Math.max(
          0,
          parseInt($('#MONITORING_TARGET_DEGRADED_THRESHOLD').val(), 10) || 0
        ),
        Settings: CollectMonitoringDynamicSettings(),
      };
      if (!Payload.Nickname) return Notify('Please enter a name', 'error');
      if (!Payload.Address) return Notify('Please enter an address', 'error');
      if (!Payload.Method) return Notify('Please choose a monitoring method', 'error');

      try {
        if (MonitoringEditorTargetID) {
          const [Err] = await window.API.UpdateMonitoringTarget(MonitoringEditorTargetID, Payload);
          if (Err) return Notify(Err, 'error');
          await Notify('Monitoring target updated', 'success');
        } else {
          const [Err] = await window.API.CreateMonitoringTarget(Payload);
          if (Err) return Notify(Err, 'error');
          await Notify('Monitoring target created', 'success');
        }
        await CloseAllModals();
      } catch (e) {
        Notify(e && e.message ? e.message : 'Failed to save monitoring target', 'error');
      }
    });

  $('#MONITORING_TARGET_DELETE')
    .off('click.mon')
    .on('click.mon', async () => {
      if (!MonitoringEditorTargetID) return;
      const Confirmation = await ConfirmationDialog(
        'Delete this monitoring target? This cannot be undone.'
      );
      if (!Confirmation) return;
      const [Err] = await window.API.DeleteMonitoringTarget(MonitoringEditorTargetID);
      if (Err) return Notify(Err, 'error');
      await Notify('Monitoring target deleted', 'success');
      await CloseAllModals();
    });

  $('#SHOWTRAK_MODAL_MONITORING_TARGET').modal('show');
}
