interface SchemaTable {
  Name: string;
  SQL: string;
}

interface SchemaMigration {
  /** Monotonic version recorded in the SchemaMigrations table. Never reuse or reorder. */
  Version: number;
  SQL: string;
}

interface SchemaArray extends Array<SchemaTable> {
  Migrations?: SchemaMigration[];
}

const Schema: SchemaArray = [];

Schema.push({
  Name: 'Groups',
  SQL: 'CREATE TABLE IF NOT EXISTS `Groups` ( \
        GroupID INTEGER PRIMARY KEY AUTOINCREMENT, \
        Title TEXT, \
        Weight INTEGER, \
        FullWidth INTEGER NOT NULL DEFAULT 1, \
        KeyBind TEXT, \
        Slug TEXT \
    )',
});

Schema.push({
  Name: 'Clients',
  SQL: 'CREATE TABLE IF NOT EXISTS `Clients` ( \
            UUID TEXT PRIMARY KEY, \
            Nickname TEXT, \
            Hostname TEXT, \
            OperatingSystem TEXT, \
            MacAddress TEXT, \
            GroupID INTEGER, \
            Weight INTEGER NOT NULL DEFAULT 100, \
            Version TEXT, \
            IP TEXT, \
            RunOnLaunchScriptID TEXT, \
            RunOnLaunchDelaySeconds INTEGER, \
            Unassigned INTEGER NOT NULL DEFAULT 0, \
            Slug TEXT, \
            Timestamp BIGINT(11) NOT NULL \
    )',
});

Schema.push({
  Name: 'Settings',
  SQL: 'CREATE TABLE IF NOT EXISTS `Settings` ( \
            Key TEXT PRIMARY KEY, \
            Value BLOB \
    )',
});

// Monitoring Targets are a separate kind of "client": no installed agent, just
// server-driven probes (ping, http, etc). Method-specific config is stored as
// JSON in the Settings column so new methods can introduce new fields without
// requiring schema migrations.
Schema.push({
  Name: 'MonitoringTargets',
  SQL: 'CREATE TABLE IF NOT EXISTS `MonitoringTargets` ( \
            TargetID INTEGER PRIMARY KEY AUTOINCREMENT, \
            Nickname TEXT, \
            Address TEXT, \
            Method TEXT NOT NULL, \
            Interval INTEGER NOT NULL DEFAULT 30000, \
            Settings TEXT, \
            GroupID INTEGER, \
            Weight INTEGER NOT NULL DEFAULT 100, \
            LastSuccessAt BIGINT(11), \
            DegradedThresholdMs INTEGER NOT NULL DEFAULT 0, \
            Slug TEXT, \
            Timestamp BIGINT(11) NOT NULL \
    )',
});

// Each Monitoring Target can own multiple independent checks (e.g. two DNS
// probes plus a QLab workspace check). A check carries its own Address,
// method-specific Settings (JSON) and degraded threshold; the parent target
// owns the shared check Interval and grouping. Legacy single-method targets are
// migrated into a single check row on first boot (see MonitoringTargetManager).
Schema.push({
  Name: 'MonitoringChecks',
  SQL: 'CREATE TABLE IF NOT EXISTS `MonitoringChecks` ( \
            CheckID INTEGER PRIMARY KEY AUTOINCREMENT, \
            TargetID INTEGER NOT NULL, \
            Name TEXT, \
            Address TEXT, \
            Method TEXT NOT NULL, \
            Settings TEXT, \
            DegradedThresholdMs INTEGER NOT NULL DEFAULT 0, \
            Weight INTEGER NOT NULL DEFAULT 100, \
            LastSuccessAt BIGINT(11), \
            Timestamp BIGINT(11) NOT NULL \
    )',
});

// Dummy Clients are a virtual class of "client": there is no installed agent.
// Instead they are kept alive by external heartbeats delivered over OSC or
// HTTP. They carry a stable, user-editable DummyID (distinct from the auto
// assigned backend UUID), a title and a heartbeat interval. All connection
// state (Idle/Online/Degraded/Offline) is runtime-only and never persisted.
Schema.push({
  Name: 'DummyClients',
  SQL: 'CREATE TABLE IF NOT EXISTS `DummyClients` ( \
            UUID TEXT PRIMARY KEY, \
            DummyID TEXT NOT NULL UNIQUE, \
            Nickname TEXT, \
            Interval INTEGER NOT NULL DEFAULT 30000, \
            IP TEXT, \
            GroupID INTEGER, \
            Weight INTEGER NOT NULL DEFAULT 100, \
            Timestamp BIGINT(11) NOT NULL \
    )',
});

