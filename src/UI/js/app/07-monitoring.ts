import {
  AllClients,
  AppMode,
  DummyClients,
  MONITOR_HISTORY_BLOCK_COUNT,
  MONITOR_HISTORY_WINDOW_MS,
  MonitorHistoryModalContext,
  MonitorHistorySeries,
  MonitorHistoryTooltipHover,
  MonitoringMethodsCache,
  MonitoringTargets,
  setMonitorHistoryModalContext,
  setMonitorHistorySeries,
  setMonitorHistoryTooltipHover,
} from './01-state';
import type {
  ClientApplicationHistorySeries,
  ClientDisplayHistorySeries,
  ClientDisplayView,
  ClientUSBHistorySeries,
  ClientView,
  DummyClientView,
  HistorySample,
  MonitoringCheckView,
  MonitoringTargetView,
  RunningApplicationViewItem,
  USBDeviceView,
} from '@showtrak/protocol';
import { HandleNonFatalError, Safe } from './04-utils';
import { openModal } from './lib/modal';
import { OfflineBadgeContent } from './lib/status-badges';

// Discriminated view-model for the currently-open monitor history modal.
type MonitorHistoryEntity =
  | { type: 'target'; id: number; title: string; target: MonitoringTargetView }
  | { type: 'dummy'; id: string; title: string; dummy: DummyClientView }
  | { type: 'client'; id: string; title: string; client: ClientView | null };

// Per-state sample tallies inside a single timeline block.
interface StatusStateCounts {
  ONLINE: number;
  DEGRADED: number;
  OFFLINE: number;
}

// A single one-hour-window timeline block (one per minute).
interface StatusBlock {
  start: number;
  end: number;
  state: string;
  count: number;
  counts: StatusStateCounts;
  latencyMs: number | null;
}

// Options backing the current-status card / history section heading.
interface MonitorStatusCardOptions {
  state?: string;
  name?: string;
  sub?: string;
  badge?: string;
  statusText?: string;
}

// Critical telemetry list elements carry runtime-enriched flags beyond their
// base wire shapes (connection/mismatch state derived on the client entity).
type CriticalUSBItem = USBDeviceView & { Missing?: boolean };
type CriticalDisplayItem = ClientDisplayView & {
  Missing?: boolean;
  Mismatch?: boolean;
  IsConnected?: boolean;
};
import { GetClientStatusDisplayText } from './06-client-list';
import { CloseAllModals } from './11-modals';
import { Notify } from './14-selection-init';
export function FormatInterval(ms: unknown) {
  const n = Number(ms) || 0;
  if (n < 60000) return `${Math.round(n / 1000)}s`;
  const m = Math.floor(n / 60000);
  const s = Math.round((n % 60000) / 1000);
  return s ? `${m}m ${s}s` : `${m}m`;
}

export function FormatLatency(ms: number | null | undefined) {
  if (ms == null) return '';
  if (ms < 1) return '<1ms';
  return `${Math.round(ms)}ms`;
}

export function FormatMonitoringCheckSummary(T: MonitoringTargetView, MaxLength = 24) {
  const Checks = Array.isArray(T && T.Checks) ? T.Checks : [];
  const Labels: string[] = [];
  const Seen = new Set<string>();
  const MethodLabels: Record<string, string> = {
    ping: 'PING',
    dns: 'DNS',
    http: 'HTTP',
    https: 'HTTPS',
    'http-json': 'HTTP',
    'tcp-port': 'TCP',
    qlab: 'QLAB',
    qlab5: 'QLAB5',
    qlab4: 'QLAB4',
  };

  for (const Check of Checks) {
    const MethodID = String((Check && Check.Method) || '')
      .trim()
      .toLowerCase();
    if (!MethodID) continue;
    const Label = MethodLabels[MethodID] || MethodID.replace(/[-_]+/g, ' ').toUpperCase();
    if (Seen.has(Label)) continue;
    Seen.add(Label);
    Labels.push(Label);
  }

  if (!Labels.length) return '';

  const FormatVisibleLabels = (Items: string[]) => {
    if (Items.length <= 1) return Items.join('');
    if (Items.length === 2) return `${Items[0]} & ${Items[1]}`;
    return `${Items.slice(0, -1).join(', ')} & ${Items[Items.length - 1]}`;
  };

  const Visible: string[] = [];
  for (let Index = 0; Index < Labels.length; Index += 1) {
    const Label = Labels[Index]!; // Index < Labels.length: always defined
    const Remaining = Labels.length - (Index + 1);
    const Candidate = FormatVisibleLabels([...Visible, Label]);
    const Suffix = Remaining > 0 ? ` + ${Remaining} More` : '';
    if (Visible.length && Candidate.length + Suffix.length > MaxLength) break;
    Visible.push(Label);
  }

  const HiddenCount = Labels.length - Visible.length;
  const Summary = FormatVisibleLabels(Visible);
  return HiddenCount > 0 ? `${Summary} + ${HiddenCount} More` : Summary;
}

