# Architecture

ShowTrak Server is an Electron app composed of a main process, a renderer (UI), and a set of modular managers that coordinate storage, network I/O, and business logic.

- Main process: `src/main.js`
  - Creates windows (preloader + main), wires IPC handlers, starts Bonjour discovery, initializes modules, and propagates events to the UI.
  - Uses the SettingsManager to enable optional features like powerSaveBlocker and auto-update.
- Renderer: `src/UI` (Bootstrap + jQuery)
  - Interacts with the main process via a safe preload bridge (`src/bridge_main.js`), exposed under `window.API`.
  - Renders clients, groups, settings, adoption, script execution queue, and notifications.
- Modules: `src/Modules/*`
  - Self-contained managers using an in-memory cache + SQLite persistence + EventEmitter (`Broadcast`) for cross-module events.

Key flows

1) Client lifecycle
- Clients connect to the built-in Socket.IO server (`Modules/Server`) with a UUID and Adopted flag.
- New, unadopted clients send AdoptionHeartbeat and appear in the Adoption Manager list.
- Once adopted, clients send Heartbeat + SystemInfo + USB events to keep their status up to date.
- UI listens for `ClientUpdated`, `ClientListChanged`, `USBDevice*` events.

2) Scripts
- Scripts are folders under AppData/Scripts, each with a Script.json and files.
- Server calculates file checksums and exposes a list to clients.
- Execution queue is managed by `ScriptExecutionManager`, with timeouts and progress broadcast to UI.

3) Settings
- Default settings are defined in `SettingsManager/DefaultSettings.js` and stored/overridden in SQLite.
- Changes are persisted and broadcast via `Broadcast` to update the UI and trigger optional behaviors.

4) Discovery and control
- Bonjour advertises the server presence (service type `ShowTrak`).
- OSC server listens on UDP port 3333 for simple remote control actions (select clients, run scripts, WOL).

5) Storage
- AppData paths: `%APPDATA%/ShowTrakServer` (Windows) or platform equivalents.
- Subfolders: `Logs`, `Scripts`, `Storage` (SQLite DB lives under `Storage/DB.sqlite`).

See the other docs for deeper dives.
