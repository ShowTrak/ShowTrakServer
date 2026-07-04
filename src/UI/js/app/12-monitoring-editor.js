// --- Monitoring Target Editor ---
async function EnsureMonitoringMethodsLoaded() {
  if (Array.isArray(MonitoringMethodsCache) && MonitoringMethodsCache.length) return;
  try {
    MonitoringMethodsCache = (await window.API.GetMonitoringMethods()) || [];
  } catch {
    MonitoringMethodsCache = [];
  }
}

function BuildMonitoringCheckFieldHtml(Field, Val) {
  if (Field.Type === 'boolean') {
    return `
      <div class="form-check form-switch ps-0 d-flex align-items-center justify-content-between bg-ghost rounded p-2">
        <label class="form-check-label mb-0 ms-2" for="MON_DYN_${Safe(Field.Key)}">${Safe(
          Field.Label || Field.Key
        )}</label>
        <input class="form-check-input ms-2 me-2" type="checkbox" role="switch" id="MON_DYN_${Safe(
          Field.Key
        )}" data-key="${Safe(Field.Key)}" data-type="boolean" ${Val ? 'checked' : ''} />
      </div>`;
  } else if (Field.Type === 'number') {
    return `
      <div class="form-floating">
        <input type="number" class="form-control" id="MON_DYN_${Safe(Field.Key)}"
          data-key="${Safe(Field.Key)}" data-type="number"
          ${typeof Field.Min === 'number' ? `min="${Field.Min}"` : ''}
          ${typeof Field.Max === 'number' ? `max="${Field.Max}"` : ''}
          value="${Safe(String(Val))}" placeholder="${Safe(Field.Label || Field.Key)}" />
        <label for="MON_DYN_${Safe(Field.Key)}">${Safe(Field.Label || Field.Key)}</label>
      </div>`;
  } else if (Field.Type === 'select') {
    const Options = Array.isArray(Field.Options) ? Field.Options : [];
    const OptionsHtml = Options.map((Opt) => {
      const OptLabel = typeof Opt === 'object' ? Opt.label : String(Opt);
      const OptValue = typeof Opt === 'object' ? Opt.value : String(Opt);
      const Selected = String(OptValue) === String(Val) ? 'selected' : '';
      return `<option value="${Safe(String(OptValue))}" ${Selected}>${Safe(OptLabel)}</option>`;
    }).join('');
    return `
      <div class="form-floating">
        <select class="form-select" id="MON_DYN_${Safe(Field.Key)}"
          data-key="${Safe(Field.Key)}" data-type="string">
          ${OptionsHtml}
        </select>
        <label for="MON_DYN_${Safe(Field.Key)}">${Safe(Field.Label || Field.Key)}</label>
      </div>`;
  }
  return `
    <div class="form-floating">
      <input type="text" class="form-control" id="MON_DYN_${Safe(Field.Key)}"
        data-key="${Safe(Field.Key)}" data-type="string"
        value="${Safe(String(Val == null ? '' : Val))}" placeholder="${Safe(
          Field.Label || Field.Key
        )}" />
      <label for="MON_DYN_${Safe(Field.Key)}">${Safe(Field.Label || Field.Key)}</label>
    </div>`;
}

function RenderMonitoringCheckDynamicSettings(MethodID, CurrentSettings) {
  const Method = MonitoringMethodsCache.find((m) => m.ID === MethodID);
  const $host = $('#MONITORING_CHECK_DYNAMIC_SETTINGS');
  const $advHost = $('#MONITORING_CHECK_ADVANCED_SETTINGS');
  $host.empty();
  $advHost.empty();
  if (!Method || !Array.isArray(Method.Settings) || !Method.Settings.length) return;
  const Cur = CurrentSettings || {};
  for (const Field of Method.Settings) {
    const Val = Cur[Field.Key] !== undefined ? Cur[Field.Key] : Field.Default;
    const Html = BuildMonitoringCheckFieldHtml(Field, Val);
    // Fields flagged Advanced live in the collapsed "Advanced" section; the rest
    // render inline under the address.
    if (Field.Advanced) {
      $advHost.append(Html);
    } else {
      $host.append(Html);
    }
  }
}

