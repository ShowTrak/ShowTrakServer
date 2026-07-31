// The FreeKiosk terminal view modal.
//
// Reuses #SHOWTRAK_CLIENT_INFO (as the monitor and dummy history modals do) and
// renders, top to bottom:
//
//   overall status card + status timeline
//   capture panel        — on-demand screenshot / camera photo
//   controls panel       — buttons and live sliders
//   one section per registry section, each row showing the metric's label, its
//   current value, an alarm badge, and its history chart
//
// EVERY metric in the registry gets a row. That is the point of the feature:
// whatever the device exposes, the operator can see. The chart kind comes from
// the registry too — a line for numbers, the existing block timeline for
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
import {
  BuildLiveStatusText,
  BuildStatusBlocksFromSamples,
  RenderMonitorHistorySection,
  RenderStatusTimeline,
} from './monitoring';
import type { HistorySample } from '@showtrak/protocol';

/** Mirrors FREEKIOSK_DISPLAY_MODES in src/Modules/FreeKiosk/metrics. */
const DISPLAY_MODE_LABELS: Record<string, string> = {
  webview: 'WebView',
  external_app: 'External app',
  media_player: 'Media player',
};

/** Series for the open terminal, keyed by metric. Refilled on every push. */
let FreeKioskSeries = new Map<string, FreeKioskMetricSample[]>();

/** A capture is held only while the modal is open — never persisted anywhere. */
let LastCapture: { DataUrl: string; Bytes: number; CapturedAt: number; Kind: string } | null = null;
let CaptureError: string | null = null;
let CaptureInFlight = false;
let CameraChoices: Array<{ id: string; facing: string }> = [];

