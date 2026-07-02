// IdentifyManager
// Orchestrates the "Identify Client" feature. Multiple clients can be in
// identify mode concurrently. Works for both adopted clients (ClientManager)
// and pending-adoption devices (AdoptionManager); integrated (SDK) clients are
// rejected because they cannot render the overlay.
const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('IdentifyManager');

const { Ok, Fail } = require('../Utils');
const { Manager: ClientManager } = require('../ClientManager');
const { Manager: AdoptionManager } = require('../AdoptionManager');
const { Manager: BroadcastManager } = require('../Broadcast');

// Socket.IO server instance, registered by the Server module during setup.
let io = null;

// UUIDs currently in identify mode.
const IdentifyingUUIDs = new Set();
const MINIMUM_IDENTIFY_VERSION = [3, 7, 0];

const Manager = {};

// Called once by the Server module so we can dispatch to specific client rooms.
Manager.RegisterIO = (server) => {
  io = server;
};

function IsIntegratedClient(Client) {
  if (!Client) return false;
  if (Client.Integrated === true) return true;
  return (
    String(Client.OperatingSystem || '')
      .trim()
      .toLowerCase() === 'integrated'
  );
}

function ParseSemverTuple(value) {
  const match = String(value || '')
    .trim()
    .match(/(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(?:[^0-9]|$)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function IsVersionAtLeast(value, minimumTuple) {
  const parsed = ParseSemverTuple(value);
  if (!parsed) return false;
  for (let i = 0; i < minimumTuple.length; i++) {
    const current = parsed[i] || 0;
    const minimum = minimumTuple[i] || 0;
    if (current > minimum) return true;
    if (current < minimum) return false;
  }
  return true;
}

// Clear the identify flag on whichever manager owns the UUID. Does not emit to
// the client (callers decide whether the client still needs telling to stop).
async function ClearFlag(UUID) {
  // Attempt both paths so transient lookup failures cannot leave stale
  // identify state behind.
  const [ClientErr] = await ClientManager.SetIdentifying(UUID, false);
  const PendingCleared = AdoptionManager.SetIdentifying(UUID, false);
  if (ClientErr && !PendingCleared) {
    Logger.debug(`ClearFlag could not clear ${UUID}: ${ClientErr}`);
  }
}

function EmitIdentifyStateChanged() {
  // Force a fresh UI sync regardless of whether the mutation occurred on an
  // adopted or pending client path.
  BroadcastManager.emit('ClientListChanged');
  BroadcastManager.emit('AdoptionListUpdated');
}

// Start identify mode on a client.
Manager.Identify = async (UUID) => {
  UUID = String(UUID || '').trim();
  if (!UUID) return Fail('A client UUID is required.');
  if (!io) return Fail('Server is not ready.');

  const IsAdopted = await ClientManager.Exists(UUID);
  let Nickname = null;

  if (IsAdopted) {
    const [Err, Client] = await ClientManager.Get(UUID);
    if (Err) return Fail(Err);
    if (!Client) return Fail('Client not found.');
    if (IsIntegratedClient(Client)) {
      return Fail('Integrated clients cannot be identified.');
    }
    if (!IsVersionAtLeast(Client.Version, MINIMUM_IDENTIFY_VERSION)) {
      return Fail('Identify requires client version 3.7.0 or newer.');
    }
    if (!Client.Online) return Fail('Client is offline.');
    // Only surface a nickname when it meaningfully differs from the hostname.
    if (Client.Nickname && Client.Nickname !== Client.Hostname) {
      Nickname = Client.Nickname;
    }
  } else {
    const Pending = AdoptionManager.GetClientsPendingAdoption().find((d) => d && d.UUID === UUID);
    if (!Pending) return Fail('Client not found.');
    if (!IsVersionAtLeast(Pending.Version, MINIMUM_IDENTIFY_VERSION)) {
      return Fail('Identify requires client version 3.7.0 or newer.');
    }
  }

  if (IsAdopted) {
    const [SetErr] = await ClientManager.SetIdentifying(UUID, true);
    if (SetErr) return Fail(SetErr);
  } else {
    AdoptionManager.SetIdentifying(UUID, true);
  }

  IdentifyingUUIDs.add(UUID);
  io.to(UUID).emit('Identify', { Nickname });
  EmitIdentifyStateChanged();
  Logger.log(`Identify started for ${UUID}`);
  return Ok(true);
};

// Stop identify mode from the server side (e.g. operator picked "Stop
// Identifying"). Clears state and tells the client to hide its overlay.
Manager.Stop = async (UUID) => {
  UUID = String(UUID || '').trim();
  if (!UUID) return Fail('A client UUID is required.');

  await ClearFlag(UUID);
  if (io) io.to(UUID).emit('StopIdentify');
  IdentifyingUUIDs.delete(UUID);
  EmitIdentifyStateChanged();
  Logger.log(`Identify stopped for ${UUID}`);
  return Ok(true);
};

// Client-initiated stop (user pressed esc / clicked the overlay). The overlay
// is already gone on the client, so we only clear server-side state.
Manager.HandleClientStopped = async (UUID) => {
  UUID = String(UUID || '').trim();
  if (!UUID) return;
  await ClearFlag(UUID);
  IdentifyingUUIDs.delete(UUID);
  EmitIdentifyStateChanged();
  Logger.log(`Identify cleared by client ${UUID}`);
};

// A client socket disconnected; drop any lingering identify state for it.
Manager.HandleDisconnect = async (UUID) => {
  UUID = String(UUID || '').trim();
  if (!UUID) return;
  if (!IdentifyingUUIDs.has(UUID)) return;
  IdentifyingUUIDs.delete(UUID);
  try {
    // Use the shared clear path so adopted + pending entries both reset.
    await ClearFlag(UUID);
    EmitIdentifyStateChanged();
    Logger.log(`Identify cleared on disconnect for ${UUID}`);
  } catch (e) {
    Logger.warn('HandleDisconnect cleanup failed for', UUID, e);
  }
};

Manager.GetIdentifyingUUIDs = () => Array.from(IdentifyingUUIDs);

module.exports = {
  Manager,
};
