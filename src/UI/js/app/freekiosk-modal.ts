// The FreeKiosk terminal view modal.
//
// Reuses #SHOWTRAK_CLIENT_INFO (as the monitor and dummy history modals do) and
// renders one pane per tab of the modal's rail (see lib/client-info-tabs):
//
//   Status    - overall status card + status timeline, then a status card and
//               history chart for every reading with a check armed (each one
//               repeated, as a row, on its own tab)
//   Controls  - buttons and live sliders, then on-demand screenshot / camera
//   Content, Screen, Battery, Network, Misc
//             - the registry sections as monitoring cards (freekiosk-monitoring):
//               a Monitor toggle per section, then a conditions table: each
//               reading's value, the condition it alerts on, a tick, and an
//               armed reading's history chart beneath its row
//
// EVERY metric in a monitored section gets a row. That is the point of the
// feature: whatever the device exposes, the operator can see. The chart kind comes from
// the registry too: a line for numbers, the existing block timeline for
// booleans and enums.
import type {
  FreeKioskCommandDef,
  FreeKioskMetricSample,
  FreeKioskMetricSeries,
  FreeKioskMetricView,
  FreeKioskTerminalView,
} from '@showtrak/protocol';
import {
  FreeKioskCommandsCache,
  FreeKioskMetricCatalogCache,
  FreeKioskTerminals,
  MonitorHistoryModalContext,
} from './state';
import { Safe } from './utils';
import { Notify, ConfirmationDialog } from './selection-init';
import { InitMonitoringNotePopovers } from './monitoring-editor/method-fields';
import {
  GetFreeKioskDisplayMode,
  IsFreeKioskGroupEnabled,
  IsFreeKioskMetricInMode,
} from './freekiosk';

import { FormatMetricValue } from './lib/metric-format';
import { BuildMetricChartModel, RenderMetricChartSvg } from './lib/metric-chart';
import type { MetricChartThreshold } from './lib/metric-chart';
import { ExpandMetricSeries } from './lib/metric-series';
import { FreeKioskReachabilitySamples } from './lib/status-blocks';
import {
  BuildLiveStatusText,
  BuildStatusBlocksFromSamples,
  RenderMonitorHistorySection,
  RenderMonitorStatusCard,
  RenderStatusTimeline,
} from './monitoring';
import type { HistorySample } from '@showtrak/protocol';
import { FREEKIOSK_METRIC_TABS, FreeKioskSectionTab } from './lib/client-info-tabs';
import type { ClientInfoTabKey, FreeKioskMetricTabKey } from './lib/client-info-tabs';
import { BuildFreeKioskMonitorCard } from './lib/freekiosk-monitoring';
import { EffectiveFreeKioskSettings, FreeKioskMonitorCardHtml } from './freekiosk-monitoring';

/** Mirrors FREEKIOSK_DISPLAY_MODES in src/Modules/FreeKiosk/metrics. */
const DISPLAY_MODE_LABELS: Record<string, string> = {
  webview: 'WebView',
  external_app: 'External app',
  media_player: 'Media player',
};

/** Series for the open terminal, keyed by metric. Refilled on every push. */
let FreeKioskSeries = new Map<string, FreeKioskMetricSample[]>();

/** A capture is held only while the modal is open, never persisted anywhere. */
let LastCapture: { DataUrl: string; Bytes: number; CapturedAt: number; Kind: string } | null = null;
let CaptureError: string | null = null;
let CaptureInFlight = false;
let CameraChoices: Array<{ id: string; facing: string }> = [];
// The terminal a camera list has been fetched for, and the one being fetched.
let CamerasLoadedFor: string | null = null;
let CamerasLoadingFor: string | null = null;
// Set by WireFreeKioskModal; lets a background fetch redraw the open modal.
let RerenderModal: (() => void) | null = null;

export function ResetFreeKioskModalState(): void {
  FreeKioskSeries = new Map();
  // Dropping the data URL matters: it can be several megabytes, and holding it
  // for the life of the session would be pure waste.
  LastCapture = null;
  CaptureError = null;
  CaptureInFlight = false;
  CameraChoices = [];
  CamerasLoadedFor = null;
  CamerasLoadingFor = null;
}

