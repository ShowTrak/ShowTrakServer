const Schema = [];

Schema.push({
	Name: "Groups",
	SQL: "CREATE TABLE IF NOT EXISTS `Groups` ( \
        GroupID INTEGER PRIMARY KEY AUTOINCREMENT, \
        Title TEXT, \
        Weight INTEGER \
    )",
});

Schema.push({
	Name: "Clients",
	SQL: "CREATE TABLE IF NOT EXISTS `Clients` ( \
            UUID TEXT PRIMARY KEY, \
            Nickname TEXT, \
            Hostname TEXT, \
            MacAddress TEXT, \
            GroupID INTEGER, \
            Weight INTEGER NOT NULL DEFAULT 100, \
            Version TEXT, \
            IP TEXT, \
            Timestamp BIGINT(11) NOT NULL \
    )",
});

Schema.push({
	Name: "Settings",
	SQL: "CREATE TABLE IF NOT EXISTS `Settings` ( \
            Key TEXT PRIMARY KEY, \
            Value BLOB \
    )",
});

module.exports = Schema;
