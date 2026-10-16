// OBS Studio check over obs-websocket 5 (built into OBS 28+; Tools →
// WebSocket Server Settings).
//
// Protocol (obsproject/obs-websocket docs/generated/protocol.md):
//   - WebSocket, default port 4455, JSON text frames by default. Every message
//     is { op, d }.
//   - The server speaks first: Hello (op 0) { obsStudioVersion,
//     obsWebSocketVersion, rpcVersion, authentication?: { challenge, salt } }.
//   - The client answers Identify (op 1) { rpcVersion, authentication?,
//     eventSubscriptions }. With authentication present, the string is
//     base64(sha256(base64(sha256(password + salt)) + challenge)). A wrong or
//     missing password closes the socket with code 4009 (AuthenticationFailed).
//   - Identified (op 2) → the client may send a RequestBatch (op 8) and gets one
//     RequestBatchResponse (op 9) whose results carry each request's requestId,
//     requestStatus { result, code, comment } and responseData.
//
// Design:
//   - One short-lived connection per probe; eventSubscriptions 0 so OBS never
//     pushes events at us; one batch of five read-only requests (GetVersion,
//     GetStreamStatus, GetRecordStatus, GetStats, GetCurrentProgramScene); a
//     normal 1000 close. The configured Timeout bounds the WHOLE probe.
//   - Node's global WebSocket (Node 22+, Electron's main process) — no
//     dependency. The constructor is swappable through _internal for tests.
//   - A rejected password is a configuration fault on a reachable OBS, so it is
//     Degraded with a clear reason rather than Offline.
//   - Dropped frames are judged over the DELTA since a per-check baseline
//     (a module-level map; see "Dropped-frame deltas"), not OBS's since-launch
//     totals —
//     otherwise one bad minute an hour ago would degrade the check forever.
//     OBS keeps three separate counters, matching its Stats dock, and each is
//     judged on its own against the same percentage:
//       network  : GetStreamStatus outputSkippedFrames / outputTotalFrames
//                  ("Dropped frames (network)"; only while the stream is live)
//       encoding : GetStats outputSkippedFrames / outputTotalFrames
//                  ("Skipped frames due to encoding lag")
//       rendering: GetStats renderSkippedFrames / renderTotalFrames
//                  ("Frames missed due to rendering lag")
//     Summing them would mix frames of different meaning (a rendered frame is
//     not a sent frame), and naming which one is failing is the useful part.
//     The first probe, an OBS restart or an output restart (a counter going
//     backwards) and a window under 5 s or 60 frames give no verdict.
import crypto from 'crypto';
import net from 'net';
import { ErrorMessage } from './_tcp-session';
import { Esc, FormatLatency, Note, Pill, Row, Rows, TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'obs-studio';

export const DEFAULT_OBS_PORT = 4455;
const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_MAX_DROPPED_PERCENT = 1;
const RPC_VERSION = 1;
const BATCH_ID = 'showtrak-status';
// Previous-sample memory for dropped-frame deltas. Bounded so a server that
// probes many short-lived targets cannot grow it without limit.
const MAX_REMEMBERED_TARGETS = 256;

const CLOSE_AUTH_FAILED = 4009;
const CLOSE_UNSUPPORTED_RPC = 4010;
const CLOSE_SESSION_INVALIDATED = 4011;

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'WebSocket port',
    Type: 'number',
    Default: DEFAULT_OBS_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
    Note: 'Server Port under Tools → WebSocket Server Settings in OBS.',
  },
  {
    Key: 'Password',
    Label: 'Password',
    Type: 'string',
    Default: '',
    Sensitive: true,
    Note: 'Server Password from the same dialog. Leave blank when authentication is turned off.',
  },
  {
    Key: 'CheckStreaming',
    Label: 'Check streaming',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded unless OBS is streaming, and while the stream is reconnecting.',
  },
  {
    Key: 'CheckRecording',
    Label: 'Check recording',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded unless OBS is recording. A paused recording counts as Degraded.',
  },
  {
    Key: 'CheckDroppedFrames',
    Label: 'Check dropped frames',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded when network drops, encoding lag or rendering lag exceed the limit since the last verdict.',
  },
  {
    Key: 'MaxDroppedPercent',
    Label: 'Maximum dropped frames (%)',
    Type: 'number',
    Default: DEFAULT_MAX_DROPPED_PERCENT,
    Min: 0,
    Max: 100,
    VisibleWhen: { Key: 'CheckDroppedFrames', Equals: true },
    Note: 'Applied to each counter separately over at least 5 seconds and 60 frames since the last verdict. The first check after OBS starts gives no verdict.',
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

export interface ObsConfig {
  Address: string;
  Port: number;
  TimeoutMs: number;
  Password: string;
}

function ParseConfig(Target: MonitoringTargetLike): ObsConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number(Cfg.Port);
  const Timeout = Number(Cfg.Timeout);
  return {
    Address: String((Target && Target.Address) || '').trim(),
    Port: Number.isFinite(Port) && Port > 0 ? Math.floor(Port) : DEFAULT_OBS_PORT,
    TimeoutMs: Number.isFinite(Timeout) && Timeout > 0 ? Math.floor(Timeout) : DEFAULT_TIMEOUT_MS,
    // Not trimmed: a password may legitimately start or end with a space.
    Password: Cfg.Password == null ? '' : String(Cfg.Password),
  };
}