export function SetFreeKioskSeries(Series: FreeKioskMetricSeries[] | null | undefined): void {
  FreeKioskSeries = new Map();
  for (const Entry of Array.isArray(Series) ? Series : []) {
    if (!Entry || !Entry.MetricKey) continue;
    FreeKioskSeries.set(Entry.MetricKey, Array.isArray(Entry.Samples) ? Entry.Samples : []);
  }
}

function OpenTerminal(): FreeKioskTerminalView | null {
  const Context = MonitorHistoryModalContext;
  if (!Context || Context.type !== 'freekiosk') return null;
  const UUID = String(Context.id || '');
  return FreeKioskTerminals.find((K) => String(K.UUID) === UUID) || null;
}

// ---- Alarm configuration read back out of the stored settings ---------------

interface ArmedAlarm {
  operator: string;
  value: unknown;
  value2: unknown;
}

function ReadArmedAlarm(
  Terminal: FreeKioskTerminalView,
  Metric: FreeKioskMetricView
): ArmedAlarm | null {
  const Settings = Terminal.Settings || {};
  if (Settings[`A_${Metric.Key}_On`] !== true) return null;
  const Stored = Settings[`A_${Metric.Key}_Op`];
  const Operator =
    typeof Stored === 'string' && Metric.Operators.includes(Stored as never)
      ? Stored
      : Metric.DefaultOperator || Metric.Operators[0] || '';
  return {
    operator: String(Operator),
    value: Settings[`A_${Metric.Key}_V`],
    value2: Settings[`A_${Metric.Key}_V2`],
  };
}

/** The threshold band a numeric chart should shade, if one is armed. */
function ChartThreshold(Alarm: ArmedAlarm | null): MetricChartThreshold | null {
  if (!Alarm) return null;
  if (!['below', 'above', 'outside', 'inside'].includes(Alarm.operator)) return null;
  const Value = Number(Alarm.value);
  if (!Number.isFinite(Value)) return null;
  const Value2 = Number(Alarm.value2);
  return {
    operator: Alarm.operator as MetricChartThreshold['operator'],
    value: Value,
    value2: Number.isFinite(Value2) ? Value2 : null,
  };
}

/**
 * What the reading was supposed to be, in the operator's words.
 *
 * Shown only while the alarm is actually breaching. When a value is where it
 * should be, the value alone says everything; repeating the threshold on all
 * sixty-one rows would bury the two that matter.
 *
 * The stored operator is the BREACH comparison, so the expectation is its
 * complement, the same complement the condition picker shows. A stored
 * "below 20" is "expected at least 20%".
 */
export function DescribeExpected(Metric: FreeKioskMetricView, Alarm: ArmedAlarm | null): string {
  if (!Alarm) return '';
  // Stored settings are JSON, so a threshold is whatever survived a round trip.
  // Anything that is not a scalar has no wording, and formats as an em dash.
  const Scalar = (Value: unknown): string | number | boolean | null =>
    typeof Value === 'string' || typeof Value === 'number' || typeof Value === 'boolean'
      ? Value
      : null;
  // A threshold typed in its own unit (uptime in days) is worded in that unit,
  // not run through the reading's format: "7" would otherwise read as "7s".
  const Threshold = (Value: unknown): string => {
    const Numeric = typeof Value === 'number' ? Value : Number(Scalar(Value) ?? NaN);
    if (!Metric.ThresholdUnit || !Number.isFinite(Numeric)) {
      return FormatMetricValue(Metric, Scalar(Value));
    }
    const Unit = Numeric === 1 ? Metric.ThresholdUnit.replace(/s$/, '') : Metric.ThresholdUnit;
    return `${Math.round(Numeric * 100) / 100} ${Unit}`;
  };
  const Want = Threshold(Alarm.value);
  const Want2 = Threshold(Alarm.value2);
  switch (Alarm.operator) {
    case 'below':
      return `expected at least ${Want}`;
    case 'above':
      return `expected at most ${Want}`;
    case 'outside':
      return `expected ${Want} to ${Want2}`;
    case 'inside':
      return `expected outside ${Want} to ${Want2}`;
    case 'is':
      // Booleans never reach here: they arm `isNot`, so their value is already
      // the expected state. This is the enum/string case, picked as "Expected
      // is not ...".
      return `expected anything but ${Want}`;
    case 'isNot':
      return `expected ${Want}`;
    case 'contains':
      return `expected not to contain "${Want}"`;
    case 'notContains':
      return `expected to contain "${Want}"`;
    case 'changes':
      return 'expected to stay the same';
    case 'decreases':
      return 'expected never to go backwards';
    default:
      return '';
  }
}

