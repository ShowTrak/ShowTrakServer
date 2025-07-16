const Package = require("../../package.json");

const Config = {};

Config.Application = {
	Version: Package.version || "0.0.0",
	Name: "ShowTrak",
	Port: 3000,
};

Config.Shared = {
	Version: Config.Application.Version,
};

module.exports = {
	Config,
};