function CollectMonitoringCheckDynamicSettings() {
  const out = {};
  $('#MONITORING_CHECK_DYNAMIC_SETTINGS, #MONITORING_CHECK_ADVANCED_SETTINGS')
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
  } catch (err) {
    HandleNonFatalError('MonitoringEditor:StopNetworkDiscoveryScan', err);
  }
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

// --- Multi-check monitoring target editor ---------------------------------

// Locate the persisted target (if any) in the live cache so we can surface each
// check's current runtime status in the list view.
function GetLiveMonitoringTarget() {
  if (!MonitoringEditorState || MonitoringEditorState.TargetID == null) return null;
  return (
    MonitoringTargets.find(
      (t) => Number(t.TargetID) === Number(MonitoringEditorState.TargetID)
    ) || null
  );
}

function FindLiveMonitoringCheck(check) {
  const target = GetLiveMonitoringTarget();
  if (!target || !Array.isArray(target.Checks) || check.CheckID == null) return null;
  return target.Checks.find((c) => Number(c.CheckID) === Number(check.CheckID)) || null;
}

function SetMonitoringSaveHint(text, cls) {
  const $h = $('#MONITORING_TARGET_SAVE_HINT');
  const value = String(text || '').trim();
  $h.text('');
  $h.removeClass('text-muted text-danger text-success');
  $h.addClass('d-none');

  // Monitoring editor feedback should use the global notification system, not
  // inline hints in the modal footer.
  if (!value) {
    SetMonitoringSaveHint.LastNotified = '';
    return;
  }

  const type = cls === 'text-danger' ? 'error' : cls === 'text-success' ? 'success' : 'info';
  const signature = `${type}:${value}`;
  if (SetMonitoringSaveHint.LastNotified === signature) return;
  SetMonitoringSaveHint.LastNotified = signature;
  if (typeof Notify === 'function') Notify(value, type);
}

function RenderMonitoringCheckList() {
  const $host = $('#MONITORING_TARGET_CHECK_LIST');
  $host.empty();
  const checks = (MonitoringEditorState && MonitoringEditorState.Checks) || [];
  if (!checks.length) {
    $host.append(
      '<div class="bg-ghost rounded p-3 text-muted text-center" data-type="NO_CHECKS_PLACEHOLDER">No checks yet</div>'
    );
    return;
  }
  checks.forEach((check, index) => {
    const live = FindLiveMonitoringCheck(check);
    const method = String(check.Method || '').toUpperCase();
    // Fall back to the method's friendly name when no label has been set.
    const methodMeta = MonitoringMethodsCache.find((m) => m.ID === check.Method);
    const methodName = (methodMeta && methodMeta.Name) || method || 'Unnamed check';
    const name = check.Name || methodName;
    const ip = check.Address || '';
    // Badge colour conveys the live status (online / degraded / offline); checks
    // that haven't run yet keep the neutral badge.
    let badgeClass = 'bg-ghost-light text-light';
    let badgeTitle = 'Not checked yet';
    if (live) {
      if (!live.Online) {
        badgeClass = 'bg-danger text-light';
        badgeTitle = 'Offline';
      } else if (live.Degraded) {
        badgeClass = 'bg-warning text-dark';
        badgeTitle = 'Degraded';
      } else {
        badgeClass = 'bg-success text-light';
        badgeTitle = 'Online';
      }
    }
    $host.append(`
      <div class="d-flex align-items-center gap-2 bg-ghost rounded p-2 monitoring-check-row" data-index="${index}" role="button">
        <div class="flex-grow-1 text-start">
          <div class="text-light" data-type="CHECK_NAME">${Safe(name)}</div>
          ${ip ? `<small class="text-muted" data-type="CHECK_IP">${Safe(ip)}</small>` : ''}
        </div>
        <div class="d-flex align-items-center">
          <span class="badge ${badgeClass}" data-type="CHECK_METHOD" title="${Safe(badgeTitle)}">${Safe(method)}</span>
        </div>
        <i class="bi bi-chevron-right text-light MONITORING_CHECK_EDIT" data-index="${index}" role="button" aria-label="Edit Check" style="cursor: pointer;"></i>
      </div>`);
  });
}

