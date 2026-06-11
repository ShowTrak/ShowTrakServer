const Schema = [];

Schema.push({
  Name: 'Groups',
  SQL: 'CREATE TABLE IF NOT EXISTS `Groups` ( \
        GroupID INTEGER PRIMARY KEY AUTOINCREMENT, \
        Title TEXT, \
        Weight INTEGER \
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
            StoreHistory INTEGER NOT NULL DEFAULT 0, \
            Settings TEXT, \
            GroupID INTEGER, \
            Weight INTEGER NOT NULL DEFAULT 100, \
            LastSuccessAt BIGINT(11), \
            DegradedThresholdMs INTEGER NOT NULL DEFAULT 0, \
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

// Idempotent column additions for existing installs. Errors are ignored when
// the column already exists; sqlite has no native "ADD COLUMN IF NOT EXISTS".
Schema.Migrations = [
  'ALTER TABLE `MonitoringTargets` ADD COLUMN DegradedThresholdMs INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE `Clients` ADD COLUMN OperatingSystem TEXT',
];

module.exports = Schema;
