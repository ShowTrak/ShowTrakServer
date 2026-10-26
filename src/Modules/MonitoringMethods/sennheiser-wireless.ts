// Sennheiser wireless receiver check over Sennheiser Sound Control (SSC v1).
//
// The point is mid-show safety: catch a dying body-pack battery or a lost
// transmitter before the actor goes on.
//
// Protocol: SSC v1 is JSON over UDP, one message per datagram, default port 45
// (Sennheiser SSC developer guides, "SSC Transport Layer Adaptations"). A read
// is the address tree with null leaves; the receiver answers with the same tree
// filled in, and MUST answer every message, with `{"osc":{"error":[...]}}` for
// an address it does not have:
//
//   TX: {"rx1":{"name":null,"carrier":null}}
//   RX: {"rx1":{"name":"LEAD VOX","carrier":578350}}
//
// Which receivers speak it:
//   - Digital 6000 (EM 6000, EM 6000 Dante): Sennheiser TI 1109 v2.2. Two
//     channels; the transmitter is /rxN/skx/* (battery is ["70%","5:12"], an
//     empty array when no transmitter), metering is /mm.
//   - EW-DX EM 2 / EM 2 Dante / EM 4 Dante on firmware < 4.0, or on 4.0+ with
//     SSC v1 ("Legacy Mode") enabled in Sennheiser WSM. Paths per Bitfocus
//     Companion's companion-module-sennheiser-ewdx: /rxN/{name,frequency,mute,
//     warnings}, /mates/txN/{type,mute,battery/{gauge,type,lifetime}},
//     /m/rxN/{rsqi,divi}.
// EW-DX firmware 4.0+ without legacy mode speaks only SSCv2 (HTTPS REST with a
// device password), which this method does not implement; see the report.
//
// The probe is two short phases over one UDP socket: read the device identity,
// then send only that family's queries (both families' when the product is
// unrecognised; every query is a null-argument read, so an unknown address
// costs nothing but an error reply). Replies are deep-merged into one state
// tree. A phase ends when every query has been answered, after QUIET_MS of
// silence, or when the Timeout budget runs out; unanswered queries are re-sent
// once, because UDP may drop them. No subscriptions are made, so the receiver
// keeps no state about this check.
//
// Assertions: battery is on by default; a required transmitter, mute and the
// receiver's own warnings are opt-in. Battery readings are only judged while a
// transmitter is linked: a switched-off spare is not a flat battery.
import dgram from 'dgram';
import dns from 'dns';
import { Card, FormatLatency, Note, Pill, Row, Rows, TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'sennheiser-wireless';

const DEFAULT_PORT = 45;
const DEFAULT_TIMEOUT_MS = 4000;
const QUIET_MS = 700;
const MAX_CHANNEL = 4;

const DEFAULTS = {
  LowBatteryPercent: 25,
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
    Note: 'SSC’s UDP port, 45 by default. If a Digital 6000 receiver does not answer on 45, try 6970.',
  },
  {
    Key: 'Channels',
    Label: 'Channels',
    Type: 'list',
    ItemType: 'number',
    Default: [],
    Note: 'Receiver channel numbers to monitor, e.g. 1 and 2. Leave empty to monitor every channel the receiver reports.',
  },
  {
    Key: 'CheckBattery',
    Label: 'Check transmitter battery',
    Type: 'boolean',
    Default: true,
    Note: 'Report Degraded when a monitored channel’s transmitter battery is low or at or below the thresholds. Skipped while no transmitter is linked.',
  },
  {
    Key: 'LowBatteryPercent',
    Label: 'Low battery at (%)',
    Type: 'number',
    Default: DEFAULTS.LowBatteryPercent,
    Min: 0,
    Max: 100,
    VisibleWhen: { Key: 'CheckBattery', Equals: true },
    Note: 'Degraded at or below this charge; 0 turns the percentage check off. Digital 6000 reports only 100/70/30% and “low”, and “low” always counts.',
  },
  {
    Key: 'LowBatteryMinutes',
    Label: 'Low battery at (minutes left)',
    Type: 'number',
    Default: DEFAULTS.LowBatteryMinutes,
    Min: 0,
    Max: 1440,
    VisibleWhen: { Key: 'CheckBattery', Equals: true },
    Note: 'Runtime is only reported for rechargeable packs. Degraded at or below this many minutes; 0 turns the runtime check off.',
  },
  {
    Key: 'RequireTransmitter',
    Label: 'Require transmitter',
    Type: 'boolean',
    Default: false,
    Note: 'Report Degraded when a monitored channel has no transmitter linked. Leave off for spare channels that legitimately have no pack on.',
  },
  {
    Key: 'CheckMute',
    Label: 'Check mute',
    Type: 'boolean',
    Default: false,
    Note: 'Report Degraded when a monitored channel’s receiver output is muted, or its transmitter reports mute (EW-DX only).',
  },
  {
    Key: 'CheckWarnings',
    Label: 'Check receiver warnings',
    Type: 'boolean',
    Default: false,
    Note: 'Report Degraded on the receiver’s own channel warnings, such as low RF signal, RF overload, encryption mismatch or clock errors. Audio peak warnings are ignored.',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: DEFAULT_TIMEOUT_MS,
    Min: 500,
    Max: 30000,
    Advanced: true,
    Note: 'Budget for the whole probe, including one re-send of any unanswered query.',
  },
];

