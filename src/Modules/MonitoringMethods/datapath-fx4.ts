// Datapath Fx4 multi-display controller check (Fx4, Fx4-SDI, Fx4-HDR) over the
// Fx4 REST API.
//
// Protocol (Datapath "Fx4 API" reference, FX4 REST API.html in the public SDK
// download "Fx4-HDR, Fx4-SDI and Fx4 REST API v3.0.1" on datapathsoftware.com):
//   - Plain HTTP. GET reads, POST writes; every body is JSON. The HTTP status is
//     ALWAYS 200, even on error: an error is {"Success": false, "ErrorMessage",
//     "ErrorCode"} in the body, so every reply is parsed for that shape.
//   - A device password, when set, guards POST requests only (a "Password"
//     member in the body). GETs need nothing, so the check never sends it.
//   - Inputs are numbered 0–2 and outputs 0–3 in the API. Every Fx4 model has
//     three inputs and four outputs (user guides, Specifications chapter).
//
// Reads, in order, one request at a time (the Fx4 is a small embedded web
// server; nothing in the doc says it takes concurrent connections):
//   GET /SerialNumber.cgx                     {"SerialNumber"}          identity
//   GET /SystemInfo.cgx                       firmware/config/hardware/FPGA versions
//   GET /FriendlyName.cgx                     {"FriendlyName"}
//   GET /SystemHealth.cgx                     {"PowerSupply": {rail: bool}, "Temperature": {Average, Maximum, Minimum}}
//   GET /PreferredInput.cgx                   {"Input": n | null}
//   GET /ActiveInput.cgx                      {"Input": n | null}   null = no input has a signal
//   GET /InputCurrentTimings.cgx?input=n      the active input's format (only when one is active)
//   GET /InputHDCPStatus.cgx?input=n          (only when the HDCP check is on)
//   per watched output n:
//   GET /OutputEnable.cgx?output=n            {"Enable"}
//   GET /OutputImageSource.cgx?output=n       {"Source": "InputCapture" | a test pattern}
//   GET /OutputCurrentTimings.cgx?output=n    the output's current format
//   GET /OutputHDCPStatus.cgx?output=n        (only when the HDCP check is on)
//
// INFERRED (not stated in the doc):
//   - Refresh rate: the doc's 1080p example gives VerFrequency 59939 next to
//     HorFrequency 67432, so VerFrequency is read as millihertz (59.939 Hz).
//   - Resolution is HorAddrTime x VerAddrTime; the Flags bitfield (interlace?)
//     is undocumented and ignored.
//   - That API input 0/1/2 and output 0/1/2/3 are the connectors labelled
//     1/2/3 and 1/2/3/4. Shown to the operator as Input 1–3 and Output 1–4.
//   - Some example bodies in the doc carry trailing commas (invalid JSON);
//     replies are parsed leniently in case firmware really sends them.
//   - The doc lists no model field, so the model (Fx4 / SDI / HDR) is not shown.
//
// Not read: genlock (the status call's output parameter is documented
// inconsistently), EDID, network settings, link training.
//
// Actions (documented POSTs, same reference). The check itself only reads.
//   POST /PreferredInput.cgx     {"Input": 0–2 | null}             input.preferred
//   POST /OutputImageSource.cgx  {"Output", "Source": <pattern>}   output.pattern
//   POST /OutputImageSource.cgx  {"Output", "Source": "InputCapture"} output.live
//   POST /OutputEnable.cgx       {"Output", "Enable": false|true}  output.disable / output.enable
// None of them calls SaveSettings.cgx (flash has limited write cycles, and a
// show-time change should not become the power-on default), so a reboot
// returns the controller to its saved settings. Skipped: RebootDevice,
// ResetSettings, network, password, EDID, timings, crop and transform writes
// (configuration, or a reboot into an unknown state).
//
// Result semantics:
//   - No HTTP answer, or a reply without a serial number -> offline.
//   - Any enabled assertion breached                     -> degraded.
import {
  BuildBaseUrl,
  WithPath,
  RequestJson,
  IsObject,
  StrOrNull,
  NumOrNull,
  BoolOrNull,
  TimeoutOf,
  type JsonResponse,
} from './_videoproc-http-shared';
import { Card, Esc, FormatLatency, Note, Pill, Row, Rows, TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type {
  MonitoringActionDef,
  MonitoringActionResult,
  MonitoringResult,
  MonitoringSettingField,
  MonitoringTargetLike,
} from './types';

const ID = 'datapath-fx4';
const DEFAULT_TIMEOUT_MS = 5000;
// Actions answer quickly; a short budget keeps a press from hanging the panel.
const ACTION_TIMEOUT_MS = 5000;
const INPUT_COUNT = 3;
const OUTPUT_COUNT = 4;
const LIVE_SOURCE = 'InputCapture';
// The test patterns the doc lists for OutputImageSource. FlatColour is left
// out of the action: its colour comes from a separate setting.
const PATTERNS: Array<{ value: string; label: string }> = [
  { value: 'Colourbars', label: 'Colour bars' },
  { value: 'Greyscale', label: 'Greyscale' },
  { value: 'MovingColourbars', label: 'Moving colour bars' },
  { value: 'MovingGreyscale', label: 'Moving greyscale' },
];
const SOURCE_LABELS: Record<string, string> = {
  InputCapture: 'Live input',
  FlatColour: 'Flat colour',
  ...Object.fromEntries(PATTERNS.map((P) => [P.value, P.label])),
};

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'Port',
    Type: 'number',
    Default: 80,
    Min: 1,
    Max: 65535,
    Advanced: true,
    Note: 'The Fx4 serves its REST API on the normal web port, 80.',
  },
  {
    Key: 'Password',
    Label: 'Device password',
    Type: 'string',
    Default: '',
    Sensitive: true,
    Note: 'Only needed for the actions, and only if a password has been set on the Fx4. The check itself works without it.',
  },
  {
    Key: 'Outputs',
    Label: 'Outputs in use',
    Type: 'number',
    Default: OUTPUT_COUNT,
    Min: 1,
    Max: OUTPUT_COUNT,
    Note: 'How many outputs to read and check, counting from output 1. Outputs above this number are ignored.',
  },
  {
    Key: 'CheckSignal',
    Label: 'Check input signal',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded when none of the inputs has a signal.',
  },
  {
    Key: 'CheckPreferredInput',
    Label: 'Check preferred input',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when the controller has fallen back from its preferred input to another one, which means the preferred source has lost its signal.',
  },
  {
    Key: 'CheckInputFormat',
    Label: 'Check input format',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when the active input is not the expected resolution or refresh rate.',
  },
  {
    Key: 'ExpectedResolution',
    Label: 'Expected resolution',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'CheckInputFormat', Equals: true },
    Note: 'Width x height, e.g. 3840x2160. Leave blank to accept any resolution.',
  },
  {
    Key: 'ExpectedRefreshRate',
    Label: 'Expected refresh rate (Hz)',
    Type: 'number',
    Default: 0,
    Min: 0,
    Max: 250,
    VisibleWhen: { Key: 'CheckInputFormat', Equals: true },
    Note: 'e.g. 50 or 59.94. Leave at 0 to accept any rate. Matched to within 0.1 Hz.',
  },
  {
    Key: 'CheckPower',
    Label: 'Check power supply',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded when the controller reports a fault on one of its internal power rails.',
  },
  {
    Key: 'CheckHdcp',
    Label: 'Check HDCP',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded when HDCP fails on the active input or on an output in use. The screens turn red when this happens.',
  },
  {
    Key: 'CheckOutputsEnabled',
    Label: 'Check outputs enabled',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when an output in use has been switched off.',
  },
  {
    Key: 'CheckTestPattern',
    Label: 'Check test pattern',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when an output in use is showing a test pattern instead of the input.',
  },
  {
    Key: 'CheckTemperature',
    Label: 'Check temperature',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when the hottest internal temperature reading is above the limit. Datapath does not publish a limit, so set one from what the controller normally reads.',
  },
  {
    Key: 'MaxTemperature',
    Label: 'Maximum temperature (°C)',
    Type: 'number',
    Default: 70,
    Min: 0,
    Max: 150,
    VisibleWhen: { Key: 'CheckTemperature', Equals: true },
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: DEFAULT_TIMEOUT_MS,
    Min: 500,
    Max: 30000,
    Advanced: true,
    Note: 'The time allowed for the whole check, which makes up to 24 small requests.',
  },
];

