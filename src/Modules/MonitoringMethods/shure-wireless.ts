// Shure wireless receiver check (ULX-D, QLX-D, SLX-D, Axient Digital).
//
// The point is mid-show safety: catch a dying body-pack battery or a lost
// transmitter before the actor goes on, not after the desk loses the channel.
//
// Protocol: Shure's third-party "command strings" on TCP 2202. Every message is
// ASCII framed by angle brackets, e.g.
//
//   < GET 0 ALL >                       request, channel 0 = every channel
//   < REP FW_VER {2.1.15              } >     device property (no index)
//   < REP 2 CHAN_NAME {Lead Vox} >           channel property
//   < REP 2 BATT_BARS 004 >                  numeric, zero-padded
//   < REP 1 RSSI 1 083 >                     AD/SLX per-antenna RSSI
//   < REP 1 SLOT_BATT_BARS 3 255 >           AD transmitter slot (ignored)
//   < SAMPLE 1 ALL XB 096 038 >              metering, only when METER_RATE is set
//
// `GET 0 ALL` makes the receiver report every device property and every
// channel property, metered ones included (Shure ULX-D / SLX-D / AD command
// string guides). There is no end-of-reply marker, so the probe reads REP lines
// until the receiver goes quiet for QUIET_MS, or the Timeout budget runs out —
// in which case whatever arrived is still evaluated. SAMPLE lines (sent only if
// some other controller enabled metering) do not hold the session open.
//
// Read-only by construction: the probe sends nothing but `< GET 0 ALL >`. It
// never sets METER_RATE (a receiver-wide setting other controllers rely on), so
// RF levels come only from the metered values GET ALL reports.
//
// Family differences the parser absorbs (key names, from Shure's guides and
// Bitfocus Companion's companion-module-shure-wireless):
//   ULX-D / QLX-D : TX_TYPE, BATT_BARS, BATT_CHARGE, BATT_RUN_TIME, BATT_TYPE,
//                   TX_MUTE_STATUS (ULXD6/8 only), RF_INT_DET, ENCRYPTION_WARNING,
//                   RX_RF_LVL (dBm = value − 128), RF_ANTENNA
//   SLX-D         : TX_MODEL, TX_BATT_BARS, TX_BATT_MINS, RSSI (dBm = value − 120)
//   Axient Digital: TX_MODEL, TX_BATT_BARS, TX_BATT_CHARGE_PERCENT, TX_BATT_MINS,
//                   TX_BATT_TYPE, TX_MUTE_MODE_STATUS, INTERFERENCE_STATUS(2),
//                   ENCRYPTION_STATUS, UNREGISTERED_TX_STATUS, CHAN_QUALITY, RSSI
// Sentinels mean "unknown", never zero: 255 for bars/percent/quality, 65535 for
// minutes (65534 = calculating, 65533 = battery communication warning), and
// UNKN / UNKNOWN for strings.
//
// Assertions: battery is on by default (the reason this check exists); a
// required transmitter, mute and RF warnings are opt-in. Battery readings are
// only judged while a transmitter is present — a switched-off spare pack is not
// a flat battery, and that is what Require transmitter is for.
import { RunTcpSession } from './_tcp-session';
import { Card, FormatLatency, Note, Pill, Row, Rows, TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'shure-wireless';

const DEFAULT_PORT = 2202;
const DEFAULT_TIMEOUT_MS = 4000;
// Silence after the last REP that counts as "the GET ALL burst is over". The
// receiver writes the whole group back-to-back, so a gap this long means done.
const QUIET_MS = 500;
// Guard rails against a misbehaving peer streaming junk at the socket.
const MAX_BUFFER_CHARS = 256 * 1024;
const MAX_MESSAGE_CHARS = 512;
// Quad receivers are the largest current models; anything above is noise.
const MAX_CHANNEL = 8;

const DEFAULTS = {
  LowBatteryBars: 1,
  LowBatteryMinutes: 60,
};

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'Port',
    Type: 'number',
    Default: DEFAULT_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
  },
  {
    Key: 'Channels',
    Label: 'Channels',
    Type: 'list',
    ItemType: 'number',
    Default: [],
    Note: 'Receiver channel numbers to monitor, e.g. 1 and 3. Leave empty to monitor every channel the receiver reports.',
  },
  {
    Key: 'CheckBattery',
    Label: 'Check transmitter battery',
    Type: 'boolean',
    Default: true,
    Note: 'Report Degraded when a monitored channel’s transmitter battery is at or below the thresholds. Skipped while no transmitter is on.',
  },
  {
    Key: 'LowBatteryBars',
    Label: 'Low battery at (bars)',
    Type: 'number',
    Default: DEFAULTS.LowBatteryBars,
    Min: 0,
    Max: 5,
    VisibleWhen: { Key: 'CheckBattery', Equals: true },
    Note: 'Every model reports battery as 0–5 bars. Degraded at or below this many bars; 0 turns the bar check off.',
  },
  {
    Key: 'LowBatteryMinutes',
    Label: 'Low battery at (minutes left)',
    Type: 'number',
    Default: DEFAULTS.LowBatteryMinutes,
    Min: 0,
    Max: 1440,
    VisibleWhen: { Key: 'CheckBattery', Equals: true },
    Note: 'Runtime is only reported for Shure rechargeable packs. Degraded at or below this many minutes; 0 turns the runtime check off.',
  },
  {
    Key: 'RequireTransmitter',
    Label: 'Require transmitter',
    Type: 'boolean',
    Default: false,
    Note: 'Report Degraded when a monitored channel is not receiving a transmitter. Leave off for spare channels that legitimately have no pack on.',
  },
  {
    Key: 'CheckMute',
    Label: 'Check mute',
    Type: 'boolean',
    Default: false,
    Note: 'Report Degraded when a monitored channel’s receiver output is muted, or its transmitter reports mute (ULXD6/ULXD8 and Axient Digital transmitters only).',
  },
  {
    Key: 'CheckWarnings',
    Label: 'Check RF warnings',
    Type: 'boolean',
    Default: false,
    Note: 'Report Degraded on detected RF interference, an encryption mismatch, or an unregistered Axient Digital transmitter.',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: DEFAULT_TIMEOUT_MS,
    Min: 500,
    Max: 30000,
    Advanced: true,
    Note: 'Budget for the whole probe: connecting and reading every report.',
  },
];

