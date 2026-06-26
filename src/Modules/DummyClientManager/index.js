// DummyClientManager
// Owns the lifecycle of virtual "Dummy" clients: persistence, ID generation,
// CRUD, heartbeat routing (by DummyID) and group ordering. Connection state is
// kept in RAM by each DummyClient instance and surfaced to the UI via the
// 'DummyClientUpdated' / 'DummyClientListChanged' broadcast events.
const { Manager: DB } = require('../DB');
const { Manager: BroadcastManager } = require('../Broadcast');
const { Ok, Fail } = require('../Utils');
const { createGroupOrdering } = require('../Shared/group-ordering');

const {
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  DEFAULT_INTERVAL_MS,
  ClampInterval,
  SanitizeDummyID,
  IsValidDummyID,
  RandomSuffix,
  NormalizeIP,
} = require('./normalize');
const { DummyClient } = require('./dummy');

const Manager = {};

let DummyList = [];

Manager.Initialized = false;

function GenerateUUID() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return require('crypto').randomUUID();
}

function IsDummyIDTaken(DummyID) {
  return DummyList.some((D) => D.DummyID === DummyID);
}

// Produce a unique "DummyClient######" identifier that is not already in use.
Manager.GenerateUniqueDummyID = () => {
  for (let Attempt = 0; Attempt < 50; Attempt++) {
    const Candidate = `DummyClient${RandomSuffix()}`;
    if (!IsDummyIDTaken(Candidate)) return Candidate;
  }
  // Extremely unlikely fallback: append more entropy.
  return `DummyClient${RandomSuffix()}${RandomSuffix()}`;
};

// Defaults for a brand new dummy: matching random suffix in both ID and title.
Manager.GenerateDefaults = () => {
  const DummyID = Manager.GenerateUniqueDummyID();
  const Suffix = DummyID.replace(/^DummyClient/, '');
  return {
    DummyID,
    Nickname: `Dummy ${Suffix}`,
    Interval: DEFAULT_INTERVAL_MS,
  };
};

Manager.Init = async () => {
  const [Err, Rows] = await DB.All('SELECT * FROM DummyClients');
  if (Err) {
    Manager.Initialized = true;
    DummyList = [];
    return;
  }
  DummyList = (Rows || []).map((Row) => new DummyClient(Row));
  Manager.Initialized = true;
  BroadcastManager.emit('DummyClientListChanged');
};

// Rebuild runtime state from DB after external bulk changes (e.g. config import).
Manager.Reload = async () => {
  for (const Dummy of DummyList) Dummy.StopLoop();
  DummyList = [];
  Manager.Initialized = false;
  await Manager.Init();
};

Manager.Shutdown = async () => {
  for (const Dummy of DummyList) {
    try {
      Dummy.StopLoop();
    } catch {}
  }
};

Manager.GetAll = async () => {
  if (!Manager.Initialized) await Manager.Init();
  return [null, DummyList.map((D) => D.ToJSON())];
};

Manager.GetAllSync = () => DummyList.map((D) => D.ToJSON());

Manager.Get = async (UUID) => {
  const Cached = DummyList.find((D) => D.UUID === UUID);
  if (!Cached) return ['Dummy client not found', null];
  return [null, Cached.ToJSON()];
};

Manager.Create = async (Payload = {}) => {
  if (!Manager.Initialized) await Manager.Init();
  const Now = Date.now();
  const Defaults = Manager.GenerateDefaults();

  const DummyID = Object.prototype.hasOwnProperty.call(Payload, 'DummyID')
    ? SanitizeDummyID(Payload.DummyID)
    : Defaults.DummyID;
  if (!IsValidDummyID(DummyID)) return Fail('Dummy ID must be alphanumeric with no spaces');
  if (IsDummyIDTaken(DummyID)) return Fail(`Dummy ID "${DummyID}" is already in use`);

  const Nickname =
    Object.prototype.hasOwnProperty.call(Payload, 'Nickname') && String(Payload.Nickname).trim()
      ? String(Payload.Nickname).trim()
      : Defaults.Nickname;
  const Interval = ClampInterval(
    Object.prototype.hasOwnProperty.call(Payload, 'Interval') ? Payload.Interval : Defaults.Interval
  );
  const GroupID = Payload.GroupID == null ? null : Payload.GroupID;
  const Weight = typeof Payload.Weight === 'number' ? Payload.Weight : 100;
  const UUID = GenerateUUID();

  const [Err] = await DB.Run(
    'INSERT INTO DummyClients (UUID, DummyID, Nickname, Interval, GroupID, Weight, Timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [UUID, DummyID, Nickname, Interval, GroupID, Weight, Now]
  );
  if (Err) return Fail('Failed to create dummy client');

  const Dummy = new DummyClient({
    UUID,
    DummyID,
    Nickname,
    Interval,
    GroupID,
    Weight,
    Timestamp: Now,
  });
  DummyList.push(Dummy);
  BroadcastManager.emit('DummyClientListChanged');
  return Ok(Dummy.ToJSON());
};

