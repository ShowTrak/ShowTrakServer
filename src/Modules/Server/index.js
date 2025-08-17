// Socket/HTTP server for ShowTrak Clients
// - Hosts static script assets
// - Manages Socket.IO connections per-client (room = UUID)
// - Bridges server-originated actions to specific clients/groups
const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('WebServer');

const HTTP = require('http');
const { Server: WebServer } = require('socket.io');
const { Config } = require('../Config');
const { Manager: AdoptionManager } = require('../AdoptionManager');
const { Manager: ClientManager } = require('../ClientManager');
const { Manager: ScriptManager } = require('../ScriptManager');
const { Manager: ScriptExecutionManager } = require('../ScriptExecutionManager');
const { Manager: AppDataManager } = require('../AppData');
// const { Manager: BroadcastManager } = require('../Broadcast');
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