// --- Config -----------------------------------------------------------------

interface ShureConfig {
  Address: string;
  Port: number;
  TimeoutMs: number;
}

function ParseConfig(Target: MonitoringTargetLike): ShureConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number(Cfg.Port);
  const Timeout = Number(Cfg.Timeout);
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Port: Number.isFinite(Port) && Port > 0 ? Math.trunc(Port) : DEFAULT_PORT,
    TimeoutMs:
      Number.isFinite(Timeout) && Timeout > 0 ? Math.max(500, Timeout) : DEFAULT_TIMEOUT_MS,
  };
}

// Parse the Channels list setting. The editor stores a list as an array of
// strings or numbers; a comma-separated string is accepted too. Invalid entries
// are dropped, and the result is sorted and de-duplicated.
function ParseChannelList(Value: unknown): number[] {
  const Raw: unknown[] = Array.isArray(Value)
    ? Value
    : typeof Value === 'string'
      ? Value.split(/[\s,;]+/)
      : typeof Value === 'number'
        ? [Value]
        : [];
  const Out = new Set<number>();
  for (const Item of Raw) {
    const N = Number(typeof Item === 'string' ? Item.trim() : Item);
    if (Number.isInteger(N) && N >= 1 && N <= 99) Out.add(N);
  }
  return [...Out].sort((A, B) => A - B);
}

export interface EvaluateOptions {
  Channels: number[];
  CheckBattery: boolean;
  LowBatteryBars: number;
  LowBatteryMinutes: number;
  RequireTransmitter: boolean;
  CheckMute: boolean;
  CheckWarnings: boolean;
}

function ParseOptions(Target: MonitoringTargetLike): EvaluateOptions {
  const Cfg = (Target && Target.Settings) || {};
  const Clamp = (Value: unknown, Min: number, Max: number, Fallback: number): number => {
    const N = Number(Value);
    return Number.isFinite(N) ? Math.min(Max, Math.max(Min, Math.trunc(N))) : Fallback;
  };
  return {
    Channels: ParseChannelList(Cfg.Channels),
    // Battery is the reason this check exists, so an unset toggle counts as on.
    CheckBattery: Cfg.CheckBattery !== false,
    LowBatteryBars: Clamp(Cfg.LowBatteryBars, 0, 5, DEFAULTS.LowBatteryBars),
    LowBatteryMinutes: Clamp(Cfg.LowBatteryMinutes, 0, 1440, DEFAULTS.LowBatteryMinutes),
    RequireTransmitter: Cfg.RequireTransmitter === true,
    CheckMute: Cfg.CheckMute === true,
    CheckWarnings: Cfg.CheckWarnings === true,
  };
}

// --- Wire parsing -----------------------------------------------------------

