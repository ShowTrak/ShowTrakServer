# Settings reference

Settings are defined in `src/Modules/SettingsManager/DefaultSettings.js` and persisted in SQLite (`Settings` table). The UI groups them by `Group` and edits values via IPC with auto-save for most types.

Groups
- Notifications
- Features
- System

Data types

- BOOLEAN: switch, instant save on toggle
- STRING: text input, debounced auto-save (600ms)
- INTEGER: numeric input, debounced auto-save (600ms), coerced to integer
- OPTION: dropdown, instant save on change; define options via `Options: ["A","B"]` in the default setting entry

Keys

- NOTIFY_ON_USB_DEVICE_CONNECT (Notifications)
  - Type: BOOLEAN, Default: true
  - Sends toast on USB connect; may also play sound if AUDIO_* is enabled.
- AUDIO_ON_USB_DEVICE_CONNECT (Notifications)
  - Type: BOOLEAN, Default: true
  - Plays Notification sound on USB connect.
- NOTIFY_ON_USB_DEVICE_DISCONNECT (Notifications)
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

Demo settings (in Demo group)
- DEMO_INTEGER_EXAMPLE: INTEGER, default 10
- DEMO_STRING_EXAMPLE: STRING, default "Hello World"
- DEMO_OPTION_EXAMPLE: OPTION, default "Medium", options `["Low", "Medium", "High"]`

Notes
- Some settings require restart (labeled in title).
- `OnUpdateEvent` values in defaults trigger additional broadcasts when toggled.
