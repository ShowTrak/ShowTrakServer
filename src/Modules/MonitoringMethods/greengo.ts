// Green-GO intercom check (wired Green-GO devices running the OSC remote script).
//
// Green-GO devices have no built-in status protocol. Green-GO's documented
// route for external control is a device script: "osc-remote.gg5t", published
// with Bitfocus Companion's companion-module-greengo-intercom and described in
// the Green-GO manual's Companion guide. Loaded on a device (firmware
// 5.0.3.0255 or later), the script:
//
//   - opens OSC on UDP `controlPort` (8000 in the published script) and sends
//     everything to `remoteIP:controlPort`;
//   - sends `/ggo/state/heartbeat 1` every 3 s;
//   - answers `/ggo/cmd/update 1` with the full state, then `/ggo/state/updated 1`;
//   - reports per channel (1–6), args [value, channel]:
//       /ggo/state/channel/talk | call | cue | listen | level
//       /ggo/state/channel/input        0 = no members, 1 = members, 3 = VOX active
//       /ggo/state/channel/input/call
//   - and per device, args [value]: /ggo/state/level/main | pgm | direct,
//     /ggo/state/audio/gain | source, /ggo/state/mode/isolate.
//
// So ShowTrak runs ONE process-wide UDP listener per port (the script's
// controlPort), keeps the latest state per sending device, and each Run() asks
// its device for a fresh state with `/ggo/cmd/update 1`, the script's own
// documented read request. Online = the device answered that, or its heartbeat
// arrived within the grace period. A listener nobody has asked about for
// MONITORING_INTEREST_TTL_MS is closed.
//
// The script also accepts commands (talk, call, levels, identify). This check
// sends nothing but the update request, so it never changes the device.
import dgram from 'dgram';
import { Card, FormatLatency, Note, Pill, Row, Rows, TextRow } from './debug';
import { EncodeOscMessage, ParseOscPacket } from './_osc-shared';
import type { OscMessage } from './_osc-shared';
import { DEFAULT_MONITORING_INTERVAL_MS, MONITORING_INTEREST_TTL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'greengo';

const DEFAULT_PORT = 8000;
const DEFAULT_TIMEOUT_MS = 3000;
// The script's heartbeat is every 3 s; three missed beats is a real outage.
const DEFAULT_GRACE_MS = 10000;
const MAX_CHANNEL = 32;
const MAX_SOURCES = 256;
const SOURCE_RETENTION_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30000;
const RETRY_COOLDOWN_MS = 15000;
const BIND_WAIT_MS = 1000;

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'Control port',
    Type: 'number',
    Default: DEFAULT_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
    Note: 'The controlPort set in the device’s OSC remote script. ShowTrak listens on it and sends to the device on it.',
  },
  {
    Key: 'RequireMembers',
    Label: 'Channels that need members',
    Type: 'list',
    ItemType: 'number',
    Default: [],
    Note: 'Script channel numbers (1–6). Report Degraded when one of them has no members. Leave empty to only check the device is online.',
  },
  {
    Key: 'DevicePort',
    Label: 'Device port',
    Type: 'number',
    Default: 0,
    Min: 0,
    Max: 65535,
    Advanced: true,
    Note: 'Only for an edited script that listens on a different port from the one it sends to. 0 uses the control port.',
  },
  {
    Key: 'GracePeriodMs',
    Label: 'Grace period (ms)',
    Type: 'number',
    Default: DEFAULT_GRACE_MS,
    Min: 3000,
    Max: 120000,
    Advanced: true,
    Note: 'How recent the script’s heartbeat (every 3 seconds) must be to count as online when the device does not answer the state request in time.',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: DEFAULT_TIMEOUT_MS,
    Min: 500,
    Max: 30000,
    Advanced: true,
    Note: 'How long to wait for the device to answer the state request.',
  },
];

// --- Config -----------------------------------------------------------------

interface GreenGoConfig {
  Address: string;
  Port: number;
  DevicePort: number;
  RequireMembers: number[];
  GraceMs: number;
  TimeoutMs: number;
}

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
    if (Number.isInteger(N) && N >= 1 && N <= MAX_CHANNEL) Out.add(N);
  }
  return [...Out].sort((A, B) => A - B);
}