// ---- Metric rows -----------------------------------------------------------

/**
 * Turn a metric's value series into the boolean shape the block timeline reads.
 *
 * `breach` is the only thing that colours a block. It was recorded at sample
 * time from the alarm the operator actually armed, so the timeline says exactly
 * what the tile said at that instant. This used to also guess, treating a false
 * reading of any boolean as bad, which painted "Can Go Back: No" and every
 * other perfectly healthy false in degraded orange, alarm or no alarm.
 */
function ToStatusSamples(Samples: FreeKioskMetricSample[]): HistorySample[] {
  return Samples.map((Sample) => {
    if (!Sample.ok) {
      // Not a reading: leave it as an idle gap rather than painting a verdict.
      return { ts: Sample.ts, online: false, degraded: false, latencyMs: null };
    }
    return { ts: Sample.ts, online: true, degraded: Sample.breach, latencyMs: null };
  });
}

/**
 * What to draw under a metric's reading.
 *
 * NOTHING, unless a check is armed on it. Without one there is no standard to
 * judge a reading against, so a chart could only report that the device answered
 * and "a value existed sixty times" is not information anybody acts on. Worse,
 * it looks like a verdict: an unarmed block timeline is solid green whatever the
 * reading was, because nothing was breaching when nothing was being judged.
 *
 * With a check armed, the registry's `Chart` picks the KIND. 'line' graphs the
 * value with its threshold shaded. Everything else (booleans, enums, and the
 * readings whose shape over time says nothing, like uptime and storage) gets
 * the pass/fail timeline instead, coloured from the recorded breach flag.
 */
export function MetricChartKind(
  Metric: FreeKioskMetricView,
  Armed: boolean
): 'line' | 'blocks' | 'none' {
  if (!Armed) return 'none';
  return Metric.Chart === 'line' ? 'line' : 'blocks';
}

/** The history drawn under a reading: a line, a block timeline, or nothing. */
function RenderMetricChart(
  Metric: FreeKioskMetricView,
  Alarm: ArmedAlarm | null,
  Samples: FreeKioskMetricSample[]
): string {
  const Kind = MetricChartKind(Metric, !!Alarm);
  if (Kind === 'none') return '';
  if (Kind === 'line') {
    const Model = BuildMetricChartModel(Samples, {
      min: Metric.Min ?? null,
      max: Metric.Max ?? null,
      decimals: Metric.Decimals ?? 0,
      threshold: ChartThreshold(Alarm),
    });
    return RenderMetricChartSvg(Model, {
      label: Metric.Label,
      unit: Metric.Unit,
      decimals: Metric.Decimals ?? 0,
      formatted: (Numeric) => FormatMetricValue(Metric, Numeric),
    });
  }
  return RenderStatusTimeline(BuildStatusBlocksFromSamples(ToStatusSamples(Samples)));
}

/**
 * A registry section as a monitoring card: the Monitor toggle, then a table of
 * every reading with its current value: always, monitored or not. While the
 * section is monitored each row also carries the condition it alerts on and a
 * tick, and an armed reading's history is drawn beneath its row. See
 * freekiosk-monitoring.
 */
