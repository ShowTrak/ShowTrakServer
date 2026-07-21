// ScriptExecutionManager
// - Tracks execution requests (internal tasks or client scripts)
// - Provides queue semantics with timeouts and progress updates
import { CreateLogger } from '../Logger';
import type { Client } from '../ClientManager/client';
import { SCRIPT_EXECUTION_DEFAULT_TIMEOUT_MS } from '../Config/constants';
import { Manager as BroadcastManager } from '../Broadcast';
import { Manager as UUIDManager } from '../UUID';

const Logger = CreateLogger('ScriptExecutionManager');

// The subset of a script definition this manager reads. Covers both a full
// ScriptManager entry and the synthetic `{ ID, Name }` stub used for internal
// tasks; platform fields are therefore optional.
interface DispatchableScript {
  ID: string;
  Name: string;
  Timeout?: number;
  Platforms?: Record<string, unknown>;
  CompatiblePlatforms?: string[];
}

import { Manager as ScriptManager } from '../ScriptManager';
import { Manager as ClientManager } from '../ClientManager';

interface ExecutionTimer {
  Start: number;
  End: number | null;
  Duration: number | null;
}

interface ScriptExecution {
  Internal: boolean;
  RequestID: string;
  Status: 'Pending' | 'Failed' | 'Completed';
  Progress: number;
  StatusText: string;
  Timer: ExecutionTimer;
  Client: Client;
  Script: DispatchableScript;
  Error?: string | null;
  // Per-client sequential queue bookkeeping. A script execution stays queued
  // (Dispatched=false, Status=Pending, StatusText='Queued') until the client is
  // idle, at which point it is dispatched. Internal tasks dispatch immediately
  // and are excluded from the per-client gate.
  Dispatched: boolean;
  // Timeout to arm when this entry is dispatched (not while it waits in queue).
  Timeout?: number;
  // Handle for the pending timeout watchdog; cleared once the request settles
  // so a completed execution never leaves a live timer dangling.
  TimeoutHandle?: ReturnType<typeof setTimeout> | null;
}

// The renderer-safe projection of an execution. A live ScriptExecution carries a
// Client CLASS INSTANCE and a Node timer handle (TimeoutHandle) — neither
// survives Electron's structured-clone IPC (or the Web UI socket) — so anything
// pushed to a renderer MUST go through this plain-object projection instead of
// the raw entry.
interface PublicScriptExecution {
  Internal: boolean;
  RequestID: string;
  Status: 'Pending' | 'Failed' | 'Completed';
  Progress: number;
  StatusText: string;
  Timer: ExecutionTimer;
  Client: { UUID: string | null; Nickname: string | null; Hostname: string | null };
  Script: { ID: string; Name: string };
  Error: string | null;
}

// Project a live execution to its renderer-safe shape. Reads defensively because
// the value arrives at the push boundary through the untyped broadcast bus.
function ToPublicScriptExecution(Exec: ScriptExecution): PublicScriptExecution {
  const C = Exec.Client;
  return {
    Internal: !!Exec.Internal,
    RequestID: String(Exec.RequestID),
    Status: Exec.Status,
    Progress: Exec.Progress,
    StatusText: Exec.StatusText,
    Timer: {
      Start: Exec.Timer ? Exec.Timer.Start : 0,
      End: Exec.Timer ? Exec.Timer.End : null,
      Duration: Exec.Timer ? Exec.Timer.Duration : null,
    },
    Client: {
      UUID: C ? C.UUID : null,
      Nickname: C ? (C.Nickname ?? null) : null,
      Hostname: C ? (C.Hostname ?? null) : null,
    },
    Script: {
      ID: Exec.Script ? String(Exec.Script.ID ?? '') : '',
      Name: Exec.Script ? String(Exec.Script.Name ?? '') : '',
    },
    Error: Exec.Error ?? null,
  };
}

// FIFO-ish list used for UI progress; not a strict job queue
let ScriptExecutions: ScriptExecution[] = [];

function NormalizeClientPlatformKey(Client: Client): string | null {
  const Raw = String((Client && Client.OperatingSystem) || '')
    .trim()
    .toLowerCase();
  if (!Raw) return null;
  if (Raw.includes('win')) return 'Windows';
  if (Raw.includes('mac') || Raw.includes('darwin') || Raw.includes('os x')) return 'macOS';
  if (
    Raw.includes('linux') ||
    Raw.includes('ubuntu') ||
    Raw.includes('debian') ||
    Raw.includes('raspbian')
  ) {
    return 'Linux';
  }
  return null;
}

