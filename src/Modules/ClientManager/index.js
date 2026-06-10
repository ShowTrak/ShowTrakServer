// ClientManager
// - Tracks connected clients in memory for fast updates
// - Persists durable fields to the database (nickname, group, IP, etc.)
// - Emits events on changes so UI and other modules remain reactive
const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('ClientManager');

const { Manager: DB } = require('../DB');

const { Manager: BroadcastManager } = require('../Broadcast');
const { Ok, Fail } = require('../Utils');

const { Client } = require('./client');

const Manager = {};

// Hot cache of Client instances reflecting current state
var ClientList = [];

Manager.Timeout = async (UUID) => {
  let Exists = await Manager.Exists(UUID);
  if (!Exists) return;
  let [Err, TimedOutClient] = await Manager.Get(UUID);
  if (Err) return Logger.error('Failed to get client for timeout:', Err);
  if (!TimedOutClient) return Logger.warn(`Client ${UUID} not found for timeout.`);
  TimedOutClient.SetOnline(false);
  return;
};

// Fast path for frequent telemetry: update cached client or hydrate from DB
Manager.Heartbeat = async (UUID, Data, IP) => {
  let CachedClient = ClientList.find((c) => c.UUID === UUID);
  if (!CachedClient) {
    Logger.warn(`Client ${UUID} not found in memory, fetching from database.`);
    let [Err, FetchedClient] = await DB.Get('SELECT * FROM Clients WHERE UUID = ?', [UUID]);
    if (Err) {
      Logger.error('Failed to fetch client from database:', Err);
      return ['Failed to fetch client', null];
    }
    if (!FetchedClient) {
      return ['Client Not Valid', null];
    } else {
      CachedClient = new Client(FetchedClient);
      ClientList.push(CachedClient);
      BroadcastManager.emit('ClientListChanged');
    }
  }

  await CachedClient.SetVersion(Data.Version || null, { markUnsaved: false });
  await CachedClient.SetIP(IP || null, { markUnsaved: false });
  CachedClient.SetScriptsFingerprint(Data && Data.ScriptsFingerprint ? Data.ScriptsFingerprint : null);
  CachedClient.SetOnline(true);
  CachedClient.SetLastSeen(Date.now());
  CachedClient.SetVitals(Data.Vitals);

  return [null, 'Heartbeat processed successfully'];
};

Manager.SetUSBDeviceList = async (UUID, DeviceList) => {
  let [Err, Target] = await Manager.Get(UUID);
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];
  Target.SetUSBDeviceList(DeviceList);
  return [null, 'USB Device List updated successfully'];
};

Manager.SetNetworkInterfaces = async (UUID, Interfaces) => {
  let [Err, Target] = await Manager.Get(UUID);
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];
  Target.SetNetworkInterfaces(Interfaces);
  return [null, 'Network Interfaces updated successfully'];
};

Manager.USBDeviceAdded = async (UUID, Device) => {
  let [Err, Target] = await Manager.Get(UUID);
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];
  Target.USBDeviceAdded(Device);
  return [null, 'Updated'];
};

Manager.USBDeviceRemoved = async (UUID, Device) => {
  let [Err, Target] = await Manager.Get(UUID);
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];
  Target.USBDeviceRemoved(Device);
  return [null, 'Updated'];
};

// One-shot richer payload: hostname + NICs -> derive MAC for the active IP
Manager.SystemInfo = async (UUID, Data, IP) => {
  let [Err, Target] = await Manager.Get(UUID);
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];

  await Target.SetHostname(Data.Hostname || null, { markUnsaved: false });
  let Macs = Object.values(Data.MacAddresses || {});
  for (let Interface of Macs) {
    if (Interface.ipv4 == IP) await Target.SetMacAddress(Interface.mac, { markUnsaved: false });
  }

  return [null, 'Heartbeat processed successfully'];
};