function RenderSection(Terminal: FreeKioskTerminalView, Section: string): string {
  const Catalogue = FreeKioskMetricCatalogCache;
  if (!Catalogue) return '';
  const Card = BuildFreeKioskMonitorCard(Catalogue, Terminal, Section);
  if (!Card) return '';

  // Say why rows are missing rather than leaving a thinner table. The absence is
  // the correct behaviour, but an operator who remembers a URL row being here
  // needs to know it was removed on purpose.
  const Mode = GetFreeKioskDisplayMode(Terminal.Settings);
  const ModeNote = Card.HiddenByMode
    ? `<div class="freekiosk-section-note mt-1 mb-0"><i class="bi bi-info-circle"></i> Set to ${Safe(
        DISPLAY_MODE_LABELS[Mode] || Mode
      )} mode. FreeKiosk cannot report which app is in front, and keeps its last WebView readings forever, so ${Card.HiddenByMode === 1 ? 'that reading is' : 'those readings are'} hidden rather than shown stale.</div>`
    : '';

  const MetricByKey = new Map(Catalogue.Metrics.map((Metric) => [Metric.Key, Metric]));
  return FreeKioskMonitorCardHtml(
    Card,
    ModeNote,
    (Key) => {
      const Metric = MetricByKey.get(Key);
      return Metric ? DescribeExpected(Metric, ReadArmedAlarm(Terminal, Metric)) : '';
    },
    (Key) => {
      const Metric = MetricByKey.get(Key);
      if (!Metric) return '';
      // Expanded, because the store compresses flat runs; see lib/metric-series.
      const Samples = ExpandMetricSeries(FreeKioskSeries.get(Metric.Key));
      return RenderMetricChart(Metric, ReadArmedAlarm(Terminal, Metric), Samples);
    }
  );
}

/**
 * The state a monitored reading's status card shows, matching the client's
 * critical displays and network interfaces: while the terminal is offline the
 * reading is unknown, not faulty, so it is Idle; a breaching alarm is Degraded
 * (as it is on the tile); anything else is Online. The status text is the
 * reading itself, plus what it should have been while it is breaching.
 */
export function FreeKioskMetricLiveState(
  TerminalOnline: boolean,
  Breaching: boolean,
  ValueText: string,
  Expected: string
): { State: 'IDLE' | 'ONLINE' | 'DEGRADED'; Label: string } {
  if (!TerminalOnline) return { State: 'IDLE', Label: 'Idle' };
  if (Breaching) {
    return { State: 'DEGRADED', Label: Expected ? `${ValueText} · ${Expected}` : ValueText };
  }
  return { State: 'ONLINE', Label: ValueText };
}

/**
 * One monitored reading on the Status tab, drawn the way the client's Status
 * tab draws a critical display or interface: a status card (coloured by the
 * alarm's verdict) as the heading, its history chart directly beneath. Only
 * readings with a check armed get one (they are the ones with a history), and
 * the same section and display-mode rules as RenderSection apply, so Status
 * never shows a chart its own tab would hide. The full row appears again,
 * among the section's other readings, on the section's own tab.
 */
function RenderMonitoredMetric(
  Terminal: FreeKioskTerminalView,
  Metric: FreeKioskMetricView
): string {
  if (!IsFreeKioskGroupEnabled(Terminal.Settings, Metric.Section)) return '';
  if (!IsFreeKioskMetricInMode(Terminal.Settings, Metric)) return '';
  const Alarm = ReadArmedAlarm(Terminal, Metric);
  if (!Alarm) return '';

  const Value = (Terminal.Metrics || {})[Metric.Key] ?? null;
  const Breaching = (Terminal.Alarms || []).some((Entry) => Entry && Entry.Key === Metric.Key);
  const Live = FreeKioskMetricLiveState(
    !!Terminal.Online,
    Breaching,
    FormatMetricValue(Metric, Value),
    Breaching ? DescribeExpected(Metric, Alarm) : ''
  );
  const Samples = ExpandMetricSeries(FreeKioskSeries.get(Metric.Key));
  return (
    `<div class="monitor-history-section" data-metric-key="${Safe(Metric.Key)}">` +
    RenderMonitorStatusCard({
      state: Live.State,
      name: Metric.Label,
      sub: Metric.Section,
      statusText: Live.Label,
    }) +
    RenderMetricChart(Metric, Alarm, Samples) +
    `</div>`
  );
}

// ---- Capture ---------------------------------------------------------------

