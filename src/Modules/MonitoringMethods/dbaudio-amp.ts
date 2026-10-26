// d&b audiotechnik amplifier health over AES70 / OCP.1 (see ./_aes70-shared).
// One short-lived session per probe, every command a read (only RunAction,
// below, ever sends a Set):
//
//   1. Device Manager (ONo 1, the fixed AES70 manager): GetModelDescription
//      (3.6: manufacturer, model, firmware), GetDeviceName (3.4),
//      GetSerialNumber (3.3) and GetState (3.13, the OcaDeviceState bitset).
//   2. The amplifier's own objects, addressed by fixed object numbers:
//        Settings_PwrOn     OcaSwitch         GetPosition 4.1   0 = standby, >0 = on
//        Config_Mute (n)    OcaMute           GetState    4.1   1 = muted, 2 = unmuted
//        ChStatus_Isp (n)   OcaBooleanSensor  GetReading  5.1   input signal present
//        ChStatus_Gr (n)    OcaBooleanSensor  GetReading  5.1   gain reduction (limiter)
//        ChStatus_Ovl (n)   OcaBooleanSensor  GetReading  5.1   overload
//
// d&b does not publish its amplifier object tree. The object names, numbers
// and value meanings come from two public open-source clients:
//   - ChristianAhrens/NanoOcp (LGPL-3.0) Source/Ocp1ObjectDefinitions.h and
//     AmpController.cpp: the ONo layout and the numbers above, per family:
//       D20 / D80 / 10D / 30D ("Dx") and D40 / 40D ("Dy"): PwrOn 0x100,
//         Isp 0x400, Gr 0x401, Ovl 0x402;
//       5D: PwrOn 0x101, Isp 0x401, Gr 0x402, Ovl 0x403;
//       all: Config_Mute 0x205.
//     ONo = type(1) << 28 | record(0) << 20 | channel << 15 | boxAndObject,
//     channel 1–4.
//   - bitfocus/companion-module-dbaudiotechnik-amps (MIT) main.js: the OCP.1
//     ports: 30013 for D20, D80, 10D and 30D; 50014 for D40, 40D and 5D.
// Inferred, not documented anywhere: that channel 1–4 are the A–D an operator
// sees; that the family can be told from the model name ("5D" or not). The
// two clients disagree on the 5D power reading (NanoOcp: >0 = on; the
// Companion module inverts it for the 5D only, while its own Set uses 1 = on
// for every model), so >0 = on is used throughout.
//
// Temperatures, mains voltage and protection/fault codes are NOT read: no
// public source names the objects that carry them.
//
// Actions write the same objects the check reads, with the setters both
// clients use (method IDs cross-checked against DeutscheSoft AES70.js
// src/controller/ControlClasses):
//   Settings_PwrOn  OcaSwitch.SetPosition 4.2 (u16)  1 = on, 0 = standby
//                   (NanoOcp AmpController::setPower; Companion power_action)
//   Config_Mute     OcaMute.SetState      4.2 (u8)   1 = muted, 2 = unmuted
//                   (NanoOcp AmpController::setChannelMute; Companion
//                   mute_action / unmute_action)
import {
  DeviceStateFlags,
  ONO_DEVICE_MANAGER,
  ReadBoolean,
  ReadModelDescription,
  ReadOcaString,
  ReadUint16,
  ReadUint8,
  RunOcp1Session,
  type GetReply,
  type Ocp1Call,
  type Ocp1Probe,
} from './_aes70-shared';
import { Card, Esc, FormatLatency, Note, Pill, Row, Rows, TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type {
  MonitoringActionDef,
  MonitoringActionResult,
  MonitoringResult,
  MonitoringSettingField,
  MonitoringTargetLike,
} from './types';

const ID = 'dbaudio-amp';
const DEFAULT_TIMEOUT_MS = 4000;
const PORT_DX = 30013;
const PORT_DY = 50014;
const CHANNEL_LETTERS = ['A', 'B', 'C', 'D'];

type Family = 'dxdy' | '5d';
type ModelSetting = 'auto' | 'dx' | 'dy' | '5d';

interface FamilyObjects {
  PwrOn: number;
  Isp: number;
  Gr: number;
  Ovl: number;
}

const OBJECTS: Record<Family, FamilyObjects> = {
  dxdy: { PwrOn: 0x100, Isp: 0x400, Gr: 0x401, Ovl: 0x402 },
  '5d': { PwrOn: 0x101, Isp: 0x401, Gr: 0x402, Ovl: 0x403 },
};
const CONFIG_MUTE = 0x205;

// AES70 method IDs (DefLevel, MethodIndex), per AES70.js ControlClasses.
const DM_GET_SERIAL = [3, 3] as const;
const DM_GET_NAME = [3, 4] as const;
const DM_GET_MODEL = [3, 6] as const;
const DM_GET_STATE = [3, 13] as const;
const SWITCH_GET_POSITION = [4, 1] as const;
const SWITCH_SET_POSITION = [4, 2] as const;
const MUTE_GET_STATE = [4, 1] as const;
const MUTE_SET_STATE = [4, 2] as const;
const BOOLEAN_SENSOR_GET_READING = [5, 1] as const;
// OcaMuteState.
const MUTE_STATE_MUTED = 1;
const MUTE_STATE_UNMUTED = 2;

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Model',
    Label: 'Amplifier model',
    Type: 'select',
    Default: 'auto',
    Options: [
      { value: 'auto', label: 'Detect automatically' },
      { value: 'dx', label: 'D20, D80, 10D or 30D' },
      { value: 'dy', label: 'D40 or 40D' },
      { value: '5d', label: '5D' },
    ],
    Note: 'Picks the network port and the amplifier’s object layout. Detect tries port 30013, then 50014, and reads the model from the amplifier.',
  },
  {
    Key: 'Port',
    Label: 'OCP.1 port',
    Type: 'number',
    Default: 0,
    Min: 0,
    Max: 65535,
    Advanced: true,
    Note: 'Leave at 0 to use the model’s usual port: 30013 for D20, D80, 10D and 30D, 50014 for D40, 40D and 5D.',
  },
  {
    Key: 'RequirePowerOn',
    Label: 'Require power on',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded while the amplifier is in standby.',
  },
  {
    Key: 'CheckDeviceState',
    Label: 'Check device state',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded when the amplifier reports an error, or that it is disabled, starting up or updating firmware.',
  },
  {
    Key: 'CheckOverload',
    Label: 'Check for overload',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded when a channel shows its overload (OVL) indicator. The indicator is momentary, so this only catches overloads that are happening as the check runs.',
  },
  {
    Key: 'CheckMute',
    Label: 'Check for muted channels',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when a channel is muted.',
  },
  {
    Key: 'CheckGainReduction',
    Label: 'Check for limiting',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when a channel’s limiter is reducing gain (GR indicator).',
  },
  {
    Key: 'RequireSignal',
    Label: 'Require input signal',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when a channel has no input signal (ISP indicator off). Not checked while the amplifier is in standby.',
  },
  {
    Key: 'Channels',
    Label: 'Channels to check',
    Type: 'list',
    ItemType: 'string',
    Default: ['A', 'B', 'C', 'D'],
    Note: 'The channels the overload, mute, limiting and signal checks look at, as letters A to D. Leave empty to check all four.',
  },
  {
    Key: 'CheckName',
    Label: 'Check device name',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when the amplifier’s name is not the expected one, which catches a swapped or re-addressed amplifier.',
  },
  {
    Key: 'ExpectedName',
    Label: 'Expected device name',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'CheckName', Equals: true },
    Note: 'The name set in d&b R1. Matched without regard to case.',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: DEFAULT_TIMEOUT_MS,
    Min: 500,
    Max: 30000,
    Advanced: true,
    Note: 'Budget for the whole check, including trying the second port when the model is detected.',
  },
];

