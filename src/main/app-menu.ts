// Application menu (macOS only). Extracted verbatim from main.ts.
//
// On macOS ShowTrak installs a native menu bar whose items dispatch renderer
// actions (via `sendAppMenuAction`) or set the show/edit mode directly. On every
// other platform the application menu is cleared. The menu template is a pure
// function of its injected dependencies so it carries no module state.
const { Menu } = require('electron/main');

interface AppMenuDeps {
  // Forward a menu item's action ID to the renderer (AppMenuAction channel).
  sendAppMenuAction(actionID: string): void;
  // Set the application show/edit mode (ModeManager.Set).
  setMode(mode: string): void;
}

function buildMacAppMenuTemplate(deps: AppMenuDeps) {
  const { sendAppMenuAction, setMode } = deps;
  const fileSubmenu = [
    {
      label: 'New Show',
      accelerator: 'CmdOrCtrl+N',
      click: () => sendAppMenuAction('SHOWTRAK_MODEL_CORE_NEW'),
    },
    {
      label: 'Open',
      accelerator: 'CmdOrCtrl+O',
      click: () => sendAppMenuAction('SHOWTRAK_MODEL_CORE_OPEN'),
    },
    {
      label: 'Save',
      accelerator: 'CmdOrCtrl+S',
      click: () => sendAppMenuAction('SHOWTRAK_MODEL_CORE_SAVE'),
    },
    {
      label: 'Save As',
      accelerator: 'CmdOrCtrl+Shift+S',
      click: () => sendAppMenuAction('SHOWTRAK_MODEL_CORE_SAVEAS'),
    },
    { type: 'separator' },
    {
      label: 'Show Mode',
      accelerator: 'CmdOrCtrl+1',
      click: () => setMode('SHOW'),
    },
    {
      label: 'Edit Mode',
      accelerator: 'CmdOrCtrl+2',
      click: () => setMode('EDIT'),
    },
    { type: 'separator' },
    {
      label: 'Open Logs Directory',
      click: () => sendAppMenuAction('SHOWTRAK_MODEL_CORE_LOGSFOLDER'),
    },
    {
      label: 'Open Scripts Directory',
      click: () => sendAppMenuAction('SHOWTRAK_MODEL_CORE_SCRIPTSFOLDER'),
    },
    { type: 'separator' },
    {
      label: 'LAN Discovery Wizard',
      accelerator: 'CmdOrCtrl+L',
      click: () => sendAppMenuAction('ADD_TARGET_BROWSE_ACTION'),
    },
    {
      label: 'Script Manager',
      click: () => sendAppMenuAction('SHOWTRAK_MODEL_CORE_SCRIPT_MANAGER_BUTTON'),
    },
    {
      label: 'Update Manager',
      click: () => sendAppMenuAction('SHOWTRAK_MODEL_CORE_UPDATE_MANAGER_BUTTON'),
    },
    {
      label: 'OSC/API Reference',
      click: () => sendAppMenuAction('SHOWTRAK_MODEL_CORE_OSC_ROUTE_LIST_BUTTON'),
    },
    {
      label: 'OSC/API Debug Terminal',
      click: () => sendAppMenuAction('SHOWTRAK_MODEL_CORE_OSC_HTTP_DEBUG_BUTTON'),
    },
    { type: 'separator' },
    {
      label: 'Check for Updates',
      click: () => sendAppMenuAction('SHOWTRAK_MODEL_CORE_CHECKUPDATES'),
    },
    { label: 'About', click: () => sendAppMenuAction('SHOWTRAK_ABOUT_BUTTON') },
    { type: 'separator' },
    {
      label: 'ShowTrak Preferences',
      accelerator: 'CmdOrCtrl+,',
      click: () => sendAppMenuAction('SHOWTRAK_MODEL_CORE_OPEN_SETTINGS'),
    },
    {
      label: 'Close ShowTrak',
      click: () => sendAppMenuAction('SHOWTRAK_MODEL_CORE_SHUTDOWN_BUTTON'),
    },
  ];

  return [
    { role: 'appMenu' },
    { label: 'File', submenu: fileSubmenu },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
}

// Install the application menu for the current platform. macOS gets the native
// menu bar above; every other platform runs menu-less.
function configureApplicationMenu(deps: AppMenuDeps): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }

  const menu = Menu.buildFromTemplate(buildMacAppMenuTemplate(deps));
  Menu.setApplicationMenu(menu);
}

export { configureApplicationMenu };