interface HealthOptions {
  CheckStreaming: boolean;
  CheckRecording: boolean;
  CheckDroppedFrames: boolean;
  MaxDroppedPercent: number;
}

function ParseHealthOptions(Target: MonitoringTargetLike): HealthOptions {
  const Cfg = (Target && Target.Settings) || {};
  const Max = Number(Cfg.MaxDroppedPercent);
  return {
    CheckStreaming: !!Cfg.CheckStreaming,
    CheckRecording: !!Cfg.CheckRecording,
    CheckDroppedFrames: !!Cfg.CheckDroppedFrames,
    MaxDroppedPercent:
      Cfg.MaxDroppedPercent != null && Cfg.MaxDroppedPercent !== '' && Number.isFinite(Max)
        ? Math.max(0, Math.min(100, Max))
        : DEFAULT_MAX_DROPPED_PERCENT,
  };
}

// --- WebSocket plumbing -------------------------------------------------------

// The subset of the WHATWG WebSocket this probe uses, so the global and a test
// double (or the `ws` package) are interchangeable.
export interface WebSocketLike {
  readonly readyState: number;
  send(Data: string): void;
  close(Code?: number, Reason?: string): void;
  addEventListener(Type: string, Listener: (Event: unknown) => void): void;
}
export type WebSocketCtor = new (Url: string) => WebSocketLike;

function DefaultWebSocket(): WebSocketCtor | null {
  const Ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
  return typeof Ctor === 'function' ? (Ctor as WebSocketCtor) : null;
}

let WebSocketImpl: WebSocketCtor | null = null;

// Test hook: swap the WebSocket constructor; null restores the global.
function SetWebSocketImpl(Ctor: WebSocketCtor | null): void {
  WebSocketImpl = Ctor;
}

function BuildUrl(Address: string, Port: number): string {
  const Host = net.isIPv6(Address) ? `[${Address}]` : Address;
  return `ws://${Host}:${Port}`;
}

// base64(sha256(base64(sha256(password + salt)) + challenge)), per the spec.
function BuildAuthString(Password: string, Salt: string, Challenge: string): string {
  const Secret = crypto
    .createHash('sha256')
    .update(Password + Salt, 'utf8')
    .digest('base64');
  return crypto
    .createHash('sha256')
    .update(Secret + Challenge, 'utf8')
    .digest('base64');
}

// --- Snapshot -----------------------------------------------------------------

export interface ObsCounters {
  StreamActive: boolean | null;
  StreamSkipped: number | null;
  StreamTotal: number | null;
  EncodeSkipped: number | null;
  EncodeTotal: number | null;
  RenderSkipped: number | null;
  RenderTotal: number | null;
}

export interface ObsSnapshot {
  LatencyMs: number;
  ObsVersion: string | null;
  WebSocketVersion: string | null;
  RpcVersion: number | null;
  Platform: string | null;
  PlatformDescription: string | null;
  AuthRequired: boolean;
  // Null when GetStreamStatus failed.
  Stream: {
    Active: boolean;
    Reconnecting: boolean;
    Timecode: string | null;
    DurationMs: number | null;
    Congestion: number | null;
    Bytes: number | null;
    SkippedFrames: number | null;
    TotalFrames: number | null;
  } | null;
  Record: {
    Active: boolean;
    Paused: boolean;
    Timecode: string | null;
    DurationMs: number | null;
    Bytes: number | null;
  } | null;
  Stats: {
    CpuUsage: number | null;
    MemoryUsage: number | null;
    AvailableDiskSpace: number | null;
    ActiveFps: number | null;
    AverageFrameRenderTime: number | null;
    RenderSkippedFrames: number | null;
    RenderTotalFrames: number | null;
    OutputSkippedFrames: number | null;
    OutputTotalFrames: number | null;
  } | null;
  ProgramScene: string | null;
  // requestType → failure comment, for requests OBS answered with result:false.
  RequestErrors: Record<string, string>;
}

