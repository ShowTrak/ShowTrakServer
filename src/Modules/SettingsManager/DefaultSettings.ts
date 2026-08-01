import { DEFAULT_MONITORING_INTERVAL_MS, OSC_PORT } from '../Config/constants';
import { FOG_TASK_TYPES, FogTaskPermissionKey } from '../Config/fog';

// PASSWORD behaves exactly like STRING everywhere on the backend; it only tells the
// settings renderer to mask the field. Used for secrets that would otherwise sit in
// plain sight in the settings modal.
export type SettingType = 'BOOLEAN' | 'INTEGER' | 'STRING' | 'PASSWORD' | 'OPTION' | 'SLIDER';
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
    Group: 'Features',
    Key: 'SYSTEM_ALLOW_UNASSIGNED_CLIENTS',
    Title: 'Unassigned Clients',
    Description:
      'Allow empty client slots to be created ahead of time and filled in later by replacing them with a real device. Disabled by default.',
    Type: 'BOOLEAN',
    DefaultValue: false,
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
    Group: 'SDK / Integration API',
    Key: 'SDK_API_ENABLED',
    Title: 'SDK Control API',
    Description:
      'Enable the WebSocket control API (the /sdk namespace) used by the ShowTrak Server SDK and integrations such as the Bitfocus Companion module. Connections require the API key below.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'SDK / Integration API',
    Key: 'SDK_API_KEY',
    Title: 'SDK API Key',
    Description:
      'Required key integrations must present to connect to the control API. Auto-generated on first boot — copy it into your integration (e.g. the Companion connection settings). Change it to revoke existing integrations.',
    Type: 'STRING',
    DefaultValue: '',
  },
  {
    Group: 'SDK / Integration API',
    Key: 'SDK_ALLOW_REMOTE_PAIRING',
    Title: 'Allow ShowTrak Remote Pairing',
    Description:
      'Allow new phones and tablets running ShowTrak Remote to pair with this server. Pairing uses the Web UI passcode (or a scanned pairing code), not the API key above — so this can be turned off without affecting integrations such as Companion. Devices that are already paired keep working; use Revoke on the paired devices list to remove one.',
    Type: 'BOOLEAN',
    DefaultValue: true,
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
    Key: 'WEBUI_ALLOW_UNASSIGNED_CLIENTS',
    Title: 'Unassigned Clients',
    Description:
      'Allow unassigned client slots to be created from the Web UI. Also requires the global Unassigned Clients feature to be enabled, and the server to be in Edit mode.',
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
    Key: 'SYSTEM_AUTO_MAXIMIZE_ON_BOOT',
    Title: 'Auto Maximize Window on Boot',
    Description: 'Automatically maximize the ShowTrak window when the app starts.',
    Type: 'BOOLEAN',
    DefaultValue: false,
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
  {
    Group: 'FOG Project',
    Key: 'FOG_ENABLED',
    Title: 'FOG Project Integration',
    Description:
      'Enable integration with a FOG Project server so imaging tasks can be scheduled against clients from ShowTrak. The integration only reports as connected once the details below successfully reach the FOG API.',
    Type: 'BOOLEAN',
    DefaultValue: false,
    OnUpdateEvent: 'FogSettingsChanged',
  },
  {
    Group: 'FOG Project',
    Key: 'FOG_PROTOCOL',
    Title: 'Protocol',
    Description:
      'Whether to reach the FOG server over http or https. Self-signed certificates are accepted, so https does not guarantee the connection is verified.',
    Type: 'OPTION',
    DefaultValue: 'http',
    Options: ['http', 'https'],
    OnUpdateEvent: 'FogSettingsChanged',
  },
  {
    Group: 'FOG Project',
    Key: 'FOG_HOST',
    Title: 'FOG Server Address',
    Description:
      'Hostname or IP address of the FOG server. Do not include the protocol, port or /fog path — just the address, e.g. 10.0.0.10.',
    Type: 'STRING',
    DefaultValue: '',
    OnUpdateEvent: 'FogSettingsChanged',
  },
  {
    Group: 'FOG Project',
    Key: 'FOG_PORT',
    Title: 'Port',
    Description:
      'Port the FOG web interface listens on. Leave at 0 to use the protocol default (80 for http, 443 for https).',
    Type: 'INTEGER',
    DefaultValue: 0,
    Min: 0,
    Max: 65535,
    OnUpdateEvent: 'FogSettingsChanged',
  },
  {
    Group: 'FOG Project',
    Key: 'FOG_API_TOKEN',
    Title: 'API Token',
    Description:
      'System-wide FOG API token, found under FOG Configuration → FOG Settings → API System. Paste it exactly as shown in the FOG web interface — it is already encoded, and re-encoding it will cause the connection to be rejected.',
    Type: 'PASSWORD',
    DefaultValue: '',
    OnUpdateEvent: 'FogSettingsChanged',
  },
  {
    Group: 'FOG Project',
    Key: 'FOG_USER_TOKEN',
    Title: 'User Token',
    Description:
      'Per-user FOG API token, found under Users → (your user) → API. The user must have "User API Enable" ticked in FOG, otherwise the connection is rejected.',
    Type: 'PASSWORD',
    DefaultValue: '',
    OnUpdateEvent: 'FogSettingsChanged',
  },
  // One permission toggle per host-schedulable FOG task type. Generated from the task
  // type catalogue so the two cannot drift. Everything defaults to off: enabling the
  // integration must not, on its own, make it possible to wipe a machine.
  ...FOG_TASK_TYPES.map((Type): SettingDefinition => ({
    Group: 'FOG Permitted Actions',
    Key: FogTaskPermissionKey(Type.TaskTypeID),
    Title: Type.Name,
    Description: Type.Destructive
      ? `Allow the "${Type.Name}" task to be scheduled from ShowTrak. This task is destructive and can result in data loss on the target machine.`
      : `Allow the "${Type.Name}" task to be scheduled from ShowTrak.`,
    Type: 'BOOLEAN',
    DefaultValue: false,
  })),
];

export const Groups: SettingGroup[] = [
  { Name: 'Layout', Title: 'Layout' },
  { Name: 'Features', Title: 'Features' },
  { Name: 'Network', Title: 'Network' },
  { Name: 'Monitoring', Title: 'Monitoring' },
  { Name: 'SDK / Integration API', Title: 'SDK / Integration API' },
  { Name: 'Alerts', Title: 'Alerts' },
  { Name: 'Web UI', Title: 'Web UI' },
  { Name: 'Web UI Permissions', Title: 'Web UI Permissions' },
  { Name: 'FOG Project', Title: 'FOG Project' },
  { Name: 'FOG Permitted Actions', Title: 'FOG Permitted Actions' },
  { Name: 'System', Title: 'System Settings' },
];
