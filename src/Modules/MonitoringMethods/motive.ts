// OptiTrack Motive (motion capture) check over NatNet, Motive's UDP streaming
// and remote-command protocol. Wire details live in _natnet-shared.ts.
//
// Protocol (OptiTrack NatNet SDK 4.5: PacketClient.cpp, PythonClient
// NatNetClient.py and NatNetTypes.h, plus the "NatNet: Remote Requests/Commands"
// page):
//   - Motive listens for commands on UDP 1510 (Settings → Streaming → Command
//     Port) and answers to the address and port the request came from.
//   - NAT_CONNECT -> NAT_SERVERINFO: host application name ("Motive"), its
//     version, its NatNet version and, from NatNet 3.0, the data port and
//     whether it streams multicast (and to which group).
//   - NAT_REQUEST "<command>" -> NAT_RESPONSE: CurrentMode (int, 0 = Live,
//     1 = Edit), FrameRate (float), CurrentSessionPath (string),
//     UnitsToMillimeters (float). An unknown command gets
//     NAT_UNRECOGNIZED_REQUEST. Responses do NOT name the command they answer.
//   - NAT_REQUEST_MODELDEF -> NAT_MODELDEF: the asset list (rigid body names and
//     streaming IDs).
//   - Frames (NAT_FRAMEOFDATA): in multicast mode Motive sends them once to the
//     group (default 239.255.42.99:1511); in unicast mode it sends them to the
//     socket that sent NAT_CONNECT; both official samples handle frames on the
//     command socket for that reason, and send NAT_KEEPALIVE in unicast mode.
//
// Design:
//   - One ephemeral UDP socket per probe, deliberately NOT connect()ed: unicast
//     frames may come from Motive's data socket rather than port 1510, and a
//     connected socket would have the kernel drop them.
//   - Commands run strictly one at a time. Responses carry no request id and
//     two of them are bare 4-byte numbers, so pipelining could mis-assign an
//     answer. Each request is re-sent a few times inside the whole-probe
//     deadline (UDP loss), and every answer is sanity-checked against its
//     command (a mode is a small int, a rate is a real float) so a late
//     duplicate of the previous answer is not taken for the next one.
//   - Rigid body tracking is sampled per probe, not by a process-wide listener:
//     frames arrive at 100+ Hz, so a few hundred ms is plenty; unicast frames
//     only ever reach the socket that sent NAT_CONNECT anyway; and a
//     permanently joined multicast group would mean decoding a high-rate,
//     potentially large stream around the clock for a check that runs every
//     few seconds. A body counts as tracked if ANY sampled frame has it tracked,
//     so a momentary occlusion does not flap the check.
//   - Read-only: nothing that changes Motive's state is ever sent. NAT_CONNECT
//     asks for bitstream 0.0.0.0 ("your current version"), so the stream other
//     clients receive is untouched. In unicast mode the probe ends with
//     NAT_DISCONNECT so Motive stops sending frames to a closed port.
import dgram from 'dgram';
import net from 'net';
import os from 'os';
import {
  DEFAULT_COMMAND_PORT,
  DEFAULT_DATA_PORT,
  DEFAULT_MULTICAST_GROUP,
  DecodeResponse,
  EncodeConnect,
  EncodeRequest,
  EncodeSimple,
  FormatVersion,
  NAT_DISCONNECT,
  NAT_FRAMEOFDATA,
  NAT_KEEPALIVE,
  NAT_MODELDEF,
  NAT_REQUEST_MODELDEF,
  NAT_RESPONSE,
  NAT_SERVERINFO,
  NAT_UNRECOGNIZED_REQUEST,
  ParseFrameRigidBodies,
  ParseModelDefs,
  ParsePacket,
  ParseServerInfo,
  type ResponseKind,
  type RigidBodyDef,
  type ServerInfo,
} from './_natnet-shared';
import { ErrorMessage } from './_tcp-session';
import { Card, Esc, FormatLatency, Note, Pill, Row, Rows, TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'motive';

const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_EXPECTED_FRAME_RATE = 120;
const FRAME_RATE_TOLERANCE = 0.5;
// Re-send cadence bounds for unanswered datagrams.
const MIN_RESEND_MS = 150;
const MAX_RESEND_MS = 500;
// A command Motive never answers (an old build that silently drops it) is
// given up on after this many sends so the rest of the probe still runs.
const MAX_QUERY_ATTEMPTS = 3;
// How long frames are sampled once the first one arrives, unless every listed
// rigid body has already been seen tracked.
const FRAME_WINDOW_MS = 500;
const MAX_RIGID_BODY_ENTRIES = 64;

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'Command port',
    Type: 'number',
    Default: DEFAULT_COMMAND_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
    Note: 'Motive’s NatNet command port (Settings → Streaming → Command Port, an advanced setting). Default 1510.',
  },
  {
    Key: 'CheckLiveMode',
    Label: 'Check Live mode',
    Type: 'boolean',
    Default: true,
    Note: 'Report Degraded while Motive is in Edit mode. In Edit mode Motive plays back or edits a Take, so nothing live from the cameras is streamed.',
  },
  {
    Key: 'CheckFrameRate',
    Label: 'Check frame rate',
    Type: 'boolean',
    Default: false,
    Note: 'Report Degraded when Motive’s tracking frame rate differs from the expected rate.',
  },
  {
    Key: 'ExpectedFrameRate',
    Label: 'Expected frame rate (Hz)',
    Type: 'number',
    Default: DEFAULT_EXPECTED_FRAME_RATE,
    Min: 1,
    Max: 10000,
    VisibleWhen: { Key: 'CheckFrameRate', Equals: true },
    Note: 'The camera system frame rate set in Motive. A difference of up to 0.5 Hz is accepted.',
  },
  {
    Key: 'CheckRigidBodies',
    Label: 'Check rigid body tracking',
    Type: 'boolean',
    Default: false,
    Note: 'Report Degraded when a listed rigid body is not being tracked. Samples the live frame stream for up to half a second.',
  },
  {
    Key: 'TrackedRigidBodies',
    Label: 'Rigid bodies',
    Type: 'list',
    ItemType: 'string',
    Default: [],
    VisibleWhen: { Key: 'CheckRigidBodies', Equals: true },
    Note: 'Rigid body names as shown in Motive’s Assets pane, or their Streaming IDs. Needs Rigid Bodies turned on under Settings → Streaming. Skeleton bones are not covered.',
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

export interface MotiveConfig {
  Address: string;
  Port: number;
  TimeoutMs: number;
}

function ParseConfig(Target: MonitoringTargetLike): MotiveConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number(Cfg.Port);
  const Timeout = Number(Cfg.Timeout);
  return {
    Address: String((Target && Target.Address) || '').trim(),
    Port: Number.isFinite(Port) && Port > 0 ? Math.floor(Port) : DEFAULT_COMMAND_PORT,
    TimeoutMs: Number.isFinite(Timeout) && Timeout > 0 ? Math.floor(Timeout) : DEFAULT_TIMEOUT_MS,
  };
}

