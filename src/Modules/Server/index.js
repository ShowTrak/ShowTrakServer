// Socket/HTTP server for ShowTrak Clients
// - Hosts static script assets
// - Manages Socket.IO connections per-client (room = UUID)
// - Bridges server-originated actions to specific clients/groups
const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('WebServer');

const HTTP = require('http');
const path = require('path');
const { Server: WebServer } = require('socket.io');
const { Config } = require('../Config');
const { Manager: AdoptionManager } = require('../AdoptionManager');
const { Manager: ClientManager } = require('../ClientManager');
const { Manager: ScriptManager } = require('../ScriptManager');
const { Manager: ScriptExecutionManager } = require('../ScriptExecutionManager');
const { Manager: AppDataManager } = require('../AppData');
const { Manager: WOLManager } = require('../WOLManager');
const { Manager: BroadcastManager } = require('../Broadcast');
const { Manager: SettingsManager } = require('../SettingsManager');
const { Manager: GroupManager } = require('../GroupManager');
const { Manager: MonitoringTargetManager } = require('../MonitoringTargetManager');
const crypto = require('crypto');
const express = require('express');

const { Wait } = require('../Utils');

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

// Helper: convert internal Client instance to a safe, serializable payload for Web UI
const ToPublicClient = (c) => ({
  Type: 'client',
  UUID: c.UUID,
  Nickname: c.Nickname,
  Hostname: c.Hostname,
  GroupID: c.GroupID,
  Weight: c.Weight,
  Version: c.Version,
  IP: c.IP,
  MacAddress: c.MacAddress,
  Online: c.Online,
  LastSeen: c.LastSeen,
  Vitals: c.Vitals,
  USBDeviceList: Array.isArray(c.USBDeviceList) ? c.USBDeviceList : [],
  NetworkInterfaces: Array.isArray(c.NetworkInterfaces) ? c.NetworkInterfaces : [],
});

const ToPublicGroup = (g) => ({
  GroupID: g.GroupID,
  Title: g.Title,
  Weight: g.Weight,
});

// ---------------------------------------------------------------------------
// Web UI authentication (per-session passcode) + permission helpers
// ---------------------------------------------------------------------------

// In-memory set of currently valid Web UI session tokens. Cleared on restart
// and on logout, giving us a simple per-session auth model.
const WebSessions = new Set();

// Snapshot of the relevant Web UI settings used for permissions.
const GetWebConfig = async () => {
  let ProtectionEnabled = false;
  let Password = '';
  let AllowRemoteScripts = false;
  let WOLEnabled = false;
  try {
    ProtectionEnabled = !!(await SettingsManager.GetValue('WEBUI_PASSWORD_PROTECTION_ENABLED'));
    Password = String((await SettingsManager.GetValue('WEBUI_PASSWORD')) || '').trim();
    AllowRemoteScripts = !!(await SettingsManager.GetValue('WEBUI_ALLOW_REMOTE_SCRIPT_EXECUTION'));
    WOLEnabled = !!(await SettingsManager.GetValue('SYSTEM_ALLOW_WOL'));
  } catch {}
  // Protection is only meaningful when a passcode is actually set.
  const RequireAuth = ProtectionEnabled && Password.length > 0;
  return { ProtectionEnabled, Password, AllowRemoteScripts, WOLEnabled, RequireAuth };
};

// Public-facing config (never leaks the password itself).
const GetPublicConfig = async (socket) => {
  const Cfg = await GetWebConfig();
  return {
    PasswordProtection: Cfg.RequireAuth,
    AllowRemoteScripts: Cfg.AllowRemoteScripts,
    WOLEnabled: Cfg.WOLEnabled,
    Authed: !Cfg.RequireAuth || !!(socket && socket.Authed),
    Version: Config.Application.Version,
  };
};

// Is this socket allowed to receive/act on data right now?
const IsAuthed = async (socket) => {
  const Cfg = await GetWebConfig();
  if (!Cfg.RequireAuth) return true;
  return !!(socket && socket.Authed);
};

// Socket.IO namespace for Web UI so routes are isolated from ShowTrak clients
const ui = io.of('/ui');

// Validate any token presented in the handshake so reconnects stay logged in.
ui.use((socket, next) => {
  try {
    const Token =
      (socket.handshake.auth && socket.handshake.auth.token) ||
      (socket.handshake.query && socket.handshake.query.token) ||
      null;
    socket.Authed = Token ? WebSessions.has(Token) : false;
    socket.SessionToken = socket.Authed ? Token : null;
  } catch {
    socket.Authed = false;
  }
  next();
});

