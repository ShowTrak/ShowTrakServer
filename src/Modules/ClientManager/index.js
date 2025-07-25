const { CreateLogger } = require("../Logger");
const Logger = CreateLogger("ClientManager");

// const { Config } = require('../Config');

const { Manager: DB } = require("../DB");

const { Manager: BroadcastManager } = require("../Broadcast");
const { Manager: SettingsManager } = require("../SettingsManager");

const Manager = {};

var ClientList = [];

class Client {
	constructor(Data) {
		this.UUID = Data.UUID;
		this.Nickname = Data.Nickname ? Data.Nickname : Data.Hostname;
		this.Hostname = Data.Hostname || null;
		this.GroupID = Data.GroupID || null;
		this.MacAddress = Data.MacAddress || null;
		this.Version = Data.Version || null;
		this.IP = Data.IP || null;
		this.Timestamp = Data.Timestamp;

		this.Online = false;
		this.LastSeen = Date.now();
		this.Vitals = {
			CPU: {},
			Ram: {},
			Uptime: {},
		};
		this.USBDeviceList = [];
	}

	// RAM Storage
	SetOnline(Online) {
		if (this.Online === Online) return;
		this.Online = Online;
		Logger.debug(`Client ${this.UUID} Online updated to ${Online}`);
		BroadcastManager.emit("ClientUpdated", this);
		return;
	}
	SetLastSeen(LastSeen) {
		if (this.LastSeen === LastSeen) return;
		this.LastSeen = LastSeen;
		// Logger.success(`Client ${this.UUID} LastSeen updated to ${LastSeen}`);
		// BroadcastManager.emit('ClientUpdated', this);
		return;
	}
	SetVitals(Vitals) {
		this.Vitals = Vitals;
		// Logger.debug(`Client ${this.UUID} Vitals updated`, Vitals);
		BroadcastManager.emit("ClientUpdated", this);
	}
	SetUSBDeviceList(USBDeviceList) {
		this.USBDeviceList = USBDeviceList;
		Logger.debug(`Client ${this.UUID} USB Device List updated`);
		return;
	}
	async USBDeviceAdded(Device) {
		this.USBDeviceList.push(Device);
		BroadcastManager.emit("USBDeviceAdded", this, Device);
		let NOTIFIY_ON_USB_DEVICE_CONNECT = await SettingsManager.GetValue("NOTIFIY_ON_USB_DEVICE_CONNECT")
		if (NOTIFIY_ON_USB_DEVICE_CONNECT) {
			BroadcastManager.emit("Notify", `[${this.Nickname}] Device Connected: ${Device.ManufacturerName} ${Device.ProductName}`, 'info', 15000);
		}
		let AUDIO_ON_USB_DEVICE_CONNECT = await SettingsManager.GetValue("AUDIO_ON_USB_DEVICE_CONNECT")
		if (AUDIO_ON_USB_DEVICE_CONNECT) {
			BroadcastManager.emit('PlaySound', 'Notification')
		}
		return;
	}
	async USBDeviceRemoved(Device) {
		this.USBDeviceList = this.USBDeviceList.filter((d) => d.SerialNumber !== Device.SerialNumber);
		BroadcastManager.emit("USBDeviceRemoved", this, Device);
		let NOTIFIY_ON_USB_DEVICE_DISCONNECT = await SettingsManager.GetValue("NOTIFIY_ON_USB_DEVICE_DISCONNECT")
		if (NOTIFIY_ON_USB_DEVICE_DISCONNECT) {
			BroadcastManager.emit("Notify", `[${this.Nickname}] Device Disconnected: ${Device.ManufacturerName} ${Device.ProductName}`, 'warning', 15000);
		}
		let AUDIO_ON_USB_DEVICE_CONNECT = await SettingsManager.GetValue("AUDIO_ON_USB_DEVICE_DISCONNECT")
		if (AUDIO_ON_USB_DEVICE_CONNECT) {
			BroadcastManager.emit('PlaySound', 'Warning')
		}
		return;
	}

