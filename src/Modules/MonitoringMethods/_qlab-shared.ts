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
import type { MonitoringActionDef, MonitoringResult, MonitoringSettingField } from './types';
import { MONITORING_INTEREST_TTL_MS } from '../Config/constants';

const Logger = CreateLogger('QLab');

export const DEFAULT_OSC_PORT = 53000;

const MIN_PORT = 1;
const MAX_PORT = 65535;
const CONNECT_TIMEOUT_MS = 5000; // give up an unestablished TCP connect after this
const HEARTBEAT_MS = 10000; // re-query core attributes to refresh + prove liveness
const STALE_AFTER_MS = 20000; // no successful contact within this → snapshot offline
const INTEREST_TTL_MS = MONITORING_INTEREST_TTL_MS; // close a connection unobserved this long
const SWEEP_INTERVAL_MS = 30000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const UPDATE_DEBOUNCE_MS = 200; // coalesce bursts of update notifications
const MAX_STREAM_BYTES = 4_000_000; // guard against unbounded reply buffering
const COMMAND_TIMEOUT_MS = 3000; // a control message QLab has not answered by now has failed
const REFRESH_TIMEOUT_MS = 1500; // how long an action waits for the post-action re-read

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

// The key a reply is matched to its request on: the address with any
// `/workspace/<id>` prefix removed, since whether QLab echoes the prefix back
// is not something to depend on.
export function ReplyKey(Address: string): string {
  return String(Address || '').replace(/^\/workspace\/[^/]+/, '');
}

function IsReportedFlag(Data: unknown): boolean {
  return typeof Data === 'boolean' || typeof Data === 'number';
}

// Why QLab refused a message, from its reply status. Shown to the operator
// verbatim, so it names the setting that fixes it.
export function DescribeRefusal(Status: string): string {
  if (Status === 'denied') {
    return 'QLab denied the command — this connection lacks control access. Set an OSC passcode with control access in QLab (Workspace Settings → Network) and enter it on this check';
  }
  if (Status === 'badpass') return 'QLab rejected the OSC passcode';
  return 'QLab could not carry out the command';
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
  Waiters: ReplyWaiter[];
}

