// IdentifyManager
// Orchestrates the "Identify Client" feature. Only ONE client can be in
// identify mode at a time; starting identify on a new client clears the
// previous one. Works for both adopted clients (ClientManager) and
// pending-adoption devices (AdoptionManager); integrated (SDK) clients are
// rejected because they cannot render the overlay.
const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('IdentifyManager');

const { Ok, Fail } = require('../Utils');
const { Manager: ClientManager } = require('../ClientManager');
const { Manager: AdoptionManager } = require('../AdoptionManager');

// Socket.IO server instance, registered by the Server module during setup.
let io = null;

// UUID of the single client currently in identify mode (or null).
let IdentifyingUUID = null;

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

// Clear the identify flag on whichever manager owns the UUID. Does not emit to
// the client (callers decide whether the client still needs telling to stop).
async function ClearFlag(UUID) {
  const IsAdopted = await ClientManager.Exists(UUID);
  if (IsAdopted) {
    await ClientManager.SetIdentifying(UUID, false);
    return;
  }
  AdoptionManager.SetIdentifying(UUID, false);
}

// Start identify mode on a client. Clears any previously-identifying client
// first so only one overlay is ever active across the fleet.
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
    if (!Client.Online) return Fail('Client is offline.');
    // Only surface a nickname when it meaningfully differs from the hostname.
    if (Client.Nickname && Client.Nickname !== Client.Hostname) {
      Nickname = Client.Nickname;
    }
  } else {
    const Pending = AdoptionManager.GetClientsPendingAdoption().find((d) => d && d.UUID === UUID);
    if (!Pending) return Fail('Client not found.');
  }

  // Clear the previous client (state + tell it to stop) before starting anew.
  if (IdentifyingUUID && IdentifyingUUID !== UUID) {
    await Manager.Stop(IdentifyingUUID);
  }

  if (IsAdopted) {
    const [SetErr] = await ClientManager.SetIdentifying(UUID, true);
    if (SetErr) return Fail(SetErr);
  } else {
    AdoptionManager.SetIdentifying(UUID, true);
  }

  IdentifyingUUID = UUID;
  io.to(UUID).emit('Identify', { Nickname });
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
  if (IdentifyingUUID === UUID) IdentifyingUUID = null;
  Logger.log(`Identify stopped for ${UUID}`);
  return Ok(true);
};

// Client-initiated stop (user pressed esc / clicked the overlay). The overlay
// is already gone on the client, so we only clear server-side state.
Manager.HandleClientStopped = async (UUID) => {
  UUID = String(UUID || '').trim();
  if (!UUID) return;
  await ClearFlag(UUID);
  if (IdentifyingUUID === UUID) IdentifyingUUID = null;
  Logger.log(`Identify cleared by client ${UUID}`);
};

// A client socket disconnected; drop any lingering identify state for it.
Manager.HandleDisconnect = async (UUID) => {
  UUID = String(UUID || '').trim();
  if (!UUID) return;
  if (IdentifyingUUID !== UUID) return;
  IdentifyingUUID = null;
  try {
    // Use the shared clear path so adopted + pending entries both reset.
    await ClearFlag(UUID);
    Logger.log(`Identify cleared on disconnect for ${UUID}`);
  } catch (e) {
    Logger.warn('HandleDisconnect cleanup failed for', UUID, e);
  }
};

Manager.GetIdentifyingUUID = () => IdentifyingUUID;

module.exports = {
  Manager,
};
