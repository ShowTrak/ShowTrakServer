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
const { NormalizeIntegratedActions } = require('./integrated-actions');

const Manager = {};

// Hot cache of Client instances reflecting current state
let ClientList = [];
const CriticalUSBIndex = new Map();
const CriticalApplicationIndex = new Map();

function replaceUUIDInValue(Value, OldUUID, NewUUID) {
  if (typeof Value === 'string') {
    return Value === OldUUID ? NewUUID : Value;
  }
  if (Array.isArray(Value)) {
    return Value.map((Entry) => replaceUUIDInValue(Entry, OldUUID, NewUUID));
  }
  if (Value && typeof Value === 'object') {
    const Next = {};
    for (const [Key, Entry] of Object.entries(Value)) {
      Next[Key] = replaceUUIDInValue(Entry, OldUUID, NewUUID);
    }
    return Next;
  }
  return Value;
}

function normalizeSerialNumber(SerialNumber) {
  if (typeof SerialNumber !== 'string') return null;
  const Value = SerialNumber.trim();
  if (!Value) return null;
  return Value.toUpperCase();
}

function getCriticalMapForClient(UUID, CreateIfMissing = false) {
  const Key = String(UUID || '');
  let Existing = CriticalUSBIndex.get(Key);
  if (!Existing && CreateIfMissing) {
    Existing = new Map();
    CriticalUSBIndex.set(Key, Existing);
  }
  return Existing || null;
}

function getCriticalApplicationMapForClient(UUID, CreateIfMissing = false) {
  const Key = String(UUID || '');
  let Existing = CriticalApplicationIndex.get(Key);
  if (!Existing && CreateIfMissing) {
    Existing = new Map();
    CriticalApplicationIndex.set(Key, Existing);
  }
  return Existing || null;
}

function applyCriticalUSBState(TargetClient) {
  if (!TargetClient || !TargetClient.UUID) return;
  const Entries = getCriticalMapForClient(TargetClient.UUID, false);
  const Devices = Entries ? Array.from(Entries.values()) : [];
  TargetClient.SetCriticalUSBDevices(Devices);
}

function applyCriticalApplicationState(TargetClient) {
  if (!TargetClient || !TargetClient.UUID) return;
  const Entries = getCriticalApplicationMapForClient(TargetClient.UUID, false);
  const Applications = Entries ? Array.from(Entries.values()) : [];
  TargetClient.SetCriticalApplications(Applications);
}

async function loadCriticalUSBIndex() {
  CriticalUSBIndex.clear();
  const [Err, Rows] = await DB.All(
    'SELECT UUID, SerialNumber, ManufacturerName, ProductName, Timestamp FROM CriticalUSBDevices'
  );
  if (Err || !Rows) return;
  for (const Row of Rows) {
    const UUID = Row && Row.UUID ? String(Row.UUID) : '';
    const SerialNumber = normalizeSerialNumber(Row && Row.SerialNumber);
    if (!UUID || !SerialNumber) continue;
    const PerClient = getCriticalMapForClient(UUID, true);
    PerClient.set(SerialNumber, {
      UUID,
      SerialNumber,
      ManufacturerName: Row.ManufacturerName || null,
      ProductName: Row.ProductName || null,
      Timestamp: Row.Timestamp || null,
    });
  }
}

async function loadCriticalApplicationIndex() {
  CriticalApplicationIndex.clear();
  const [Err, Rows] = await DB.All(
    'SELECT UUID, ApplicationKey, ApplicationName, Timestamp FROM CriticalApplications'
  );
  if (Err || !Rows) return;
  for (const Row of Rows) {
    const UUID = Row && Row.UUID ? String(Row.UUID) : '';
    const ApplicationKey = Row && Row.ApplicationKey ? String(Row.ApplicationKey).trim() : '';
    const ApplicationName = Row && Row.ApplicationName ? String(Row.ApplicationName).trim() : '';
    if (!UUID || !ApplicationKey || !ApplicationName) continue;
    const PerClient = getCriticalApplicationMapForClient(UUID, true);
    PerClient.set(ApplicationKey, {
      Name: ApplicationName,
      Key: ApplicationKey,
      Timestamp: Row.Timestamp || null,
    });
  }
}

