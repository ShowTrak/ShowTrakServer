function FormatInterval(ms) {
  const n = Number(ms) || 0;
  if (n < 60000) return `${Math.round(n / 1000)}s`;
  const m = Math.floor(n / 60000);
  const s = Math.round((n % 60000) / 1000);
  return s ? `${m}m ${s}s` : `${m}m`;
}

function FormatLatency(ms) {
  if (ms == null) return '';
  if (ms < 1) return '<1ms';
  return `${Math.round(ms)}ms`;
}

// A target can hold multiple checks; show the single method when there is one,
// otherwise summarise the number of checks (including the empty case).
function FormatMonitoringMethodLabel(T) {
  const Count = Number(T && T.CheckCount);
  if (Number.isFinite(Count)) {
    if (Count === 0) return 'NO CHECKS';
    if (Count > 1) return `${Count} CHECKS`;
  }
  return String((T && T.Method) || '').toUpperCase();
}

function FormatMonitorStatus(Online, LastLatencyMs, LastError, Degraded) {
  if (Online) {
    if (Degraded) {
      const Reason = typeof LastError === 'string' ? LastError.trim() : '';
      if (Reason) return Reason;
    }
    return FormatLatency(LastLatencyMs);
  }
  const ErrorText = typeof LastError === 'string' ? LastError.trim() : '';
  if (!ErrorText) return 'Offline';
  if (
    /timed?\s*out|timeout|unreachable|refused|reset|network\s+is\s+unreachable|no\s+route\s+to\s+host|socket\s+hang\s+up|econnrefused|econnreset|ehostunreach|enetunreach/i.test(
      ErrorText
    )
  ) {
    return 'Offline';
  }
  if (/enotfound|eai_again|nxdomain|dns|name\s+or\s+service\s+not\s+known/i.test(ErrorText)) {
    return 'DNS Error';
  }
  if (
    /cert|certificate|tls|ssl|self\s*signed|unable\s+to\s+verify|hostname\/?ip\s+does\s+not\s+match/i.test(
      ErrorText
    )
  ) {
    return 'TLS Error';
  }
  const HttpMatch = ErrorText.match(/\bHTTP\s+(\d{3})\b/i);
  if (HttpMatch) return `HTTP ${HttpMatch[1]}`;
  return ErrorText;
}

function FormatMonitorCompactStatus(Online, LastLatencyMs) {
  // Compact view must never surface error/degraded reason text: those messages
  // can be arbitrarily long (e.g. "No reply from QLab after 2000ms") and break
  // the tile layout. Show latency when online, otherwise nothing.
  return Online ? FormatLatency(LastLatencyMs) : '';
}

function GetMonitoringOfflineSince(Target) {
  const Candidates = [
    Target && Target.LastSuccessAt,
    Target && Target.LastChecked,
    Target && Target.Timestamp,
  ];
  for (const Value of Candidates) {
    const Ts = Number(Value);
    if (Number.isFinite(Ts) && Ts > 0) return String(Math.round(Ts));
  }
  return '';
}

function RenderMonitoringTargetsSection() {
  // Deprecated: monitoring targets are now rendered inline within their group's
  // drop zone alongside clients. Kept as a no-op for backwards compatibility.
  return '';
}

function RenderMonitoringTargetTile(T) {
  const Online = !!T.Online;
  const Degraded = !!T.Degraded;
  const Name = T.Nickname || T.Address || 'Unnamed';
  const Sub = T.Address || '';
  const Status = FormatMonitorStatus(Online, T.LastLatencyMs, T.LastError, Degraded);
  const CompactStatus = FormatMonitorCompactStatus(Online, T.LastLatencyMs);
  const OfflineSince = GetMonitoringOfflineSince(T);
  const MethodLabel = FormatMonitoringMethodLabel(T);
  const DragUUID = `monitor:${T.TargetID}`;
  const TileStateClass = Degraded ? 'DEGRADED' : Online ? 'ONLINE' : '';
  const TextClass = 'text-light';
  return `
    <div id="MONITOR_TILE_${T.TargetID}" class="SHOWTRAK_PC MONITOR ${TileStateClass}" data-target-id="${T.TargetID}" data-uuid="${DragUUID}" draggable="${
      AppMode === 'EDIT' ? 'true' : 'false'
    }">
      <button type="button" class="CLIENT_TILE_COG MONITOR_TILE_COG" aria-label="Edit Monitor" title="Edit Monitor">
        <i class="bi bi-gear-fill"></i>
      </button>
      <label class="text-sm" data-type="Method">${Safe(MethodLabel)} · ${Safe(
        FormatInterval(T.Interval)
      )}</label>
      <h5 class="mb-0" data-type="Name">${Safe(Name)}</h5>
      <small class="text-sm text-light" data-type="Address">${Safe(Sub)}</small>
      <div class="SHOWTRAK_PC_STATUS ${Online ? 'd-grid' : 'd-none'}" data-type="MONITOR_STATUS">
        <h7 class="mb-0 ${TextClass}" data-type="MONITOR_STATUS_LABEL">${Safe(Status)}</h7>
      </div>
      <div class="SHOWTRAK_PC_STATUS ${Online ? 'd-none' : 'd-grid'}" data-type="INDICATOR_OFFLINE">
        <h7 class="mb-0" data-type="OFFLINE_SINCE" data-offlinesince="${Safe(OfflineSince)}">
          Offline <span class="badge bg-ghost">00:00:00</span>
        </h7>
      </div>
      <span class="MONITOR_COMPACT_LATENCY ${TextClass}${CompactStatus ? '' : ' d-none'}" data-type="MONITOR_COMPACT_LATENCY">${Safe(CompactStatus)}</span>
    </div>`;
}