export type ObsProbeOutcome =
  | { Kind: 'ok'; Snapshot: ObsSnapshot }
  | { Kind: 'auth-failed'; Snapshot: Partial<ObsSnapshot>; Reason: string }
  | { Kind: 'not-obs'; Reason: string; LatencyMs: number }
  | { Kind: 'offline'; Error: string };

type Json = Record<string, unknown>;

function Obj(Value: unknown): Json | null {
  return Value && typeof Value === 'object' && !Array.isArray(Value) ? (Value as Json) : null;
}
function Str(Value: unknown): string | null {
  return typeof Value === 'string' ? Value : null;
}
function Num(Value: unknown): number | null {
  return typeof Value === 'number' && Number.isFinite(Value) ? Value : null;
}

// Turn the batch results into the snapshot. Each request is read on its own,
// so one failed request leaves the others intact. Pure — exported for tests.
function ParseBatchResults(Results: unknown, Hello: Json, LatencyMs: number): ObsSnapshot {
  const ByType = new Map<string, { Ok: boolean; Data: Json | null; Comment: string }>();
  for (const Item of Array.isArray(Results) ? Results : []) {
    const R = Obj(Item);
    if (!R) continue;
    const Type = Str(R.requestType) || Str(R.requestId);
    if (!Type) continue;
    const Status = Obj(R.requestStatus);
    ByType.set(Type, {
      Ok: !!(Status && Status.result === true),
      Data: Obj(R.responseData),
      Comment:
        (Status && Str(Status.comment)) ||
        (Status ? `code ${Num(Status.code) ?? '?'}` : 'no status'),
    });
  }
  const Errors: Record<string, string> = {};
  const Data = (Type: string): Json | null => {
    const R = ByType.get(Type);
    if (!R) {
      Errors[Type] = 'no reply';
      return null;
    }
    if (!R.Ok) {
      Errors[Type] = R.Comment;
      return null;
    }
    return R.Data || {};
  };

  const Version = Data('GetVersion');
  const Stream = Data('GetStreamStatus');
  const Record = Data('GetRecordStatus');
  const Stats = Data('GetStats');
  const Scene = Data('GetCurrentProgramScene');

  return {
    LatencyMs,
    ObsVersion: (Version && Str(Version.obsVersion)) || Str(Hello.obsStudioVersion),
    WebSocketVersion:
      (Version && Str(Version.obsWebSocketVersion)) || Str(Hello.obsWebSocketVersion),
    RpcVersion: (Version && Num(Version.rpcVersion)) ?? Num(Hello.rpcVersion),
    Platform: Version ? Str(Version.platform) : null,
    PlatformDescription: Version ? Str(Version.platformDescription) : null,
    AuthRequired: !!Obj(Hello.authentication),
    Stream: Stream
      ? {
          Active: Stream.outputActive === true,
          Reconnecting: Stream.outputReconnecting === true,
          Timecode: Str(Stream.outputTimecode),
          DurationMs: Num(Stream.outputDuration),
          Congestion: Num(Stream.outputCongestion),
          Bytes: Num(Stream.outputBytes),
          SkippedFrames: Num(Stream.outputSkippedFrames),
          TotalFrames: Num(Stream.outputTotalFrames),
        }
      : null,
    Record: Record
      ? {
          Active: Record.outputActive === true,
          Paused: Record.outputPaused === true,
          Timecode: Str(Record.outputTimecode),
          DurationMs: Num(Record.outputDuration),
          Bytes: Num(Record.outputBytes),
        }
      : null,
    Stats: Stats
      ? {
          CpuUsage: Num(Stats.cpuUsage),
          MemoryUsage: Num(Stats.memoryUsage),
          AvailableDiskSpace: Num(Stats.availableDiskSpace),
          ActiveFps: Num(Stats.activeFps),
          AverageFrameRenderTime: Num(Stats.averageFrameRenderTime),
          RenderSkippedFrames: Num(Stats.renderSkippedFrames),
          RenderTotalFrames: Num(Stats.renderTotalFrames),
          OutputSkippedFrames: Num(Stats.outputSkippedFrames),
          OutputTotalFrames: Num(Stats.outputTotalFrames),
        }
      : null,
    // sceneName is current; currentProgramSceneName is the deprecated alias
    // older 5.x servers send.
    ProgramScene: Scene ? Str(Scene.sceneName) || Str(Scene.currentProgramSceneName) : null,
    RequestErrors: Errors,
  };
}

