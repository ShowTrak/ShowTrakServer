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

// Idempotent column additions for existing installs. Errors are ignored when
// the column already exists; sqlite has no native "ADD COLUMN IF NOT EXISTS".
Schema.Migrations = [
  'ALTER TABLE `MonitoringTargets` ADD COLUMN DegradedThresholdMs INTEGER NOT NULL DEFAULT 0',
];

module.exports = Schema;