// --- Options -----------------------------------------------------------------

interface AmpConfig {
  Address: string;
  Model: ModelSetting;
  // 0 = the model's usual port (both, in order, for auto).
  Port: number;
  TimeoutMs: number;
}

interface HealthOptions {
  RequirePowerOn: boolean;
  CheckDeviceState: boolean;
  CheckOverload: boolean;
  CheckMute: boolean;
  CheckGainReduction: boolean;
  RequireSignal: boolean;
  // Channel numbers 1–4.
  Channels: number[];
  CheckName: boolean;
  ExpectedName: string;
}

const MODELS: ModelSetting[] = ['auto', 'dx', 'dy', '5d'];

function ParseConfig(Target: MonitoringTargetLike): AmpConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number(Cfg.Port);
  const Timeout = Number(Cfg.Timeout);
  const Model = String(Cfg.Model == null ? 'auto' : Cfg.Model).toLowerCase() as ModelSetting;
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Model: MODELS.includes(Model) ? Model : 'auto',
    Port: Number.isFinite(Port) && Port > 0 ? Port | 0 : 0,
    TimeoutMs: Number.isFinite(Timeout) && Timeout > 0 ? Timeout : DEFAULT_TIMEOUT_MS,
  };
}

function ParseChannels(Input: unknown): number[] {
  const List = Array.isArray(Input) ? Input : [];
  const Found = new Set<number>();
  for (const Raw of List) {
    const Letter = String(Raw == null ? '' : Raw)
      .trim()
      .toUpperCase();
    const Index = CHANNEL_LETTERS.indexOf(Letter);
    if (Index >= 0) Found.add(Index + 1);
  }
  return Found.size ? Array.from(Found).sort((A, B) => A - B) : [1, 2, 3, 4];
}

