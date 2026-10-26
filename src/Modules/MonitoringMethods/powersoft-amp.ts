// Powersoft amplifier check over the amplifier's binary UDP control protocol.
//
// Protocol (Powersoft "Protocol for X Series Amplifiers" rev 0.16, the PDF
// `API_for_X_T_Canali-DSP_0.16.pdf` published in Bitfocus
// companion-module-powersoft-amplifiers/docs; cross-checked against that module's
// src/udp.ts and macoss/companion-module-powersoft-amplifier's protocol.js):
//   - The amplifier listens on UDP 1234 (broadcast and unicast) and answers the
//     sender's IP on the `answer_port` named in the request (1234 when that is 0).
//   - Every frame, request or answer:
//       STX 0x02 | cmd u8 | cookie u16LE | count u16LE | answer_port u16LE |
//       data[count] | crc16 u16LE | ~cmd u8 | ETX 0x03
//     Requests use cmd 0–127; the answer carries ~cmd (e.g. READGM 1 -> 254) and
//     echoes the cookie. The trailing byte is the complement of the frame's own
//     cmd, so an answer to READGM ends `.. 0x01 0x03`.
//   - crc16 is over the data field only (0 for empty data), polynomial
//     x^16+x^15+x^2+1 with the PDF's check value CRC("123456789") = 0xBB3D,
//     i.e. CRC-16/ARC. Every request this check sends has empty or all-zero data,
//     so its CRC is 0 either way. The PDF's own answer diagrams show CRC16 = 0 on
//     some answers (READALLALARMS2), so the answer CRC is deliberately NOT
//     verified; STX/ETX, length, cmd, ~cmd and cookie are.
//   - Commands read here (all read-only):
//       INFO (11)            -> 128 bytes: manufacturer, family, model, serial,
//                               each a NUL-terminated string in a 32-byte slot.
//       STANDBY (14) data [0,0,0,0] (0 = READ without changing the state)
//                            -> [answer_ok, ON_OFF, 0, 0]; ON_OFF 2 = standby OFF
//                               (operative), 1 = standby ON (not operative).
//       READGM (1)           -> answer_ok, num_channels, 0, 0, INGAIN0..7 i16LE,
//                               OUTGAIN0..7 i16LE (cents of dB), INMUTE0..7 u8,
//                               OUTMUTE0..7 u8; 52 bytes.
//       READALLALARMS2 (25)  -> answer_ok, gpio_alarms u8, 0 u16, global u32LE,
//                               channel 0..7 alarms u32LE; 40 bytes.
//     STANDBY with ON_OFF_READ 1 or 2 changes the power state, so this check
//     only ever sends it with 0.
//   - Commands only the operator's actions send (RunAction, never Run):
//       STANDBY (14) data [1,0,0,0] -> standby OFF (amplifier operative);
//                    data [2,0,0,0] -> standby ON (not operative).
//                    Answer [answer_ok, ON_OFF, 0, 0].
//       WRITEOUTMUTE (3) data [CHANNEL (0-based), OUTMUTE (1 mute, 0 unmute), 0, 0]
//                    -> [answer_ok, CHANNEL, OUTMUTE, 0]. "Way EQ" mute in
//                    Armonía, the same OUTMUTE that READGM reports.
//     These carry non-zero data, so their CRC is not 0. The CRC is computed as
//     the PDF defines it (CRC-16/ARC of the data field). The Companion module
//     forces CRC 0 for STANDBY because the amplifier ignored its computed CRC,
//     but that CRC covered the header too and started from 0xFFFF, which does
//     not match the PDF's own check value; with the PDF's CRC the read request
//     [0,0,0,0] has CRC 0 anyway. Not verified against hardware.
//     WRITEMULTI (8) could mute several outputs at once, but it also writes
//     every gain, so "all channels" is one WRITEOUTMUTE per channel instead.
//
// Coverage: the PDF covers the X Series and the "Canali" DSP family (Duecanali,
// Quattrocanali, Ottocanali DSP+D). Some alarm bits are marked "only X". The
// T Series and Mezzo are not named by the document; they are not claimed here.
//
// Design (mirrors x32-console.ts):
//   - One ephemeral connected UDP socket per probe; its local port is the
//     answer_port, so the amplifier replies straight back to it.
//   - UDP is lossy, so every unanswered request is re-sent on a short interval
//     with the SAME cookie until it is answered or the whole-probe deadline (the
//     configured Timeout) passes. Reads are idempotent.
//   - Answers are matched by cookie and answer cmd, never by arrival order.
//   - INFO is the fingerprint: a well-formed INFO answer means a Powersoft
//     protocol endpoint answered.
import dgram from 'dgram';
import net from 'net';
import { ErrorMessage } from './_tcp-session';
import { Card, Esc, FormatLatency, Note, Pill, Row, Rows, TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type {
  MonitoringActionDef,
  MonitoringActionOptions,
  MonitoringActionResult,
  MonitoringResult,
  MonitoringSettingField,
  MonitoringTargetLike,
} from './types';

const ID = 'powersoft-amp';

export const DEFAULT_POWERSOFT_PORT = 1234;
const DEFAULT_TIMEOUT_MS = 3000;
const MIN_RESEND_MS = 250;
// The protocol carries eight channel slots in READGM and READALLALARMS2.
const MAX_CHANNELS = 8;

const STX = 0x02;
const ETX = 0x03;
export const CMD = {
  READGM: 1,
  WRITEOUTMUTE: 3,
  INFO: 11,
  STANDBY: 14,
  READALLALARMS2: 25,
} as const;

// READALLALARMS2 global_alarms bits, as named in the PDF.
const GLOBAL_ALARM_BITS: Array<[number, string]> = [
  [0, 'Mains phase error'],
  [1, 'AD converter configuration fault'],
  [2, 'DA converter configuration fault'],
  [3, 'AUX voltage fault'],
  [4, 'Digital board over-temperature'],
  [5, 'Power supply over-temperature'],
  [6, 'Fan fault'],
  [7, 'Moderate over-temperature'],
  [8, 'High over-temperature'],
];

// READALLALARMS2 channel alarm bits. Bit 0 (input clip) is kept apart: it is a
// signal condition, not a fault, and has its own toggle.
const CLIP_BIT = 0;
const CHANNEL_FAULT_BITS: Array<[number, string]> = [
  [1, 'thermal SOA active'],
  [3, 'over-temperature'],
  [4, 'rail voltage fault'],
  [5, 'AUX current fault'],
  [6, 'other fault'],
  [7, 'low load protection'],
];

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'UDP port',
    Type: 'number',
    Default: DEFAULT_POWERSOFT_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
    Note: 'Powersoft amplifiers listen on UDP 1234.',
  },
  {
    Key: 'CheckStandby',
    Label: 'Check standby',
    Type: 'boolean',
    Default: true,
    Note: 'Enable to report Degraded while the amplifier is in standby.',
  },
  {
    Key: 'CheckFaults',
    Label: 'Check amplifier faults',
    Type: 'boolean',
    Default: true,
    Note: 'Enable to report Degraded on a mains phase error, converter fault, AUX voltage fault, over-temperature or fan fault.',
  },
  {
    Key: 'CheckChannelFaults',
    Label: 'Check channel faults',
    Type: 'boolean',
    Default: true,
    Note: 'Enable to report Degraded when an output channel reports over-temperature, a rail voltage fault, low load protection, thermal SOA, an AUX current fault or another fault.',
  },
  {
    Key: 'CheckClip',
    Label: 'Check input clip',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded while a channel reports input clip at the moment of the check.',
  },
  {
    Key: 'CheckMutes',
    Label: 'Check output mutes',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded while an output channel is muted.',
  },
  {
    Key: 'MonitoredChannels',
    Label: 'Output channels',
    Type: 'list',
    ItemType: 'number',
    Default: [],
    VisibleWhen: { Key: 'CheckMutes', Equals: true },
    Note: 'Channel numbers starting at 1. Leave empty to check every channel on the amplifier.',
  },
  {
    Key: 'CheckSerial',
    Label: 'Check serial number',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded when a different amplifier answers on this address.',
  },
  {
    Key: 'ExpectedSerial',
    Label: 'Expected serial number',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'CheckSerial', Equals: true },
    Note: 'The serial number shown in ArmoníaPlus. Not case-sensitive.',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: DEFAULT_TIMEOUT_MS,
    Min: 500,
    Max: 30000,
    Advanced: true,
  },
];