function UpdateMonitoringTargetTile(T) {
  const $tile = $(`#MONITOR_TILE_${T.TargetID}`);
  if (!$tile.length) return;
  const Online = !!T.Online;
  const Degraded = !!T.Degraded;
  $tile.toggleClass('ONLINE', Online && !Degraded);
  $tile.toggleClass('DEGRADED', Degraded);
  const Name = T.Nickname || T.Address || 'Unnamed';
  $tile.find('[data-type="Name"]').text(Name);
  $tile.find('[data-type="Address"]').text(T.Address || '');
  $tile
    .find('[data-type="Method"]')
    .text(`${FormatMonitoringMethodLabel(T)} · ${FormatInterval(T.Interval)}`);
  const Status = FormatMonitorStatus(Online, T.LastLatencyMs, T.LastError, Degraded);
  const CompactStatus = FormatMonitorCompactStatus(Online, T.LastLatencyMs);
  const $label = $tile.find('[data-type="MONITOR_STATUS_LABEL"]');
  $label.text(Status);
  $label.removeClass('text-success text-warning').addClass('text-light');
  const $compact = $tile.find('[data-type="MONITOR_COMPACT_LATENCY"]');
  $compact.text(CompactStatus);
  $compact.removeClass('text-success text-warning').addClass('text-light');
  $compact.toggleClass('d-none', !CompactStatus);
  $tile
    .find('.SHOWTRAK_PC_STATUS[data-type="MONITOR_STATUS"]')
    .toggleClass('d-grid', Online)
    .toggleClass('d-none', !Online);
  $tile
    .find('.SHOWTRAK_PC_STATUS[data-type="INDICATOR_OFFLINE"]')
    .toggleClass('d-grid', !Online)
    .toggleClass('d-none', Online);
  $tile.find('[data-type="OFFLINE_SINCE"]').attr('data-offlinesince', GetMonitoringOfflineSince(T));
}

// The history modal is target-centric: it renders an overall status timeline
// plus one timeline per dependent check (or a single dummy-client timeline).
function ResolveMonitorHistoryContextEntity() {
  if (!MonitorHistoryModalContext || !MonitorHistoryModalContext.type) return null;
  if (MonitorHistoryModalContext.type === 'target') {
    const target = MonitoringTargets.find(
      (T) => Number(T.TargetID) === Number(MonitorHistoryModalContext.id)
    );
    if (!target) return null;
    return {
      type: 'target',
      id: Number(target.TargetID),
      title: target.Nickname || target.Address || `Target ${target.TargetID}`,
      target,
    };
  }
  if (MonitorHistoryModalContext.type === 'dummy') {
    const id = String(MonitorHistoryModalContext.id || '').trim();
    const dummy = DummyClients.find((D) => String(D.UUID) === id);
    if (!dummy) return null;
    return {
      type: 'dummy',
      id,
      title: dummy.Nickname || dummy.DummyID || 'Dummy Client',
      dummy,
    };
  }
  if (MonitorHistoryModalContext.type === 'client') {
    const id = String(MonitorHistoryModalContext.id || '').trim();
    const client = AllClients.find((C) => C && String(C.UUID) === id);
    if (!client) return { type: 'client', id, title: 'Client Info', client: null };
    return {
      type: 'client',
      id,
      title: client.Nickname || client.Hostname || 'Client Info',
      client,
    };
  }
  return null;
}

function IsMonitorHistoryContextFor(entityType, id) {
  if (!MonitorHistoryModalContext || MonitorHistoryModalContext.type !== entityType) return false;
  if (entityType === 'target') return Number(MonitorHistoryModalContext.id) === Number(id);
  if (entityType === 'dummy')
    return String(MonitorHistoryModalContext.id || '') === String(id || '');
  if (entityType === 'client')
    return String(MonitorHistoryModalContext.id || '') === String(id || '');
  return false;
}

