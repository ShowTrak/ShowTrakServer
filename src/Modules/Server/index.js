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
const { Manager: UpdateManager } = require('../UpdateManager');
const { Manager: DummyClientManager } = require('../DummyClientManager');
const { Manager: MonitoringTargetManager } = require('../MonitoringTargetManager');
const { OSC } = require('../OSC');
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

UpdateManager.RegisterRoutes(app);

app.use('/API', (req, res, next) => {
  const startAt = Date.now();
  res.on('finish', () => {
    const statusCode = Number(res.statusCode || 0);
    const sourceIP =
      req.ip ||
      (req.socket && req.socket.remoteAddress) ||
      (req.connection && req.connection.remoteAddress) ||
      null;

    const detailParts = [];
    if (res.locals && res.locals.debugTrafficDetail) {
      detailParts.push(String(res.locals.debugTrafficDetail));
    }
    detailParts.push(`${statusCode || '---'}`);
    if (Date.now() - startAt >= 0) detailParts.push(`${Date.now() - startAt}ms`);
    if (sourceIP) detailParts.push(sourceIP);

    Logger.log(`API ${req.method} ${req.originalUrl} -> ${statusCode}`);
    require('../Broadcast').Manager.emit('DebugTrafficEntry', {
      protocol: 'http',
      timestamp: Date.now(),
      valid: statusCode > 0 && statusCode < 400,
      summary: `${req.method} ${req.originalUrl || req.url || '/API'}`,
      detail: detailParts.join(' • '),
      source: sourceIP,
    });
  });
  next();
});

function sendApiError(res, httpStatus, code, message) {
  return res.status(httpStatus).json({
    Error: true,
    Code: code || httpStatus,
    Message: String(message || 'Request failed'),
  });
}

function sendApiSuccess(res, response) {
  return res.json({
    Error: false,
    Response: response,
  });
}

function computeStatus(Entity) {
  const Type = String((Entity && Entity.Type) || '').toLowerCase();
  if (Type === 'dummy' && String((Entity && Entity.State) || '').toUpperCase() === 'IDLE') {
    return 'IDLE';
  }
  if (Entity && Entity.Online && Entity.Degraded) return 'DEGRADED';
  if (Entity && Entity.Online) return 'ONLINE';
  return 'OFFLINE';
}

function canonicalizeTypeFilter(Value) {
  const Normalized = String(Value || '')
    .trim()
    .toUpperCase();
  if (!Normalized) return null;
  if (Normalized === 'REMOTE') return 'Remote';
  if (Normalized === 'MONITORING' || Normalized === 'MONITOR') return 'Monitoring';
  if (Normalized === 'DUMMY') return 'Dummy';
  return null;
}

const ClientsListHandler = async (req, res) => {
  const RawGroupID = String((req.query && req.query.GroupID) || '').trim();
  const HasGroupIDFilter = RawGroupID.length > 0;
  const GroupIDFilter = HasGroupIDFilter ? Number(RawGroupID) : null;
  if (HasGroupIDFilter && !Number.isFinite(GroupIDFilter)) {
    res.locals.debugTrafficDetail = `Invalid GroupID query "${RawGroupID}"`;
    return sendApiError(res, 400, 'INVALID_QUERY_GROUPID', 'Invalid GroupID query');
  }

  const OperatingSystemFilter = String((req.query && req.query.OperatingSystem) || '')
    .trim()
    .toLowerCase();

  const RawStatusFilter = String((req.query && req.query.Status) || '')
    .trim()
    .toUpperCase();
  const HasStatusFilter = RawStatusFilter.length > 0;
  const AllowedStatuses = new Set(['IDLE', 'OFFLINE', 'DEGRADED', 'ONLINE']);
  if (HasStatusFilter && !AllowedStatuses.has(RawStatusFilter)) {
    res.locals.debugTrafficDetail = `Invalid Status query "${RawStatusFilter}"`;
    return sendApiError(res, 400, 'INVALID_QUERY_STATUS', 'Invalid Status query');
  }

  const RawTypeFilter = String((req.query && req.query.Type) || '').trim();
  const TypeFilter = canonicalizeTypeFilter(RawTypeFilter);
  if (RawTypeFilter.length > 0 && !TypeFilter) {
    res.locals.debugTrafficDetail = `Invalid Type query "${RawTypeFilter}"`;
    return sendApiError(res, 400, 'INVALID_QUERY_TYPE', 'Invalid Type query');
  }

  const [ClientsErr, Clients] = await ClientManager.GetAll();
  if (ClientsErr) {
    res.locals.debugTrafficDetail = 'Failed to fetch remote clients';
    return sendApiError(res, 500, 'REMOTE_CLIENTS_FETCH_FAILED', 'Failed to fetch remote clients');
  }

  const [TargetsErr, Targets] = await MonitoringTargetManager.GetAll();
  if (TargetsErr) {
    res.locals.debugTrafficDetail = 'Failed to fetch monitoring targets';
    return sendApiError(
      res,
      500,
      'MONITORING_TARGETS_FETCH_FAILED',
      'Failed to fetch monitoring targets'
    );
  }

  const [DummiesErr, Dummies] = await DummyClientManager.GetAll();
  if (DummiesErr) {
    res.locals.debugTrafficDetail = 'Failed to fetch dummy clients';
    return sendApiError(res, 500, 'DUMMY_CLIENTS_FETCH_FAILED', 'Failed to fetch dummy clients');
  }

  const RemoteEntities = (Clients || []).map((Client) => ({
    ...Client,
    Type: 'Remote',
    Status: computeStatus(Client),
  }));

  const MonitoringEntities = (Targets || []).map((Target) => ({
    ...Target,
    Type: 'Monitoring',
    OperatingSystem: '',
    Status: computeStatus(Target),
  }));

  const DummyEntities = (Dummies || []).map((Dummy) => ({
    ...Dummy,
    Type: 'Dummy',
    OperatingSystem: '',
    Status: computeStatus(Dummy),
  }));

  const Results = [...RemoteEntities, ...MonitoringEntities, ...DummyEntities].filter((Entity) => {
    if (TypeFilter && Entity.Type !== TypeFilter) return false;
    if (HasGroupIDFilter && Number(Entity.GroupID) !== GroupIDFilter) return false;
    if (
      OperatingSystemFilter &&
      String(Entity.OperatingSystem || '').toLowerCase() !== OperatingSystemFilter
    ) {
      return false;
    }
    if (HasStatusFilter && Entity.Status !== RawStatusFilter) return false;
    return true;
  });

  res.locals.debugTrafficDetail = `Returned ${Results.length} entities`;
  return sendApiSuccess(res, { Data: Results, Count: Results.length });
};

