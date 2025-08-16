# Modules and events

All modules live under `src/Modules`. Most export a `Manager` with functions and emit events on a shared EventEmitter (`Broadcast`).

Core modules

- AppData (`AppData/`)
  - Initializes per-user directories and exposes getters: `GetLogsDirectory`, `GetScriptsDirectory`, `GetStorageDirectory`.
- DB (`DB/`)
  - SQLite wrapper; auto-initializes schema from `DB/schema.js` with tables: Groups, Clients, Settings.
  - API: `Get(query, params)`, `All(query, params)`, `Run(query, params)`.
- Logger (`Logger/`)
  - Colored console + daily file logs under Logs/ with levels, async writes, and retention cleanup.
  - `CreateLogger(alias)` returns a class with `log, info, warn, error, success, debug, trace, database, databaseError, silent`.
  - Env vars: `LOG_LEVEL` (error|warn|info|debug|trace), `LOG_TO_CONSOLE=true|false`, `LOG_TO_FILE=true|false`, `LOG_RETENTION_DAYS=30`.
- Broadcast (`Broadcast/`)
  - `new EventEmitter()` used for cross-module events.

Domain managers

- ClientManager
  - In-memory list + persistence of Clients.
  - Public: `Heartbeat(UUID, Data, IP)`, `SystemInfo(UUID, Data, IP)`, `Get(UUID)`, `GetAll()`, `Create(UUID)`, `Delete(UUID)`, `Update(UUID, { Nickname, GroupID })`, `Exists(UUID)`, `GetClientsInGroup(GroupID)`, `ClearCache()`.
  - Emits: `ClientUpdated`, `ClientListChanged`, `USBDeviceAdded`, `USBDeviceRemoved`, `Notify` (via Settings toggles).
- GroupManager
  - CRUD for groups; reassigns clients when deleting a group.
  - Emits: `GroupListChanged`.
- AdoptionManager
  - Tracks devices pending adoption (`AddClientPendingAdoption`, `RemoveClientPendingAdoption`, `SetState`), clears list.
  - Emits: `AdoptionListUpdated`, `ReadoptDevice`.
- Server (Socket.IO)
  - Receives client connections, relays messages, and pushes execution requests.
  - API: `ExecuteScripts(ScriptID, Targets, ResetList)`, `ExecuteBulkRequest(Action, Targets, ReadableName)`, `SendMessageByGroup(Group, Message, Data)`.
- ScriptManager
  - Discovers scripts from AppData Scripts folder, reads Script.json, computes checksums, exposes list.
  - API: `GetScripts()`, `Get(ID)`.
- ScriptExecutionManager
  - Tracks queue of executions: `AddToQueue(UUID, ScriptID)`, `AddInternalTaskToQueue(UUID, Name)`, `Complete(RequestID, Err)`, `ClearQueue()`.
  - Emits: `ScriptExecutionUpdated` with full queue.
- SettingsManager
  - Loads defaults + DB values, provides `GetAll()`, `GetValue(key)`, `Set(key, value)`, `GetGroups()`.
  - Emits: `SettingsUpdated` and any `OnUpdateEvent` from defaults.
- Bonjour
  - Publishes service with server metadata on `Config.Application.Port`.
- WOLManager
  - Sends magic packets.
- OSC
  - UDP server on port 3333. See docs/osc.md.
- FileSelectorManager
  - Wraps Electron dialogs for backup/export/import.

Events consumed by UI

- `SettingsUpdated` -> update settings and groups
- `AdoptionListUpdated` -> refresh pending devices list
- `ClientListChanged` -> rebuild client tiles
- `ClientUpdated` -> update a tile’s online/vitals fields
- `ScriptExecutionUpdated` -> refresh execution queue
- `Notify` -> toast in UI; `PlaySound` -> howler plays sfx
- `OSCBulkAction` -> renderer applies selection/actions
- `Shutdown` -> app quitting