// --- Transport --------------------------------------------------------------

// The body as JSON, tolerating the trailing commas some of the doc's examples
// show. Undefined when it is not JSON at all.
function ParseBody(Res: JsonResponse): unknown {
  if (!Res.Ok) return undefined;
  if (Res.Json !== undefined) return Res.Json;
  const Body = String(Res.Body || '').trim();
  if (!Body) return undefined;
  try {
    return JSON.parse(Body.replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return undefined;
  }
}

type CallResult =
  | { Ok: true; Value: Record<string, unknown> }
  | { Ok: false; Error: string; Transport: boolean; TimedOut?: boolean };

// One API call. Transport = the request itself failed (no answer, non-200,
// not JSON); otherwise the Fx4 answered with its own {"Success": false} error.
async function Call(
  Base: URL,
  Path: string,
  DeadlineAt: number,
  Body?: Record<string, unknown>
): Promise<CallResult> {
  const Res = await RequestJson(WithPath(Base, Path), {
    Method: Body ? 'POST' : 'GET',
    ...(Body ? { Json: Body } : {}),
    DeadlineAt,
  });
  if (!Res.Ok) return { Ok: false, Error: Res.Error, Transport: true, TimedOut: Res.TimedOut };
  if (Res.Status !== 200) return { Ok: false, Error: `HTTP ${Res.Status}`, Transport: true };
  const Json = ParseBody(Res);
  if (!IsObject(Json)) return { Ok: false, Error: 'Reply was not JSON', Transport: true };
  if (Json.Success === false) {
    const Message = StrOrNull(Json.ErrorMessage);
    const Code = NumOrNull(Json.ErrorCode);
    return {
      Ok: false,
      Error: `${Message || 'Error'}${Code != null ? ` (code ${Code})` : ''}`,
      Transport: false,
    };
  }
  return { Ok: true, Value: Json };
}

// --- Parsing ----------------------------------------------------------------

export interface Fx4Format {
  Width: number | null;
  Height: number | null;
  RefreshHz: number | null;
  ColourSpace: string | null;
  ColourRange: string | null;
  Subsampling: string | null;
  SdiLevel: string | null;
}

export interface Fx4Output {
  // 1-based, as an operator counts them.
  Output: number;
  Enabled: boolean | null;
  ImageSource: string | null;
  Format: Fx4Format | null;
  Hdcp: string | null;
}

export interface Fx4Snapshot {
  Serial: string | null;
  FriendlyName: string | null;
  FirmwareVersion: number | null;
  ConfigVersion: number | null;
  HardwareVersion: number | null;
  FpgaVersion: number | null;
  BuildDate: string | null;
  PowerRails: Array<{ Name: string; Ok: boolean }>;
  TemperatureAverage: number | null;
  TemperatureMaximum: number | null;
  TemperatureMinimum: number | null;
  // 1-based input numbers; null = none.
  PreferredInput: number | null;
  ActiveInput: number | null;
  InputFormat: Fx4Format | null;
  InputHdcp: string | null;
  Outputs: Fx4Output[];
}

function ParseFormat(Value: Record<string, unknown>): Fx4Format {
  const MilliHz = NumOrNull(Value.VerFrequency);
  return {
    Width: NumOrNull(Value.HorAddrTime),
    Height: NumOrNull(Value.VerAddrTime),
    // Millihertz, inferred from the doc's 1080p59.94 example (59939).
    RefreshHz: MilliHz != null && MilliHz > 0 ? Math.round(MilliHz / 10) / 100 : null,
    ColourSpace: StrOrNull(Value.ColourSpace),
    ColourRange: StrOrNull(Value.ColourRange),
    Subsampling: StrOrNull(Value.Subsampling),
    SdiLevel: StrOrNull(Value.SDILevel),
  };
}

// API input/output index (0-based, may be null) -> operator number (1-based).
function OneBased(Value: unknown, Count: number): number | null {
  const N = NumOrNull(Value);
  return N != null && Number.isInteger(N) && N >= 0 && N < Count ? N + 1 : null;
}

function ParseHealth(Value: Record<string, unknown>): {
  PowerRails: Array<{ Name: string; Ok: boolean }>;
  Average: number | null;
  Maximum: number | null;
  Minimum: number | null;
} {
  const Rails: Array<{ Name: string; Ok: boolean }> = [];
  if (IsObject(Value.PowerSupply)) {
    for (const [Name, Ok] of Object.entries(Value.PowerSupply)) {
      const B = BoolOrNull(Ok);
      if (B != null) Rails.push({ Name, Ok: B });
    }
  }
  const T = IsObject(Value.Temperature) ? Value.Temperature : {};
  return {
    PowerRails: Rails,
    Average: NumOrNull(T.Average),
    Maximum: NumOrNull(T.Maximum),
    Minimum: NumOrNull(T.Minimum),
  };
}

function OutputsOf(Cfg: Record<string, unknown>): number {
  const N = Number(Cfg.Outputs);
  return Number.isFinite(N) ? Math.min(OUTPUT_COUNT, Math.max(1, N | 0)) : OUTPUT_COUNT;
}

// --- Verdict ----------------------------------------------------------------

function ParseResolution(Value: unknown): { W: number; H: number } | null {
  const Match = String(Value == null ? '' : Value)
    .trim()
    .match(/^(\d+)\s*[x×*]\s*(\d+)$/i);
  return Match ? { W: Number(Match[1]), H: Number(Match[2]) } : null;
}

function IsHdcpFailure(Status: string | null): boolean {
  return Status === 'Error' || Status === 'Failure';
}

// The reasons a reachable controller is unhealthy, per the enabled toggles.
// A reading the controller did not report is skipped, never failed, except
// where the reading is the thing asserted (the input format). Pure.
function EvaluateHealth(Snap: Fx4Snapshot, Cfg: Record<string, unknown>): string[] {
  const Reasons: string[] = [];

  if (Cfg.CheckSignal !== false && Snap.ActiveInput == null) {
    Reasons.push('No input has a signal');
  }

  if (
    Cfg.CheckPreferredInput &&
    Snap.PreferredInput != null &&
    Snap.ActiveInput != null &&
    Snap.ActiveInput !== Snap.PreferredInput
  ) {
    Reasons.push(
      `Running on input ${Snap.ActiveInput}, not the preferred input ${Snap.PreferredInput}`
    );
  }

  if (Cfg.CheckInputFormat && Snap.ActiveInput != null) {
    const F = Snap.InputFormat;
    if (!F || F.Width == null || F.Height == null) {
      Reasons.push('Input format not reported');
    } else {
      const Want = ParseResolution(Cfg.ExpectedResolution);
      if (Want && (Want.W !== F.Width || Want.H !== F.Height)) {
        Reasons.push(`Input ${F.Width}x${F.Height} (expected ${Want.W}x${Want.H})`);
      }
      const WantRate = Number(Cfg.ExpectedRefreshRate);
      if (Number.isFinite(WantRate) && WantRate > 0) {
        if (F.RefreshHz == null) Reasons.push('Input refresh rate not reported');
        else if (Math.abs(F.RefreshHz - WantRate) > 0.1) {
          Reasons.push(`Input ${F.RefreshHz} Hz (expected ${WantRate} Hz)`);
        }
      }
    }
  }

  if (Cfg.CheckPower !== false) {
    const Bad = Snap.PowerRails.filter((R) => !R.Ok).map((R) => R.Name);
    if (Bad.length) Reasons.push(`Power supply fault on ${Bad.join(', ')}`);
  }

  if (Cfg.CheckHdcp !== false) {
    if (Snap.ActiveInput != null && IsHdcpFailure(Snap.InputHdcp)) {
      Reasons.push(`HDCP ${String(Snap.InputHdcp).toLowerCase()} on input ${Snap.ActiveInput}`);
    }
    for (const O of Snap.Outputs) {
      if (IsHdcpFailure(O.Hdcp)) {
        Reasons.push(`HDCP ${String(O.Hdcp).toLowerCase()} on output ${O.Output}`);
      }
    }
  }

  if (Cfg.CheckOutputsEnabled) {
    const Off = Snap.Outputs.filter((O) => O.Enabled === false).map((O) => O.Output);
    if (Off.length)
      Reasons.push(`${Off.length === 1 ? 'Output' : 'Outputs'} ${Off.join(', ')} off`);
  }

  if (Cfg.CheckTestPattern) {
    for (const O of Snap.Outputs) {
      if (O.ImageSource && O.ImageSource !== LIVE_SOURCE) {
        Reasons.push(`Output ${O.Output} showing ${SourceLabel(O.ImageSource).toLowerCase()}`);
      }
    }
  }

  if (Cfg.CheckTemperature && Snap.TemperatureMaximum != null) {
    const Limit = Number.isFinite(Number(Cfg.MaxTemperature)) ? Number(Cfg.MaxTemperature) : 70;
    if (Snap.TemperatureMaximum > Limit) {
      Reasons.push(`Temperature ${Snap.TemperatureMaximum} °C (limit ${Limit} °C)`);
    }
  }

  return Reasons;
}

function SourceLabel(Source: string): string {
  return SOURCE_LABELS[Source] || Source;
}

// --- Run --------------------------------------------------------------------

function BaseOf(Target: MonitoringTargetLike): URL | null {
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number.isFinite(Number(Cfg.Port)) ? Number(Cfg.Port) | 0 : 80;
  return BuildBaseUrl(Target && Target.Address, 'http', Port > 0 ? Port : 80);
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Cfg = (Target && Target.Settings) || {};
  const Base = BaseOf(Target);
  if (!Base) return { Success: false, Error: 'No address configured' };

  const Started = Date.now();
  const DeadlineAt = Started + TimeoutOf(Cfg, DEFAULT_TIMEOUT_MS);
  const Get = (Path: string) => Call(Base, Path, DeadlineAt);

  // Identity first: anything that does not return a serial number is not an Fx4.
  const SerialRes = await Get('/SerialNumber.cgx');
  if (!SerialRes.Ok) {
    if (SerialRes.Transport && /^HTTP |not JSON/.test(SerialRes.Error)) {
      return { Success: false, Error: `${SerialRes.Error}: not the Datapath Fx4 REST API` };
    }
    return { Success: false, Error: SerialRes.Error };
  }
  const Serial = StrOrNull(SerialRes.Value.SerialNumber);
  if (!Serial) return { Success: false, Error: 'Answered, but not as a Datapath Fx4' };

  // Every later read is best effort: a call the firmware does not support
  // leaves its reading empty. Running out of time, though, is offline: a
  // half-read controller must not look healthy.
  let TimedOut = false;
  const Read = async (Path: string): Promise<Record<string, unknown> | null> => {
    if (TimedOut) return null;
    const Res = await Get(Path);
    if (Res.Ok) return Res.Value;
    if (Res.TimedOut) TimedOut = true;
    return null;
  };

  const Info = (await Read('/SystemInfo.cgx')) || {};
  const Name = (await Read('/FriendlyName.cgx')) || {};
  const Health = ParseHealth((await Read('/SystemHealth.cgx')) || {});
  const Preferred = await Read('/PreferredInput.cgx');
  const Active = await Read('/ActiveInput.cgx');
  if (!TimedOut && !Active) {
    return { Success: false, Error: 'The controller did not report its active input' };
  }
  const ActiveInput = Active ? OneBased(Active.Input, INPUT_COUNT) : null;
  const CheckHdcp = Cfg.CheckHdcp !== false;

  let InputFormat: Fx4Format | null = null;
  let InputHdcp: string | null = null;
  if (ActiveInput != null) {
    const Timings = await Read(`/InputCurrentTimings.cgx?input=${ActiveInput - 1}`);
    InputFormat = Timings ? ParseFormat(Timings) : null;
    if (CheckHdcp) {
      const Hdcp = await Read(`/InputHDCPStatus.cgx?input=${ActiveInput - 1}`);
      InputHdcp = Hdcp ? StrOrNull(Hdcp.Status) : null;
    }
  }

  const Outputs: Fx4Output[] = [];
  for (let N = 0; N < OutputsOf(Cfg); N++) {
    const Enable = await Read(`/OutputEnable.cgx?output=${N}`);
    const Source = await Read(`/OutputImageSource.cgx?output=${N}`);
    const Timings = await Read(`/OutputCurrentTimings.cgx?output=${N}`);
    const Hdcp = CheckHdcp ? await Read(`/OutputHDCPStatus.cgx?output=${N}`) : null;
    Outputs.push({
      Output: N + 1,
      Enabled: Enable ? BoolOrNull(Enable.Enable) : null,
      ImageSource: Source ? StrOrNull(Source.Source) : null,
      Format: Timings ? ParseFormat(Timings) : null,
      Hdcp: Hdcp ? StrOrNull(Hdcp.Status) : null,
    });
  }

  if (TimedOut) {
    return { Success: false, Error: 'The controller stopped answering before the check finished' };
  }

  const BuildDate = [StrOrNull(Info.ApplicationBuildDate), StrOrNull(Info.ApplicationBuildTime)]
    .filter(Boolean)
    .join(' ');
  const Snap: Fx4Snapshot = {
    Serial,
    FriendlyName: StrOrNull(Name.FriendlyName),
    FirmwareVersion: NumOrNull(Info.FirmwareVersion),
    ConfigVersion: NumOrNull(Info.ConfigVersion),
    HardwareVersion: NumOrNull(Info.HardwareVersion),
    FpgaVersion: NumOrNull(Info.FPGAVersion),
    BuildDate: BuildDate || null,
    PowerRails: Health.PowerRails,
    TemperatureAverage: Health.Average,
    TemperatureMaximum: Health.Maximum,
    TemperatureMinimum: Health.Minimum,
    PreferredInput: Preferred ? OneBased(Preferred.Input, INPUT_COUNT) : null,
    ActiveInput,
    InputFormat,
    InputHdcp,
    Outputs,
  };

  const Reasons = EvaluateHealth(Snap, Cfg);
  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs: Date.now() - Started,
    ...Snap,
  };
}