export function QueryObs(Config: ObsConfig): Promise<ObsProbeOutcome> {
  const BudgetMs = Math.max(500, Config.TimeoutMs | 0);
  const Ctor = WebSocketImpl || DefaultWebSocket();
  if (!Ctor) {
    return Promise.resolve({
      Kind: 'offline',
      Error: 'WebSocket is not available in this runtime',
    });
  }

  return new Promise<ObsProbeOutcome>((Resolve) => {
    let Settled = false;
    let Socket: WebSocketLike | null = null;
    let Opened = false;
    let Hello: Json | null = null;
    let Identified = false;
    const StartedAt = Date.now();
    let HelloAt: number | null = null;

    const Finish = (Outcome: ObsProbeOutcome): void => {
      if (Settled) return;
      Settled = true;
      clearTimeout(Deadline);
      try {
        // 1000 = normal closure. A socket still CONNECTING is closed too, so a
        // timed-out handshake does not linger.
        if (Socket && Socket.readyState < 2) Socket.close(1000);
      } catch {
        // already closing
      }
      Resolve(Outcome);
    };

    const Latency = (): number => (HelloAt ?? Date.now()) - StartedAt;

    const Deadline = setTimeout(() => {
      if (Hello) {
        Finish({
          Kind: 'not-obs',
          Reason: Identified
            ? 'OBS did not answer the status requests in time'
            : 'OBS did not complete the handshake in time',
          LatencyMs: Latency(),
        });
      } else if (Opened) {
        // A WebSocket that never says Hello is not obs-websocket 5 — most
        // likely the old 4.x plugin (port 4444), which waits for requests.
        Finish({
          Kind: 'not-obs',
          Reason: 'Connected, but no obs-websocket 5 Hello (is this obs-websocket 4?)',
          LatencyMs: Latency(),
        });
      } else {
        Finish({ Kind: 'offline', Error: `Connection timed out after ${BudgetMs}ms` });
      }
    }, BudgetMs);

    const SendJson = (Message: Json): void => {
      try {
        Socket?.send(JSON.stringify(Message));
      } catch (Err) {
        Finish({ Kind: 'offline', Error: ErrorMessage(Err) });
      }
    };

    const OnMessage = (Raw: unknown): void => {
      if (Settled) return;
      let Message: Json | null = null;
      if (typeof Raw === 'string') {
        try {
          Message = Obj(JSON.parse(Raw));
        } catch {
          Message = null;
        }
      }
      const Op = Message ? Num(Message.op) : null;
      const D = Message ? Obj(Message.d) : null;
      if (!Message || Op == null || !D) {
        if (!Hello) {
          Finish({
            Kind: 'not-obs',
            Reason: 'Responded, but does not look like obs-websocket 5',
            LatencyMs: Date.now() - StartedAt,
          });
        }
        return;
      }

      if (Op === 0 && !Hello) {
        if (Str(D.obsWebSocketVersion) == null || Num(D.rpcVersion) == null) {
          Finish({
            Kind: 'not-obs',
            Reason: 'Responded, but does not look like obs-websocket 5',
            LatencyMs: Date.now() - StartedAt,
          });
          return;
        }
        Hello = D;
        HelloAt = Date.now();
        const Auth = Obj(D.authentication);
        const Identify: Json = { rpcVersion: RPC_VERSION, eventSubscriptions: 0 };
        if (Auth) {
          if (!Config.Password) {
            Finish({
              Kind: 'auth-failed',
              Snapshot: PartialFromHello(D, Latency()),
              Reason: 'OBS requires a password; none is set',
            });
            return;
          }
          Identify.authentication = BuildAuthString(
            Config.Password,
            Str(Auth.salt) ?? '',
            Str(Auth.challenge) ?? ''
          );
        }
        SendJson({ op: 1, d: Identify });
        return;
      }

      if (Op === 2 && Hello && !Identified) {
        Identified = true;
        SendJson({
          op: 8,
          d: {
            requestId: BATCH_ID,
            haltOnFailure: false,
            requests: [
              { requestType: 'GetVersion', requestId: 'GetVersion' },
              { requestType: 'GetStreamStatus', requestId: 'GetStreamStatus' },
              { requestType: 'GetRecordStatus', requestId: 'GetRecordStatus' },
              { requestType: 'GetStats', requestId: 'GetStats' },
              { requestType: 'GetCurrentProgramScene', requestId: 'GetCurrentProgramScene' },
            ],
          },
        });
        return;
      }

      if (Op === 9 && Hello && D.requestId === BATCH_ID) {
        Finish({ Kind: 'ok', Snapshot: ParseBatchResults(D.results, Hello, Latency()) });
      }
      // Anything else (an event despite subscriptions 0) is ignored.
    };

    try {
      Socket = new Ctor(BuildUrl(Config.Address, Config.Port));
    } catch (Err) {
      Finish({ Kind: 'offline', Error: ErrorMessage(Err) });
      return;
    }

    Socket.addEventListener('open', () => {
      Opened = true;
    });
    Socket.addEventListener('message', (Event) => {
      OnMessage(Obj(Event) ? (Event as { data?: unknown }).data : undefined);
    });
    // The WHATWG error event carries no detail; the close that always follows
    // carries the code, so the verdict is made there.
    Socket.addEventListener('error', () => {});
    Socket.addEventListener('close', (Event) => {
      if (Settled) return;
      const E = Obj(Event) || {};
      const Code = Num(E.code) ?? 1006;
      const Reason = Str(E.reason) || '';
      if (Code === CLOSE_AUTH_FAILED && Hello) {
        Finish({
          Kind: 'auth-failed',
          Snapshot: PartialFromHello(Hello, Latency()),
          Reason: 'Password rejected by OBS',
        });
      } else if (Code === CLOSE_UNSUPPORTED_RPC) {
        Finish({
          Kind: 'not-obs',
          Reason: 'OBS refused the protocol version (obs-websocket too old?)',
          LatencyMs: Latency(),
        });
      } else if (Code === CLOSE_SESSION_INVALIDATED) {
        Finish({
          Kind: 'not-obs',
          Reason: 'OBS closed the session (kicked from the session list)',
          LatencyMs: Latency(),
        });
      } else if (Hello) {
        Finish({
          Kind: 'not-obs',
          Reason: `OBS closed the connection (${Code}${Reason ? ` ${Reason}` : ''})`,
          LatencyMs: Latency(),
        });
      } else {
        Finish({
          Kind: 'offline',
          Error: Opened
            ? `Connection closed before OBS said Hello (${Code})`
            : 'Failed to connect to the OBS WebSocket server',
        });
      }
    });
  });
}

