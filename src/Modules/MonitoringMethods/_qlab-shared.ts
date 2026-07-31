// Shared plumbing for the QLab 5 monitoring method (qlab5).
//
// APPROACH: PERSISTENT CONNECTION + /updates SUBSCRIPTION.
//
// Rather than opening a throwaway TCP socket each tick, this method inspects live
// state INSIDE a workspace, so it holds ONE persistent SLIP/TCP connection per QLab
// target and subscribes to QLab's `/updates` feed. QLab's updates are change-
// NOTIFICATIONS, not state, so the connection is a hybrid: it learns *when*
// something changed, then re-queries the actual values (debounced) and caches a
// snapshot.
//
// There is no framework teardown hook for monitoring methods (see
// MonitoringTargetManager: check delete/edit only stops the target's tick timer,
// it never notifies the method). So — exactly like _millumin-shared's
// MilluminReceiver and _ndi-shared's NdiBrowser — this is a self-reaping,
// module-level singleton: Run() calls Observe() to keep a connection alive, and a
// periodic sweep closes any connection not observed within an interest TTL. When a
// check is deleted or repointed, Run() simply stops calling Observe() for the old
// key and the socket reaps itself.
//
// Importing this module has NO side effects — nothing connects until the first
// Observe().
import net from 'net';
import { CreateLogger } from '../Logger';
import { EncodeOscTcp, DecodeOscStream, type OscArg, type OscMessage } from './_osc-shared';
import type { MonitoringResult } from './types';

const Logger = CreateLogger('QLab');

export const DEFAULT_OSC_PORT = 53000;

const MIN_PORT = 1;
const MAX_PORT = 65535;
const CONNECT_TIMEOUT_MS = 5000; // give up an unestablished TCP connect after this
const HEARTBEAT_MS = 10000; // re-query core attributes to refresh + prove liveness
const STALE_AFTER_MS = 20000; // no successful contact within this → snapshot offline
const INTEREST_TTL_MS = 120000; // close a connection unobserved this long
const SWEEP_INTERVAL_MS = 30000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const UPDATE_DEBOUNCE_MS = 200; // coalesce bursts of update notifications
const MAX_STREAM_BYTES = 4_000_000; // guard against unbounded reply buffering

// The set of override flags we track. Overrides are GLOBAL (application-level) in
// QLab, addressed `/overrides/{key}` — NOT workspace-scoped — and are queried with
// no argument (read), replying with a boolean: true = that subsystem is enabled
// (normal); false = overridden/suppressed. Querying a key QLab doesn't recognise
// simply yields no reply — harmless.
export const OVERRIDE_KEYS = [
  'dmxOutputEnabled',
  'midiInputEnabled',
  'midiOutputEnabled',
  'mscInputEnabled',
  'mscOutputEnabled',
  'sysexInputEnabled',
  'sysexOutputEnabled',
  'networkExternalInputEnabled',
  'networkExternalOutputEnabled',
  'networkLocalInputEnabled',
  'networkLocalOutputEnabled',
  'timecodeInputEnabled',
  'timecodeOutputEnabled',
] as const;

export type OverrideKey = (typeof OVERRIDE_KEYS)[number];

// --- Workspace matching -----------------------------------------------------

export function NormalizeWorkspace(Value: unknown): string {
  return String(Value == null ? '' : Value)
    .trim()
    .toLowerCase()
    .replace(/\.qlab[45]?$/, '');
}

interface QLabWorkspaceInfo {
  uniqueID?: unknown;
  displayName?: unknown;
}

export function WorkspaceMatches(Workspace: unknown, Wanted: unknown): boolean {
  if (!Workspace || typeof Workspace !== 'object') return false;
  const Ws = Workspace as QLabWorkspaceInfo;
  const WantedRaw = String(Wanted).trim().toLowerCase();
  const WantedNorm = NormalizeWorkspace(Wanted);
  if (!WantedNorm) return false;
  const UniqueID = Ws.uniqueID == null ? '' : String(Ws.uniqueID).trim().toLowerCase();
  if (UniqueID && (UniqueID === WantedRaw || UniqueID === WantedNorm)) return true;
  if (Ws.displayName != null && NormalizeWorkspace(Ws.displayName) === WantedNorm) return true;
  return false;
}

// --- QLab reply envelope ----------------------------------------------------

export interface QLabReply {
  Address: string;
  Status: string;
  Data: unknown;
  WorkspaceID: string | null;
}