function ResolveDispatchBlockReason(Script: DispatchableScript, Client: Client): string | null {
  const PlatformKey = NormalizeClientPlatformKey(Client);
  if (!PlatformKey) {
    return 'Unable to determine client operating system.';
  }

  const Platforms: Record<string, unknown> = Script && Script.Platforms ? Script.Platforms : {};
  const PlatformValue = Platforms[PlatformKey];
  const PlatformPath = typeof PlatformValue === 'string' ? PlatformValue.trim() : '';
  if (!PlatformPath) {
    return `No ${PlatformKey} script is configured for this script.`;
  }

  const Compatible: string[] = Array.isArray(Script.CompatiblePlatforms)
    ? Script.CompatiblePlatforms
    : [];
  if (!Compatible.includes(PlatformKey)) {
    return `${PlatformKey} script file "${PlatformPath}" was not found.`;
  }

  return null;
}

// Injected by the Server layer: performs the actual socket emit that starts a
// script on a client. Kept as a seam so this manager can own every queue and
// dispatch decision (enqueue, completion, timeout) in one place rather than
// scattering the "dispatch the next queued script" logic across call sites.
let DispatchHandler: ((UUID: string, RequestID: string, ScriptID: string) => void) | null = null;

function SetDispatchHandler(
  Handler: (UUID: string, RequestID: string, ScriptID: string) => void
): void {
  DispatchHandler = Handler;
}

// Per-client sequential dispatch. Each client runs one script at a time: if the
// client already has a dispatched-but-unsettled script, do nothing; otherwise
// dispatch the oldest queued (not-yet-dispatched) script for that client. Called
// on enqueue and whenever an in-flight script settles (completion or timeout),
// so a client steadily works through its queue top-to-bottom.
function PumpClient(UUID: string | null | undefined): void {
  if (!UUID) return;
  const Busy = ScriptExecutions.some(
    (e) =>
      !e.Internal && e.Client && e.Client.UUID === UUID && e.Dispatched && e.Status === 'Pending'
  );
  if (Busy) return;
  const Next = ScriptExecutions.find(
    (e) =>
      !e.Internal && e.Client && e.Client.UUID === UUID && !e.Dispatched && e.Status === 'Pending'
  );
  if (!Next) return;

  // Re-validate eligibility at dispatch time, not just at enqueue. A script can
  // wait in this queue behind an in-flight one for a long time, and the client
  // may go offline (or otherwise become ineligible) in the meantime — the
  // enqueue-time fast-fail only covers the instant of enqueue. Without this,
  // dispatching to a now-dead client parks a live entry that holds the client's
  // whole queue hostage until its full timeout elapses. Client is the live
  // cached instance (ClientManager mutates it in place), so `.Online` is current.
  const BlockReason = !Next.Client.Online
    ? 'Client is offline'
    : ResolveDispatchBlockReason(Next.Script, Next.Client);
  if (BlockReason) {
    Next.Dispatched = true;
    Next.Status = 'Failed';
    Next.Error = BlockReason;
    Next.StatusText = 'Failed';
    Next.Timer.End = Date.now();
    Next.Timer.Duration = 0;
    BroadcastManager.emit('ScriptExecutionUpdated', ScriptExecutions);
    // This entry is settled and no longer blocks the client — try the next
    // queued script (which is re-validated the same way). Failed/settled entries
    // are excluded from both checks above, so this recursion terminates.
    PumpClient(UUID);
    return;
  }

  Next.Dispatched = true;
  // Start the clock (and arm the timeout watchdog) at real dispatch time so the
  // time a script spent waiting in the queue is not counted against it.
  Next.Timer.Start = Date.now();
  Next.StatusText = 'Pending';
  Manager.SetTimeout(Next.RequestID, Next.Timeout || SCRIPT_EXECUTION_DEFAULT_TIMEOUT_MS);
  if (DispatchHandler) {
    DispatchHandler(UUID, Next.RequestID, String(Next.Script ? Next.Script.ID : ''));
  } else {
    Logger.warn('No dispatch handler registered; queued script will not start');
  }
  BroadcastManager.emit('ScriptExecutionUpdated', ScriptExecutions);
}

