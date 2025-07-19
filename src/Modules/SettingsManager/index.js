const { CreateLogger } = require("../Logger");
const Logger = CreateLogger("Settings");

const { DefaultSettings, Groups } = require("./DefaultSettings");

const { Manager: BroadcastManager } = require("../Broadcast");

const { Manager: DB } = require("../DB");

const Settings = new Map();

const Manager = [];

Manager.Initialized = false;

Manager.Init = async () => {
	if (Manager.Initialized) return;

	for (const Setting of DefaultSettings) {
		let [Err, ManualSetting] = await DB.Get("SELECT * FROM settings WHERE key = ?", [Setting.Key]);
		if (Err) throw Err;

		let NewSetting = {
            Group: Setting.Group,
			Key: Setting.Key,
			Title: Setting.Title,
			Description: Setting.Description,
			Type: Setting.Type,
			Value: ManualSetting ? ManualSetting.Value : Setting.DefaultValue,
			isDefault: ManualSetting ? ManualSetting.Value === Setting.DefaultValue : true,
			DefaultValue: Setting.DefaultValue,
			OnUpdateEvent: Setting.OnUpdateEvent || null
		};

		Settings.set(NewSetting.Key, NewSetting);

		// Logger.log(`Setting ${NewSetting.Key} is ${NewSetting.Value}`);
	}
	return;
};

Manager.GetGroups = async () => {
    return Groups;
}

Manager.GetAll = async () => {
	if (!Manager.Initialized) await Manager.Init();
	return Array.from(Settings.values());
};

Manager.GetValue = async (Key) => {
	if (!Manager.Initialized) await Manager.Init();
	let Setting = Settings.get(Key);
	if (!Setting) return null;
	return Setting.Value;
}

Manager.Get = async (Key) => {
	if (!Manager.Initialized) Manager.Init();
	return Settings.get(Key);
};

Manager.Set = async (Key, Value) => {
	if (!Manager.Initialized) await Manager.Init();

	let Setting = Settings.get(Key);
	if (!Setting) return ["Invalid Setting Key", null];

	if (Setting.Value === Value) return [null, Setting];

	Setting.Value = Value;
    
	let [Err, _Res] = await DB.Run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [Key, Value]);
	if (Err) return ["Error updating setting", null];
    
    Setting.isDefault = Setting.Value === Setting.DefaultValue;

	Settings.set(Key, Setting);

	Logger.log(`Setting ${Key} updated to ${Value}`);

    BroadcastManager.emit('SettingsUpdated');

	if (Setting.OnUpdateEvent) BroadcastManager.emit(Setting.OnUpdateEvent);

	return [null, Setting];
};

Manager.Init();

module.exports = {
	Manager,
};