ui.on('connection', async (socket) => {
  try {
    Logger.log('Web UI connected', { id: socket.id, ip: socket.handshake.address });
  } catch {}

  // Build and emit the full bootstrap snapshot for an authed session.
  const SendBootstrap = async () => {
    try {
      if (!(await IsAuthed(socket))) return;
      const [cErr, clients] = await ClientManager.GetAll();
      const [gErr, groups] = await GroupManager.GetAll();
      const [mErr, monitors] = await MonitoringTargetManager.GetAll();
      let scripts = [];
      try {
        scripts = (await ScriptManager.GetScripts()) || [];
      } catch {}
      socket.emit('bootstrap', {
        clients: cErr ? [] : clients.map(ToPublicClient),
        groups: gErr ? [] : (groups || []).map(ToPublicGroup),
        monitors: mErr ? [] : monitors || [],
        scripts: scripts.map((s) => ({
          id: s.ID,
          name: s.Name,
          style: s.LabelStyle,
          weight: s.Weight || 0,
          confirm: !!s.Confirmation,
        })),
        config: await GetPublicConfig(socket),
      });
    } catch (e) {
      Logger.error('Web UI bootstrap failed:', e);
    }
  };

  // Tell the client whether it must authenticate before anything else.
  socket.emit('hello', await GetPublicConfig(socket));
  await SendBootstrap();

  // --- Authentication handlers -------------------------------------------
  socket.on('auth:login', async (payload, cb) => {
    try {
      const Cfg = await GetWebConfig();
      if (!Cfg.RequireAuth) {
        socket.Authed = true;
        const token = crypto.randomBytes(24).toString('hex');
        WebSessions.add(token);
        socket.SessionToken = token;
        await SendBootstrap();
        return cb && cb({ ok: true, token });
      }
      const Passcode = String((payload && payload.password) || '').trim();
      if (Passcode !== Cfg.Password) {
        return cb && cb({ error: 'invalid_password' });
      }
      const token = crypto.randomBytes(24).toString('hex');
      WebSessions.add(token);
      socket.Authed = true;
      socket.SessionToken = token;
      await SendBootstrap();
      cb && cb({ ok: true, token });
    } catch (e) {
      cb && cb({ error: 'failed' });
    }
  });

  socket.on('auth:logout', async (cb) => {
    try {
      if (socket.SessionToken) WebSessions.delete(socket.SessionToken);
      socket.Authed = false;
      socket.SessionToken = null;
      cb && cb({ ok: true });
    } catch (e) {
      cb && cb({ error: 'failed' });
    }
  });

  socket.on('config:get', async (cb) => {
    try {
      cb && cb({ data: await GetPublicConfig(socket) });
    } catch {
      cb && cb({ error: 'failed' });
    }
  });

  // --- Data request handlers (all gated on auth) -------------------------
  socket.on('bootstrap:get', async () => {
    await SendBootstrap();
  });

  socket.on('clients:get', async (cb) => {
    try {
      if (!(await IsAuthed(socket))) return cb && cb({ error: 'unauthorized' });
      const [err, list] = await ClientManager.GetAll();
      if (err) return cb && cb({ error: err });
      cb && cb({ data: list.map(ToPublicClient) });
    } catch (e) {
      cb && cb({ error: 'failed' });
    }
  });

  socket.on('client:get', async (uuid, cb) => {
    try {
      if (!(await IsAuthed(socket))) return cb && cb({ error: 'unauthorized' });
      const [err, client] = await ClientManager.Get(uuid);
      if (err) return cb && cb({ error: err });
      if (!client) return cb && cb({ error: 'not_found' });
      cb && cb({ data: ToPublicClient(client) });
    } catch (e) {
      cb && cb({ error: 'failed' });
    }
  });

  // --- Live push wiring (per-socket, only to authed sessions) ------------
  const onClientListChanged = async () => {
    try {
      if (!(await IsAuthed(socket))) return;
      const [err, list] = await ClientManager.GetAll();
      if (err) return;
      socket.emit('clients:list', list.map(ToPublicClient));
    } catch {}
  };

  const onClientUpdated = async (client) => {
    try {
      if (!(await IsAuthed(socket))) return;
      socket.emit('clients:updated', ToPublicClient(client));
    } catch {}
  };

  const onGroupListChanged = async () => {
    try {
      if (!(await IsAuthed(socket))) return;
      const [err, groups] = await GroupManager.GetAll();
      if (err) return;
      socket.emit('groups:list', (groups || []).map(ToPublicGroup));
    } catch {}
  };

  const onMonitorListChanged = async () => {
    try {
      if (!(await IsAuthed(socket))) return;
      const [err, monitors] = await MonitoringTargetManager.GetAll();
      if (err) return;
      socket.emit('monitors:list', monitors || []);
    } catch {}
  };

  const onMonitorUpdated = async (monitor) => {
    try {
      if (!(await IsAuthed(socket))) return;
      socket.emit('monitors:updated', monitor);
    } catch {}
  };

  // When server settings change, permissions may change. If auth is now
  // required and this socket isn't authed, force it back to the login screen.
  const onSettingsUpdated = async () => {
    try {
      const Cfg = await GetWebConfig();
      if (Cfg.RequireAuth && !socket.Authed) {
        socket.emit('config', await GetPublicConfig(socket));
        return;
      }
      socket.emit('config', await GetPublicConfig(socket));
      await SendBootstrap();
    } catch {}
  };

  BroadcastManager.on('ClientListChanged', onClientListChanged);
  BroadcastManager.on('ClientUpdated', onClientUpdated);
  BroadcastManager.on('GroupListChanged', onGroupListChanged);
  BroadcastManager.on('MonitoringTargetListChanged', onMonitorListChanged);
  BroadcastManager.on('MonitoringTargetUpdated', onMonitorUpdated);
  BroadcastManager.on('SettingsUpdated', onSettingsUpdated);

  // --- Action handlers (gated on auth + permission) ----------------------
  socket.on('scripts:run', async (payload, cb) => {
    try {
      if (!(await IsAuthed(socket))) return cb && cb({ error: 'unauthorized' });
      const Cfg = await GetWebConfig();
      if (!Cfg.AllowRemoteScripts) return cb && cb({ error: 'forbidden' });
      const { uuid, scriptId } = payload || {};
      if (!uuid || !scriptId) return cb && cb({ error: 'invalid_args' });
      await Manager.ExecuteScripts(scriptId, [uuid], false);
      cb && cb({ ok: true });
    } catch (e) {
      cb && cb({ error: 'failed' });
    }
  });

  socket.on('wol:wake', async (payload, cb) => {
    try {
      if (!(await IsAuthed(socket))) return cb && cb({ error: 'unauthorized' });
      const Cfg = await GetWebConfig();
      if (!Cfg.AllowRemoteScripts || !Cfg.WOLEnabled) return cb && cb({ error: 'forbidden' });
      const { uuid } = payload || {};
      if (!uuid) return cb && cb({ error: 'invalid_args' });
      const [err, client] = await ClientManager.Get(uuid);
      if (err || !client) return cb && cb({ error: err || 'not_found' });
      const mac = client.MacAddress;
      if (!mac) return cb && cb({ error: 'no_mac' });
      const [wolErr, result] = await WOLManager.Wake(mac);
      if (wolErr) return cb && cb({ error: String(wolErr) });
      cb && cb({ ok: true, message: result });
    } catch (e) {
      cb && cb({ error: 'failed' });
    }
  });

  socket.on('disconnect', () => {
    BroadcastManager.off('ClientListChanged', onClientListChanged);
    BroadcastManager.off('ClientUpdated', onClientUpdated);
    BroadcastManager.off('GroupListChanged', onGroupListChanged);
    BroadcastManager.off('MonitoringTargetListChanged', onMonitorListChanged);
    BroadcastManager.off('MonitoringTargetUpdated', onMonitorUpdated);
    BroadcastManager.off('SettingsUpdated', onSettingsUpdated);
  });
});