function ParseHealthOptions(Target: MonitoringTargetLike): HealthOptions {
  const Cfg = (Target && Target.Settings) || {};
  return {
    // Default ON: absent means enabled, so only an explicit false turns it off.
    RequirePowerOn: Cfg.RequirePowerOn !== false,
    CheckDeviceState: Cfg.CheckDeviceState !== false,
    CheckOverload: Cfg.CheckOverload !== false,
    CheckMute: Cfg.CheckMute === true,
    CheckGainReduction: Cfg.CheckGainReduction === true,
    RequireSignal: Cfg.RequireSignal === true,
    Channels: ParseChannels(Cfg.Channels),
    CheckName: Cfg.CheckName === true,
    ExpectedName: String(Cfg.ExpectedName == null ? '' : Cfg.ExpectedName).trim(),
  };
}

// The ports to try, in order, for this configuration.
function PortsFor(Config: AmpConfig): number[] {
  if (Config.Port) return [Config.Port];
  if (Config.Model === 'dx') return [PORT_DX];
  if (Config.Model === 'dy' || Config.Model === '5d') return [PORT_DY];
  return [PORT_DX, PORT_DY];
}

// --- Pure protocol helpers ---------------------------------------------------

export function AmpONo(Channel: number, BoxAndObject: number): number {
  return ((1 << 28) | ((Channel & 0x1f) << 15) | (BoxAndObject & 0x7fff)) >>> 0;
}

// The 5D has its own object layout; every other model shares one. Only a
// "5D" token in the model name selects it (inferred: the name format is not
// documented, so "5D" anywhere as a word is accepted).
function DetectFamily(ModelName: string | null): Family {
  return ModelName && /(^|[^0-9a-z])5d($|[^0-9a-z])/i.test(ModelName) ? '5d' : 'dxdy';
}

function FamilyFor(Model: ModelSetting, ModelName: string | null): Family {
  if (Model === '5d') return '5d';
  if (Model === 'dx' || Model === 'dy') return 'dxdy';
  return DetectFamily(ModelName);
}

// A read value, or the reason it is missing.
export interface Reading<T> {
  Value: T | null;
  Error?: string;
}

// The amplifier's refusal in plain words.
const NOT_FOUND = 'object not found on this amplifier';
function ReplyError(Error: string): string {
  return Error === 'BadONo' ? NOT_FOUND : Error;
}

// A missing power object is what the wrong object layout produces (a 5D read
// as a D80, or the reverse), so that one points at the model setting.
function PowerError(Error: string): string {
  return Error === NOT_FOUND ? `${NOT_FOUND}; check the amplifier model setting` : Error;
}

function FromReply<T>(Reply: GetReply, Parse: (Params: Buffer) => T | null): Reading<T> {
  if (!Reply.Ok) return { Value: null, Error: ReplyError(Reply.Error) };
  const Value = Parse(Reply.Params);
  return Value == null ? { Value: null, Error: 'Unreadable reply' } : { Value };
}

export interface ChannelReading {
  Channel: string;
  Muted: Reading<boolean>;
  SignalPresent: Reading<boolean>;
  GainReduction: Reading<boolean>;
  Overload: Reading<boolean>;
}

export interface AmpSnapshot {
  Manufacturer: string | null;
  Model: string | null;
  FirmwareVersion: string | null;
  DeviceName: string | null;
  SerialNumber: string | null;
  // OcaDeviceState bitset; null when the amplifier does not implement it.
  DeviceState: number | null;
  Family: Family | null;
  Power: Reading<boolean>;
  Channels: ChannelReading[];
}

function EmptySnapshot(): AmpSnapshot {
  return {
    Manufacturer: null,
    Model: null,
    FirmwareVersion: null,
    DeviceName: null,
    SerialNumber: null,
    DeviceState: null,
    Family: null,
    Power: { Value: null, Error: 'Not read' },
    Channels: [],
  };
}

// Mute enum: 1 = Muted, 2 = Unmuted (AES70 OcaMuteState). Anything else is unknown.
function ParseMute(Params: Buffer): boolean | null {
  const Value = ReadUint8(Params);
  return Value === 1 ? true : Value === 2 ? false : null;
}

function ParsePower(Params: Buffer): boolean | null {
  const Position = ReadUint16(Params);
  return Position == null ? null : Position > 0;
}

