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

## What This Project Is

ShowTrak Server is the desktop control plane for ShowTrak. It is an Electron app that runs on an operator machine and manages many ShowTrak Client nodes on a local network.

Core outcomes:

- Observe machine status in near real time
- Adopt and organize clients by group
- Execute scripted actions across single or bulk targets
- Monitor service/network endpoints (ping, HTTP(S), DNS, TCP)
- Trigger alert actions from rule-based events
- Control systems through OSC and Wake-on-LAN
- Expose a browser-based companion Web UI for remote dashboards and actions

Companion client agent repository: <a href="https://github.com/ShowTrak/ShowTrakClient"><strong>ShowTrak Client</strong></a>

## Scope Overview

ShowTrak Server includes all of the following in a single app/runtime:

- Desktop UI (Electron renderer in `src/UI`)
- Main process orchestration and IPC bridge (`src/main.js`, `src/bridge_main.js`)
- Client socket server and Web UI socket namespace (`src/Modules/Server`)
- Persistent local data (SQLite + show file workflow)
- Monitoring targets and history
- Alerting engine + pluggable action handlers
- Script catalog + execution queue
- Network discovery and adoption flows
- Auto-update hooks for packaged desktop builds

## Key Features

### Device and Group Management

- Client adoption queue for unmanaged devices
- Full client list sync and update broadcasts
- Group creation, deletion, and ordering
- Per-client updates and unadopt workflow

### Monitoring

- Built-in monitor methods:
  - ICMP ping
  - TCP port probe
  - HTTP probe
  - HTTPS probe
  - HTTP JSON check
  - DNS check
- Monitoring target CRUD and live status updates
- Monitoring history collection and retrieval APIs

### Alerts and Actions

- Rule-based triggers:
  - Client/target offline
  - Client/target online
  - Degraded state
  - Script execution failure
- Action transports:
  - Discord webhook
  - HTTP API call
  - OSC trigger
- Alert history persistence and live "AlertTriggered" broadcast events

### Scripts and Automation

- Script library management (upload/update/delete)
- Targeted or bulk execution dispatch
- Queue tracking for execution status and visibility
- Optional Web UI remote execution gate via settings

### Web UI (Browser Access)

- Hosted directly by ShowTrak Server at `/`
- Socket namespace dedicated to browser clients
- Optional passcode protection
- Session token auth (in-memory)
- Mobile-friendly dashboard view for clients/monitors
- Optional remote run actions (scripts/WOL), disabled by default

### Show File Workflow

- `New`, `Open`, `Save`, `Save As` lifecycle for show state
- `.ShowTrak` file acts as a complete SQLite snapshot
- Autosave support to currently open show file
- Missing file recovery checks at startup

### Platform and Packaging

- Electron Forge based development and packaging
- Makers configured for:
  - Windows (Squirrel)
  - macOS (ZIP)
  - Linux (ZIP, DEB, RPM)
- Optional macOS signing and notarization through environment variables

## Tech Stack

[![Electron][Electronjs.org]][Electron-url] [![Bootstrap][Bootstrap.com]][Bootstrap-url] [![JQuery][JQuery.com]][JQuery-url]

Additional runtime components include Socket.IO, Express, SQLite, node-osc, wakeonlan, and electron-updater.

## Requirements

- Node.js 20+ recommended (CI uses Node 20)
- npm
- macOS, Windows, or Linux

## Installation (End Users)

1. Download the latest package from GitHub Releases.
2. Install and launch ShowTrak Server.
3. Install ShowTrak Client on target devices.
4. Ensure operator and clients can reach each other over LAN.

## Local Development

```bash
npm ci
npm run start
```

### Useful Scripts

```bash
# Run app in development
npm run start

# Build distributables for current platform
npm run make

# Package without makers
npm run package

# Run test suite
npm run test

# Run tests with coverage report
npm run test:coverage

# Lint
npm run lint

# Auto-fix lint issues
npm run lint:fix

# Format repository
npm run format

# Check formatting only
npm run format:check
```

## Networking and Runtime Notes

- Main server/socket port defaults to `3000`.
- The app hosts:
  - client script/static assets
  - Web UI static assets
  - Socket.IO namespaces for clients and browser UI
- Wake-on-LAN and remote Web UI actions are setting-gated features.

## Data and Storage

Application data root:

- Windows: `%APPDATA%/ShowTrakServer`
- macOS: `~/Library/Application Support/ShowTrakServer`
- Linux: `$XDG_DATA_HOME/ShowTrakServer` or `~/.local/share/ShowTrakServer`

Inside app data:

- `Logs/`
- `Scripts/`
- `Storage/` (runtime DB storage)
- `state.json` (current open show file pointer)

## Security Model (Desktop)

- Electron renderer isolation enabled
- Node integration disabled in renderer
- Sandboxed renderer
- Navigation/window-open guards for external URLs
- IPC bridge allowlists exposed channels (`window.API`)

## Build and Release Workflow

GitHub Actions workflow:

- `.github/workflows/build-and-draft-release.yml`

What it does:

- Builds on Ubuntu, macOS, and Windows
- Supports macOS variants:
  - unsigned
  - signed
  - signed + notarized
- Uploads build artifacts
- Optionally creates/updates a draft GitHub release
- Generates `latest-mac.yml` for macOS auto-update metadata

### macOS Signing/Notarization Environment Variables

Used by packaging and CI when signing/notarization is enabled:

- `APPLE_SIGN_IDENTITY`
- `APPLE_KEYCHAIN_PATH`
- `APPLE_API_KEY_PATH`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER_ID`

## Repository Layout

- `src/main.js` - Electron main process and lifecycle orchestration
- `src/bridge_main.js` - preload bridge and IPC channel allowlists
- `src/UI/` - desktop renderer UI
- `src/WebUI/` - browser-based companion UI
- `src/Modules/` - domain modules and infrastructure
- `test/` - Node test runner suite for managers, integrations, and behavior
- `forge.config.js` - Electron Forge packaging/maker/signing configuration

## Support

- Discord: [ShowTrak Discord](https://discord.gg/DACmwsbSGW)
- Issues: [GitHub Issues](https://github.com/ShowTrak/ShowTrakServer/issues)

## License

Licensed under AGPL-3.0-only. See [LICENSE](LICENSE).

[Electronjs.org]: https://img.shields.io/badge/Electron-563D7C?style=for-the-badge&logo=electron&logoColor=white
[Electron-url]: https://www.electronjs.org/
[Bootstrap.com]: https://img.shields.io/badge/Bootstrap-563D7C?style=for-the-badge&logo=bootstrap&logoColor=white
[Bootstrap-url]: https://getbootstrap.com
[JQuery.com]: https://img.shields.io/badge/jQuery-0769AD?style=for-the-badge&logo=jquery&logoColor=white
[JQuery-url]: https://jquery.com