Manager.Timeout = async (UUID) => {
  const Exists = await Manager.Exists(UUID);
  if (!Exists) return;
  const [Err, TimedOutClient] = await Manager.Get(UUID);
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
    const [Err, FetchedClient] = await DB.Get('SELECT * FROM Clients WHERE UUID = ?', [UUID]);
    if (Err) {
      Logger.error('Failed to fetch client from database:', Err);
      return ['Failed to fetch client', null];
    }
    if (!FetchedClient) {
      return ['Client Not Valid', null];
    } else {
      CachedClient = new Client(FetchedClient);
      applyCriticalUSBState(CachedClient);
      applyCriticalApplicationState(CachedClient);
      ClientList.push(CachedClient);
      BroadcastManager.emit('ClientListChanged');
    }
  }

  await CachedClient.SetVersion(Data.Version || null, { markUnsaved: false });
  await CachedClient.SetIP(IP || null, { markUnsaved: false });
  CachedClient.SetScriptsFingerprint(
    Data && Data.ScriptsFingerprint ? Data.ScriptsFingerprint : null
  );
  CachedClient.SetOnline(true);
  CachedClient.SetLastSeen(Date.now());
  CachedClient.SetVitals(Data.Vitals);

  return [null, 'Heartbeat processed successfully'];
};

Manager.SetUSBDeviceList = async (UUID, DeviceList) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];
  Target.SetUSBDeviceList(DeviceList);
  return [null, 'USB Device List updated successfully'];
};

// Register/replace the integrated action (event) catalog declared by an
// integrated client over Socket.IO. The payload is normalized/sanitized before
// being stored on the cached Client instance.
Manager.SetIntegratedActions = async (UUID, Actions) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];
  const Normalized = NormalizeIntegratedActions(Actions);
  Target.SetIntegratedActions(Normalized);
  return [null, Normalized];
};

// Apply a manual health state (ONLINE / DEGRADED) reported by an integrated
// client over the SDK. OFFLINE is rejected (driven by the connection only).
Manager.SetIntegratedState = async (UUID, State, Message) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];
  const Applied = Target.SetIntegratedState(State, Message);
  if (!Applied) return ['Invalid integrated state', null];
  return [null, true];
};

Manager.SetNetworkInterfaces = async (UUID, Interfaces) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];
  Target.SetNetworkInterfaces(Interfaces);
  return [null, 'Network Interfaces updated successfully'];
};

Manager.SetRunningApplications = async (UUID, Snapshot) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];
  if (!ClientList.find((Client) => Client.UUID === UUID)) {
    ClientList.push(Target);
    BroadcastManager.emit('ClientListChanged');
  }
  Target.SetRunningApplications(Snapshot || {});
  return [null, 'Running applications updated successfully'];
};

Manager.MarkApplicationCritical = async (UUID, Application) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];

  const ApplicationName =
    typeof Application?.Name === 'string' && Application.Name.trim().length > 0
      ? Application.Name.trim()
      : null;
  if (!ApplicationName) return ['Application name is required', null];

  const ApplicationKey = ApplicationName.toLowerCase();
  const Timestamp = Date.now();
  const [WriteErr] = await DB.Run(
    'INSERT OR REPLACE INTO CriticalApplications (UUID, ApplicationKey, ApplicationName, Timestamp) VALUES (?, ?, ?, ?)',
    [UUID, ApplicationKey, ApplicationName, Timestamp]
  );
  if (WriteErr) return Fail('Failed to save critical application');

  const PerClient = getCriticalApplicationMapForClient(UUID, true);
  PerClient.set(ApplicationKey, {
    Name: ApplicationName,
    Key: ApplicationKey,
    Timestamp,
  });
  Target.MarkCriticalApplication({ Name: ApplicationName, Timestamp });
  BroadcastManager.emit('ClientUpdated', Target);
  return Ok(true);
};

Manager.RemoveApplicationCritical = async (UUID, ApplicationName) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];

  const NormalizedName =
    typeof ApplicationName === 'string' && ApplicationName.trim().length > 0
      ? ApplicationName.trim()
      : null;
  if (!NormalizedName) return ['Application name is required', null];
  const ApplicationKey = NormalizedName.toLowerCase();

  const [WriteErr] = await DB.Run(
    'DELETE FROM CriticalApplications WHERE UUID = ? AND ApplicationKey = ?',
    [UUID, ApplicationKey]
  );
  if (WriteErr) return Fail('Failed to remove critical application');

  const PerClient = getCriticalApplicationMapForClient(UUID, false);
  if (PerClient) {
    PerClient.delete(ApplicationKey);
    if (PerClient.size === 0) CriticalApplicationIndex.delete(String(UUID || ''));
  }

  Target.UnmarkCriticalApplication(NormalizedName);
  BroadcastManager.emit('ClientUpdated', Target);
  return Ok(true);
};