Manager.Update = async (UUID, Data) => {
  let [Err, Client] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Client) return Fail('Client Not Found');
  if (Object.prototype.hasOwnProperty.call(Data, 'Nickname')) {
    await Client.SetNickname(Data.Nickname);
  }
  if (Object.prototype.hasOwnProperty.call(Data, 'GroupID')) {
    await Client.SetGroupID(Data.GroupID);
  }
  return Ok(Client);
};

// Adopt a client by creating a durable DB row and adding to the cache
Manager.Create = async (UUID) => {
  // Verify if the client already exists
  let [Err, ExistingClient] = await DB.Get('SELECT * FROM Clients WHERE UUID = ?', [UUID]);
  if (Err) return Fail('Failed to fetch existing client');
  if (ExistingClient) return Fail('Client already exists');
  // Insert new client into the database
  let [InsertErr, _Res] = await DB.Run(
    'INSERT INTO Clients (UUID, Hostname, Version, IP, Timestamp) VALUES (?, ?, ?, ?, ?)',
    [UUID, 'ShowTrak Client', null, null, Date.now()]
  );
  if (InsertErr) return Fail('Failed to insert new client');
  ClientList.push(
    new Client({
      UUID: UUID,
      Hostname: null,
      Version: 'X.X.X',
      IP: null,
      Timestamp: Date.now(),
    })
  );
  BroadcastManager.emit('ClientListChanged');
  return Ok(true);
};

// Unadopt or purge a client; remove from DB and cache
Manager.Delete = async (UUID) => {
  // Remove from database
  let [Err, _Res] = await DB.Run('DELETE FROM Clients WHERE UUID = ?', [UUID]);
  if (Err) return Fail('Failed to delete client');
  // Remove from in-memory list
  ClientList = ClientList.filter((c) => c.UUID !== UUID);
  Logger.success(`Client ${UUID} deleted successfully`);
  return Ok(true);
};

// Truthy existence check: prefer cache, fallback to DB
Manager.Exists = async (UUID) => {
  // Check in memory first
  let CachedClient = ClientList.find((c) => c.UUID === UUID);
  if (CachedClient) return true;
  // If not found in memory, check in database
  let [Err, Client] = await DB.Get('SELECT * FROM Clients WHERE UUID = ?', [UUID]);
  if (Err) return false;
  if (!Client) return false;
  return true;
};

// Fetch a Client object (cached or hydrated); callers should not mutate DB-only fields directly
Manager.Get = async (UUID) => {
  // Check in memory first
  let CachedClient = ClientList.find((c) => c.UUID === UUID);
  if (CachedClient) {
    return [null, CachedClient];
  }
  // If not found in memory, check in database
  let [Err, ClientRow] = await DB.Get('SELECT * FROM Clients WHERE UUID = ?', [UUID]);
  if (Err) return ['Failed to fetch client', null];
  if (!ClientRow) return ['Client Not Found', null];
  ClientRow = new Client(ClientRow);
  return [null, ClientRow];
};

Manager.Initialized = false;
// Warm the cache from DB so early UI renders have data
Manager.Init = async () => {
  let [Err, Clients] = await DB.All('SELECT * FROM Clients');
  if (Err || !Clients) {
    Manager.Initialized = true;
    ClientList = [];
    return;
  }
  Clients = Clients.map((row) => new Client(row));
  ClientList = Clients; // Update in-memory list
  BroadcastManager.emit('ClientListChanged');
  Manager.Initialized = true;
  return;
};

// Snapshot the current list; ensures cache is initialized first
Manager.GetAll = async () => {
  // Check in memory first
  if (!Manager.Initialized) await Manager.Init();
  if (ClientList.length > 0) {
    return [null, ClientList];
  }
  // If not found in memory, fetch from database
  let [Err, Clients] = await DB.All('SELECT * FROM Clients');
  if (Err) return ['Failed to fetch clients', null];
  if (!Clients || Clients.length === 0) return [null, []];
  Clients = Clients.map((row) => new Client(row));
  ClientList = Clients; // Update in-memory list
  BroadcastManager.emit('ClientListChanged');
  return [null, Clients];
};