// API Routes (in logical order)
// 1. Query/List endpoint (first in the logical list)
app.get('/API/Clients', ClientsListHandler);

// 2-7. OSC routes mirrored to HTTP (mirrors the logical order defined in OSC/index.js)
//      System Control → Client → Dummy → Group → All → Selection
// Mirror all OSC routes to HTTP API routes under /API.
// Example: /API/Client/:UUID/Select -> /API/Client/:UUID/Select
for (const Route of OSC.GetRoutes()) {
  const NormalizedPath =
    String(Route.Path || '').replace(/^\/(?:ShowTrak|API)(?=\/|$)/i, '') || '/';
  const ApiPath = `/API${NormalizedPath === '/' ? '' : NormalizedPath}`;
  const OSCToHTTPHandler = async (req, res) => {
    const Params = req.params || {};
    const SourceIP =
      req.ip ||
      (req.socket && req.socket.remoteAddress) ||
      (req.connection && req.connection.remoteAddress) ||
      null;

    let Result = null;
    try {
      Result = await Route.Callback(Params, { IP: SourceIP });
    } catch (Error) {
      const Message = String(
        (Error && Error.message) || Error || `Unhandled error while processing ${Route.Path}`
      );
      res.locals.debugTrafficDetail = Message;
      return sendApiError(res, 500, 'OSC_HTTP_HANDLER_EXCEPTION', Message);
    }

    const Passed = Result && typeof Result === 'object' ? Result.ok !== false : Result !== false;
    const Detail =
      Result && typeof Result === 'object' && Result.detail
        ? String(Result.detail)
        : Route.Title || Route.Path;

    res.locals.debugTrafficDetail = Detail;
    if (!Passed) {
      return sendApiError(res, 400, 'OSC_ROUTE_FAILED', Detail);
    }
    return sendApiSuccess(res, {
      Status: 'OK',
      Detail,
    });
  };
  app.get(ApiPath, OSCToHTTPHandler);
  app.post(ApiPath, OSCToHTTPHandler);
}

app.use('/API', (_req, res) => {
  res.locals.debugTrafficDetail = 'API route not found';
  return sendApiError(res, 404, 'API_ROUTE_NOT_FOUND', 'API route not found');
});

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
  const Summary = { queued: 0, dispatched: 0, failed: [] };
  if (ResetList) await ScriptExecutionManager.ClearQueue();
  for (const UUID of Targets) {
    const RequestID = await ScriptExecutionManager.AddToQueue(UUID, ScriptID);
    if (!RequestID) {
      Summary.failed.push({ UUID, message: 'Failed to queue script execution request' });
      continue;
    }
    Summary.queued += 1;

    const CanDispatch =
      typeof ScriptExecutionManager.ShouldDispatch === 'function'
        ? await ScriptExecutionManager.ShouldDispatch(RequestID)
        : true;

    Logger.log('ExecuteScript dispatch', { ScriptID, UUID, RequestID });
    if (!CanDispatch) {
      const Request =
        typeof ScriptExecutionManager.GetExecution === 'function'
          ? await ScriptExecutionManager.GetExecution(RequestID)
          : null;
      Summary.failed.push({
        UUID,
        message: (Request && Request.Error) || 'Script was blocked before dispatch',
      });
      continue;
    }
    io.to(UUID).emit('ExecuteScript', RequestID, ScriptID);
    Summary.dispatched += 1;
  }
  return Summary;
};

// Emit an arbitrary action to many clients with a user-friendly name for the queue UI
Manager.ExecuteBulkRequest = async (Action, Targets, ReadableName, Options = {}) => {
  if (!ReadableName) ReadableName = Action;
  const ResetQueue =
    !Options || typeof Options.resetQueue === 'undefined' ? true : !!Options.resetQueue;
  const Payload =
    Options && Object.prototype.hasOwnProperty.call(Options, 'payload')
      ? Options.payload
      : undefined;
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
    io.to(UUID).emit(Action, RequestID, Payload);
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