function PartialFromHello(Hello: Json, LatencyMs: number): Partial<ObsSnapshot> {
  return {
    LatencyMs,
    ObsVersion: Str(Hello.obsStudioVersion),
    WebSocketVersion: Str(Hello.obsWebSocketVersion),
    RpcVersion: Num(Hello.rpcVersion),
    AuthRequired: !!Obj(Hello.authentication),
  };
}

// --- Dropped-frame deltas ------------------------------------------------------
//
// Each counter keeps its own baseline sample. A verdict needs a real window:
// at least MIN_DROP_WINDOW_MS since the baseline AND at least MIN_DROP_FRAMES
// new frames. Until both hold the OLD baseline is kept and no verdict is given,
// so a short window — two probes moments apart (a manual run just before a
// tick) — can never turn 1 skipped frame in 2 into "50%".
//
// Baselines are keyed per CHECK (the check instance passed to Run carries its
// CheckID), so two checks on the same OBS with different settings — which the
// target runs together — never measure against each other's sample. A probe
// with no check id (the editor's test run) falls back to address:port.

const MIN_DROP_WINDOW_MS = 5000;
const MIN_DROP_FRAMES = 60;

interface DropSample {
  Skipped: number;
  Total: number;
  At: number;
}

export interface DropBaseline {
  Network: DropSample | null;
  Encoding: DropSample | null;
  Rendering: DropSample | null;
}

const Baselines = new Map<string, DropBaseline>();

// Swappable clock so tests can step past the minimum window without waiting.
let Clock: () => number = () => Date.now();
function SetClock(Fn: (() => number) | null): void {
  Clock = Fn || (() => Date.now());
}

function CountersOf(Snapshot: ObsSnapshot): ObsCounters {
  return {
    StreamActive: Snapshot.Stream ? Snapshot.Stream.Active : null,
    StreamSkipped: Snapshot.Stream ? Snapshot.Stream.SkippedFrames : null,
    StreamTotal: Snapshot.Stream ? Snapshot.Stream.TotalFrames : null,
    EncodeSkipped: Snapshot.Stats ? Snapshot.Stats.OutputSkippedFrames : null,
    EncodeTotal: Snapshot.Stats ? Snapshot.Stats.OutputTotalFrames : null,
    RenderSkipped: Snapshot.Stats ? Snapshot.Stats.RenderSkippedFrames : null,
    RenderTotal: Snapshot.Stats ? Snapshot.Stats.RenderTotalFrames : null,
  };
}

export interface DropDelta {
  Skipped: number;
  Total: number;
  Percent: number;
  WindowMs: number;
}

export interface DropDeltas {
  Network: DropDelta | null;
  Encoding: DropDelta | null;
  Rendering: DropDelta | null;
}