export function ResetFreeKioskModalState(): void {
  FreeKioskSeries = new Map();
  // Dropping the data URL matters: it can be several megabytes, and holding it
  // for the life of the session would be pure waste.
  LastCapture = null;
  CaptureError = null;
  CaptureInFlight = false;
  CameraChoices = [];
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
 * should be, the value alone says everything — repeating the threshold on all
 * sixty-one rows would bury the two that matter.
 *
 * Note the inversion: an armed operator states the ALARM condition, never the
 * healthy one, so the expected value is its complement. "Below 20" armed means
 * "expected 20% or more".
 */
export function DescribeExpected(Metric: FreeKioskMetricView, Alarm: ArmedAlarm | null): string {
  if (!Alarm) return '';
  // Stored settings are JSON, so a threshold is whatever survived a round trip.
  // Anything that is not a scalar has no wording, and formats as an em dash.
  const Scalar = (Value: unknown): string | number | boolean | null =>
    typeof Value === 'string' || typeof Value === 'number' || typeof Value === 'boolean'
      ? Value
      : null;
  const Want = FormatMetricValue(Metric, Scalar(Alarm.value));
  const Want2 = FormatMetricValue(Metric, Scalar(Alarm.value2));
  switch (Alarm.operator) {
    case 'below':
      return `expected ${Want} or more`;
    case 'above':
      return `expected ${Want} or less`;
    case 'outside':
      return `expected ${Want} to ${Want2}`;
    case 'inside':
      return `expected outside ${Want} to ${Want2}`;
    case 'is':
      // Booleans never reach here — they arm `isNot`, so their value is already
      // the expected state. This is the enum/string case, where the operator
      // picker really did say "alert when it IS this".
      return `expected anything but ${Want}`;
    case 'isNot':
      return `expected ${Want}`;
    case 'contains':
      return `expected not to contain "${Want}"`;
    case 'notContains':
      return `expected to contain "${Want}"`;
    case 'changes':
      return 'expected to hold steady';
    case 'decreases':
      return 'expected never to go backwards';
    default:
      return '';
  }
}

function AlarmBadge(
  Terminal: FreeKioskTerminalView,
  Metric: FreeKioskMetricView,
  Alarm: ArmedAlarm | null
): string {
  if (!Alarm) return '';
  const Breaching = (Terminal.Alarms || []).some((Entry) => Entry && Entry.Key === Metric.Key);
  const Cls = Breaching ? 'is-breaching' : '';
  const Title = Breaching ? 'Alarm is breaching' : 'Alarm armed';
  const Icon = Breaching ? 'exclamation-triangle-fill' : 'bell-fill';
  return `<span class="freekiosk-alarm-badge ${Cls}" title="${Safe(Title)}"><i class="bi bi-${Icon}"></i></span>`;
}

// ---- Metric rows -----------------------------------------------------------

/**
 * Turn a metric's value series into the boolean shape the block timeline reads.
 *
 * `breach` is the only thing that colours a block. It was recorded at sample
 * time from the alarm the operator actually armed, so the timeline says exactly
 * what the tile said at that instant. This used to also guess — treating a false
 * reading of any boolean as bad — which painted "Can Go Back: No" and every
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
 * — and "a value existed sixty times" is not information anybody acts on. Worse,
 * it looks like a verdict: an unarmed block timeline is solid green whatever the
 * reading was, because nothing was breaching when nothing was being judged.
 *
 * With a check armed, the registry's `Chart` picks the KIND. 'line' graphs the
 * value with its threshold shaded. Everything else — booleans, enums, and the
 * readings whose shape over time says nothing, like uptime and storage — gets
 * the pass/fail timeline instead, coloured from the recorded breach flag.
 */
export function MetricChartKind(
  Metric: FreeKioskMetricView,
  Armed: boolean
): 'line' | 'blocks' | 'none' {
  if (!Armed) return 'none';
  return Metric.Chart === 'line' ? 'line' : 'blocks';
}

// Only ever called for a section that IS being monitored — RenderSection drops
// the whole section otherwise — so there is always history to draw from and an
// armed alarm is always a live one.
function RenderMetricRow(Terminal: FreeKioskTerminalView, Metric: FreeKioskMetricView): string {
  const Value = (Terminal.Metrics || {})[Metric.Key] ?? null;
  const Alarm = ReadArmedAlarm(Terminal, Metric);
  // Expanded, because the store compresses flat runs — see lib/metric-series.
  const Samples = ExpandMetricSeries(FreeKioskSeries.get(Metric.Key));
  const Breaching = (Terminal.Alarms || []).some((Entry) => Entry && Entry.Key === Metric.Key);
  const Expected = Breaching ? DescribeExpected(Metric, Alarm) : '';

  let Body = '';
  const Kind = MetricChartKind(Metric, !!Alarm);
  if (Kind === 'none') {
    Body = '';
  } else if (Kind === 'line') {
    const Model = BuildMetricChartModel(Samples, {
      min: Metric.Min ?? null,
      max: Metric.Max ?? null,
      decimals: Metric.Decimals ?? 0,
      threshold: ChartThreshold(Alarm),
    });
    Body = RenderMetricChartSvg(Model, {
      label: Metric.Label,
      unit: Metric.Unit,
      decimals: Metric.Decimals ?? 0,
      formatted: (Numeric) => FormatMetricValue(Metric, Numeric),
    });
  } else {
    Body = RenderStatusTimeline(BuildStatusBlocksFromSamples(ToStatusSamples(Samples)));
  }

  // The same popover the monitoring editor uses, rather than a bare title
  // attribute. `.monitoring-note` is what InitMonitoringNotePopovers looks for,
  // so the hint is delivered by Bootstrap and styled like every other note in
  // the app; a title attribute rendered as nothing but a help cursor.
  const Note = Metric.Note
    ? `<span class="monitoring-note freekiosk-metric-note" tabindex="0" role="button" aria-label="More information"
        data-bs-toggle="popover" data-bs-trigger="hover focus" data-bs-placement="left"
        data-bs-content="${Safe(Metric.Note)}"><i class="bi bi-info-circle"></i></span>`
    : '';

  return `
    <div class="freekiosk-metric-row${Breaching ? ' is-breaching' : ''}" data-metric-key="${Safe(
      Metric.Key
    )}">
      <div class="freekiosk-metric-head">
        <span class="freekiosk-metric-label">${Safe(Metric.Label)}${Note}</span>
        <span class="freekiosk-metric-value">${Safe(
          FormatMetricValue(Metric, Value)
        )}</span>${Expected ? `<span class="freekiosk-metric-expected">${Safe(Expected)}</span>` : ''}${AlarmBadge(Terminal, Metric, Alarm)}
      </div>
      ${Body}
    </div>`;
}

function RenderSection(
  Terminal: FreeKioskTerminalView,
  Section: string,
  Metrics: FreeKioskMetricView[]
): string {
  if (!Metrics.length) return '';
  // A section with monitoring switched off is not rendered at all. Its readings
  // are still arriving, but nothing is recording or judging them, so showing
  // them would put numbers on screen that look live and are not being watched —
  // and an operator scanning a modal does not check each heading for a caveat.
  // The editor is where the section reappears, next to the switch that hid it.
  if (!IsFreeKioskGroupEnabled(Terminal.Settings, Section)) return '';

  // Readings that belong to a display mode this terminal is not in are dropped
  // outright. FreeKiosk never clears webview.currentUrl, so a terminal locked to
  // an external app reports the last page it loaded for as long as it runs —
  // indistinguishable, on screen, from a page that is actually up.
  const Applicable = Metrics.filter((Metric) => IsFreeKioskMetricInMode(Terminal.Settings, Metric));
  if (!Applicable.length) return '';

  // Say why the rows are missing rather than leaving a thinner section. The
  // absence is the correct behaviour, but an operator who remembers a URL row
  // being here needs to know it was removed on purpose.
  const Dropped = Metrics.length - Applicable.length;
  const Mode = GetFreeKioskDisplayMode(Terminal.Settings);
  const ModeNote = Dropped
    ? `<div class="freekiosk-section-note"><i class="bi bi-info-circle"></i> Set to ${Safe(
        DISPLAY_MODE_LABELS[Mode] || Mode
      )} mode. FreeKiosk cannot report which app is in front, and keeps its last WebView readings forever, so ${Dropped === 1 ? 'that reading is' : 'those readings are'} hidden rather than shown stale.</div>`
    : '';

  const Rows = Applicable.map((Metric) => RenderMetricRow(Terminal, Metric)).join('');
  return `
    <div class="freekiosk-section" data-section="${Safe(Section)}">
      <h6 class="freekiosk-section-title">${Safe(Section)}</h6>
      ${ModeNote}
      ${Rows}
    </div>`;
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
        ${CaptureInFlight ? '<span class="freekiosk-capture-spinner">Capturing…</span>' : ''}
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
  // kiosk locked to an app is not merely irrelevant — the device would accept it,
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
  // designed — the failure this note exists to prevent was a real one.
  const Hidden = Commands.filter((Command) => Command.Modes && !Command.Modes.includes(Mode));
  const ModeNote = Hidden.length
    ? `<div class="freekiosk-section-note"><i class="bi bi-info-circle"></i> This terminal is set to ${Safe(
        DISPLAY_MODE_LABELS[Mode] || Mode
      )} mode, so ${Safe(
        Hidden.map((Command) => Command.Label).join(', ')
      )} ${Hidden.length === 1 ? 'is' : 'are'} hidden — ${Hidden.length === 1 ? 'it acts' : 'they act'} on the WebView. Change the display mode in this terminal's settings if that is wrong.</div>`
    : '';

  return `
    <div class="freekiosk-panel freekiosk-controls-panel">
      <h6 class="freekiosk-section-title">Controls</h6>
      ${ModeNote}
      ${Sections}
    </div>`;
}

// ---- The modal -------------------------------------------------------------

export function RenderFreeKioskModal($timelines: JQuery<HTMLElement>): void {
  const Terminal = OpenTerminal();
  if (!Terminal) return;
  const Catalogue = FreeKioskMetricCatalogCache;

  const State = String(Terminal.State || 'IDLE');
  // Poll latency doubles as the reachability series: it is only ever recorded
  // with a reading when a poll actually answered. Expanded first, or a terminal
  // with steady latency shows one live block and fifty-nine grey ones.
  const StatusSamples: HistorySample[] = ExpandMetricSeries(
    FreeKioskSeries.get('poll_latencyMs')
  ).map((Sample) => ({
    ts: Sample.ts,
    online: Sample.ok,
    degraded: Sample.breach,
    latencyMs: Sample.n,
  }));

  $timelines.append(
    RenderMonitorHistorySection(
      {
        state: State,
        name: Terminal.Nickname || Terminal.Address || 'FreeKiosk Terminal',
        sub: `${Terminal.Address}:${Terminal.Port}`,
        badge: 'FreeKiosk',
        statusText: BuildLiveStatusText(State, Terminal.LastLatencyMs, Terminal.LastError),
      },
      BuildStatusBlocksFromSamples(StatusSamples)
    )
  );

  $timelines.append(RenderCapturePanel(Terminal));
  $timelines.append(RenderControlsPanel(Terminal));

  if (!Catalogue) {
    $timelines.append(
      `<div class="freekiosk-panel"><em class="text-muted">Could not load the metric list.</em></div>`
    );
    return;
  }

  for (const Section of Catalogue.Sections) {
    const Metrics = Catalogue.Metrics.filter((Metric) => Metric.Section === Section);
    const Html = RenderSection(Terminal, Section, Metrics);
    if (Html) $timelines.append(Html);
  }

  // The rows are appended, not bound, so the popovers have to be attached after
  // every render — including the 30s live refresh, which replaces the DOM.
  InitMonitoringNotePopovers('#MONITOR_HISTORY_TIMELINES');
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

/** Populate the camera picker, so the UI only offers cameras that exist. */
export async function LoadFreeKioskCameras(): Promise<void> {
  const Terminal = OpenTerminal();
  if (!Terminal) return;
  try {
    const Cameras = await window.API.GetFreeKioskCameraList(Terminal.UUID);
    CameraChoices = Array.isArray(Cameras)
      ? Cameras.map((Camera) => ({ id: String(Camera.id), facing: String(Camera.facing) }))
      : [];
  } catch {
    CameraChoices = [];
  }
}

// ---- Wiring ----------------------------------------------------------------

// Sliders are debounced then reconciled by an immediate re-poll. The pending
// window stops the next push writing over a value the operator is still
// dragging — and, once it lapses, lets a device that refused the command snap
// the control back rather than leaving it lying.
const SLIDER_DEBOUNCE_MS = 400;
const SliderTimers = new Map<string, ReturnType<typeof setTimeout>>();
const SliderPendingUntil = new Map<string, number>();

export function IsFreeKioskSliderPending(CommandID: string): boolean {
  const Until = SliderPendingUntil.get(CommandID);
  return !!Until && Until > Date.now();
}

export function WireFreeKioskModal(Rerender: () => void): void {
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
        `${Command.Label} on "${Terminal.Nickname || Terminal.Address}"?`
      );
      if (!Confirmed) return;
    }

    // Commands that need parameters are configured from the editor or the
    // context menu prompt; the modal only fires the parameterless ones.
    if (Command.Params && Command.Params.length) {
      Notify(`${Command.Label} needs parameters — use the right-click menu.`, 'info');
      return;
    }

    const [Err, Summary] = await window.API.SendFreeKioskCommand([Terminal.UUID], CommandID);
    if (Err) return Notify(Err, 'error');
    if (Summary && Summary.Failed) {
      const Reason = Summary.Results.find((Entry) => !Entry.Success);
      return Notify(`${Command.Label} failed: ${Reason?.Error || 'unknown error'}`, 'error');
    }
    Notify(`${Command.Label} sent`, 'success');
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
          Notify(`Could not set ${CommandID}: ${Reason || 'unknown error'}`, 'error');
          SliderPendingUntil.delete(CommandID);
          return;
        }
        await window.API.RunFreeKioskTerminalsNow([Terminal.UUID]);
        SliderPendingUntil.delete(CommandID);
      }, SLIDER_DEBOUNCE_MS)
    );
  });
}
