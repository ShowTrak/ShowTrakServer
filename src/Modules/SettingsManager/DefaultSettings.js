const DefaultSettings = [
  // {
  //     Group: "UI",
  //     Key: "UI_DISPLAY_CLIENTS_IN_TABLE",
  //     Title: "List View",
  //     Description: "Displays clients in a table format instead of a list.",
  //     Type: "BOOLEAN",
  //     DefaultValue: false,
  //     OnUpdateEvent: "GroupListChanged"
  // },
  {
    Group: 'Features',
    Key: 'SYSTEM_ALLOW_WOL',
    Title: 'Wake on LAN',
    Description: 'Enable Wake on LAN functionality to wake up clients remotely.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },

  {
    Group: 'Web UI',
    Key: 'WEBUI_ENABLED',
    Title: 'Web UI Enabled',
    Description: 'Enable access to the Web UI.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'Web UI',
    Key: 'WEBUI_PASSWORD_PROTECTION_ENABLED',
    Title: 'Password Protection Enabled',
    Description:
      'Require a password to access the Web UI. Sessions are remembered per browser tab and can be ended with the Logout button.',
    Type: 'BOOLEAN',
    DefaultValue: false,
  },
  {
    Group: 'Web UI',
    Key: 'WEBUI_PASSWORD',
    Title: 'Password (4 Digit Numeric)',
    Description:
      'Optional 4 digit numeric passcode used to access the Web UI when password protection is enabled.',
    Type: 'STRING',
    DefaultValue: '',
  },
  {
    Group: 'Web UI',
    Key: 'WEBUI_ALLOW_REMOTE_SCRIPT_EXECUTION',
    Title: 'Remote Script Execution',
    Description:
      'Allow scripts and Wake on LAN to be triggered from the Web UI. When disabled the Web UI is read-only.',
    Type: 'BOOLEAN',
    DefaultValue: false,
  },
  {
    Group: 'Features',
    Key: 'SYSTEM_ALLOW_SCRIPT_EDITS',
    Title: 'Allow Script Edits',
    Description: 'You can disable the ability to upload scripts to clients here.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'System',
    Key: 'SYSTEM_PREVENT_DISPLAY_SLEEP',
    Title: 'Prevent Display Sleep',
    Description: 'Prevents the display from going to sleep while ShowTrak is running.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'System',
    Key: 'SYSTEM_CONFIRM_SHUTDOWN_ON_ALT_F4',
    Title: 'Stop Accidental Shutdowns (Reboot Required)',
    Description: 'Requires confirmation before quitting ShowTrak from system or app quit actions.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'System',
    Key: 'SYSTEM_AUTOSAVE_ENABLED',
    Title: 'Enable Autosave',
    Description: 'Automatically save the open ShowTrak file at a regular interval.',
    Type: 'BOOLEAN',
    DefaultValue: true,
    OnUpdateEvent: 'AutosaveSettingsChanged',
  },
  {
    Group: 'System',
    Key: 'SYSTEM_AUTOSAVE_INTERVAL_MINUTES',
    Title: 'Autosave Interval (Minutes)',
    Description: 'How often, in minutes, to automatically save the open ShowTrak file.',
    Type: 'INTEGER',
    DefaultValue: 5,
    OnUpdateEvent: 'AutosaveSettingsChanged',
  },
  {
    Group: 'System',
    Key: 'SYSTEM_WORKSPACE_DEFAULT_EDITOR',
    Title: 'Workspace Default Editor',
    Description:
      'Choose which editor is used to edit script files from Script Manager. "System Default" uses your OS default app.',
    Type: 'OPTION',
    DefaultValue: 'System Default',
    Options: ['System Default', 'Visual Studio Code'],
  },
  // Demo settings to showcase new data types
  // {
  //   Group: 'Demo',
  //   Key: 'DEMO_INTEGER_EXAMPLE',
  //   Title: 'Demo Integer',
  //   Description: 'An example integer setting with debounced auto-save.',
  //   Type: 'INTEGER',
  //   DefaultValue: 10,
  // },
  // {
  //   Group: 'Demo',
  //   Key: 'DEMO_STRING_EXAMPLE',
  //   Title: 'Demo String',
  //   Description: 'An example string setting with debounced auto-save.',
  //   Type: 'STRING',
  //   DefaultValue: 'Hello World',
  // },
  // {
  //   Group: 'Demo',
  //   Key: 'DEMO_OPTION_EXAMPLE',
  //   Title: 'Demo Option',
  //   Description: 'An example dropdown (option) setting with auto-save.',
  //   Type: 'OPTION',
  //   DefaultValue: 'Medium',
  //   Options: ['Low', 'Medium', 'High'],
  // },
];

const Groups = [
  // { Name: "UI", Title: "User Interface" },
  { Name: 'Features', Title: 'Features' },
  { Name: 'Web UI', Title: 'Web UI' },
  { Name: 'System', Title: 'System Settings' },
  // { Name: 'Demo', Title: 'Demo Settings' },
];

module.exports = {
  DefaultSettings,
  Groups,
};