// Extract just the hostname from an http/https URL, or show a compact check
// summary for multi-check targets.
export function FormatMonitoringAddressSub(T: MonitoringTargetView) {
  const Count = Number(T && T.CheckCount);
  if (Number.isFinite(Count) && Count > 1) {
    return FormatMonitoringCheckSummary(T) || `${Count} Checks`;
  }
  const Addr = String((T && T.Address) || '');
  if (/^https?:\/\//i.test(Addr)) {
    try {
      return new URL(Addr).hostname;
    } catch (_) {
      // fall through
    }
  }
  return Addr;
}

// A target can hold multiple checks; show the single method when there is one,
// otherwise summarise the number of checks (including the empty case).
export function FormatMonitoringMethodLabel(T: MonitoringTargetView) {
  const Count = Number(T && T.CheckCount);
  if (Number.isFinite(Count)) {
    if (Count === 0) return 'NO CHECKS';
    if (Count > 1) return `${Count} CHECKS`;
  }
  return String((T && T.Method) || '').toUpperCase();
}

export function FormatMonitorStatus(
  Online: boolean,
  LastLatencyMs: number | null,
  LastError: string | null,
  Degraded: boolean
) {
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

export function FormatMonitorCompactStatus(
  Online: boolean,
  LastLatencyMs: number | null,
  Degraded: boolean,
  IsIdle: boolean
) {
  // Compact view keeps labels short and deterministic. Prefer latency when it
  // exists, otherwise show a stable state label.
  const Latency = Online ? FormatLatency(LastLatencyMs) : '';
  if (Latency) return { text: Latency, color: 'text-light' };
  if (IsIdle) return { text: 'Idle', color: 'text-light' };
  if (Online && Degraded) return { text: 'Degraded', color: 'text-warning' };
  if (Online) return { text: 'Online', color: 'text-light' };
  return { text: 'Offline', color: 'text-light' };
}

export function GetMonitoringOfflineSince(Target: MonitoringTargetView) {
  // Only LastSuccessAt reflects the moment the target was last confirmed
  // online. LastChecked/Timestamp update on every check cycle (including
  // failures), so using them here would make the offline timer reset on
  // every tick instead of counting from when it actually went offline.
  const Ts = Number(Target && Target.LastSuccessAt);
  if (Number.isFinite(Ts) && Ts > 0) return String(Math.round(Ts));
  return '';
}

export function RenderMonitoringTargetsSection() {
  // Deprecated: monitoring targets are now rendered inline within their group's
  // drop zone alongside clients. Kept as a no-op for backwards compatibility.
  return '';
}

export function RenderMonitoringTargetTile(T: MonitoringTargetView) {
  const Online = !!T.Online;
  const Degraded = !!T.Degraded;
  const IsIdle = !T.CheckCount;
  const Name = T.Nickname || T.Address || 'Unnamed';
  const Sub = FormatMonitoringAddressSub(T);
  const Status = IsIdle
    ? 'Idle'
    : FormatMonitorStatus(Online, T.LastLatencyMs, T.LastError, Degraded);
  const CompactStatus = FormatMonitorCompactStatus(Online, T.LastLatencyMs, Degraded, IsIdle);
  const OfflineSince = GetMonitoringOfflineSince(T);
  const MethodLabel = FormatMonitoringMethodLabel(T);
  const DragUUID = `monitor:${T.TargetID}`;
  const TileStateClass = Degraded ? 'DEGRADED' : Online ? 'ONLINE' : IsIdle ? 'IDLE' : '';
  const TextClass = 'text-light';
  return `
    <div id="MONITOR_TILE_${T.TargetID}" class="SHOWTRAK_PC MONITOR ${TileStateClass}" data-target-id="${T.TargetID}" data-uuid="${DragUUID}" data-flip-key="${DragUUID}" draggable="${
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
      <div class="SHOWTRAK_PC_STATUS ${IsIdle ? 'd-grid' : 'd-none'}" data-type="INDICATOR_IDLE">
        <h7 class="mb-0 text-light" data-type="MONITOR_IDLE_LABEL">Idle</h7>
      </div>
      <div class="SHOWTRAK_PC_STATUS ${Online ? 'd-grid' : 'd-none'}" data-type="MONITOR_STATUS">
        <h7 class="mb-0 ${TextClass}" data-type="MONITOR_STATUS_LABEL">${Safe(Status)}</h7>
      </div>
      <div class="SHOWTRAK_PC_STATUS ${!Online && !IsIdle ? 'd-grid' : 'd-none'}" data-type="INDICATOR_OFFLINE">
        <h7 class="mb-0" data-type="OFFLINE_SINCE" data-offlinesince="${Safe(OfflineSince)}">
          ${OfflineBadgeContent()}
        </h7>
      </div>
      <span class="MONITOR_COMPACT_LATENCY ${CompactStatus.color}" data-type="MONITOR_COMPACT_LATENCY">${Safe(CompactStatus.text)}</span>
    </div>`;
}

export function UpdateMonitoringTargetTile(T: MonitoringTargetView) {
  const $tile = $(`#MONITOR_TILE_${T.TargetID}`);
  if (!$tile.length) return;
  const Online = !!T.Online;
  const Degraded = !!T.Degraded;
  const IsIdle = !T.CheckCount;
  $tile.toggleClass('ONLINE', Online && !Degraded);
  $tile.toggleClass('DEGRADED', Degraded);
  $tile.toggleClass('IDLE', IsIdle);
  const Name = T.Nickname || T.Address || 'Unnamed';
  $tile.find('[data-type="Name"]').text(Name);
  $tile.find('[data-type="Address"]').text(FormatMonitoringAddressSub(T));
  $tile
    .find('[data-type="Method"]')
    .text(`${FormatMonitoringMethodLabel(T)} · ${FormatInterval(T.Interval)}`);
  const Status = FormatMonitorStatus(Online, T.LastLatencyMs, T.LastError, Degraded);
  const CompactStatus = FormatMonitorCompactStatus(Online, T.LastLatencyMs, Degraded, IsIdle);
  const $label = $tile.find('[data-type="MONITOR_STATUS_LABEL"]');
  $label.text(Status);
  $label.removeClass('text-success text-warning').addClass('text-light');
  const $compact = $tile.find('[data-type="MONITOR_COMPACT_LATENCY"]');
  $compact.text(CompactStatus.text);
  $compact.removeClass('text-light text-success text-warning').addClass(CompactStatus.color);
  const ToggleIndicator = (Type: string, Show: boolean) => {
    $tile
      .find(`.SHOWTRAK_PC_STATUS[data-type="${Type}"]`)
      .toggleClass('d-grid', Show)
      .toggleClass('d-none', !Show);
  };
  ToggleIndicator('INDICATOR_IDLE', IsIdle);
  ToggleIndicator('MONITOR_STATUS', Online);
  ToggleIndicator('INDICATOR_OFFLINE', !Online && !IsIdle);
  $tile.find('[data-type="OFFLINE_SINCE"]').attr('data-offlinesince', GetMonitoringOfflineSince(T));
}

// The history modal is target-centric: it renders an overall status timeline
// plus one timeline per dependent check (or a single dummy-client timeline).
export function ResolveMonitorHistoryContextEntity(): MonitorHistoryEntity | null {
  const Context = MonitorHistoryModalContext;
  if (!Context || !Context.type) return null;
  if (Context.type === 'target') {
    const target = MonitoringTargets.find((T) => Number(T.TargetID) === Number(Context.id));
    if (!target) return null;
    return {
      type: 'target',
      id: Number(target.TargetID),
      title: target.Nickname || target.Address || `Target ${target.TargetID}`,
      target,
    };
  }
  if (Context.type === 'dummy') {
    const id = String(Context.id || '').trim();
    const dummy = DummyClients.find((D) => String(D.UUID) === id);
    if (!dummy) return null;
    return {
      type: 'dummy',
      id,
      title: dummy.Nickname || dummy.DummyID || 'Dummy Client',
      dummy,
    };
  }
  if (Context.type === 'client') {
    const id = String(Context.id || '').trim();
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

export function IsMonitorHistoryContextFor(entityType: string, id: string | number) {
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
export async function LoadHistorySamplesForContext() {
  setMonitorHistorySeries([]);
  const entity = ResolveMonitorHistoryContextEntity();
  if (!entity) return;
  if (entity.type === 'target') {
    const checks = Array.isArray(entity.target.Checks) ? entity.target.Checks : [];
    for (const check of checks) {
      if (!check || check.CheckID == null) continue;
      let samples: HistorySample[] = [];
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
    let samples: HistorySample[] = [];
    try {
      samples = await window.API.GetDummyClientHistory(String(entity.id));
    } catch {
      samples = [];
    }
    MonitorHistorySeries.push({ dummy: true, samples: Array.isArray(samples) ? samples : [] });
  }
  if (entity.type === 'client') {
    let samples: HistorySample[] = [];
    try {
      samples = await window.API.GetClientHistory(String(entity.id));
    } catch {
      samples = [];
    }
    MonitorHistorySeries.push({ client: true, samples: Array.isArray(samples) ? samples : [] });

    // Per-critical-application running/not-running series. Each entry drives its
    // own status timeline in the modal, mirroring per-check monitoring rows.
    let apps: ClientApplicationHistorySeries[] = [];
    try {
      apps = await window.API.GetClientApplicationHistory(String(entity.id));
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
    let usb: ClientUSBHistorySeries[] = [];
    try {
      usb = await window.API.GetClientUSBHistory(String(entity.id));
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
    let displays: ClientDisplayHistorySeries[] = [];
    try {
      displays = await window.API.GetClientDisplayHistory(String(entity.id));
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
export const MONITOR_STATE_SEVERITY = {
  IDLE: -1,
  UNAVAILABLE: -1,
  ONLINE: 0,
  DEGRADED: 1,
  OFFLINE: 2,
};

export function MonitorStateLabel(State: string) {
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

export function DeriveSampleState(Sample: HistorySample | null | undefined) {
  if (!Sample) return null;
  if (!Sample.online) return 'OFFLINE' as const;
  if (Sample.degraded) return 'DEGRADED' as const;
  return 'ONLINE' as const;
}

// Bucket a single sample series into a fixed number of one-hour timeline
// blocks. Blocks with no samples stay IDLE (grey) so gaps read as "not enough
// data" instead of implying a state we never observed.
export function BuildStatusBlocksFromSamples(Samples: HistorySample[]) {
  const Now = Date.now();
  const WindowStart = Now - MONITOR_HISTORY_WINDOW_MS;
  const BlockMs = MONITOR_HISTORY_WINDOW_MS / MONITOR_HISTORY_BLOCK_COUNT;
  const Sorted = (Array.isArray(Samples) ? Samples : [])
    .filter((S) => S && Number.isFinite(Number(S.ts)))
    .sort((a, b) => a.ts - b.ts);

  const Blocks: StatusBlock[] = [];
  for (let i = 0; i < MONITOR_HISTORY_BLOCK_COUNT; i++) {
    const Start = WindowStart + i * BlockMs;
    const End = Start + BlockMs;
    let State = 'IDLE';
    let Worst = -1;
    let Count = 0;
    let LatencySum = 0;
    let LatencyCount = 0;
    const Counts: StatusStateCounts = { ONLINE: 0, DEGRADED: 0, OFFLINE: 0 };
    for (const S of Sorted) {
      const Ts = Number(S.ts);
      if (Ts < Start || Ts >= End) continue;
      Count += 1;
      const SampleState = DeriveSampleState(S);
      if (SampleState) {
        Counts[SampleState] += 1;
        const Severity = MONITOR_STATE_SEVERITY[SampleState];
        if (Severity > Worst) {
          Worst = Severity;
          State = SampleState;
        }
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
export function BuildOverallStatusBlocks(PerCheckBlocks: StatusBlock[][]) {
  const Now = Date.now();
  const WindowStart = Now - MONITOR_HISTORY_WINDOW_MS;
  const BlockMs = MONITOR_HISTORY_WINDOW_MS / MONITOR_HISTORY_BLOCK_COUNT;
  const Blocks: StatusBlock[] = [];
  for (let i = 0; i < MONITOR_HISTORY_BLOCK_COUNT; i++) {
    const States: string[] = [];
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

export function FormatBlockTime(Ts: number) {
  try {
    return new Date(Ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function RenderStatusTimeline(Blocks: StatusBlock[]) {
  const Cells = (Array.isArray(Blocks) ? Blocks : [])
    .map((Block) => {
      const C = Block.counts;
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
export function HideStatusTimelineTooltip() {
  const El = document.getElementById('MONITOR_HISTORY_TOOLTIP');
  if (El) El.classList.add('d-none');
}

export function ShowStatusTimelineTooltip(
  BlockEl: Element | null,
  ClientX: number,
  ClientY: number
) {
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

export function RestoreStatusTimelineTooltipAfterRender() {
  if (!MonitorHistoryTooltipHover) return;
  if (!$('#SHOWTRAK_CLIENT_INFO').hasClass('show')) {
    HideStatusTimelineTooltip();
    setMonitorHistoryTooltipHover(null);
    return;
  }
  const X = Number(MonitorHistoryTooltipHover.x);
  const Y = Number(MonitorHistoryTooltipHover.y);
  if (!Number.isFinite(X) || !Number.isFinite(Y)) {
    HideStatusTimelineTooltip();
    setMonitorHistoryTooltipHover(null);
    return;
  }
  const Hit = document.elementFromPoint(X, Y);
  const Block =
    Hit && typeof Hit.closest === 'function' ? Hit.closest('.status-timeline-block') : null;
  if (!Block) {
    HideStatusTimelineTooltip();
    setMonitorHistoryTooltipHover(null);
    return;
  }
  ShowStatusTimelineTooltip(Block, X, Y);
}

// A history section now leads with the current-status card (which acts as the
// heading, carrying the label + address/type + live state on a single line) and
// places the status timeline directly beneath it.
export function RenderMonitorHistorySection(
  CardOptions: MonitorStatusCardOptions,
  Blocks: StatusBlock[]
) {
  return (
    `<div class="monitor-history-section">` +
    RenderMonitorStatusCard(CardOptions) +
    RenderStatusTimeline(Blocks) +
    `</div>`
  );
}

// Current live status state for a monitoring check (from the target snapshot).
export function LiveCheckState(Check: MonitoringCheckView | null | undefined) {
  if (!Check) return 'IDLE';
  if (Check.LastChecked == null) return 'IDLE';
  if (!Check.Online) return 'OFFLINE';
  if (Check.Degraded) return 'DEGRADED';
  return 'ONLINE';
}

// Human readable "current status" line shown on the status cards below the chart.
export function BuildLiveStatusText(State: string, LatencyMs: number | null, Error: string | null) {
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

export function RenderMonitorStatusCard(Options: MonitorStatusCardOptions) {
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

export function UpdateMonitorHistoryEditButtonVisibility(
  Options: { requireModalOpen?: boolean } = {}
) {
  const RequireModalOpen = Options.requireModalOpen !== false;
  const Btn = document.getElementById('MONITOR_HISTORY_EDIT_BUTTON') as HTMLButtonElement | null;
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

export function RenderMonitoringHistoryModal() {
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
    const SamplesByCheck = new Map<number, HistorySample[]>();
    for (const Series of MonitorHistorySeries) {
      if (Series && Series.checkID != null) {
        SamplesByCheck.set(Number(Series.checkID), Series.samples);
      }
    }

    const PerCheckBlocks: StatusBlock[][] = [];
    const CheckSections: string[] = [];
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
    const Client = Entity.client || ({} as Partial<ClientView>);
    const ClientState = Client.Online ? (Client.Degraded ? 'DEGRADED' : 'ONLINE') : 'OFFLINE';
    const StatusText = GetClientStatusDisplayText(Client);
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
    const SamplesByAppKey = new Map<string, HistorySample[]>();
    for (const Series of MonitorHistorySeries) {
      if (Series && Series.applicationKey) {
        SamplesByAppKey.set(String(Series.applicationKey), Series.samples);
      }
    }
    const CriticalApps: { Key: string; Item: RunningApplicationViewItem }[] = [];
    const SeenAppKeys = new Set<string>();
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
    const SamplesByUSBSerial = new Map<string, HistorySample[]>();
    for (const Series of MonitorHistorySeries) {
      if (Series && Series.usbSerial) {
        SamplesByUSBSerial.set(String(Series.usbSerial), Series.samples);
      }
    }
    const CriticalUSB: { Serial: string; Device: CriticalUSBItem }[] = [];
    const SeenSerials = new Set<string>();
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

    // Per-critical serial-less USB-device timelines. These are guarded by name +
    // quantity, so there is one timeline per distinct name (keyed by NameKey with
    // the same `usbname:` prefix the recorder uses). "Connected" here means the
    // expected quantity is satisfied; a shortfall or full absence reads as
    // "Disconnected".
    const CriticalUSBNames: { NameKey: string; Device: CriticalUSBItem }[] = [];
    const SeenNameKeys = new Set<string>();
    for (const Device of USBItems) {
      if (!Device || !Device.IsCriticalByName) continue;
      const NameKey =
        Device.NameKey != null && String(Device.NameKey).trim()
          ? String(Device.NameKey).trim().toLowerCase()
          : '';
      if (!NameKey || SeenNameKeys.has(NameKey)) continue;
      SeenNameKeys.add(NameKey);
      CriticalUSBNames.push({ NameKey, Device });
    }
    for (const { NameKey, Device } of CriticalUSBNames) {
      const Blocks = BuildStatusBlocksFromSamples(
        SamplesByUSBSerial.get(`usbname:${NameKey}`) || []
      );
      const Manufacturer = Device.ManufacturerName ? String(Device.ManufacturerName).trim() : '';
      const Product = Device.ProductName ? String(Device.ProductName).trim() : '';
      const Name = [Manufacturer, Product].filter(Boolean).join(' ') || 'USB Device';
      const Satisfied = Device.IsConnected !== false && !Device.Missing && !Device.Shortfall;
      let LiveState = 'IDLE';
      let StatusLabel = 'Idle';
      if (Client.Online) {
        LiveState = Satisfied ? 'ONLINE' : 'OFFLINE';
        StatusLabel = Satisfied ? 'Connected' : 'Disconnected';
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
    const SamplesByDisplayID = new Map<string, HistorySample[]>();
    for (const Series of MonitorHistorySeries) {
      if (Series && Series.displayID) {
        SamplesByDisplayID.set(String(Series.displayID), Series.samples);
      }
    }
    const CriticalDisplays: { DisplayID: string; Display: CriticalDisplayItem }[] = [];
    const SeenDisplayIDs = new Set<string>();
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
  const Dummy = Entity.dummy || ({} as Partial<DummyClientView>);
  const DummyState = ['IDLE', 'ONLINE', 'DEGRADED', 'OFFLINE'].includes(Dummy.State || '')
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

export async function OpenMonitoringTargetHistory(TargetID: number) {
  const Target = MonitoringTargets.find((T) => Number(T.TargetID) === Number(TargetID));
  if (!Target) return Notify('Monitoring target not found', 'error');
  try {
    await CloseAllModals();
  } catch (err) {
    HandleNonFatalError('Monitoring:OpenMonitoringTargetHistory:CloseAllModals', err);
  }

  setMonitorHistoryModalContext({ type: 'target', id: Number(Target.TargetID) });
  setMonitorHistorySeries([]);
  await LoadHistorySamplesForContext();
  UpdateMonitorHistoryEditButtonVisibility({ requireModalOpen: false });

  const $modal = $('#SHOWTRAK_CLIENT_INFO');
  $modal.off('hidden.bs.modal.monitorhistory').on('hidden.bs.modal.monitorhistory', function () {
    setMonitorHistoryModalContext(null);
    setMonitorHistorySeries([]);
    setMonitorHistoryTooltipHover(null);
    HideStatusTimelineTooltip();
  });
  openModal('SHOWTRAK_CLIENT_INFO');
  RenderMonitoringHistoryModal();
}

export async function OpenDummyClientHistory(UUID: string) {
  const DummyUUID = String(UUID || '').trim();
  const Dummy = DummyClients.find((D) => String(D.UUID) === DummyUUID);
  if (!Dummy) return Notify('Dummy client not found', 'error');

  try {
    await CloseAllModals();
  } catch (err) {
    HandleNonFatalError('Monitoring:OpenDummyClientHistory:CloseAllModals', err);
  }

  setMonitorHistoryModalContext({ type: 'dummy', id: DummyUUID });
  setMonitorHistorySeries([]);
  await LoadHistorySamplesForContext();
  UpdateMonitorHistoryEditButtonVisibility({ requireModalOpen: false });

  const $modal = $('#SHOWTRAK_CLIENT_INFO');
  $modal.off('hidden.bs.modal.monitorhistory').on('hidden.bs.modal.monitorhistory', function () {
    setMonitorHistoryModalContext(null);
    setMonitorHistorySeries([]);
    setMonitorHistoryTooltipHover(null);
    HideStatusTimelineTooltip();
  });
  openModal('SHOWTRAK_CLIENT_INFO');
  RenderMonitoringHistoryModal();
}