// Fetch the raw sample series backing the open modal. For a monitoring target
// this pulls one series per check; for a dummy client it pulls its single
// uptime series.
async function LoadHistorySamplesForContext() {
  MonitorHistorySeries = [];
  const entity = ResolveMonitorHistoryContextEntity();
  if (!entity) return;
  if (entity.type === 'target') {
    const checks = Array.isArray(entity.target.Checks) ? entity.target.Checks : [];
    for (const check of checks) {
      if (!check || check.CheckID == null) continue;
      let samples = [];
      try {
        samples = await window.API.GetMonitoringCheckHistory(check.CheckID);
      } catch {
        samples = [];
      }
      MonitorHistorySeries.push({
        checkID: Number(check.CheckID),
        samples: Array.isArray(samples) ? samples : [],
      });
    }
    return;
  }
  if (entity.type === 'dummy') {
    let samples = [];
    try {
      samples = await window.API.GetDummyClientHistory(entity.id);
    } catch {
      samples = [];
    }
    MonitorHistorySeries.push({ dummy: true, samples: Array.isArray(samples) ? samples : [] });
  }
  if (entity.type === 'client') {
    let samples = [];
    try {
      samples = await window.API.GetClientHistory(entity.id);
    } catch {
      samples = [];
    }
    MonitorHistorySeries.push({ client: true, samples: Array.isArray(samples) ? samples : [] });

    // Per-critical-application running/not-running series. Each entry drives its
    // own status timeline in the modal, mirroring per-check monitoring rows.
    let apps = [];
    try {
      apps = await window.API.GetClientApplicationHistory(entity.id);
    } catch {
      apps = [];
    }
    for (const App of Array.isArray(apps) ? apps : []) {
      if (!App || !App.Key) continue;
      MonitorHistorySeries.push({
        applicationKey: String(App.Key),
        applicationName: App.Name ? String(App.Name) : String(App.Key),
        samples: Array.isArray(App.samples) ? App.samples : [],
      });
    }

    // Per-critical-USB-device connected/disconnected series. Each entry drives
    // its own status timeline in the modal, mirroring per-check monitoring rows.
    let usb = [];
    try {
      usb = await window.API.GetClientUSBHistory(entity.id);
    } catch {
      usb = [];
    }
    for (const Device of Array.isArray(usb) ? usb : []) {
      if (!Device || !Device.Serial) continue;
      MonitorHistorySeries.push({
        usbSerial: String(Device.Serial),
        usbName: Device.Name ? String(Device.Name) : String(Device.Serial),
        samples: Array.isArray(Device.samples) ? Device.samples : [],
      });
    }

    // Per-critical-display connected/changed/missing series. Each entry drives
    // its own status timeline in the modal, mirroring per-check monitoring rows.
    let displays = [];
    try {
      displays = await window.API.GetClientDisplayHistory(entity.id);
    } catch {
      displays = [];
    }
    for (const Display of Array.isArray(displays) ? displays : []) {
      if (!Display || !Display.DisplayID) continue;
      MonitorHistorySeries.push({
        displayID: String(Display.DisplayID),
        displayName: Display.Name ? String(Display.Name) : String(Display.DisplayID),
        samples: Array.isArray(Display.samples) ? Display.samples : [],
      });
    }
  }
}

// Possible timeline/status states. All resolve to a CSS variable driven colour
// (see main.css :root --status-*) so the palette lives in one place:
//   IDLE / UNAVAILABLE -> grey, OFFLINE -> red, DEGRADED -> orange, ONLINE -> green.
const MONITOR_STATE_SEVERITY = { IDLE: -1, UNAVAILABLE: -1, ONLINE: 0, DEGRADED: 1, OFFLINE: 2 };

function MonitorStateLabel(State) {
  switch (State) {
    case 'ONLINE':
      return 'Online';
    case 'DEGRADED':
      return 'Degraded';
    case 'OFFLINE':
      return 'Offline';
    case 'UNAVAILABLE':
      return 'Unavailable';
    default:
      return 'Idle';
  }
}

function DeriveSampleState(Sample) {
  if (!Sample) return null;
  if (!Sample.online) return 'OFFLINE';
  if (Sample.degraded) return 'DEGRADED';
  return 'ONLINE';
}

