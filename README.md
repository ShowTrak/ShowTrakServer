<br />
<div align="center">

<a href="https://github.com/ShowTrak/ShowTrakServer">
    <img src="https://tkw.bz/img/ShowTrak.png" alt="Logo" width="120" height="120">
</a>

<h3 align="center">ShowTrak Server</h3>
  <p align="center">
    Simple, Free LAN PC Monitoring for arcade style environments.
    <br />
    <a href="https://github.com/ShowTrak/ShowTrakClient"><strong>View ShowTrak Client (Related Project) »</strong></a>
    <br />
    <br />
    <a href="https://github.com/ShowTrak/ShowTrakServer/issues/new?labels=bug&template=bug-report---.md">Report Bug</a>
    &middot;
    <a href="https://github.com/ShowTrak/ShowTrakServer/issues/new?labels=enhancement&template=feature-request---.md">Request Feature</a>
  </p>
</div>

## About The Project

ShowTrak Server is an Electron application that lets you monitor and manage Windows PCs on your LAN, designed for arcade-style environments. It pairs with the ShowTrak Client and provides:

- Realtime presence and vitals for clients (CPU, RAM, uptime)
- Easy adoption workflow for new clients on the network
- Grouping, nicknaming, and management actions
- Script distribution and execution with progress/status queue
- Wake-on-LAN, USB connect/disconnect notifications, and OSC control

This repository contains the server UI and runtime. The companion agent runs on each client machine here: <a href="https://github.com/ShowTrak/ShowTrakClient"><strong>ShowTrak Client</strong></a>.

## Support

Join our [Discord Server](https://discord.gg/DACmwsbSGW) for support

### Built With

[![Electron][Electronjs.org]][Electron-url] [![Bootstrap][Bootstrap.com]][Bootstrap-url]
[![JQuery][JQuery.com]][JQuery-url]

## Getting Started

The following instructions are for installing ShowTrak Server, To install the Client monitoring application please visit [ShowTrak Client](https://github.com/ShowTrak/ShowTrakClient)

### Installation

1. Download the installer from the releases page
2. Run the installer.

### Development (build from source)

Prerequisites:
- Node.js 18+ and npm
- Windows, macOS, or Linux (Windows recommended for production packaging)

Steps:
1. Clone this repo and install dependencies.
2. Start the Electron app using Electron Forge.

Try it:

```powershell
npm install
npm run start
```

Packaging installers (optional):

```powershell
npm run make
```

Lint:

```powershell
npm run lint
```

### Project structure (high level)

- `src/main.js` – Electron main process and app lifecycle
- `src/bridge_main.js` – Preload bridge exposing IPC-backed APIs to the renderer
- `src/UI/` – Renderer UI (Bootstrap/jQuery)
- `src/Modules/` – Server modules (data, network, business logic)
  - `Server/` – Socket.IO server for client connections
  - `ClientManager/`, `GroupManager/`, `AdoptionManager/` – core domain managers
  - `SettingsManager/`, `DB/`, `AppData/` – settings, SQLite, and app data paths
  - `ScriptManager/`, `ScriptExecutionManager/` – script distribution and queue
  - `Bonjour/`, `OSC/`, `WOLManager/` – discovery, control, and wake-on-LAN

See the docs below for details.

## Documentation

- Architecture: docs/architecture.md
- Modules and events: docs/modules.md
- Settings reference: docs/settings.md
- OSC routes: docs/osc.md
- Scripts: folder layout and Script.json: docs/scripts.md
- Storage and database schema: docs/storage.md
- Renderer IPC API (window.API) and channels: docs/ipc.md

[Electronjs.org]: https://img.shields.io/badge/Electron-563D7C?style=for-the-badge&logo=electron&logoColor=white
[Electron-url]: https://www.electronjs.org/
[Bootstrap.com]: https://img.shields.io/badge/Bootstrap-563D7C?style=for-the-badge&logo=bootstrap&logoColor=white
[Bootstrap-url]: https://getbootstrap.com
[JQuery.com]: https://img.shields.io/badge/jQuery-0769AD?style=for-the-badge&logo=jquery&logoColor=white
[JQuery-url]: https://jquery.com