Manager.IsApplicationCritical = async (UUID, ApplicationName) => {
  const NormalizedName =
    typeof ApplicationName === 'string' && ApplicationName.trim().length > 0
      ? ApplicationName.trim().toLowerCase()
      : null;
  if (!NormalizedName) return [null, false];

  const Cached = getCriticalApplicationMapForClient(UUID, false);
  if (Cached) return [null, Cached.has(NormalizedName)];

  const [Err, Row] = await DB.Get(
    'SELECT 1 AS Found FROM CriticalApplications WHERE UUID = ? AND ApplicationKey = ? LIMIT 1',
    [UUID, NormalizedName]
  );
  if (Err) return ['Failed to determine critical application status', null];
  return [null, !!Row];
};

Manager.USBDeviceAdded = async (UUID, Device) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];
  Target.USBDeviceAdded(Device);
  return [null, 'Updated'];
};

Manager.USBDeviceRemoved = async (UUID, Device) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];
  Target.USBDeviceRemoved(Device);
  return [null, 'Updated'];
};

Manager.MarkUSBDeviceCritical = async (UUID, Device) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];

  const SerialNumber = normalizeSerialNumber(Device && Device.SerialNumber);
  if (!SerialNumber) return ['Device serial number is required', null];

  const KnownDevice = (
    Array.isArray(Target.ConnectedUSBDeviceList) ? Target.ConnectedUSBDeviceList : []
  ).find((Entry) => normalizeSerialNumber(Entry && Entry.SerialNumber) === SerialNumber);
  const ManufacturerName =
    (KnownDevice && KnownDevice.ManufacturerName) || (Device && Device.ManufacturerName) || null;
  const ProductName =
    (KnownDevice && KnownDevice.ProductName) || (Device && Device.ProductName) || null;

  const [WriteErr] = await DB.Run(
    'INSERT OR REPLACE INTO CriticalUSBDevices (UUID, SerialNumber, ManufacturerName, ProductName, Timestamp) VALUES (?, ?, ?, ?, ?)',
    [UUID, SerialNumber, ManufacturerName, ProductName, Date.now()]
  );
  if (WriteErr) return Fail('Failed to save critical USB device');

  const PerClient = getCriticalMapForClient(UUID, true);
  PerClient.set(SerialNumber, {
    UUID,
    SerialNumber,
    ManufacturerName,
    ProductName,
    Timestamp: Date.now(),
  });
  Target.MarkCriticalUSBDevice({
    SerialNumber,
    ManufacturerName,
    ProductName,
    Timestamp: Date.now(),
  });
  BroadcastManager.emit('ClientUpdated', Target);
  return Ok(true);
};

Manager.RemoveUSBDeviceCritical = async (UUID, SerialNumber) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];

  const NormalizedSerial = normalizeSerialNumber(SerialNumber);
  if (!NormalizedSerial) return ['Device serial number is required', null];

  const [WriteErr] = await DB.Run(
    'DELETE FROM CriticalUSBDevices WHERE UUID = ? AND SerialNumber = ?',
    [UUID, NormalizedSerial]
  );
  if (WriteErr) return Fail('Failed to remove critical USB device');

  const PerClient = getCriticalMapForClient(UUID, false);
  if (PerClient) {
    PerClient.delete(NormalizedSerial);
    if (PerClient.size === 0) CriticalUSBIndex.delete(String(UUID || ''));
  }

  Target.UnmarkCriticalUSBSerial(NormalizedSerial);
  BroadcastManager.emit('ClientUpdated', Target);
  return Ok(true);
};

Manager.IsUSBDeviceCritical = async (UUID, SerialNumber) => {
  const Normalized = normalizeSerialNumber(SerialNumber);
  if (!Normalized) return [null, false];

  const Cached = getCriticalMapForClient(UUID, false);
  if (Cached) return [null, Cached.has(Normalized)];

  const [Err, Row] = await DB.Get(
    'SELECT 1 AS Found FROM CriticalUSBDevices WHERE UUID = ? AND SerialNumber = ? LIMIT 1',
    [UUID, Normalized]
  );
  if (Err) return ['Failed to determine critical USB status', null];
  return [null, !!Row];
};

// One-shot richer payload: hostname + NICs -> derive MAC for the active IP
Manager.SystemInfo = async (UUID, Data, IP) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];

  await Target.SetHostname(Data.Hostname || null, { markUnsaved: false });
  await Target.SetOperatingSystem(Data.OperatingSystem || null, { markUnsaved: false });
  const Macs = Object.values(Data.MacAddresses || {});
  for (const Interface of Macs) {
    if (Interface.ipv4 === IP) await Target.SetMacAddress(Interface.mac, { markUnsaved: false });
  }

  return [null, 'Heartbeat processed successfully'];
};

