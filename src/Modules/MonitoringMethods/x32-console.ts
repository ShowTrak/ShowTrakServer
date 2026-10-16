// Behringer X32 / Midas M32 (and Behringer X-Air / Midas MR) mixer check over
// the console's native OSC-over-UDP remote protocol.
//
// Protocol (Patrick-Gilles Maillot, "Unofficial X32/M32 OSC Remote Protocol",
// cross-checked against Bitfocus companion-module-behringer-x32):
//   - X32/M32 listen on UDP 10023; X-Air (XR12/16/18) and MR mixers on 10024.
//   - The console replies to the IP and port the request came FROM, so one
//     ephemeral socket per probe is enough — nothing has to be bound to a fixed
//     port and two checks never fight over one.
//   - `/xinfo` (no args) -> `/xinfo ,ssss <ip> <network name> <model> <firmware>`
//     e.g. `192.168.1.62`, `X32-02-4A-53`, `X32`, `3.04`. Models seen in the
//     wild: X32, X32RACK, X32C, X32P, X32CORE, M32, M32C, M32R, XR18, XR16, XR12
//     (MR18/MR12 are the Midas twins of the XR range).
//   - `/status` -> `/status ,sss active <ip> <name>`; informational only.
//   - Any parameter address sent with no arguments is a READ: the console
//     answers with the same address and the current value. Mute is an "on"
//     switch: `/main/st/mix/on` (X32/M32 main stereo) or `/lr/mix/on` (X-Air/MR)
//     and `/ch/NN/mix/on` (zero-padded channel) answer `,i 1` when the channel is
//     ON (unmuted) and `,i 0` when muted. `/ch/NN/config/name` answers `,s` with
//     the scribble-strip name (blank by default).
//
// Design:
//   - UDP is lossy, so every unanswered query is re-sent on a short interval
//     until it is answered or the whole-probe deadline (the configured Timeout)
//     passes. Reads are idempotent, so a duplicate is harmless.
//   - Replies can arrive in any order and are matched by OSC address, never by
//     arrival order.
//   - `/xinfo` is the fingerprint: the reply's model decides which family's
//     address map the assertion reads use, so a single check type covers both
//     families without asking the operator which one they have.
//   - Nothing is ever written to the console and `/xremote` is never sent, so
//     the console does not start pushing updates at us.
//   - A mute group or DCA mute does NOT change a channel's `mix/on` — the
//     console keeps the two separate — so the channel check reports the
//     channel's own mute button only.
import dgram from 'dgram';
import net from 'net';
import { EncodeOscMessage, ParseOscPacket, type OscMessage } from './_osc-shared';
import { ErrorMessage } from './_tcp-session';
import { Card, FormatLatency, Note, Pill, Row, Rows, TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'x32-console';

export const DEFAULT_X32_PORT = 10023;
export const DEFAULT_XAIR_PORT = 10024;
const DEFAULT_TIMEOUT_MS = 4000;
// How often an unanswered query is sent again. A quarter of the budget gives a
// lost datagram three more chances without flooding a busy console.
const MIN_RESEND_MS = 250;

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'OSC port',
    Type: 'number',
    Default: DEFAULT_X32_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
    Note: 'X32 and M32 consoles listen on UDP 10023. X-Air and MR mixers listen on UDP 10024.',
  },
  {
    Key: 'CheckName',
    Label: 'Check console name',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded when a different console answers on this address.',
  },
  {
    Key: 'ExpectedName',
    Label: 'Expected console name',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'CheckName', Equals: true },
    Note: 'The network name shown under Setup → Network, e.g. X32-02-4A-53. Not case-sensitive.',
  },
  {
    Key: 'CheckMainMute',
    Label: 'Check main mute',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded while the main stereo bus is muted (Main LR on X32/M32, LR on X-Air/MR).',
  },
  {
    Key: 'CheckChannelMutes',
    Label: 'Check channel mutes',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded while any listed input channel is muted.',
  },
  {
    Key: 'MonitoredChannels',
    Label: 'Input channels',
    Type: 'list',
    ItemType: 'number',
    Default: [],
    VisibleWhen: { Key: 'CheckChannelMutes', Equals: true },
    Note: 'Channel numbers: 1–32 on X32/M32, 1–16 on X-Air/MR. Mute groups and DCA mutes are not reflected.',
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

export interface X32Config {
  Address: string;
  Port: number;
  TimeoutMs: number;
}

function ParseConfig(Target: MonitoringTargetLike): X32Config {
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number(Cfg.Port);
  const Timeout = Number(Cfg.Timeout);
  return {
    Address: String((Target && Target.Address) || '').trim(),
    Port: Number.isFinite(Port) && Port > 0 ? Math.floor(Port) : DEFAULT_X32_PORT,
    TimeoutMs: Number.isFinite(Timeout) && Timeout > 0 ? Math.floor(Timeout) : DEFAULT_TIMEOUT_MS,
  };
}

interface HealthOptions {
  CheckName: boolean;
  ExpectedName: string;
  CheckMainMute: boolean;
  CheckChannelMutes: boolean;
  Channels: number[];
}

// Coerce the channel list to unique positive integers, in the order given.
// Out-of-range numbers are kept: whether channel 20 exists depends on the model,
// which only the probe knows, and EvaluateHealth says so by name.
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

function ParseHealthOptions(Target: MonitoringTargetLike): HealthOptions {
  const Cfg = (Target && Target.Settings) || {};
  return {
    CheckName: !!Cfg.CheckName,
    ExpectedName: String(Cfg.ExpectedName || '').trim(),
    CheckMainMute: !!Cfg.CheckMainMute,
    CheckChannelMutes: !!Cfg.CheckChannelMutes,
    Channels: ParseChannelList(Cfg.MonitoredChannels),
  };
}

// --- Address map --------------------------------------------------------------

export type X32Family = 'x32' | 'xair';

// X-Air and MR models report XR../MR..; everything else on this protocol (X32
// variants and all M32s) uses the X32 address map.
function FamilyOfModel(Model: string | null): X32Family {
  return /^(XR|MR)/i.test(String(Model || '').trim()) ? 'xair' : 'x32';
}

function ChannelCount(Family: X32Family): number {
  return Family === 'xair' ? 16 : 32;
}

function MainMutePath(Family: X32Family): string {
  return Family === 'xair' ? '/lr/mix/on' : '/main/st/mix/on';
}

function Pad2(N: number): string {
  return N < 10 ? `0${N}` : String(N);
}

function ChannelOnPath(Channel: number): string {
  return `/ch/${Pad2(Channel)}/mix/on`;
}

function ChannelNamePath(Channel: number): string {
  return `/ch/${Pad2(Channel)}/config/name`;
}

// An OSC "on" switch value as a boolean. The console sends int32; a float or
// T/F is accepted defensively. Anything else is unknown.
function ParseOnSwitch(Arg: unknown): boolean | null {
  if (typeof Arg === 'boolean') return Arg;
  if (typeof Arg === 'number' && Number.isFinite(Arg)) return Arg !== 0;
  return null;
}

// Decode an `/xinfo` reply. Null unless it carries the four strings a console
// sends — that shape is the fingerprint. The first string is the console's IP
// on X32 firmware; some X-Air firmware is reported to put the OSC server
// version (e.g. V0.04) there instead, so it is only kept when it is an IP.
// Name, model and firmware sit at the same positions either way.
function ParseXinfo(
  Msg: OscMessage
): { Ip: string; Name: string; Model: string; Firmware: string } | null {
  if (Msg.Address !== '/xinfo' || Msg.Args.length < 4) return null;
  const [Ip, Name, Model, Firmware] = Msg.Args;
  if (
    typeof Ip !== 'string' ||
    typeof Name !== 'string' ||
    typeof Model !== 'string' ||
    typeof Firmware !== 'string' ||
    !Model.trim()
  ) {
    return null;
  }
  return {
    Ip: net.isIP(Ip.trim()) ? Ip.trim() : '',
    Name: Name.trim(),
    Model: Model.trim(),
    Firmware: Firmware.trim(),
  };
}

// --- Probe ------------------------------------------------------------------

export interface X32ChannelState {
  Channel: number;
  // Whether the channel exists on the console that answered.
  Supported: boolean;
  Name: string | null;
  // true = channel on (unmuted), false = muted, null = not read.
  On: boolean | null;
}

export interface X32Snapshot {
  LatencyMs: number;
  // /xinfo answered with the four-string console shape.
  IsConsole: boolean;
  ReportedIp: string | null;
  ConsoleName: string | null;
  Model: string | null;
  Firmware: string | null;
  Family: X32Family | null;
  StatusState: string | null;
  // Main stereo bus "on" (true = unmuted). Null when not asked for or unanswered.
  MainOn: boolean | null;
  Channels: X32ChannelState[];
}

export type X32ProbeOutcome =
  | { Reachable: true; Snapshot: X32Snapshot }
  | { Reachable: false; Error: string; Refused: boolean };

export interface X32ProbeWants {
  MainMute: boolean;
  Channels: number[];
}

export function QueryX32(Config: X32Config, Wants: X32ProbeWants): Promise<X32ProbeOutcome> {
  const BudgetMs = Math.max(500, Config.TimeoutMs | 0);
  const ResendMs = Math.max(MIN_RESEND_MS, Math.floor(BudgetMs / 4));

  return new Promise<X32ProbeOutcome>((Resolve) => {
    let Settled = false;
    let StartedAt = Date.now();
    let XinfoAt: number | null = null;
    let AnyReply = false;
    const Snap: X32Snapshot = {
      LatencyMs: 0,
      IsConsole: false,
      ReportedIp: null,
      ConsoleName: null,
      Model: null,
      Firmware: null,
      Family: null,
      StatusState: null,
      MainOn: null,
      Channels: [],
    };
    // OSC addresses still awaiting a reply; each is re-sent until answered.
    const Pending = new Set<string>();
    let Socket: dgram.Socket | null = null;
    let ResendTimer: ReturnType<typeof setInterval> | null = null;
    let DeadlineTimer: ReturnType<typeof setTimeout> | null = null;

    const Finish = (Outcome: X32ProbeOutcome): void => {
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

    const Reached = (): X32ProbeOutcome => {
      Snap.LatencyMs = (XinfoAt ?? Date.now()) - StartedAt;
      return { Reachable: true, Snapshot: Snap };
    };

    const Send = (Address: string): void => {
      if (!Socket || Settled) return;
      try {
        Socket.send(EncodeOscMessage(Address));
      } catch {
        // A send on a socket that errored is reported by the 'error' handler.
      }
    };

    // Done once the fingerprint is in and every follow-up read has answered.
    // /status is informational, so it is never waited for.
    const MaybeDone = (): void => {
      if (XinfoAt == null) return;
      for (const Address of Pending) if (Address !== '/status') return;
      Finish(Reached());
    };

    const OnXinfo = (Info: NonNullable<ReturnType<typeof ParseXinfo>>): void => {
      if (XinfoAt != null) return; // a re-sent /xinfo answered twice
      XinfoAt = Date.now();
      Snap.IsConsole = true;
      Snap.ReportedIp = Info.Ip || null;
      Snap.ConsoleName = Info.Name || null;
      Snap.Model = Info.Model;
      Snap.Firmware = Info.Firmware || null;
      const Family = FamilyOfModel(Info.Model);
      Snap.Family = Family;
      const Followups: string[] = [];
      if (Wants.MainMute) Followups.push(MainMutePath(Family));
      for (const Channel of Wants.Channels) {
        const Supported = Channel <= ChannelCount(Family);
        Snap.Channels.push({ Channel, Supported, Name: null, On: null });
        if (Supported) Followups.push(ChannelOnPath(Channel), ChannelNamePath(Channel));
      }
      for (const Address of Followups) {
        Pending.add(Address);
        Send(Address);
      }
    };

    const OnMessage = (Msg: OscMessage): void => {
      if (Msg.Address === '/xinfo') {
        const Info = ParseXinfo(Msg);
        if (Info) {
          Pending.delete('/xinfo');
          OnXinfo(Info);
        }
        return;
      }
      if (!Pending.has(Msg.Address)) return; // stale duplicate or unsolicited
      if (Msg.Address === '/status') {
        const State = Msg.Args[0];
        if (typeof State === 'string') Snap.StatusState = State;
        Pending.delete('/status');
        return;
      }
      if (Snap.Family && Msg.Address === MainMutePath(Snap.Family)) {
        Snap.MainOn = ParseOnSwitch(Msg.Args[0]);
        Pending.delete(Msg.Address);
        return;
      }
      const ChannelMatch = /^\/ch\/(\d{2})\/(mix\/on|config\/name)$/.exec(Msg.Address);
      if (ChannelMatch) {
        const Channel = Number(ChannelMatch[1]);
        const Entry = Snap.Channels.find((C) => C.Channel === Channel);
        if (Entry) {
          if (ChannelMatch[2] === 'mix/on') Entry.On = ParseOnSwitch(Msg.Args[0]);
          else if (typeof Msg.Args[0] === 'string') Entry.Name = Msg.Args[0].trim() || null;
        }
        Pending.delete(Msg.Address);
      }
    };

    try {
      Socket = dgram.createSocket(net.isIPv6(Config.Address) ? 'udp6' : 'udp4');
    } catch (Err) {
      Finish({ Reachable: false, Error: ErrorMessage(Err), Refused: false });
      return;
    }

    Socket.on('error', (Err: NodeJS.ErrnoException) => {
      const Code = Err && Err.code;
      // ICMP port-unreachable surfaces as ECONNREFUSED on a connected UDP socket:
      // the host is up, nothing is listening. Once the fingerprint is in, a
      // late error cannot unmake it.
      if (XinfoAt != null) {
        Finish(Reached());
        return;
      }
      Finish({
        Reachable: false,
        Error: ErrorMessage(Err),
        Refused: Code === 'ECONNREFUSED',
      });
    });

    Socket.on('message', (Buf: Buffer) => {
      if (Settled) return;
      AnyReply = true;
      for (const Msg of ParseOscPacket(Buf)) OnMessage(Msg);
      MaybeDone();
    });

    DeadlineTimer = setTimeout(() => {
      if (XinfoAt != null || AnyReply) {
        // Something answered. With /xinfo in, report what was read; without
        // it, the responder is not a console of this family.
        Finish(Reached());
        return;
      }
      Finish({
        Reachable: false,
        Error: `No reply within ${BudgetMs}ms`,
        Refused: false,
      });
    }, BudgetMs);

    try {
      // Connecting a UDP socket fixes the peer, so stray datagrams from other
      // hosts are dropped by the kernel and an ICMP unreachable is reported.
      Socket.connect(Config.Port, Config.Address, () => {
        StartedAt = Date.now();
        Pending.add('/xinfo');
        Pending.add('/status');
        Send('/xinfo');
        Send('/status');
        ResendTimer = setInterval(() => {
          for (const Address of Pending) Send(Address);
        }, ResendMs);
      });
    } catch (Err) {
      Finish({ Reachable: false, Error: ErrorMessage(Err), Refused: false });
    }
  });
}

// --- Evaluation -------------------------------------------------------------

function ChannelLabel(State: X32ChannelState): string {
  return State.Name ? `Ch ${State.Channel} (${State.Name})` : `Ch ${State.Channel}`;
}

// The reasons a reachable console is unhealthy, per the enabled toggles. Pure —
// exported via _internal for unit tests.
function EvaluateHealth(Snapshot: X32Snapshot, Options: HealthOptions): string[] {
  if (!Snapshot.IsConsole) {
    return ['Responded, but does not look like an X32 / M32 / X-Air console'];
  }
  const Reasons: string[] = [];

  if (Options.CheckName && Options.ExpectedName) {
    const Actual = String(Snapshot.ConsoleName || '').trim();
    if (Actual.toLowerCase() !== Options.ExpectedName.toLowerCase()) {
      Reasons.push(`Name "${Actual || '(blank)'}" (expected "${Options.ExpectedName}")`);
    }
  }

  if (Options.CheckMainMute) {
    const Label = Snapshot.Family === 'xair' ? 'LR' : 'Main LR';
    if (Snapshot.MainOn === false) Reasons.push(`${Label} muted`);
    else if (Snapshot.MainOn == null) Reasons.push(`Failed to read the ${Label} mute state`);
  }

  if (Options.CheckChannelMutes) {
    for (const Channel of Options.Channels) {
      const State = Snapshot.Channels.find((C) => C.Channel === Channel) || {
        Channel,
        Supported: true,
        Name: null,
        On: null,
      };
      if (!State.Supported) {
        Reasons.push(`Ch ${Channel}: not on this ${Snapshot.Model || 'console'}`);
      } else if (State.On === false) {
        Reasons.push(`${ChannelLabel(State)}: muted`);
      } else if (State.On == null) {
        Reasons.push(`${ChannelLabel(State)}: failed to read mute state`);
      }
    }
  }

  return Reasons;
}

// --- Run / Debug ------------------------------------------------------------

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Success: false, Error: `Invalid port: ${Config.Port}` };
  }
  const Options = ParseHealthOptions(Target);

  const Outcome = await QueryX32(Config, {
    MainMute: Options.CheckMainMute,
    Channels: Options.CheckChannelMutes ? Options.Channels : [],
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
    IsConsole: Snap.IsConsole,
    Model: Snap.Model,
    ConsoleName: Snap.ConsoleName,
    Firmware: Snap.Firmware,
    ReportedIp: Snap.ReportedIp,
    Family: Snap.Family,
    StatusState: Snap.StatusState,
    MainOn: Snap.MainOn,
    MainMuted: Snap.MainOn == null ? null : !Snap.MainOn,
    Channels: Snap.Channels,
  };
}