const Manager = {
  async GetAllExecutions(): Promise<ScriptExecution[]> {
    return ScriptExecutions;
  },

  async GetExecution(RequestID: string): Promise<ScriptExecution | null> {
    return ScriptExecutions.find((execution) => execution.RequestID === RequestID) || null;
  },

  // Drop all pending/complete entries and notify the UI
  async ClearQueue(): Promise<void> {
    for (const Request of ScriptExecutions) Manager.ClearTimeout(Request);
    ScriptExecutions = [];
    BroadcastManager.emit('ScriptExecutionUpdated', ScriptExecutions);
  },

  // Drop only settled (Completed/Failed) entries, preserving anything still
  // Pending — queued or in flight. Used as the "reset" when a new batch starts
  // so a fresh run clears the finished rows from the last batch but never
  // disturbs scripts that are still queued or running.
  async ClearSettled(): Promise<void> {
    const Remaining: ScriptExecution[] = [];
    for (const Request of ScriptExecutions) {
      if (Request.Status === 'Pending') {
        Remaining.push(Request);
      } else {
        Manager.ClearTimeout(Request);
      }
    }
    ScriptExecutions = Remaining;
    BroadcastManager.emit('ScriptExecutionUpdated', ScriptExecutions);
  },

  // Clear a request's pending timeout watchdog, if one is armed.
  ClearTimeout(Request: ScriptExecution): void {
    if (Request.TimeoutHandle) {
      clearTimeout(Request.TimeoutHandle);
      Request.TimeoutHandle = null;
    }
  },

  // Convert a pending request to Failed after Timeout ms, if still pending
  SetTimeout(RequestID: string, Timeout: number): void {
    const Target = ScriptExecutions.find((execution) => execution.RequestID === RequestID);
    if (!Target) return;
    // Replace any timer already armed for this request (e.g. a re-queue).
    Manager.ClearTimeout(Target);
    Target.TimeoutHandle = setTimeout(() => {
      const Request = ScriptExecutions.find((execution) => execution.RequestID === RequestID);
      if (!Request) return;
      Request.TimeoutHandle = null;
      if (Request.Status === 'Pending') {
        Request.Status = 'Failed';
        Request.StatusText = 'Failed';
        Request.Error = 'Script execution timed out after ' + Timeout + 'ms';
        Request.Timer.End = Date.now();
        Request.Timer.Duration = Request.Timer.End - Request.Timer.Start;
      }
      BroadcastManager.emit('ScriptExecutionUpdated', ScriptExecutions);
      // The client is free again — dispatch its next queued script.
      if (!Request.Internal) PumpClient(Request.Client ? Request.Client.UUID : null);
    }, Timeout);
    // The timeout watchdog must not, by itself, keep the process alive.
    if (typeof Target.TimeoutHandle.unref === 'function') Target.TimeoutHandle.unref();
    return;
  },

  // Enqueue a synthetic/internal action for a client (e.g., Wake On LAN)
  async AddInternalTaskToQueue(UUID: string, TaskName: string): Promise<string | undefined> {
    const [Err, Client] = await ClientManager.Get(UUID);
    if (Err || !Client) return;

    const RequestID = UUIDManager.Generate();

    ScriptExecutions.push({
      Internal: true,
      RequestID: RequestID,
      Status: 'Pending',
      // Internal tasks are emitted immediately by the caller and are not part of
      // the per-client script queue, so they are marked dispatched up front.
      Dispatched: true,
      Progress: 0,
      StatusText: 'Pending',
      Timer: {
        Start: Date.now(),
        End: null,
        Duration: null,
      },
      Client: Client,
      Script: {
        ID: TaskName,
        Name: TaskName,
      },
    });

    Manager.SetTimeout(RequestID, SCRIPT_EXECUTION_DEFAULT_TIMEOUT_MS);

    BroadcastManager.emit('ScriptExecutionUpdated', ScriptExecutions);

    return RequestID;
  },

  // Enqueue a script for a client. Always appends to the bottom of the queue —
  // never replaces an existing entry — so starting a new run while one is in
  // flight leaves the running/queued work untouched and the new script simply
  // waits its turn (per-client sequential execution, driven by PumpClient).
  async AddToQueue(UUID: string, ScriptID: string): Promise<string | undefined> {
    const Script = await ScriptManager.Get(ScriptID);
    if (!Script) return;

    const [Err, Client] = await ClientManager.Get(UUID);
    if (Err || !Client) return;

    const RequestID = UUIDManager.Generate();

    // Invalid (unparseable) scripts have no Timeout field; `in` narrows the
    // union to the valid variant before reading it, and they fall back to the
    // default timeout (dispatch of invalid scripts is blocked below).
    const Timeout =
      'Timeout' in Script &&
      typeof Script.Timeout === 'number' &&
      Number.isInteger(Script.Timeout) &&
      Script.Timeout > 0
        ? Script.Timeout
        : SCRIPT_EXECUTION_DEFAULT_TIMEOUT_MS;

    const Entry: ScriptExecution = {
      Internal: false,
      RequestID: RequestID,
      Status: 'Pending',
      Dispatched: false,
      Progress: 0,
      StatusText: 'Queued',
      Timer: {
        Start: Date.now(),
        End: null,
        Duration: null,
      },
      Client: Client,
      Script: Script,
      Timeout: Timeout,
    };
    ScriptExecutions.push(Entry);

    // An offline or incompatible client can never receive the dispatch, so fail
    // the request now rather than leaving it queued and blocking the client.
    const DispatchBlockReason = Client.Online
      ? ResolveDispatchBlockReason(Script, Client)
      : 'Client is offline';
    if (DispatchBlockReason) {
      Entry.Status = 'Failed';
      Entry.Error = DispatchBlockReason;
      Entry.StatusText = 'Failed';
      Entry.Dispatched = true;
      Entry.Timer.End = Date.now();
      Entry.Timer.Duration = 0;
      BroadcastManager.emit('ScriptExecutionUpdated', ScriptExecutions);
      return RequestID;
    }

    BroadcastManager.emit('ScriptExecutionUpdated', ScriptExecutions);
    // Dispatch now if the client is idle; otherwise this entry waits behind the
    // client's in-flight script and is dispatched when that one settles.
    PumpClient(UUID);

    return RequestID;
  },

  async ShouldDispatch(RequestID: string): Promise<boolean> {
    const Request = ScriptExecutions.find((execution) => execution.RequestID === RequestID);
    return !!(Request && Request.Status === 'Pending');
  },

  // Update request progress without completing the task.
  async UpdateProgress(
    RequestID: string,
    Progress: unknown = 0,
    StatusText: string | null = null
  ): Promise<void> {
    const Request = ScriptExecutions.find((execution) => execution.RequestID === RequestID);
    if (!Request) return;
    if (Request.Status !== 'Pending') return;

    let NormalizedProgress = Number(Progress);
    if (!Number.isFinite(NormalizedProgress)) NormalizedProgress = 0;
    if (NormalizedProgress < 0) NormalizedProgress = 0;
    if (NormalizedProgress > 100) NormalizedProgress = 100;

    Request.Progress = Math.round(NormalizedProgress);
    if (typeof StatusText === 'string' && StatusText.trim().length > 0) {
      Request.StatusText = StatusText.trim();
    }

    BroadcastManager.emit('ScriptExecutionUpdated', ScriptExecutions);
  },

  // Mark a request as completed or failed; compute duration and broadcast
  async Complete(RequestID: string, Err: unknown): Promise<void> {
    const Request = ScriptExecutions.find((execution) => execution.RequestID === RequestID);
    if (Err) Logger.error(`Script execution failed for ${Request?.Client?.UUID}`, Err);
    if (!Request) return;
    Manager.ClearTimeout(Request);
    if (Err)
      Request.Error = typeof Err === 'string' ? Err : (Err as Error).message || 'Unknown error';
    else Request.Error = null;
    Request.Status = Err ? 'Failed' : 'Completed';
    Request.Progress = Err ? Request.Progress || 0 : 100;
    Request.StatusText = Err ? 'Failed' : 'Completed';
    Request.Timer.End = Date.now();
    Request.Timer.Duration = Request.Timer.End - Request.Timer.Start;
    BroadcastManager.emit('ScriptExecutionUpdated', ScriptExecutions);
    // The client is free again — dispatch its next queued script (if any).
    if (!Request.Internal) PumpClient(Request.Client ? Request.Client.UUID : null);
  },
};

export { Manager, ToPublicScriptExecution, SetDispatchHandler };
export type { PublicScriptExecution, ScriptExecution };