function StringOf(Reply: GetReply): string | null {
  if (!Reply.Ok) return null;
  const Parsed = ReadOcaString(Reply.Params);
  return Parsed ? Parsed.Value : null;
}

// The read-only conversation. Every Get of a stage goes out at once and is
// matched by handle; stage 2 waits for the model only to pick the layout.
async function ReadAmp(Call: Ocp1Call, Model: ModelSetting, Snapshot: AmpSnapshot): Promise<void> {
  const [Desc, Name, Serial, State] = await Promise.all([
    Call(ONO_DEVICE_MANAGER, ...DM_GET_MODEL),
    Call(ONO_DEVICE_MANAGER, ...DM_GET_NAME),
    Call(ONO_DEVICE_MANAGER, ...DM_GET_SERIAL),
    Call(ONO_DEVICE_MANAGER, ...DM_GET_STATE),
  ]);
  const Description = Desc.Ok ? ReadModelDescription(Desc.Params) : null;
  if (Description) {
    Snapshot.Manufacturer = Description.Manufacturer;
    Snapshot.Model = Description.Name;
    Snapshot.FirmwareVersion = Description.Version;
  }
  Snapshot.DeviceName = StringOf(Name);
  Snapshot.SerialNumber = StringOf(Serial);
  Snapshot.DeviceState = State.Ok ? ReadUint16(State.Params) : null;

  const Family = FamilyFor(Model, Snapshot.Model);
  Snapshot.Family = Family;
  const Objects = OBJECTS[Family];
  const ReadChannel = async (Ch: number, Letter: string): Promise<ChannelReading> => {
    const [Mute, Isp, Gr, Ovl] = await Promise.all([
      Call(AmpONo(Ch, CONFIG_MUTE), ...MUTE_GET_STATE),
      Call(AmpONo(Ch, Objects.Isp), ...BOOLEAN_SENSOR_GET_READING),
      Call(AmpONo(Ch, Objects.Gr), ...BOOLEAN_SENSOR_GET_READING),
      Call(AmpONo(Ch, Objects.Ovl), ...BOOLEAN_SENSOR_GET_READING),
    ]);
    return {
      Channel: Letter,
      Muted: FromReply(Mute, ParseMute),
      SignalPresent: FromReply(Isp, (P) => ReadBoolean(P)),
      GainReduction: FromReply(Gr, (P) => ReadBoolean(P)),
      Overload: FromReply(Ovl, (P) => ReadBoolean(P)),
    };
  };
  const [Power, Channels] = await Promise.all([
    Call(AmpONo(0, Objects.PwrOn), ...SWITCH_GET_POSITION),
    Promise.all(CHANNEL_LETTERS.map((Letter, I) => ReadChannel(I + 1, Letter))),
  ]);
  Snapshot.Power = FromReply(Power, ParsePower);
  Snapshot.Channels = Channels;
}

export type AmpProbe =
  | { Reachable: false; Error: string; Refused: boolean }
  | {
      Reachable: true;
      LatencyMs: number;
      Port: number;
      IsAes70: boolean;
      Incomplete: boolean;
      Snapshot: AmpSnapshot;
    };

// Run Script against the amplifier, trying each candidate port in turn and
// moving on only when the previous one was refused (nothing listening). The
// whole attempt shares one budget. Fresh is called before each attempt so a
// script that records state starts clean on every port.
async function RunOnAmp(
  Config: AmpConfig,
  Fresh: () => (Call: Ocp1Call) => Promise<void>
): Promise<{ Port: number; Probe: Ocp1Probe }> {
  const Ports = PortsFor(Config);
  const Deadline = Date.now() + Math.max(500, Config.TimeoutMs | 0);
  let Last: { Port: number; Probe: Ocp1Probe } = {
    Port: Ports[0] ?? 0,
    Probe: { Reachable: false, Error: 'No port to try', Refused: false },
  };
  for (const Port of Ports) {
    const Remaining = Deadline - Date.now();
    if (Remaining <= 0) break;
    const Probe = await RunOcp1Session(Config.Address, Port, Remaining, Fresh());
    if (Probe.Reachable) return { Port, Probe };
    Last = {
      Port,
      Probe: Ports.length > 1 ? { ...Probe, Error: `Port ${Port}: ${Probe.Error}` } : Probe,
    };
    if (!Probe.Refused) break;
  }
  return Last;
}

async function QueryAmp(Config: AmpConfig): Promise<AmpProbe> {
  let Snapshot = EmptySnapshot();
  const { Port, Probe } = await RunOnAmp(Config, () => {
    Snapshot = EmptySnapshot();
    return (Call) => ReadAmp(Call, Config.Model, Snapshot);
  });
  if (!Probe.Reachable) return Probe;
  return {
    Reachable: true,
    LatencyMs: Probe.LatencyMs,
    Port,
    IsAes70: Probe.IsAes70,
    Incomplete: Probe.Incomplete,
    Snapshot,
  };
}

