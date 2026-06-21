// ScriptExecutionManager
// - Tracks execution requests (internal tasks or client scripts)
// - Provides queue semantics with timeouts and progress updates
const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('ScriptExecutionManager');

const { Manager: ScriptManager } = require('../ScriptManager');
const { Manager: ClientManager } = require('../ClientManager');
const { Manager: BroadcastManager } = require('../Broadcast');
const { Manager: UUIDManager } = require('../UUID');

// FIFO-ish list used for UI progress; not a strict job queue
let ScriptExecutions = [];

const Manager = {};

Manager.GetAllExecutions = async () => {
  return ScriptExecutions;
};

Manager.GetExecution = async (RequestID) => {
  return ScriptExecutions.find((execution) => execution.RequestID === RequestID) || null;
};

// Drop all pending/complete entries and notify the UI
Manager.ClearQueue = async () => {
  ScriptExecutions = [];
  BroadcastManager.emit('ScriptExecutionUpdated', ScriptExecutions);
};

// Convert a pending request to Failed after Timeout ms, if still pending
Manager.SetTimeout = (RequestID, Timeout) => {
  setTimeout(() => {
    let Request = ScriptExecutions.find((execution) => execution.RequestID === RequestID);
    if (!Request) return;
    if (Request.Status === 'Pending') {
      Request.Status = 'Failed';
      Request.Error = 'Script execution timed out after ' + Timeout + 'ms';
      Request.Timer.End = Date.now();
      Request.Timer.Duration = Request.Timer.End - Request.Timer.Start;
    }
    BroadcastManager.emit('ScriptExecutionUpdated', ScriptExecutions);
  }, Timeout);
  return;
};

function NormalizeClientPlatformKey(Client) {
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

function ResolveDispatchBlockReason(Script, Client) {
  const PlatformKey = NormalizeClientPlatformKey(Client);
  if (!PlatformKey) {
    return 'Unable to determine client operating system.';
  }

  const Platforms = Script && Script.Platforms ? Script.Platforms : {};
  const PlatformPath =
    typeof Platforms[PlatformKey] === 'string' ? Platforms[PlatformKey].trim() : '';
  if (!PlatformPath) {
    return `No ${PlatformKey} script is configured for this script.`;
  }

  const Compatible = Array.isArray(Script && Script.CompatiblePlatforms)
    ? Script.CompatiblePlatforms
    : [];
  if (!Compatible.includes(PlatformKey)) {
    return `${PlatformKey} script file "${PlatformPath}" was not found.`;
  }

  return null;
}

// Enqueue a synthetic/internal action for a client (e.g., Wake On LAN)
Manager.AddInternalTaskToQueue = async (UUID, TaskName) => {
  let [Err, Client] = await ClientManager.Get(UUID);
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

  Manager.SetTimeout(RequestID, 15000);

  BroadcastManager.emit('ScriptExecutionUpdated', ScriptExecutions);

  return RequestID;
};

// Enqueue a script for a client. Replace existing entry if one exists for this client.
Manager.AddToQueue = async (UUID, ScriptID) => {
  let Script = await ScriptManager.Get(ScriptID);
  if (!Script) return;

  let [Err, Client] = await ClientManager.Get(UUID);
  if (Err || !Client) return;

  const RequestID = UUIDManager.Generate();

  let ExistingCommand = ScriptExecutions.find((Exe) => Exe.Client.UUID == UUID);
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
      : 15000;
  Manager.SetTimeout(RequestID, Timeout);

  BroadcastManager.emit('ScriptExecutionUpdated', ScriptExecutions);

  return RequestID;
};

Manager.ShouldDispatch = async (RequestID) => {
  const Request = ScriptExecutions.find((execution) => execution.RequestID === RequestID);
  return !!(Request && Request.Status === 'Pending');
};

// Update request progress without completing the task.
Manager.UpdateProgress = async (RequestID, Progress = 0, StatusText = null) => {
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
};

// Mark a request as completed or failed; compute duration and broadcast
Manager.Complete = async (RequestID, Err) => {
  let Request = ScriptExecutions.find((execution) => execution.RequestID === RequestID);
  if (Err) Logger.error(`Script execution failed for ${Request.Client.UUID}`, Err);
  if (!Request) return;
  if (Err) Request.Error = typeof Err === 'string' ? Err : Err.message || 'Unknown error';
  else Request.Error = null;
  Request.Status = Err ? 'Failed' : 'Completed';
  Request.Progress = Err ? Request.Progress || 0 : 100;
  Request.StatusText = Err ? 'Failed' : 'Completed';
  Request.Timer.End = Date.now();
  Request.Timer.Duration = Request.Timer.End - Request.Timer.Start;
  BroadcastManager.emit('ScriptExecutionUpdated', ScriptExecutions);
};

module.exports = {
  Manager,
};