function ParseConfig(Target: MonitoringTargetLike): GreenGoConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number(Cfg.Port);
  const DevicePort = Number(Cfg.DevicePort);
  const Grace = Number(Cfg.GracePeriodMs);
  const Timeout = Number(Cfg.Timeout);
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Port: Number.isFinite(Port) && Port > 0 ? Math.trunc(Port) : DEFAULT_PORT,
    DevicePort:
      Number.isInteger(DevicePort) && DevicePort >= 1 && DevicePort <= 65535 ? DevicePort : 0,
    RequireMembers: ParseChannelList(Cfg.RequireMembers),
    GraceMs: Number.isFinite(Grace) && Grace > 0 ? Math.max(3000, Grace) : DEFAULT_GRACE_MS,
    TimeoutMs:
      Number.isFinite(Timeout) && Timeout > 0 ? Math.max(500, Timeout) : DEFAULT_TIMEOUT_MS,
  };
}

export function NormalizeAddress(Address: unknown): string {
  return String(Address == null ? '' : Address)
    .trim()
    .replace(/^::ffff:/i, '')
    .toLowerCase();
}

// --- State model --------------------------------------------------------------

export interface GreenGoSource {
  Address: string;
  LastSeenAt: number;
  LastHeartbeatAt: number | null;
  // When the last full state dump (`/ggo/state/updated`) finished.
  UpdatedAt: number | null;
  // Device-level values keyed by the path after /ggo/state/ ('level/main', ...).
  Device: Record<string, number>;
  // Channel -> property ('talk', 'call', 'input', 'input/call', ...) -> value.
  Channels: Record<number, Record<string, number>>;
}

function NewSource(Address: string, Now: number): GreenGoSource {
  return {
    Address,
    LastSeenAt: Now,
    LastHeartbeatAt: null,
    UpdatedAt: null,
    Device: {},
    Channels: {},
  };
}

function NumArg(Value: unknown): number | null {
  if (typeof Value === 'number' && Number.isFinite(Value)) return Value;
  if (typeof Value === 'boolean') return Value ? 1 : 0;
  return null;
}

const DEVICE_PATHS = new Set([
  'level/main',
  'level/pgm',
  'level/direct',
  'audio/gain',
  'audio/source',
  'mode/isolate',
]);
const CHANNEL_PROPS = new Set(['talk', 'call', 'cue', 'listen', 'level', 'input', 'input/call']);

// Apply one OSC message to a source. Returns true for any recognised Green-GO
// state message (only those count as the device being alive). Pure apart from
// mutating Source.
function ApplyMessage(Source: GreenGoSource, Msg: OscMessage, Now: number): boolean {
  if (!Msg.Address.startsWith('/ggo/state/')) return false;
  const Path = Msg.Address.slice('/ggo/state/'.length);
  if (Path === 'heartbeat') {
    Source.LastHeartbeatAt = Now;
  } else if (Path === 'updated') {
    Source.UpdatedAt = Now;
  } else if (Path.startsWith('channel/')) {
    const Prop = Path.slice('channel/'.length);
    const Value = NumArg(Msg.Args[0]);
    const Channel = NumArg(Msg.Args[1]);
    if (!CHANNEL_PROPS.has(Prop) || Value == null || Channel == null) return false;
    if (!Number.isInteger(Channel) || Channel < 1 || Channel > MAX_CHANNEL) return false;
    (Source.Channels[Channel] ??= {})[Prop] = Value;
  } else if (DEVICE_PATHS.has(Path)) {
    const Value = NumArg(Msg.Args[0]);
    if (Value == null) return false;
    Source.Device[Path] = Value;
  } else {
    return false;
  }
  Source.LastSeenAt = Now;
  return true;
}

// --- Listener -------------------------------------------------------------------

type Waiter = (Source: GreenGoSource) => void;

interface PortListener {
  Port: number;
  Socket: dgram.Socket | null;
  State: 'binding' | 'ready' | 'failed';
  LastError: string | null;
  LastFailAt: number;
  LastInterestAt: number;
  Sources: Map<string, GreenGoSource>;
  Waiters: Set<Waiter>;
  ReadyWaiters: Set<() => void>;
}

class GreenGoReceiverImpl {
  private Ports = new Map<number, PortListener>();
  private SweepTimer: ReturnType<typeof setInterval> | null = null;