// --- Evaluation ----------------------------------------------------------------

function JoinLetters(Letters: string[]): string {
  return Letters.length === 1 ? `channel ${Letters[0]}` : `channels ${Letters.join(', ')}`;
}

// The reasons a reachable amplifier is unhealthy, per the enabled options.
// Pure: exported via _internal for unit tests.
function EvaluateHealth(
  Probe: { IsAes70: boolean; Incomplete: boolean; Snapshot: AmpSnapshot },
  Options: HealthOptions
): string[] {
  if (!Probe.IsAes70) return ['Responded, but not as an AES70 (OCA) device'];
  const Snap = Probe.Snapshot;
  const Reasons: string[] = [];
  if (Probe.Incomplete) Reasons.push('The amplifier did not answer every read in time');

  if (Options.CheckDeviceState && Snap.DeviceState != null) {
    const Flags = DeviceStateFlags(Snap.DeviceState);
    if (Flags.includes('Error')) Reasons.push('Amplifier reports an error');
    if (Flags.includes('Disabled')) Reasons.push('Amplifier is disabled');
    if (Flags.includes('Initializing')) Reasons.push('Amplifier is starting up');
    if (Flags.includes('Updating')) Reasons.push('Amplifier is updating firmware');
  }

  if (Options.CheckName) {
    const Name = (Snap.DeviceName || '').trim();
    if (!Options.ExpectedName) {
      if (!Name) Reasons.push('Amplifier has no device name');
    } else if (Name.toLowerCase() !== Options.ExpectedName.toLowerCase()) {
      Reasons.push(`Device name "${Name}" (expected "${Options.ExpectedName}")`);
    }
  }

  const PoweredOff = Snap.Power.Value === false;
  if (Options.RequirePowerOn) {
    if (PoweredOff) Reasons.push('Amplifier is in standby');
    else if (Snap.Power.Value == null && !Probe.Incomplete) {
      Reasons.push(`Power state not readable (${PowerError(Snap.Power.Error || 'no reply')})`);
    }
  }

  const Checked = Snap.Channels.filter((C) =>
    Options.Channels.includes(CHANNEL_LETTERS.indexOf(C.Channel) + 1)
  );
  // One reason per check: which channels are bad, and which could not be read.
  const Check = (
    Enabled: boolean,
    Pick: (C: ChannelReading) => Reading<boolean>,
    IsBad: (Value: boolean) => boolean,
    Describe: (Letters: string) => string,
    What: string
  ): void => {
    if (!Enabled) return;
    const Bad = Checked.filter((C) => {
      const R = Pick(C);
      return R.Value != null && IsBad(R.Value);
    }).map((C) => C.Channel);
    if (Bad.length) Reasons.push(Describe(JoinLetters(Bad)));
    if (Probe.Incomplete) return;
    const Unread = Checked.filter((C) => Pick(C).Value == null);
    const First = Unread[0];
    if (First) {
      const Err = Pick(First).Error || 'no reply';
      Reasons.push(`${What} not readable on ${JoinLetters(Unread.map((C) => C.Channel))} (${Err})`);
    }
  };

  Check(
    Options.CheckMute,
    (C) => C.Muted,
    (V) => V,
    (L) => `Muted: ${L}`,
    'Mute'
  );
  // The status indicators mean nothing in standby, which RequirePowerOn reports.
  if (!PoweredOff) {
    Check(
      Options.CheckOverload,
      (C) => C.Overload,
      (V) => V,
      (L) => `Overload on ${L}`,
      'Overload'
    );
    Check(
      Options.CheckGainReduction,
      (C) => C.GainReduction,
      (V) => V,
      (L) => `Limiting on ${L}`,
      'Limiter state'
    );
    Check(
      Options.RequireSignal,
      (C) => C.SignalPresent,
      (V) => !V,
      (L) => `No input signal on ${L}`,
      'Input signal'
    );
  }
  return Reasons;
}