// --- Config -----------------------------------------------------------------

export interface PowersoftConfig {
  Address: string;
  Port: number;
  TimeoutMs: number;
}

function ParseConfig(Target: MonitoringTargetLike): PowersoftConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number(Cfg.Port);
  const Timeout = Number(Cfg.Timeout);
  return {
    Address: String((Target && Target.Address) || '').trim(),
    Port: Number.isFinite(Port) && Port > 0 ? Math.floor(Port) : DEFAULT_POWERSOFT_PORT,
    TimeoutMs: Number.isFinite(Timeout) && Timeout > 0 ? Math.floor(Timeout) : DEFAULT_TIMEOUT_MS,
  };
}

interface HealthOptions {
  CheckStandby: boolean;
  CheckFaults: boolean;
  CheckChannelFaults: boolean;
  CheckClip: boolean;
  CheckMutes: boolean;
  Channels: number[];
  CheckSerial: boolean;
  ExpectedSerial: string;
}

// Unique positive integers in the order given. Numbers past the amplifier's
// channel count are kept and named by EvaluateHealth: only the probe knows the
// count.
function ParseChannelList(Value: unknown): number[] {
  const Raw = Array.isArray(Value) ? Value : Value == null || Value === '' ? [] : [Value];
  const Out: number[] = [];
  for (const Item of Raw) {
    const N = Number(String(Item == null ? '' : Item).trim());
    if (!Number.isInteger(N) || N < 1 || N > 999) continue;
    if (!Out.includes(N)) Out.push(N);
  }
  return Out;
}

// A toggle that defaults ON when the stored settings predate it.
function Toggle(Value: unknown, Default: boolean): boolean {
  return Value === undefined ? Default : !!Value;
}