// Split buffered text into complete `< ... >` messages. Brace-quoted strings
// may legally contain `<` and `>` (channel names accept any printable ASCII),
// so a closing bracket only ends a message outside braces. Text before a `<`
// is discarded; an incomplete trailing message is returned as Rest for the next
// chunk. An unterminated message longer than MAX_MESSAGE_CHARS is junk and is
// skipped so it cannot wedge the buffer.
function SplitMessages(Buffer: string): { Messages: string[]; Rest: string } {
  const Messages: string[] = [];
  let Pos = 0;
  while (Pos < Buffer.length) {
    const Start = Buffer.indexOf('<', Pos);
    if (Start === -1) return { Messages, Rest: '' };
    let Depth = 0;
    let End = -1;
    // Bounded: a frame longer than MAX_MESSAGE_CHARS is junk anyway, and an
    // unbounded scan per `<` makes a hostile `<{<{…` buffer quadratic.
    const Limit = Math.min(Buffer.length, Start + 1 + MAX_MESSAGE_CHARS);
    for (let I = Start + 1; I < Limit; I++) {
      const C = Buffer[I];
      if (C === '{') Depth++;
      else if (C === '}') Depth = Math.max(0, Depth - 1);
      else if (C === '>' && Depth === 0) {
        End = I;
        break;
      }
    }
    if (End === -1) {
      // Reached the end of the buffer within the bound: wait for more data.
      if (Limit === Buffer.length && Buffer.length - Start <= MAX_MESSAGE_CHARS) {
        return { Messages, Rest: Buffer.slice(Start) };
      }
      Pos = Start + 1;
      continue;
    }
    Messages.push(Buffer.slice(Start + 1, End).trim());
    Pos = End + 1;
  }
  return { Messages, Rest: '' };
}

// Tokenise a message body on whitespace, keeping a `{...}` string as one token
// (braces included, so callers can tell a quoted value from a bare one).
function Tokenise(Body: string): string[] {
  const Tokens: string[] = [];
  let I = 0;
  while (I < Body.length) {
    const C = Body[I] as string;
    if (/\s/.test(C)) {
      I++;
      continue;
    }
    if (C === '{') {
      const Close = Body.indexOf('}', I + 1);
      const End = Close === -1 ? Body.length : Close + 1;
      Tokens.push(Body.slice(I, End));
      I = End;
      continue;
    }
    let J = I;
    while (J < Body.length && !/\s/.test(Body[J] as string)) J++;
    Tokens.push(Body.slice(I, J));
    I = J;
  }
  return Tokens;
}

export interface ShureReport {
  // null for a device-level property (`< REP MODEL {...} >`).
  Channel: number | null;
  Key: string;
  Args: string[];
}

// Parse one message body into a report. Returns null for anything that is not
// a usable REP: SAMPLE metering, `REP ERR`, or junk.
function ParseReport(Body: string): ShureReport | null {
  const Tokens = Tokenise(Body);
  if (Tokens[0] !== 'REP' || Tokens.length < 3) return null;
  const Second = Tokens[1] as string;
  if (/^\d+$/.test(Second)) {
    const Key = Tokens[2] as string;
    if (!/^[A-Z][A-Z0-9_]*$/.test(Key)) return null;
    return { Channel: Number(Second), Key, Args: Tokens.slice(3) };
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(Second) || Second === 'ERR') return null;
  return { Channel: null, Key: Second, Args: Tokens.slice(2) };
}

// Raw reported values, keyed exactly as the receiver sent them. Later reports
// overwrite earlier ones, matching how the receiver pushes changes.
export interface ShureSnapshot {
  Device: Record<string, string>;
  Channels: Record<number, Record<string, string>>;
  // Per channel, per antenna index (1–4): raw RSSI value.
  Rssi: Record<number, Record<number, string>>;
  ReportCount: number;
}

function EmptySnapshot(): ShureSnapshot {
  return { Device: {}, Channels: {}, Rssi: {}, ReportCount: 0 };
}

function ApplyReport(Snapshot: ShureSnapshot, Report: ShureReport): void {
  Snapshot.ReportCount++;
  if (Report.Channel == null) {
    Snapshot.Device[Report.Key] = Report.Args.join(' ');
    return;
  }
  const Ch = Report.Channel;
  if (Ch < 1 || Ch > MAX_CHANNEL) return; // channel 0 / out-of-range: nothing per-channel
  // Axient transmitter slots: the channel-level TX_* values already describe the
  // active transmitter, so the eight registered slots are not needed here.
  if (Report.Key.startsWith('SLOT_')) return;
  if (Report.Key === 'RSSI') {
    const Antenna = Number(Report.Args[0]);
    const Value = Report.Args[1];
    if (Number.isInteger(Antenna) && Antenna >= 1 && Antenna <= 4 && Value != null) {
      (Snapshot.Rssi[Ch] ??= {})[Antenna] = Value;
    }
    (Snapshot.Channels[Ch] ??= {}).RSSI = '';
    return;
  }
  (Snapshot.Channels[Ch] ??= {})[Report.Key] = Report.Args.join(' ');
}

