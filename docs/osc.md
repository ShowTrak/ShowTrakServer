# OSC routes

The server runs a UDP OSC server on port 3333 (0.0.0.0). It exposes routes for simple control, defined in `src/Modules/OSC/index.js`.

General
- GET route list in UI under the menu item that opens the OSC dictionary.

Routes

- /ShowTrak/Shutdown
  - Closes the ShowTrak Server application.

Client (UUID)
- /ShowTrak/Client/:UUID/Select
- /ShowTrak/Client/:UUID/Deselect
- /ShowTrak/Client/:UUID/WakeOnLAN
- /ShowTrak/Client/:UUID/RunScript/:ScriptID

All clients
- /ShowTrak/All/WakeOnLAN
- /ShowTrak/All/RunScript/:ScriptID

Behavior
- Dynamic segments use `:Param` style and are matched by position.
- On success, a short toast is shown.
- Errors (invalid UUID or ScriptID) produce error toasts.