function ShowMonitoringListView() {
  if (!MonitoringEditorState) return;
  MonitoringEditorState.View = 'list';
  MonitoringEditorState.EditingIndex = null;
  $('#MONITORING_TARGET_CHECK_VIEW').addClass('d-none');
  $('#MONITORING_TARGET_LIST_VIEW').removeClass('d-none');
  RenderMonitoringCheckList();
}

function CloseMonitoringCheckCollapses() {
  const IDs = ['MONITORING_CHECK_ADVANCED', 'MONITORING_CHECK_DEBUG_COLLAPSE'];
  IDs.forEach((ID) => {
    const El = document.getElementById(ID);
    if (!El) return;
    if (typeof bootstrap !== 'undefined' && bootstrap.Collapse) {
      bootstrap.Collapse.getOrCreateInstance(El, { toggle: false }).hide();
      return;
    }
    El.classList.remove('show');
  });
}

function OpenMonitoringCheckView(index) {
  if (!MonitoringEditorState) return;
  const check = MonitoringEditorState.Checks[index];
  if (!check) return;
  MonitoringEditorState.EditingIndex = index;
  MonitoringEditorState.View = 'check';

  $('#MONITORING_CHECK_VIEW_TITLE').text(check.CheckID != null ? 'Edit Check' : 'New Check');
  $('#MONITORING_CHECK_NAME').val(check.Name || '');
  $('#MONITORING_CHECK_ADDRESS').val(check.Address || '');

  const $method = $('#MONITORING_CHECK_METHOD');
  $method.empty();
  for (const M of MonitoringMethodsCache) {
    $method.append(`<option value="${Safe(M.ID)}">${Safe(M.Name)}</option>`);
  }
  $method.val(check.Method || (MonitoringMethodsCache[0] && MonitoringMethodsCache[0].ID));

  $('#MONITORING_CHECK_DEGRADED_THRESHOLD').val(
    Number.isFinite(Number(check.DegradedThresholdMs)) ? Number(check.DegradedThresholdMs) : 0
  );

  RenderMonitoringCheckDynamicSettings($method.val(), check.Settings || {});

  $('#MONITORING_TARGET_LIST_VIEW').addClass('d-none');
  $('#MONITORING_TARGET_CHECK_VIEW').removeClass('d-none');
  CloseMonitoringCheckCollapses();

  // Reset then (re)load the live "last response" debug panel for this check.
  $('#MONITORING_CHECK_DEBUG_META').text('');
  $('#MONITORING_CHECK_DEBUG_BODY').html(
    '<div class="text-muted small fst-italic">Loading latest response…</div>'
  );
  LoadMonitoringCheckDebug();
}

// Render the memory-only per-check debug payload returned by the server. The
// Html comes from the method module (which escapes any untrusted values), so it
// is safe to inject directly.
function RenderMonitoringCheckDebug(payload) {
  const $body = $('#MONITORING_CHECK_DEBUG_BODY');
  const $meta = $('#MONITORING_CHECK_DEBUG_META');
  if (!$body.length) return;

  if (!payload || (payload.LastChecked == null && !payload.Html)) {
    $meta.text('');
    $body.html(
      '<div class="text-muted small fst-italic">Waiting for the first check to run…</div>'
    );
    return;
  }

  let statusText = 'Online';
  if (!payload.Online) statusText = 'Offline';
  else if (payload.Degraded) statusText = 'Degraded';

  let when = '';
  if (payload.LastChecked) {
    try {
      when = new Date(Number(payload.LastChecked)).toLocaleTimeString();
    } catch {
      when = '';
    }
  }
  $meta.text(when ? `${statusText} · ${when}` : statusText);

  if (payload.Html) {
    $body.html(payload.Html);
  } else {
    $body.html('<div class="text-muted small fst-italic">No response details available yet.</div>');
  }
}