// --- Actions ----------------------------------------------------------------
//
// Parameters are free text with suggested choices, never a select or a number
// with a default: the shared normaliser turns an unknown select value into its
// default and clamps a number, which would let a mistyped OSC value become a
// real command. RunAction validates every value strictly instead.

const OUTPUT_PARAM: MonitoringSettingField = {
  Key: 'Output',
  Label: 'Output',
  Type: 'string',
  Required: true,
  Options: [
    { value: 'all', label: 'All outputs' },
    ...Array.from({ length: OUTPUT_COUNT }, (_v, I) => ({
      value: String(I + 1),
      label: `Output ${I + 1}`,
    })),
  ],
  Note: '1 to 4, or All for every output.',
};

const Actions: MonitoringActionDef[] = [
  {
    ID: 'input.preferred',
    Label: 'Set Preferred Input',
    Icon: 'box-arrow-in-right',
    Group: 'Input',
    Destructive: true,
    Params: [
      {
        Key: 'Input',
        Label: 'Input',
        Type: 'string',
        Required: true,
        Options: [
          ...Array.from({ length: INPUT_COUNT }, (_v, I) => ({
            value: String(I + 1),
            label: `Input ${I + 1}`,
          })),
          { value: 'auto', label: 'No preference (automatic)' },
        ],
        Note: '1, 2 or 3, or Auto for no preferred input.',
      },
    ],
    Note: 'Switches the wall to another input while it has a signal. Not saved, so a restart brings back the saved preferred input.',
  },
  {
    ID: 'output.pattern',
    Label: 'Show Test Pattern',
    Icon: 'grid-3x3',
    Group: 'Output',
    Destructive: true,
    Params: [
      OUTPUT_PARAM,
      {
        Key: 'Pattern',
        Label: 'Pattern',
        Type: 'string',
        Required: true,
        Options: PATTERNS,
        Note: 'Colourbars, Greyscale, MovingColourbars or MovingGreyscale.',
      },
    ],
    Note: 'Replaces the picture on an output with a test pattern until Show Live Input is pressed.',
  },
  {
    ID: 'output.live',
    Label: 'Show Live Input',
    Icon: 'play-circle',
    Group: 'Output',
    Params: [OUTPUT_PARAM],
    Note: 'Returns an output from a test pattern to the live input.',
  },
  {
    ID: 'output.disable',
    Label: 'Switch Output Off',
    Icon: 'display',
    Group: 'Output',
    Destructive: true,
    Params: [OUTPUT_PARAM],
    Note: 'Stops sending a signal on an output, so its screen goes blank.',
  },
  {
    ID: 'output.enable',
    Label: 'Switch Output On',
    Icon: 'display',
    Group: 'Output',
    Params: [OUTPUT_PARAM],
    Note: 'Starts sending a signal on an output again.',
  },
];