// QLab answers a query with an OSC message to `/reply/...` whose single string
// argument is a JSON envelope: {workspace_id, address, status, data}. Parse it.
// Returns null for anything that isn't a well-formed reply envelope.
export function ParseQLabReply(Message: OscMessage): QLabReply | null {
  if (!Message || typeof Message.Address !== 'string') return null;
  if (!Message.Address.startsWith('/reply')) return null;
  const Arg = Array.isArray(Message.Args) ? Message.Args.find((A) => typeof A === 'string') : null;
  if (typeof Arg !== 'string') return null;
  try {
    const Obj = JSON.parse(Arg) as Record<string, unknown>;
    if (!Obj || typeof Obj !== 'object') return null;
    const Address =
      typeof Obj.address === 'string' ? Obj.address : Message.Address.replace(/^\/reply/, '');
    return {
      Address,
      Status: typeof Obj.status === 'string' ? Obj.status : 'ok',
      Data: 'data' in Obj ? Obj.data : undefined,
      WorkspaceID: typeof Obj.workspace_id === 'string' ? Obj.workspace_id : null,
    };
  } catch {
    return null;
  }
}

// --- Snapshot ---------------------------------------------------------------

export interface QLabCueRef {
  uniqueID: string;
  number: string;
  name: string;
  listName: string;
}

export interface QLabSnapshot {
  Connected: boolean;
  Ready: boolean; // workspace resolved + at least one successful query
  Error: string | null;
  WorkspaceFound: boolean;
  WorkspaceID: string | null;
  WorkspaceName: string | null;
  ShowMode: boolean | null; // true = show mode, false = edit mode, null = unknown
  RunningCues: QLabCueRef[];
  Overrides: Partial<Record<OverrideKey, boolean>>;
  LastContactAt: number;
  Stale: boolean;
}

function EmptySnapshot(): QLabSnapshot {
  return {
    Connected: false,
    Ready: false,
    Error: null,
    WorkspaceFound: false,
    WorkspaceID: null,
    WorkspaceName: null,
    ShowMode: null,
    RunningCues: [],
    Overrides: {},
    LastContactAt: 0,
    Stale: true,
  };
}

// --- Connection -------------------------------------------------------------

interface ConnectionParams {
  Address: string;
  Port: number;
  Workspace: string; // wanted workspace name/filename/unique id
  Passcode: string;
}

interface Connection {
  Key: string;
  Params: ConnectionParams;
  Socket: net.Socket | null;
  Stream: Buffer;
  State: 'idle' | 'connecting' | 'ready' | 'failed';
  LastInterestAt: number;
  LastContactAt: number;
  ReconnectAttempts: number;
  ReconnectTimer: NodeJS.Timeout | null;
  HeartbeatTimer: NodeJS.Timeout | null;
  UpdateTimer: NodeJS.Timeout | null;
  Snapshot: QLabSnapshot;
}

function BuildKey(P: ConnectionParams): string {
  return `${P.Address.toLowerCase()}|${P.Port}|${NormalizeWorkspace(P.Workspace)}`;
}

class QLabConnectionManagerImpl {
  private Connections = new Map<string, Connection>();
  private SweepTimer: NodeJS.Timeout | null = null;

  // Register interest in a QLab target, opening the connection if needed.
  Observe(Params: ConnectionParams): string {
    const Key = BuildKey(Params);
    let Conn = this.Connections.get(Key);
    if (!Conn) {
      Conn = {
        Key,
        Params,
        Socket: null,
        Stream: Buffer.alloc(0),
        State: 'idle',
        LastInterestAt: Date.now(),
        LastContactAt: 0,
        ReconnectAttempts: 0,
        ReconnectTimer: null,
        HeartbeatTimer: null,
        UpdateTimer: null,
        Snapshot: EmptySnapshot(),
      };
      this.Connections.set(Key, Conn);
    }
    Conn.LastInterestAt = Date.now();
    this.EnsureConnected(Conn);
    this.EnsureSweep();
    return Key;
  }

  // Read the current snapshot for a target. Does not open a connection.
  Snapshot(Key: string): QLabSnapshot {
    const Conn = this.Connections.get(Key);
    if (!Conn) return EmptySnapshot();
    const Snap = Conn.Snapshot;
    // Derive freshness on read so a silently-dead socket surfaces as stale.
    const Stale = !Conn.LastContactAt || Date.now() - Conn.LastContactAt > STALE_AFTER_MS;
    return { ...Snap, Connected: Conn.State === 'ready', Stale };
  }