interface HealthOptions {
  CheckLiveMode: boolean;
  CheckFrameRate: boolean;
  ExpectedFrameRate: number;
  CheckRigidBodies: boolean;
  RigidBodies: string[];
}

// Trimmed, non-empty, de-duplicated (case-insensitively, as names are matched).
function ParseRigidBodyList(Value: unknown): string[] {
  const Raw = Array.isArray(Value) ? Value : Value == null || Value === '' ? [] : [Value];
  const Out: string[] = [];
  const Seen = new Set<string>();
  for (const Item of Raw) {
    const S = String(Item == null ? '' : Item).trim();
    if (!S || Seen.has(S.toLowerCase())) continue;
    Seen.add(S.toLowerCase());
    Out.push(S);
    if (Out.length >= MAX_RIGID_BODY_ENTRIES) break;
  }
  return Out;
}

function ParseHealthOptions(Target: MonitoringTargetLike): HealthOptions {
  const Cfg = (Target && Target.Settings) || {};
  const Expected = Number(Cfg.ExpectedFrameRate);
  return {
    // Defaults ON: absent means the check predates the toggle or was never edited.
    CheckLiveMode: Cfg.CheckLiveMode === undefined ? true : !!Cfg.CheckLiveMode,
    CheckFrameRate: !!Cfg.CheckFrameRate,
    ExpectedFrameRate:
      Number.isFinite(Expected) && Expected > 0 ? Expected : DEFAULT_EXPECTED_FRAME_RATE,
    CheckRigidBodies: !!Cfg.CheckRigidBodies,
    RigidBodies: ParseRigidBodyList(Cfg.TrackedRigidBodies),
  };
}

// --- Remote queries ---------------------------------------------------------

type QueryKey = 'Mode' | 'FrameRate' | 'UnitsToMillimeters' | 'SessionPath';

interface QueryDef {
  Command: string;
  Kind: ResponseKind;
  Key: QueryKey;
  // Plausibility test for an answer. Because responses are not tagged, this is
  // what stops a delayed duplicate of the previous answer being accepted.
  Accept(Value: number | string): boolean;
}

// A float response read back from an int 0/1 is zero or a denormal; a real
// rate or scale is neither.
const IsRealFloat = (V: number | string): boolean =>
  typeof V === 'number' && Number.isFinite(V) && Math.abs(V) >= 1e-6;

// Ordered so neighbours never share a reply shape (int, float, string,
// float): a late duplicate of one answer then fails the next command's shape
// or plausibility test instead of being taken for it.
const QUERIES: QueryDef[] = [
  {
    Command: 'CurrentMode',
    Kind: 'int',
    Key: 'Mode',
    Accept: (V) => typeof V === 'number' && Number.isInteger(V) && V >= 0 && V <= 255,
  },
  {
    // An int 0 / 1 (a duplicate mode answer) reads as 0 or a denormal, so a
    // real rate must be positive.
    Command: 'FrameRate',
    Kind: 'float',
    Key: 'FrameRate',
    Accept: (V) => IsRealFloat(V) && (V as number) > 0 && (V as number) <= 100000,
  },
  {
    Command: 'CurrentSessionPath',
    Kind: 'string',
    Key: 'SessionPath',
    Accept: (V) => typeof V === 'string',
  },
  {
    Command: 'UnitsToMillimeters',
    Kind: 'float',
    Key: 'UnitsToMillimeters',
    Accept: (V) => IsRealFloat(V) && (V as number) > 0 && (V as number) <= 1e9,
  },
];

