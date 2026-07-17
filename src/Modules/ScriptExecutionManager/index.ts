// ScriptExecutionManager
// - Tracks execution requests (internal tasks or client scripts)
// - Provides queue semantics with timeouts and progress updates
import { CreateLogger } from '../Logger';
import type { ClientManagerType } from '../ClientManager';
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

// The slice of the (require-loaded) ScriptManager surface used here.
interface ScriptManagerSurface {
  Get(ScriptID: string): Promise<DispatchableScript | null>;
}

const { Manager: ScriptManager } = require('../ScriptManager') as { Manager: ScriptManagerSurface };
const { Manager: ClientManager } = require('../ClientManager') as { Manager: ClientManagerType };

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
  // Handle for the pending timeout watchdog; cleared once the request settles
  // so a completed execution never leaves a live timer dangling.
  TimeoutHandle?: ReturnType<typeof setTimeout> | null;
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
        Request.Error = 'Script execution timed out after ' + Timeout + 'ms';
        Request.Timer.End = Date.now();
        Request.Timer.Duration = Request.Timer.End - Request.Timer.Start;
      }
      BroadcastManager.emit('ScriptExecutionUpdated', ScriptExecutions);
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

  // Enqueue a script for a client. Replace existing entry if one exists for this client.
  async AddToQueue(UUID: string, ScriptID: string): Promise<string | undefined> {
    const Script = await ScriptManager.Get(ScriptID);
    if (!Script) return;

    const [Err, Client] = await ClientManager.Get(UUID);
    if (Err || !Client) return;

    const RequestID = UUIDManager.Generate();

    const ExistingCommand = ScriptExecutions.find((Exe) => Exe.Client.UUID === UUID);
    if (ExistingCommand) {
      ExistingCommand.RequestID = RequestID;
      ExistingCommand.Timer = {
        Start: Date.now(),
        End: null,
        Duration: null,
      };
      ExistingCommand.Status = 'Pending';
      ExistingCommand.Progress = 0;
      ExistingCommand.StatusText = 'Pending';
    } else {
      ScriptExecutions.push({
        Internal: false,
        RequestID: RequestID,
        Status: 'Pending',
        Progress: 0,
        StatusText: 'Pending',
        Timer: {
          Start: Date.now(),
          End: null,
          Duration: null,
        },
        Client: Client,
        Script: Script,
      });
    }

    const DispatchBlockReason = ResolveDispatchBlockReason(Script, Client);
    if (DispatchBlockReason) {
      const Request = ScriptExecutions.find((Exe) => Exe.RequestID === RequestID);
      if (Request) {
        Manager.ClearTimeout(Request);
        Request.Status = 'Failed';
        Request.Error = DispatchBlockReason;
        Request.StatusText = 'Failed';
        Request.Timer.End = Date.now();
        Request.Timer.Duration = Request.Timer.End - Request.Timer.Start;
      }
      BroadcastManager.emit('ScriptExecutionUpdated', ScriptExecutions);
      return RequestID;
    }

    const Timeout =
      typeof Script.Timeout === 'number' && Number.isInteger(Script.Timeout) && Script.Timeout > 0
        ? Script.Timeout
        : SCRIPT_EXECUTION_DEFAULT_TIMEOUT_MS;
    Manager.SetTimeout(RequestID, Timeout);

    BroadcastManager.emit('ScriptExecutionUpdated', ScriptExecutions);

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
  },
};

export { Manager };