// --- Config -----------------------------------------------------------------

interface SscConfig {
  Address: string;
  Port: number;
  TimeoutMs: number;
}

function ParseConfig(Target: MonitoringTargetLike): SscConfig {
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

// Same rules as the Shure check: array of strings/numbers, or a
// comma-separated string; invalid entries dropped; sorted and de-duplicated.
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
  LowBatteryPercent: number;
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
    LowBatteryPercent: Clamp(Cfg.LowBatteryPercent, 0, 100, DEFAULTS.LowBatteryPercent),
    LowBatteryMinutes: Clamp(Cfg.LowBatteryMinutes, 0, 1440, DEFAULTS.LowBatteryMinutes),
    RequireTransmitter: Cfg.RequireTransmitter === true,
    CheckMute: Cfg.CheckMute === true,
    CheckWarnings: Cfg.CheckWarnings === true,
  };
}

// --- Queries ----------------------------------------------------------------

type Json = Record<string, unknown>;

export type SscProfile = 'Digital 6000' | 'EW-DX';

const IDENTITY_QUERIES: Json[] = [
  { device: { identity: { product: null, version: null } } },
  { device: { name: null } },
];

function Digital6000Queries(): Json[] {
  const Out: Json[] = [];
  for (let N = 1; N <= 2; N++) {
    Out.push({
      [`rx${N}`]: { name: null, carrier: null, audio_mute: null, active_warnings: null },
    });
    Out.push({ [`rx${N}`]: { skx: { type: null, name: null, battery: null } } });
  }
  Out.push({ mm: null });
  return Out;
}

function EwdxQueries(): Json[] {
  const Out: Json[] = [];
  for (let N = 1; N <= MAX_CHANNEL; N++) {
    Out.push({ [`rx${N}`]: { name: null, frequency: null, mute: null, warnings: null } });
    Out.push({
      mates: {
        [`tx${N}`]: {
          type: null,
          name: null,
          mute: null,
          battery: { gauge: null, type: null, lifetime: null },
        },
      },
    });
    Out.push({ m: { [`rx${N}`]: { rsqi: null, divi: null } } });
  }
  return Out;
}

// Which family a product label belongs to (null when unrecognised).
function DetectProfile(Product: string | null): SscProfile | null {
  const P = (Product || '').toUpperCase().replace(/\s+/g, '');
  if (!P) return null;
  if (P.includes('EM6000') || P.includes('DIGITAL6000')) return 'Digital 6000';
  if (P.includes('EW-DX') || P.includes('EWDX') || /^EM[24](DANTE)?$/.test(P)) return 'EW-DX';
  return null;
}

function QueriesFor(Profile: SscProfile | null): Json[] {
  if (Profile === 'Digital 6000') return Digital6000Queries();
  if (Profile === 'EW-DX') return EwdxQueries();
  return [...Digital6000Queries(), ...EwdxQueries()];
}

// --- Reply handling ---------------------------------------------------------

function IsPlainObject(Value: unknown): Value is Json {
  return Value != null && typeof Value === 'object' && !Array.isArray(Value);
}

// Merge a reply into the accumulated state. The `osc` subtree (errors, xid) is
// protocol bookkeeping, not device state, and is dropped. Arrays and leaves
// replace; objects merge.
// SSC address trees are a handful of levels deep; anything deeper is not a
// receiver talking, and recursing into it would let one datagram blow the stack.
const MAX_MERGE_DEPTH = 16;

