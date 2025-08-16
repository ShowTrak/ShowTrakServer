// Console + file logger with colored tags; writes to daily log file under AppData.
// Improvements: leveled logging, async file writes, midnight rollover, retention cleanup.
const colors = require("colors");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

let IsInInstallation = false;
try {
	// In install/update phase for Electron apps, avoid file I/O noise.
	IsInInstallation = require("electron-squirrel-startup");
} catch (_) {
	IsInInstallation = false;
}

const { Manager: AppDataManager } = require("../AppData");

const LogDirectory = AppDataManager.GetLogsDirectory();
if (!fs.existsSync(LogDirectory)) {
	fs.mkdirSync(LogDirectory, { recursive: true });
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

// Plain (non-colored) labels for file output
const PlainTypes = {
	Info: Pad("INFO"),
	Warn: Pad("WARN"),
	Error: Pad("ERROR"),
	Trace: Pad("TRACE"),
	Debug: Pad("DEBUG"),
	Success: Pad("SUCCESS"),
	Database: Pad("DATABASE"),
};

// Log level gating
const LevelRank = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const DefaultLevel = process.env.NODE_ENV === "production" ? "info" : "debug";
const Settings = {
	level: (process.env.LOG_LEVEL || DefaultLevel).toLowerCase(),
	toConsole: (process.env.LOG_TO_CONSOLE || "true").toLowerCase() !== "false",
	toFile: (process.env.LOG_TO_FILE || "true").toLowerCase() !== "false",
	retentionDays: Number.parseInt(process.env.LOG_RETENTION_DAYS || "30", 10),
};

function isLevelEnabled(level) {
	const want = LevelRank[Settings.level] ?? LevelRank[DefaultLevel];
	const have = LevelRank[level] ?? LevelRank.info;
	return have <= want;
}

function Tag(Text, Type) {
	return `[${colors.cyan("ShowTrakServer")}] [${colors.cyan(Pad(Text))}] [${
		Object.prototype.hasOwnProperty.call(Types, Type) ? Types[Type] : Types["Info"]
	}]`;
}

function TagPlain(Text, Type) {
	return `[ShowTrakServer] [${Pad(Text)}] [${
		Object.prototype.hasOwnProperty.call(PlainTypes, Type) ? PlainTypes[Type] : PlainTypes["Info"]
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

// Daily rollover: compute today's file on each write and ensure it exists.
function getTodayLogFilePath() {
	const fileName = `ShowTrakServer-${GetDatestampLabel()}.log`;
	return path.join(LogDirectory, fileName);
}

async function ensureTodayLogFile() {
	const filePath = getTodayLogFilePath();
	try {
		await fsp.mkdir(LogDirectory, { recursive: true });
		await fsp.access(filePath).catch(() => fsp.writeFile(filePath, "", "utf8"));
	} catch (_) {}
	return filePath;
}

// Simple write queue to keep ordering and avoid sync I/O.
let writeTail = Promise.resolve();
function enqueueWrite(line) {
	if (IsInInstallation || !Settings.toFile) return;
	writeTail = writeTail
		.then(async () => {
			const filePath = await ensureTodayLogFile();
			await fsp.appendFile(filePath, line + "\n", "utf8");
		})
		.catch(() => {});
}

function serializeArg(arg) {
	if (arg instanceof Error) return arg.stack || String(arg);
	if (typeof arg === "string") return arg;
	try {
		return JSON.stringify(arg);
	} catch (_) {
		return String(arg);
	}
}

// Remove ANSI color codes for file output
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;
function stripAnsi(s) {
	if (typeof s !== "string") return s;
	return s.replace(ANSI_REGEX, "");
}

function writeLine(alias, type, arg, levelKey) {
	const msg = serializeArg(arg);
	const consoleTag = Tag(alias, type);
	const fileTag = TagPlain(alias, type);
	const line = `${GetDateTimeStamp()} ${fileTag} ${stripAnsi(msg)}`;
	if (Settings.toConsole && isLevelEnabled(levelKey)) console.log(consoleTag, msg);
	enqueueWrite(line);
}

class Logger {
	constructor(Alias) {
		this.Alias = Alias;
	}
	log(...args) {
		args.forEach((arg) => writeLine(this.Alias, "Info", arg, "info"));
	}
	info(...args) {
		args.forEach((arg) => writeLine(this.Alias, "Info", arg, "info"));
	}
	silent(...args) {
		args.forEach((arg) => enqueueWrite(`${GetDateTimeStamp()} ${TagPlain(this.Alias, "Info")} ${serializeArg(arg)}`));
	}
	warn(...args) {
		args.forEach((arg) => writeLine(this.Alias, "Warn", arg, "warn"));
	}
	error(...args) {
		args.forEach((arg) => writeLine(this.Alias, "Error", arg instanceof Error ? arg : serializeArg(arg), "error"));
	}
	debug(...args) {
		if (!isLevelEnabled("debug")) return;
		args.forEach((arg) => writeLine(this.Alias, "Debug", arg, "debug"));
	}
	trace(...args) {
		if (!isLevelEnabled("trace")) return;
		args.forEach((arg) => writeLine(this.Alias, "Trace", arg, "trace"));
	}
	success(...args) {
		args.forEach((arg) => writeLine(this.Alias, "Success", arg, "info"));
	}
	database(...args) {
		args.forEach((arg) => writeLine(this.Alias, "Database", arg, "info"));
	}
	databaseError(...args) {
		args.forEach((arg) => writeLine(this.Alias, "Database", arg instanceof Error ? arg : colors.red(arg), "error"));
	}
	child(suffix) { return new Logger(`${this.Alias}:${suffix}`); }
}

function CreateLogger(Alias) {
	return new Logger(Alias);
}

module.exports = {
	CreateLogger,
	configure(options = {}) {
		if (options.level) Settings.level = String(options.level).toLowerCase();
		if (typeof options.toConsole === "boolean") Settings.toConsole = options.toConsole;
		if (typeof options.toFile === "boolean") Settings.toFile = options.toFile;
		if (typeof options.retentionDays === "number") Settings.retentionDays = options.retentionDays;
	},
};

// Cleanup old logs on startup (best-effort)
(async function cleanupOldLogs() {
	if (!Number.isFinite(Settings.retentionDays) || Settings.retentionDays <= 0) return;
	try {
		const files = await fsp.readdir(LogDirectory);
		const cutoff = Date.now() - Settings.retentionDays * 24 * 60 * 60 * 1000;
		await Promise.all(
			files
				.filter((f) => /^ShowTrakServer-\d{4}-\d{2}-\d{2}\.log$/.test(f))
				.map(async (f) => {
					const full = path.join(LogDirectory, f);
					const stat = await fsp.stat(full).catch(() => null);
					if (!stat) return;
					if (stat.mtimeMs < cutoff) {
						await fsp.unlink(full).catch(() => {});
					}
				})
		);
	} catch (_) {}
})();