function PlainChannel(C: ChannelReading): Record<string, unknown> {
  return {
    Channel: C.Channel,
    Muted: C.Muted.Value,
    SignalPresent: C.SignalPresent.Value,
    GainReduction: C.GainReduction.Value,
    Overload: C.Overload.Value,
    Errors: [
      C.Muted.Error && `Mute: ${C.Muted.Error}`,
      C.SignalPresent.Error && `Signal: ${C.SignalPresent.Error}`,
      C.GainReduction.Error && `Limiter: ${C.GainReduction.Error}`,
      C.Overload.Error && `Overload: ${C.Overload.Error}`,
    ].filter(Boolean),
  };
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (Config.Port > 65535) return { Success: false, Error: `Invalid port: ${Config.Port}` };
  const Options = ParseHealthOptions(Target);

  const Probe = await QueryAmp(Config);
  if (!Probe.Reachable) {
    return { Success: false, ...(Probe.Refused ? { Degraded: true } : {}), Error: Probe.Error };
  }

  const Snap = Probe.Snapshot;
  const Reasons = EvaluateHealth(Probe, Options);
  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs: Probe.LatencyMs,
    Port: Probe.Port,
    IsAes70: Probe.IsAes70,
    Manufacturer: Snap.Manufacturer,
    Model: Snap.Model,
    FirmwareVersion: Snap.FirmwareVersion,
    DeviceName: Snap.DeviceName,
    SerialNumber: Snap.SerialNumber,
    DeviceState: Snap.DeviceState,
    DeviceStateFlags: Snap.DeviceState == null ? null : DeviceStateFlags(Snap.DeviceState),
    Family: Snap.Family,
    PowerOn: Snap.Power.Value,
    PowerError: Snap.Power.Value == null ? Snap.Power.Error || null : null,
    Channels: Snap.Channels.map(PlainChannel),
  };
}

// --- Actions -----------------------------------------------------------------------
//
// Each press opens its own short session on the check's port(s), sends the Set
// and waits for the amplifier's response. Nothing is cached, so there is no
// InvalidateCaches: the follow-up probe reads the amplifier afresh.

const CHANNEL_PARAM: MonitoringSettingField = {
  Key: 'Channel',
  Label: 'Channel',
  // Free text with suggested choices, not a select: a select silently falls back
  // to its default for an unknown value, which would turn a mistyped OSC
  // channel into "All". RunAction validates instead.
  Type: 'string',
  Required: true,
  Options: [
    { value: 'all', label: 'All channels' },
    ...CHANNEL_LETTERS.map((Letter) => ({ value: Letter, label: `Channel ${Letter}` })),
  ],
  Note: 'A, B, C or D, or All for every channel.',
};

const Actions: MonitoringActionDef[] = [
  {
    ID: 'power.on',
    Label: 'Power On',
    Icon: 'power',
    Group: 'Power',
    Note: 'Brings the amplifier out of standby.',
  },
  {
    ID: 'power.standby',
    Label: 'Standby',
    Icon: 'power',
    Group: 'Power',
    Destructive: true,
    Note: 'Puts the amplifier into standby. Every output goes silent until it is powered on again.',
  },
  {
    ID: 'mute.on',
    Label: 'Mute Channel',
    Icon: 'volume-mute',
    Group: 'Mute',
    Destructive: true,
    Params: [CHANNEL_PARAM],
    Note: 'Mutes one output channel, or all four.',
  },
  {
    ID: 'mute.off',
    Label: 'Unmute Channel',
    Icon: 'volume-up',
    Group: 'Mute',
    Params: [CHANNEL_PARAM],
  },
];

// The channel numbers (1–4) a Channel parameter names, or null when it names
// none. Letters A–D or digits 1–4, any case; "all" is every channel.
function ParseChannelParam(Value: unknown): number[] | null {
  const Text = String(Value == null ? '' : Value)
    .trim()
    .toUpperCase();
  if (Text === 'ALL') return [1, 2, 3, 4];
  const Letter = CHANNEL_LETTERS.indexOf(Text);
  if (Letter >= 0) return [Letter + 1];
  return /^[1-4]$/.test(Text) ? [Number(Text)] : null;
}

function LetterOf(Channel: number): string {
  return CHANNEL_LETTERS[Channel - 1] || String(Channel);
}

function ChannelsLabel(Channels: number[]): string {
  if (Channels.length === CHANNEL_LETTERS.length) return 'All channels';
  return JoinLetters(Channels.map(LetterOf)).replace(/^c/, 'C');
}

function U16(Value: number): Buffer {
  const Out = Buffer.alloc(2);
  Out.writeUInt16BE(Value);
  return Out;
}