function RenderCapturePanel(Terminal: FreeKioskTerminalView): string {
  const Offline = !Terminal.Online;
  const ControlDisabled = Terminal.ControlEnabled === false;
  const Disabled = Offline || CaptureInFlight ? 'disabled' : '';

  const CameraSelect =
    CameraChoices.length > 1
      ? `<select class="form-select form-select-sm freekiosk-camera-select" id="FREEKIOSK_CAMERA_SELECT">
           ${CameraChoices.map(
             (Camera) =>
               `<option value="${Safe(Camera.facing)}">${Safe(
                 Camera.facing === 'front' ? 'Front camera' : 'Back camera'
               )}</option>`
           ).join('')}
         </select>`
      : '';

  // A failed capture reports inline rather than as a toast: "camera in use by
  // another app" is diagnostic information the operator needs to keep reading.
  const Error_ = CaptureError
    ? `<div class="freekiosk-capture-error">${Safe(CaptureError)}</div>`
    : '';

  const Frame = LastCapture
    ? `<div class="freekiosk-capture-frame" id="FREEKIOSK_CAPTURE_FRAME">
         <img src="${LastCapture.DataUrl}" alt="${Safe(LastCapture.Kind)} capture"/>
         <div class="freekiosk-capture-caption">Captured ${new Date(
           LastCapture.CapturedAt
         ).toLocaleTimeString()} · ${Math.round(LastCapture.Bytes / 1024)} KB</div>
       </div>`
    : '';

  const ControlBanner = ControlDisabled
    ? `<div class="freekiosk-control-banner"><i class="bi bi-slash-circle"></i> Remote control is disabled in this device's FreeKiosk settings.</div>`
    : '';

  return `
    <div class="freekiosk-panel freekiosk-capture-panel">
      <h6 class="freekiosk-section-title">Capture</h6>
      ${ControlBanner}
      <div class="freekiosk-capture-actions">
        <button type="button" class="btn btn-sm freekiosk-btn" id="FREEKIOSK_CAPTURE_SCREENSHOT" ${Disabled}>
          <i class="bi bi-display"></i> Take Screenshot
        </button>
        <button type="button" class="btn btn-sm freekiosk-btn" id="FREEKIOSK_CAPTURE_CAMERA" ${Disabled}>
          <i class="bi bi-camera"></i> Take Photo
        </button>
        ${CameraSelect}
        ${CaptureInFlight ? '<span class="freekiosk-capture-spinner">Capturing...</span>' : ''}
      </div>
      ${Error_}
      ${Frame}
    </div>`;
}

// ---- Controls --------------------------------------------------------------