Manager.Update = async (UUID, Data) => {
  const [Err, Client] = await Manager.Get(UUID);
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
  const [Err, ExistingClient] = await DB.Get('SELECT * FROM Clients WHERE UUID = ?', [UUID]);
  if (Err) return Fail('Failed to fetch existing client');
  if (ExistingClient) return Fail('Client already exists');
  // Insert new client into the database
  const [InsertErr, _Res] = await DB.Run(
    'INSERT INTO Clients (UUID, Hostname, OperatingSystem, Version, IP, Timestamp) VALUES (?, ?, ?, ?, ?, ?)',
    [UUID, 'ShowTrak Client', null, null, null, Date.now()]
  );
  if (InsertErr) return Fail('Failed to insert new client');
  const Created = new Client({
    UUID: UUID,
    Hostname: null,
    OperatingSystem: null,
    Version: 'X.X.X',
    IP: null,
    Timestamp: Date.now(),
  });
  applyCriticalUSBState(Created);
  applyCriticalApplicationState(Created);
  ClientList.push(Created);
  BroadcastManager.emit('ClientListChanged');
  return Ok(true);
};

// Unadopt or purge a client; remove from DB and cache
Manager.Delete = async (UUID) => {
  const [criticalErr] = await DB.Run('DELETE FROM CriticalUSBDevices WHERE UUID = ?', [UUID]);
  if (criticalErr) return Fail('Failed to delete critical USB devices for client');
  const [criticalAppErr] = await DB.Run('DELETE FROM CriticalApplications WHERE UUID = ?', [UUID]);
  if (criticalAppErr) return Fail('Failed to delete critical applications for client');
  // Remove from database
  const [Err, _Res] = await DB.Run('DELETE FROM Clients WHERE UUID = ?', [UUID]);
  if (Err) return Fail('Failed to delete client');
  // Remove from in-memory list
  ClientList = ClientList.filter((c) => c.UUID !== UUID);
  CriticalUSBIndex.delete(String(UUID || ''));
  CriticalApplicationIndex.delete(String(UUID || ''));
  Logger.success(`Client ${UUID} deleted successfully`);
  return Ok(true);
};

