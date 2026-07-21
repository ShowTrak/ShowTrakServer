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

// Tags are cross-cutting, colour+icon labelled collections of clients that
// overlap freely (unlike Groups, where a client belongs to exactly one). The
// Slug doubles as the tag's display label. Colour is an integer index into the
// shared Scripts colour palette; Icon is a bare Bootstrap Icons name. Membership
// is dynamic: Scope is the same JSON shape as AlertRules.Scope /
// ScriptWhitelists.Scope ({ Workspace, Groups[], Clients[] }), so tagging a group
// carries the tag to its current and future members.
Schema.push({
  Name: 'Tags',
  SQL: 'CREATE TABLE IF NOT EXISTS `Tags` ( \
            TagID INTEGER PRIMARY KEY AUTOINCREMENT, \
            Slug TEXT, \
            Colour INTEGER NOT NULL DEFAULT 6, \
            Icon TEXT NOT NULL DEFAULT \'tag\', \
            Scope TEXT NOT NULL DEFAULT \'{"Workspace":false,"Groups":[],"Clients":[]}\', \
            Weight INTEGER NOT NULL DEFAULT 100 \
    )',
});

// Every MAC address a client is known by, one row per address. A machine with
// several external NICs (wired + wireless, or multiple VLANs) has several, and
// Wake-on-LAN fans a magic packet out to all of them — which NIC is reachable
// depends on where the server sits, so guessing one is unreliable.
//
// Superseded `Clients.MacAddress`, which held only the MAC of the interface
// serving the active socket IP. That column is still written as the "primary"
// (most recently active) MAC for display and back-compat; this table is the
// source of truth for waking.
//
// Source records how an address arrived: 'Reported' from the client's own NIC
// enumeration, 'Manual' from an operator typing it into the client editor. Both
// are woken identically — Source exists so the UI can label them and so a
// hand-entered MAC for a machine that has never connected is not mistaken for
// observed data. Reported addresses re-appear on the next report if deleted;
// that is deliberate (deletion is for retiring MACs the client no longer has).
//
// MacAddress is stored normalized to upper-case colon-separated form so the
// (UUID, MacAddress) primary key de-duplicates regardless of input formatting.
Schema.push({
  Name: 'ClientMacAddresses',
  SQL: "CREATE TABLE IF NOT EXISTS `ClientMacAddresses` ( \
            UUID TEXT NOT NULL, \
            MacAddress TEXT NOT NULL, \
            Source TEXT NOT NULL DEFAULT 'Reported', \
            InterfaceName TEXT, \
            FirstSeen BIGINT(11) NOT NULL DEFAULT 0, \
            LastSeen BIGINT(11) NOT NULL DEFAULT 0, \
            PRIMARY KEY (UUID, MacAddress) \
    )",
});

// FOG Project integration. All FOG state lives in its own tables rather than as
// columns on Clients, so the integration can be enabled, disabled or removed
// wholesale without touching core client data.
//
// FogHosts links a ShowTrak client to a FOG host. One row per client (UUID is the
// PK), so a client maps to at most one FOG host. FogHostName is cached at link time
// purely so the client editor can still show which host is linked when the FOG
// server is unreachable.
Schema.push({
  Name: 'FogHosts',
  SQL: 'CREATE TABLE IF NOT EXISTS `FogHosts` ( \
            UUID TEXT PRIMARY KEY, \
            FogHostID INTEGER NOT NULL, \
            FogHostName TEXT, \
            Timestamp BIGINT(11) NOT NULL DEFAULT 0 \
    )',
});

// FogTasks records tasks ShowTrak scheduled, and is reconciled against
// /fog/task/active by the poller.
//
// FogTaskID is nullable by necessity: FOG's task creation endpoint returns the
// literal body `null` and does not hand back an ID, so a freshly scheduled task has
// no FOG-side identifier until the next poll matches it up by host. Rows are kept
// after completion so the panel can show recently-finished tasks, and are pruned by
// age rather than on completion.
Schema.push({
  Name: 'FogTasks',
  SQL: 'CREATE TABLE IF NOT EXISTS `FogTasks` ( \
            FogTaskRecordID INTEGER PRIMARY KEY AUTOINCREMENT, \
            UUID TEXT, \
            FogHostID INTEGER NOT NULL, \
            FogHostName TEXT, \
            FogTaskID INTEGER, \
            TaskTypeID INTEGER NOT NULL, \
            TaskTypeName TEXT, \
            StateID INTEGER NOT NULL DEFAULT 0, \
            Percent TEXT, \
            LastError TEXT, \
            CreatedAt BIGINT(11) NOT NULL DEFAULT 0, \
            UpdatedAt BIGINT(11) NOT NULL DEFAULT 0 \
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
  // Tags: a new sluggable entity type in its own `tags` namespace. The NOCASE
  // unique index is the in-table safety net; app-level uniqueness lives in the
  // Slug service. The Tags table itself is created by the Schema block above on
  // both new and existing installs.
  {
    Version: 19,
    SQL: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_slug ON `Tags` (Slug COLLATE NOCASE)',
  },
  // FOG integration lookups. The tables themselves are created by the Schema blocks
  // above on both new and existing installs; only the indexes need versioning.
  // FogHosts is indexed on FogHostID for the reverse lookup the task poller does
  // (FOG reports tasks by host ID, and we need the owning ShowTrak client).
  {
    Version: 20,
    SQL: 'CREATE INDEX IF NOT EXISTS idx_foghosts_foghostid ON `FogHosts` (FogHostID)',
  },
  {
    Version: 21,
    SQL: 'CREATE INDEX IF NOT EXISTS idx_fogtasks_foghostid ON `FogTasks` (FogHostID)',
  },
  {
    Version: 22,
    SQL: 'CREATE INDEX IF NOT EXISTS idx_fogtasks_uuid ON `FogTasks` (UUID)',
  },
  // Multi-MAC support. The ClientMacAddresses table itself is created by the
  // Schema block above on both new and existing installs; only the index and the
  // back-fill need versioning. The back-fill seeds the new table from the single
  // MAC each client already carried, so upgrading installs keep waking the
  // machines they could wake before. INSERT OR IGNORE makes it a no-op on
  // re-run, and the UPPER/empty guards mirror the normalization the app applies.
  {
    Version: 23,
    SQL: 'CREATE INDEX IF NOT EXISTS idx_clientmacaddresses_uuid ON `ClientMacAddresses` (UUID)',
  },
  {
    Version: 24,
    SQL: "INSERT OR IGNORE INTO `ClientMacAddresses` (UUID, MacAddress, Source, InterfaceName, FirstSeen, LastSeen) \
          SELECT UUID, UPPER(REPLACE(MacAddress, '-', ':')), 'Reported', NULL, Timestamp, Timestamp \
          FROM `Clients` WHERE MacAddress IS NOT NULL AND TRIM(MacAddress) != ''",
  },
];

export = Schema;