// --- Frame listener (multicast) ----------------------------------------------

export interface FrameListener {
  Close(): void;
}

export type FrameListenerFactory = (
  Options: { Group: string; Port: number },
  OnPacket: (Buf: Buffer, FromIp: string) => void,
  OnError: (Err: unknown) => void
) => FrameListener;

function LocalIPv4Addresses(): string[] {
  const Out: string[] = [];
  try {
    for (const List of Object.values(os.networkInterfaces())) {
      for (const Iface of List || []) {
        if (Iface.family === 'IPv4' && !Iface.internal) Out.push(Iface.address);
      }
    }
  } catch {
    // No interface list: fall back to the default membership below.
  }
  return Out;
}

// Bind the data port (shared, so another NatNet client on this machine keeps
// working) and join the group on every IPv4 interface, as the sACN receiver
// does: Motive's streaming interface may not be the default route.
const DefaultFrameListener: FrameListenerFactory = (Options, OnPacket, OnError) => {
  const Sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let Closed = false;
  Sock.on('error', (Err) => {
    if (!Closed) OnError(Err);
  });
  Sock.on('message', (Buf, Rinfo) => {
    if (!Closed) OnPacket(Buf, Rinfo.address);
  });
  try {
    Sock.bind(Options.Port, () => {
      let Joined = 0;
      let LastErr: unknown = null;
      for (const Ip of LocalIPv4Addresses()) {
        try {
          Sock.addMembership(Options.Group, Ip);
          Joined++;
        } catch (Err) {
          LastErr = Err;
        }
      }
      if (!Joined) {
        try {
          Sock.addMembership(Options.Group);
          Joined++;
        } catch (Err) {
          LastErr = Err;
        }
      }
      if (!Joined && !Closed) OnError(LastErr || new Error('No interface could join the group'));
    });
  } catch (Err) {
    OnError(Err);
  }
  return {
    Close() {
      if (Closed) return;
      Closed = true;
      try {
        Sock.close();
      } catch {
        // already closed
      }
    },
  };
};

let FrameListenerImpl: FrameListenerFactory = DefaultFrameListener;

// Tests swap in a plain loopback socket: joining a multicast group depends on
// the host's routes, which a test must not.
function SetFrameListenerFactory(Factory: FrameListenerFactory | null): void {
  FrameListenerImpl = Factory || DefaultFrameListener;
}

// --- Probe ------------------------------------------------------------------

export interface FrameBodyStats {
  Id: number;
  Frames: number;
  TrackedFrames: number;
}

export interface MotiveSnapshot {
  LatencyMs: number;
  // NAT_SERVERINFO arrived and parsed.
  IsNatNet: boolean;
  // Host application name contains "Motive".
  IsMotive: boolean;
  ServerIp: string | null;
  AppName: string | null;
  AppVersion: string | null;
  NatNetVersion: string | null;
  NatNetMajor: number;
  NatNetMinor: number;
  Streaming: { Multicast: boolean; Group: string; DataPort: number } | null;
  Mode: number | null;
  FrameRate: number | null;
  UnitsToMillimeters: number | null;
  SessionPath: string | null;
  // Commands Motive answered with NAT_UNRECOGNIZED_REQUEST.
  Unsupported: string[];
  // Rigid body sampling (only when asked for).
  RigidBodyDefs: RigidBodyDef[] | null;
  ModelDefComplete: boolean;
  FramesSampled: number;
  FramesUndecodable: number;
  FrameBodies: FrameBodyStats[];
  // Why no frame verdict is possible at all (too old, listen failed, no frames).
  FrameError: string | null;
}

export type MotiveProbeOutcome =
  { Reachable: true; Snapshot: MotiveSnapshot } | { Reachable: false; Error: string };

export interface MotiveProbeWants {
  // The rigid body entries to resolve; empty = do not sample frames.
  RigidBodies: string[];
}

function IsLoopback(Address: string): boolean {
  return Address === 'localhost' || /^127\./.test(Address);
}

