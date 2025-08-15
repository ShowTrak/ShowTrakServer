// AdoptionManager
// - Tracks devices that are discoverable but not yet adopted into the DB
// - Provides a small in-memory list for the UI and transitions to adopted
const { CreateLogger } = require("../Logger");
const Logger = CreateLogger("AdoptionManager");
const { Manager: BroadcastManager } = require("../Broadcast");

const { Manager: ClientManager } = require("../ClientManager");

// Ephemeral list of discoverable, not-yet-adopted clients
var ClientsPendingAdoption = [];

class ClientPendingAdoption {
	constructor(UUID, IP, Data) {
		this.State = "Pending";
		this.UUID = UUID;
		this.Hostname = Data.Hostname || "No Hostname Found";
		this.Version = Data.Version || "No Version Found";
		this.IP = IP || "No IP Found";
	}
}

const Manager = {};

Manager.GetClientsPendingAdoption = () => {
	return ClientsPendingAdoption;
};

// Reset the list (e.g., on reinitialize)
Manager.ClearAllDevicesPendingAdopption = async () => {
	ClientsPendingAdoption = [];
	BroadcastManager.emit("AdoptionListUpdated");
	return;
};

// Register or refresh a device in the pending list; if already adopted, trigger readopt flow
Manager.AddClientPendingAdoption = async (UUID, IP, Data) => {
	let IsClientMeantToBeAdopted = await ClientManager.Exists(UUID);
	if (IsClientMeantToBeAdopted) {
		Manager.RemoveClientPendingAdoption(UUID);
		Logger.log(`Client ${UUID} is already adopted, removing from pending adoption list.`);
		BroadcastManager.emit("ReadoptDevice", UUID);
		return;
	} else {
		// Check if the client is already in the list
		const existingClient = ClientsPendingAdoption.find((client) => client.UUID === UUID);
		if (existingClient) return;
		ClientsPendingAdoption.push(new ClientPendingAdoption(UUID, IP, Data));
		Logger.log(`Client ${UUID} added to pending adoption list.`);
		BroadcastManager.emit("AdoptionListUpdated");
		return;
	}
};

// Update UI-visible state for a pending device (e.g., "Adopting")
Manager.SetState = async (UUID, State) => {
	const client = ClientsPendingAdoption.find((client) => client.UUID === UUID);
	if (!client) {
		Logger.log(`Client ${UUID} not found in pending adoption list.`);
		return;
	}
	client.State = State;
	Logger.log(`Client ${UUID} state set to ${State}.`);
	BroadcastManager.emit("AdoptionListUpdated");
	return;
};

// Remove a device from the pending list; safe if missing
Manager.RemoveClientPendingAdoption = (UUID) => {
	const index = ClientsPendingAdoption.findIndex((client) => client.UUID === UUID);
	if (index !== -1) {
		ClientsPendingAdoption.splice(index, 1);
		BroadcastManager.emit("AdoptionListUpdated");
		Logger.log(`Client ${UUID} removed from pending adoption list.`);
	} else {
		Logger.log(`Client ${UUID} not found in pending adoption list.`);
	}
	return;
};

module.exports = {
	Manager,
};