Schema.push({
  Name: 'AlertRules',
  SQL: 'CREATE TABLE IF NOT EXISTS `AlertRules` ( \
            RuleID INTEGER PRIMARY KEY AUTOINCREMENT, \
            Title TEXT NOT NULL, \
            Scope TEXT NOT NULL, \
            TriggerType TEXT NOT NULL, \
            TriggerConfig TEXT, \
            Actions TEXT NOT NULL, \
            Enabled INTEGER NOT NULL DEFAULT 1, \
            Timestamp BIGINT(11) NOT NULL, \
            UpdatedAt BIGINT(11) NOT NULL \
    )',
});

Schema.push({
  Name: 'AlertHistory',
  SQL: 'CREATE TABLE IF NOT EXISTS `AlertHistory` ( \
            HistoryID INTEGER PRIMARY KEY AUTOINCREMENT, \
            RuleID INTEGER NOT NULL, \
            TriggerType TEXT NOT NULL, \
            TriggerSource TEXT NOT NULL, \
            Context TEXT, \
            Result TEXT, \
            Timestamp BIGINT(11) NOT NULL \
    )',
});

Schema.push({
  Name: 'CriticalUSBDevices',
  SQL: 'CREATE TABLE IF NOT EXISTS `CriticalUSBDevices` ( \
            UUID TEXT NOT NULL, \
            SerialNumber TEXT NOT NULL, \
            ManufacturerName TEXT, \
            ProductName TEXT, \
            Timestamp BIGINT(11) NOT NULL, \
            PRIMARY KEY (UUID, SerialNumber) \
    )',
});

// Serial-less critical USB devices. WebUSB cannot always read a device serial,
// so these devices are guarded by their visible name (Manufacturer + Product)
// and an expected Quantity instead: the client is degraded when fewer than
// Quantity devices matching NameKey are connected. NameKey is the lower-cased
// visible label; ManufacturerName/ProductName are kept for display.
Schema.push({
  Name: 'CriticalUSBDeviceNames',
  SQL: 'CREATE TABLE IF NOT EXISTS `CriticalUSBDeviceNames` ( \
            UUID TEXT NOT NULL, \
            NameKey TEXT NOT NULL, \
            ManufacturerName TEXT, \
            ProductName TEXT, \
            Quantity INTEGER NOT NULL DEFAULT 1, \
            Timestamp BIGINT(11) NOT NULL, \
            PRIMARY KEY (UUID, NameKey) \
    )',
});

Schema.push({
  Name: 'CriticalApplications',
  SQL: 'CREATE TABLE IF NOT EXISTS `CriticalApplications` ( \
            UUID TEXT NOT NULL, \
            ApplicationKey TEXT NOT NULL, \
            ApplicationName TEXT NOT NULL, \
            Timestamp BIGINT(11) NOT NULL, \
            PRIMARY KEY (UUID, ApplicationKey) \
    )',
});

Schema.push({
  Name: 'CriticalDisplays',
  SQL: 'CREATE TABLE IF NOT EXISTS `CriticalDisplays` ( \
            UUID TEXT NOT NULL, \
            DisplayID TEXT NOT NULL, \
            Label TEXT, \
            Width INTEGER, \
            Height INTEGER, \
            RefreshRate INTEGER, \
            ScaleFactor REAL, \
            Timestamp BIGINT(11) NOT NULL, \
            PRIMARY KEY (UUID, DisplayID) \
    )',
});