  // Register interest in a port, binding it if needed, and resolve once the
  // socket is listening (or has failed, or BIND_WAIT_MS passed).
  async Observe(Port: number): Promise<PortListener> {
    let Listener = this.Ports.get(Port);
    if (!Listener) {
      Listener = {
        Port,
        Socket: null,
        State: 'failed',
        LastError: null,
        LastFailAt: 0,
        LastInterestAt: Date.now(),
        Sources: new Map(),
        Waiters: new Set(),
        ReadyWaiters: new Set(),
      };
      this.Ports.set(Port, Listener);
    }
    Listener.LastInterestAt = Date.now();
    this.EnsureSweep();
    this.EnsureBound(Listener);
    if (Listener.State === 'binding') {
      const L = Listener;
      await new Promise<void>((resolve) => {
        const Done = () => {
          clearTimeout(Timer);
          L.ReadyWaiters.delete(Done);
          resolve();
        };
        const Timer = setTimeout(Done, BIND_WAIT_MS);
        L.ReadyWaiters.add(Done);
      });
    }
    return Listener;
  }

  private EnsureBound(Listener: PortListener): void {
    if (Listener.State === 'ready' || Listener.State === 'binding') return;
    if (Listener.LastFailAt && Date.now() - Listener.LastFailAt < RETRY_COOLDOWN_MS) return;
    Listener.State = 'binding';
    Listener.LastError = null;

    let Sock: dgram.Socket;
    try {
      Sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch (Err) {
      this.Fail(Listener, Err);
      return;
    }
    Listener.Socket = Sock;
    Sock.on('error', (Err: Error) => {
      if (Listener.Socket === Sock) this.Fail(Listener, Err);
      try {
        Sock.close();
      } catch {
        // already closing
      }
    });
    Sock.on('message', (Msg: Buffer, RInfo: dgram.RemoteInfo) => {
      try {
        this.HandleMessage(Listener, Msg, RInfo);
      } catch {
        // A malformed datagram must never escape into the main process.
      }
    });
    Sock.on('listening', () => {
      if (Listener.Socket !== Sock) return;
      Listener.State = 'ready';
      this.WakeReady(Listener);
    });
    try {
      Sock.bind(Listener.Port);
      // Don't keep the event loop (or a test process) alive on our account.
      Sock.unref();
    } catch (Err) {
      this.Fail(Listener, Err);
      try {
        Sock.close();
      } catch {
        // ignore
      }
    }
  }

  private WakeReady(Listener: PortListener): void {
    for (const Wake of [...Listener.ReadyWaiters]) Wake();
  }

  private Fail(Listener: PortListener, Err: unknown): void {
    Listener.LastError = Err && (Err as Error).message ? (Err as Error).message : String(Err);
    Listener.LastFailAt = Date.now();
    Listener.State = 'failed';
    Listener.Socket = null;
    this.WakeReady(Listener);
  }

  private HandleMessage(Listener: PortListener, Msg: Buffer, RInfo: dgram.RemoteInfo): void {
    const Address = NormalizeAddress(RInfo && RInfo.address);
    if (!Address) return;
    const Messages = ParseOscPacket(Msg);
    if (!Messages.length) return;
    const Now = Date.now();
    let Source = Listener.Sources.get(Address);
    const IsNew = !Source;
    if (!Source) Source = NewSource(Address, Now);
    let Recognised = false;
    for (const M of Messages) if (ApplyMessage(Source, M, Now)) Recognised = true;
    if (!Recognised) return;
    if (IsNew) {
      if (Listener.Sources.size >= MAX_SOURCES) return;
      Listener.Sources.set(Address, Source);
    }
    for (const Wake of [...Listener.Waiters]) Wake(Source);
  }

  // Send the documented state request to a device from the listening socket,
  // so the reply's destination port is the one we listen on.
  Send(
    Listener: PortListener,
    Address: string,
    Port: number,
    Packet: Buffer
  ): Promise<string | null> {
    return new Promise((resolve) => {
      const Sock = Listener.Socket;
      if (!Sock || Listener.State !== 'ready') return resolve('Listener not ready');
      try {
        Sock.send(Packet, Port, Address, (Err) => resolve(Err ? Err.message : null));
      } catch (Err) {
        resolve(Err instanceof Error ? Err.message : String(Err));
      }
    });
  }

  // Resolve with the target's source once Predicate holds, or null at the deadline.
  WaitFor(
    Listener: PortListener,
    Address: string,
    Predicate: (Source: GreenGoSource) => boolean,
    TimeoutMs: number
  ): Promise<GreenGoSource | null> {
    return new Promise((resolve) => {
      const Existing = Listener.Sources.get(Address);
      if (Existing && Predicate(Existing)) return resolve(Existing);
      const Waiter: Waiter = (Source) => {
        if (Source.Address !== Address || !Predicate(Source)) return;
        clearTimeout(Timer);
        Listener.Waiters.delete(Waiter);
        resolve(Source);
      };
      const Timer = setTimeout(() => {
        Listener.Waiters.delete(Waiter);
        resolve(null);
      }, TimeoutMs);
      Listener.Waiters.add(Waiter);
    });
  }

  private EnsureSweep(): void {
    if (this.SweepTimer) return;
    this.SweepTimer = setInterval(() => this.Sweep(), SWEEP_INTERVAL_MS);
    if (typeof this.SweepTimer.unref === 'function') this.SweepTimer.unref();
  }

  Sweep(Now = Date.now()): void {
    for (const [Port, Listener] of this.Ports) {
      if (Now - Listener.LastInterestAt > MONITORING_INTEREST_TTL_MS) {
        if (Listener.Socket) {
          try {
            Listener.Socket.close();
          } catch {
            // ignore
          }
        }
        this.Ports.delete(Port);
        continue;
      }
      for (const [Addr, Src] of Listener.Sources) {
        if (Now - Src.LastSeenAt > SOURCE_RETENTION_MS) Listener.Sources.delete(Addr);
      }
    }
    if (!this.Ports.size && this.SweepTimer) {
      clearInterval(this.SweepTimer);
      this.SweepTimer = null;
    }
  }

  // Test-only.
  PortCount(): number {
    return this.Ports.size;
  }

  // Test-only teardown.
  Stop(): void {
    if (this.SweepTimer) {
      clearInterval(this.SweepTimer);
      this.SweepTimer = null;
    }
    for (const Listener of this.Ports.values()) {
      if (Listener.Socket) {
        try {
          Listener.Socket.close();
        } catch {
          // ignore
        }
      }
    }
    this.Ports.clear();
  }
}

const Receiver = new GreenGoReceiverImpl();

// --- Evaluation ---------------------------------------------------------------

export function MembersText(Value: number | undefined): string {
  if (Value == null) return '-';
  if (Value === 0) return 'No members';
  if (Value === 1) return 'Members';
  if (Value === 3) return 'VOX active';
  return `State ${Value}`;
}

// Reasons for the configured member requirements. A channel the device has
// not reported is not judged; nothing is known about it. Pure.
export function EvaluateMembers(Source: GreenGoSource, Required: number[]): string[] {
  const Reasons: string[] = [];
  for (const Ch of Required) {
    const State = Source.Channels[Ch]?.input;
    if (State === 0) Reasons.push(`Ch ${Ch}: no members`);
  }
  return Reasons;
}

// --- Run ------------------------------------------------------------------------

function SnapshotSource(Source: GreenGoSource): GreenGoSource {
  return {
    ...Source,
    Device: { ...Source.Device },
    Channels: Object.fromEntries(
      Object.entries(Source.Channels).map(([K, V]) => [K, { ...V }])
    ) as Record<number, Record<string, number>>,
  };
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Success: false, Error: `Invalid port: ${Config.Port}` };
  }
  const Address = NormalizeAddress(Config.Address);

  const Listener = await Receiver.Observe(Config.Port);
  if (Listener.State !== 'ready') {
    return {
      Success: false,
      Error: `Failed to listen on UDP ${Config.Port}: ${Listener.LastError || 'socket not ready'}`,
    };
  }

  const AskedAt = Date.now();
  const SendError = await Receiver.Send(
    Listener,
    Config.Address,
    Config.DevicePort || Config.Port,
    EncodeOscMessage('/ggo/cmd/update', [{ Int: 1 }])
  );
  const Answered = SendError
    ? null
    : await Receiver.WaitFor(
        Listener,
        Address,
        (S) => S.UpdatedAt != null && S.UpdatedAt >= AskedAt,
        Config.TimeoutMs
      );

  const Now = Date.now();
  const Source = Listener.Sources.get(Address) ?? null;
  const Fresh = !!Source && Now - Source.LastSeenAt <= Config.GraceMs;
  if (!Answered && !Fresh) {
    const Others = [...Listener.Sources.values()]
      .filter((S) => Now - S.LastSeenAt <= Config.GraceMs)
      .map((S) => S.Address);
    return {
      Success: false,
      Error: SendError
        ? `Failed to send the state request: ${SendError}`
        : Others.length
          ? `No reply from ${Config.Address}; Green-GO OSC is arriving from ${Others.slice(0, 3).join(', ')}`
          : `No reply from ${Config.Address} within ${Config.TimeoutMs}ms`,
      ListenPort: Config.Port,
    };
  }

  const Live = SnapshotSource((Answered ?? Source) as GreenGoSource);
  const Reasons = EvaluateMembers(Live, Config.RequireMembers);
  return {
    Success: true,
    LatencyMs: Answered && Answered.UpdatedAt != null ? Answered.UpdatedAt - AskedAt : null,
    StateRefreshed: !!Answered,
    HeartbeatAgeMs: Live.LastHeartbeatAt != null ? Now - Live.LastHeartbeatAt : null,
    ListenPort: Config.Port,
    Device: Live.Device,
    Channels: Live.Channels,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
  };
}