// Fetch the latest debug snapshot for the check currently open in the editor.
async function LoadMonitoringCheckDebug() {
  const $body = $('#MONITORING_CHECK_DEBUG_BODY');
  if (!$body.length) return;
  if (!MonitoringEditorState || MonitoringEditorState.View !== 'check') return;
  const index = MonitoringEditorState.EditingIndex;
  const check = index == null ? null : MonitoringEditorState.Checks[index];
  if (!check) return;

  if (check.CheckID == null) {
    $('#MONITORING_CHECK_DEBUG_META').text('');
    $body.html(
      '<div class="text-muted small fst-italic">Save this check to see its latest response.</div>'
    );
    return;
  }

  const requestedCheckID = check.CheckID;
  let payload = null;
  try {
    payload = await window.API.GetMonitoringCheckDebug(requestedCheckID);
  } catch (err) {
    HandleNonFatalError('MonitoringEditor:LoadMonitoringCheckDebug', err);
    return;
  }

  // The user may have navigated away or switched checks while we awaited.
  if (!MonitoringEditorState || MonitoringEditorState.View !== 'check') return;
  const curIndex = MonitoringEditorState.EditingIndex;
  const curCheck = curIndex == null ? null : MonitoringEditorState.Checks[curIndex];
  if (!curCheck || Number(curCheck.CheckID) !== Number(requestedCheckID)) return;

  RenderMonitoringCheckDebug(payload);
}

// Called from the live MonitoringTargetUpdated feed so the open check editor's
// debug panel refreshes as new probe results arrive.
function RefreshMonitoringCheckDebugIfOpen(TargetID) {
  if (!MonitoringEditorState || MonitoringEditorState.View !== 'check') return;
  if (MonitoringEditorState.TargetID == null) return;
  if (Number(MonitoringEditorState.TargetID) !== Number(TargetID)) return;
  LoadMonitoringCheckDebug();
}

// Manually run the check currently open in the editor and refresh its debug
// panel with the fresh response. Flushes any pending auto-save first so the
// server probes the check's current configuration.
async function RunMonitoringCheckNow() {
  if (!MonitoringEditorState || MonitoringEditorState.View !== 'check') return;
  const index = MonitoringEditorState.EditingIndex;
  const check = index == null ? null : MonitoringEditorState.Checks[index];
  if (!check) return;

  // Commit + flush the debounced save so the persisted check reflects the UI.
  CommitMonitoringCheckView();
  if (MonitoringEditorState.saveTimer) {
    clearTimeout(MonitoringEditorState.saveTimer);
    MonitoringEditorState.saveTimer = null;
  }
  await PerformMonitoringAutoSave();

  const curIndex = MonitoringEditorState.EditingIndex;
  const curCheck = curIndex == null ? null : MonitoringEditorState.Checks[curIndex];
  if (!curCheck || curCheck.CheckID == null) {
    $('#MONITORING_CHECK_DEBUG_META').text('');
    $('#MONITORING_CHECK_DEBUG_BODY').html(
      '<div class="text-muted small fst-italic">Give this check a valid address to run it.</div>'
    );
    return;
  }

  const requestedCheckID = curCheck.CheckID;
  const $btn = $('#MONITORING_CHECK_RUN_NOW');
  const $icon = $btn.find('.bi');
  $btn.prop('disabled', true);
  $icon.addClass('monitoring-spin');
  $('#MONITORING_CHECK_DEBUG_BODY').html(
    '<div class="text-muted small fst-italic">Running check…</div>'
  );

  let payload = null;
  try {
    payload = await window.API.RunMonitoringCheckNow(requestedCheckID);
  } catch (err) {
    HandleNonFatalError('MonitoringEditor:RunMonitoringCheckNow', err);
  } finally {
    $btn.prop('disabled', false);
    $icon.removeClass('monitoring-spin');
  }

  // Only paint if the user is still on the same check.
  if (!MonitoringEditorState || MonitoringEditorState.View !== 'check') return;
  const stillIndex = MonitoringEditorState.EditingIndex;
  const stillCheck = stillIndex == null ? null : MonitoringEditorState.Checks[stillIndex];
  if (!stillCheck || Number(stillCheck.CheckID) !== Number(requestedCheckID)) return;
  RenderMonitoringCheckDebug(payload);
}