// Parse a complete text capture (tests and the probe share this path).
function ParseCapture(Text: string): ShureSnapshot {
  const Snapshot = EmptySnapshot();
  for (const Body of SplitMessages(Text).Messages) {
    const Report = ParseReport(Body);
    if (Report) ApplyReport(Snapshot, Report);
  }
  return Snapshot;
}

// --- Interpretation ---------------------------------------------------------

// `{Lead Vox      }` -> `Lead Vox`. Bare values are returned trimmed.
function Unquote(Value: string | undefined): string {
  if (Value == null) return '';
  const V = Value.trim();
  const Inner = V.startsWith('{') ? V.slice(1, V.endsWith('}') ? -1 : undefined) : V;
  return Inner.trim();
}

function IsUnknownText(Value: string): boolean {
  return /^(UNKN|UNKNOWN)$/i.test(Value.trim());
}

// A numeric report, or null when missing, non-numeric or one of the sentinels.
function ShureNumber(
  Value: string | undefined,
  Max: number,
  Sentinels: number[] = []
): number | null {
  if (Value == null) return null;
  const Trimmed = Value.trim();
  if (!/^-?\d+$/.test(Trimmed)) return null;
  const N = Number(Trimmed);
  if (Sentinels.includes(N) || N < 0 || N > Max) return null;
  return N;
}

export interface ShureChannel {
  Number: number;
  Name: string;
  FrequencyMHz: number | null;
  // true = receiving a transmitter; false = the receiver says none; null = not reported.
  TxPresent: boolean | null;
  TxType: string | null;
  TxDeviceId: string | null;
  BatteryBars: number | null;
  BatteryPercent: number | null;
  BatteryMinutes: number | null;
  BatteryCalculating: boolean;
  BatteryCommWarning: boolean;
  BatteryType: string | null;
  TxMuted: boolean | null;
  RxMuted: boolean | null;
  Interference: boolean | null;
  EncryptionError: boolean | null;
  UnregisteredTx: boolean | null;
  SignalQuality: number | null;
  RfLevelsDbm: number[];
  Antenna: string | null;
}

export interface ShureDevice {
  Model: string | null;
  Family: string;
  DeviceId: string | null;
  Firmware: string | null;
  Channels: ShureChannel[];
}

function DetectFamily(Model: string | null, Snapshot: ShureSnapshot): string {
  const M = (Model || '').toUpperCase();
  if (M.startsWith('ULXD')) return 'ULX-D';
  if (M.startsWith('QLXD')) return 'QLX-D';
  if (M.startsWith('SLXD')) return 'SLX-D';
  if (M.startsWith('AD')) return 'Axient Digital';
  // No MODEL report (QLX-D firmware may not send one): infer from the keys only
  // one family uses.
  const Keys = new Set<string>(Object.keys(Snapshot.Device));
  for (const Ch of Object.values(Snapshot.Channels)) for (const K of Object.keys(Ch)) Keys.add(K);
  if (
    Keys.has('QUADVERSITY_MODE') ||
    Keys.has('CHAN_QUALITY') ||
    Keys.has('TX_BATT_CHARGE_PERCENT')
  )
    return 'Axient Digital';
  if (Keys.has('AUDIO_OUT_LVL_SWITCH') || Keys.has('LOCK_STATUS')) return 'SLX-D';
  if (Keys.has('BATT_BARS') || Keys.has('RF_INT_DET') || Keys.has('TX_TYPE'))
    return 'ULX-D / QLX-D';
  return 'Shure';
}

