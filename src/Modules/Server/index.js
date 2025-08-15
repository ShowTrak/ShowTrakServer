const { CreateLogger } = require("../Logger");
const Logger = CreateLogger("WebServer");

const HTTP = require("http");
const { Server: WebServer } = require("socket.io");
const { Config } = require("../Config");
const { Manager: AdoptionManager } = require("../AdoptionManager");
const { Manager: ClientManager } = require("../ClientManager");
const { Manager: ScriptManager } = require("../ScriptManager");
const { Manager: ScriptExecutionManager } = require("../ScriptExecutionManager");
const { Manager: AppDataManager } = require("../AppData");
// const { Manager: BroadcastManager } = require('../Broadcast');
const express = require("express");

const { Wait } = require("../Utils");

// Create a basic HTTP server
const Server = HTTP.createServer();

const app = express();

const ScriptDirectory = AppDataManager.GetScriptsDirectory();
app.use(express.static(ScriptDirectory));
Server.on("request", app);

// Initialize Socket.IO server
const io = new WebServer(Server, {
	cors: {
		origin: "*", // Adjust as needed for security
		methods: ["GET", "POST"],
	},
	connectTimeout: 4000, // 5 seconds
	pingTimeout: 2500, // 10 seconds
	pingInterval: 5000, // 25 seconds
});

const Manager = {};

// Handle new connections
io.on("connection", async (socket) => {
	// UUID
	if (!socket.handshake.query || Object.keys(socket.handshake.query).length === 0 || !socket.handshake.query.UUID)
		return socket.disconnect(true);
	socket.UUID = socket.handshake.query.UUID;
	socket.Adopted = socket.handshake.query.Adopted === "true" ? true : false;
	Logger.log(`Client Connected As ${socket.UUID} ${socket.Adopted ? "(Adopted)" : "(Pending Adoption)"}`);
	socket.join(socket.UUID); // Join the socket to a room with its UUID

	// IP
	socket.IP = socket.handshake.address;
	if (socket.IP.startsWith("::ffff:")) {
		socket.IP = socket.IP.substring(7); // Remove IPv6 prefix if present
	}

	// Does client think it's adopted?
	if (socket.Adopted) {
		let IsInDatabase = await ClientManager.Exists(socket.UUID);
		if (!IsInDatabase) {
			Logger.warn("Client is adopted but not found in the database:", socket.UUID);
			Logger.warn("Unadopting Client");
			socket.emit("Unadopt");
		}
	}

	// Client making itself discoverable as an unadopted device
	socket.on("AdoptionHeartbeat", async (Data) => {
		await AdoptionManager.AddClientPendingAdoption(socket.UUID, socket.IP, Data);
	});

	socket.on("GetScripts", async (Callback) => {
		Logger.log(`Client ${socket.UUID} requested scripts.`);
		const Scripts = await ScriptManager.GetScripts();
		Callback(Scripts);
	});

	socket.on("Heartbeat", async (Data) => {
		await ClientManager.Heartbeat(socket.UUID, Data, socket.IP);
	});

	socket.on("SystemInfo", async (Data) => {
		await ClientManager.SystemInfo(socket.UUID, Data, socket.IP);
	});

	socket.on("USBDeviceList", async (DeviceList) => {
		Logger.log(
			`USB Device list recieved from ${socket.UUID} (${DeviceList.length} ${
				DeviceList.length === 1 ? "Device" : "Devices"
			})`
		);
		await ClientManager.SetUSBDeviceList(socket.UUID, DeviceList);
	});

	socket.on("USBDeviceConnected", async (Device) => {
		Logger.log(`USB Device Connected to ${socket.UUID} (${Device.ManufacturerName} ${Device.ProductName})`);
		await ClientManager.USBDeviceAdded(socket.UUID, Device);
		return;
	});

	socket.on("USBDeviceDisconnected", async (Device) => {
		Logger.log(`USB Device Disconnected from ${socket.UUID} (${Device.ManufacturerName} ${Device.ProductName})`);
		await ClientManager.USBDeviceRemoved(socket.UUID, Device);
		return;
	});

	socket.on("disconnect", () => {
		if (!socket.UUID) {
			Logger.log("Socket disconnected without UUID:", socket.id);
			return;
		}
		AdoptionManager.RemoveClientPendingAdoption(socket.UUID);
		ClientManager.Timeout(socket.UUID);
	});

	socket.on("ScriptExecutionResponse", (RequestID, Error, _Result) => {
		Logger.log(`Received Script Execution Response for RequestID: ${RequestID}`);
		ScriptExecutionManager.Complete(RequestID, Error);
	});
});

Manager.ExecuteScripts = async (ScriptID, Targets, ResetList) => {
	if (ResetList) await ScriptExecutionManager.ClearQueue();
	for (const UUID of Targets) {
		const RequestID = await ScriptExecutionManager.AddToQueue(UUID, ScriptID);
		io.to(UUID).emit("ExecuteScript", RequestID, ScriptID);
	}
};

Manager.ExecuteBulkRequest = async (Action, Targets, ReadableName) => {
	if (!ReadableName) ReadableName = Action;
	await ScriptExecutionManager.ClearQueue();
	for (const UUID of Targets) {
		await Wait(150);
		const RequestID = await ScriptExecutionManager.AddInternalTaskToQueue(UUID, ReadableName);
		io.to(UUID).emit(Action, RequestID);
	}
};

Manager.SendMessageByGroup = async (Group, Message, Data) => {
	return io.to(Group).emit(Message, Data);
};

Server.listen(Config.Application.Port, () => {
	Logger.log(`Socket.IO server running on port ${Config.Application.Port}`);
});

module.exports = {
	Manager,
};