function ParseHealthOptions(Target: MonitoringTargetLike): HealthOptions {
  const Cfg = (Target && Target.Settings) || {};
  return {
    CheckStandby: Toggle(Cfg.CheckStandby, true),
    CheckFaults: Toggle(Cfg.CheckFaults, true),
    CheckChannelFaults: Toggle(Cfg.CheckChannelFaults, true),
    CheckClip: !!Cfg.CheckClip,
    CheckMutes: !!Cfg.CheckMutes,
    Channels: ParseChannelList(Cfg.MonitoredChannels),
    CheckSerial: !!Cfg.CheckSerial,
    ExpectedSerial: String(Cfg.ExpectedSerial || '').trim(),
  };
}

// --- Framing ----------------------------------------------------------------

// CRC-16/ARC: reflected polynomial 0xA001 (x^16+x^15+x^2+1), init 0. Matches the
// PDF's check value CRC("123456789") = 0xBB3D, and is 0 for empty data.
function Crc16(Data: Buffer): number {
  let Crc = 0;
  for (const Byte of Data) {
    Crc ^= Byte;
    for (let Bit = 0; Bit < 8; Bit++) {
      Crc = Crc & 1 ? (Crc >>> 1) ^ 0xa001 : Crc >>> 1;
    }
  }
  return Crc & 0xffff;
}

function BuildFrame(Cmd: number, Cookie: number, AnswerPort: number, Data: Buffer): Buffer {
  const Out = Buffer.alloc(12 + Data.length);
  Out[0] = STX;
  Out[1] = Cmd & 0xff;
  Out.writeUInt16LE(Cookie & 0xffff, 2);
  Out.writeUInt16LE(Data.length, 4);
  Out.writeUInt16LE(AnswerPort & 0xffff, 6);
  Data.copy(Out, 8);
  Out.writeUInt16LE(Crc16(Data), 8 + Data.length);
  Out[10 + Data.length] = ~Cmd & 0xff;
  Out[11 + Data.length] = ETX;
  return Out;
}

export interface PowersoftFrame {
  Cmd: number;
  Cookie: number;
  Data: Buffer;
}

// Decode one datagram. Null unless it is exactly one well-formed frame.
function ParseFrame(Buf: Buffer): PowersoftFrame | null {
  if (!Buf || Buf.length < 12 || Buf[0] !== STX || Buf[Buf.length - 1] !== ETX) return null;
  const Count = Buf.readUInt16LE(4);
  if (Buf.length !== 12 + Count) return null;
  const Cmd = Buf.readUInt8(1);
  if (Buf[10 + Count] !== (~Cmd & 0xff)) return null;
  return { Cmd, Cookie: Buf.readUInt16LE(2), Data: Buf.subarray(8, 8 + Count) };
}

// --- Answer decoders ----------------------------------------------------------

function CString(Data: Buffer, Offset: number, Size: number): string {
  const Slice = Data.subarray(Offset, Offset + Size);
  const End = Slice.indexOf(0);
  return Slice.subarray(0, End < 0 ? Slice.length : End)
    .toString('latin1')
    .trim();
}

export interface PowersoftInfo {
  Manufacturer: string;
  Family: string;
  Model: string;
  Serial: string;
}

function ParseInfo(Data: Buffer): PowersoftInfo | null {
  if (Data.length < 128) return null;
  return {
    Manufacturer: CString(Data, 0, 32),
    Family: CString(Data, 32, 32),
    Model: CString(Data, 64, 32),
    Serial: CString(Data, 96, 32),
  };
}

// STANDBY answer -> true = in standby, false = operative, null = invalid.
function ParseStandby(Data: Buffer): boolean | null {
  if (Data.length < 2 || Data[0] !== 1) return null;
  if (Data[1] === 1) return true;
  if (Data[1] === 2) return false;
  return null;
}

export interface PowersoftGainsMutes {
  NumChannels: number;
  OutGainDb: number[];
  OutMuted: boolean[];
}

function ParseReadGm(Data: Buffer): PowersoftGainsMutes | null {
  if (Data.length < 52 || Data[0] !== 1) return null;
  const NumChannels = Math.min(Data.readUInt8(1), MAX_CHANNELS);
  const OutGainDb: number[] = [];
  const OutMuted: boolean[] = [];
  for (let I = 0; I < NumChannels; I++) {
    OutGainDb.push(Data.readInt16LE(20 + I * 2) / 100);
    OutMuted.push(Data[44 + I] !== 0);
  }
  return { NumChannels, OutGainDb, OutMuted };
}

export interface PowersoftAlarms {
  Gpio: number;
  Global: number;
  ChannelWords: number[];
}

function ParseAlarms2(Data: Buffer): PowersoftAlarms | null {
  if (Data.length < 8 || Data[0] !== 1) return null;
  const ChannelWords: number[] = [];
  for (let I = 0; I < MAX_CHANNELS && 8 + I * 4 + 4 <= Data.length; I++) {
    ChannelWords.push(Data.readUInt32LE(8 + I * 4));
  }
  return { Gpio: Data.readUInt8(1), Global: Data.readUInt32LE(4), ChannelWords };
}

function GlobalAlarmNames(Word: number): string[] {
  return GLOBAL_ALARM_BITS.filter(([Bit]) => (Word >>> Bit) & 1).map(([, Label]) => Label);
}

function ChannelFaultNames(Word: number): string[] {
  return CHANNEL_FAULT_BITS.filter(([Bit]) => (Word >>> Bit) & 1).map(([, Label]) => Label);
}