function MergeReply(State: Json, Reply: Json, Depth = 0): void {
  if (Depth >= MAX_MERGE_DEPTH) return;
  for (const [Key, Value] of Object.entries(Reply)) {
    if (Key === 'osc' || Key === '__proto__' || Key === 'constructor' || Key === 'prototype')
      continue;
    const Existing = State[Key];
    if (IsPlainObject(Value) && IsPlainObject(Existing)) MergeReply(Existing, Value, Depth + 1);
    else if (IsPlainObject(Value)) {
      if (Depth + 1 >= MAX_MERGE_DEPTH) continue;
      const Fresh: Json = {};
      MergeReply(Fresh, Value, Depth + 1);
      State[Key] = Fresh;
    } else State[Key] = Value;
  }
}

// Parse one datagram. Null when it is not a JSON object (i.e. not SSC).
function ParseDatagram(Data: Buffer | string): Json | null {
  try {
    const Parsed: unknown = JSON.parse(typeof Data === 'string' ? Data : Data.toString('utf8'));
    return IsPlainObject(Parsed) ? Parsed : null;
  } catch {
    return null;
  }
}

// --- Interpretation ---------------------------------------------------------

function Str(Value: unknown): string {
  return typeof Value === 'string' ? Value.trim() : '';
}

function Num(Value: unknown): number | null {
  return typeof Value === 'number' && Number.isFinite(Value) ? Value : null;
}

function Bool(Value: unknown): boolean | null {
  return typeof Value === 'boolean' ? Value : null;
}

function StringList(Value: unknown): string[] {
  return Array.isArray(Value)
    ? Value.filter((V): V is string => typeof V === 'string' && V.trim() !== '')
    : [];
}

function Path(State: Json, ...Keys: string[]): unknown {
  let Cur: unknown = State;
  for (const K of Keys) {
    if (!IsPlainObject(Cur)) return undefined;
    Cur = Cur[K];
  }
  return Cur;
}

// "5:12" -> 312; "-:--" or anything else -> null.
function ParseClockMinutes(Value: unknown): number | null {
  const Match = Str(Value).match(/^(\d{1,3}):(\d{2})$/);
  if (!Match) return null;
  return Number(Match[1]) * 60 + Number(Match[2]);
}

export interface SennheiserChannel {
  Number: number;
  Name: string;
  FrequencyMHz: number | null;
  // true = transmitter linked; false = the receiver says none; null = not reported.
  TxPresent: boolean | null;
  TxType: string | null;
  TxName: string | null;
  BatteryPercent: number | null;
  BatteryMinutes: number | null;
  BatteryLow: boolean;
  BatteryType: string | null;
  // Digital 6000's raw state string ("70%", "low"), for display.
  BatteryState: string | null;
  TxMuted: boolean | null;
  RxMuted: boolean | null;
  Warnings: string[];
  LinkQuality: number | null;
  RfLevelsDbm: number[];
  ActiveAntenna: string | null;
}

export interface SennheiserDevice {
  Product: string | null;
  Profile: SscProfile | null;
  Firmware: string | null;
  DeviceName: string | null;
  Channels: SennheiserChannel[];
}

// Digital 6000 /mm row: [RF1, RF1 peak, RF2, RF2 peak, DIV1, DIV2, LQI, AF, AF peak].
// RF dBm = (v − 255) / 2; LQI 0–255 (255 best). Sennheiser TI 1109 §8.100.
function ReadMeter(Row: unknown): {
  RfLevelsDbm: number[];
  LinkQuality: number | null;
  Antenna: string | null;
} {
  if (!Array.isArray(Row)) return { RfLevelsDbm: [], LinkQuality: null, Antenna: null };
  const At = (I: number): number | null => {
    const V = Num(Row[I]);
    return V != null && V >= 0 && V <= 255 ? V : null;
  };
  const Rf = [At(0), At(2)].filter((V): V is number => V != null).map((V) => (V - 255) / 2);
  const Lqi = At(6);
  const Div = [At(4) === 1 ? 'A' : '', At(5) === 1 ? 'B' : ''].join('');
  return {
    RfLevelsDbm: Rf,
    LinkQuality: Lqi != null ? Math.round((Lqi / 255) * 100) : null,
    Antenna: Div || null,
  };
}

