// The monitor / client / dummy / FreeKiosk history modal: which entity it is
// showing, loading its samples, the status timelines and their tooltips, and
// the current-status card. Split out of ./monitoring, which keeps the tiles and
// re-exports everything here for existing importers.
import {
  AllClients,
  AppMode,
  DummyClients,
  FreeKioskTerminals,
  MonitorHistoryModalContext,
  MonitorHistorySeries,
  MonitorHistoryTooltipHover,
  MonitoringMethodsCache,
  MonitoringTargets,
  setMonitorHistoryModalContext,
  setMonitorHistorySeries,
  setMonitorHistoryTooltipHover,
} from './state';
import type {
  ClientApplicationHistorySeries,
  ClientAudioHistorySeries,
  ClientNetworkHistorySeries,
  ClientDisplayHistorySeries,
  ClientDisplayView,
  ClientUSBHistorySeries,
  ClientView,
  DummyClientView,
  FreeKioskTerminalView,
  FreeKioskMetricSample,
  HistorySample,
  MonitoringCheckView,
  MonitoringTargetView,
  RunningApplicationViewItem,
  USBDeviceView,
} from '@showtrak/protocol';
import { HandleNonFatalError, Safe } from './utils';
import { AudioTimelineLiveState } from './lib/audio-devices';
import { DisplayKey, DisplayTimelineLiveState } from './lib/displays';
import { USBTimelineLiveState } from './lib/usb-devices';
import { NetworkTimelineLiveState } from './lib/network-interfaces';
import { SYSTEM_CHECK_ORDER, SystemCheckCardFor, SystemCheckLiveState } from './lib/system-health';
import { UsageChartHtml } from './client-info-health';
import { openModal } from './lib/modal';
import { RefreshClientInfoTabs, ResetClientInfoTab, SetClientInfoKind } from './client-info-nav';
import {
  RenderFreeKioskModal,
  ResetFreeKioskModalState,
  SetFreeKioskSeries,
} from './freekiosk-modal';
import {
  PositionOpenActionsMenu,
  RenderTargetActionsPane,
  RenderTimelineWithActions,
  ResetActionParamDrafts,
} from './monitoring-actions';
import {
  BuildOverallStatusBlocks,
  BuildStatusBlocksFromSamples,
  type StatusBlock,
} from './lib/status-blocks';
import {
  FormatLatency,
  FormatMonitorStatus,
  IsMonitorAwaitingFirstCheck,
} from './lib/monitor-format';