function InterpretChannel(
  Number_: number,
  Raw: Record<string, string>,
  Rssi: Record<number, string> | undefined
): ShureChannel {
  const Pick = (...Keys: string[]): string | undefined => {
    for (const K of Keys) if (Raw[K] != null) return Raw[K];
    return undefined;
  };

  const TxTypeRaw = Pick('TX_TYPE', 'TX_MODEL');
  const TxType =
    TxTypeRaw != null && Unquote(TxTypeRaw) && !IsUnknownText(Unquote(TxTypeRaw))
      ? Unquote(TxTypeRaw)
      : null;
  const BarsRaw = Pick('BATT_BARS', 'TX_BATT_BARS');
  const Bars = ShureNumber(BarsRaw, 5, [255]);
  const RuntimeRaw = ShureNumber(Pick('BATT_RUN_TIME', 'TX_BATT_MINS'), 65535);
  const BatteryTypeRaw = Unquote(Pick('BATT_TYPE', 'TX_BATT_TYPE'));
  const TxDeviceId = Unquote(Pick('TX_DEVICE_ID'));

  // A transmitter is present when the receiver names its model or reports a
  // battery level; TX_TYPE UNKN plus 255 bars is Shure's "no transmitter".
  let TxPresent: boolean | null = null;
  if (TxType || Bars != null) TxPresent = true;
  else if (TxTypeRaw != null || BarsRaw != null) TxPresent = false;

  const OnOff = (
    Value: string | undefined,
    OnValues: string[],
    OffValues: string[]
  ): boolean | null => {
    if (Value == null) return null;
    const V = Value.trim().toUpperCase();
    if (OnValues.includes(V)) return true;
    if (OffValues.includes(V)) return false;
    return null;
  };

  // ULXD6/8: TX_MUTE_STATUS ON/OFF. Axient: TX_MUTE_MODE_STATUS MUTE (switch off,
  // RF still on) vs ON (audio passing).
  const TxMuted =
    OnOff(Raw.TX_MUTE_STATUS, ['ON'], ['OFF']) ?? OnOff(Raw.TX_MUTE_MODE_STATUS, ['MUTE'], ['ON']);

  const Interference = (() => {
    const A = OnOff(Raw.RF_INT_DET, ['CRITICAL'], ['NONE']);
    const B = OnOff(Raw.INTERFERENCE_STATUS, ['DETECTED'], ['NONE']);
    const C = OnOff(Raw.INTERFERENCE_STATUS2, ['DETECTED'], ['NONE']);
    if (A === true || B === true || C === true) return true;
    if (A === false || B === false || C === false) return false;
    return null;
  })();

  const RfLevelsDbm: number[] = [];
  const UlxRf = ShureNumber(Raw.RX_RF_LVL, 255);
  if (UlxRf != null) RfLevelsDbm.push(UlxRf - 128);
  if (Rssi) {
    for (const Antenna of Object.keys(Rssi)
      .map(Number)
      .sort((A, B) => A - B)) {
      const V = ShureNumber(Rssi[Antenna], 120);
      if (V != null) RfLevelsDbm.push(V - 120);
    }
  }

  const FrequencyKhz = ShureNumber(Raw.FREQUENCY, 9_999_999, [0]);
  const Antenna = Unquote(Pick('RF_ANTENNA', 'ANTENNA_STATUS'));

  return {
    Number: Number_,
    Name: Unquote(Raw.CHAN_NAME),
    FrequencyMHz: FrequencyKhz != null ? FrequencyKhz / 1000 : null,
    TxPresent,
    TxType,
    TxDeviceId: TxDeviceId || null,
    BatteryBars: Bars,
    BatteryPercent: ShureNumber(Pick('BATT_CHARGE', 'TX_BATT_CHARGE_PERCENT'), 100, [255]),
    BatteryMinutes: RuntimeRaw != null && RuntimeRaw <= 65532 ? RuntimeRaw : null,
    BatteryCalculating: RuntimeRaw === 65534,
    BatteryCommWarning: RuntimeRaw === 65533,
    BatteryType: BatteryTypeRaw && !IsUnknownText(BatteryTypeRaw) ? BatteryTypeRaw : null,
    TxMuted,
    RxMuted: OnOff(Raw.AUDIO_MUTE, ['ON'], ['OFF']),
    Interference,
    EncryptionError:
      OnOff(Raw.ENCRYPTION_WARNING, ['ON'], ['OFF']) ??
      OnOff(Raw.ENCRYPTION_STATUS, ['ERROR'], ['OK']),
    UnregisteredTx: OnOff(Raw.UNREGISTERED_TX_STATUS, ['ERROR'], ['OK']),
    SignalQuality: ShureNumber(Raw.CHAN_QUALITY, 5, [255]),
    RfLevelsDbm,
    Antenna: Antenna || null,
  };
}

function InterpretSnapshot(Snapshot: ShureSnapshot): ShureDevice {
  const Model = Unquote(Snapshot.Device.MODEL) || null;
  const Channels = Object.keys(Snapshot.Channels)
    .map(Number)
    .sort((A, B) => A - B)
    .map((N) => InterpretChannel(N, Snapshot.Channels[N] ?? {}, Snapshot.Rssi[N]));
  return {
    Model,
    Family: DetectFamily(Model, Snapshot),
    DeviceId: Unquote(Snapshot.Device.DEVICE_ID) || null,
    Firmware: Unquote(Snapshot.Device.FW_VER) || null,
    Channels,
  };
}

// --- Evaluation -------------------------------------------------------------

function ChannelLabel(Number_: number, Name: string): string {
  return Name ? `Ch ${Number_} (${Name})` : `Ch ${Number_}`;
}