async function RunAction(
  Target: MonitoringTargetLike,
  ActionID: string,
  Params: Record<string, unknown>
): Promise<MonitoringActionResult> {
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (Config.Port > 65535) return { Success: false, Error: `Invalid port: ${Config.Port}` };

  const IsPower = ActionID === 'power.on' || ActionID === 'power.standby';
  const IsMute = ActionID === 'mute.on' || ActionID === 'mute.off';
  if (!IsPower && !IsMute) {
    return { Success: false, Error: `Unknown d&b amplifier action "${ActionID}"` };
  }
  let Channels: number[] = [];
  if (IsMute) {
    const Parsed = ParseChannelParam(Params && Params.Channel);
    if (!Parsed) return { Success: false, Error: 'Choose a channel: A, B, C, D or All' };
    Channels = Parsed;
  }

  // One reply per Set sent: channel 0 for power.
  let Replies: Array<{ Channel: number; Reply: GetReply }> = [];
  const { Probe } = await RunOnAmp(Config, () => {
    Replies = [];
    return async (Call) => {
      if (IsPower) {
        // The power object differs on the 5D; in auto mode read the model first.
        let ModelName: string | null = null;
        if (Config.Model === 'auto') {
          const Desc = await Call(ONO_DEVICE_MANAGER, ...DM_GET_MODEL);
          const Parsed = Desc.Ok ? ReadModelDescription(Desc.Params) : null;
          ModelName = Parsed ? Parsed.Name : null;
        }
        const Objects = OBJECTS[FamilyFor(Config.Model, ModelName)];
        const Position = U16(ActionID === 'power.on' ? 1 : 0);
        const Reply = await Call(AmpONo(0, Objects.PwrOn), ...SWITCH_SET_POSITION, Position, 1);
        Replies.push({ Channel: 0, Reply });
        return;
      }
      const State = Buffer.from([ActionID === 'mute.on' ? MUTE_STATE_MUTED : MUTE_STATE_UNMUTED]);
      Replies = await Promise.all(
        Channels.map(async (Ch) => ({
          Channel: Ch,
          Reply: await Call(AmpONo(Ch, CONFIG_MUTE), ...MUTE_SET_STATE, State, 1),
        }))
      );
    };
  });

  if (!Probe.Reachable) return { Success: false, Error: Probe.Error };
  if (!Probe.IsAes70) {
    return { Success: false, Error: 'The device answered, but not as an AES70 (OCA) amplifier' };
  }
  if (Probe.Incomplete) {
    return { Success: false, Error: 'The amplifier did not confirm the command in time' };
  }

  const Failed = Replies.filter((R) => !R.Reply.Ok);
  const FirstFailure = Failed[0];
  const Reason = FirstFailure && !FirstFailure.Reply.Ok ? ReplyError(FirstFailure.Reply.Error) : '';
  if (IsPower) {
    if (Failed.length) {
      return { Success: false, Error: `The amplifier refused: ${PowerError(Reason)}` };
    }
    return {
      Success: true,
      Detail: ActionID === 'power.on' ? 'Amplifier powered on' : 'Amplifier put into standby',
    };
  }
  const Verb = ActionID === 'mute.on' ? 'muted' : 'unmuted';
  if (!Failed.length) return { Success: true, Detail: `${ChannelsLabel(Channels)} ${Verb}` };
  const Done = Replies.filter((R) => R.Reply.Ok).map((R) => R.Channel);
  const FailedLabel = JoinLetters(Failed.map((R) => LetterOf(R.Channel)));
  return {
    Success: false,
    Error: Done.length
      ? `${ChannelsLabel(Done)} ${Verb}, but the amplifier refused ${FailedLabel}: ${Reason}`
      : `The amplifier refused: ${Reason}`,
  };
}

// No GetActionOptions: every amplifier this method covers has four channels,
// so the parameter's own Options already list the real choices.

function DescribeAction(ActionID: string, Params: Record<string, unknown>): string | null {
  if (ActionID !== 'mute.on' && ActionID !== 'mute.off') return null;
  const Channels = ParseChannelParam(Params && Params.Channel);
  if (!Channels) return null;
  const Verb = ActionID === 'mute.on' ? 'Mute' : 'Unmute';
  return Channels.length === CHANNEL_LETTERS.length
    ? `${Verb} All Channels`
    : `${Verb} Channel ${Channels.map(LetterOf).join(', ')}`;
}

// --- Debug panel -----------------------------------------------------------------

const FAMILY_LABELS: Record<Family, string> = {
  dxdy: 'D20 / D40 / D80 / 10D / 30D / 40D layout',
  '5d': '5D layout',
};