export function QueryMotive(
  Config: MotiveConfig,
  Wants: MotiveProbeWants
): Promise<MotiveProbeOutcome> {
  const BudgetMs = Math.max(500, Config.TimeoutMs | 0);
  const ResendMs = Math.min(MAX_RESEND_MS, Math.max(MIN_RESEND_MS, Math.floor(BudgetMs / 8)));
  const WantFrames = Wants.RigidBodies.length > 0;

  return new Promise<MotiveProbeOutcome>((Resolve) => {
    let Settled = false;
    let StartedAt = Date.now();
    let ServerInfoAt: number | null = null;
    let Info: ServerInfo | null = null;
    let AnyReply = false;
    let ConnectSentAt = 0;
    // Index into QUERIES of the command in flight; QUERIES.length = all done.
    let QueryIndex = -1;
    let QueryAttempts = 0;
    let QuerySentAt = 0;
    // NAT_UNRECOGNIZED_REQUEST replies still owed to commands already moved
    // past. They carry no command name, so without this count a slow Motive's
    // reply to a re-send would be pinned on the NEXT command (or the model
    // list) and mark a working command unsupported. Each one is swallowed
    // instead; should the next command's real reply be swallowed by mistake,
    // its own re-send recovers it.
    let StrayUnrecognised = 0;
    // Model list: 'idle' -> 'pending' -> 'done'.
    let ModelDefState: 'idle' | 'pending' | 'done' = 'idle';
    let ModelDefSentAt = 0;
    let FirstFrameAt: number | null = null;
    const Stats = new Map<number, FrameBodyStats>();
    let Listener: FrameListener | null = null;
    let Socket: dgram.Socket | null = null;
    let ResendTimer: ReturnType<typeof setInterval> | null = null;
    let DeadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let WindowTimer: ReturnType<typeof setTimeout> | null = null;

    const Snap: MotiveSnapshot = {
      LatencyMs: 0,
      IsNatNet: false,
      IsMotive: false,
      ServerIp: null,
      AppName: null,
      AppVersion: null,
      NatNetVersion: null,
      NatNetMajor: 0,
      NatNetMinor: 0,
      Streaming: null,
      Mode: null,
      FrameRate: null,
      UnitsToMillimeters: null,
      SessionPath: null,
      Unsupported: [],
      RigidBodyDefs: null,
      ModelDefComplete: false,
      FramesSampled: 0,
      FramesUndecodable: 0,
      FrameBodies: [],
      FrameError: null,
    };

    const Unicast = (): boolean => !!(Info && Info.Connection && !Info.Connection.Multicast);

    const Send = (Buf: Buffer, OnError?: (Err: Error) => void): void => {
      if (!Socket || Settled) return;
      try {
        Socket.send(Buf, Config.Port, Config.Address, (Err) => {
          if (Err && OnError) OnError(Err);
        });
      } catch (Err) {
        if (OnError) OnError(Err as Error);
      }
    };

    const CloseSocket = (): void => {
      const Sock = Socket;
      Socket = null;
      if (!Sock) return;
      const Close = (): void => {
        try {
          Sock.close();
        } catch {
          // already closed
        }
      };
      if (Info && Unicast()) {
        // Tell Motive this unicast client is gone, then close once it is sent.
        try {
          Sock.send(EncodeSimple(NAT_DISCONNECT), Config.Port, Config.Address, Close);
          return;
        } catch {
          // fall through to an immediate close
        }
      }
      Close();
    };

    const Finish = (Outcome: MotiveProbeOutcome): void => {
      if (Settled) return;
      Settled = true;
      if (ResendTimer) clearInterval(ResendTimer);
      if (DeadlineTimer) clearTimeout(DeadlineTimer);
      if (WindowTimer) clearTimeout(WindowTimer);
      if (Listener) Listener.Close();
      CloseSocket();
      Resolve(Outcome);
    };

    const Reached = (): MotiveProbeOutcome => {
      Snap.LatencyMs = (ServerInfoAt ?? Date.now()) - StartedAt;
      Snap.FrameBodies = [...Stats.values()];
      if (WantFrames && Snap.IsMotive && !Snap.FrameError && Snap.FramesSampled === 0) {
        Snap.FrameError =
          Snap.FramesUndecodable > 0
            ? `frame data could not be decoded as NatNet ${Snap.NatNetVersion}`
            : 'no frame data received';
      }
      return { Reachable: true, Snapshot: Snap };
    };

    const SendQuery = (): void => {
      const Q = QUERIES[QueryIndex];
      if (!Q) return;
      QueryAttempts++;
      QuerySentAt = Date.now();
      Send(EncodeRequest(Q.Command));
    };

    const SendModelDef = (): void => {
      ModelDefSentAt = Date.now();
      Send(EncodeSimple(NAT_REQUEST_MODELDEF));
    };

    // Move to the next command (or, after the last, to the model list).
    const NextQuery = (): void => {
      QueryIndex++;
      QueryAttempts = 0;
      if (QueryIndex < QUERIES.length) {
        SendQuery();
        return;
      }
      if (WantFrames && !Snap.FrameError && ModelDefState === 'idle') {
        ModelDefState = 'pending';
        SendModelDef();
      }
    };

    const QueriesDone = (): boolean => QueryIndex >= QUERIES.length;

    // True when every listed body that resolves to an id has been seen tracked.
    const AllWantedTracked = (): boolean => {
      if (ModelDefState !== 'done') return false;
      const Resolved = ResolveRigidBodies(Wants.RigidBodies, {
        RigidBodyDefs: Snap.RigidBodyDefs,
        ModelDefComplete: Snap.ModelDefComplete,
        FramesSampled: Snap.FramesSampled,
        FrameBodies: [...Stats.values()],
      });
      return Resolved.every((R) => R.State === 'tracked');
    };

    const FramesDone = (): boolean => {
      if (!WantFrames || Snap.FrameError) return true;
      if (FirstFrameAt == null) return false;
      if (Date.now() - FirstFrameAt >= FRAME_WINDOW_MS) return ModelDefState === 'done';
      return AllWantedTracked();
    };

    const MaybeDone = (): void => {
      if (Settled || !Info) return;
      if (!Snap.IsMotive) {
        Finish(Reached());
        return;
      }
      if (!QueriesDone()) return;
      if (WantFrames && !Snap.FrameError && ModelDefState !== 'done') return;
      if (FramesDone()) Finish(Reached());
    };

    const OnFrame = (Payload: Buffer): void => {
      if (!WantFrames || !Info || Snap.FrameError) return;
      const Frame = ParseFrameRigidBodies(Payload, Snap.NatNetMajor, Snap.NatNetMinor);
      if (!Frame) {
        Snap.FramesUndecodable++;
        return;
      }
      Snap.FramesSampled++;
      if (FirstFrameAt == null) {
        FirstFrameAt = Date.now();
        WindowTimer = setTimeout(() => {
          try {
            MaybeDone();
          } catch (Err) {
            Finish({
              Reachable: false,
              Error: `Failed to evaluate NatNet frames: ${ErrorMessage(Err)}`,
            });
          }
        }, FRAME_WINDOW_MS);
      }
      for (const Body of Frame.Bodies) {
        let S = Stats.get(Body.Id);
        if (!S) {
          S = { Id: Body.Id, Frames: 0, TrackedFrames: 0 };
          Stats.set(Body.Id, S);
        }
        S.Frames++;
        if (Body.Tracked) S.TrackedFrames++;
      }
    };

    const StartFrames = (): void => {
      if (!WantFrames || !Info) return;
      if (Snap.NatNetMajor < 3) {
        Snap.FrameError = `NatNet ${Snap.NatNetVersion} is too old for rigid body tracking (needs NatNet 3.0, Motive 2.0 or later)`;
        return;
      }
      // Unicast frames arrive on the command socket (see OnCommandMessage).
      // Multicast (or a server that did not say) needs the group joined.
      if (Info.Connection && !Info.Connection.Multicast) return;
      const Group = Info.Connection ? Info.Connection.MulticastGroup : DEFAULT_MULTICAST_GROUP;
      const Port = Info.Connection ? Info.Connection.DataPort : DEFAULT_DATA_PORT;
      const AnySource = IsLoopback(Config.Address);
      try {
        Listener = FrameListenerImpl(
          { Group, Port },
          (Buf, FromIp) => {
            if (Settled) return;
            try {
              // Several Motive PCs can share a group: only frames from this one.
              if (!AnySource && FromIp !== Snap.ServerIp) return;
              const Pkt = ParsePacket(Buf);
              if (Pkt && Pkt.MessageId === NAT_FRAMEOFDATA) OnFrame(Pkt.Payload);
              MaybeDone();
            } catch (Err) {
              Finish({
                Reachable: false,
                Error: `Failed to decode NatNet frame data: ${ErrorMessage(Err)}`,
              });
            }
          },
          (Err) => {
            if (Settled || Snap.FrameError) return;
            Snap.FrameError = `failed to listen for frame data on ${Group}:${Port} (${ErrorMessage(Err)})`;
            try {
              MaybeDone();
            } catch {
              // MaybeDone only reads state; nothing to recover.
            }
          }
        );
      } catch (Err) {
        Snap.FrameError = `failed to listen for frame data on ${Group}:${Port} (${ErrorMessage(Err)})`;
      }
    };

    const OnServerInfo = (Parsed: ServerInfo, FromIp: string): void => {
      if (Info) return; // a re-sent NAT_CONNECT answered twice
      Info = Parsed;
      ServerInfoAt = Date.now();
      Snap.IsNatNet = true;
      Snap.ServerIp = FromIp;
      Snap.AppName = Parsed.AppName || null;
      Snap.AppVersion = FormatVersion(Parsed.AppVersion);
      Snap.NatNetVersion = FormatVersion(Parsed.NatNetVersion);
      Snap.NatNetMajor = Parsed.NatNetVersion[0];
      Snap.NatNetMinor = Parsed.NatNetVersion[1];
      Snap.IsMotive = /motive/i.test(Parsed.AppName);
      Snap.Streaming = Parsed.Connection
        ? {
            Multicast: Parsed.Connection.Multicast,
            Group: Parsed.Connection.MulticastGroup,
            DataPort: Parsed.Connection.DataPort,
          }
        : null;
      // Something else speaking NatNet: Motive's commands may mean nothing to it.
      if (!Snap.IsMotive) return;
      StartFrames();
      if (WantFrames && Unicast()) Send(EncodeSimple(NAT_KEEPALIVE));
      NextQuery();
    };

    const OnResponse = (Payload: Buffer): void => {
      const Q = QUERIES[QueryIndex];
      if (!Q) return;
      const Value = DecodeResponse(Payload, Q.Kind);
      if (Value == null || !Q.Accept(Value)) return; // not this command's answer
      (Snap as unknown as Record<QueryKey, unknown>)[Q.Key] =
        typeof Value === 'string' ? Value.trim() || null : Value;
      NextQuery();
    };

    const OnUnrecognised = (): void => {
      if (StrayUnrecognised > 0) {
        StrayUnrecognised--;
        return;
      }
      const Q = QUERIES[QueryIndex];
      if (Q) {
        Snap.Unsupported.push(Q.Command);
        // This reply answers one send; every other send may still be answered.
        StrayUnrecognised += QueryAttempts - 1;
        NextQuery();
      } else if (ModelDefState === 'pending') {
        ModelDefState = 'done';
        Snap.Unsupported.push('NAT_REQUEST_MODELDEF');
      }
    };

    const OnCommandMessage = (Buf: Buffer, FromIp: string): void => {
      AnyReply = true;
      const Pkt = ParsePacket(Buf);
      if (!Pkt) return;
      switch (Pkt.MessageId) {
        case NAT_SERVERINFO: {
          const Parsed = ParseServerInfo(Pkt.Payload);
          if (Parsed) OnServerInfo(Parsed, FromIp);
          break;
        }
        case NAT_RESPONSE:
          if (Info) OnResponse(Pkt.Payload);
          break;
        case NAT_UNRECOGNIZED_REQUEST:
          if (Info) OnUnrecognised();
          break;
        case NAT_MODELDEF:
          if (Info && ModelDefState === 'pending') {
            const Defs = ParseModelDefs(Pkt.Payload, Snap.NatNetMajor, Snap.NatNetMinor);
            Snap.RigidBodyDefs = Defs ? Defs.RigidBodies : null;
            Snap.ModelDefComplete = !!(Defs && Defs.Complete);
            ModelDefState = 'done';
          }
          break;
        case NAT_FRAMEOFDATA:
          OnFrame(Pkt.Payload);
          break;
        default:
          // NAT_MESSAGESTRING and anything newer: informational only.
          break;
      }
    };

    const OnTick = (): void => {
      const Now = Date.now();
      if (!Info) {
        if (Now - ConnectSentAt >= ResendMs) {
          ConnectSentAt = Now;
          Send(EncodeConnect());
        }
        return;
      }
      if (!Snap.IsMotive) return;
      if (WantFrames && Unicast() && !FramesDone()) Send(EncodeSimple(NAT_KEEPALIVE));
      if (!QueriesDone()) {
        if (Now - QuerySentAt < ResendMs) return;
        if (QueryAttempts >= MAX_QUERY_ATTEMPTS) {
          // Given up on, but a slow Motive may yet answer every send.
          StrayUnrecognised += QueryAttempts;
          NextQuery();
        } else SendQuery();
        return;
      }
      if (ModelDefState === 'pending' && Now - ModelDefSentAt >= ResendMs) SendModelDef();
      MaybeDone();
    };

    if (net.isIPv6(Config.Address)) {
      Finish({ Reachable: false, Error: 'NatNet is IPv4 only; use Motive’s IPv4 address' });
      return;
    }

    try {
      Socket = dgram.createSocket('udp4');
    } catch (Err) {
      Finish({ Reachable: false, Error: ErrorMessage(Err) });
      return;
    }

    Socket.on('error', (Err) => {
      if (Info) Finish(Reached());
      else Finish({ Reachable: false, Error: ErrorMessage(Err) });
    });

    Socket.on('message', (Buf: Buffer, Rinfo: dgram.RemoteInfo) => {
      if (Settled) return;
      try {
        OnCommandMessage(Buf, Rinfo.address);
        MaybeDone();
      } catch (Err) {
        Finish({
          Reachable: false,
          Error: `Failed to decode a NatNet reply: ${ErrorMessage(Err)}`,
        });
      }
    });

    DeadlineTimer = setTimeout(() => {
      if (Info || AnyReply) {
        // Report whatever was read; without server info the responder is not
        // a NatNet server.
        Finish(Reached());
        return;
      }
      Finish({ Reachable: false, Error: `No NatNet reply within ${BudgetMs}ms` });
    }, BudgetMs);

    StartedAt = Date.now();
    ConnectSentAt = StartedAt;
    // A send error before any reply (DNS failure, no route) is the answer.
    Send(EncodeConnect(), (Err) => {
      if (!Info) Finish({ Reachable: false, Error: ErrorMessage(Err) });
    });
    ResendTimer = setInterval(
      () => {
        if (Settled) return;
        try {
          OnTick();
        } catch (Err) {
          Finish({
            Reachable: false,
            Error: `Failed to run the NatNet probe: ${ErrorMessage(Err)}`,
          });
        }
      },
      Math.max(50, Math.floor(ResendMs / 2))
    );
  });
}

