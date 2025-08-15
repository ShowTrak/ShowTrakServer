// Console + file logger with colored tags; writes to daily log file under AppData.
// Debug-level logs are suppressed in production builds via Config.Production.
const Config = require("../Config");
const colors = require("colors");
const fs = require("fs");
const path = require("path");

let IsInInstallation = require("electron-squirrel-startup");

const { Manager: AppDataManager } = require("../AppData");

const LogDirectory = AppDataManager.GetLogsDirectory();
console.log(`Log Directory: ${LogDirectory}`);
const LogFileName = `ShowTrakServer-${GetDatestampLabel()}.log`;
if (!fs.existsSync(LogDirectory)) {
	fs.mkdirSync(LogDirectory, { recursive: true });
}
const LogFilePath = path.join(LogDirectory, LogFileName);
if (!fs.existsSync(LogFilePath)) {
	fs.writeFileSync(LogFilePath, "", "utf8");
}

function Pad(Text, Length = 17) {
	return Text.padEnd(Length, " ").toUpperCase();
}

const Types = {
	Info: colors.cyan(Pad("INFO")),
	Warn: colors.magenta(Pad("WARN")),
	Error: colors.red(Pad("ERROR")),
	Trace: colors.magenta(Pad("TRACE")),
	Debug: colors.grey(Pad("DEBUG")),
	Success: colors.green(Pad("SUCCESS")),
	Database: colors.grey(Pad("DATABASE")),
};

function Tag(Text, Type) {
	return `[${colors.cyan("ShowTrakServer")}] [${colors.cyan(Pad(Text))}] [${
		Object.prototype.hasOwnProperty.call(Types, Type) ? Types[Type] : Types["Info"]
	}]`;
}

function GetDatestampLabel() {
	const date = new Date();
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(
		2,
		"0"
	)}`;
}

function GetDateTimeStamp() {
	const date = new Date();
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(
		2,
		"0"
	)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(
		date.getSeconds()
	).padStart(2, "0")}`;
}

function WriteToFile(Line) {
	if (IsInInstallation || !fs.existsSync(LogDirectory)) return;
	if (typeof Line !== "string") return;
	fs.appendFileSync(LogFilePath, `${GetDateTimeStamp()} > ${Line}` + "\n", "utf8");
}

class Logger {
	constructor(Alias) {
		this.Alias = Alias;
	}
	log(...args) {
		args.forEach((arg) => console.log(Tag(this.Alias, "Info"), arg));
		args.forEach(WriteToFile);
	}
	info(...args) {
		args.forEach((arg) => console.log(Tag(this.Alias, "Info"), arg));
		args.forEach(WriteToFile);
	}
	silent(...args) {
		args.forEach(WriteToFile);
	}
	warn(...args) {
		args.forEach((arg) => console.log(Tag(this.Alias, "Warn"), arg));
		args.forEach(WriteToFile);
	}
	error(...args) {
		args.forEach((arg) => console.log(Tag(this.Alias, "Error"), arg));
		args.forEach(WriteToFile);
	}
	debug(...args) {
		if (Config.Production) return;
		args.forEach((arg) => console.log(Tag(this.Alias, "Debug"), arg));
	}
	success(...args) {
		args.forEach((arg) => console.log(Tag(this.Alias, "Success"), arg));
		args.forEach(WriteToFile);
	}
	database(...args) {
		args.forEach((arg) => console.log(Tag(this.Alias, "Database"), arg));
		args.forEach(WriteToFile);
	}
	databaseError(...args) {
		args.forEach((arg) => console.log(Tag(this.Alias, "Database"), colors.red(arg)));
		args.forEach(WriteToFile);
	}
}

function CreateLogger(Alias) {
	return new Logger(Alias);
}

module.exports = {
	CreateLogger,
};
