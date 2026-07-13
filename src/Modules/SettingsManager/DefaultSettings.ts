import { DEFAULT_MONITORING_INTERVAL_MS, OSC_PORT } from '../Config/constants';

export type SettingType = 'BOOLEAN' | 'INTEGER' | 'STRING' | 'OPTION' | 'SLIDER';
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
  // Optional unit label shown alongside numeric/slider values in the UI (e.g. '%', 'ms').
  Unit?: string;
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
    Group: 'Features',
    Key: 'CLIENT_SHOW_LAUNCH_COUNTDOWN',
    Title: 'Show Auto Launch Countdown',
    Description:
      'Show the visible abort countdown on clients before a run-on-launch script fires. When disabled the script still runs after its delay, but without the on-screen countdown or a chance to cancel.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'Network',
    Key: 'SYSTEM_OSC_ENABLED',
    Title: 'OSC Control',
    Description:
      'Enable the inbound OSC control server so external consoles can drive ShowTrak. Applies immediately.',
    Type: 'BOOLEAN',
    DefaultValue: true,
    OnUpdateEvent: 'OscSettingsChanged',
  },
  {
    Group: 'Network',
    Key: 'SYSTEM_OSC_PORT',
    Title: 'OSC Control Port',
    Description:
      'UDP port the inbound OSC control server listens on. Changes apply immediately — update any OSC senders to match.',
    Type: 'INTEGER',
    DefaultValue: OSC_PORT,
    Min: 1,
    Max: 65535,
    OnUpdateEvent: 'OscSettingsChanged',
  },
  {
    Group: 'Monitoring',
    Key: 'MONITORING_DEFAULT_INTERVAL_MS',
    Title: 'Default Monitoring Interval',
    Description:
      'Polling interval applied to monitoring targets and dummy clients that do not set their own. Applies to targets created or reloaded after the change.',
    Type: 'INTEGER',
    DefaultValue: DEFAULT_MONITORING_INTERVAL_MS,
    Min: 3000,
    Max: 300000,
    Unit: 'ms',
    OnUpdateEvent: 'MonitoringSettingsChanged',
  },
  {
    Group: 'Alerts',
    Key: 'ALERT_SOUND_VOLUME',
    Title: 'Alert Sound Volume',
    Description: 'Master volume for the built-in and custom alert sounds played on the server.',
    Type: 'SLIDER',
    DefaultValue: 100,
    Min: 0,
    Max: 100,
    Unit: '%',
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
    Group: 'Web UI Permissions',
    Key: 'WEBUI_ALLOW_IDENTIFY',
    Title: 'Identify Clients',
    Description: 'Allow the Web UI to flash the identify overlay on a client screen.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'Web UI Permissions',
    Key: 'WEBUI_ALLOW_CLIENT_MANAGEMENT',
    Title: 'Client Management',
    Description:
      'Allow the Web UI to adopt, edit, replace, unadopt clients and change critical USB/app/display flags. Still requires the server to be in Edit mode.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'Web UI Permissions',
    Key: 'WEBUI_ALLOW_GROUP_MANAGEMENT',
    Title: 'Group Management',
    Description:
      'Allow the Web UI to create, rename, delete and reorder groups. Still requires the server to be in Edit mode.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'Web UI Permissions',
    Key: 'WEBUI_ALLOW_MONITORING_MANAGEMENT',
    Title: 'Monitoring Management',
    Description:
      'Allow the Web UI to create, edit and delete monitoring targets and dummy clients, and run checks on demand. Still requires the server to be in Edit mode.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'Web UI Permissions',
    Key: 'WEBUI_ALLOW_ALERT_MANAGEMENT',
    Title: 'Alert Rule Management',
    Description:
      'Allow the Web UI to create, edit, delete and enable/disable alert rules. Still requires the server to be in Edit mode.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'Web UI Permissions',
    Key: 'WEBUI_ALLOW_WOL',
    Title: 'Wake on LAN',
    Description:
      'Allow Wake on LAN to be triggered from the Web UI. Also requires the global Wake on LAN feature to be enabled.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'Web UI Permissions',
    Key: 'WEBUI_ALLOW_REMOTE_SCRIPT_EXECUTION',
    Title: 'Script Execution',
    Description:
      'Allow scripts and integrated events to be triggered from the Web UI. Disabled by default for safety.',
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
    OnUpdateEvent: 'DisplaySleepSettingsChanged',
  },
  {
    Group: 'System',
    Key: 'SYSTEM_CONFIRM_SHUTDOWN_ON_ALT_F4',
    Title: 'Stop Accidental Shutdowns',
    Description: 'Requires confirmation before quitting ShowTrak from system or app quit actions.',
    Type: 'BOOLEAN',
    DefaultValue: true,
    OnUpdateEvent: 'ShutdownProtectionChanged',
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
  {
    Group: 'System',
    Key: 'SYSTEM_LOG_LEVEL',
    Title: 'Log Level',
    Description:
      'Minimum severity written to the console and daily log files. More verbose levels (debug, trace) help when diagnosing issues.',
    Type: 'OPTION',
    DefaultValue: 'info',
    Options: ['error', 'warn', 'info', 'debug', 'trace'],
    OnUpdateEvent: 'LoggingSettingsChanged',
  },
];

export const Groups: SettingGroup[] = [
  { Name: 'Layout', Title: 'Layout' },
  { Name: 'Features', Title: 'Features' },
  { Name: 'Network', Title: 'Network' },
  { Name: 'Monitoring', Title: 'Monitoring' },
  { Name: 'Alerts', Title: 'Alerts' },
  { Name: 'Web UI', Title: 'Web UI' },
  { Name: 'Web UI Permissions', Title: 'Web UI Permissions' },
  { Name: 'System', Title: 'System Settings' },
];