function InterpretDigital6000(N: number, Rx: Json, Meter: unknown): SennheiserChannel {
  const Skx = IsPlainObject(Rx.skx) ? Rx.skx : null;
  const TypeValue = Skx ? Skx.type : undefined;
  const TxType = Array.isArray(TypeValue) ? Str(TypeValue[0]) : Str(TypeValue);
  const TxName = Skx ? Str(Skx.name) : '';
  const Battery = Skx && Array.isArray(Skx.battery) ? Skx.battery : null;
  const BatteryState = Battery ? Str(Battery[0]) : '';
  const PercentMatch = BatteryState.match(/^(\d{1,3})\s*%$/);
  const Warnings = StringList(Rx.active_warnings);
  const Mm = ReadMeter(Meter);

  // NoLink is the receiver's own "no transmitter"; otherwise an empty skx
  // (name "", battery []) means none is linked (TI 1109 §8.21, §8.27).
  let TxPresent: boolean | null = null;
  if (Warnings.includes('NoLink')) TxPresent = false;
  else if (TxType || TxName || (Battery && Battery.length)) TxPresent = true;
  else if (Skx && ('name' in Skx || 'battery' in Skx || 'type' in Skx)) TxPresent = false;

  const Carrier = Num(Rx.carrier);
  return {
    Number: N,
    Name: Str(Rx.name),
    FrequencyMHz: Carrier != null && Carrier > 0 ? Carrier / 1000 : null,
    TxPresent,
    TxType: TxType || null,
    TxName: TxName || null,
    BatteryPercent: PercentMatch ? Math.min(100, Number(PercentMatch[1])) : null,
    BatteryMinutes: Battery ? ParseClockMinutes(Battery[1]) : null,
    BatteryLow: /^low$/i.test(BatteryState) || Warnings.includes('LowBattery'),
    BatteryType: null,
    BatteryState: BatteryState || null,
    TxMuted: null,
    RxMuted: Bool(Rx.audio_mute),
    Warnings,
    LinkQuality: Mm.LinkQuality,
    RfLevelsDbm: Mm.RfLevelsDbm,
    ActiveAntenna: Mm.Antenna,
  };
}

function InterpretEwdx(
  N: number,
  Rx: Json,
  Mate: Json | null,
  Meter: Json | null
): SennheiserChannel {
  const Warnings = StringList(Rx.warnings);
  const Rsqi = Meter ? Num(Meter.rsqi) : null;
  const Divi = Meter ? Num(Meter.divi) : null;
  const MateType = Mate ? Str(Mate.type) : '';
  const KnownType = MateType && !/^(unknown|none|nan)$/i.test(MateType) ? MateType : '';

  // RSQI 0 is "no link" (the Companion module clears the mate on it); the mate
  // values a receiver keeps after the pack is switched off are stale, so the
  // link decides and the mate type is only a fallback when RSQI is missing.
  let TxPresent: boolean | null = null;
  if (Warnings.includes('NoLink')) TxPresent = false;
  else if (Rsqi != null) TxPresent = Rsqi > 0;
  else if (KnownType) TxPresent = true;

  const BatteryNode = Mate && IsPlainObject(Mate.battery) ? Mate.battery : null;
  const Gauge = BatteryNode ? Num(BatteryNode.gauge) : null;
  const BatteryType = BatteryNode ? Str(BatteryNode.type) : '';
  const Lifetime = BatteryNode ? Num(BatteryNode.lifetime) : null;
  // Runtime is only meaningful for the BA 70 rechargeable pack, which EW-DX
  // reports as battery type "Battery"; for AA cells only the gauge is used.
  const IsPack = /^(battery|ba\s*70|accu)/i.test(BatteryType);

  const Frequency = Num(Rx.frequency);
  return {
    Number: N,
    Name: Str(Rx.name),
    FrequencyMHz: Frequency != null && Frequency > 0 ? Frequency / 1000 : null,
    TxPresent,
    TxType: KnownType || null,
    TxName: (Mate && Str(Mate.name)) || null,
    BatteryPercent: Gauge != null && Gauge >= 0 && Gauge <= 100 ? Gauge : null,
    BatteryMinutes: IsPack && Lifetime != null && Lifetime >= 0 ? Math.round(Lifetime) : null,
    BatteryLow: Warnings.some((W) => /low\s*_?batt/i.test(W)),
    BatteryType: BatteryType || null,
    BatteryState: null,
    TxMuted: Mate ? Bool(Mate.mute) : null,
    RxMuted: Bool(Rx.mute),
    Warnings,
    LinkQuality: Rsqi != null && Rsqi >= 0 && Rsqi <= 100 ? Rsqi : null,
    RfLevelsDbm: [],
    ActiveAntenna: Divi === 1 ? 'A' : Divi === 2 ? 'B' : null,
  };
}