// The battery part of a channel's reason, or null when the battery is fine (or
// unknown — unknown is never treated as low).
function BatteryIssue(Ch: ShureChannel, Options: EvaluateOptions): string | null {
  const Parts: string[] = [];
  if (
    Options.LowBatteryBars > 0 &&
    Ch.BatteryBars != null &&
    Ch.BatteryBars <= Options.LowBatteryBars
  ) {
    Parts.push(`${Ch.BatteryBars}/5 bars`);
  }
  if (
    Options.LowBatteryMinutes > 0 &&
    Ch.BatteryMinutes != null &&
    Ch.BatteryMinutes <= Options.LowBatteryMinutes
  ) {
    Parts.push(`${Ch.BatteryMinutes} min left`);
  }
  if (Parts.length) return `battery ${Parts.join(', ')}`;
  if (Ch.BatteryCommWarning) return 'battery communication warning';
  return null;
}

// Issues for one channel, per the enabled options. Pure.
function ChannelIssues(Ch: ShureChannel, Options: EvaluateOptions): string[] {
  const Issues: string[] = [];
  if (Ch.TxPresent === false) {
    if (Options.RequireTransmitter) Issues.push('no transmitter');
  } else if (Ch.TxPresent === true) {
    if (Options.CheckBattery) {
      const Battery = BatteryIssue(Ch, Options);
      if (Battery) Issues.push(Battery);
    }
    if (Options.CheckMute && Ch.TxMuted === true) Issues.push('transmitter muted');
  }
  if (Options.CheckMute && Ch.RxMuted === true) Issues.push('receiver output muted');
  if (Options.CheckWarnings) {
    if (Ch.Interference === true) Issues.push('RF interference detected');
    if (Ch.EncryptionError === true) Issues.push('encryption mismatch');
    if (Ch.UnregisteredTx === true) Issues.push('unregistered transmitter');
  }
  return Issues;
}

export interface Evaluation {
  Reasons: string[];
  Monitored: number[];
  Missing: number[];
  Issues: Record<number, string[]>;
}

// Turn an interpreted receiver into reasons. Monitors the configured channels
// (or all reported ones); a configured channel the receiver does not report is
// itself a reason, since it means the check is watching nothing. Pure.
function EvaluateShure(Device: ShureDevice, Options: EvaluateOptions): Evaluation {
  const Reported = new Map(Device.Channels.map((Ch) => [Ch.Number, Ch]));
  const Monitored = Options.Channels.length ? Options.Channels : [...Reported.keys()];
  const Reasons: string[] = [];
  const Missing: number[] = [];
  const Issues: Record<number, string[]> = {};
  for (const N of Monitored) {
    const Ch = Reported.get(N);
    if (!Ch) {
      Missing.push(N);
      Reasons.push(`Ch ${N}: not reported by this receiver`);
      continue;
    }
    const List = ChannelIssues(Ch, Options);
    Issues[N] = List;
    if (List.length) Reasons.push(`${ChannelLabel(N, Ch.Name)}: ${List.join(', ')}`);
  }
  return { Reasons, Monitored, Missing, Issues };
}

// --- Probe ------------------------------------------------------------------

type ProbeOutcome =
  | {
      Ok: true;
      Snapshot: ShureSnapshot;
      LatencyMs: number | null;
      Partial: boolean;
      Connected: true;
    }
  | { Ok: false; Error: string; Refused: boolean };

// One short session: connect, `< GET 0 ALL >`, read REPs until quiet or the
// budget ends, close.
function ProbeShure(Config: ShureConfig): Promise<ProbeOutcome> {
  const Budget = Config.TimeoutMs;
  const Snapshot = EmptySnapshot();
  let Text = '';
  let Connected = false;
  let FirstReportAt: number | null = null;
  let QuietTimer: ReturnType<typeof setTimeout> | null = null;

  const Done = (StartedAt: number, Partial: boolean): ProbeOutcome => ({
    Ok: true,
    Snapshot,
    LatencyMs: FirstReportAt != null ? FirstReportAt - StartedAt : null,
    Partial,
    Connected: true,
  });

  return RunTcpSession<ProbeOutcome>({
    Address: Config.Address,
    Port: Config.Port,
    IdleMs: Budget,
    DeadlineMs: Budget,
    NoDelay: true,
    OnSettle: () => {
      if (QuietTimer) clearTimeout(QuietTimer);
      QuietTimer = null;
    },
    OnConnect: (Session) => {
      Connected = true;
      try {
        Session.Socket.write('< GET 0 ALL >');
      } catch (Err) {
        Session.Finish({
          Ok: false,
          Error: Err instanceof Error ? Err.message : String(Err),
          Refused: false,
        });
      }
    },
    OnData: (Chunk, Session) => {
      Text += Chunk.toString('latin1');
      if (Text.length > MAX_BUFFER_CHARS) {
        Session.Finish({ Ok: false, Error: 'Reply too large', Refused: false });
        return;
      }
      const Split = SplitMessages(Text);
      Text = Split.Rest;
      let SawReport = false;
      for (const Body of Split.Messages) {
        const Report = ParseReport(Body);
        if (!Report) continue;
        ApplyReport(Snapshot, Report);
        SawReport = true;
      }
      if (!SawReport) return;
      if (FirstReportAt == null) FirstReportAt = Date.now();
      if (QuietTimer) clearTimeout(QuietTimer);
      QuietTimer = setTimeout(() => Session.Finish(Done(Session.StartedAt, false)), QUIET_MS);
    },
    OnTimeout: (Session) => {
      if (Snapshot.ReportCount > 0) return Done(Session.StartedAt, true);
      if (Connected) return Done(Session.StartedAt, false);
      return { Ok: false, Error: `Connection timed out after ${Budget}ms`, Refused: false };
    },
    OnError: (Message) => ({
      Ok: false,
      Error: Message,
      Refused: Message.includes('ECONNREFUSED') || Message.includes('ECONNRESET'),
    }),
    OnClose: (Session) => {
      if (Snapshot.ReportCount > 0) return Done(Session.StartedAt, false);
      return { Ok: false, Error: 'Connection closed before the receiver replied', Refused: false };
    },
  });
}