// --- Probe ------------------------------------------------------------------

export interface PowersoftChannel {
  Channel: number;
  Muted: boolean | null;
  GainDb: number | null;
  Clip: boolean | null;
  Faults: string[];
}

export interface PowersoftSnapshot {
  LatencyMs: number;
  // INFO answered with the 128-byte identity block.
  IsAmplifier: boolean;
  Manufacturer: string | null;
  Family: string | null;
  Model: string | null;
  Serial: string | null;
  // true = standby (not operative), false = operative, null = not read.
  Standby: boolean | null;
  NumChannels: number | null;
  AlarmsRead: boolean;
  GlobalAlarms: string[];
  GpioAlarms: number | null;
  Channels: PowersoftChannel[];
}

export type PowersoftProbeOutcome =
  | { Reachable: true; Snapshot: PowersoftSnapshot }
  | { Reachable: false; Error: string; Refused: boolean };

export interface PowersoftProbeWants {
  Alarms: boolean;
}

export function QueryPowersoft(
  Config: PowersoftConfig,
  Wants: PowersoftProbeWants
): Promise<PowersoftProbeOutcome> {
  const BudgetMs = Math.max(500, Config.TimeoutMs | 0);
  const ResendMs = Math.max(MIN_RESEND_MS, Math.floor(BudgetMs / 4));

  return new Promise<PowersoftProbeOutcome>((Resolve) => {
    let Settled = false;
    let StartedAt = Date.now();
    let InfoAt: number | null = null;
    let AnyReply = false;
    let Gm: PowersoftGainsMutes | null = null;
    let Alarms: PowersoftAlarms | null = null;
    const Snap: PowersoftSnapshot = {
      LatencyMs: 0,
      IsAmplifier: false,
      Manufacturer: null,
      Family: null,
      Model: null,
      Serial: null,
      Standby: null,
      NumChannels: null,
      AlarmsRead: false,
      GlobalAlarms: [],
      GpioAlarms: null,
      Channels: [],
    };
    // Outstanding requests keyed by cookie; each is re-sent until answered.
    const Pending = new Map<number, { Cmd: number; Frame: Buffer }>();
    let Socket: dgram.Socket | null = null;
    let ResendTimer: ReturnType<typeof setInterval> | null = null;
    let DeadlineTimer: ReturnType<typeof setTimeout> | null = null;

    const BuildChannels = (): void => {
      const Count = Gm ? Gm.NumChannels : Alarms ? Alarms.ChannelWords.length : 0;
      Snap.NumChannels = Gm ? Gm.NumChannels : null;
      Snap.Channels = [];
      for (let I = 0; I < Count; I++) {
        const Word = Alarms && I < Alarms.ChannelWords.length ? Alarms.ChannelWords[I] : null;
        Snap.Channels.push({
          Channel: I + 1,
          Muted: Gm ? (Gm.OutMuted[I] ?? null) : null,
          GainDb: Gm ? (Gm.OutGainDb[I] ?? null) : null,
          Clip: Word == null ? null : ((Word >>> CLIP_BIT) & 1) === 1,
          Faults: Word == null ? [] : ChannelFaultNames(Word),
        });
      }
      if (Alarms) {
        Snap.AlarmsRead = true;
        Snap.GlobalAlarms = GlobalAlarmNames(Alarms.Global);
        Snap.GpioAlarms = Alarms.Gpio;
      }
    };

    const Finish = (Outcome: PowersoftProbeOutcome): void => {
      if (Settled) return;
      Settled = true;
      if (ResendTimer) clearInterval(ResendTimer);
      if (DeadlineTimer) clearTimeout(DeadlineTimer);
      try {
        Socket?.close();
      } catch {
        // already closed
      }
      Resolve(Outcome);
    };

    const Reached = (): PowersoftProbeOutcome => {
      BuildChannels();
      Snap.LatencyMs = (InfoAt ?? Date.now()) - StartedAt;
      return { Reachable: true, Snapshot: Snap };
    };

    const Send = (Frame: Buffer): void => {
      if (!Socket || Settled) return;
      try {
        Socket.send(Frame);
      } catch {
        // A send on a socket that errored is reported by the 'error' handler.
      }
    };

    const OnFrame = (Frame: PowersoftFrame): void => {
      const Request = Pending.get(Frame.Cookie);
      if (!Request || Frame.Cmd !== (~Request.Cmd & 0xff)) return; // stale or unsolicited
      // A request the amplifier answered with answer_ok != 1 is still answered:
      // waiting for a better reply would only burn the budget.
      Pending.delete(Frame.Cookie);
      if (Request.Cmd === CMD.INFO) {
        const Info = ParseInfo(Frame.Data);
        if (Info) {
          InfoAt = Date.now();
          Snap.IsAmplifier = true;
          Snap.Manufacturer = Info.Manufacturer || null;
          Snap.Family = Info.Family || null;
          Snap.Model = Info.Model || null;
          Snap.Serial = Info.Serial || null;
        }
      } else if (Request.Cmd === CMD.STANDBY) {
        Snap.Standby = ParseStandby(Frame.Data);
      } else if (Request.Cmd === CMD.READGM) {
        Gm = ParseReadGm(Frame.Data);
      } else if (Request.Cmd === CMD.READALLALARMS2) {
        Alarms = ParseAlarms2(Frame.Data);
      }
    };

    try {
      Socket = dgram.createSocket(net.isIPv6(Config.Address) ? 'udp6' : 'udp4');
    } catch (Err) {
      Finish({ Reachable: false, Error: ErrorMessage(Err), Refused: false });
      return;
    }

    Socket.on('error', (Err: NodeJS.ErrnoException) => {
      // ICMP port-unreachable surfaces as ECONNREFUSED on a connected UDP socket:
      // the host is up, nothing is listening. Once the fingerprint is in, a late
      // error cannot unmake it.
      if (InfoAt != null) {
        Finish(Reached());
        return;
      }
      Finish({
        Reachable: false,
        Error: ErrorMessage(Err),
        Refused: (Err && Err.code) === 'ECONNREFUSED',
      });
    });

    Socket.on('message', (Buf: Buffer) => {
      if (Settled) return;
      AnyReply = true;
      const Frame = ParseFrame(Buf);
      if (Frame) OnFrame(Frame);
      if (!Pending.size) Finish(Reached());
    });

    DeadlineTimer = setTimeout(() => {
      // Something answered: report what was read. Without a valid INFO answer
      // the responder is not a Powersoft amplifier, which EvaluateHealth says.
      if (InfoAt != null || AnyReply) {
        Finish(Reached());
        return;
      }
      Finish({ Reachable: false, Error: `No reply within ${BudgetMs}ms`, Refused: false });
    }, BudgetMs);

    try {
      // Connecting fixes the peer, so stray datagrams from other hosts are
      // dropped by the kernel and an ICMP unreachable is reported.
      Socket.connect(Config.Port, Config.Address, () => {
        if (!Socket || Settled) return;
        StartedAt = Date.now();
        const AnswerPort = Socket.address().port;
        let Cookie = Math.floor(Math.random() * 0x10000);
        const Queue = (Cmd: number, Data: Buffer): void => {
          Cookie = (Cookie + 1) & 0xffff;
          Pending.set(Cookie, { Cmd, Frame: BuildFrame(Cmd, Cookie, AnswerPort, Data) });
        };
        Queue(CMD.INFO, Buffer.alloc(0));
        // ON_OFF_READ = 0: read the standby state WITHOUT changing it.
        Queue(CMD.STANDBY, Buffer.from([0, 0, 0, 0]));
        Queue(CMD.READGM, Buffer.alloc(0));
        if (Wants.Alarms) Queue(CMD.READALLALARMS2, Buffer.alloc(0));
        for (const Request of Pending.values()) Send(Request.Frame);
        ResendTimer = setInterval(() => {
          for (const Request of Pending.values()) Send(Request.Frame);
        }, ResendMs);
      });
    } catch (Err) {
      Finish({ Reachable: false, Error: ErrorMessage(Err), Refused: false });
    }
  });
}