// One counter's step: the delta (if the window qualifies) and the baseline to
// keep for next time.
function StepCounter(
  Prev: DropSample | null,
  Skipped: number | null,
  Total: number | null,
  Now: number
): { Delta: DropDelta | null; Next: DropSample | null } {
  if (Skipped == null || Total == null) return { Delta: null, Next: null };
  const Fresh: DropSample = { Skipped, Total, At: Now };
  // First sample, or a counter going backwards (OBS / the output restarted):
  // start a new baseline here.
  if (!Prev || Total < Prev.Total || Skipped < Prev.Skipped) return { Delta: null, Next: Fresh };
  const Frames = Total - Prev.Total;
  const WindowMs = Now - Prev.At;
  if (WindowMs < MIN_DROP_WINDOW_MS || Frames < MIN_DROP_FRAMES) return { Delta: null, Next: Prev };
  const Dropped = Skipped - Prev.Skipped;
  return {
    Delta: { Skipped: Dropped, Total: Frames, Percent: (Dropped / Frames) * 100, WindowMs },
    Next: Fresh,
  };
}

// Advance a check's baseline with a new sample. Pure — exported for tests.
function AdvanceDropBaseline(
  Prev: DropBaseline | null,
  Cur: ObsCounters,
  Now: number
): { Deltas: DropDeltas; Next: DropBaseline } {
  // The stream counters belong to one stream session; while no stream is live
  // there is nothing to compare and the baseline is dropped.
  const Network =
    Cur.StreamActive === true
      ? StepCounter(Prev ? Prev.Network : null, Cur.StreamSkipped, Cur.StreamTotal, Now)
      : { Delta: null, Next: null };
  const Encoding = StepCounter(
    Prev ? Prev.Encoding : null,
    Cur.EncodeSkipped,
    Cur.EncodeTotal,
    Now
  );
  const Rendering = StepCounter(
    Prev ? Prev.Rendering : null,
    Cur.RenderSkipped,
    Cur.RenderTotal,
    Now
  );
  return {
    Deltas: { Network: Network.Delta, Encoding: Encoding.Delta, Rendering: Rendering.Delta },
    Next: { Network: Network.Next, Encoding: Encoding.Next, Rendering: Rendering.Next },
  };
}

function CheckIdOf(Target: MonitoringTargetLike): number | null {
  const Raw = Target ? (Target as { CheckID?: unknown }).CheckID : null;
  return typeof Raw === 'number' && Number.isInteger(Raw) && Raw > 0 ? Raw : null;
}

function BaselineKey(Target: MonitoringTargetLike, Config: ObsConfig): string {
  const CheckID = CheckIdOf(Target);
  return CheckID != null ? `check:${CheckID}` : `addr:${Config.Address}:${Config.Port}`;
}

function RememberBaseline(Key: string, Baseline: DropBaseline): void {
  Baselines.delete(Key); // re-insert so the Map's order is least-recent first
  Baselines.set(Key, Baseline);
  while (Baselines.size > MAX_REMEMBERED_TARGETS) {
    const Oldest = Baselines.keys().next();
    if (Oldest.done) break;
    Baselines.delete(Oldest.value);
  }
}

function ResetBaselines(): void {
  Baselines.clear();
}

// The registry caches a probe result by Address + Settings. Run's result now
// also depends on the check's own baseline, so the check id joins the key and
// two identical checks each keep their own window.
function GetRunCacheKeyExtra(Target: MonitoringTargetLike): unknown {
  return CheckIdOf(Target);
}

// --- Evaluation -------------------------------------------------------------

function FormatPercent(Value: number): string {
  return `${Math.round(Value * 10) / 10}%`;
}

