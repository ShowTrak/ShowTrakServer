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

// Enqueue a synthetic/internal action for a client (e.g., Wake On LAN)
Manager.AddInternalTaskToQueue = async (UUID, TaskName) => {
  let [Err, Client] = await ClientManager.Get(UUID);
  if (Err || !Client) return;

  const RequestID = UUIDManager.Generate();

  ScriptExecutions.push({
    Internal: true,
    RequestID: RequestID,
    Status: 'Pending',
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
  } else {
    ScriptExecutions.push({
      Internal: false,
      RequestID: RequestID,
      Status: 'Pending',
      Timer: {
        Start: Date.now(),
        End: null,
        Duration: null,
      },
      Client: Client,
      Script: Script,
    });
  }

  Manager.SetTimeout(RequestID, Script.Timeout || 5000);

  BroadcastManager.emit('ScriptExecutionUpdated', ScriptExecutions);

  return RequestID;
};

// Mark a request as completed or failed; compute duration and broadcast
Manager.Complete = async (RequestID, Err) => {
  let Request = ScriptExecutions.find((execution) => execution.RequestID === RequestID);
  if (Err) Logger.error(`Script execution failed for ${Request.Client.UUID}`, Err);
  if (!Request) return;
  if (Err) Request.Error = typeof Err === 'string' ? Err : Err.message || 'Unknown error';
  else Request.Error = null;
  Request.Status = Err ? 'Failed' : 'Completed';
  Request.Timer.End = Date.now();
  Request.Timer.Duration = Request.Timer.End - Request.Timer.Start;
  BroadcastManager.emit('ScriptExecutionUpdated', ScriptExecutions);
};

module.exports = {
  Manager,
};
