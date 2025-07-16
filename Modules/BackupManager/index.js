const { CreateLogger } = require("../Logger");
const Logger = CreateLogger("BackupManager");

const path = require("path");
const fs = require("fs");

const { Manager: DB } = require("../DB");

const { Config } = require("../Config");

const { Manager: Broadcast } = require("../Broadcast");

const Manager = {};

Manager.ExportConfig = async (Path) => {
	Logger.log("Exporting configuration to:", Path);
	let [GroupsErr, Groups] = await DB.All("SELECT * FROM Groups");
	if (GroupsErr) return [GroupsErr, null];
	let [ClientsErr, Clients] = await DB.All("SELECT * FROM Clients");
	if (ClientsErr) return [ClientsErr, null];

	let Export = {
		Timestamp: Date.now(),
		Version: Config.Application.Version,
		Groups: Groups,
		Clients: Clients,
	};

	try {
		// Ensure the directory exists
		const dir = path.dirname(Path);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(Path, JSON.stringify(Export, null, 2), "utf8");
		return [null, "Configuration exported successfully"];
	} catch (err) {
		Logger.error("Failed to export configuration:", err);
		return [err, null];
	}
};

Manager.ImportConfig = async (Path) => {
	if (!fs.existsSync(Path)) {
		Logger.error("Configuration file does not exist:", Path);
		return ["Configuration file does not exist", null];
	}
	try {
		const data = fs.readFileSync(Path, "utf8");
		const ImportedConfig = JSON.parse(data);

		// Validate structure
		if (!ImportedConfig || !ImportedConfig.Groups || !ImportedConfig.Clients) {
			Logger.error("Invalid configuration format");
			return ["Invalid configuration format", null];
		}

		// Validate version
		if (ImportedConfig.Version !== Config.Application.Version) {
			Logger.warn(
				`Configuration version mismatch: expected ${Config.Application.Version}, got ${ImportedConfig.Version}`
			);
		}

		// Import groups
		Logger.log("Deleting All Clients");
		await DB.Run("DELETE FROM Clients");
		Logger.log("Deleting All Groups");
		await DB.Run("DELETE FROM Groups");
		for (const { GroupID, Title, Weight } of ImportedConfig.Groups) {
			Logger.log(`Importing group: [${GroupID}] ${Title} [${Weight}]`);
			await DB.Run("INSERT OR REPLACE INTO Groups (GroupID, Title, Weight) VALUES (?, ?, ?)", [
				GroupID,
				Title,
				Weight,
			]);
		}
		for (const {
			UUID,
			Nickname,
			Hostname,
			MacAddress,
			GroupID,
			Weight,
			Version,
			IP,
			Timestamp,
		} of ImportedConfig.Clients) {
			Logger.log(`Importing client: [${UUID}] ${Nickname} [${Hostname}]`);
			await DB.Run(
				"INSERT OR REPLACE INTO Clients (UUID, Nickname, Hostname, MacAddress, GroupID, Weight, Version, IP, Timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[UUID, Nickname, Hostname, MacAddress, GroupID, Weight, Version, IP, Timestamp]
			);
		}
	} catch (err) {
		Logger.error("Failed to import configuration:", err);
		return ["Failed to import configuration:", null];
	}
	Broadcast.emit("ReinitializeSystem");
	return [null, "Configuration imported successfully"];
};

module.exports = {
	Manager,
};