// Bucket a single sample series into a fixed number of one-hour timeline
// blocks. Blocks with no samples stay IDLE (grey) so gaps read as "not enough
// data" instead of implying a state we never observed.
function BuildStatusBlocksFromSamples(Samples) {
  const Now = Date.now();
  const WindowStart = Now - MONITOR_HISTORY_WINDOW_MS;
  const BlockMs = MONITOR_HISTORY_WINDOW_MS / MONITOR_HISTORY_BLOCK_COUNT;
  const Sorted = (Array.isArray(Samples) ? Samples : [])
    .filter((S) => S && Number.isFinite(Number(S.ts)))
    .sort((a, b) => a.ts - b.ts);

  const Blocks = [];
  for (let i = 0; i < MONITOR_HISTORY_BLOCK_COUNT; i++) {
    const Start = WindowStart + i * BlockMs;
    const End = Start + BlockMs;
    let State = 'IDLE';
    let Worst = -1;
    let Count = 0;
    let LatencySum = 0;
    let LatencyCount = 0;
    const Counts = { ONLINE: 0, DEGRADED: 0, OFFLINE: 0 };
    for (const S of Sorted) {
      const Ts = Number(S.ts);
      if (Ts < Start || Ts >= End) continue;
      Count += 1;
      const SampleState = DeriveSampleState(S);
      if (Counts[SampleState] != null) Counts[SampleState] += 1;
      const Severity = MONITOR_STATE_SEVERITY[SampleState];
      if (Severity > Worst) {
        Worst = Severity;
        State = SampleState;
      }
      if (S.latencyMs != null && Number.isFinite(Number(S.latencyMs))) {
        LatencySum += Number(S.latencyMs);
        LatencyCount += 1;
      }
    }
    Blocks.push({
      start: Start,
      end: End,
      state: State,
      count: Count,
      counts: Counts,
      latencyMs: LatencyCount ? LatencySum / LatencyCount : null,
    });
  }
  return Blocks;
}

// Combine per-check block timelines into a single overall timeline, mirroring
// the server aggregation: OFFLINE only when every reporting check is offline,
// DEGRADED when any is offline/degraded, otherwise ONLINE. Blocks where no
// check reported data stay IDLE (grey).
function BuildOverallStatusBlocks(PerCheckBlocks) {
  const Now = Date.now();
  const WindowStart = Now - MONITOR_HISTORY_WINDOW_MS;
  const BlockMs = MONITOR_HISTORY_WINDOW_MS / MONITOR_HISTORY_BLOCK_COUNT;
  const Blocks = [];
  for (let i = 0; i < MONITOR_HISTORY_BLOCK_COUNT; i++) {
    const States = [];
    const Counts = { ONLINE: 0, DEGRADED: 0, OFFLINE: 0 };
    for (const CheckBlocks of PerCheckBlocks) {
      const Block = CheckBlocks[i];
      if (Block && Block.state && Block.state !== 'IDLE' && Block.state !== 'UNAVAILABLE') {
        States.push(Block.state);
      }
      if (Block && Block.counts) {
        Counts.ONLINE += Block.counts.ONLINE || 0;
        Counts.DEGRADED += Block.counts.DEGRADED || 0;
        Counts.OFFLINE += Block.counts.OFFLINE || 0;
      }
    }
    let State = 'IDLE';
    if (States.length) {
      if (States.every((S) => S === 'OFFLINE')) State = 'OFFLINE';
      else if (States.some((S) => S === 'OFFLINE' || S === 'DEGRADED')) State = 'DEGRADED';
      else State = 'ONLINE';
    }
    Blocks.push({
      start: WindowStart + i * BlockMs,
      end: WindowStart + (i + 1) * BlockMs,
      state: State,
      count: States.length,
      counts: Counts,
      latencyMs: null,
    });
  }
  return Blocks;
}