	// Persistent Storage
	async SetNickname(Nickname) {
		if (this.Nickname === Nickname) return;
		this.Nickname = Nickname;
		let [Err, _Res] = await DB.Run("UPDATE Clients SET Nickname = ? WHERE UUID = ?", [Nickname, this.UUID]);
		if (Err) return Logger.error("Failed to update client nickname");
		BroadcastManager.emit("ClientUpdated", this);
		Logger.debug(`Client ${this.UUID} nickname updated to ${Nickname}`);
	}
	async SetGroupID(GroupID) {
		if (this.GroupID === GroupID) return;
		if (GroupID === "null") GroupID = null;
		this.GroupID = GroupID;
		let [Err, _Res] = await DB.Run("UPDATE Clients SET GroupID = ? WHERE UUID = ?", [GroupID, this.UUID]);
		if (Err) return Logger.error("Failed to update client GroupID");
		BroadcastManager.emit("ClientListChanged");
		BroadcastManager.emit("ClientUpdated", this);
		Logger.debug(`Client ${this.UUID} GroupID updated to ${GroupID}`);
	}
	async SetHostname(Hostname) {
		if (this.Hostname === Hostname) return;
		this.Hostname = Hostname;
		let [Err, _Res] = await DB.Run("UPDATE Clients SET Hostname = ? WHERE UUID = ?", [Hostname, this.UUID]);
		if (Err) return Logger.error("Failed to update client hostname");
		BroadcastManager.emit("ClientUpdated", this);
		Logger.debug(`Client ${this.UUID} hostname updated to ${Hostname}`);
	}
	async SetMacAddress(MacAddress) {
		if (this.MacAddress === MacAddress) return;
		this.MacAddress = MacAddress;
		let [Err, _Res] = await DB.Run("UPDATE Clients SET MacAddress = ? WHERE UUID = ?", [MacAddress, this.UUID]);
		if (Err) return Logger.error("Failed to update client mac address");
		BroadcastManager.emit("ClientUpdated", this);
		Logger.debug(`Client ${this.UUID} mac address updated to ${MacAddress}`);
	}
	async SetVersion(Version) {
		if (this.Version === Version) return;
		this.Version = Version;
		let [Err, _Res] = await DB.Run("UPDATE Clients SET Version = ? WHERE UUID = ?", [Version, this.UUID]);
		if (Err) return Logger.error("Failed to update client version");
		BroadcastManager.emit("ClientUpdated", this);
		Logger.debug(`Client ${this.UUID} version updated to ${Version}`);
	}
	async SetIP(IP) {
		if (this.IP === IP) return;
		this.IP = IP;
		let [Err, _Res] = await DB.Run("UPDATE Clients SET IP = ? WHERE UUID = ?", [IP, this.UUID]);
		if (Err) return Logger.error("Failed to update client IP");
		BroadcastManager.emit("ClientUpdated", this);
		Logger.debug(`Client ${this.UUID} IP updated to ${IP}`);
	}
}

Manager.Timeout = async (UUID) => {
	let Exists = await Manager.Exists(UUID);
	if (!Exists) return;
	let [Err, TimedOutClient] = await Manager.Get(UUID);
	if (Err) return Logger.error("Failed to get client for timeout:", Err);
	if (!TimedOutClient) return Logger.warn(`Client ${UUID} not found for timeout.`);
	TimedOutClient.SetOnline(false);
	return;
};

Manager.Heartbeat = async (UUID, Data, IP) => {
	let CachedClient = ClientList.find((c) => c.UUID === UUID);
	if (!CachedClient) {
		Logger.warn(`Client ${UUID} not found in memory, fetching from database.`);
		let [Err, FetchedClient] = await DB.Get("SELECT * FROM Clients WHERE UUID = ?", [UUID]);
		if (Err) {
			Logger.error("Failed to fetch client from database:", Err);
			return ["Failed to fetch client", null];
		}
		if (!FetchedClient) {
			Logger.warn(`Client ${UUID} not found in database, creating new entry.`);
			return ["Client Not Valid", null];
		} else {
			CachedClient = new Client(FetchedClient);
			ClientList.push(CachedClient);
			BroadcastManager.emit("ClientListChanged");
		}
	}

	await CachedClient.SetVersion(Data.Version || null);
	await CachedClient.SetIP(IP || null);
	CachedClient.SetOnline(true);
	CachedClient.SetLastSeen(Date.now());
	CachedClient.SetVitals(Data.Vitals);

	return [null, "Heartbeat processed successfully"];
};

Manager.SetUSBDeviceList = async (UUID, DeviceList) => {
	let [Err, Target] = await Manager.Get(UUID);
	if (Err) return [Err, null];
	if (!Target) return ["Client Not Found", null];
	Target.SetUSBDeviceList(DeviceList);
	return [null, "USB Device List updated successfully"];
};