// Per-connection lifecycle
io.on('connection', async (socket) => {
  try {
    Logger.log('Incoming socket connection', {
      id: socket.id,
      address: socket.handshake && socket.handshake.address,
      query: socket.handshake && socket.handshake.query,
      headers: socket.handshake && socket.handshake.headers && {
        'x-forwarded-for': socket.handshake.headers['x-forwarded-for'],
      },
    });
  } catch {}
  // Expect clients to provide a UUID and whether they believe they are adopted
  if (
    !socket.handshake.query ||
    Object.keys(socket.handshake.query).length === 0 ||
    !socket.handshake.query.UUID
  )
    return socket.disconnect(true);
  socket.UUID = socket.handshake.query.UUID;
  socket.Adopted = socket.handshake.query.Adopted === 'true' ? true : false;
  Logger.log(
    `Client Connected As ${socket.UUID} ${socket.Adopted ? '(Adopted)' : '(Pending Adoption)'}`
  );
  // Join a room keyed by UUID so we can message specific clients
  socket.join(socket.UUID);

  // IP
  socket.IP = socket.handshake.address;
  if (socket.IP.startsWith('::ffff:')) {
    socket.IP = socket.IP.substring(7); // Remove IPv6 prefix if present
  }

  // If the client claims adoption, verify against our DB to prevent drift
  if (socket.Adopted) {
    let IsInDatabase = await ClientManager.Exists(socket.UUID);
    if (!IsInDatabase) {
      Logger.warn('Client is adopted but not found in the database:', socket.UUID);
      Logger.warn('Unadopting Client');
      socket.emit('Unadopt');
    }
  }

  // Unadopted devices send presence to appear in the adoption list
  socket.on('AdoptionHeartbeat', async (Data) => {
    try {
      // Logger.log('AdoptionHeartbeat received', {
      //   UUID: socket.UUID,
      //   IP: socket.IP,
      //   Hostname: Data && Data.Hostname,
      //   Version: Data && Data.Version,
      // });
      await AdoptionManager.AddClientPendingAdoption(socket.UUID, socket.IP, Data);
    } catch (e) {
      Logger.error('AdoptionHeartbeat handler error for', socket.UUID, e);
    }
  });

  socket.on('GetScripts', async (Callback) => {
    Logger.log(`Client ${socket.UUID} requested scripts.`);
    const Scripts = await ScriptManager.GetScripts();
    Callback(Scripts);
  });

  socket.on('Heartbeat', async (Data) => {
    try {
      // Logger.debug('Heartbeat received', {
      //   UUID: socket.UUID,
      //   Vitals: Data && Data.Vitals ? {
      //     cpu: Data.Vitals.CPU && Data.Vitals.CPU.UsagePercentage,
      //     ram: Data.Vitals.Ram && Data.Vitals.Ram.UsagePercentage,
      //   } : undefined,
      //   Version: Data && Data.Version,
      // });
      let [Err, Client] = await ClientManager.Heartbeat(socket.UUID, Data, socket.IP);
      if (Err) {
        console.error(Err);
      }
    } catch (e) {
      Logger.error('Heartbeat handler error for', socket.UUID, e);
    }
  });

  socket.on('SystemInfo', async (Data) => {
    try {
      // Logger.debug('SystemInfo received', {
      //   UUID: socket.UUID,
      //   Hostname: Data && Data.Hostname,
      //   MacKeys: Data && Data.MacAddresses ? Object.keys(Data.MacAddresses) : [],
      // });
      await ClientManager.SystemInfo(socket.UUID, Data, socket.IP);
    } catch (e) {
      Logger.error('SystemInfo handler error for', socket.UUID, e);
    }
  });

  socket.on('USBDeviceList', async (DeviceList) => {
    Logger.log(
      `USB Device list recieved from ${socket.UUID} (${DeviceList.length} ${
        DeviceList.length === 1 ? 'Device' : 'Devices'
      })`
    );
    await ClientManager.SetUSBDeviceList(socket.UUID, DeviceList);
  });

  socket.on('USBDeviceConnected', async (Device) => {
    Logger.log(
      `USB Device Connected to ${socket.UUID} (${Device.ManufacturerName} ${Device.ProductName})`
    );
    await ClientManager.USBDeviceAdded(socket.UUID, Device);
    return;
  });

  socket.on('USBDeviceDisconnected', async (Device) => {
    Logger.log(
      `USB Device Disconnected from ${socket.UUID} (${Device.ManufacturerName} ${Device.ProductName})`
    );
    await ClientManager.USBDeviceRemoved(socket.UUID, Device);
    return;
  });

  socket.on('NetworkInterfaces', async (Interfaces) => {
    try {
      Logger.log(
        `Network interfaces received from ${socket.UUID} (${Array.isArray(Interfaces) ? Interfaces.length : 0} interfaces)`
      );
      await ClientManager.SetNetworkInterfaces(socket.UUID, Interfaces || []);
    } catch (e) {
      Logger.error('Failed to handle NetworkInterfaces for', socket.UUID, e);
    }
  });

  // Cleanup on disconnect: clear adoption entry and mark offline
  socket.on('disconnect', (reason) => {
    try {
      if (!socket.UUID) {
        Logger.log('Socket disconnected without UUID:', socket.id, reason);
        return;
      }
      Logger.log('Client disconnected', { UUID: socket.UUID, reason });
      AdoptionManager.RemoveClientPendingAdoption(socket.UUID);
      ClientManager.Timeout(socket.UUID);
    } catch (e) {
      Logger.error('Disconnect handler error for', socket && socket.UUID, e);
    }
  });

  socket.on('ScriptExecutionResponse', (RequestID, Error, _Result) => {
    Logger.log(`Received Script Execution Response for RequestID: ${RequestID}`);
    ScriptExecutionManager.Complete(RequestID, Error);
  });
});

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
Manager.ExecuteBulkRequest = async (Action, Targets, ReadableName) => {
  if (!ReadableName) ReadableName = Action;
  await ScriptExecutionManager.ClearQueue();
  for (const UUID of Targets) {
    await Wait(150);
    const RequestID = await ScriptExecutionManager.AddInternalTaskToQueue(UUID, ReadableName);
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

Server.listen(Config.Application.Port, () => {
  Logger.log(`Socket.IO server running on port ${Config.Application.Port}`);
});

module.exports = {
  Manager,
};
