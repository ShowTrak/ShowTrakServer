// const { CreateLogger } = require('../Logger');
// const Logger = CreateLogger('FileSelector');

const { dialog } = require("electron");

const Manager = {};

Manager.SelectFile = async (Title) => {
	return await dialog.showOpenDialog({
		filters: [{ name: "ShowTrak Server Config", extensions: ["ShowTrakConfig"] }],
		properties: ["openFile", "createDirectory"],
		message: Title,
	});
};

Manager.SaveDialog = async (Title) => {
	let CurrentDatestamp = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 10);
	return await dialog.showSaveDialog({
		title: Title,
		defaultPath: `ShowTrak Server Backup ${CurrentDatestamp}.ShowTrak`,
		filters: [{ name: "ShowTrak Server Config", extensions: ["ShowTrakConfig"] }],
		properties: ["createDirectory", "showOverwriteConfirmation"],
	});
};

module.exports = {
	Manager,
};
