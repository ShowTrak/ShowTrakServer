# Storage and database

App data paths
- Base path: `%APPDATA%/ShowTrakServer` on Windows, platform equivalents elsewhere.
- Subfolders created at first run:
  - Logs
  - Scripts
  - Storage

Database
- SQLite database at `Storage/DB.sqlite`.
- Initialized via `src/Modules/DB/schema.js` with tables:
  - Groups(GroupID INTEGER PK, Title TEXT, Weight INTEGER)
  - Clients(UUID TEXT PK, Nickname TEXT, Hostname TEXT, MacAddress TEXT, GroupID INTEGER, Weight INTEGER, Version TEXT, IP TEXT, Timestamp BIGINT)
  - Settings(Key TEXT PK, Value BLOB)

Backups
- Export merges Groups and Clients into a single `.ShowTrakConfig` JSON file via the Backup Manager.
- Import wipes existing Groups and Clients tables, then repopulates from the file and triggers a UI reinit.
- Access these from the UI: Settings -> Backup/Restore.

Logs
- Daily rotating file under `Logs/ShowTrakServer-YYYY-MM-DD.log`.
- See console output in dev; production also writes to file unless in Squirrel install phase.