// Turn the merged reply tree into channels. Pure.
function InterpretState(State: Json): SennheiserDevice {
  const Product = Str(Path(State, 'device', 'identity', 'product')) || null;
  let Profile = DetectProfile(Product);
  if (!Profile) {
    // Unrecognised or missing product: infer from the shape of what answered.
    const HasD6000 = [1, 2].some((N) => {
      const Rx = State[`rx${N}`];
      return IsPlainObject(Rx) && ('carrier' in Rx || 'skx' in Rx || 'audio_mute' in Rx);
    });
    if (HasD6000 || 'mm' in State) Profile = 'Digital 6000';
    else if ('mates' in State || 'm' in State) Profile = 'EW-DX';
  }

  const Channels: SennheiserChannel[] = [];
  const Max = Profile === 'Digital 6000' ? 2 : MAX_CHANNEL;
  for (let N = 1; N <= Max; N++) {
    const Rx = State[`rx${N}`];
    if (!IsPlainObject(Rx) || !Object.keys(Rx).length) continue;
    if (Profile === 'Digital 6000') {
      const Mm = Array.isArray(State.mm) ? State.mm[N - 1] : undefined;
      Channels.push(InterpretDigital6000(N, Rx, Mm));
    } else {
      const Mate = Path(State, 'mates', `tx${N}`);
      const Meter = Path(State, 'm', `rx${N}`);
      Channels.push(
        InterpretEwdx(N, Rx, IsPlainObject(Mate) ? Mate : null, IsPlainObject(Meter) ? Meter : null)
      );
    }
  }

  return {
    Product,
    Profile,
    Firmware: Str(Path(State, 'device', 'identity', 'version')) || null,
    DeviceName: Str(Path(State, 'device', 'name')) || null,
    Channels,
  };
}

// --- Evaluation -------------------------------------------------------------

function ChannelLabel(N: number, Name: string): string {
  return Name ? `Ch ${N} (${Name})` : `Ch ${N}`;
}

// Receiver warnings handled elsewhere (battery, link) or too transient to alert
// on (an audio peak flaps with every loud line).
const WARNINGS_HANDLED_ELSEWHERE = new Set(['NoLink', 'LowBattery', 'AFPeak', 'AfPeak']);

const WARNING_LABELS: Record<string, string> = {
  RFPeak: 'RF overload',
  LowSignal: 'low RF signal',
  Aes256Error: 'encryption mismatch',
  BadClock: 'clock error',
  NoClock: 'clock error',
  AnTxYBNCShorted: 'antenna BNC short',
};

function WarningLabel(Warning: string): string {
  return WARNING_LABELS[Warning] ?? Warning;
}

function BatteryIssue(Ch: SennheiserChannel, Options: EvaluateOptions): string | null {
  const Parts: string[] = [];
  const PercentLow =
    Options.LowBatteryPercent > 0 &&
    Ch.BatteryPercent != null &&
    Ch.BatteryPercent <= Options.LowBatteryPercent;
  if (PercentLow) Parts.push(`${Ch.BatteryPercent}%`);
  else if (Ch.BatteryLow) Parts.push('low');
  if (
    Options.LowBatteryMinutes > 0 &&
    Ch.BatteryMinutes != null &&
    Ch.BatteryMinutes <= Options.LowBatteryMinutes
  ) {
    Parts.push(`${Ch.BatteryMinutes} min left`);
  }
  return Parts.length ? `battery ${Parts.join(', ')}` : null;
}

function ChannelIssues(Ch: SennheiserChannel, Options: EvaluateOptions): string[] {
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
    const Labels = new Set(
      Ch.Warnings.filter((W) => !WARNINGS_HANDLED_ELSEWHERE.has(W)).map(WarningLabel)
    );
    Issues.push(...Labels);
  }
  return Issues;
}

export interface Evaluation {
  Reasons: string[];
  Monitored: number[];
  Missing: number[];
  Issues: Record<number, string[]>;
}

// Same contract as the Shure check's EvaluateShure. Pure.
function EvaluateSennheiser(Device: SennheiserDevice, Options: EvaluateOptions): Evaluation {
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
      State: Json;
      JsonReplies: number;
      OtherReplies: number;
      LatencyMs: number | null;
      Partial: boolean;
    }
  | { Ok: false; Error: string; Refused: boolean };