// --- Run --------------------------------------------------------------------

export interface ShureChannelResult extends ShureChannel {
  Monitored: boolean;
  Issues: string[];
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Success: false, Error: `Invalid port: ${Config.Port}` };
  }

  const Probe = await ProbeShure(Config);
  if (!Probe.Ok) {
    return { Success: false, ...(Probe.Refused ? { Degraded: true } : {}), Error: Probe.Error };
  }
  if (Probe.Snapshot.ReportCount === 0) {
    return {
      Success: true,
      Degraded: true,
      DegradedReason: 'Connected, but the device sent no Shure reports',
      LatencyMs: null,
    };
  }

  const Device = InterpretSnapshot(Probe.Snapshot);
  const Base: MonitoringResult = {
    Success: true,
    LatencyMs: Probe.LatencyMs,
    Model: Device.Model,
    Family: Device.Family,
    DeviceId: Device.DeviceId,
    Firmware: Device.Firmware,
    Partial: Probe.Partial,
  };
  if (!Device.Channels.length) {
    return {
      ...Base,
      Channels: [],
      Degraded: true,
      DegradedReason: 'Responded, but reported no wireless channels',
    };
  }

  const Options = ParseOptions(Target);
  const Eval = EvaluateShure(Device, Options);
  const MonitoredSet = new Set(Eval.Monitored);
  const Channels: ShureChannelResult[] = Device.Channels.map((Ch) => ({
    ...Ch,
    Monitored: MonitoredSet.has(Ch.Number),
    Issues: Eval.Issues[Ch.Number] ?? [],
  }));

  return {
    ...Base,
    Channels,
    MissingChannels: Eval.Missing,
    ...(Eval.Reasons.length ? { Degraded: true, DegradedReason: Eval.Reasons.join('; ') } : {}),
  };
}

// --- Debug ------------------------------------------------------------------

function FormatBattery(Ch: ShureChannelResult): string {
  const Parts: string[] = [];
  if (Ch.BatteryBars != null) Parts.push(`${Ch.BatteryBars}/5 bars`);
  if (Ch.BatteryPercent != null) Parts.push(`${Ch.BatteryPercent}%`);
  if (Ch.BatteryMinutes != null) {
    Parts.push(
      `${Math.floor(Ch.BatteryMinutes / 60)}:${String(Ch.BatteryMinutes % 60).padStart(2, '0')} left`
    );
  } else if (Ch.BatteryCalculating) Parts.push('runtime calculating…');
  else if (Ch.BatteryCommWarning) Parts.push('communication warning');
  if (Ch.BatteryType) Parts.push(Ch.BatteryType);
  return Parts.length ? Parts.join(' · ') : '—';
}

function ChannelBadge(Ch: ShureChannelResult): string {
  if (!Ch.Monitored) return Pill('muted', 'Not monitored');
  if (Ch.Issues.length) return Pill('warning', Ch.Issues[0] ?? 'Issue');
  if (Ch.TxPresent === false) return Pill('muted', 'No transmitter');
  return Pill('success', 'OK');
}

