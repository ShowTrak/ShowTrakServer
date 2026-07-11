export type SettingType = 'BOOLEAN' | 'INTEGER' | 'STRING' | 'OPTION';
export type SettingValue = boolean | number | string;

export interface SettingDefinition {
  Group: string;
  Key: string;
  Title: string;
  Description: string;
  Type: SettingType;
  DefaultValue: SettingValue;
  Min?: number;
  Max?: number;
  Options?: string[];
  OnUpdateEvent?: string;
}

export interface SettingGroup {
  Name: string;
  Title: string;
}

export const DefaultSettings: SettingDefinition[] = [
  {
    Group: 'Layout',
    Key: 'UI_GROUP_COLUMN_COUNT',
    Title: 'Group Columns',
    Description:
      'Number of columns used to lay out groups. Groups set to Full Width span every column; other groups take a single column.',
    Type: 'INTEGER',
    DefaultValue: 2,
    Min: 2,
    Max: 6,
    OnUpdateEvent: 'GroupListChanged',
  },
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
    // Re-evaluate live Web UI sessions when access is toggled: disabling must
    // eject connected browsers, re-enabling must re-greet them.
    OnUpdateEvent: 'WebUiSettingsChanged',
  },
  {
    Group: 'Web UI',
    Key: 'WEBUI_PASSWORD_PROTECTION_ENABLED',
    Title: 'Password Protection Enabled',
    Description:
      'Require a password to access the Web UI. Sessions are remembered per browser tab and can be ended with the Logout button.',
    Type: 'BOOLEAN',
    DefaultValue: false,
    // Toggling protection must invalidate existing sessions so already-connected
    // browsers are re-prompted (or let straight in when protection is removed).
    OnUpdateEvent: 'WebUiSettingsChanged',
  },
  {
    Group: 'Web UI',
    Key: 'WEBUI_PASSWORD',
    Title: 'Password (4 Digit Numeric)',
    Description:
      'Optional 4 digit numeric passcode used to access the Web UI when password protection is enabled.',
    Type: 'STRING',
    DefaultValue: '',
    // Changing the passcode must invalidate every existing session so live
    // browsers are forced to re-authenticate with the new code.
    OnUpdateEvent: 'WebUiSettingsChanged',
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
];

export const Groups: SettingGroup[] = [
  { Name: 'Layout', Title: 'Layout' },
  { Name: 'Features', Title: 'Features' },
  { Name: 'Web UI', Title: 'Web UI' },
  { Name: 'System', Title: 'System Settings' },
];