function FormatBlockTime(Ts) {
  try {
    return new Date(Ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function RenderStatusTimeline(Blocks) {
  const Cells = (Array.isArray(Blocks) ? Blocks : [])
    .map((Block) => {
      const C = Block.counts || {};
      return `<span class="status-timeline-block state-${Safe(Block.state)}" data-ts="${Number(
        Block.start
      )}" data-online="${Number(C.ONLINE || 0)}" data-degraded="${Number(
        C.DEGRADED || 0
      )}" data-offline="${Number(C.OFFLINE || 0)}"></span>`;
    })
    .join('');
  return `<div class="status-timeline" role="img" aria-label="Status over the past hour">${Cells}</div>`;
}

// Custom hover tooltip for a timeline block: shows the hovered minute plus a
// per-state count breakdown (coloured dot + label left, count right).
function HideStatusTimelineTooltip() {
  const El = document.getElementById('MONITOR_HISTORY_TOOLTIP');
  if (El) El.classList.add('d-none');
}

function ShowStatusTimelineTooltip(BlockEl, ClientX, ClientY) {
  const Tooltip = document.getElementById('MONITOR_HISTORY_TOOLTIP');
  if (!Tooltip || !BlockEl) return;
  const Ts = Number(BlockEl.getAttribute('data-ts'));
  const Rows = [
    { state: 'ONLINE', label: 'Online', count: Number(BlockEl.getAttribute('data-online')) || 0 },
    {
      state: 'DEGRADED',
      label: 'Degraded',
      count: Number(BlockEl.getAttribute('data-degraded')) || 0,
    },
    {
      state: 'OFFLINE',
      label: 'Offline',
      count: Number(BlockEl.getAttribute('data-offline')) || 0,
    },
  ];
  const RowsHtml = Rows.map(
    (R) =>
      `<div class="status-tt-row"><span class="status-tt-label"><i class="status-tt-dot state-${R.state}"></i>${R.label}</span><span class="status-tt-count">${R.count}</span></div>`
  ).join('');
  Tooltip.innerHTML = `<div class="status-tt-time">${Safe(FormatBlockTime(Ts))}</div>${RowsHtml}`;
  Tooltip.classList.remove('d-none');

  // Position (fixed / viewport-relative) near the cursor, flipping left when it
  // would overflow the right edge.
  const TipRect = Tooltip.getBoundingClientRect();
  let Left = ClientX + 14;
  let Top = ClientY + 14;
  if (Left + TipRect.width > window.innerWidth - 6) Left = ClientX - TipRect.width - 14;
  if (Top + TipRect.height > window.innerHeight - 6) Top = ClientY - TipRect.height - 14;
  Tooltip.style.left = `${Math.max(6, Left)}px`;
  Tooltip.style.top = `${Math.max(6, Top)}px`;
}

function RestoreStatusTimelineTooltipAfterRender() {
  if (!MonitorHistoryTooltipHover) return;
  if (!$('#SHOWTRAK_CLIENT_INFO').hasClass('show')) {
    HideStatusTimelineTooltip();
    MonitorHistoryTooltipHover = null;
    return;
  }
  const X = Number(MonitorHistoryTooltipHover.x);
  const Y = Number(MonitorHistoryTooltipHover.y);
  if (!Number.isFinite(X) || !Number.isFinite(Y)) {
    HideStatusTimelineTooltip();
    MonitorHistoryTooltipHover = null;
    return;
  }
  const Hit = document.elementFromPoint(X, Y);
  const Block =
    Hit && typeof Hit.closest === 'function' ? Hit.closest('.status-timeline-block') : null;
  if (!Block) {
    HideStatusTimelineTooltip();
    MonitorHistoryTooltipHover = null;
    return;
  }
  ShowStatusTimelineTooltip(Block, X, Y);
}

// A history section now leads with the current-status card (which acts as the
// heading, carrying the label + address/type + live state on a single line) and
// places the status timeline directly beneath it.
function RenderMonitorHistorySection(CardOptions, Blocks) {
  return (
    `<div class="monitor-history-section">` +
    RenderMonitorStatusCard(CardOptions) +
    RenderStatusTimeline(Blocks) +
    `</div>`
  );
}

// Current live status state for a monitoring check (from the target snapshot).
function LiveCheckState(Check) {
  if (!Check) return 'IDLE';
  if (Check.LastChecked == null) return 'IDLE';
  if (!Check.Online) return 'OFFLINE';
  if (Check.Degraded) return 'DEGRADED';
  return 'ONLINE';
}

// Human readable "current status" line shown on the status cards below the chart.
function BuildLiveStatusText(State, LatencyMs, Error) {
  if (State === 'IDLE') return 'Idle';
  if (State === 'UNAVAILABLE') return 'No checks configured';
  if (State === 'OFFLINE') return FormatMonitorStatus(false, LatencyMs, Error, false) || 'Offline';
  if (State === 'DEGRADED') {
    const Reason = typeof Error === 'string' ? Error.trim() : '';
    return Reason ? `Degraded · ${Reason}` : 'Degraded';
  }
  const Latency = FormatLatency(LatencyMs);
  return Latency ? `Online · ${Latency}` : 'Online';
}

function RenderMonitorStatusCard(Options) {
  const State = Options.state || 'IDLE';
  const Name = Options.name || 'Unnamed';
  const Sub = Options.sub || '';
  const Badge = Options.badge || '';
  const StatusText = Options.statusText || MonitorStateLabel(State);
  const SubHtml = Sub ? `<small class="monitor-status-card-sub">${Safe(Sub)}</small>` : '';
  const BadgeHtml = Badge
    ? `<span class="badge monitor-status-card-badge">${Safe(Badge)}</span>`
    : '';
  return `
    <div class="monitor-status-card state-${Safe(State)}">
      <div class="monitor-status-card-body">
        <div class="monitor-status-card-title">${Safe(Name)}</div>
        ${SubHtml}
      </div>
      <div class="monitor-status-card-meta">
        ${BadgeHtml}
        <span class="monitor-status-card-state">${Safe(StatusText)}</span>
      </div>
    </div>`;
}

function UpdateMonitorHistoryEditButtonVisibility(Options = {}) {
  const RequireModalOpen = Options.requireModalOpen !== false;
  const Btn = document.getElementById('MONITOR_HISTORY_EDIT_BUTTON');
  if (!Btn) return;
  const ModalOpen = $('#SHOWTRAK_CLIENT_INFO').hasClass('show');
  const Entity = ResolveMonitorHistoryContextEntity();
  const CanEditTarget =
    (!RequireModalOpen || ModalOpen) &&
    AppMode === 'EDIT' &&
    Entity &&
    Entity.type === 'target' &&
    Entity.target &&
    Number.isFinite(Number(Entity.target.TargetID));

  Btn.classList.toggle('d-none', !CanEditTarget);
  Btn.disabled = !CanEditTarget;
  Btn.setAttribute('data-target-id', CanEditTarget ? String(Entity.target.TargetID) : '');
}

function RenderMonitoringHistoryModal() {
  const Entity = ResolveMonitorHistoryContextEntity();
  if (!Entity) {
    UpdateMonitorHistoryEditButtonVisibility();
    return;
  }

  $('#CLIENT_INFO_TITLE').text(Entity.title);
  // The client detail fields (nickname, vitals, USB, network, apps) only make
  // sense for real clients; monitoring targets and dummy clients show just the
  // status timeline. RenderClientInfoDetails owns the per-section gating for
  // integrated clients within the details block.
  $('#CLIENT_INFO_DETAILS_SECTION').toggleClass('d-none', Entity.type !== 'client');
  UpdateMonitorHistoryEditButtonVisibility();

  const $timelines = $('#MONITOR_HISTORY_TIMELINES');
  if (!$timelines.length) return;
  $timelines.empty();

  if (Entity.type === 'target') {
    const Target = Entity.target;
    const Checks = Array.isArray(Target.Checks) ? Target.Checks : [];

    // Align fetched sample series with the live checks by CheckID.
    const SamplesByCheck = new Map();
    for (const Series of MonitorHistorySeries) {
      if (Series && Series.checkID != null) {
        SamplesByCheck.set(Number(Series.checkID), Series.samples);
      }
    }

    const PerCheckBlocks = [];
    const CheckSections = [];
    for (const Check of Checks) {
      if (!Check || Check.CheckID == null) continue;
      const Samples = SamplesByCheck.get(Number(Check.CheckID)) || [];
      const Blocks = BuildStatusBlocksFromSamples(Samples);
      PerCheckBlocks.push(Blocks);

      const MethodMeta = MonitoringMethodsCache.find((m) => m.ID === Check.Method);
      const MethodName =
        (MethodMeta && MethodMeta.Name) || String(Check.Method || '').toUpperCase();
      const Label = Check.Name || MethodName || 'Check';
      const LiveState = LiveCheckState(Check);
      // Each check: its current-status card acts as the heading, with its
      // timeline directly beneath.
      CheckSections.push(
        RenderMonitorStatusCard({
          state: LiveState,
          name: Label,
          sub: Check.Address || '',
          badge: String(Check.Method || '').toUpperCase(),
          statusText: BuildLiveStatusText(LiveState, Check.LastLatencyMs, Check.LastError),
        }) + RenderStatusTimeline(Blocks)
      );
    }

    // Overall status timeline factoring in every dependent check, with its own
    // current-status card directly beneath it.
    const OverallBlocks = PerCheckBlocks.length
      ? BuildOverallStatusBlocks(PerCheckBlocks)
      : BuildStatusBlocksFromSamples([]);
    const OverallState = Target.Online
      ? Target.Degraded
        ? 'DEGRADED'
        : 'ONLINE'
      : Checks.length
        ? 'OFFLINE'
        : 'UNAVAILABLE';
    $timelines.append(
      RenderMonitorHistorySection(
        {
          state: OverallState,
          name: 'Overall Status',
          sub: `${Checks.length} check${Checks.length === 1 ? '' : 's'}`,
          statusText: BuildLiveStatusText(OverallState, Target.LastLatencyMs, Target.LastError),
        },
        OverallBlocks
      )
    );
    for (const Section of CheckSections) {
      $timelines.append(`<div class="monitor-history-section">${Section}</div>`);
    }
    if (!CheckSections.length) {
      $timelines.append('<div class="status-timeline-empty">This target has no checks yet.</div>');
    }
    RestoreStatusTimelineTooltipAfterRender();
    return;
  }

  // Client: a single online/degraded status series and one status card. The
  // client detail fields render separately (RenderClientInfoDetails).
  if (Entity.type === 'client') {
    const ClientSeries = MonitorHistorySeries.find((S) => S && S.client) || { samples: [] };
    const ClientBlocks = BuildStatusBlocksFromSamples(ClientSeries.samples);
    const Client = Entity.client || {};
    const ClientState = Client.Online ? (Client.Degraded ? 'DEGRADED' : 'ONLINE') : 'OFFLINE';
    const StatusText =
      typeof GetClientStatusDisplayText === 'function'
        ? GetClientStatusDisplayText(Client)
        : BuildLiveStatusText(ClientState, null, null);
    $timelines.append(
      RenderMonitorHistorySection(
        {
          state: ClientState,
          name: Client.Nickname || Client.Hostname || 'Client',
          sub: Client.IP || '',
          statusText: StatusText,
        },
        ClientBlocks
      )
    );

    // Per-critical-application timelines (running vs not running over the past
    // hour). Rendered the same way individual monitoring checks are. The rows
    // are driven by the client's CURRENT critical applications (not just the
    // fetched history series) so marking or unmarking an application updates the
    // modal immediately — even before any history samples exist for it — instead
    // of waiting for the next client snapshot.
    const SamplesByAppKey = new Map();
    for (const Series of MonitorHistorySeries) {
      if (Series && Series.applicationKey) {
        SamplesByAppKey.set(String(Series.applicationKey), Series.samples);
      }
    }
    const CriticalApps = [];
    const SeenAppKeys = new Set();
    const RunningItems = Array.isArray(Client?.RunningApplications?.Items)
      ? Client.RunningApplications.Items
      : [];
    for (const Item of RunningItems) {
      if (!Item || !Item.IsCritical) continue;
      const Key = Item.Key ? String(Item.Key) : Item.Name ? String(Item.Name) : '';
      if (!Key || SeenAppKeys.has(Key)) continue;
      SeenAppKeys.add(Key);
      CriticalApps.push({ Key, Item });
    }
    const AppStatusState = String(Client?.RunningApplications?.Status?.State || '').toLowerCase();
    const AppMonitoringOk = !!Client.Online && AppStatusState === 'ok';
    for (const { Key, Item } of CriticalApps) {
      const Blocks = BuildStatusBlocksFromSamples(SamplesByAppKey.get(Key) || []);
      const Name = (Item && Item.Name) || Key || 'Application';
      let LiveState = 'IDLE';
      let StatusLabel = 'Idle';
      if (AppMonitoringOk) {
        const IsRunning = Item.IsRunning !== false;
        LiveState = IsRunning ? 'ONLINE' : 'OFFLINE';
        StatusLabel = IsRunning ? 'Running' : 'Not Running';
      }
      $timelines.append(
        RenderMonitorHistorySection(
          {
            state: LiveState,
            name: Name,
            sub: 'Critical Application',
            statusText: StatusLabel,
          },
          Blocks
        )
      );
    }

    // Per-critical-USB-device timelines (connected vs disconnected over the past
    // hour). Rendered the same way individual monitoring checks are, and driven
    // by the client's CURRENT critical USB devices so marking/unmarking updates
    // the modal immediately.
    const SamplesByUSBSerial = new Map();
    for (const Series of MonitorHistorySeries) {
      if (Series && Series.usbSerial) {
        SamplesByUSBSerial.set(String(Series.usbSerial), Series.samples);
      }
    }
    const CriticalUSB = [];
    const SeenSerials = new Set();
    const USBItems = Array.isArray(Client?.USBDeviceList) ? Client.USBDeviceList : [];
    for (const Device of USBItems) {
      if (!Device || !Device.IsCritical) continue;
      const Serial = Device.SerialNumber ? String(Device.SerialNumber).trim() : '';
      if (!Serial || SeenSerials.has(Serial)) continue;
      SeenSerials.add(Serial);
      CriticalUSB.push({ Serial, Device });
    }
    for (const { Serial, Device } of CriticalUSB) {
      const Blocks = BuildStatusBlocksFromSamples(SamplesByUSBSerial.get(Serial) || []);
      const Manufacturer = Device.ManufacturerName ? String(Device.ManufacturerName).trim() : '';
      const Product = Device.ProductName ? String(Device.ProductName).trim() : '';
      const Name = [Manufacturer, Product].filter(Boolean).join(' ') || 'USB Device';
      const IsConnected = Device.IsConnected !== false && !Device.Missing;
      let LiveState = 'IDLE';
      let StatusLabel = 'Idle';
      if (Client.Online) {
        LiveState = IsConnected ? 'ONLINE' : 'OFFLINE';
        StatusLabel = IsConnected ? 'Connected' : 'Disconnected';
      }
      $timelines.append(
        RenderMonitorHistorySection(
          {
            state: LiveState,
            name: Name,
            sub: 'Critical USB Device',
            statusText: StatusLabel,
          },
          Blocks
        )
      );
    }

    // Per-critical-display timelines (connected / configuration-changed /
    // missing over the past hour). Rendered the same way individual monitoring
    // checks are, and driven by the client's CURRENT critical displays so
    // marking/unmarking updates the modal immediately.
    const SamplesByDisplayID = new Map();
    for (const Series of MonitorHistorySeries) {
      if (Series && Series.displayID) {
        SamplesByDisplayID.set(String(Series.displayID), Series.samples);
      }
    }
    const CriticalDisplays = [];
    const SeenDisplayIDs = new Set();
    const DisplayItems = Array.isArray(Client?.DisplayList) ? Client.DisplayList : [];
    for (const Display of DisplayItems) {
      if (!Display || !Display.IsCritical) continue;
      const DisplayID = Display.DisplayID ? String(Display.DisplayID).trim() : '';
      if (!DisplayID || SeenDisplayIDs.has(DisplayID)) continue;
      SeenDisplayIDs.add(DisplayID);
      CriticalDisplays.push({ DisplayID, Display });
    }
    for (const { DisplayID, Display } of CriticalDisplays) {
      const Blocks = BuildStatusBlocksFromSamples(SamplesByDisplayID.get(DisplayID) || []);
      const Name =
        Display.Label && String(Display.Label).trim() ? String(Display.Label).trim() : 'Display';
      const IsConnected = Display.IsConnected !== false && !Display.Missing;
      const IsMismatch = !!Display.Mismatch;
      let LiveState = 'IDLE';
      let StatusLabel = 'Idle';
      if (Client.Online) {
        if (!IsConnected) {
          LiveState = 'OFFLINE';
          StatusLabel = 'Missing';
        } else if (IsMismatch) {
          LiveState = 'DEGRADED';
          StatusLabel = 'Configuration Changed';
        } else {
          LiveState = 'ONLINE';
          StatusLabel = 'Connected';
        }
      }
      $timelines.append(
        RenderMonitorHistorySection(
          {
            state: LiveState,
            name: Name,
            sub: 'Critical Display',
            statusText: StatusLabel,
          },
          Blocks
        )
      );
    }

    RestoreStatusTimelineTooltipAfterRender();
    return;
  }

  // Dummy client: a single uptime series and one status card.
  const Series = MonitorHistorySeries[0] || { samples: [] };
  const Blocks = BuildStatusBlocksFromSamples(Series.samples);
  const Dummy = Entity.dummy || {};
  const DummyState = ['IDLE', 'ONLINE', 'DEGRADED', 'OFFLINE'].includes(Dummy.State)
    ? Dummy.State
    : Dummy.Online
      ? Dummy.Degraded
        ? 'DEGRADED'
        : 'ONLINE'
      : 'OFFLINE';
  $timelines.append(
    RenderMonitorHistorySection(
      {
        state: DummyState,
        name: Dummy.Nickname || Dummy.DummyID || 'Dummy Client',
        sub: Dummy.IP || '',
        statusText: BuildLiveStatusText(DummyState, null, null),
      },
      Blocks
    )
  );
  RestoreStatusTimelineTooltipAfterRender();
}

async function OpenMonitoringTargetHistory(TargetID) {
  const Target = MonitoringTargets.find((T) => Number(T.TargetID) === Number(TargetID));
  if (!Target) return Notify('Monitoring target not found', 'error');
  try {
    await CloseAllModals();
  } catch (err) {
    HandleNonFatalError('Monitoring:OpenMonitoringTargetHistory:CloseAllModals', err);
  }

  MonitorHistoryModalContext = { type: 'target', id: Number(Target.TargetID) };
  MonitorHistorySeries = [];
  await LoadHistorySamplesForContext();
  UpdateMonitorHistoryEditButtonVisibility({ requireModalOpen: false });

  const $modal = $('#SHOWTRAK_CLIENT_INFO');
  $modal.off('hidden.bs.modal.monitorhistory').on('hidden.bs.modal.monitorhistory', function () {
    MonitorHistoryModalContext = null;
    MonitorHistorySeries = [];
    MonitorHistoryTooltipHover = null;
    HideStatusTimelineTooltip();
  });
  $modal.modal('show');
  RenderMonitoringHistoryModal();
}

async function OpenDummyClientHistory(UUID) {
  const DummyUUID = String(UUID || '').trim();
  const Dummy = DummyClients.find((D) => String(D.UUID) === DummyUUID);
  if (!Dummy) return Notify('Dummy client not found', 'error');

  try {
    await CloseAllModals();
  } catch (err) {
    HandleNonFatalError('Monitoring:OpenDummyClientHistory:CloseAllModals', err);
  }

  MonitorHistoryModalContext = { type: 'dummy', id: DummyUUID };
  MonitorHistorySeries = [];
  await LoadHistorySamplesForContext();
  UpdateMonitorHistoryEditButtonVisibility({ requireModalOpen: false });

  const $modal = $('#SHOWTRAK_CLIENT_INFO');
  $modal.off('hidden.bs.modal.monitorhistory').on('hidden.bs.modal.monitorhistory', function () {
    MonitorHistoryModalContext = null;
    MonitorHistorySeries = [];
    MonitorHistoryTooltipHover = null;
    HideStatusTimelineTooltip();
  });
  $modal.modal('show');
  RenderMonitoringHistoryModal();
}