// Pull the check-edit view fields back into the working state + schedule a save.
function CommitMonitoringCheckView() {
  if (!MonitoringEditorState) return;
  const index = MonitoringEditorState.EditingIndex;
  if (index == null) return;
  const check = MonitoringEditorState.Checks[index];
  if (!check) return;
  check.Name = ($('#MONITORING_CHECK_NAME').val() || '').trim();
  check.Address = ($('#MONITORING_CHECK_ADDRESS').val() || '').trim();
  check.Method = $('#MONITORING_CHECK_METHOD').val();
  check.DegradedThresholdMs = Math.max(
    0,
    parseInt($('#MONITORING_CHECK_DEGRADED_THRESHOLD').val(), 10) || 0
  );
  check.Settings = CollectMonitoringCheckDynamicSettings();
  ScheduleMonitoringAutoSave();
}

function BuildMonitoringPayload() {
  const s = MonitoringEditorState;
  return {
    Nickname: (s.Nickname || '').trim(),
    Interval: s.Interval,
    GroupID: s.GroupID == null ? null : s.GroupID,
    Checks: s.Checks.map((c) => {
      const out = {
        Name: c.Name || '',
        Address: (c.Address || '').trim(),
        Method: c.Method,
        Settings: c.Settings || {},
        DegradedThresholdMs: Math.max(0, Number(c.DegradedThresholdMs) || 0),
      };
      if (c.CheckID != null) out.CheckID = c.CheckID;
      return out;
    }),
  };
}

function MonitoringPayloadIsValid(payload) {
  if (!payload.Nickname) return false;
  // A target may legitimately have zero checks (it renders as degraded). Any
  // checks that do exist must be fully configured before we save.
  for (const c of payload.Checks) {
    if (!c.Address || !c.Method) return false;
  }
  return true;
}

function ScheduleMonitoringAutoSave() {
  if (!MonitoringEditorState) return;
  if (MonitoringEditorState.saveTimer) clearTimeout(MonitoringEditorState.saveTimer);
  MonitoringEditorState.saveTimer = setTimeout(() => {
    PerformMonitoringAutoSave();
  }, 500);
}

async function PerformMonitoringAutoSave() {
  if (!MonitoringEditorState) return;
  const payload = BuildMonitoringPayload();
  if (!MonitoringPayloadIsValid(payload)) {
    SetMonitoringSaveHint('Enter a name and give every check an address to save.', 'text-muted');
    return;
  }
  if (MonitoringEditorState.saving) {
    MonitoringEditorState.pendingSave = true;
    return;
  }
  MonitoringEditorState.saving = true;
  SetMonitoringSaveHint('', null);
  try {
    if (MonitoringEditorState.TargetID == null) {
      const [Err, Created] = await window.API.CreateMonitoringTarget(payload);
      if (Err) return SetMonitoringSaveHint(Err, 'text-danger');
      MonitoringEditorState.TargetID = Created.TargetID;
      MonitoringEditorTargetID = Created.TargetID;
      if (Array.isArray(Created.Checks)) {
        Created.Checks.forEach((cr, i) => {
          if (MonitoringEditorState.Checks[i]) MonitoringEditorState.Checks[i].CheckID = cr.CheckID;
        });
      }
      $('#MONITORING_TARGET_MODAL_TITLE').text('Edit Monitoring Target');
      $('#MONITORING_TARGET_DANGER_ZONE').removeClass('d-none');
    } else {
      const [Err, Updated] = await window.API.UpdateMonitoringTarget(
        MonitoringEditorState.TargetID,
        payload
      );
      if (Err) return SetMonitoringSaveHint(Err, 'text-danger');
      // Reconciliation returns checks in the same order we sent them, so we can
      // map freshly-inserted CheckIDs back onto the working state by index.
      if (Updated && Array.isArray(Updated.Checks)) {
        Updated.Checks.forEach((cr, i) => {
          if (MonitoringEditorState.Checks[i]) MonitoringEditorState.Checks[i].CheckID = cr.CheckID;
        });
      }
    }
    SetMonitoringSaveHint('', null);
  } catch (e) {
    SetMonitoringSaveHint(e && e.message ? e.message : 'Failed to save', 'text-danger');
  } finally {
    MonitoringEditorState.saving = false;
    if (MonitoringEditorState.pendingSave) {
      MonitoringEditorState.pendingSave = false;
      ScheduleMonitoringAutoSave();
    }
    if (MonitoringEditorState.View === 'list') RenderMonitoringCheckList();
  }
}