// Discriminated view-model for the currently-open monitor history modal.
type MonitorHistoryEntity =
  | { type: 'target'; id: number; title: string; target: MonitoringTargetView }
  | { type: 'dummy'; id: string; title: string; dummy: DummyClientView }
  | { type: 'freekiosk'; id: string; title: string; terminal: FreeKioskTerminalView }
  | { type: 'client'; id: string; title: string; client: ClientView | null };

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
import { GetClientStatusDisplayText } from './client-list';
import { CloseAllModals } from './modals';
import { Notify } from './selection-init';
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
  if (Context.type === 'freekiosk') {
    const id = String(Context.id || '').trim();
    const terminal = FreeKioskTerminals.find((K) => String(K.UUID) === id);
    if (!terminal) return null;
    return {
      type: 'freekiosk',
      id,
      title: terminal.Nickname || terminal.Address || 'FreeKiosk Terminal',
      terminal,
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
  if (entityType === 'freekiosk')
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
  if (entity.type === 'freekiosk') {
    // A terminal has ~60 series and this reloads on every push while the modal
    // is open, so they come back in one call rather than one call per metric.
    try {
      SetFreeKioskSeries(await window.API.GetFreeKioskHistory(entity.id));
    } catch {
      SetFreeKioskSeries([]);
    }
    return;
  }
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

    // Per-critical-audio-endpoint series (connected / conditions broken / missing).
    let audio: ClientAudioHistorySeries[] = [];
    try {
      audio = await window.API.GetClientAudioHistory(String(entity.id));
    } catch {
      audio = [];
    }
    for (const Endpoint of Array.isArray(audio) ? audio : []) {
      if (!Endpoint || !Endpoint.EndpointID) continue;
      MonitorHistorySeries.push({
        audioEndpointID: String(Endpoint.EndpointID),
        audioName: Endpoint.Name ? String(Endpoint.Name) : String(Endpoint.EndpointID),
        samples: Array.isArray(Endpoint.samples) ? Endpoint.samples : [],
      });
    }

    // Per-critical-network-interface series (connected / conditions broken / missing).
    let network: ClientNetworkHistorySeries[] = [];
    try {
      network = await window.API.GetClientNetworkHistory(String(entity.id));
    } catch {
      network = [];
    }
    for (const Iface of Array.isArray(network) ? network : []) {
      if (!Iface || !Iface.InterfaceName) continue;
      MonitorHistorySeries.push({
        networkInterfaceName: String(Iface.InterfaceName),
        samples: Array.isArray(Iface.samples) ? Iface.samples : [],
      });
    }

    // Monitored system checks: a healthy/failing series each, and the CPU and
    // memory readings their line charts are drawn from.
    let checks: Array<{ CheckKey?: string; samples?: HistorySample[] }> = [];
    try {
      checks = await window.API.GetClientSystemCheckHistory(String(entity.id));
    } catch {
      checks = [];
    }
    let vitals: { Cpu?: FreeKioskMetricSample[]; Ram?: FreeKioskMetricSample[] } = {};
    try {
      vitals = (await window.API.GetClientVitalsHistory(String(entity.id))) || {};
    } catch {
      vitals = {};
    }
    const ChecksByKey = new Map(
      (Array.isArray(checks) ? checks : [])
        .filter((Check) => Check && Check.CheckKey)
        .map((Check) => [String(Check.CheckKey), Check.samples] as const)
    );
    for (const Key of SYSTEM_CHECK_ORDER) {
      const Samples = ChecksByKey.get(Key);
      MonitorHistorySeries.push({
        systemCheckKey: Key,
        samples: Array.isArray(Samples) ? Samples : [],
        ...(Key === 'cpu' ? { metricSamples: Array.isArray(vitals.Cpu) ? vitals.Cpu : [] } : {}),
        ...(Key === 'ram' ? { metricSamples: Array.isArray(vitals.Ram) ? vitals.Ram : [] } : {}),
      });
    }
  }
}

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
// The tooltip host defaults to the view modal's; the list view passes its own,
// which sits outside the modal so it shows while the modal is closed.
export function HideStatusTimelineTooltip(TooltipID = 'MONITOR_HISTORY_TOOLTIP') {
  const El = document.getElementById(TooltipID);
  if (El) El.classList.add('d-none');
}

export function ShowStatusTimelineTooltip(
  BlockEl: Element | null,
  ClientX: number,
  ClientY: number,
  TooltipID = 'MONITOR_HISTORY_TOOLTIP'
) {
  const Tooltip = document.getElementById(TooltipID);
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

  PositionHistoryTooltip(Tooltip, ClientX, ClientY);
}

// Position (fixed / viewport-relative) near the cursor, flipping when it would
// overflow an edge. Shared by the timeline and the metric charts.
function PositionHistoryTooltip(Tooltip: HTMLElement, ClientX: number, ClientY: number) {
  const TipRect = Tooltip.getBoundingClientRect();
  let Left = ClientX + 14;
  let Top = ClientY + 14;
  if (Left + TipRect.width > window.innerWidth - 6) Left = ClientX - TipRect.width - 14;
  if (Top + TipRect.height > window.innerHeight - 6) Top = ClientY - TipRect.height - 14;
  Tooltip.style.left = `${Math.max(6, Left)}px`;
  Tooltip.style.top = `${Math.max(6, Top)}px`;
}