  // Send a workspace-scoped message on an already-observed connection, e.g.
  // SendToWorkspace(Key, '/cue/5/start'). Returns false when the connection is
  // unknown, not ready, its socket is gone, or the workspace has not resolved.
  //
  // A false return MUST be surfaced as a failure by the caller. "Wrote nothing
  // because the socket was down" is the QLab form of the reports-success-but-
  // did-nothing trap, and it is the likely case during a show — QLab quit, the
  // workspace closed, the passcode changed. Refusing on an unresolved workspace
  // matters just as much: QLab silently ignores `/workspace/null/...`, which
  // would otherwise read as a cue that fired.
  SendToWorkspace(Key: string, Suffix: string, Args: OscArg[] = []): boolean {
    const Conn = this.Connections.get(Key);
    if (!Conn || Conn.State !== 'ready') return false;
    if (!Conn.Snapshot.WorkspaceID) return false;
    const Socket = Conn.Socket;
    if (!Socket || Socket.destroyed) return false;
    this.Send(Conn, this.Ws(Conn, Suffix), Args);
    return true;
  }

  private EnsureConnected(Conn: Connection): void {
    if (Conn.State === 'ready' || Conn.State === 'connecting') return;
    if (Conn.ReconnectTimer) return; // a reconnect is already scheduled
    this.Connect(Conn);
  }

  private Connect(Conn: Connection): void {
    Conn.State = 'connecting';
    Conn.Stream = Buffer.alloc(0);
    const Socket = new net.Socket();
    Conn.Socket = Socket;
    Socket.setTimeout(CONNECT_TIMEOUT_MS);

    Socket.once('connect', () => {
      Socket.setTimeout(0);
      Conn.ReconnectAttempts = 0;
      // Passcode first (if any), then resolve the workspace; subscription + initial
      // queries happen once /workspaces replies.
      if (Conn.Params.Passcode) this.Send(Conn, '/connect', [Conn.Params.Passcode]);
      this.Send(Conn, '/alwaysReply', [{ Int: 1 }]);
      this.Send(Conn, '/workspaces', []);
    });

    Socket.on('data', (Chunk: Buffer) => this.OnData(Conn, Chunk));
    Socket.once('timeout', () => this.Drop(Conn, 'Connection timed out'));
    Socket.once('error', (Err: Error) =>
      this.Drop(Conn, Err && Err.message ? Err.message : String(Err))
    );
    Socket.once('close', () => {
      if (Conn.Socket === Socket && Conn.State !== 'failed') this.Drop(Conn, 'Connection closed');
    });

    try {
      Socket.connect(Conn.Params.Port, Conn.Params.Address);
    } catch (Err) {
      this.Drop(Conn, Err && (Err as Error).message ? (Err as Error).message : String(Err));
    }
  }

  private Send(Conn: Connection, Address: string, Args: Parameters<typeof EncodeOscTcp>[1]): void {
    const Socket = Conn.Socket;
    if (!Socket || Socket.destroyed) return;
    try {
      Socket.write(EncodeOscTcp(Address, Args, 'slip'));
    } catch {
      // A failed write surfaces via the socket 'error'/'close' handlers.
    }
  }

  // Workspace-scoped address helper.
  private Ws(Conn: Connection, Suffix: string): string {
    return `/workspace/${Conn.Snapshot.WorkspaceID}${Suffix}`;
  }

  private OnData(Conn: Connection, Chunk: Buffer): void {
    Conn.Stream = Buffer.concat([Conn.Stream, Chunk]);
    if (Conn.Stream.length > MAX_STREAM_BYTES) {
      this.Drop(Conn, 'Reply stream too large');
      return;
    }
    const { Messages, Rest } = DecodeOscStream(Conn.Stream, 'slip');
    Conn.Stream = Rest;
    for (const Message of Messages) this.Dispatch(Conn, Message);
  }

  private Dispatch(Conn: Connection, Message: OscMessage): void {
    if (typeof Message.Address !== 'string') return;
    Conn.LastContactAt = Date.now();

    if (Message.Address.startsWith('/update')) {
      this.HandleUpdate(Conn, Message);
      return;
    }

    const Reply = ParseQLabReply(Message);
    if (!Reply) return;
    if (Reply.Status !== 'ok') return;
    this.ApplyReply(Conn, Reply);
  }