// 1-based input number, 'auto' (no preference), or null for anything else.
function ParseInputParam(Value: unknown): number | 'auto' | null {
  const Text = String(Value == null ? '' : Value)
    .trim()
    .toLowerCase();
  if (Text === 'auto' || Text === 'none') return 'auto';
  return /^[1-3]$/.test(Text) ? Number(Text) : null;
}

// 1-based output numbers, or null when the value names none.
function ParseOutputParam(Value: unknown): number[] | null {
  const Text = String(Value == null ? '' : Value)
    .trim()
    .toLowerCase();
  if (Text === 'all') return Array.from({ length: OUTPUT_COUNT }, (_v, I) => I + 1);
  return /^[1-4]$/.test(Text) ? [Number(Text)] : null;
}

// The documented pattern name, matched without regard to case or spaces.
function ParsePatternParam(Value: unknown): string | null {
  const Text = String(Value == null ? '' : Value)
    .replace(/[\s_-]+/g, '')
    .toLowerCase();
  const Match = PATTERNS.find((P) => P.value.toLowerCase() === Text);
  return Match ? Match.value : null;
}

function OutputsLabel(Outputs: number[]): string {
  if (Outputs.length === OUTPUT_COUNT) return 'All outputs';
  return Outputs.length === 1 ? `Output ${Outputs[0]}` : `Outputs ${Outputs.join(', ')}`;
}