// The chart's equivalent, filling the same tooltip host with the same classes
// so hovering a chart and hovering a timeline feel like one control.
export function ShowMetricChartTooltip(HitEl: Element | null, ClientX: number, ClientY: number) {
  const Tooltip = document.getElementById('MONITOR_HISTORY_TOOLTIP');
  if (!Tooltip || !HitEl) return;
  const Ts = Number(HitEl.getAttribute('data-ts'));
  const Ok = HitEl.getAttribute('data-ok') === '1';
  const Breach = HitEl.getAttribute('data-breach') === '1';
  const Unit = HitEl.getAttribute('data-unit') || '';
  const Decimals = Number(HitEl.getAttribute('data-decimals')) || 0;

  const Show = (Raw: string | null) => {
    if (Raw == null || Raw === '') return '—';
    const Value = Number(Raw);
    if (!Number.isFinite(Value)) return '—';
    const Text = Value.toFixed(Decimals);
    return Unit ? (Unit === '%' ? `${Text}%` : `${Text} ${Unit}`) : Text;
  };

  const Rows: string[] = [];
  if (!Ok) {
    Rows.push(
      `<div class="status-tt-row"><span class="status-tt-label"><i class="status-tt-dot state-IDLE"></i>No reading</span></div>`
    );
  } else {
    Rows.push(
      `<div class="status-tt-row"><span class="status-tt-label">Average</span><span class="status-tt-count">${Safe(
        Show(HitEl.getAttribute('data-avg'))
      )}</span></div>`,
      `<div class="status-tt-row"><span class="status-tt-label">Min</span><span class="status-tt-count">${Safe(
        Show(HitEl.getAttribute('data-min'))
      )}</span></div>`,
      `<div class="status-tt-row"><span class="status-tt-label">Max</span><span class="status-tt-count">${Safe(
        Show(HitEl.getAttribute('data-max'))
      )}</span></div>`,
      `<div class="status-tt-row"><span class="status-tt-label">Samples</span><span class="status-tt-count">${Safe(
        HitEl.getAttribute('data-count') || '0'
      )}</span></div>`
    );
    if (Breach) {
      Rows.push(
        `<div class="status-tt-row"><span class="status-tt-label"><i class="status-tt-dot state-DEGRADED"></i>Alarm breaching</span></div>`
      );
    }
  }

  Tooltip.innerHTML = `<div class="status-tt-time">${Safe(FormatBlockTime(Ts))}</div>${Rows.join('')}`;
  Tooltip.classList.remove('d-none');
  PositionHistoryTooltip(Tooltip, ClientX, ClientY);
}

/** Anything the history tooltip may describe. */
const HISTORY_TOOLTIP_TARGETS = '.status-timeline-block, .metric-chart-hit';

/**
 * Point the tooltip at whatever is under (X, Y), or hide it if that is nothing.
 *
 * The single decision point for the tooltip, and it HIDES as readily as it
 * shows. Every way the tooltip used to get stranded was a path that could only
 * ever show it: hovering a chart and then moving onto the gap between charts
 * fired no per-target handler at all, so the last bucket's readings stayed on
 * screen describing something the pointer had long left.
 */
export function SyncHistoryTooltipToPointer(Hit: Element | null, X: number, Y: number) {
  const Target =
    Hit && typeof Hit.closest === 'function' ? Hit.closest(HISTORY_TOOLTIP_TARGETS) : null;
  if (!Target) {
    setMonitorHistoryTooltipHover(null);
    return HideStatusTimelineTooltip();
  }
  setMonitorHistoryTooltipHover({ x: X, y: Y });
  // The modal re-renders on every push while it is open, so the element under
  // the pointer is a fresh one; dispatch on what it actually is.
  if (Target.classList.contains('metric-chart-hit')) ShowMetricChartTooltip(Target, X, Y);
  else ShowStatusTimelineTooltip(Target, X, Y);
}

/**
 * Re-resolve the tooltip against the last known pointer position.
 *
 * Called after a re-render, and on scroll. Scrolling is the case worth naming:
 * the content moves out from under a pointer that never moved, so NO mouse
 * event fires and nothing would otherwise reconsider the tooltip — it just
 * hangs there over whatever scrolled into its place.
 */
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
  SyncHistoryTooltipToPointer(document.elementFromPoint(X, Y), X, Y);
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

