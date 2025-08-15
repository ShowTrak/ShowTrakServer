# Scripts

Scripts let you execute custom operations on clients from the server UI. Each script lives in a folder under the ShowTrak Server AppData `Scripts` directory.

Location
- Windows: `%APPDATA%/ShowTrakServer/Scripts`
- macOS: `~/Library/Preferences/ShowTrakServer/Scripts`
- Linux: `~/.local/share/ShowTrakServer/Scripts`

Folder layout

```text
Scripts/
  MyScript/
    Script.json
    run.ps1
    assets/
      icon.png
```

Script.json schema (minimal)

```json
{
  "Name": "Update Client",
  "Type": "powershell", // freeform label
  "Path": "run.ps1",     // relative path to entry file in this folder
  "LabelStyle": "light", // UI label style
  "Weight": 0,            // ordering in UI (higher or lower as desired)
  "Confirmation": false,  // ask for confirmation before running
  "Enabled": true         // list visibility
}
```

What the server does
- Discovers each top-level folder (excluding node_modules/.git/.vscode).
- Reads `Script.json` and builds a listing with all files and a checksum for each file.
- Sends script execution requests to clients via Socket.IO.
- Tracks an execution queue with per-client status, timeouts, and errors.

Client side
- The ShowTrak Client must know how to handle the script type and fetch files as needed.

Tips
- Keep scripts self-contained within their folder.
- Use small assets and keep the number of files reasonable to speed up checksum and transfer.