Manager.Update = async (UUID, Payload = {}) => {
  const Dummy = DummyList.find((D) => D.UUID === UUID);
  if (!Dummy) return Fail('Dummy client not found');

  let NextDummyID = Dummy.DummyID;
  if (Object.prototype.hasOwnProperty.call(Payload, 'DummyID')) {
    NextDummyID = SanitizeDummyID(Payload.DummyID);
    if (!IsValidDummyID(NextDummyID)) return Fail('Dummy ID must be alphanumeric with no spaces');
    if (NextDummyID !== Dummy.DummyID && DummyList.some((D) => D.DummyID === NextDummyID)) {
      return Fail(`Dummy ID "${NextDummyID}" is already in use`);
    }
  }

  const NextNickname =
    Object.prototype.hasOwnProperty.call(Payload, 'Nickname') && String(Payload.Nickname).trim()
      ? String(Payload.Nickname).trim()
      : Dummy.Nickname;
  const NextInterval = ClampInterval(
    Object.prototype.hasOwnProperty.call(Payload, 'Interval') ? Payload.Interval : Dummy.Interval
  );
  const NextGroupID = Object.prototype.hasOwnProperty.call(Payload, 'GroupID')
    ? Payload.GroupID
    : Dummy.GroupID;

  const [Err] = await DB.Run(
    'UPDATE DummyClients SET DummyID = ?, Nickname = ?, Interval = ?, GroupID = ? WHERE UUID = ?',
    [NextDummyID, NextNickname, NextInterval, NextGroupID, UUID]
  );
  if (Err) return Fail('Failed to update dummy client');

  Dummy.DummyID = NextDummyID;
  Dummy.Nickname = NextNickname;
  Dummy.GroupID = NextGroupID == null ? null : NextGroupID;
  Dummy.SetInterval(NextInterval);

  BroadcastManager.emit('DummyClientUpdated', Dummy.ToJSON());
  BroadcastManager.emit('DummyClientListChanged');
  return Ok(Dummy.ToJSON());
};

Manager.Delete = async (UUID) => {
  const Idx = DummyList.findIndex((D) => D.UUID === UUID);
  if (Idx === -1) return Fail('Dummy client not found');
  const Dummy = DummyList[Idx];
  Dummy.StopLoop();
  const [Err] = await DB.Run('DELETE FROM DummyClients WHERE UUID = ?', [UUID]);
  if (Err) return Fail('Failed to delete dummy client');
  DummyList.splice(Idx, 1);
  BroadcastManager.emit('DummyClientListChanged');
  return Ok(true);
};

// Deliver a heartbeat addressed to a dummy by its user-facing DummyID. The
// source IP (from the OSC packet or HTTP request) is recorded and persisted so
// the UI can display where the dummy last reported from.
Manager.Heartbeat = async (DummyID, IP = null) => {
  if (!Manager.Initialized) await Manager.Init();
  const Sanitized = SanitizeDummyID(DummyID);
  const Dummy = DummyList.find((D) => D.DummyID === Sanitized);
  if (!Dummy) return Fail(`Unknown Dummy ID "${DummyID}"`);
  const NormalizedIP = NormalizeIP(IP);
  const IPChanged = NormalizedIP && NormalizedIP !== Dummy.IP;
  Dummy.Heartbeat(NormalizedIP);
  if (IPChanged) {
    // Persist quietly (no dirty tracking) since the IP is auto-discovered
    // runtime data, not a user edit to the show document.
    const Run =
      typeof DB.RunWithoutDirtyTracking === 'function'
        ? DB.RunWithoutDirtyTracking.bind(DB)
        : DB.Run.bind(DB);
    await Run('UPDATE DummyClients SET IP = ? WHERE UUID = ?', [NormalizedIP, Dummy.UUID]);
  }
  return Ok(true);
};

// Group ordering (SetGroupAndWeight / MoveGroupToNoGroup / ReconcileOrphanedGroups)
// is shared with other list-backed managers via the group-ordering helper.
const GroupOrdering = createGroupOrdering({
  DB,
  BroadcastManager,
  table: 'DummyClients',
  keyColumn: 'UUID',
  getList: () => DummyList,
  getKey: (Dummy) => Dummy.UUID,
  listChangedEvent: 'DummyClientListChanged',
  ensureInitialized: async () => {
    if (!Manager.Initialized) await Manager.Init();
  },
  labels: {
    notFound: 'Dummy client not found',
    update: 'Failed to update dummy client',
    move: 'Failed to move dummy clients to no group',
    reconcile: 'Failed to reconcile orphaned dummy clients',
  },
});

// Move a dummy to a group with a specific weight (used by drag/drop ordering).
Manager.SetGroupAndWeight = (UUID, GroupID, Weight) =>
  GroupOrdering.SetGroupAndWeight(UUID, GroupID, Weight);

// Move all dummies in a specific group into the default no-group bucket (null).
Manager.MoveGroupToNoGroup = (GroupID) => GroupOrdering.MoveGroupToNoGroup(GroupID);

// Ensure all dummies reference an existing group; unknown groups reset to null.
Manager.ReconcileOrphanedGroups = (ValidGroupIDs) =>
  GroupOrdering.ReconcileOrphanedGroups(ValidGroupIDs);

Manager.MIN_INTERVAL_MS = MIN_INTERVAL_MS;
Manager.MAX_INTERVAL_MS = MAX_INTERVAL_MS;

module.exports = { Manager };