// --- Evaluation -------------------------------------------------------------

// The reasons a reachable amplifier is unhealthy, per the enabled toggles. Pure;
// exported via _internal for unit tests.
function EvaluateHealth(Snapshot: PowersoftSnapshot, Options: HealthOptions): string[] {
  if (!Snapshot.IsAmplifier) {
    return ['Responded, but does not look like a Powersoft amplifier'];
  }
  const Reasons: string[] = [];

  if (Options.CheckSerial && Options.ExpectedSerial) {
    const Actual = String(Snapshot.Serial || '').trim();
    if (Actual.toLowerCase() !== Options.ExpectedSerial.toLowerCase()) {
      Reasons.push(`Serial "${Actual || '(blank)'}" (expected "${Options.ExpectedSerial}")`);
    }
  }

  if (Options.CheckStandby) {
    if (Snapshot.Standby === true) Reasons.push('In standby');
    else if (Snapshot.Standby == null) Reasons.push('Failed to read the standby state');
  }

  const WantsAlarms = Options.CheckFaults || Options.CheckChannelFaults || Options.CheckClip;
  if (WantsAlarms && !Snapshot.AlarmsRead) {
    Reasons.push('Failed to read the alarms');
  } else {
    if (Options.CheckFaults) Reasons.push(...Snapshot.GlobalAlarms);
    for (const C of Snapshot.Channels) {
      const Parts: string[] = [];
      if (Options.CheckChannelFaults) Parts.push(...C.Faults);
      if (Options.CheckClip && C.Clip) Parts.push('input clip');
      if (Parts.length) Reasons.push(`Ch ${C.Channel}: ${Parts.join(', ')}`);
    }
  }

  if (Options.CheckMutes) {
    if (Snapshot.NumChannels == null) {
      Reasons.push('Failed to read the output mutes');
    } else {
      const Wanted = Options.Channels.length
        ? Options.Channels
        : Snapshot.Channels.map((C) => C.Channel);
      for (const Channel of Wanted) {
        const State = Snapshot.Channels.find((C) => C.Channel === Channel);
        if (!State) Reasons.push(`Ch ${Channel}: not on this amplifier`);
        else if (State.Muted === true) Reasons.push(`Ch ${Channel}: muted`);
      }
    }
  }

  return Reasons;
}