function RenderControlsPanel(Terminal: FreeKioskTerminalView): string {
  const Commands = FreeKioskCommandsCache;
  if (!Commands.length) return '';
  const Blocked = !Terminal.Online || Terminal.ControlEnabled === false;
  const Disabled = Blocked ? 'disabled' : '';

  // Only what works in the mode this terminal is set up for. "Reload Page" on a
  // kiosk locked to an app is not merely irrelevant: the device would accept it,
  // answer executed:true and do nothing, so offering it invites a click that
  // reports success and changes nothing.
  const Mode = GetFreeKioskDisplayMode(Terminal.Settings);
  const Applicable = Commands.filter((Command) => !Command.Modes || Command.Modes.includes(Mode));

  const Groups = new Map<string, FreeKioskCommandDef[]>();
  for (const Command of Applicable) {
    const List = Groups.get(Command.Group) || [];
    List.push(Command);
    Groups.set(Command.Group, List);
  }

  const Sections = Array.from(Groups.entries())
    .map(([Group, List]) => {
      const Controls = List.map((Command) => {
        if (Command.Control === 'slider') {
          const Current = Number((Terminal.Metrics || {})[Command.Metric || ''] ?? 0);
          const Value = Number.isFinite(Current) ? Math.round(Current) : 0;
          return `
            <div class="freekiosk-slider" data-command="${Safe(Command.ID)}">
              <label for="FREEKIOSK_SLIDER_${Safe(Command.ID)}">${Safe(Command.Label)}</label>
              <input type="range" class="form-range freekiosk-slider-input" id="FREEKIOSK_SLIDER_${Safe(
                Command.ID
              )}" min="0" max="100" step="1" value="${Value}" data-command="${Safe(
                Command.ID
              )}" data-metric="${Safe(Command.Metric || '')}" ${Disabled}/>
              <span class="freekiosk-slider-value" data-for="${Safe(Command.ID)}">${Value}%</span>
            </div>`;
        }
        return `
          <button type="button" class="btn btn-sm freekiosk-btn freekiosk-command-btn${
            Command.Destructive ? ' is-destructive' : ''
          }" data-command="${Safe(Command.ID)}" title="${Safe(
            Command.Note || Command.Label
          )}" ${Disabled}>
            <i class="bi bi-${Safe(Command.Icon)}"></i> ${Safe(Command.Label)}
          </button>`;
      }).join('');
      return `<div class="freekiosk-control-group"><span class="freekiosk-control-group-title">${Safe(
        Group
      )}</span><div class="freekiosk-control-group-body">${Controls}</div></div>`;
    })
    .join('');

  // Say which controls the mode removed, and where to change it. Hiding them
  // silently sends an operator hunting for a button that is working exactly as
  // designed; the failure this note exists to prevent was a real one.
  const Hidden = Commands.filter((Command) => Command.Modes && !Command.Modes.includes(Mode));
  const ModeNote = Hidden.length
    ? `<div class="freekiosk-section-note"><i class="bi bi-info-circle"></i> This terminal is set to ${Safe(
        DISPLAY_MODE_LABELS[Mode] || Mode
      )} mode, so ${Safe(
        Hidden.map((Command) => Command.Label).join(', ')
      )} ${Hidden.length === 1 ? 'is' : 'are'} hidden: ${Hidden.length === 1 ? 'it acts' : 'they act'} on the WebView. Change the display mode in this terminal's settings if that is wrong.</div>`
    : '';

  return `
    <div class="freekiosk-panel freekiosk-controls-panel">
      <h6 class="freekiosk-section-title">Controls</h6>
      ${ModeNote}
      ${Sections}
    </div>`;
}

// ---- The modal -------------------------------------------------------------

function Pane(Tab: ClientInfoTabKey, Html: string): string {
  return `<div class="freekiosk-tab-pane" data-client-info-tab="${Tab}">${Html}</div>`;
}

export function RenderFreeKioskModal($timelines: JQuery<HTMLElement>): void {
  const Stored = OpenTerminal();
  if (!Stored) return;
  // Drawn with any monitoring change still being saved already applied, so a
  // toggle reads as done the moment it is clicked.
  const Terminal: FreeKioskTerminalView = {
    ...Stored,
    Settings: EffectiveFreeKioskSettings(Stored.UUID, Stored.Settings),
  };
  const Catalogue = FreeKioskMetricCatalogCache;

  const State = String(Terminal.State || 'IDLE');
  // Poll latency is the reachability series (see FreeKioskReachabilitySamples).
  const StatusSamples: HistorySample[] = FreeKioskReachabilitySamples(
    FreeKioskSeries.get('poll_latencyMs')
  );

  // Status: the terminal's overall status, then the history of every reading
  // with a check armed: the at-a-glance view of everything being monitored.
  // Readings nobody is watching have no history to show and stay on their tabs.
  // In registry section order, then registry order within a section, so the
  // list reads the same as the tabs do.
  const MonitoredHtml = Catalogue
    ? Catalogue.Sections.flatMap((Section) =>
        Catalogue.Metrics.filter((Metric) => Metric.Section === Section).map((Metric) =>
          RenderMonitoredMetric(Terminal, Metric)
        )
      ).join('')
    : '';
  $timelines.append(
    Pane(
      'status',
      RenderMonitorHistorySection(
        {
          state: State,
          name: Terminal.Nickname || Terminal.Address || 'FreeKiosk Terminal',
          sub: `${Terminal.Address}:${Terminal.Port}`,
          badge: 'FreeKiosk',
          statusText: BuildLiveStatusText(State, Terminal.LastLatencyMs, Terminal.LastError),
        },
        BuildStatusBlocksFromSamples(StatusSamples)
      ) +
        (MonitoredHtml ||
          (Catalogue
            ? `<div class="freekiosk-panel"><div class="freekiosk-section-note mb-0"><i class="bi bi-info-circle"></i> No readings are being monitored on this terminal. Tick a reading on its tab (Content, Screen, Battery, Network or Misc) to monitor it and see its history here.</div></div>`
            : ''))
    )
  );

  $timelines.append(Pane('controls', RenderControlsPanel(Terminal) + RenderCapturePanel(Terminal)));

  // Each registry section lands on the tab FreeKioskSectionTab names, in
  // registry order, as a card the operator can switch monitoring on from.
  const ByTab = new Map<FreeKioskMetricTabKey, string>(
    FREEKIOSK_METRIC_TABS.map((Tab) => [Tab, ''])
  );
  if (Catalogue) {
    for (const Section of Catalogue.Sections) {
      const Tab = FreeKioskSectionTab(Section);
      ByTab.set(Tab, (ByTab.get(Tab) || '') + RenderSection(Terminal, Section));
    }
  }
  for (const [Tab, Html] of ByTab) {
    const Body = !Catalogue
      ? `<div class="freekiosk-panel"><em class="text-muted">Failed to load the metric list.</em></div>`
      : Html;
    $timelines.append(Pane(Tab, Body));
  }

  // The rows are appended, not bound, so the popovers have to be attached after
  // every render, including the 30s live refresh, which replaces the DOM.
  InitMonitoringNotePopovers('#MONITOR_HISTORY_TIMELINES');

  EnsureFreeKioskCameras(Terminal);
}