// --- Evaluation -------------------------------------------------------------

export type RigidBodyState =
  'tracked' | 'not-tracked' | 'not-streamed' | 'not-found' | 'no-list' | 'unresolved' | 'no-frames';

export interface RigidBodyStatus {
  Entry: string;
  Id: number | null;
  Name: string | null;
  State: RigidBodyState;
  Frames: number;
  TrackedFrames: number;
}

type RigidBodyEvidence = Pick<
  MotiveSnapshot,
  'RigidBodyDefs' | 'ModelDefComplete' | 'FramesSampled' | 'FrameBodies'
>;

// Map each listed entry to a streaming ID and a verdict. A name is matched
// case-insensitively against Motive's rigid body list; an all-digit entry that
// is not also a name is taken as the Streaming ID. Pure.
function ResolveRigidBodies(Entries: string[], Evidence: RigidBodyEvidence): RigidBodyStatus[] {
  const Defs = Evidence.RigidBodyDefs;
  const Bodies = Array.isArray(Evidence.FrameBodies) ? Evidence.FrameBodies : [];
  return Entries.map((Entry) => {
    const Lower = Entry.toLowerCase();
    const ByName = Defs ? Defs.find((D) => D.Name.toLowerCase() === Lower) : undefined;
    let Id: number | null = ByName ? ByName.Id : null;
    let Name: string | null = ByName ? ByName.Name : null;
    const Numeric = !ByName && /^\d{1,9}$/.test(Entry);
    if (Numeric) {
      Id = Number(Entry);
      const Def = Defs ? Defs.find((D) => D.Id === Id) : undefined;
      Name = Def ? Def.Name || null : null;
    }
    const Base = { Entry, Id, Name, Frames: 0, TrackedFrames: 0 };
    if (Id == null) {
      const State: RigidBodyState = !Defs
        ? 'no-list'
        : Evidence.ModelDefComplete
          ? 'not-found'
          : 'unresolved';
      return { ...Base, State };
    }
    if (!Evidence.FramesSampled) return { ...Base, State: 'no-frames' as const };
    const Seen = Bodies.find((B) => B.Id === Id);
    if (!Seen) {
      const Unknown = Numeric && Defs && Evidence.ModelDefComplete && Name == null;
      return { ...Base, State: Unknown ? ('not-found' as const) : ('not-streamed' as const) };
    }
    return {
      ...Base,
      Frames: Seen.Frames,
      TrackedFrames: Seen.TrackedFrames,
      State: Seen.TrackedFrames > 0 ? ('tracked' as const) : ('not-tracked' as const),
    };
  });
}