function StatePill(Result: MonitoringResult): string {
  const Reachable = !!(Result && Result.Success === true);
  if (Reachable && !Result.Degraded) return Pill('success', 'Online');
  if (Reachable) return Pill('warning', Result.DegradedReason || 'Degraded');
  return Pill('danger', 'Offline');
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseConfig(Target);
  const Options = ParseHealthOptions(Target);
  const Reachable = !!(Result && Result.Success === true);
  const Identity = [Result && Result.Model, Result && Result.ConsoleName]
    .filter((Part) => Part != null && String(Part).trim() !== '')
    .join(' · ');

  const Head = Rows([
    TextRow('Host', `${Config.Address || '—'}:${Config.Port}`),
    Identity ? TextRow('Console', Identity) : null,
    Reachable && Result.Firmware ? TextRow('Firmware', Result.Firmware) : null,
    Reachable && Result.ReportedIp ? TextRow('Reported IP', Result.ReportedIp) : null,
    Row('Status', StatePill(Result)),
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Failed to reach the console'),
    Reachable && Result.MainOn != null
      ? Row(
          Result.Family === 'xair' ? 'LR' : 'Main LR',
          Result.MainOn ? Pill('success', 'On') : Pill('warning', 'Muted')
        )
      : null,
  ]);
  if (!Reachable) {
    return (
      Head +
      '<div class="mt-2">' +
      Note(
        `Failed to reach the console over OSC. X-Air and MR mixers use port ${DEFAULT_XAIR_PORT}.`
      ) +
      '</div>'
    );
  }

  const Channels = Array.isArray(Result.Channels) ? (Result.Channels as X32ChannelState[]) : [];
  if (!Options.CheckChannelMutes || !Channels.length) return Head;
  const Cards = Channels.map((C) =>
    Card({
      Title: ChannelLabel(C),
      Badge: !C.Supported
        ? Pill('warning', 'Not on this model')
        : C.On === true
          ? Pill('success', 'On')
          : C.On === false
            ? Pill('warning', 'Muted')
            : Pill('muted', 'No reply'),
    })
  ).join('');
  return Head + `<div class="d-grid gap-1 mt-2">${Cards}</div>`;
}

export const Name = 'Behringer X32 / Midas M32';
export const Description =
  'Queries a Behringer X32 / Midas M32 console (UDP 10023) or an X-Air / MR mixer (UDP 10024) over its OSC remote protocol for the model, network name and firmware. Optionally flags a different console name, a muted main bus or muted input channels. Read-only: it never changes a setting on the desk.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseConfig,
  ParseHealthOptions,
  ParseChannelList,
  FamilyOfModel,
  MainMutePath,
  ChannelOnPath,
  ChannelNamePath,
  ParseOnSwitch,
  ParseXinfo,
  EvaluateHealth,
  QueryX32,
};
export { ID, Settings, Run, Debug };