async function ResolveAddress(Address: string): Promise<{ Address: string; Family: 4 | 6 }> {
  const Found = await dns.promises.lookup(Address);
  return { Address: Found.address, Family: Found.family === 6 ? 6 : 4 };
}

function ProbeSsc(Config: SscConfig): Promise<ProbeOutcome> {
  return new Promise<ProbeOutcome>((Resolve) => {
    const StartedAt = Date.now();
    const DeadlineAt = StartedAt + Config.TimeoutMs;
    const State: Json = {};
    let JsonReplies = 0;
    let OtherReplies = 0;
    let FirstReplyAt: number | null = null;
    let Settled = false;
    let Socket: dgram.Socket | null = null;
    const Timers = new Set<ReturnType<typeof setTimeout>>();
    // Wakes the phase currently waiting for replies.
    let OnReply: (() => void) | null = null;

    const Later = (Fn: () => void, Ms: number): void => {
      const T = setTimeout(
        () => {
          Timers.delete(T);
          Fn();
        },
        Math.max(0, Ms)
      );
      Timers.add(T);
    };
    const Finish = (Outcome: ProbeOutcome): void => {
      if (Settled) return;
      Settled = true;
      for (const T of Timers) clearTimeout(T);
      Timers.clear();
      OnReply = null;
      try {
        Socket?.close();
      } catch {
        // already closed
      }
      Resolve(Outcome);
    };
    const Total = (): number => JsonReplies + OtherReplies;

    const Send = (Messages: Json[]): void => {
      for (const Message of Messages) {
        try {
          Socket?.send(JSON.stringify(Message));
        } catch {
          // A send that throws (socket closing) is answered by the deadline.
        }
      }
    };

    // Send a batch and wait until it is fully answered, quiet after at least one
    // answer, or the deadline. Unanswered queries are re-sent once, halfway.
    const Exchange = (Messages: Json[]): Promise<{ Answered: number }> =>
      new Promise((Done) => {
        const Before = Total();
        let Finished = false;
        let QuietTimer: ReturnType<typeof setTimeout> | null = null;
        const End = (): void => {
          if (Finished) return;
          Finished = true;
          if (QuietTimer) {
            clearTimeout(QuietTimer);
            Timers.delete(QuietTimer);
          }
          OnReply = null;
          Done({ Answered: Total() - Before });
        };
        OnReply = () => {
          const Answered = Total() - Before;
          if (Answered >= Messages.length) return End();
          if (QuietTimer) {
            clearTimeout(QuietTimer);
            Timers.delete(QuietTimer);
          }
          QuietTimer = setTimeout(() => {
            if (QuietTimer) Timers.delete(QuietTimer);
            End();
          }, QUIET_MS);
          Timers.add(QuietTimer);
        };
        const Remaining = DeadlineAt - Date.now();
        Later(() => {
          if (!Finished && Total() - Before < Messages.length) Send(Messages);
        }, Remaining / 2);
        Later(End, Remaining);
        Send(Messages);
      });

    const Outcome = (Partial: boolean): ProbeOutcome =>
      Total() > 0
        ? {
            Ok: true,
            State,
            JsonReplies,
            OtherReplies,
            LatencyMs: FirstReplyAt != null ? FirstReplyAt - StartedAt : null,
            Partial,
          }
        : { Ok: false, Error: `No SSC reply after ${Config.TimeoutMs}ms`, Refused: false };

    const Run = async (): Promise<void> => {
      // The whole probe's budget, whatever phase it is in, name resolution
      // included, so a slow resolver cannot stretch the probe past Timeout.
      let Resolving = true;
      Later(
        () =>
          Finish(
            Resolving
              ? {
                  Ok: false,
                  Error: `Failed to resolve ${Config.Address}: timed out after ${Config.TimeoutMs}ms`,
                  Refused: false,
                }
              : Outcome(true)
          ),
        DeadlineAt - Date.now() + 50
      );

      let Target: { Address: string; Family: 4 | 6 };
      try {
        Target = await ResolveAddress(Config.Address);
      } catch (Err) {
        return Finish({
          Ok: false,
          Error: `Failed to resolve ${Config.Address}: ${Err instanceof Error ? Err.message : String(Err)}`,
          Refused: false,
        });
      }
      Resolving = false;
      if (Settled) return;

      const Sock = dgram.createSocket(Target.Family === 6 ? 'udp6' : 'udp4');
      Socket = Sock;
      Sock.on('error', (Err: Error) => {
        const Message = Err && Err.message ? Err.message : String(Err);
        // A connected UDP socket surfaces ICMP port-unreachable as ECONNREFUSED:
        // the host answered but nothing listens on the SSC port.
        if (Total() > 0) return; // late error after real replies: keep the data
        Finish({ Ok: false, Error: Message, Refused: Message.includes('ECONNREFUSED') });
      });
      Sock.on('message', (Data: Buffer) => {
        if (Settled) return;
        // Device-supplied input: whatever it does to the parser must end this
        // probe with a result, never escape as an uncaught exception.
        try {
          if (FirstReplyAt == null) FirstReplyAt = Date.now();
          const Reply = ParseDatagram(Data);
          if (Reply) {
            JsonReplies++;
            MergeReply(State, Reply);
          } else OtherReplies++;
          OnReply?.();
        } catch (Err) {
          Finish({
            Ok: false,
            Error: `Failed to process an SSC reply: ${Err instanceof Error ? Err.message : String(Err)}`,
            Refused: false,
          });
        }
      });

      await new Promise<void>((Ready) => {
        try {
          Sock.connect(Config.Port, Target.Address, () => Ready());
        } catch (Err) {
          Finish({
            Ok: false,
            Error: Err instanceof Error ? Err.message : String(Err),
            Refused: false,
          });
          Ready();
        }
      });
      if (Settled) return;

      const Identity = await Exchange(IDENTITY_QUERIES);
      if (Settled) return;
      if (Identity.Answered === 0) {
        return Finish({
          Ok: false,
          Error: `No SSC reply after ${Config.TimeoutMs}ms`,
          Refused: false,
        });
      }
      if (JsonReplies === 0) return Finish(Outcome(false));

      const Product = Str(Path(State, 'device', 'identity', 'product')) || null;
      const Queries = QueriesFor(DetectProfile(Product));
      const Channels = await Exchange(Queries);
      if (Settled) return;
      Finish(Outcome(Channels.Answered < Queries.length));
    };

    void Run().catch((Err: unknown) =>
      Finish({ Ok: false, Error: Err instanceof Error ? Err.message : String(Err), Refused: false })
    );
  });
}