Manager.GetClientsInGroup = async (GroupID) => {
  return ClientList.filter((c) => c.GroupID === GroupID);
};

// Move all clients from a specific group into the default no-group bucket (null).
Manager.MoveGroupToNoGroup = async (GroupID) => {
  if (!Manager.Initialized) await Manager.Init();
  const TargetGroupID = Number(GroupID);
  if (!Number.isFinite(TargetGroupID)) return ['Invalid GroupID', null];

  const [Err] = await DB.Run('UPDATE Clients SET GroupID = NULL WHERE GroupID = ?', [
    TargetGroupID,
  ]);
  if (Err) return ['Failed to move clients to no group', null];

  let Changed = 0;
  for (const Client of ClientList) {
    if (Client.GroupID == null) continue;
    if (Number(Client.GroupID) !== TargetGroupID) continue;
    Client.GroupID = null;
    Changed += 1;
  }

  if (Changed > 0) BroadcastManager.emit('ClientListChanged');
  return [null, Changed];
};

// Ensure all clients reference an existing group; unknown groups are reassigned to null.
Manager.ReconcileOrphanedGroups = async (ValidGroupIDs) => {
  if (!Manager.Initialized) await Manager.Init();
  const Valid = new Set(
    (Array.isArray(ValidGroupIDs) ? ValidGroupIDs : [])
      .map((ID) => Number(ID))
      .filter((ID) => Number.isFinite(ID))
  );

  let Changed = 0;
  for (const Client of ClientList) {
    if (Client.GroupID == null) continue;
    const ClientGroupID = Number(Client.GroupID);
    if (Valid.has(ClientGroupID)) continue;
    await Client.SetGroupID(null);
    Changed += 1;
  }

  return [null, Changed];
};

// Persist a specific order of clients in a group and optionally move clients into that group
// orderedUUIDs: string[] in the desired order. Any client not in orderedUUIDs will retain existing weight.
Manager.SetGroupOrder = async (GroupID, orderedUUIDs) => {
  if (!Array.isArray(orderedUUIDs)) return ['Invalid orderedUUIDs', null];
  // normalize GroupID null
  const TargetGroupID = GroupID === undefined ? null : GroupID;
  let weight = 10;
  for (const uuid of orderedUUIDs) {
    const [err, client] = await Manager.Get(uuid);
    if (err) continue;
    if (!client) continue;
    // move to target group if needed
    if (client.GroupID !== TargetGroupID) {
      await client.SetGroupID(TargetGroupID);
    }
    await client.SetWeight(weight);
    weight += 10;
  }
  // Emit a single list changed after batch
  BroadcastManager.emit('ClientListChanged');
  return [null, true];
};

// Like SetGroupOrder but accepts an explicit weight per UUID. Used when ordering
// is shared across multiple entity types (e.g. clients + monitoring targets).
Manager.SetGroupOrderWithWeights = async (GroupID, orderedUUIDs, weights) => {
  if (!Array.isArray(orderedUUIDs) || !Array.isArray(weights)) return ['Invalid input', null];
  if (orderedUUIDs.length !== weights.length) return ['Length mismatch', null];
  const TargetGroupID = GroupID === undefined ? null : GroupID;
  for (let i = 0; i < orderedUUIDs.length; i++) {
    const uuid = orderedUUIDs[i];
    const w = Number(weights[i]) || 0;
    const [err, client] = await Manager.Get(uuid);
    if (err || !client) continue;
    if (client.GroupID !== TargetGroupID) await client.SetGroupID(TargetGroupID);
    await client.SetWeight(w);
  }
  BroadcastManager.emit('ClientListChanged');
  return [null, true];
};

Manager.ClearCache = async () => {
  ClientList = [];
  return;
};

module.exports = {
  Manager,
};
