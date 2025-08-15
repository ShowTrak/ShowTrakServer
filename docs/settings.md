# Settings reference

Settings are defined in `src/Modules/SettingsManager/DefaultSettings.js` and persisted in SQLite (`Settings` table). The UI groups them by `Group` and toggles values via IPC.

Groups
- Notifications
- Features
- System

Keys

- NOTIFIY_ON_USB_DEVICE_CONNECT (Notifications)
  - Type: BOOLEAN, Default: true
  - Sends toast on USB connect; may also play sound if AUDIO_* is enabled.
- AUDIO_ON_USB_DEVICE_CONNECT (Notifications)
  - Type: BOOLEAN, Default: true
  - Plays Notification sound on USB connect.
- NOTIFIY_ON_USB_DEVICE_DISCONNECT (Notifications)
  - Type: BOOLEAN, Default: true
  - Sends toast on USB disconnect.
- AUDIO_ON_USB_DEVICE_DISCONNECT (Notifications)
  - Type: BOOLEAN, Default: true
  - Plays Warning sound on USB disconnect.
- SYSTEM_ALLOW_WOL (Features)
  - Type: BOOLEAN, Default: true
  - Enables Wake on LAN actions.
- SYSTEM_ALLOW_SCRIPT_EDITS (Features)
  - Type: BOOLEAN, Default: true
  - Allows uploading/updating scripts to clients.
- SYSTEM_PREVENT_DISPLAY_SLEEP (System)
  - Type: BOOLEAN, Default: true
  - Uses Electron `powerSaveBlocker` to prevent sleep.
- SYSTEM_CONFIRM_SHUTDOWN_ON_ALT_F4 (System)
  - Type: BOOLEAN, Default: true
  - Intercepts Alt+F4 and asks the UI to confirm shutdown.
- SYSTEM_AUTO_UPDATE (System)
  - Type: BOOLEAN, Default: true
  - Enables `update-electron-app` auto-updates.

Notes
- Some settings require restart (labeled in title).
- `OnUpdateEvent` values in defaults trigger additional broadcasts when toggled.