// The reasons a reachable OBS is unhealthy, per the enabled toggles. Pure —
// exported via _internal for unit tests.
function EvaluateHealth(
  Snapshot: ObsSnapshot,
  Deltas: DropDeltas,
  Options: HealthOptions
): string[] {
  const Reasons: string[] = [];

  if (Options.CheckStreaming) {
    if (!Snapshot.Stream) Reasons.push('Failed to read the stream status');
    else if (Snapshot.Stream.Reconnecting) Reasons.push('Stream reconnecting');
    else if (!Snapshot.Stream.Active) Reasons.push('Not streaming');
  }

  if (Options.CheckRecording) {
    if (!Snapshot.Record) Reasons.push('Failed to read the recording status');
    else if (!Snapshot.Record.Active) Reasons.push('Not recording');
    else if (Snapshot.Record.Paused) Reasons.push('Recording paused');
  }

  if (Options.CheckDroppedFrames) {
    const Limit = Options.MaxDroppedPercent;
    const Judge = (Delta: DropDelta | null, Label: string): void => {
      if (Delta && Delta.Skipped > 0 && Delta.Percent > Limit) {
        Reasons.push(`${Label} ${FormatPercent(Delta.Percent)} (limit ${Limit}%)`);
      }
    };
    Judge(Deltas.Network, 'Dropped frames (network)');
    Judge(Deltas.Encoding, 'Encoding lag');
    Judge(Deltas.Rendering, 'Rendering lag');
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
  const Outcome = await QueryObs(Config);

  if (Outcome.Kind === 'offline') return { Success: false, Error: Outcome.Error };
  if (Outcome.Kind === 'not-obs') {
    return {
      Success: true,
      Degraded: true,
      DegradedReason: Outcome.Reason,
      LatencyMs: Outcome.LatencyMs,
    };
  }
  if (Outcome.Kind === 'auth-failed') {
    return {
      Success: true,
      Degraded: true,
      DegradedReason: Outcome.Reason,
      AuthFailed: true,
      ...Outcome.Snapshot,
    };
  }

  const Snap = Outcome.Snapshot;
  const Key = BaselineKey(Target, Config);
  const Step = AdvanceDropBaseline(Baselines.get(Key) || null, CountersOf(Snap), Clock());
  RememberBaseline(Key, Step.Next);
  const Deltas = Step.Deltas;
  const Reasons = EvaluateHealth(Snap, Deltas, Options);

  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs: Snap.LatencyMs,
    ObsVersion: Snap.ObsVersion,
    WebSocketVersion: Snap.WebSocketVersion,
    RpcVersion: Snap.RpcVersion,
    Platform: Snap.Platform,
    PlatformDescription: Snap.PlatformDescription,
    AuthRequired: Snap.AuthRequired,
    StreamActive: Snap.Stream ? Snap.Stream.Active : null,
    StreamReconnecting: Snap.Stream ? Snap.Stream.Reconnecting : null,
    StreamTimecode: Snap.Stream ? Snap.Stream.Timecode : null,
    StreamDurationMs: Snap.Stream ? Snap.Stream.DurationMs : null,
    StreamCongestion: Snap.Stream ? Snap.Stream.Congestion : null,
    StreamBytes: Snap.Stream ? Snap.Stream.Bytes : null,
    StreamSkippedFrames: Snap.Stream ? Snap.Stream.SkippedFrames : null,
    StreamTotalFrames: Snap.Stream ? Snap.Stream.TotalFrames : null,
    RecordActive: Snap.Record ? Snap.Record.Active : null,
    RecordPaused: Snap.Record ? Snap.Record.Paused : null,
    RecordTimecode: Snap.Record ? Snap.Record.Timecode : null,
    RecordDurationMs: Snap.Record ? Snap.Record.DurationMs : null,
    RecordBytes: Snap.Record ? Snap.Record.Bytes : null,
    CpuUsage: Snap.Stats ? Snap.Stats.CpuUsage : null,
    MemoryUsage: Snap.Stats ? Snap.Stats.MemoryUsage : null,
    AvailableDiskSpace: Snap.Stats ? Snap.Stats.AvailableDiskSpace : null,
    ActiveFps: Snap.Stats ? Snap.Stats.ActiveFps : null,
    AverageFrameRenderTime: Snap.Stats ? Snap.Stats.AverageFrameRenderTime : null,
    RenderSkippedFrames: Snap.Stats ? Snap.Stats.RenderSkippedFrames : null,
    RenderTotalFrames: Snap.Stats ? Snap.Stats.RenderTotalFrames : null,
    OutputSkippedFrames: Snap.Stats ? Snap.Stats.OutputSkippedFrames : null,
    OutputTotalFrames: Snap.Stats ? Snap.Stats.OutputTotalFrames : null,
    ProgramScene: Snap.ProgramScene,
    DropDeltas: Deltas,
    RequestErrors: Snap.RequestErrors,
  };
}

function StatePill(Result: MonitoringResult): string {
  const Reachable = !!(Result && Result.Success === true);
  if (Reachable && !Result.Degraded) return Pill('success', 'Online');
  if (Reachable) return Pill('warning', Result.DegradedReason || 'Degraded');
  return Pill('danger', 'Offline');
}

function MonoRow(Label: string, Value: string): string {
  return Row(Label, `<span class="font-monospace">${Value}</span>`);
}

function FormatBytes(Value: unknown): string {
  const N = Number(Value);
  if (Value == null || !Number.isFinite(N)) return '—';
  const Units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let V = N;
  let I = 0;
  while (V >= 1024 && I < Units.length - 1) {
    V /= 1024;
    I++;
  }
  return `${I === 0 ? V : V.toFixed(1)} ${Units[I]}`;
}

