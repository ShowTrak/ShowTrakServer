# IPC and renderer API

The renderer uses a safe preload bridge to call into the main process. The bridge is defined in `src/bridge_main.js` and exposes functions on `window.API`.

Renderer API (window.API)

- OpenDiscordInviteLinkInBrowser()
- GetConfig() -> Config object
- GetSettings() -> array of settings
- AdoptDevice(UUID)
- CheckForUpdatesOnClient(UUID)
- Loaded()
- Shutdown()
- GetClient(UUID)
- GetAllGroups()
- CreateGroup(Title)
- DeleteGroup(GroupID)
- OpenLogsFolder()
- OpenScriptsFolder()
- BackupConfig()
- ImportConfig()
- OSCBulkAction(callback)
- PlaySound(callback)
- Notify(callback)
- SetOSCList(callback)
- SetDevicesPendingAdoption(callback)
- SetFullClientList(callback)
- SetScriptList(callback)
- ClientUpdated(callback)
- UpdateScriptExecutions(callback)
- ShutdownRequested(callback)
- USBDeviceAdded(callback)
- USBDeviceRemoved(callback)
- UpdateSettings(callback)
- SetSetting(Key, Value)
- WakeOnLan(TargetUUIDs[])
- UpdateClient(UUID, Data)
- ExecuteScript(ScriptID, Targets[], ResetList)
- UnadoptClient(UUID)
- DeleteScripts(List)
- UpdateScripts(List)
// Application Mode
- GetMode() -> 'SHOW' | 'EDIT'
- SetMode(Mode: 'SHOW' | 'EDIT') -> 'SHOW' | 'EDIT'
- OnModeUpdated(callback) -> subscribes to mode changes

IPC channels (main handlers)
- See `src/main.js` for the matching `RPC.handle(...)` registrations.
Additional Mode channels
- "Mode:Get" -> returns current mode ('SHOW' | 'EDIT')
- "Mode:Set" (Mode: 'SHOW' | 'EDIT') -> sets and returns the new mode; broadcasts "ModeUpdated"

Notes
- Callbacks subscribe to push events (renderer listens via `ipcRenderer.on`).
- Use `API.Loaded()` on UI init so the main process can push initial data.