// Open the view modal for a FreeKiosk terminal.
export async function OpenFreeKioskTerminalHistory(UUID: string) {
  await CloseAllModals();
  ResetFreeKioskModalState();
  ResetClientInfoTab();
  setMonitorHistoryModalContext({ type: 'freekiosk', id: String(UUID) });
  await LoadHistorySamplesForContext();
  // The camera list is fetched by the render, in the background: it asks the
  // device, so awaiting it here held the modal shut for the whole connection
  // timeout whenever the terminal was offline.
  RenderMonitoringHistoryModal();
  const Modal = document.getElementById('SHOWTRAK_CLIENT_INFO');
  if (Modal) {
    $(Modal).off('hidden.bs.modal.freekiosk');
    $(Modal).on('hidden.bs.modal.freekiosk', () => {
      // Drop the capture data URL rather than holding megabytes for the session.
      ResetFreeKioskModalState();
      setMonitorHistoryModalContext(null);
    });
  }
  openModal('SHOWTRAK_CLIENT_INFO');
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
  // integrated clients within the details block, and picks between the client
  // and integrated tab sets, so a client's kind is left to it here.
  $('#CLIENT_INFO_DETAILS_SECTION').toggleClass('d-none', Entity.type !== 'client');
  if (Entity.type === 'freekiosk') SetClientInfoKind('freekiosk');
  else if (Entity.type === 'target') SetClientInfoKind('target');
  else if (Entity.type === 'dummy') SetClientInfoKind('dummy');
  UpdateMonitorHistoryEditButtonVisibility();

  const $timelines = $('#MONITOR_HISTORY_TIMELINES');
  if (!$timelines.length) return;
  // Emptying the pane collapses it, which clamps the scroll position to the top;
  // live pushes re-render every few seconds, so hold the operator's place.
  const $content = $('#CLIENT_INFO_CONTENT');
  const ScrollTop = $content.scrollTop() || 0;
  $timelines.empty();
  // FreeKiosk terminals and monitoring targets spread themselves across several
  // tabs, so they wrap each part in its own pane; everything else is the Status
  // tab as a whole.
  if (Entity.type === 'freekiosk' || Entity.type === 'target') {
    $timelines.removeAttr('data-client-info-tab');
  } else $timelines.attr('data-client-info-tab', 'status');

  RenderMonitoringHistoryEntity(Entity, $timelines);

  RefreshClientInfoTabs();
  if (($content.scrollTop() || 0) !== ScrollTop) $content.scrollTop(ScrollTop);
  // Again, now that the inactive panes are hidden and the scroll is back: the
  // pointer lookup inside depends on the final layout.
  RestoreStatusTimelineTooltipAfterRender();
}