Manager.ReplaceClient = async (CurrentUUID, ReplacementUUID) => {
  const OldUUID = String(CurrentUUID || '').trim();
  const NewUUID = String(ReplacementUUID || '').trim();
  if (!OldUUID || !NewUUID) return Fail('Client UUID is required');
  if (OldUUID === NewUUID) return Fail('Replacement client must be different');

  const [OldErr, ExistingClient] = await Manager.Get(OldUUID);
  if (OldErr || !ExistingClient) return Fail('Current client not found');
  if (ExistingClient.Online) return Fail('Current client must be offline before replacement');

  const NewExists = await Manager.Exists(NewUUID);
  if (NewExists) return Fail('Replacement client is already adopted');

  const oldCriticalUSB = getCriticalMapForClient(OldUUID, false);
  const oldCriticalApps = getCriticalApplicationMapForClient(OldUUID, false);
  const oldClientRows = ClientList.slice();

  const [beginErr] = await DB.Run('BEGIN IMMEDIATE TRANSACTION');
  if (beginErr) return Fail('Failed to start client replacement transaction');

  let committed = false;
  try {
    const [clientUpdateErr] = await DB.Run('UPDATE Clients SET UUID = ? WHERE UUID = ?', [
      NewUUID,
      OldUUID,
    ]);
    if (clientUpdateErr) throw clientUpdateErr;

    const [criticalUSBErr] = await DB.Run('UPDATE CriticalUSBDevices SET UUID = ? WHERE UUID = ?', [
      NewUUID,
      OldUUID,
    ]);
    if (criticalUSBErr) throw criticalUSBErr;

    const [criticalAppErr] = await DB.Run(
      'UPDATE CriticalApplications SET UUID = ? WHERE UUID = ?',
      [NewUUID, OldUUID]
    );
    if (criticalAppErr) throw criticalAppErr;

    const [rulesErr, RuleRows] = await DB.All('SELECT RuleID, Scope, Actions FROM AlertRules', []);
    if (rulesErr) throw rulesErr;

    for (const Row of RuleRows || []) {
      const RuleID = Number(Row && Row.RuleID);
      if (!Number.isFinite(RuleID)) continue;

      let ParsedScope = null;
      let ParsedActions = null;

      try {
        ParsedScope = JSON.parse(Row && Row.Scope ? Row.Scope : '{}');
      } catch {
        ParsedScope = null;
      }
      try {
        ParsedActions = JSON.parse(Row && Row.Actions ? Row.Actions : '[]');
      } catch {
        ParsedActions = null;
      }

      const NextScope = ParsedScope
        ? replaceUUIDInValue(ParsedScope, OldUUID, NewUUID)
        : ParsedScope;
      const NextActions = ParsedActions
        ? replaceUUIDInValue(ParsedActions, OldUUID, NewUUID)
        : ParsedActions;

      const ScopeChanged =
        ParsedScope != null && JSON.stringify(NextScope) !== JSON.stringify(ParsedScope);
      const ActionsChanged =
        ParsedActions != null && JSON.stringify(NextActions) !== JSON.stringify(ParsedActions);

      if (!ScopeChanged && !ActionsChanged) continue;

      const [ruleUpdateErr] = await DB.Run(
        'UPDATE AlertRules SET Scope = ?, Actions = ?, UpdatedAt = ? WHERE RuleID = ?',
        [
          ScopeChanged ? JSON.stringify(NextScope) : Row.Scope,
          ActionsChanged ? JSON.stringify(NextActions) : Row.Actions,
          Date.now(),
          RuleID,
        ]
      );
      if (ruleUpdateErr) throw ruleUpdateErr;
    }

    const [commitErr] = await DB.Run('COMMIT');
    if (commitErr) throw commitErr;
    committed = true;
  } catch (Err) {
    await DB.Run('ROLLBACK');
    Logger.error('Failed to replace client UUID', Err);
    return Fail('Failed to replace client');
  }

  if (!committed) return Fail('Failed to replace client');

  ExistingClient.UUID = NewUUID;
  ClientList = oldClientRows.filter((Client) => Client.UUID !== OldUUID && Client.UUID !== NewUUID);
  ClientList.push(ExistingClient);

  if (oldCriticalUSB) {
    CriticalUSBIndex.set(NewUUID, oldCriticalUSB);
    CriticalUSBIndex.delete(OldUUID);
  }
  if (oldCriticalApps) {
    CriticalApplicationIndex.set(NewUUID, oldCriticalApps);
    CriticalApplicationIndex.delete(OldUUID);
  }

  applyCriticalUSBState(ExistingClient);
  applyCriticalApplicationState(ExistingClient);

  BroadcastManager.emit('ClientListChanged');
  BroadcastManager.emit('ClientUpdated', ExistingClient);
  BroadcastManager.emit('AlertRuleListChanged');
  return Ok(ExistingClient);
};

// Truthy existence check: prefer cache, fallback to DB
Manager.Exists = async (UUID) => {
  // Check in memory first
  const CachedClient = ClientList.find((c) => c.UUID === UUID);
  if (CachedClient) return true;
  // If not found in memory, check in database
  const [Err, Client] = await DB.Get('SELECT * FROM Clients WHERE UUID = ?', [UUID]);
  if (Err) return false;
  if (!Client) return false;
  return true;
};

// Fetch a Client object (cached or hydrated); callers should not mutate DB-only fields directly
Manager.Get = async (UUID) => {
  // Check in memory first
  const CachedClient = ClientList.find((c) => c.UUID === UUID);
  if (CachedClient) {
    return [null, CachedClient];
  }
  // If not found in memory, check in database
  let [Err, ClientRow] = await DB.Get('SELECT * FROM Clients WHERE UUID = ?', [UUID]);
  if (Err) return ['Failed to fetch client', null];
  if (!ClientRow) return ['Client Not Found', null];
  ClientRow = new Client(ClientRow);
  applyCriticalUSBState(ClientRow);
  applyCriticalApplicationState(ClientRow);
  return [null, ClientRow];
};

Manager.Initialized = false;
// Warm the cache from DB so early UI renders have data
Manager.Init = async () => {
  await loadCriticalUSBIndex();
  await loadCriticalApplicationIndex();
  let [Err, Clients] = await DB.All('SELECT * FROM Clients');
  if (Err || !Clients) {
    Manager.Initialized = true;
    ClientList = [];
    return;
  }
  Clients = Clients.map((row) => {
    const ClientEntity = new Client(row);
    applyCriticalUSBState(ClientEntity);
    applyCriticalApplicationState(ClientEntity);
    return ClientEntity;
  });
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
  Clients = Clients.map((row) => {
    const ClientEntity = new Client(row);
    applyCriticalUSBState(ClientEntity);
    applyCriticalApplicationState(ClientEntity);
    return ClientEntity;
  });
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
  CriticalUSBIndex.clear();
  CriticalApplicationIndex.clear();
  Manager.Initialized = false;
  return;
};

module.exports = {
  Manager,
};
