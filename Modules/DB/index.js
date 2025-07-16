const { CreateLogger } = require("../Logger");
const Logger = CreateLogger("DB");

const { Manager: AppDataManager } = require("../AppData");

const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const DatabasePath = AppDataManager.GetStorageDirectory();
const DatabaseFileName = "DB.sqlite";

const dbPath = path.join(DatabasePath, DatabaseFileName);
const DB = new sqlite3.Database(dbPath, async (err) => {
	if (err) return Logger.error("Failed to connect to database:", err);
	Logger.success("Connected to SQLite database.");
	await Manager.InitializeSchema();
});

const Manager = {};

Manager.InitializeSchema = async () => {
	let Tables = require("./schema.js");
	for (let Table of Tables) {
		Logger.database(`Creating table: ${Table.Name}`);
		let [Err, _Result] = await Manager.Run(Table.SQL);
		if (Err) {
			Logger.databaseError(`Failed to create table ${Table.Name}:`, Err);
		} else {
			Logger.database(`Table ${Table.Name} created successfully.`);
		}
	}
};

Manager.Get = async (Query, Params) => {
	return new Promise((resolve, _reject) => {
		DB.get(Query, Params, (err, row) => {
			if (err) {
				Logger.databaseError("Error fetching data:", err);
				return resolve([err, null]);
			}
			resolve([null, row]);
		});
	});
};

Manager.All = async (Query, Params) => {
	return new Promise((resolve, _reject) => {
		DB.all(Query, Params, (err, rows) => {
			if (err) {
				Logger.databaseError("Error fetching data:", err);
				return resolve([err, null]);
			}
			resolve([null, rows]);
		});
	});
};

Manager.Run = async (Query, Params) => {
	return new Promise((resolve, _reject) => {
		DB.run(Query, Params, function (err) {
			if (err) {
				Logger.databaseError("Error running query:", err);
				return resolve([err, null]);
			}
			resolve([null, this]);
		});
	});
};

module.exports = {
	Manager,
};