// --- Run --------------------------------------------------------------------

export interface SennheiserChannelResult extends SennheiserChannel {
  Monitored: boolean;
  Issues: string[];
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Success: false, Error: `Invalid port: ${Config.Port}` };
  }

  const Probe = await ProbeSsc(Config);
  if (!Probe.Ok) {
    return { Success: false, ...(Probe.Refused ? { Degraded: true } : {}), Error: Probe.Error };
  }
  if (Probe.JsonReplies === 0) {
    return {
      Success: true,
      Degraded: true,
      DegradedReason: 'Responded, but not with Sennheiser SSC (JSON)',
      LatencyMs: Probe.LatencyMs,
    };
  }

  const Device = InterpretState(Probe.State);
  const Base: MonitoringResult = {
    Success: true,
    LatencyMs: Probe.LatencyMs,
    Model: Device.Product,
    Family: Device.Profile,
    DeviceId: Device.DeviceName,
    Firmware: Device.Firmware,
    Partial: Probe.Partial,
  };
  if (!Device.Channels.length) {
    return {
      ...Base,
      Channels: [],
      Degraded: true,
      DegradedReason: 'Responded, but reported no receiver channels',
    };
  }

  const Eval = EvaluateSennheiser(Device, ParseOptions(Target));
  const MonitoredSet = new Set(Eval.Monitored);
  const Channels: SennheiserChannelResult[] = Device.Channels.map((Ch) => ({
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

function FormatBattery(Ch: SennheiserChannelResult): string {
  const Parts: string[] = [];
  if (Ch.BatteryPercent != null) Parts.push(`${Ch.BatteryPercent}%`);
  else if (Ch.BatteryState) Parts.push(Ch.BatteryState);
  if (Ch.BatteryMinutes != null) {
    Parts.push(
      `${Math.floor(Ch.BatteryMinutes / 60)}:${String(Ch.BatteryMinutes % 60).padStart(2, '0')} left`
    );
  }
  if (Ch.BatteryLow && !Parts.includes('low')) Parts.push('low');
  if (Ch.BatteryType) Parts.push(Ch.BatteryType);
  return Parts.length ? Parts.join(' · ') : '-';
}

function ChannelBadge(Ch: SennheiserChannelResult): string {
  if (!Ch.Monitored) return Pill('muted', 'Not monitored');
  if (Ch.Issues.length) return Pill('warning', Ch.Issues[0] ?? 'Issue');
  if (Ch.TxPresent === false) return Pill('muted', 'No transmitter');
  return Pill('success', 'OK');
}

function ChannelCard(Ch: SennheiserChannelResult): string {
  const Mute: string[] = [];
  if (Ch.TxMuted != null) Mute.push(`TX ${Ch.TxMuted ? 'muted' : 'on'}`);
  if (Ch.RxMuted != null) Mute.push(`RX ${Ch.RxMuted ? 'muted' : 'on'}`);
  const Rf: string[] = [];
  if (Ch.RfLevelsDbm.length) Rf.push(Ch.RfLevelsDbm.map((V) => `${V} dBm`).join(' / '));
  if (Ch.LinkQuality != null) Rf.push(`link ${Ch.LinkQuality}%`);
  if (Ch.ActiveAntenna) Rf.push(`antenna ${Ch.ActiveAntenna}`);

  const Body = Rows([
    TextRow('Frequency', Ch.FrequencyMHz != null ? `${Ch.FrequencyMHz.toFixed(3)} MHz` : '-'),
    TextRow(
      'Transmitter',
      Ch.TxPresent === false
        ? 'None'
        : [Ch.TxType, Ch.TxName].filter(Boolean).join(' · ') || (Ch.TxPresent ? 'Linked' : '-')
    ),
    Ch.TxPresent !== false ? TextRow('Battery', FormatBattery(Ch)) : null,
    Rf.length ? TextRow('RF', Rf.join(' · ')) : null,
    Mute.length ? TextRow('Mute', Mute.join(' · ')) : null,
    Ch.Warnings.length ? TextRow('Warnings', Ch.Warnings.join(', ')) : null,
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
  const Text = (Value: unknown): string => (Value == null || Value === '' ? '' : String(Value));

  const Head = Rows([
    TextRow('Host', `${Config.Address || '-'}:${Config.Port} (UDP)`),
    Row('Status', StatusPill),
    Online && Text(Result.Model || Result.Family)
      ? TextRow('Receiver', [Text(Result.Model), Text(Result.Family)].filter(Boolean).join(' · '))
      : null,
    Online && Text(Result.DeviceId) ? TextRow('Device name', Text(Result.DeviceId)) : null,
    Online && Text(Result.Firmware) ? TextRow('Firmware', Text(Result.Firmware)) : null,
    Online && Result.LatencyMs != null
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : null,
    Online && Degraded && Result.DegradedReason
      ? TextRow('Reason', Text(Result.DegradedReason))
      : null,
    !Online
      ? TextRow('Error', Text(Result && Result.Error) || 'Failed to reach the receiver')
      : null,
  ]);

  if (!Online) return Head;
  const Channels = Array.isArray(Result.Channels)
    ? (Result.Channels as SennheiserChannelResult[])
    : [];
  if (!Channels.length)
    return Head + '<div class="mt-2">' + Note('No channels reported') + '</div>';

  const Missing = Array.isArray(Result.MissingChannels) ? (Result.MissingChannels as number[]) : [];
  return (
    Head +
    (Result.Partial
      ? '<div class="mt-2">' +
        Note('Some queries were not answered before the timeout; readings may be incomplete.') +
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

export const Name = 'Wireless Receiver (Sennheiser)';
export const Description =
  'Reads every channel of a Sennheiser Digital 6000 or EW-DX receiver over Sennheiser Sound Control (SSC, UDP 45), covering transmitter link, battery level and runtime, mute and receiver warnings, and reports Degraded when a monitored channel’s battery is low. Read-only: it sends only queries.';
export const Group = 'Sound';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseConfig,
  ParseOptions,
  ParseChannelList,
  DetectProfile,
  QueriesFor,
  MergeReply,
  ParseDatagram,
  ParseClockMinutes,
  ReadMeter,
  InterpretState,
  ChannelIssues,
  EvaluateSennheiser,
  ProbeSsc,
  QUIET_MS,
  MAX_MERGE_DEPTH,
};
export { ID, Settings, Run, Debug };