// ---- Capture actions -------------------------------------------------------

async function RunCapture(Kind: 'screenshot' | 'camera', Rerender: () => void): Promise<void> {
  const Terminal = OpenTerminal();
  if (!Terminal || CaptureInFlight) return;
  CaptureInFlight = true;
  CaptureError = null;
  Rerender();

  try {
    const Facing = String($('#FREEKIOSK_CAMERA_SELECT').val() || 'back');
    const [Err, Image] =
      Kind === 'screenshot'
        ? await window.API.CaptureFreeKioskScreenshot(Terminal.UUID)
        : await window.API.CaptureFreeKioskCamera(Terminal.UUID, {
            Camera: Facing,
            Quality: 80,
          });
    if (Err || !Image) {
      CaptureError = Err || 'Capture failed';
      LastCapture = null;
    } else {
      CaptureError = null;
      LastCapture = { ...Image, Kind };
    }
  } catch (Error_) {
    CaptureError = Error_ instanceof Error ? Error_.message : String(Error_);
  } finally {
    CaptureInFlight = false;
    Rerender();
  }
}

/**
 * Populate the camera picker, so the UI only offers cameras that exist.
 *
 * Never awaited by the modal. The list comes from the device itself, so on an
 * unreachable terminal the request runs to the full connection timeout, and
 * holding the modal shut for that long made opening an offline terminal look
 * hung. The modal opens at once without a picker; one appears when the list
 * lands. An offline terminal is not asked at all (capture is disabled while
 * offline anyway), and since every live push re-renders, the list is fetched
 * on the first render after the terminal comes back.
 */
function EnsureFreeKioskCameras(Terminal: FreeKioskTerminalView): void {
  if (!Terminal.Online) return;
  const UUID = String(Terminal.UUID);
  if (CamerasLoadedFor === UUID || CamerasLoadingFor === UUID) return;
  CamerasLoadingFor = UUID;
  void (async () => {
    let Choices: Array<{ id: string; facing: string }> = [];
    try {
      const Cameras = await window.API.GetFreeKioskCameraList(UUID);
      Choices = Array.isArray(Cameras)
        ? Cameras.map((Camera) => ({ id: String(Camera.id), facing: String(Camera.facing) }))
        : [];
    } catch {
      Choices = [];
    }
    // The modal was closed, or moved to another terminal, while this was out.
    if (CamerasLoadingFor !== UUID) return;
    CamerasLoadingFor = null;
    CamerasLoadedFor = UUID;
    if (String(OpenTerminal()?.UUID ?? '') !== UUID) return;
    CameraChoices = Choices;
    // A picker is only drawn for more than one camera; otherwise nothing changed.
    if (Choices.length > 1 && RerenderModal) RerenderModal();
  })();
}