// --- Actions ----------------------------------------------------------------
//
// Each press opens its own socket and sends its requests with the same resend
// rule as the probe: every unanswered request is re-sent with the same cookie
// until answered or the Timeout passes. Each write sets an absolute state, so a
// resend the amplifier already acted on changes nothing. Nothing is cached, so
// there is no InvalidateCaches.

export interface PowersoftRequest {
  Cmd: number;
  Data: Buffer;
}

export type PowersoftExchange =
  { Ok: true; Answers: Array<Buffer | null> } | { Ok: false; Error: string };

// Send every request at once and collect each answer's data (null when that
// one was never answered). Resolves when all are answered or the budget ends.
export function ExchangePowersoft(
  Config: PowersoftConfig,
  Requests: PowersoftRequest[],
  BudgetMs: number
): Promise<PowersoftExchange> {
  const Budget = Math.max(200, BudgetMs | 0);
  const ResendMs = Math.max(MIN_RESEND_MS, Math.floor(Budget / 4));
  return new Promise<PowersoftExchange>((Resolve) => {
    let Settled = false;
    let Socket: dgram.Socket | null = null;
    let ResendTimer: ReturnType<typeof setInterval> | null = null;
    let DeadlineTimer: ReturnType<typeof setTimeout> | null = null;
    const Answers: Array<Buffer | null> = Requests.map(() => null);
    // Outstanding requests keyed by cookie: its index in Requests and its frame.
    const Pending = new Map<number, { Index: number; Cmd: number; Frame: Buffer }>();

    const Finish = (Outcome: PowersoftExchange): void => {
      if (Settled) return;
      Settled = true;
      if (ResendTimer) clearInterval(ResendTimer);
      if (DeadlineTimer) clearTimeout(DeadlineTimer);
      try {
        Socket?.close();
      } catch {
        // already closed
      }
      Resolve(Outcome);
    };
    const SendAll = (): void => {
      if (!Socket || Settled) return;
      for (const Request of Pending.values()) {
        try {
          Socket.send(Request.Frame);
        } catch {
          // Reported by the 'error' handler.
        }
      }
    };

    try {
      Socket = dgram.createSocket(net.isIPv6(Config.Address) ? 'udp6' : 'udp4');
    } catch (Err) {
      Finish({ Ok: false, Error: ErrorMessage(Err) });
      return;
    }
    Socket.on('error', (Err: NodeJS.ErrnoException) => {
      Finish({
        Ok: false,
        Error:
          (Err && Err.code) === 'ECONNREFUSED'
            ? `Nothing is listening on UDP ${Config.Port}`
            : ErrorMessage(Err),
      });
    });
    Socket.on('message', (Buf: Buffer) => {
      if (Settled) return;
      const Frame = ParseFrame(Buf);
      if (!Frame) return;
      const Request = Pending.get(Frame.Cookie);
      if (!Request || Frame.Cmd !== (~Request.Cmd & 0xff)) return;
      Pending.delete(Frame.Cookie);
      Answers[Request.Index] = Frame.Data;
      if (!Pending.size) Finish({ Ok: true, Answers });
    });
    DeadlineTimer = setTimeout(() => {
      if (Answers.some((Answer) => Answer != null)) Finish({ Ok: true, Answers });
      else Finish({ Ok: false, Error: `No reply within ${Budget}ms` });
    }, Budget);

    try {
      Socket.connect(Config.Port, Config.Address, () => {
        if (!Socket || Settled) return;
        const AnswerPort = Socket.address().port;
        let Cookie = Math.floor(Math.random() * 0x10000);
        Requests.forEach((Request, Index) => {
          Cookie = (Cookie + 1) & 0xffff;
          Pending.set(Cookie, {
            Index,
            Cmd: Request.Cmd,
            Frame: BuildFrame(Request.Cmd, Cookie, AnswerPort, Request.Data),
          });
        });
        if (!Pending.size) {
          Finish({ Ok: true, Answers });
          return;
        }
        SendAll();
        ResendTimer = setInterval(SendAll, ResendMs);
      });
    } catch (Err) {
      Finish({ Ok: false, Error: ErrorMessage(Err) });
    }
  });
}

// STANDBY's ON-OFF-READ values for a write.
const STANDBY_SET_OPERATIVE = 1;
const STANDBY_SET_STANDBY = 2;

const CHANNEL_PARAM: MonitoringSettingField = {
  Key: 'Channel',
  Label: 'Output channel',
  // Free text with suggested choices, not a select: a select silently falls back
  // to its default for an unknown value, which would turn a mistyped OSC
  // channel into "All". RunAction validates instead.
  Type: 'string',
  Required: true,
  Options: [
    { value: 'all', label: 'All channels' },
    ...Array.from({ length: MAX_CHANNELS }, (_, I) => ({
      value: String(I + 1),
      label: `Channel ${I + 1}`,
    })),
  ],
  Note: 'An output channel number starting at 1, or All for every channel on the amplifier.',
};

const Actions: MonitoringActionDef[] = [
  {
    ID: 'power.on',
    Label: 'Power On',
    Icon: 'power',
    Group: 'Power',
    Note: 'Takes the amplifier out of standby.',
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
    Label: 'Mute Output',
    Icon: 'volume-mute',
    Group: 'Mute',
    Destructive: true,
    Params: [CHANNEL_PARAM],
    Note: 'Mutes one output channel, or all of them (the output mute, "Way EQ" in Armonía).',
  },
  {
    ID: 'mute.off',
    Label: 'Unmute Output',
    Icon: 'volume-up',
    Group: 'Mute',
    Params: [CHANNEL_PARAM],
  },
];

