const { CreateLogger } = require("../Logger");
const Logger = CreateLogger("ClientManager");

// const { Config } = require('../Config');

const { Manager: DB } = require("../DB");

const { Manager: BroadcastManager } = require("../Broadcast");

const { Manager: ClientManager } = require("../ClientManager");

const Manager = {};

class Group {
	constructor(Data) {
		this.GroupID = Data.GroupID;
		this.Title = Data.Title || null;
		this.Weight = Data.Weight || 0;
	}

	// Persistent Storage
	async SetTitle(Title) {
		if (this.Title === Title) return;
		this.Title = Title;
		let [Err, _Res] = await DB.Run("UPDATE Groups SET Title = ? WHERE UUID = ?", [Title, this.GroupID]);
		if (Err) return Logger.error("Failed to update group Title");
		Logger.debug(`Group ${this.GroupID} Title updated to ${Title}`);
	}
	async SetWeight(Weight) {
		if (this.Weight === Weight) return;
		this.Weight = Weight;
		let [Err, _Res] = await DB.Run("UPDATE Groups SET Weight = ? WHERE UUID = ?", [Weight, this.GroupID]);
		if (Err) return Logger.error("Failed to update group Weight");
		Logger.debug(`Group ${this.GroupID} Weight updated to ${Weight}`);
	}
}

Manager.Create = async (Title = "New Group") => {
	if (!Title) return [new Error("Group title is required")];
	let [Err, _Res] = await DB.Run("INSERT INTO Groups (Title, Weight) VALUES (?, ?)", [Title, 100]);
	if (Err) return;
	BroadcastManager.emit("GroupListChanged");
	return;
};

Manager.Delete = async (GroupID) => {
	if (!GroupID) return ["GroupID is required to delete a group", null];
	let [Err, _Res] = await DB.Run("DELETE FROM Groups WHERE GroupID = ?", [GroupID]);
	let ClientsWithGroup = await ClientManager.GetClientsInGroup(GroupID);
	for (const Client of ClientsWithGroup) {
		await Client.SetGroupID(null);
	}
	if (Err) return [Err];
	Logger.debug(`Deleted group with ID ${GroupID}`);
	BroadcastManager.emit("GroupListChanged");
	return [null, "Group Deleted Successfully"];
};

Manager.Get = async (GroupID) => {
	if (!GroupID) return [new Error("GroupID is required")];
	let [Err, Rows] = await DB.Get("SELECT * FROM Groups WHERE GroupID = ?", [GroupID]);
	if (Err) {
		Logger.error("Failed to fetch group:", Err);
		return [Err, null];
	}
	if (Rows.length === 0) return [null, null];
	let Group = new Group(Rows);
	return [null, Group];
};

Manager.GetAll = async () => {
	let [Err, Rows] = await DB.All("SELECT * FROM Groups ORDER BY Weight DESC");
	if (Err) {
		Logger.error("Failed to fetch groups:", Err);
		return [Err, []];
	}
	return [null, Rows.map((row) => new Group(row))];
};

module.exports = {
	Manager,
};