function OutputPill(Active: unknown, Warn: boolean, WarnText: string): string {
  if (Active == null) return Pill('muted', 'Unknown');
  if (Warn) return Pill('warning', WarnText);
  return Active ? Pill('success', 'Live') : Pill('muted', 'Off');
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseConfig(Target);
  const Reachable = !!(Result && Result.Success === true);
  const Num1 = (Value: unknown, Suffix = ''): string =>
    Value == null || !Number.isFinite(Number(Value))
      ? '—'
      : `${Math.round(Number(Value) * 10) / 10}${Suffix}`;
  const Frames = (Skipped: unknown, Total: unknown): string =>
    Skipped == null || Total == null ? '—' : `${Number(Skipped)} / ${Number(Total)}`;

  const Identity = [
    Result && Result.ObsVersion ? `OBS ${Result.ObsVersion}` : null,
    Result && Result.WebSocketVersion ? `obs-websocket ${Result.WebSocketVersion}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const Rows0: Array<string | null> = [
    TextRow('Host', `${Config.Address || '—'}:${Config.Port}`),
    Identity ? TextRow('Version', Identity) : null,
    Reachable && Result.PlatformDescription
      ? TextRow('Platform', Result.PlatformDescription)
      : null,
    Row('Status', StatePill(Result)),
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Failed to reach OBS'),
  ];

  if (Reachable && Result.ProgramScene != null) {
    Rows0.push(TextRow('Program scene', Result.ProgramScene));
  }
  if (Reachable && Result.StreamActive !== undefined) {
    Rows0.push(
      Row(
        'Stream',
        OutputPill(Result.StreamActive, !!Result.StreamReconnecting, 'Reconnecting') +
          (Result.StreamActive
            ? ` <span class="font-monospace">${Esc(Result.StreamTimecode || '')} · ${Esc(FormatBytes(Result.StreamBytes))}</span>`
            : '')
      )
    );
    Rows0.push(
      MonoRow(
        'Dropped (network)',
        Esc(Frames(Result.StreamSkippedFrames, Result.StreamTotalFrames))
      )
    );
  }
  if (Reachable && Result.RecordActive !== undefined) {
    Rows0.push(
      Row(
        'Recording',
        OutputPill(Result.RecordActive, !!(Result.RecordActive && Result.RecordPaused), 'Paused') +
          (Result.RecordActive
            ? ` <span class="font-monospace">${Esc(Result.RecordTimecode || '')} · ${Esc(FormatBytes(Result.RecordBytes))}</span>`
            : '')
      )
    );
  }
  if (Reachable && Result.CpuUsage !== undefined) {
    Rows0.push(MonoRow('CPU', Esc(Num1(Result.CpuUsage, '%'))));
    Rows0.push(MonoRow('Active FPS', Esc(Num1(Result.ActiveFps))));
    Rows0.push(MonoRow('Render time', Esc(Num1(Result.AverageFrameRenderTime, ' ms'))));
    Rows0.push(
      MonoRow('Encoding lag', Esc(Frames(Result.OutputSkippedFrames, Result.OutputTotalFrames)))
    );
    Rows0.push(
      MonoRow('Rendering lag', Esc(Frames(Result.RenderSkippedFrames, Result.RenderTotalFrames)))
    );
  }
  const Deltas = Result && (Result.DropDeltas as DropDeltas | undefined);
  if (Reachable && Deltas) {
    const Show = (Delta: DropDelta | null): string =>
      Delta
        ? `${FormatPercent(Delta.Percent)} (${Delta.Skipped} / ${Delta.Total} over ${Math.round(Delta.WindowMs / 1000)} s)`
        : '—';
    Rows0.push(
      MonoRow(
        'Drop window',
        Esc(
          `network ${Show(Deltas.Network)} · encoding ${Show(Deltas.Encoding)} · rendering ${Show(Deltas.Rendering)}`
        )
      )
    );
  }

  const Head = Rows(Rows0);
  if (!Reachable) {
    return (
      Head +
      '<div class="mt-2">' +
      Note('Failed to reach OBS. Enable the server under Tools → WebSocket Server Settings.') +
      '</div>'
    );
  }
  return Head;
}

export const Name = 'OBS Studio';
export const Description =
  'Connects to OBS Studio over obs-websocket 5 (default port 4455) and reads the OBS and plugin versions, stream and recording state, program scene and performance stats. Optionally flags a stream or recording that is not running and dropped frames since the previous check. Read-only: it only sends Get requests.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseConfig,
  ParseHealthOptions,
  BuildUrl,
  BuildAuthString,
  ParseBatchResults,
  CountersOf,
  AdvanceDropBaseline,
  BaselineKey,
  EvaluateHealth,
  QueryObs,
  SetWebSocketImpl,
  ResetBaselines,
  SetClock,
  Baselines,
  MIN_DROP_WINDOW_MS,
  MIN_DROP_FRAMES,
};
export { ID, Settings, Run, Debug, GetRunCacheKeyExtra };