function ChannelCard(Ch: ShureChannelResult): string {
  const Mute: string[] = [];
  if (Ch.TxMuted != null) Mute.push(`TX ${Ch.TxMuted ? 'muted' : 'on'}`);
  if (Ch.RxMuted != null) Mute.push(`RX ${Ch.RxMuted ? 'muted' : 'on'}`);
  const Rf: string[] = [];
  if (Ch.RfLevelsDbm.length) Rf.push(Ch.RfLevelsDbm.map((V) => `${V} dBm`).join(' / '));
  if (Ch.Antenna) Rf.push(`antenna ${Ch.Antenna}`);
  if (Ch.SignalQuality != null) Rf.push(`quality ${Ch.SignalQuality}/5`);
  const Warnings: string[] = [];
  if (Ch.Interference) Warnings.push('interference');
  if (Ch.EncryptionError) Warnings.push('encryption mismatch');
  if (Ch.UnregisteredTx) Warnings.push('unregistered transmitter');

  const Body = Rows([
    TextRow('Frequency', Ch.FrequencyMHz != null ? `${Ch.FrequencyMHz.toFixed(3)} MHz` : '—'),
    TextRow(
      'Transmitter',
      Ch.TxPresent === false
        ? 'None'
        : [Ch.TxType, Ch.TxDeviceId].filter(Boolean).join(' · ') || (Ch.TxPresent ? 'Present' : '—')
    ),
    Ch.TxPresent !== false ? TextRow('Battery', FormatBattery(Ch)) : null,
    Rf.length ? TextRow('RF', Rf.join(' · ')) : null,
    Mute.length ? TextRow('Mute', Mute.join(' · ')) : null,
    Warnings.length ? TextRow('Warnings', Warnings.join(', ')) : null,
    Ch.Issues.length > 1 ? TextRow('Issues', Ch.Issues.join(', ')) : null,
  ]);
  return Card({
    Title: Ch.Name ? `Ch ${Ch.Number} · ${Ch.Name}` : `Ch ${Ch.Number}`,
    Badge: ChannelBadge(Ch),
    BodyHtml: `<div class="mt-1">${Body}</div>`,
  });
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseConfig(Target);
  const Online = !!(Result && Result.Success === true);
  const Degraded = !!(Result && Result.Degraded);
  const StatusPill = !Online
    ? Pill('danger', 'Offline')
    : Degraded
      ? Pill('warning', 'Degraded')
      : Pill('success', 'Healthy');
  const Str = (Value: unknown): string => (Value == null || Value === '' ? '' : String(Value));

  const Head = Rows([
    TextRow('Host', `${Config.Address || '—'}:${Config.Port}`),
    Row('Status', StatusPill),
    Online && Str(Result.Model || Result.Family)
      ? TextRow('Receiver', [Str(Result.Model), Str(Result.Family)].filter(Boolean).join(' · '))
      : null,
    Online && Str(Result.DeviceId) ? TextRow('Device ID', Str(Result.DeviceId)) : null,
    Online && Str(Result.Firmware) ? TextRow('Firmware', Str(Result.Firmware)) : null,
    Online && Result.LatencyMs != null
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : null,
    Online && Degraded && Result.DegradedReason
      ? TextRow('Reason', Str(Result.DegradedReason))
      : null,
    !Online
      ? TextRow('Error', Str(Result && Result.Error) || 'Failed to reach the receiver')
      : null,
  ]);

  if (!Online) return Head;
  const Channels = Array.isArray(Result.Channels) ? (Result.Channels as ShureChannelResult[]) : [];
  if (!Channels.length)
    return Head + '<div class="mt-2">' + Note('No channels reported') + '</div>';

  const Missing = Array.isArray(Result.MissingChannels) ? (Result.MissingChannels as number[]) : [];
  return (
    Head +
    (Result.Partial
      ? '<div class="mt-2">' +
        Note(
          'The receiver was still reporting when the timeout ended; readings may be incomplete.'
        ) +
        '</div>'
      : '') +
    `<div class="text-muted small mt-2 mb-1">Channels (${Channels.length})</div>` +
    `<div class="d-grid gap-1">${Channels.map(ChannelCard).join('')}</div>` +
    (Missing.length
      ? '<div class="mt-2">' +
        Note(`Not reported by this receiver: ${Missing.map((N) => `Ch ${N}`).join(', ')}`) +
        '</div>'
      : '')
  );
}

export const Name = 'Wireless Receiver (Shure)';
export const Description =
  'Reads every channel of a Shure ULX-D, QLX-D, SLX-D or Axient Digital receiver over its command-string port (TCP 2202) — transmitter presence, battery bars and runtime, mute and RF warnings — and reports Degraded when a monitored channel’s battery is low. Read-only: it sends a single GET request.';
export const Group = 'Sound';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  SplitMessages,
  Tokenise,
  ParseReport,
  ParseCapture,
  Unquote,
  ShureNumber,
  InterpretSnapshot,
  InterpretChannel,
  DetectFamily,
  ParseChannelList,
  ParseOptions,
  ParseConfig,
  ChannelIssues,
  EvaluateShure,
  ProbeShure,
  QUIET_MS,
};
export { ID, Settings, Run, Debug };
