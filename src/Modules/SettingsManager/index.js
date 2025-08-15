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

		// Normalize value based on type
		const normalize = (val) => {
			switch (Setting.Type) {
				case "BOOLEAN": {
					if (typeof val === "boolean") return val;
					if (val === 1 || val === "1" || val === "true") return true;
					if (val === 0 || val === "0" || val === "false") return false;
					return !!val;
				}
				case "INTEGER": {
					if (val === null || val === undefined || val === "") return Setting.DefaultValue;
					const n = parseInt(val, 10);
					return isNaN(n) ? Setting.DefaultValue : n;
				}
				case "STRING": {
					return val == null ? "" : String(val);
				}
				case "OPTION": {
					if (Setting.Options && Array.isArray(Setting.Options)) {
						return Setting.Options.includes(val) ? val : Setting.DefaultValue;
					}
					return val;
				}
				default: {
					return val;
				}
			}
		};

		const EffectiveValue = ManualSetting ? normalize(ManualSetting.Value) : Setting.DefaultValue;

		let NewSetting = {
			Group: Setting.Group,
			Key: Setting.Key,
			Title: Setting.Title,
			Description: Setting.Description,
			Type: Setting.Type,
			Value: EffectiveValue,
			isDefault: ManualSetting ? EffectiveValue === Setting.DefaultValue : true,
			DefaultValue: Setting.DefaultValue,
			OnUpdateEvent: Setting.OnUpdateEvent || null,
			Options: Setting.Options || null,
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

	// Coerce incoming value to correct type
	const coerce = (val) => {
		switch (Setting.Type) {
			case "BOOLEAN": {
				if (typeof val === "boolean") return val;
				if (val === 1 || val === "1" || val === "true") return true;
				if (val === 0 || val === "0" || val === "false") return false;
				return !!val;
			}
			case "INTEGER": {
				if (val === null || val === undefined || val === "") return Setting.DefaultValue;
				const n = parseInt(val, 10);
				return isNaN(n) ? Setting.DefaultValue : n;
			}
			case "STRING": {
				return val == null ? "" : String(val);
			}
			case "OPTION": {
				if (Setting.Options && Array.isArray(Setting.Options)) {
					return Setting.Options.includes(val) ? val : Setting.DefaultValue;
				}
				return val;
			}
			default: {
				return val;
			}
		}
	};

	const CoercedValue = coerce(Value);

	if (Setting.Value === CoercedValue) return [null, Setting];

	Setting.Value = CoercedValue;
    
	let [Err, _Res] = await DB.Run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [Key, Setting.Value]);
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
