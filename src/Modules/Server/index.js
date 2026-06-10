// Socket/HTTP server for ShowTrak Clients
// - Hosts static script assets + the Web UI (PWA) at root
// - Wires the ShowTrak client namespace and the Web UI '/ui' namespace
//   (implemented in ./client-namespace and ./webui-namespace)
// - Exposes server-originated action dispatch (scripts, bulk requests, messaging)
const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('WebServer');

const HTTP = require('http');
const path = require('path');
const { Server: WebServer } = require('socket.io');
const { Config } = require('../Config');
const { Manager: AppDataManager } = require('../AppData');
const { Manager: ScriptExecutionManager } = require('../ScriptExecutionManager');
const { Manager: ClientManager } = require('../ClientManager');
const express = require('express');

const { Wait } = require('../Utils');

const { SetupClientNamespace } = require('./client-namespace');
const { SetupWebUiNamespace } = require('./webui-namespace');

// HTTP server backing express + Socket.IO
const Server = HTTP.createServer();
Server.on('error', (e) => {
  Logger.error('HTTP/Socket server error:', e && e.code ? e.code : e);
});

const app = express();

const ScriptDirectory = AppDataManager.GetScriptsDirectory();
app.use(express.static(ScriptDirectory));
// Serve Web UI (PWA) at root
const WebUIRoot = path.join(__dirname, '../../WebUI');
app.use('/', express.static(WebUIRoot));
app.get('/', (_req, res) => {
  res.sendFile(path.join(WebUIRoot, 'index.html'));
});
Server.on('request', app);

// Initialize Socket.IO server with conservative timeouts
const io = new WebServer(Server, {
  cors: {
    origin: '*', // Adjust as needed for security
    methods: ['GET', 'POST'],
  },
  connectTimeout: 4000,
  pingTimeout: 2500,
  pingInterval: 5000,
});

const Manager = {};

// Ask specific clients to execute a script by ID; optionally reset the queue first
Manager.ExecuteScripts = async (ScriptID, Targets, ResetList) => {
  if (ResetList) await ScriptExecutionManager.ClearQueue();
  for (const UUID of Targets) {
    const RequestID = await ScriptExecutionManager.AddToQueue(UUID, ScriptID);
    Logger.log('ExecuteScript dispatch', { ScriptID, UUID, RequestID });
    io.to(UUID).emit('ExecuteScript', RequestID, ScriptID);
  }
};

// Emit an arbitrary action to many clients with a user-friendly name for the queue UI
Manager.ExecuteBulkRequest = async (Action, Targets, ReadableName, Options = {}) => {
  if (!ReadableName) ReadableName = Action;
  const ResetQueue =
    !Options || typeof Options.resetQueue === 'undefined' ? true : !!Options.resetQueue;
  if (ResetQueue) await ScriptExecutionManager.ClearQueue();
  for (const UUID of Targets) {
    await Wait(150);
    const RequestID = await ScriptExecutionManager.AddInternalTaskToQueue(UUID, ReadableName);
    if (!RequestID) {
      continue;
    }

    const [ClientErr, Client] = await ClientManager.Get(UUID);
    if (ClientErr || !Client) {
      await ScriptExecutionManager.Complete(
        RequestID,
        ClientErr || 'Client not found in internal database'
      );
      continue;
    }

    if (!Client.Online) {
      await ScriptExecutionManager.Complete(RequestID, 'Client is not online');
      continue;
    }

    Logger.log('ExecuteBulkRequest dispatch', { Action, ReadableName, UUID, RequestID });
    io.to(UUID).emit(Action, RequestID);
  }
};

// Send a message to all sockets in a room (UUID or group ID)
Manager.SendMessageByGroup = async (Group, Message, Data) => {
  try {
    Logger.debug('SendMessageByGroup', { Group, Message });
  } catch {}
  return io.to(Group).emit(Message, Data);
};

// Wire both Socket.IO namespaces (client agents + Web UI).
SetupClientNamespace(io);
SetupWebUiNamespace(io, Manager);

Server.listen(Config.Application.Port, () => {
  Logger.log(`Socket.IO server running on port ${Config.Application.Port}`);
});

module.exports = {
  Manager,
};