// Called from the live MonitoringTargetUpdated feed so the open editor's check
// list reflects fresh status without a manual refresh.
function RefreshMonitoringEditorIfOpen(TargetID) {
  if (!MonitoringEditorState || MonitoringEditorState.View !== 'list') return;
  if (MonitoringEditorState.TargetID == null) return;
  if (Number(MonitoringEditorState.TargetID) !== Number(TargetID)) return;
  RenderMonitoringCheckList();
}

async function OpenMonitoringTargetEditor(TargetID, Prefill = null) {
  await CloseAllModals();
  await EnsureMonitoringMethodsLoaded();

  const DefaultMethod = MonitoringMethodsCache[0] && MonitoringMethodsCache[0].ID;

  let Existing = null;
  if (TargetID) Existing = await window.API.GetMonitoringTarget(TargetID);

  if (Existing) {
    MonitoringEditorState = {
      TargetID: Existing.TargetID,
      Nickname: Existing.Nickname || '',
      Interval: Number(Existing.Interval) || 30000,
      GroupID: Existing.GroupID == null ? null : Existing.GroupID,
      Checks: (Existing.Checks || []).map((c) => ({
        CheckID: c.CheckID,
        Name: c.Name || '',
        Address: c.Address || '',
        Method: c.Method || DefaultMethod,
        Settings: c.Settings || {},
        DegradedThresholdMs: Number(c.DegradedThresholdMs) || 0,
      })),
      View: 'list',
      EditingIndex: null,
      saveTimer: null,
      saving: false,
      pendingSave: false,
    };
  } else {
    const HintedMethod =
      (Prefill && Prefill.Method && ResolveMonitoringMethodHint(Prefill.Method)) || DefaultMethod;
    MonitoringEditorState = {
      TargetID: null,
      Nickname: (Prefill && Prefill.Nickname) || '',
      Interval: 30000,
      GroupID: null,
      Checks: [
        {
          Name: '',
          Address: (Prefill && Prefill.Address) || '',
          Method: HintedMethod,
          Settings: {},
          DegradedThresholdMs: 0,
        },
      ],
      View: 'list',
      EditingIndex: null,
      saveTimer: null,
      saving: false,
      pendingSave: false,
    };
  }
  MonitoringEditorTargetID = MonitoringEditorState.TargetID;

  $('#MONITORING_TARGET_MODAL_TITLE').text(
    Existing ? 'Edit Monitoring Target' : 'Add Monitoring Target'
  );
  $('#MONITORING_TARGET_DANGER_ZONE').toggleClass('d-none', !Existing);
  $('#MONITORING_TARGET_NICKNAME').val(MonitoringEditorState.Nickname);
  $('#MONITORING_TARGET_INTERVAL').val(MonitoringEditorState.Interval);
  $('#MONITORING_TARGET_INTERVAL_LABEL').text(FormatInterval(MonitoringEditorState.Interval));
  SetMonitoringSaveHint('', null);

  // Global (target-level) inputs
  $('#MONITORING_TARGET_NICKNAME')
    .off('input.mon')
    .on('input.mon', function () {
      MonitoringEditorState.Nickname = $(this).val() || '';
      ScheduleMonitoringAutoSave();
    });
  $('#MONITORING_TARGET_INTERVAL')
    .off('input.mon')
    .on('input.mon', function () {
      MonitoringEditorState.Interval = parseInt($(this).val(), 10) || 30000;
      $('#MONITORING_TARGET_INTERVAL_LABEL').text(FormatInterval(MonitoringEditorState.Interval));
      ScheduleMonitoringAutoSave();
    });

  // Add a new (blank) check and drop straight into its edit view.
  $('#MONITORING_TARGET_ADD_CHECK')
    .off('click.mon')
    .on('click.mon', function () {
      MonitoringEditorState.Checks.push({
        Name: '',
        Address: '',
        Method: DefaultMethod,
        Settings: {},
        DegradedThresholdMs: 0,
      });
      OpenMonitoringCheckView(MonitoringEditorState.Checks.length - 1);
    });

  // Check rows open the per-check edit view.
  $('#MONITORING_TARGET_CHECK_LIST')
    .off('click.mon')
    .on('click.mon', '.monitoring-check-row, .MONITORING_CHECK_EDIT', function (e) {
      e.preventDefault();
      e.stopPropagation();
      const index = parseInt($(this).attr('data-index'), 10);
      if (Number.isFinite(index)) OpenMonitoringCheckView(index);
    });

  // Check edit view field bindings (auto-save on change).
  $('#MONITORING_CHECK_NAME, #MONITORING_CHECK_ADDRESS, #MONITORING_CHECK_DEGRADED_THRESHOLD')
    .off('input.moncheck')
    .on('input.moncheck', function () {
      CommitMonitoringCheckView();
    });
  $('#MONITORING_CHECK_METHOD')
    .off('change.moncheck')
    .on('change.moncheck', function () {
      CloseMonitoringCheckCollapses();
      RenderMonitoringCheckDynamicSettings($(this).val(), CollectMonitoringCheckDynamicSettings());
      CommitMonitoringCheckView();
    });
  $('#MONITORING_CHECK_DYNAMIC_SETTINGS, #MONITORING_CHECK_ADVANCED_SETTINGS')
    .off('input.moncheck change.moncheck')
    .on('input.moncheck change.moncheck', '[data-key]', function () {
      CommitMonitoringCheckView();
    });

  $('#MONITORING_CHECK_RUN_NOW')
    .off('click.moncheck')
    .on('click.moncheck', function () {
      RunMonitoringCheckNow();
    });

  $('#MONITORING_CHECK_BACK')
    .off('click.moncheck')
    .on('click.moncheck', function () {
      CommitMonitoringCheckView();
      ShowMonitoringListView();
    });

  $('#MONITORING_CHECK_DELETE')
    .off('click.moncheck')
    .on('click.moncheck', function () {
      const index = MonitoringEditorState.EditingIndex;
      if (index == null) return;
      MonitoringEditorState.Checks.splice(index, 1);
      ShowMonitoringListView();
      ScheduleMonitoringAutoSave();
    });

  $('#MONITORING_TARGET_DELETE')
    .off('click.mon')
    .on('click.mon', async () => {
      if (MonitoringEditorState.TargetID == null) return;
      const Confirmation = await ConfirmationDialog(
        'Delete this monitoring target? This cannot be undone.'
      );
      if (!Confirmation) return;
      const [Err] = await window.API.DeleteMonitoringTarget(MonitoringEditorState.TargetID);
      if (Err) return Notify(Err, 'error');
      await Notify('Monitoring target deleted', 'success');
      await CloseAllModals();
    });

  ShowMonitoringListView();
  $('#SHOWTRAK_MODAL_MONITORING_TARGET').modal('show');

  // Prefilled discovery adds already have a name+address, so try an initial save.
  ScheduleMonitoringAutoSave();
}