function YesNo(Value: unknown): string {
  return Value === true ? 'yes' : Value === false ? 'no' : '-';
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseConfig(Target);
  const Options = ParseHealthOptions(Target);
  const Reachable = !!(Result && Result.Success === true);
  const Degraded = !!(Result && Result.Degraded);
  const StatePill = !Reachable
    ? Pill('danger', 'Offline')
    : Degraded
      ? Pill('warning', Result.DegradedReason || 'Degraded')
      : Pill('success', 'Healthy');
  const PortText =
    Reachable && Result.Port != null ? String(Result.Port) : PortsFor(Config).join(' or ');

  const Head = [
    TextRow('Host', `${Config.Address || '-'}:${PortText}`),
    Row('Status', StatePill),
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Failed to reach the amplifier'),
  ];
  if (!Reachable) {
    return (
      Rows(Head) +
      '<div class="mt-2">' +
      Note(`Failed to reach AES70 (OCP.1) on TCP ${PortText}`) +
      '</div>'
    );
  }
  if (Result.IsAes70 === false) {
    return (
      Rows(Head) +
      '<div class="mt-2">' +
      Note('The device answered, but not as an AES70 (OCA) device') +
      '</div>'
    );
  }

  const Flags = Array.isArray(Result.DeviceStateFlags)
    ? (Result.DeviceStateFlags as string[])
    : null;
  const StateBad =
    !!Flags &&
    Flags.some(
      (F) => F === 'Error' || F === 'Disabled' || F === 'Initializing' || F === 'Updating'
    );
  const Power = Result.PowerOn;

  const Body = [
    ...Head,
    Result.Model ? TextRow('Model', String(Result.Model)) : null,
    Result.Manufacturer ? TextRow('Manufacturer', String(Result.Manufacturer)) : null,
    Result.FirmwareVersion ? TextRow('Firmware', String(Result.FirmwareVersion)) : null,
    Result.DeviceName != null
      ? TextRow(
          'Device name',
          (String(Result.DeviceName) || '(none)') +
            (Options.CheckName && Options.ExpectedName
              ? ` (expected "${Options.ExpectedName}")`
              : '')
        )
      : null,
    Result.SerialNumber ? TextRow('Serial number', String(Result.SerialNumber)) : null,
    Flags
      ? Row(
          'Device state',
          Pill(StateBad ? 'warning' : 'success', Flags.length ? Flags.join(', ') : 'None reported')
        )
      : null,
    Row(
      'Power',
      Power === true
        ? Pill('success', 'On')
        : Power === false
          ? Pill('warning', 'Standby')
          : Pill('muted', Result.PowerError ? `Unknown (${String(Result.PowerError)})` : 'Unknown')
    ),
    Result.Family
      ? TextRow('Objects', FAMILY_LABELS[Result.Family as Family] || String(Result.Family))
      : null,
  ];

  const Channels = Array.isArray(Result.Channels)
    ? (Result.Channels as Array<Record<string, unknown>>)
    : [];
  const Cards = Channels.map((C) => {
    const Letter = String(C.Channel);
    const IsChecked = Options.Channels.includes(CHANNEL_LETTERS.indexOf(Letter) + 1);
    const Bad =
      IsChecked &&
      ((Options.CheckMute && C.Muted === true) ||
        (Options.CheckOverload && C.Overload === true) ||
        (Options.CheckGainReduction && C.GainReduction === true) ||
        (Options.RequireSignal && Power !== false && C.SignalPresent === false));
    const Badge =
      C.Muted === true
        ? Pill(Bad ? 'warning' : 'muted', 'Muted')
        : C.Muted === false
          ? Pill(Bad ? 'warning' : 'success', 'Unmuted')
          : Pill('muted', 'Unknown');
    const Errors = Array.isArray(C.Errors) ? (C.Errors as string[]) : [];
    const Detail =
      `Signal ${YesNo(C.SignalPresent)} · Limiting ${YesNo(C.GainReduction)} · Overload ${YesNo(C.Overload)}` +
      (IsChecked ? '' : ' · not checked');
    return Card({
      Title: `Channel ${Letter}`,
      Badge,
      Highlight: IsChecked && !Bad && C.Muted === false,
      BodyHtml:
        `<div class="text-muted small text-break">${Esc(Detail)}</div>` +
        (Errors.length
          ? `<div class="text-muted small text-break">${Esc(Errors.join(' · '))}</div>`
          : ''),
    });
  }).join('');

  return Rows(Body) + (Cards ? `<div class="mt-2 d-grid gap-1">${Cards}</div>` : '');
}

export const Name = 'd&b Amplifier';
export const Description =
  'Connects to a d&b audiotechnik amplifier (D20, D40, D80, 10D, 30D, 40D, 5D) over AES70 / OCP.1 and reads its model, firmware, name, device state, power and per-channel mute, signal, limiter and overload indicators, without changing anything. Reports Degraded when the amplifier is in standby, reports an error or a channel is in overload, and optionally when channels are muted, limiting or have no input signal. Actions: power on, standby, and mute or unmute a channel.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseConfig,
  ParseHealthOptions,
  ParseChannels,
  PortsFor,
  AmpONo,
  DetectFamily,
  FamilyFor,
  EvaluateHealth,
  QueryAmp,
  ParseChannelParam,
  OBJECTS,
  CONFIG_MUTE,
};
export { ID, Settings, Actions, Run, RunAction, DescribeAction, Debug };