// 'all', or a channel number 1–8; null for anything else.
function ParseChannelParam(Value: unknown): 'all' | number | null {
  const Text = String(Value == null ? '' : Value)
    .trim()
    .toLowerCase();
  if (Text === 'all') return 'all';
  if (!/^[0-9]+$/.test(Text)) return null;
  const N = Number(Text);
  return N >= 1 && N <= MAX_CHANNELS ? N : null;
}

function ChannelsLabel(Channels: number[]): string {
  return Channels.length === 1 ? `Channel ${Channels[0]}` : `Channels ${Channels.join(', ')}`;
}

async function RunAction(
  Target: MonitoringTargetLike,
  ActionID: string,
  Params: Record<string, unknown>
): Promise<MonitoringActionResult> {
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Success: false, Error: `Invalid port: ${Config.Port}` };
  }
  const Deadline = Date.now() + Math.max(500, Config.TimeoutMs | 0);

  if (ActionID === 'power.on' || ActionID === 'power.standby') {
    const On = ActionID === 'power.on';
    const Data = Buffer.from([On ? STANDBY_SET_OPERATIVE : STANDBY_SET_STANDBY, 0, 0, 0]);
    const Outcome = await ExchangePowersoft(
      Config,
      [{ Cmd: CMD.STANDBY, Data }],
      Deadline - Date.now()
    );
    if (!Outcome.Ok) return { Success: false, Error: Outcome.Error };
    const Answer = Outcome.Answers[0];
    if (!Answer || Answer[0] !== 1) {
      return { Success: false, Error: 'The amplifier did not accept the standby command' };
    }
    return {
      Success: true,
      Detail: On ? 'Amplifier taken out of standby' : 'Amplifier put into standby',
    };
  }

  if (ActionID !== 'mute.on' && ActionID !== 'mute.off') {
    return { Success: false, Error: `Unknown Powersoft amplifier action "${ActionID}"` };
  }
  const Wanted = ParseChannelParam(Params && Params.Channel);
  if (Wanted == null) {
    return { Success: false, Error: `Choose an output channel from 1 to ${MAX_CHANNELS}, or All` };
  }

  // Read the channel count first (READGM, read-only), so "All" covers exactly
  // the amplifier's outputs and a channel it does not have is named as such.
  const Read = await ExchangePowersoft(
    Config,
    [{ Cmd: CMD.READGM, Data: Buffer.alloc(0) }],
    Deadline - Date.now()
  );
  if (!Read.Ok) return { Success: false, Error: Read.Error };
  const Gm = Read.Answers[0] ? ParseReadGm(Read.Answers[0]) : null;
  if (!Gm) return { Success: false, Error: 'The amplifier did not report its channels' };
  if (Wanted !== 'all' && Wanted > Gm.NumChannels) {
    return {
      Success: false,
      Error: `This amplifier has ${Gm.NumChannels} output channels, so there is no channel ${Wanted}`,
    };
  }
  const Channels =
    Wanted === 'all' ? Array.from({ length: Gm.NumChannels }, (_, I) => I + 1) : [Wanted];
  if (!Channels.length) return { Success: false, Error: 'The amplifier reported no channels' };

  const Mute = ActionID === 'mute.on' ? 1 : 0;
  const Remaining = Deadline - Date.now();
  if (Remaining <= 0) return { Success: false, Error: 'Ran out of time before sending the mute' };
  const Write = await ExchangePowersoft(
    Config,
    Channels.map((Ch) => ({ Cmd: CMD.WRITEOUTMUTE, Data: Buffer.from([Ch - 1, Mute, 0, 0]) })),
    Remaining
  );
  if (!Write.Ok) return { Success: false, Error: Write.Error };
  const Done: number[] = [];
  const Failed: number[] = [];
  Channels.forEach((Ch, I) => {
    const Answer = Write.Answers[I];
    if (Answer && Answer[0] === 1) Done.push(Ch);
    else Failed.push(Ch);
  });
  const Verb = Mute ? 'muted' : 'unmuted';
  const Everything = Wanted === 'all';
  if (!Failed.length) {
    return { Success: true, Detail: `${Everything ? 'All outputs' : ChannelsLabel(Done)} ${Verb}` };
  }
  return {
    Success: false,
    Error: Done.length
      ? `${ChannelsLabel(Done)} ${Verb}, but the amplifier did not confirm ${ChannelsLabel(Failed).toLowerCase()}`
      : `The amplifier did not confirm the ${Mute ? 'mute' : 'unmute'}`,
  };
}

// Offer only the output channels the amplifier reported.
function GetActionOptions(Result: MonitoringResult): MonitoringActionOptions {
  const Count = Number(Result && Result.NumChannels);
  if (!Number.isInteger(Count) || Count < 1) return {};
  return {
    Channel: [
      { value: 'all', label: 'All channels' },
      ...Array.from({ length: Math.min(Count, MAX_CHANNELS) }, (_, I) => ({
        value: String(I + 1),
        label: `Channel ${I + 1}`,
      })),
    ],
  };
}

