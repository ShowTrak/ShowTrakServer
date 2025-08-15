// const { Config } = require('../Config');
const path = require("path");
const fs = require("fs");

// TODO(macOS): Consider using ~/Library/Application Support/ShowTrakServer instead of Preferences (more standard for app data).
// Add a simple migration if changing paths (copy/move existing data on first run).
let BasePath =
	process.env.APPDATA ||
	(process.platform == "darwin" ? process.env.HOME + "/Library/Preferences" : process.env.HOME + "/.local/share");
const appDataPath = path.join(BasePath, "ShowTrakServer");

const Manager = {};

Manager.Initialized = false;

Manager.Initialize = async () => {
	if (Manager.Initialized) return;
	if (!fs.existsSync(appDataPath)) {
		fs.mkdirSync(appDataPath, { recursive: true });
	}

	let AppDataFolders = ["Logs", "Scripts", "Storage"];
	AppDataFolders.forEach((folder) => {
		const folderPath = path.join(appDataPath, folder);
		if (!fs.existsSync(folderPath)) {
			fs.mkdirSync(folderPath, { recursive: true });
		}
	});
	Manager.Initialized = true;
};

Manager.GetLogsDirectory = () => {
	return path.join(appDataPath, "Logs");
};

Manager.GetScriptsDirectory = () => {
	return path.join(appDataPath, "Scripts");
};

Manager.GetStorageDirectory = () => {
	return path.join(appDataPath, "Storage");
};

Manager.OpenFolder = (FolderPath) => {
	if (fs.existsSync(FolderPath)) {
		// TODO(macOS/Linux): Use `open` on macOS and `xdg-open` on Linux instead of Windows-only `start`.
		// Example:
		// const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
		// require('child_process').exec(`${opener} "${FolderPath}"`);
		require("child_process").exec(`start "" "${FolderPath}"`);
		return true;
	} else {
		return false;
	}
};

module.exports = {
	Manager,
};