function RigidBodyLabel(S: RigidBodyStatus): string {
  if (S.Name && S.Name.toLowerCase() === S.Entry.toLowerCase()) return S.Name;
  return S.Name ? `${S.Entry} (${S.Name})` : S.Entry;
}

function FormatNumber(N: number): string {
  return String(Math.round(N * 1000) / 1000);
}

// The reasons a reachable server is unhealthy, per the enabled toggles. Pure;
// exported via _internal for unit tests.
function EvaluateHealth(Snapshot: MotiveSnapshot, Options: HealthOptions): string[] {
  if (!Snapshot.IsNatNet) return ['Responded, but not with NatNet server info'];
  if (!Snapshot.IsMotive) {
    return [`NatNet server is "${Snapshot.AppName || '(unnamed)'}", not Motive`];
  }
  const Reasons: string[] = [];

  if (Options.CheckLiveMode) {
    if (Snapshot.Mode === 1) Reasons.push('Motive is in Edit mode');
    else if (Snapshot.Mode == null) Reasons.push('Failed to read Motive’s mode');
    else if (Snapshot.Mode !== 0) Reasons.push(`Motive reports an unknown mode (${Snapshot.Mode})`);
  }

  if (Options.CheckFrameRate) {
    if (Snapshot.FrameRate == null) {
      Reasons.push('Failed to read the frame rate');
    } else if (Math.abs(Snapshot.FrameRate - Options.ExpectedFrameRate) > FRAME_RATE_TOLERANCE) {
      Reasons.push(
        `Frame rate ${FormatNumber(Snapshot.FrameRate)} Hz (expected ${FormatNumber(Options.ExpectedFrameRate)})`
      );
    }
  }

  if (Options.CheckRigidBodies && Options.RigidBodies.length) {
    if (Snapshot.FrameError) {
      Reasons.push(`Rigid bodies: ${Snapshot.FrameError}`);
    } else {
      const Statuses = ResolveRigidBodies(Options.RigidBodies, Snapshot);
      if (Statuses.some((S) => S.State === 'no-list')) {
        Reasons.push('Failed to read Motive’s rigid body list');
      }
      for (const S of Statuses) {
        const Label = `Rigid body ${RigidBodyLabel(S)}`;
        if (S.State === 'not-tracked') Reasons.push(`${Label}: not tracked`);
        else if (S.State === 'not-streamed') Reasons.push(`${Label}: not streamed`);
        else if (S.State === 'not-found') Reasons.push(`${Label}: not found in Motive`);
        else if (S.State === 'unresolved') {
          Reasons.push(`${Label}: failed to resolve the name; use its Streaming ID`);
        } else if (S.State === 'no-frames') Reasons.push(`${Label}: no frame data received`);
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

  const Outcome = await QueryMotive(Config, {
    RigidBodies: Options.CheckRigidBodies ? Options.RigidBodies : [],
  });
  if (!Outcome.Reachable) return { Success: false, Error: Outcome.Error };

  const Snap = Outcome.Snapshot;
  const Reasons = EvaluateHealth(Snap, Options);
  const RigidBodies =
    Options.CheckRigidBodies && Options.RigidBodies.length && !Snap.FrameError && Snap.IsMotive
      ? ResolveRigidBodies(Options.RigidBodies, Snap)
      : [];
  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs: Snap.LatencyMs,
    IsNatNet: Snap.IsNatNet,
    IsMotive: Snap.IsMotive,
    AppName: Snap.AppName,
    AppVersion: Snap.AppVersion,
    NatNetVersion: Snap.NatNetVersion,
    ServerIp: Snap.ServerIp,
    Streaming: Snap.Streaming,
    Mode: Snap.Mode,
    ModeName: Snap.Mode === 0 ? 'Live' : Snap.Mode === 1 ? 'Edit' : null,
    FrameRate: Snap.FrameRate,
    UnitsToMillimeters: Snap.UnitsToMillimeters,
    SessionPath: Snap.SessionPath,
    Unsupported: Snap.Unsupported,
    FramesSampled: Snap.FramesSampled,
    FrameError: Snap.FrameError,
    RigidBodies,
  };
}

function StatePill(Result: MonitoringResult): string {
  const Reachable = !!(Result && Result.Success === true);
  if (Reachable && !Result.Degraded) return Pill('success', 'Online');
  if (Reachable) return Pill('warning', Result.DegradedReason || 'Degraded');
  return Pill('danger', 'Offline');
}

const RIGID_BODY_BADGES: Record<RigidBodyState, [string, string]> = {
  tracked: ['success', 'Tracked'],
  'not-tracked': ['warning', 'Not tracked'],
  'not-streamed': ['warning', 'Not streamed'],
  'not-found': ['warning', 'Not found'],
  'no-list': ['muted', 'Name not resolved'],
  unresolved: ['muted', 'Name not resolved'],
  'no-frames': ['muted', 'No frames'],
};

function StreamingText(Value: unknown): string | null {
  if (!Value || typeof Value !== 'object') return null;
  const S = Value as { Multicast?: unknown; Group?: unknown; DataPort?: unknown };
  return S.Multicast
    ? `Multicast ${String(S.Group)}:${String(S.DataPort)}`
    : `Unicast, data port ${String(S.DataPort)}`;
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseConfig(Target);
  const Options = ParseHealthOptions(Target);
  const Reachable = !!(Result && Result.Success === true);
  const App = [Result && Result.AppName, Result && Result.AppVersion]
    .filter((Part) => Part != null && String(Part).trim() !== '')
    .join(' ');
  const Mode = Result && Result.ModeName;
  const Rate = Result && typeof Result.FrameRate === 'number' ? Result.FrameRate : null;
  const Units =
    Result && typeof Result.UnitsToMillimeters === 'number' ? Result.UnitsToMillimeters : null;

  const Head = Rows([
    TextRow('Host', `${Config.Address || '-'}:${Config.Port}`),
    App ? TextRow('Application', App) : null,
    Reachable && Result.NatNetVersion ? TextRow('NatNet', Result.NatNetVersion) : null,
    Row('Status', StatePill(Result)),
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Failed to reach Motive'),
    Reachable && Mode
      ? Row('Mode', Mode === 'Live' ? Pill('success', 'Live') : Pill('warning', 'Edit'))
      : null,
    Reachable && Rate != null ? TextRow('Frame rate', `${FormatNumber(Rate)} Hz`) : null,
    Reachable && Units != null ? TextRow('Units', `1 unit = ${FormatNumber(Units)} mm`) : null,
    Reachable && Result.SessionPath ? TextRow('Session folder', Result.SessionPath) : null,
    Reachable && StreamingText(Result.Streaming)
      ? TextRow('Streaming', StreamingText(Result.Streaming))
      : null,
    Reachable && Array.isArray(Result.Unsupported) && Result.Unsupported.length
      ? TextRow('Not supported', (Result.Unsupported as unknown[]).map(String).join(', '))
      : null,
  ]);
  if (!Reachable) {
    return (
      Head +
      '<div class="mt-2">' +
      Note(
        'Failed to reach Motive’s NatNet server. In Motive, open Settings → Streaming, turn on NatNet streaming (Enable, or Broadcast Frame Data in older versions) and set Local Interface to a network ShowTrak can reach. Loopback only works when ShowTrak runs on the Motive PC.'
      ) +
      '</div>'
    );
  }

  if (!Options.CheckRigidBodies || !Options.RigidBodies.length) return Head;
  if (Result.FrameError) {
    return Head + `<div class="mt-2">${Note(`Rigid bodies: ${String(Result.FrameError)}`)}</div>`;
  }
  const Statuses = Array.isArray(Result.RigidBodies)
    ? (Result.RigidBodies as RigidBodyStatus[])
    : [];
  if (!Statuses.length) return Head;
  const Cards = Statuses.map((S) => {
    const [Kind, Text] = RIGID_BODY_BADGES[S.State] || ['muted', 'Unknown'];
    const Detail = [
      S.Id != null ? `ID ${S.Id}` : null,
      S.Frames ? `tracked in ${S.TrackedFrames}/${S.Frames} frames` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    return Card({
      Title: RigidBodyLabel(S),
      Badge: Pill(Kind, Text),
      BodyHtml: Detail ? `<div class="text-muted small">${Esc(Detail)}</div>` : '',
    });
  }).join('');
  const Sampled = Number(Result.FramesSampled) || 0;
  return (
    Head +
    `<div class="d-grid gap-1 mt-2">${Cards}</div>` +
    `<div class="mt-1">${Note(`${Sampled} frame${Sampled === 1 ? '' : 's'} sampled.`)}</div>`
  );
}

export const Name = 'OptiTrack Motive';
export const Description =
  'Queries OptiTrack Motive over NatNet (UDP 1510) for its version, Live/Edit mode and frame rate. Flags Edit mode by default, and optionally a different frame rate or listed rigid bodies that are not being tracked. Read-only: it never changes a setting in Motive.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseConfig,
  ParseHealthOptions,
  ParseRigidBodyList,
  ResolveRigidBodies,
  EvaluateHealth,
  QueryMotive,
  QUERIES,
  SetFrameListenerFactory,
};
export { ID, Settings, Run, Debug };