function DescribeAction(ActionID: string, Params: Record<string, unknown>): string | null {
  if (ActionID !== 'mute.on' && ActionID !== 'mute.off') return null;
  const Wanted = ParseChannelParam(Params && Params.Channel);
  if (Wanted == null) return null;
  const Verb = ActionID === 'mute.on' ? 'Mute' : 'Unmute';
  return Wanted === 'all' ? `${Verb} All Outputs` : `${Verb} Output ${Wanted}`;
}

// --- Run / Debug ------------------------------------------------------------

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Success: false, Error: `Invalid port: ${Config.Port}` };
  }
  const Options = ParseHealthOptions(Target);

  const Outcome = await QueryPowersoft(Config, {
    Alarms: Options.CheckFaults || Options.CheckChannelFaults || Options.CheckClip,
  });
  if (!Outcome.Reachable) {
    return {
      Success: false,
      ...(Outcome.Refused ? { Degraded: true } : {}),
      Error: Outcome.Error,
    };
  }

  const Snap = Outcome.Snapshot;
  const Reasons = EvaluateHealth(Snap, Options);
  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs: Snap.LatencyMs,
    IsAmplifier: Snap.IsAmplifier,
    Manufacturer: Snap.Manufacturer,
    Family: Snap.Family,
    Model: Snap.Model,
    Serial: Snap.Serial,
    Standby: Snap.Standby,
    NumChannels: Snap.NumChannels,
    AlarmsRead: Snap.AlarmsRead,
    GlobalAlarms: Snap.GlobalAlarms,
    GpioAlarms: Snap.GpioAlarms,
    Channels: Snap.Channels,
  };
}

function StatePill(Result: MonitoringResult): string {
  const Reachable = !!(Result && Result.Success === true);
  if (Reachable && !Result.Degraded) return Pill('success', 'Online');
  if (Reachable) return Pill('warning', Result.DegradedReason || 'Degraded');
  return Pill('danger', 'Offline');
}

function ChannelBadge(C: PowersoftChannel): string {
  const Problems = [...(C.Faults || [])];
  if (C.Clip) Problems.push('input clip');
  if (Problems.length) return Pill('danger', Problems.join(', '));
  if (C.Muted === true) return Pill('warning', 'Muted');
  return Pill('success', 'OK');
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseConfig(Target);
  const Reachable = !!(Result && Result.Success === true);
  const Identity = [Result && Result.Family, Result && Result.Model]
    .filter((Part) => Part != null && String(Part).trim() !== '')
    .join(' ');
  const GlobalAlarms = Array.isArray(Result && Result.GlobalAlarms)
    ? (Result.GlobalAlarms as string[])
    : [];

  const Head = Rows([
    TextRow('Host', `${Config.Address || '-'}:${Config.Port}`),
    Identity ? TextRow('Amplifier', Identity) : null,
    Reachable && Result.Serial ? TextRow('Serial', Result.Serial) : null,
    Row('Status', StatePill(Result)),
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Failed to reach the amplifier'),
    Reachable && Result.Standby != null
      ? Row('Power', Result.Standby ? Pill('warning', 'Standby') : Pill('success', 'Operative'))
      : null,
    Reachable && Result.AlarmsRead
      ? Row(
          'Amplifier alarms',
          GlobalAlarms.length
            ? GlobalAlarms.map((Name) => Pill('danger', Name)).join(' ')
            : Pill('success', 'None')
        )
      : null,
  ]);
  if (!Reachable) {
    return (
      Head +
      '<div class="mt-2">' +
      Note(
        `Failed to reach the amplifier on UDP ${Config.Port}. Check that ShowTrak can reach it on the network and that nothing blocks UDP ${Config.Port}.`
      ) +
      '</div>'
    );
  }

  const Channels = Array.isArray(Result.Channels) ? (Result.Channels as PowersoftChannel[]) : [];
  if (!Channels.length) return Head;
  const Cards = Channels.map((C) =>
    Card({
      Title: `Ch ${C.Channel}`,
      Badge: ChannelBadge(C),
      BodyHtml:
        C.GainDb != null
          ? `<div class="text-muted small">Output gain ${Esc(C.GainDb.toFixed(2))} dB</div>`
          : '',
    })
  ).join('');
  return Head + `<div class="d-grid gap-1 mt-2">${Cards}</div>`;
}

export const Name = 'Powersoft Amplifier';
export const Description =
  'Queries a Powersoft X Series or Canali DSP amplifier (Duecanali, Quattrocanali, Ottocanali) over its UDP control protocol (port 1234) for the model, serial, standby state, alarms and output mutes. Optionally flags standby, amplifier faults, channel faults, input clip, muted outputs or a different serial number. The check never changes a setting; the actions switch standby and mute or unmute outputs.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseConfig,
  ParseHealthOptions,
  ParseChannelList,
  Crc16,
  BuildFrame,
  ParseFrame,
  ParseInfo,
  ParseStandby,
  ParseReadGm,
  ParseAlarms2,
  GlobalAlarmNames,
  ChannelFaultNames,
  EvaluateHealth,
  QueryPowersoft,
  ParseChannelParam,
};
export { ID, Settings, Actions, Run, RunAction, GetActionOptions, DescribeAction, Debug };