// --- Debug ----------------------------------------------------------------------

function OnOff(Value: number | undefined, On = 'On', Off = 'Off'): string | null {
  if (Value == null) return null;
  return Value ? On : Off;
}

function ChannelCard(Ch: number, Props: Record<string, number>, Required: boolean): string {
  const Members = Props.input;
  const Badge =
    Required && Members === 0
      ? Pill('warning', 'No members')
      : Members === 3
        ? Pill('success', 'VOX active')
        : Members === 1
          ? Pill('success', 'Members')
          : Pill('muted', MembersText(Members));
  const Flags = (
    [
      ['talk', 'talking'],
      ['call', 'call'],
      ['input/call', 'incoming call'],
      ['cue', 'cue'],
    ] as const
  )
    .filter(([Key]) => !!Props[Key])
    .map(([, Text]) => Text);
  const Body = Rows([
    TextRow('Listen', OnOff(Props.listen) ?? '-'),
    Props.level != null ? TextRow('Level', String(Props.level)) : null,
    Flags.length ? TextRow('Active', Flags.join(', ')) : null,
  ]);
  return Card({
    Title: Required ? `Ch ${Ch} (monitored)` : `Ch ${Ch}`,
    Badge,
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
  const Device = (Result && (Result.Device as Record<string, number>)) || {};
  const Age = Number(Result && Result.HeartbeatAgeMs);

  const Head = Rows([
    TextRow('Device', Config.Address || '-'),
    TextRow(
      'Control port',
      Config.DevicePort && Config.DevicePort !== Config.Port
        ? `UDP ${Config.Port} (device listens on ${Config.DevicePort})`
        : `UDP ${Config.Port}`
    ),
    Row('Status', StatusPill),
    Online
      ? TextRow(
          'State request',
          Result.StateRefreshed ? 'Answered' : 'Not answered in time (online by heartbeat)'
        )
      : null,
    Online && Number.isFinite(Age)
      ? TextRow('Last heartbeat', `${(Age / 1000).toFixed(1)} s ago`)
      : null,
    Online && Result.LatencyMs != null
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : null,
    Online && OnOff(Device['mode/isolate'])
      ? TextRow('Isolate', OnOff(Device['mode/isolate']))
      : null,
    Online && Device['level/main'] != null
      ? TextRow('Main level', String(Device['level/main']))
      : null,
    Online && Device['level/pgm'] != null
      ? TextRow('Programme level', String(Device['level/pgm']))
      : null,
    Online && Degraded && Result.DegradedReason
      ? TextRow('Reason', String(Result.DegradedReason))
      : null,
    !Online ? TextRow('Error', (Result && Result.Error) || 'Failed to reach the device') : null,
  ]);
  if (!Online) {
    return (
      Head +
      '<div class="mt-2">' +
      Note(
        'The device must run the Green-GO OSC remote script with remoteIP set to this computer and controlPort set to this port.'
      ) +
      '</div>'
    );
  }
  const Channels = (Result.Channels as Record<string, Record<string, number>>) || {};
  const Numbers = Object.keys(Channels)
    .map(Number)
    .filter((N) => Number.isInteger(N))
    .sort((A, B) => A - B);
  if (!Numbers.length)
    return Head + '<div class="mt-2">' + Note('No channel state reported yet') + '</div>';
  const Required = new Set(Config.RequireMembers);
  return (
    Head +
    `<div class="text-muted small mt-2 mb-1">Channels (${Numbers.length})</div>` +
    `<div class="d-grid gap-1">${Numbers.map((N) => ChannelCard(N, Channels[N] ?? {}, Required.has(N))).join('')}</div>`
  );
}

export const Name = 'Green-GO Intercom';
export const Description =
  'Checks a wired Green-GO device running the Green-GO OSC remote script: asks for its state over OSC (UDP) and listens for its heartbeat. It reports channel members, talk, call and listen states, and Degraded when a channel that needs members has none. Read-only: it sends only the script’s state request.';
export const Group = 'Sound';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  Receiver,
  ParseConfig,
  ParseChannelList,
  ApplyMessage,
  NewSource,
  EvaluateMembers,
  MembersText,
};
export { ID, Settings, Run, Debug };