function RefusalText(Error: string): string {
  return /password/i.test(Error)
    ? `The controller refused: ${Error}. Check the Device password setting.`
    : `The controller refused: ${Error}`;
}

async function RunAction(
  Target: MonitoringTargetLike,
  ActionID: string,
  Params: Record<string, unknown> = {}
): Promise<MonitoringActionResult> {
  const Cfg = (Target && Target.Settings) || {};
  const Base = BaseOf(Target);
  if (!Base) return { Success: false, Error: 'No address configured' };
  const Password = String(Cfg.Password == null ? '' : Cfg.Password);
  const WithPassword = (Body: Record<string, unknown>) => (Password ? { ...Body, Password } : Body);
  const DeadlineAt = Date.now() + Math.min(TimeoutOf(Cfg, DEFAULT_TIMEOUT_MS), ACTION_TIMEOUT_MS);

  if (ActionID === 'input.preferred') {
    const Input = ParseInputParam(Params.Input);
    if (Input == null) return { Success: false, Error: 'Choose an input: 1, 2, 3 or Auto' };
    const Res = await Call(
      Base,
      '/PreferredInput.cgx',
      DeadlineAt,
      WithPassword({ Input: Input === 'auto' ? null : Input - 1 })
    );
    if (!Res.Ok)
      return { Success: false, Error: Res.Transport ? Res.Error : RefusalText(Res.Error) };
    return {
      Success: true,
      Detail:
        Input === 'auto' ? 'Preferred input cleared' : `Preferred input set to input ${Input}`,
    };
  }

  let Body: (Output: number) => Record<string, unknown>;
  let Path: string;
  let Verb: string;
  const Outputs = ParseOutputParam(Params.Output);
  if (ActionID === 'output.pattern') {
    const Pattern = ParsePatternParam(Params.Pattern);
    if (!Outputs) return { Success: false, Error: 'Choose an output: 1 to 4, or All' };
    if (!Pattern) {
      return {
        Success: false,
        Error: 'Choose a pattern: Colourbars, Greyscale, MovingColourbars or MovingGreyscale',
      };
    }
    Path = '/OutputImageSource.cgx';
    Body = (Output) => ({ Output, Source: Pattern });
    Verb = `showing ${SourceLabel(Pattern).toLowerCase()}`;
  } else if (ActionID === 'output.live') {
    Path = '/OutputImageSource.cgx';
    Body = (Output) => ({ Output, Source: LIVE_SOURCE });
    Verb = 'back on the live input';
  } else if (ActionID === 'output.disable' || ActionID === 'output.enable') {
    const Enable = ActionID === 'output.enable';
    Path = '/OutputEnable.cgx';
    Body = (Output) => ({ Output, Enable });
    Verb = Enable ? 'switched on' : 'switched off';
  } else {
    return { Success: false, Error: `Unknown Datapath Fx4 action "${ActionID}"` };
  }
  if (!Outputs) return { Success: false, Error: 'Choose an output: 1 to 4, or All' };

  // One POST per output, in order; stop at the first failure and say which
  // outputs did change.
  const Done: number[] = [];
  for (const Output of Outputs) {
    const Res = await Call(Base, Path, DeadlineAt, WithPassword(Body(Output - 1)));
    if (!Res.Ok) {
      const Why = Res.Transport ? Res.Error : RefusalText(Res.Error);
      return {
        Success: false,
        Error: Done.length
          ? `${OutputsLabel(Done)} ${Verb}, but output ${Output} failed: ${Why}`
          : Why,
      };
    }
    Done.push(Output);
  }
  return { Success: true, Detail: `${OutputsLabel(Done)} ${Verb}` };
}