// Per-show whitelist of which clients/groups may run a given script. Scripts
// themselves live on disk (machine-global), but *who* may run each one is
// show-specific, so it belongs in the DB (and therefore the .ShowTrak file).
// A script with NO row here is unrestricted (all clients) — this is the default
// for every script, and is what lets brand-new clients automatically inherit
// access to any script that has not been explicitly restricted. Scope is the
// same JSON shape as AlertRules.Scope: { Workspace, Groups[], Clients[] }.
Schema.push({
  Name: 'ScriptWhitelists',
  SQL: 'CREATE TABLE IF NOT EXISTS `ScriptWhitelists` ( \
            ScriptID TEXT PRIMARY KEY, \
            Scope TEXT NOT NULL, \
            UpdatedAt BIGINT(11) NOT NULL \
    )',
});

// Versioned migrations for existing installs. Applied versions are recorded in
// the SchemaMigrations table; only versions above the recorded maximum run.
// Installs that predate the version table are back-filled by probing
// PRAGMA table_info before each ALTER (sqlite has no "ADD COLUMN IF NOT
// EXISTS"), so an already-present column records its version without re-running.
// Append new migrations with the next version — never reuse or reorder.
Schema.Migrations = [
  {
    Version: 1,
    SQL: 'ALTER TABLE `MonitoringTargets` ADD COLUMN DegradedThresholdMs INTEGER NOT NULL DEFAULT 0',
  },
  { Version: 2, SQL: 'ALTER TABLE `Clients` ADD COLUMN OperatingSystem TEXT' },
  { Version: 3, SQL: 'ALTER TABLE `DummyClients` ADD COLUMN IP TEXT' },
  { Version: 4, SQL: 'ALTER TABLE `Groups` ADD COLUMN FullWidth INTEGER NOT NULL DEFAULT 1' },
  { Version: 5, SQL: 'ALTER TABLE `Groups` ADD COLUMN KeyBind TEXT' },
  { Version: 6, SQL: 'ALTER TABLE `Clients` ADD COLUMN RunOnLaunchScriptID TEXT' },
  { Version: 7, SQL: 'ALTER TABLE `Clients` ADD COLUMN RunOnLaunchDelaySeconds INTEGER' },
  {
    Version: 8,
    SQL: 'ALTER TABLE `Clients` ADD COLUMN Unassigned INTEGER NOT NULL DEFAULT 0',
  },
  // Indexes for the non-PK lookups the app runs repeatedly. CREATE INDEX IF NOT
  // EXISTS is idempotent (and the migration runner only ALTER-probes; anything
  // else just runs), so these apply cleanly to both new and existing installs.
  {
    Version: 9,
    SQL: 'CREATE INDEX IF NOT EXISTS idx_clients_groupid ON `Clients` (GroupID)',
  },
  {
    Version: 10,
    SQL: 'CREATE INDEX IF NOT EXISTS idx_monitoringchecks_targetid ON `MonitoringChecks` (TargetID)',
  },
  {
    Version: 11,
    SQL: 'CREATE INDEX IF NOT EXISTS idx_alerthistory_ruleid ON `AlertHistory` (RuleID)',
  },
  {
    Version: 12,
    SQL: 'CREATE INDEX IF NOT EXISTS idx_alerthistory_timestamp ON `AlertHistory` (Timestamp)',
  },
  // Slugs: stable, human-friendly, OSC-addressable identifiers. Real clients,
  // monitoring targets and groups gain a Slug column; dummy clients reuse their
  // existing DummyID as their slug. Columns are added nullable and back-filled
  // with generated unique values on first boot (see SlugBackfill); the NOCASE
  // unique indexes are the in-table safety net (the shared client namespace that
  // also spans DummyClients is enforced in the Slug service).
  { Version: 13, SQL: 'ALTER TABLE `Clients` ADD COLUMN Slug TEXT' },
  { Version: 14, SQL: 'ALTER TABLE `MonitoringTargets` ADD COLUMN Slug TEXT' },
  { Version: 15, SQL: 'ALTER TABLE `Groups` ADD COLUMN Slug TEXT' },
  {
    Version: 16,
    SQL: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_slug ON `Clients` (Slug COLLATE NOCASE)',
  },
  {
    Version: 17,
    SQL: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_monitoringtargets_slug ON `MonitoringTargets` (Slug COLLATE NOCASE)',
  },
  {
    Version: 18,
    SQL: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_slug ON `Groups` (Slug COLLATE NOCASE)',
  },
];

export = Schema;
