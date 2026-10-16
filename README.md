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

- Observe machine status in near real time: vitals, hardware, applications, power and temperatures
- Adopt and organize clients by group and tag
- Execute scripted actions across single or bulk targets
- Monitor show devices and services (network probes, show control, lighting, video, audio, UPS, projectors)
- Trigger alert actions from rule-based events
- Control systems through OSC and Wake-on-LAN
- Expose a browser-based companion Web UI for remote dashboards and actions

Companion client agent repository: <a href="https://github.com/ShowTrak/ShowTrakClient"><strong>ShowTrak Client</strong></a>

## Scope Overview

ShowTrak Server includes all of the following in a single app/runtime:

- Desktop UI (Electron renderer in `src/UI`)
- Main process orchestration and IPC bridge (`src/main.ts`, `src/bridge_main.ts`)
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

### Client Monitoring

Each ShowTrak Client reports, and the server judges:

- **Vitals:** CPU and memory usage (every second), operating-system uptime and
  boot time. On macOS, memory reads as Activity Monitor's "Memory Used" from
  client 3.27.0.
- **Hardware:** USB devices (port, firmware, Windows device errors), displays
  (mode, rotation, position, primary), audio endpoints (format, default, level,
  mute) and network interfaces (addresses, router).
- **Applications:** what is running, which instances are hung ("Not
  Responding", Windows only), and which application holds the foreground
  (Windows, macOS, and Linux with `xdotool` on X11).
- **Power:** battery charge, mains or battery power, and sleep/wake.
- **Temperatures:** CPU/GPU/system sensors where the platform exposes them
  (Windows via LibreHardwareMonitor/OpenHardwareMonitor or ACPI thermal zones,
  Linux via sysfs, NVIDIA GPUs via `nvidia-smi`), and macOS thermal pressure.

Anything a platform cannot report is shown as "not available on <OS>" rather
than treated as a fault, and clients older than 3.27.0 are told which version
they need.

A client reads **degraded** when any of the following holds:

- a monitored item breaks one of its conditions: a USB device, display, audio
  endpoint, network interface or application. Monitored applications can also be
  required to stay responding and to hold the foreground.
- a threshold is breached:
  - CPU or memory usage stays at or above its threshold for the sustain time
    (default 90% for 60 s);
  - the hottest sensor reaches the temperature threshold (default 85 °C), or
    macOS reports thermal throttling;
  - the battery falls to the low-battery threshold (default 20%) while
    discharging.

Every threshold is set server-wide in Preferences → Monitoring. CPU, memory and
temperature can also be overridden per client in the client editor, where "Off"
turns that check off for one machine.

### Monitoring Targets

- Monitor methods for non-ShowTrak devices:
  - Network: ICMP ping, TCP port, HTTP, HTTPS, HTTP JSON, DNS, MQTT topic
  - Show control: QLab 4/5, ETC Eos, grandMA2/MA3, Avolites Titan, ChamSys
    MagicQ, Bitfocus Companion
  - Video and media: Resolume, Millumin, Watchout, disguise, BrightSign, NDI
    sources
  - Lighting and audio networks: sACN universes (and priority), Art-Net
    universes, Dante devices
  - Power and projection: NUT and SNMP UPS, PJLink, SNMP projectors
- Monitoring target CRUD and live status updates
- Check actions: methods that can control their device (PJLink projector power,
  shutter, input) expose buttons in the monitor view, starred favourites in the
  right-click menu, and `/API/Monitor/<slug>/<method>/<action>` over OSC and HTTP

### History

- Status timelines for clients, monitoring checks, dummy clients and every
  monitored item, shown as the last hour in the view modal
- Nothing is kept for more than 12 hours: status timelines, FreeKiosk metric
  history, alert history, finished script executions, finished FOG tasks and the
  in-app alerts tray all age out, including entries for clients that have gone
  offline
- A steady signal is stored as about one reading every 15 seconds rather than
  one per heartbeat; any change of state is recorded the moment it happens

### Alerts and Actions

Alert rules are scoped to the workspace, groups, tags or individual clients,
and fire on any of their selected triggers:

- **Status:** online, offline, degraded, recovered (after an announced degraded
  alert), restarted, client version changed, going to sleep, woke from sleep
- **Resources & power:** CPU usage high, memory usage high, temperature high,
  battery low, running on battery, mains power restored
- **Applications:** started/stopped (any, monitored, unmonitored), not responding
  (any, monitored), responding again, monitored application running more than
  once, foreground application changed, monitored application lost the foreground
- **Displays:** connected/disconnected (any, monitored), configuration changed
- **Network:** interface up, interface down (any, monitored), address changed,
  router changed
- **USB:** connected/disconnected (any, monitored, unmonitored), moved to another
  port, firmware changed, device error
- **Audio:** connected/disconnected (any, monitored, unmonitored), default device
  changed, muted, format changed, level out of range
- **Scripts & kiosks:** script execution failure, FreeKiosk metric alarm

Restarts are quiet: a fault already present when the server starts is held for
a settle period (3 minutes) and announced once only if it is still present.
Threshold alarms and hung applications follow the same rule.

Action transports:

- In-app alert and toast
- Built-in alert sound or custom uploaded audio
- OSC message (path templated with the trigger, entity, severity and IP)
- HTTP(S) request
- Discord, Slack and Microsoft Teams webhooks
- Telegram bot

Alert history is stored in the show database (12 hours, capped at 10,000 rows),
and a live `AlertTriggered` event is broadcast.

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

- Node.js 24+ (CI uses Node 24)
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

`npm run start` now runs with file watching and automatic rebuild/restart.
You can also type `rs` in the terminal to force a manual restart.

### Useful Scripts

```bash
# Run app in development
npm run start

# Build distributables for current platform
npm run make

# Run test suite (builds first, then runs all tests against an empty
# sandboxed app-data directory, never your real show data)
npm run test

# Run one test file
npm test -- test/db.test.js

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

- `src/main.ts` - Electron main process and lifecycle orchestration
- `src/main/` - main-process wiring: broadcast bridge, history stores, retention sweep, IPC registrars
- `src/bridge_main.ts` - preload bridge and IPC channel allowlists
- `shared/` - `@showtrak/protocol`, the wire types shared with ShowTrak Client (git submodule)
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