// No GetActionOptions: every Fx4 model has three inputs and four outputs, so
// the parameters' own Options already list the real choices.

function DescribeAction(ActionID: string, Params: Record<string, unknown>): string | null {
  if (ActionID === 'input.preferred') {
    const Input = ParseInputParam(Params && Params.Input);
    if (Input == null) return null;
    return Input === 'auto' ? 'Clear Preferred Input' : `Preferred Input ${Input}`;
  }
  const Outputs = ParseOutputParam(Params && Params.Output);
  if (!Outputs) return null;
  const Which = OutputsLabel(Outputs);
  if (ActionID === 'output.pattern') {
    const Pattern = ParsePatternParam(Params && Params.Pattern);
    return Pattern ? `${SourceLabel(Pattern)} on ${Which}` : null;
  }
  if (ActionID === 'output.live') return `Live Input on ${Which}`;
  if (ActionID === 'output.disable') return `Switch Off ${Which}`;
  if (ActionID === 'output.enable') return `Switch On ${Which}`;
  return null;
}

// --- Debug ------------------------------------------------------------------

function StatePill(Result: MonitoringResult): string {
  const Reachable = !!(Result && Result.Success === true);
  if (Reachable && !Result.Degraded) return Pill('success', 'Healthy');
  if (Reachable) return Pill('warning', Result.DegradedReason || 'Degraded');
  return Pill('danger', 'Offline');
}