Manager.USBDeviceAdded = async (UUID, Device) => {
	let [Err, Target] = await Manager.Get(UUID);
	if (Err) return [Err, null];
	if (!Target) return ["Client Not Found", null];
	Target.USBDeviceAdded(Device);
	return [null, "Updated"];
};

Manager.USBDeviceRemoved = async (UUID, Device) => {
	let [Err, Target] = await Manager.Get(UUID);
	if (Err) return [Err, null];
	if (!Target) return ["Client Not Found", null];
	Target.USBDeviceRemoved(Device);
	return [null, "Updated"];
};

Manager.SystemInfo = async (UUID, Data, IP) => {
	let [Err, Target] = await Manager.Get(UUID);
	if (Err) return [Err, null];
	if (!Target) return ["Client Not Found", null];

	await Target.SetHostname(Data.Hostname || null);
	let Macs = Object.values(Data.MacAddresses || {});
	for (let Interface of Macs) {
		if (Interface.ipv4 == IP) await Target.SetMacAddress(Interface.mac);
	}

	return [null, "Heartbeat processed successfully"];
};

Manager.Update = async (UUID, Data) => {
	let [Err, Client] = await Manager.Get(UUID);
	if (Err) return false;
	if (!Client) return false;
	if (Object.prototype.hasOwnProperty.call(Data, "Nickname")) {
		await Client.SetNickname(Data.Nickname);
	}
	if (Object.prototype.hasOwnProperty.call(Data, "GroupID")) {
		await Client.SetGroupID(Data.GroupID);
	}
	return true;
};

Manager.Create = async (UUID) => {
	// Verify if the client already exists
	let [Err, ExistingClient] = await DB.Get("SELECT * FROM Clients WHERE UUID = ?", [UUID]);
	if (Err) return "Failed to fetch existing client";
	if (ExistingClient) return "Client already exists";
	// Insert new client into the database
	let [InsertErr, _Res] = await DB.Run(
		"INSERT INTO Clients (UUID, Hostname, Version, IP, Timestamp) VALUES (?, ?, ?, ?, ?)",
		[UUID, "ShowTrak Client", null, null, Date.now()]
	);
	if (InsertErr) return "Failed to insert new client";
	ClientList.push(
		new Client({
			UUID: UUID,
			Hostname: null,
			Version: "X.X.X",
			IP: null,
			Timestamp: Date.now(),
		})
	);
	BroadcastManager.emit("ClientListChanged");
};

Manager.Delete = async (UUID) => {
	// Remove from database
	let [Err, _Res] = await DB.Run("DELETE FROM Clients WHERE UUID = ?", [UUID]);
	if (Err) return "Failed to delete client";
	// Remove from in-memory list
	ClientList = ClientList.filter((c) => c.UUID !== UUID);
	Logger.success(`Client ${UUID} deleted successfully`);
	return null;
};

Manager.Exists = async (UUID) => {
	// Check in memory first
	let CachedClient = ClientList.find((c) => c.UUID === UUID);
	if (CachedClient) return true;
	// If not found in memory, check in database
	let [Err, Client] = await DB.Get("SELECT * FROM Clients WHERE UUID = ?", [UUID]);
	if (Err) return false;
	if (!Client) return false;
	return true;
};

Manager.Get = async (UUID) => {
	// Check in memory first
	let CachedClient = ClientList.find((c) => c.UUID === UUID);
	if (CachedClient) {
		return [null, CachedClient];
	}
	// If not found in memory, check in database
	let [Err, ClientRow] = await DB.Get("SELECT * FROM Clients WHERE UUID = ?", [UUID]);
	if (Err) return ["Failed to fetch client", null];
	if (!ClientRow) return ["Client Not Found", null];
	ClientRow = new Client(ClientRow);
	return [null, ClientRow];
};

Manager.GetAll = async () => {
	// Check in memory first
	if (ClientList.length > 0) {
		return [null, ClientList];
	}
	// If not found in memory, fetch from database
	let [Err, Clients] = await DB.All("SELECT * FROM Clients");
	if (Err) return ["Failed to fetch clients", null];
	if (!Clients || Clients.length === 0) return [null, []];
	Clients = Clients.map((row) => new Client(row));
	ClientList = Clients; // Update in-memory list
	BroadcastManager.emit("ClientListChanged");
	return [null, Clients];
};

Manager.GetClientsInGroup = async (GroupID) => {
	return ClientList.filter((c) => c.GroupID === GroupID);
};

Manager.ClearCache = async () => {
	ClientList = [];
	return;
};

module.exports = {
	Manager,
};