// ---- Wiring ----------------------------------------------------------------

// Sliders are debounced then reconciled by an immediate re-poll. The pending
// window stops the next push writing over a value the operator is still
// dragging and, once it lapses, lets a device that refused the command snap
// the control back rather than leaving it lying.
const SLIDER_DEBOUNCE_MS = 400;
const SliderTimers = new Map<string, ReturnType<typeof setTimeout>>();
const SliderPendingUntil = new Map<string, number>();

export function IsFreeKioskSliderPending(CommandID: string): boolean {
  const Until = SliderPendingUntil.get(CommandID);
  return !!Until && Until > Date.now();
}

export function WireFreeKioskModal(Rerender: () => void): void {
  RerenderModal = Rerender;
  const Host = '#MONITOR_HISTORY_TIMELINES';

  $(document).on('click', `${Host} #FREEKIOSK_CAPTURE_SCREENSHOT`, () =>
    RunCapture('screenshot', Rerender)
  );
  $(document).on('click', `${Host} #FREEKIOSK_CAPTURE_CAMERA`, () =>
    RunCapture('camera', Rerender)
  );

  $(document).on('click', `${Host} .freekiosk-capture-frame`, function () {
    $(this).toggleClass('expanded');
  });

  $(document).on('click', `${Host} .freekiosk-command-btn`, async function () {
    const Terminal = OpenTerminal();
    if (!Terminal) return;
    const CommandID = String($(this).attr('data-command') || '');
    const Command = FreeKioskCommandsCache.find((Entry) => Entry.ID === CommandID);
    if (!Command) return;

    if (Command.Destructive) {
      const Confirmed = await ConfirmationDialog(
        `${Command.Label} on "${Terminal.Nickname || Terminal.Address}"?`,
        { ConfirmLabel: Command.Label }
      );
      if (!Confirmed) return;
    }

    // Commands that need parameters are configured from the editor or the
    // context menu prompt; the modal only fires the parameterless ones.
    if (Command.Params && Command.Params.length) {
      Notify(`${Command.Label} needs parameters: use the right-click menu.`, 'info');
      return;
    }

    const [Err, Summary] = await window.API.SendFreeKioskCommand([Terminal.UUID], CommandID);
    if (Err) return Notify(Err, 'error');
    if (Summary && Summary.Failed) {
      const Reason = Summary.Results.find((Entry) => !Entry.Success);
      return Notify(`${Command.Label} failed: ${Reason?.Error || 'unknown error'}`, 'error');
    }
    Notify(`${Command.Label} sent.`, 'success');
    // Settle every displayed value within ~200ms rather than waiting out the
    // poll interval.
    await window.API.RunFreeKioskTerminalsNow([Terminal.UUID]);
  });

  $(document).on('input', `${Host} .freekiosk-slider-input`, function () {
    const CommandID = String($(this).attr('data-command') || '');
    const Value = Number($(this).val());
    $(`${Host} .freekiosk-slider-value[data-for="${CommandID}"]`).text(`${Value}%`);

    const Existing = SliderTimers.get(CommandID);
    if (Existing) clearTimeout(Existing);
    SliderTimers.set(
      CommandID,
      setTimeout(async () => {
        SliderTimers.delete(CommandID);
        const Terminal = OpenTerminal();
        if (!Terminal) return;
        // Long enough for two polls, so a device that never takes the command
        // visibly reverts instead of the slider lying indefinitely.
        SliderPendingUntil.set(CommandID, Date.now() + Math.max(2 * Terminal.Interval, 5000));
        const [Err, Summary] = await window.API.SendFreeKioskCommand([Terminal.UUID], CommandID, {
          value: Value,
        });
        if (Err || (Summary && Summary.Failed)) {
          const Reason = Err || Summary?.Results.find((E) => !E.Success)?.Error;
          Notify(`Failed to set ${CommandID}: ${Reason || 'unknown error'}`, 'error');
          SliderPendingUntil.delete(CommandID);
          return;
        }
        await window.API.RunFreeKioskTerminalsNow([Terminal.UUID]);
        SliderPendingUntil.delete(CommandID);
      }, SLIDER_DEBOUNCE_MS)
    );
  });
}