function RenderMonitoringHistoryEntity(
  Entity: MonitorHistoryEntity,
  $timelines: JQuery<HTMLElement>
) {
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
      // Each check: its current-status card acts as the heading, its timeline
      // directly beneath, with a ⋯ controls menu on the end of it when its
      // method offers any (nothing at all for a read-only check type).
      CheckSections.push(
        RenderMonitorStatusCard({
          state: LiveState,
          name: Label,
          sub: Check.Address || '',
          badge: String(Check.Method || '').toUpperCase(),
          statusText: BuildLiveStatusText(LiveState, Check.LastLatencyMs, Check.LastError),
        }) + RenderTimelineWithActions(Check, RenderStatusTimeline(Blocks))
      );
    }

    // Overall status timeline factoring in every dependent check, with its own
    // current-status card directly beneath it.
    const OverallBlocks = PerCheckBlocks.length
      ? BuildOverallStatusBlocks(PerCheckBlocks)
      : BuildStatusBlocksFromSamples([]);
    // A target whose first check has not landed yet has no verdict to report,
    // so it reads as pending rather than as an outage (see the tile above).
    const AwaitingFirstCheck = IsMonitorAwaitingFirstCheck(Target);
    const OverallState = AwaitingFirstCheck
      ? 'IDLE'
      : Target.Online
        ? Target.Degraded
          ? 'DEGRADED'
          : 'ONLINE'
        : Checks.length
          ? 'OFFLINE'
          : 'UNAVAILABLE';
    const StatusHtml =
      RenderMonitorHistorySection(
        {
          state: OverallState,
          name: 'Overall Status',
          sub: `${Checks.length} check${Checks.length === 1 ? '' : 's'}`,
          statusText: AwaitingFirstCheck
            ? 'Checking'
            : BuildLiveStatusText(OverallState, Target.LastLatencyMs, Target.LastError),
        },
        OverallBlocks
      ) +
      CheckSections.map((Section) => `<div class="monitor-history-section">${Section}</div>`).join(
        ''
      ) +
      (CheckSections.length
        ? ''
        : '<div class="status-timeline-empty">This target has no checks yet.</div>');
    $timelines.append(
      `<div class="monitor-tab-pane" data-client-info-tab="status">${StatusHtml}</div>`
    );
    $timelines.append(
      `<div class="monitor-tab-pane" data-client-info-tab="actions">${RenderTargetActionsPane(
        Target
      )}</div>`
    );
    PositionOpenActionsMenu();
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

    // Monitored system checks, straight under the client's own timeline: CPU
    // and memory as usage charts with their limit, uptime, power and thermal as
    // healthy/failing timelines. Driven by the client's CURRENT checks, so
    // monitoring one shows its row at once.
    const Viewed = { ...Client, UUID: String(Client.UUID || '') } as ClientView;
    for (const Key of SYSTEM_CHECK_ORDER) {
      const Card = SystemCheckCardFor(Viewed, Key);
      if (!Card.Monitored) continue;
      const Series = MonitorHistorySeries.find((Entry) => Entry && Entry.systemCheckKey === Key);
      const Live = SystemCheckLiveState(Viewed, Card);
      const Body =
        Key === 'cpu' || Key === 'ram'
          ? UsageChartHtml(Card, Viewed, (Series && Series.metricSamples) || [])
          : RenderStatusTimeline(BuildStatusBlocksFromSamples((Series && Series.samples) || []));
      $timelines.append(
        `<div class="monitor-history-section">` +
          RenderMonitorStatusCard({
            state: Live.State,
            name: Card.Title,
            sub: 'Monitored System Check',
            statusText: Live.Label,
          }) +
          Body +
          `</div>`
      );
    }

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
            sub: 'Monitored Application',
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
      const Live = USBTimelineLiveState([Device], !!Client.Online);
      $timelines.append(
        RenderMonitorHistorySection(
          {
            state: Live.State,
            name: Name,
            sub: 'Monitored USB Device',
            statusText: Live.Label,
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
      const Group = USBItems.filter(
        (Item) =>
          !!Item &&
          !!Item.IsCriticalByName &&
          String(Item.NameKey ?? '')
            .trim()
            .toLowerCase() === NameKey
      );
      const Live = USBTimelineLiveState(Group, !!Client.Online);
      $timelines.append(
        RenderMonitorHistorySection(
          {
            state: Live.State,
            name: Name,
            sub: 'Monitored USB Device',
            statusText: Live.Label,
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
    const CriticalDisplays: { DisplayID: string; Display: ClientDisplayView }[] = [];
    const SeenDisplayIDs = new Set<string>();
    const DisplayItems = Array.isArray(Client?.DisplayList) ? Client.DisplayList : [];
    for (const Display of DisplayItems) {
      if (!Display || !Display.IsCritical) continue;
      // Keyed by the critical entry's own id, as the history store is.
      const DisplayID = DisplayKey(Display);
      if (!DisplayID || SeenDisplayIDs.has(DisplayID)) continue;
      SeenDisplayIDs.add(DisplayID);
      CriticalDisplays.push({ DisplayID, Display });
    }
    for (const { DisplayID, Display } of CriticalDisplays) {
      const Blocks = BuildStatusBlocksFromSamples(SamplesByDisplayID.get(DisplayID) || []);
      const Name =
        Display.Label && String(Display.Label).trim() ? String(Display.Label).trim() : 'Display';
      const Live = DisplayTimelineLiveState(Display, !!Client.Online);
      $timelines.append(
        RenderMonitorHistorySection(
          {
            state: Live.State,
            name: Name,
            sub: 'Monitored Display',
            statusText: Live.Label,
          },
          Blocks
        )
      );
    }

    // Per-critical-audio-endpoint timelines, driven by the client's CURRENT
    // critical endpoints so marking/unmarking updates the modal at once.
    const SamplesByAudioEndpoint = new Map<string, HistorySample[]>();
    for (const Series of MonitorHistorySeries) {
      if (Series && Series.audioEndpointID) {
        SamplesByAudioEndpoint.set(String(Series.audioEndpointID), Series.samples);
      }
    }
    const AudioEndpoints = Array.isArray(Client?.AudioDevices?.Endpoints)
      ? Client.AudioDevices.Endpoints
      : [];
    for (const Endpoint of AudioEndpoints) {
      if (!Endpoint || !Endpoint.IsCritical || !Endpoint.EndpointID) continue;
      const Live = AudioTimelineLiveState(Endpoint, !!Client.Online);
      $timelines.append(
        RenderMonitorHistorySection(
          {
            state: Live.State,
            name: Endpoint.Name || 'Audio Device',
            sub:
              Endpoint.Direction === 'input' ? 'Monitored Audio Input' : 'Monitored Audio Output',
            statusText: Live.Label,
          },
          BuildStatusBlocksFromSamples(SamplesByAudioEndpoint.get(Endpoint.EndpointID) || [])
        )
      );
    }

    // Per-critical-network-interface timelines, likewise driven by the client's
    // CURRENT critical interfaces.
    const SamplesByInterface = new Map<string, HistorySample[]>();
    for (const Series of MonitorHistorySeries) {
      if (Series && Series.networkInterfaceName) {
        SamplesByInterface.set(String(Series.networkInterfaceName), Series.samples);
      }
    }
    const Interfaces = Array.isArray(Client?.NetworkStatus?.Interfaces)
      ? Client.NetworkStatus.Interfaces
      : [];
    for (const Iface of Interfaces) {
      if (!Iface || !Iface.IsCritical || !Iface.Name) continue;
      const Live = NetworkTimelineLiveState(Iface, !!Client.Online);
      $timelines.append(
        RenderMonitorHistorySection(
          {
            state: Live.State,
            name: Iface.Name,
            sub: 'Monitored Network Interface',
            statusText: Live.Label,
          },
          BuildStatusBlocksFromSamples(SamplesByInterface.get(Iface.Name) || [])
        )
      );
    }

    RestoreStatusTimelineTooltipAfterRender();
    return;
  }

  if (Entity.type === 'freekiosk') {
    // Every metric with its own chart, plus the capture and control panels.
    RenderFreeKioskModal($timelines);
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
  if (!Target) return Notify('Monitor not found.', 'error');
  try {
    await CloseAllModals();
  } catch (err) {
    HandleNonFatalError('Monitoring:OpenMonitoringTargetHistory:CloseAllModals', err);
  }

  ResetClientInfoTab();
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
    // A half-typed control parameter belongs to the panel that was open, not to
    // the next monitor the operator looks at.
    ResetActionParamDrafts();
  });
  openModal('SHOWTRAK_CLIENT_INFO');
  RenderMonitoringHistoryModal();
}

export async function OpenDummyClientHistory(UUID: string) {
  const DummyUUID = String(UUID || '').trim();
  const Dummy = DummyClients.find((D) => String(D.UUID) === DummyUUID);
  if (!Dummy) return Notify('Dummy client not found.', 'error');

  try {
    await CloseAllModals();
  } catch (err) {
    HandleNonFatalError('Monitoring:OpenDummyClientHistory:CloseAllModals', err);
  }

  ResetClientInfoTab();
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
    // A half-typed control parameter belongs to the panel that was open, not to
    // the next monitor the operator looks at.
    ResetActionParamDrafts();
  });
  openModal('SHOWTRAK_CLIENT_INFO');
  RenderMonitoringHistoryModal();
}
