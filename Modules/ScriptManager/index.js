const { CreateLogger } = require("../Logger");
const Logger = CreateLogger("ScriptManager");

// const { Config } = require('../Config');
const path = require("path");
const fs = require("fs");

const { Manager: AppDataManager } = require("../AppData");
const { Manager: ChecksumManager } = require("../ChecksumManager");

var Scripts = [];

class Script {
	constructor(ID, Data, AllFilesInFolder) {
		this.ID = ID;
		this.Name = Data.Name;
		this.Type = Data.Type;
		this.Path = Data.Path;
		this.LabelStyle = Data.LabelStyle || "light";
		this.Weight = Data.Weight || 0;
		this.Confirmation = Data.Confirmation || false;

		this.Files = AllFilesInFolder;

		this.isEnabled = Data.Enabled || false;
		this.isValid = true;
	}
}

const Manager = {};

function RecursiveFileList(dir, baseDir = dir) {
	let results = [];
	var list = fs.readdirSync(dir);
	list.forEach((file) => {
		const filePath = path.join(dir, file);
		const stat = fs.statSync(filePath);
		if (stat && stat.isDirectory()) {
			results.push({
				Path: path.relative(baseDir, filePath),
				Type: "directory",
			});
			results = results.concat(RecursiveFileList(filePath, baseDir));
		} else {
			results.push({
				Path: path.relative(baseDir, filePath),
				Type: "file",
				Checksum: null,
			});
		}
	});
	return results;
}

Manager.GetScripts = async () => {
	let TempScripts = [];
	const ScriptsDirectory = AppDataManager.GetScriptsDirectory();

	Logger.log(`Loading scripts from ${ScriptsDirectory}`);
	if (!fs.existsSync(ScriptsDirectory)) return [];

	const ScriptFolders = fs.readdirSync(ScriptsDirectory).filter((file) => {
		const fullPath = path.join(ScriptsDirectory, file);
		return fs.statSync(fullPath).isDirectory() && file !== "node_modules" && file !== ".git" && file !== ".vscode";
	});

	for (const ScriptFolder of ScriptFolders) {
		Logger.log(`Loading script from folder: ${ScriptFolder}`);
		const scriptJsonPath = path.join(ScriptsDirectory, ScriptFolder, "Script.json");
		if (!fs.existsSync(scriptJsonPath)) {
			Logger.error(`Script.json not found in ${ScriptFolder}, skipping...`);
			continue;
		}
		try {
			const ScriptData = JSON.parse(fs.readFileSync(scriptJsonPath, "utf-8"));
			const AllFilesInFolder = RecursiveFileList(path.join(ScriptsDirectory, ScriptFolder));
			for (const File of AllFilesInFolder) {
				if (File.Type === "file") {
					File.Checksum = await ChecksumManager.Checksum(
						path.join(ScriptsDirectory, ScriptFolder, File.Path)
					);
				}
			}
			TempScripts.push(new Script(ScriptFolder, ScriptData, AllFilesInFolder));
		} catch (err) {
			Logger.error(`Failed to load Script.json for ${ScriptFolder}:`, err);
		}
	}
	Scripts = TempScripts;
	return Scripts;
};

Manager.Get = async (ID) => {
	if (Scripts.length === 0) await Manager.GetScripts();
	const Script = Scripts.find((s) => s.ID === ID);
	if (!Script) return null;
	return Script;
};

module.exports = {
	Manager,
};