function Mono(Value: unknown): string {
  return `<span class="font-monospace">${Esc(Value)}</span>`;
}

function FormatText(F: Fx4Format | null | undefined): string | null {
  if (!F || F.Width == null || F.Height == null) return null;
  const Rate = F.RefreshHz != null ? ` @ ${F.RefreshHz} Hz` : '';
  const Extra = [F.ColourSpace, F.Subsampling, F.SdiLevel ? `SDI level ${F.SdiLevel}` : null]
    .filter(Boolean)
    .join(', ');
  return `${F.Width}x${F.Height}${Rate}${Extra ? ` (${Extra})` : ''}`;
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  const Reachable = !!(Result && Result.Success === true);
  const R = (Result || {}) as Partial<Fx4Snapshot> & MonitoringResult;

  const Versions = [
    R.FirmwareVersion != null ? `firmware ${R.FirmwareVersion}` : null,
    R.FpgaVersion != null ? `FPGA ${R.FpgaVersion}` : null,
    R.HardwareVersion != null ? `hardware ${R.HardwareVersion}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const Rails = Array.isArray(R.PowerRails) ? R.PowerRails : [];
  const BadRails = Rails.filter((P) => !P.Ok).map((P) => P.Name);
  const Input =
    R.ActiveInput != null
      ? `Input ${R.ActiveInput}: ${FormatText(R.InputFormat) || 'format not reported'}`
      : 'No signal';

  const Head = Rows([
    TextRow('Controller', `${Address || '—'}${R.FriendlyName ? ` (${R.FriendlyName})` : ''}`),
    Row('Status', StatePill(Result)),
    Reachable
      ? Row('Reply time', Mono(FormatLatency(R.LatencyMs)))
      : TextRow('Error', (Result && Result.Error) || 'Failed to reach the controller'),
    Reachable && R.Serial ? Row('Serial', Mono(R.Serial)) : null,
    Reachable && Versions ? TextRow('Versions', Versions) : null,
    Reachable && R.BuildDate ? TextRow('Firmware built', R.BuildDate) : null,
    Reachable ? TextRow('Active input', Input) : null,
    Reachable
      ? TextRow(
          'Preferred input',
          R.PreferredInput != null ? `Input ${R.PreferredInput}` : 'None (automatic)'
        )
      : null,
    Reachable && R.InputHdcp ? TextRow('Input HDCP', R.InputHdcp) : null,
    Reachable && Rails.length
      ? Row(
          'Power supply',
          BadRails.length
            ? Pill('danger', `Fault: ${BadRails.join(', ')}`)
            : Pill('success', 'All rails good')
        )
      : null,
    Reachable && R.TemperatureMaximum != null
      ? TextRow(
          'Temperature',
          `${R.TemperatureMaximum} °C hottest` +
            (R.TemperatureAverage != null ? `, ${R.TemperatureAverage} °C average` : '')
        )
      : null,
  ]);
  if (!Reachable) {
    return (
      Head +
      '<div class="mt-2">' +
      Note(
        'Failed to read the Fx4 REST API. Check the address and that the LAN port is connected.'
      ) +
      '</div>'
    );
  }

  const Cards: string[] = [];
  for (const O of Array.isArray(R.Outputs) ? R.Outputs : []) {
    const Badge =
      O.Enabled === false
        ? Pill('warning', 'Off')
        : O.ImageSource && O.ImageSource !== LIVE_SOURCE
          ? Pill('warning', SourceLabel(O.ImageSource))
          : IsHdcpFailure(O.Hdcp)
            ? Pill('danger', `HDCP ${O.Hdcp}`)
            : O.Enabled === true
              ? Pill('success', 'On')
              : Pill('muted', 'Unknown');
    const Format = FormatText(O.Format);
    Cards.push(
      Card({
        Title: `Output ${O.Output}`,
        Badge,
        BodyHtml: Format ? `<div class="text-muted small">${Esc(Format)}</div>` : '',
      })
    );
  }
  return Cards.length ? Head + `<div class="d-grid gap-1 mt-2">${Cards.join('')}</div>` : Head;
}

export const Name = 'Datapath Fx4';
export const Description =
  'Reads a Datapath Fx4, Fx4-SDI or Fx4-HDR video wall controller over its REST API: serial, firmware, active and preferred input, input format, power supply, temperature, HDCP and the state of each output. Flags no input signal, a power fault and HDCP failures by default; optional toggles also flag a fallback from the preferred input, an unexpected input format, outputs switched off, test patterns and a high temperature. The check only reads; preferred input, test pattern and output on/off are offered as actions.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseBody,
  ParseFormat,
  ParseHealth,
  EvaluateHealth,
  ParseResolution,
  ParseInputParam,
  ParseOutputParam,
  ParsePatternParam,
};
export { ID, Settings, Actions, Run, RunAction, DescribeAction, Debug };