  private ApplyReply(Conn: Connection, Reply: QLabReply): void {
    const Snap = Conn.Snapshot;
    const Addr = Reply.Address;

    if (Addr.endsWith('/workspaces')) {
      const List = Array.isArray(Reply.Data) ? Reply.Data : [];
      const Wanted = Conn.Params.Workspace;
      // With no workspace configured, target whichever workspace is open (the
      // first one QLab reports). Otherwise match by name/filename/unique ID.
      const Match = (
        Wanted
          ? List.find((W) => WorkspaceMatches(W, Wanted))
          : List.find(
              (W) => W && typeof W === 'object' && (W as QLabWorkspaceInfo).uniqueID != null
            )
      ) as QLabWorkspaceInfo | undefined;
      if (Match) {
        Snap.WorkspaceFound = true;
        Snap.WorkspaceID = String(Match.uniqueID == null ? '' : Match.uniqueID);
        Snap.WorkspaceName = Match.displayName == null ? null : String(Match.displayName);
        Snap.Error = null;
        Conn.State = 'ready';
        this.OnWorkspaceReady(Conn);
      } else {
        Snap.WorkspaceFound = false;
        Snap.WorkspaceID = null;
        Snap.Error = Wanted ? 'Workspace not open in QLab' : 'No workspaces open in QLab';
        Conn.State = 'ready'; // reachable, just wrong/missing workspace
      }
      return;
    }

    if (Addr.endsWith('/showMode')) {
      Snap.ShowMode = Reply.Data === true || Reply.Data === 1;
      Snap.Ready = true;
      return;
    }

    if (Addr.endsWith('/runningOrPausedCues')) {
      Snap.RunningCues = NormalizeCueList(Reply.Data);
      Snap.Ready = true;
      return;
    }

    const OverrideMatch = /\/overrides\/([A-Za-z]+)$/.exec(Addr);
    if (OverrideMatch) {
      const Key = OverrideMatch[1] as OverrideKey;
      if ((OVERRIDE_KEYS as readonly string[]).includes(Key)) {
        Snap.Overrides[Key] = Reply.Data === true || Reply.Data === 1;
        Snap.Ready = true;
      }
      return;
    }
  }

  private HandleUpdate(Conn: Connection, Message: OscMessage): void {
    const Addr = Message.Address;

    if (/\/disconnect$/.test(Addr)) {
      this.Drop(Conn, 'QLab requested disconnect');
      return;
    }

    // Any update (cue edited/started/stopped, workspace changed) → refresh the core
    // attributes, debounced to coalesce bursts.
    this.ScheduleRefresh(Conn);
  }

  private OnWorkspaceReady(Conn: Connection): void {
    if (!Conn.Snapshot.WorkspaceID) return;
    // Subscribe to updates for this workspace, then seed all core attributes.
    this.Send(Conn, this.Ws(Conn, '/updates'), [{ Int: 1 }]);
    this.QueryCore(Conn);
    this.EnsureHeartbeat(Conn);
  }

  // Query the always-tracked attributes (mode, running cues, overrides).
  private QueryCore(Conn: Connection): void {
    if (Conn.State !== 'ready' || !Conn.Snapshot.WorkspaceID) return;
    this.Send(Conn, this.Ws(Conn, '/showMode'), []);
    this.Send(Conn, this.Ws(Conn, '/runningOrPausedCues'), []);
    // Overrides are global (application-level), not workspace-scoped.
    for (const Key of OVERRIDE_KEYS) this.Send(Conn, `/overrides/${Key}`, []);
  }

  private ScheduleRefresh(Conn: Connection): void {
    if (Conn.UpdateTimer) return;
    Conn.UpdateTimer = setTimeout(() => {
      Conn.UpdateTimer = null;
      // If we haven't resolved the workspace yet, re-resolve; else refresh core.
      if (!Conn.Snapshot.WorkspaceID) this.Send(Conn, '/workspaces', []);
      else this.QueryCore(Conn);
    }, UPDATE_DEBOUNCE_MS);
    if (typeof Conn.UpdateTimer.unref === 'function') Conn.UpdateTimer.unref();
  }

  private EnsureHeartbeat(Conn: Connection): void {
    if (Conn.HeartbeatTimer) return;
    Conn.HeartbeatTimer = setInterval(() => {
      if (Conn.State !== 'ready') return;
      if (!Conn.Snapshot.WorkspaceID) this.Send(Conn, '/workspaces', []);
      else this.QueryCore(Conn);
    }, HEARTBEAT_MS);
    if (typeof Conn.HeartbeatTimer.unref === 'function') Conn.HeartbeatTimer.unref();
  }