// Someone awaiting QLab's reply to a message this connection sent. Matched on
// the reply's address with any `/workspace/<id>` prefix stripped (see
// ReplyKey), first-come first-served. A consuming waiter swallows the reply —
// an action's acknowledgement carries no state worth applying — while a
// non-consuming one lets it update the snapshot too.
interface ReplyWaiter {
  Key: string;
  Consume: boolean;
  Resolve: (Reply: QLabReply | null, Error?: string) => void;
  Timer: NodeJS.Timeout;
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
        Waiters: [],
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
    if (this.SettleWaiter(Conn, Reply)) return;
    if (Reply.Status !== 'ok') return;
    this.ApplyReply(Conn, Reply);
  }

  // Hand a reply to the first waiter expecting its address. Returns true when
  // that waiter consumed it, so it is not also applied to the snapshot.
  private SettleWaiter(Conn: Connection, Reply: QLabReply): boolean {
    const Key = ReplyKey(Reply.Address);
    const Index = Conn.Waiters.findIndex((Waiter) => Waiter.Key === Key);
    if (Index === -1) return false;
    const [Waiter] = Conn.Waiters.splice(Index, 1);
    clearTimeout(Waiter!.Timer);
    Waiter!.Resolve(Reply);
    return Waiter!.Consume;
  }

  // Send one message and wait for QLab's reply to it (every message is
  // answered, since the connection opened with /alwaysReply 1). Resolves with
  // the reply, or null and a reason when none arrives.
  private Request(
    Conn: Connection,
    Address: string,
    Args: OscArg[],
    Consume: boolean,
    TimeoutMs: number
  ): Promise<{ Reply: QLabReply | null; Error?: string }> {
    return new Promise((resolve) => {
      const Waiter: ReplyWaiter = {
        Key: ReplyKey(Address),
        Consume,
        Resolve: (Reply, Error) => resolve({ Reply, Error }),
        Timer: setTimeout(() => {
          const Index = Conn.Waiters.indexOf(Waiter);
          if (Index !== -1) Conn.Waiters.splice(Index, 1);
          resolve({ Reply: null, Error: `No reply from QLab after ${TimeoutMs}ms` });
        }, TimeoutMs),
      };
      if (typeof Waiter.Timer.unref === 'function') Waiter.Timer.unref();
      Conn.Waiters.push(Waiter);
      this.Send(Conn, Address, Args);
    });
  }

  private FailWaiters(Conn: Connection, Reason: string): void {
    const Waiters = Conn.Waiters.splice(0);
    for (const Waiter of Waiters) {
      clearTimeout(Waiter.Timer);
      Waiter.Resolve(null, Reason);
    }
  }

  /**
   * Send a control message over the target's persistent connection and wait
   * for QLab to acknowledge it. `Scope: 'workspace'` prefixes the address with
   * the resolved workspace, so the command lands on the workspace this check
   * watches rather than on every open one.
   *
   * There is deliberately no connect-on-demand: a target nobody is observing
   * has no workspace resolved to address, and the check's own tick opens the
   * connection well before an operator can press anything.
   */
  async Command(
    Params: ConnectionParams,
    Address: string,
    Args: OscArg[],
    Scope: 'workspace' | 'application'
  ): Promise<{ Success: boolean; Error?: string }> {
    const Key = this.Observe(Params);
    const Conn = this.Connections.get(Key)!;
    if (Conn.State !== 'ready') {
      return { Success: false, Error: Conn.Snapshot.Error || 'Not connected to QLab yet' };
    }
    if (Scope === 'workspace' && !Conn.Snapshot.WorkspaceID) {
      return {
        Success: false,
        Error: Conn.Params.Workspace ? 'Workspace not open in QLab' : 'No workspaces open in QLab',
      };
    }
    const Full = Scope === 'workspace' ? this.Ws(Conn, Address) : Address;
    const { Reply, Error } = await this.Request(Conn, Full, Args, true, COMMAND_TIMEOUT_MS);
    if (!Reply) return { Success: false, Error: Error || 'No reply from QLab' };
    if (Reply.Status !== 'ok') return { Success: false, Error: DescribeRefusal(Reply.Status) };
    return { Success: true };
  }

  /**
   * Re-read the tracked attributes now and wait for them to land, so the
   * re-probe an action triggers reports the state it produced rather than the
   * one it replaced. Best effort: a slow reply only means the tile catches up
   * on the next heartbeat.
   */
  async Refresh(Params: ConnectionParams): Promise<void> {
    const Conn = this.Connections.get(BuildKey(Params));
    if (!Conn || Conn.State !== 'ready' || !Conn.Snapshot.WorkspaceID) return;
    this.QueryCore(Conn);
    // Replies arrive in the order the queries went out, so the last one
    // landing means the whole batch has been applied.
    const Last = OVERRIDE_KEYS[OVERRIDE_KEYS.length - 1];
    await this.Request(Conn, `/overrides/${Last}`, [], false, REFRESH_TIMEOUT_MS);
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

    // A setter's acknowledgement shares its address with the query but carries
    // no data, so only a reply that actually reports a value may change state.
    if (Addr.endsWith('/showMode')) {
      if (!IsReportedFlag(Reply.Data)) return;
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
      if ((OVERRIDE_KEYS as readonly string[]).includes(Key) && IsReportedFlag(Reply.Data)) {
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
    this.FailWaiters(Conn, Reason);
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
      this.FailWaiters(Conn, 'Connection closed');
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
      this.FailWaiters(Conn, 'Connection closed');
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

// --- Actions shared by QLab 4 and QLab 5 ------------------------------------
//
// Every message here is workspace-scoped (`/workspace/<id>/...`): unscoped,
// QLab 5 delivers a workspace message to EVERY open workspace and QLab 4 to the
// frontmost one, and neither is necessarily the workspace this check watches.
//
// GO is not marked Destructive: firing the next cue is what the button is for,
// and a confirmation in front of it defeats a quick GO from a favourite. The
// ones that cut a running show short (stop, hard stop, panic, reset) are.

const CUE_PARAM: MonitoringSettingField = {
  Key: 'Cue',
  Label: 'Cue number',
  Type: 'string',
  Default: '',
  Required: true,
  Note: 'The cue number as shown in QLab. A cue list number GOs that list.',
};

export const TRANSPORT_ACTIONS: MonitoringActionDef[] = [
  {
    ID: 'go',
    Label: 'GO',
    Icon: 'play-fill',
    Group: 'Playback',
    Note: 'GOs the current cue list from the playhead.',
  },
  {
    ID: 'go.cue',
    Label: 'GO Cue',
    Icon: 'skip-forward-fill',
    Group: 'Playback',
    Params: [CUE_PARAM],
    Note: 'Moves the playhead to a cue and GOs it.',
  },
  { ID: 'pause', Label: 'Pause All', Icon: 'pause-fill', Group: 'Playback' },
  { ID: 'resume', Label: 'Resume All', Icon: 'play', Group: 'Playback' },
  {
    ID: 'stop',
    Label: 'Stop All',
    Icon: 'stop-fill',
    Group: 'Stop',
    Destructive: true,
    Note: 'Stops every cue, letting audio effects such as reverb tails ring out.',
  },
  {
    ID: 'panic',
    Label: 'Panic',
    Icon: 'exclamation-octagon',
    Group: 'Stop',
    Destructive: true,
    Note: 'Fades everything out over the workspace panic time, then stops.',
  },
  {
    ID: 'stop.hard',
    Label: 'Hard Stop',
    Icon: 'stop-circle-fill',
    Group: 'Stop',
    Destructive: true,
    Note: 'Stops every cue and cuts audio effects immediately.',
  },
  {
    ID: 'reset',
    Label: 'Reset Workspace',
    Icon: 'arrow-counterclockwise',
    Group: 'Stop',
    Destructive: true,
    Note: 'Stops everything, returns the playhead to the top and undoes live changes.',
  },
];

export const MODE_ACTIONS: MonitoringActionDef[] = [
  { ID: 'mode.show', Label: 'Show Mode', Icon: 'display', Group: 'Mode' },
  {
    ID: 'mode.edit',
    Label: 'Edit Mode',
    Icon: 'pencil-square',
    Group: 'Mode',
    Note: 'Leaves show mode, so the workspace can be edited.',
  },
];

export interface QLabCommand {
  /** Relative to the workspace: `/go` is sent as `/workspace/<id>/go`. */
  Address: string;
  Args: OscArg[];
  Detail: string;
}

// The longest cue number accepted. QLab's own limit is far higher; this only
// stops a pasted paragraph reaching the wire.
const MAX_CUE_LENGTH = 64;

/**
 * The OSC message for one shared action, or the reason it cannot be sent.
 * QLab 5 takes a boolean for show mode, QLab 4 a number read as one.
 */
export function BuildQLabCommand(
  ActionID: string,
  Params: Record<string, unknown>,
  Version: 4 | 5
): QLabCommand | { Error: string } {
  switch (ActionID) {
    case 'go':
      return { Address: '/go', Args: [], Detail: 'GO sent' };
    case 'go.cue': {
      const Cue = String(Params.Cue == null ? '' : Params.Cue).trim();
      if (!Cue) return { Error: 'Enter the cue number to GO' };
      if (Cue.length > MAX_CUE_LENGTH) return { Error: 'Cue number is too long' };
      // Always a string argument: QLab ignores `/go 53` but honours `/go "53"`.
      return { Address: '/go', Args: [Cue], Detail: `GO sent to cue ${Cue}` };
    }
    case 'pause':
      return { Address: '/pause', Args: [], Detail: 'Paused all cues' };
    case 'resume':
      return { Address: '/resume', Args: [], Detail: 'Resumed paused cues' };
    case 'stop':
      return { Address: '/stop', Args: [], Detail: 'Stopped all cues' };
    case 'panic':
      return { Address: '/panic', Args: [], Detail: 'Panic sent' };
    case 'stop.hard':
      return { Address: '/hardStop', Args: [], Detail: 'Hard stop sent' };
    case 'reset':
      return { Address: '/reset', Args: [], Detail: 'Workspace reset' };
    case 'mode.show':
    case 'mode.edit': {
      const On = ActionID === 'mode.show';
      return {
        Address: '/showMode',
        Args: [Version === 5 ? On : { Int: On ? 1 : 0 }],
        Detail: On ? 'Switched to show mode' : 'Switched to edit mode',
      };
    }
    default:
      return { Error: `Unknown QLab action "${ActionID}"` };
  }
}

// Bind a GO Cue favourite's cue number into its label.
export function DescribeQLabAction(
  ActionID: string,
  Params: Record<string, unknown>
): string | null {
  if (ActionID !== 'go.cue') return null;
  const Cue = String(Params.Cue == null ? '' : Params.Cue).trim();
  return Cue ? `GO Cue — ${Cue}` : null;
}

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
  ReplyKey,
  BuildQLabCommand,
};

// Re-export for the method module's convenience.
export type { MonitoringResult };