  private Drop(Conn: Connection, Reason: string): void {
    const WasReady = Conn.State === 'ready';
    Conn.State = 'failed';
    Conn.Snapshot.Connected = false;
    Conn.Snapshot.Ready = false;
    Conn.Snapshot.Error = Reason;
    this.ClearTimers(Conn, /* keepReconnect */ true);
    if (Conn.Socket) {
      try {
        Conn.Socket.destroy();
      } catch {
        // ignore
      }
      Conn.Socket = null;
    }
    if (WasReady)
      Logger.warn(`QLab connection to ${Conn.Params.Address}:${Conn.Params.Port} lost: ${Reason}`);
    this.ScheduleReconnect(Conn);
  }

  private ScheduleReconnect(Conn: Connection): void {
    if (Conn.ReconnectTimer) return;
    // Only reconnect while there is still interest in this target.
    if (Date.now() - Conn.LastInterestAt > INTEREST_TTL_MS) return;
    const Delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** Math.min(6, Conn.ReconnectAttempts)
    );
    Conn.ReconnectAttempts += 1;
    Conn.ReconnectTimer = setTimeout(() => {
      Conn.ReconnectTimer = null;
      if (Date.now() - Conn.LastInterestAt > INTEREST_TTL_MS) return;
      this.Connect(Conn);
    }, Delay);
    if (typeof Conn.ReconnectTimer.unref === 'function') Conn.ReconnectTimer.unref();
  }

  private ClearTimers(Conn: Connection, keepReconnect = false): void {
    if (Conn.HeartbeatTimer) {
      clearInterval(Conn.HeartbeatTimer);
      Conn.HeartbeatTimer = null;
    }
    if (Conn.UpdateTimer) {
      clearTimeout(Conn.UpdateTimer);
      Conn.UpdateTimer = null;
    }
    if (!keepReconnect && Conn.ReconnectTimer) {
      clearTimeout(Conn.ReconnectTimer);
      Conn.ReconnectTimer = null;
    }
  }

  private EnsureSweep(): void {
    if (this.SweepTimer) return;
    this.SweepTimer = setInterval(() => this.Sweep(), SWEEP_INTERVAL_MS);
    if (typeof this.SweepTimer.unref === 'function') this.SweepTimer.unref();
  }

  private Sweep(): void {
    const Now = Date.now();
    for (const [Key, Conn] of this.Connections) {
      if (Now - Conn.LastInterestAt <= INTEREST_TTL_MS) continue;
      this.ClearTimers(Conn);
      if (Conn.Socket) {
        try {
          Conn.Socket.destroy();
        } catch {
          // ignore
        }
      }
      this.Connections.delete(Key);
    }
  }

  // Test-only teardown so a suite can connect/disconnect deterministically.
  Stop(): void {
    if (this.SweepTimer) {
      clearInterval(this.SweepTimer);
      this.SweepTimer = null;
    }
    for (const Conn of this.Connections.values()) {
      this.ClearTimers(Conn);
      if (Conn.Socket) {
        try {
          Conn.Socket.destroy();
        } catch {
          // ignore
        }
      }
    }
    this.Connections.clear();
  }
}

// Coerce QLab's runningOrPausedCues data into a clean cue-ref array.
export function NormalizeCueList(Data: unknown): QLabCueRef[] {
  if (!Array.isArray(Data)) return [];
  const Out: QLabCueRef[] = [];
  for (const Item of Data) {
    if (!Item || typeof Item !== 'object') continue;
    const C = Item as Record<string, unknown>;
    Out.push({
      uniqueID: C.uniqueID == null ? '' : String(C.uniqueID),
      number: C.number == null ? '' : String(C.number),
      name: C.name == null ? '' : String(C.name),
      listName: C.listName == null ? '' : String(C.listName),
    });
  }
  return Out;
}

export const QLabConnectionManager = new QLabConnectionManagerImpl();

export function IsValidPort(Port: number): boolean {
  return Number.isInteger(Port) && Port >= MIN_PORT && Port <= MAX_PORT;
}

export const _internal = {
  ParseQLabReply,
  WorkspaceMatches,
  NormalizeWorkspace,
  NormalizeCueList,
  BuildKey,
  QLabConnectionManager,
};

// Re-export for the method module's convenience.
export type { MonitoringResult };
