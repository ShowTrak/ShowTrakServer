import {
  ALERT_AUDIO_DEDUPE_DEFAULT_MS,
  ALERT_AUDIO_DEDUPE_MAX_MS,
  DEFAULT_MONITORING_INTERVAL_MS,
  OSC_PORT,
} from '../Config/constants';
import { FOG_TASK_TYPES, FogTaskPermissionKey } from '../Config/fog';
import {
  FREEKIOSK_COMMANDS,
  FREEKIOSK_MENU_POLL_SETTING_KEY,
  FreeKioskMenuSettingKey,
  IsFreeKioskMenuCommand,
} from '../FreeKiosk/commands';
import type { FreeKioskCommandDef } from '../FreeKiosk/commands';
import {
  MIN_OFFLINE_GRACE_SECONDS,
  MAX_OFFLINE_GRACE_SECONDS,
} from '../ClientManager/offline-grace';

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
  // 'INSTALL' stores the value with this installation of ShowTrak (see
  // install-settings.ts) instead of in the open show file, so it does not change
  // when a different show is opened. Omitted means per show file.
  Scope?: 'INSTALL';
  // Progressive disclosure: Preferences shows this setting only while every
  // BOOLEAN setting named here is on. Purely presentational: a hidden setting
  // keeps its value, and the backend still reads the parent toggle itself.
  ShowWhen?: string[];
}

export interface SettingGroup {
  Name: string;
  Title: string;
  // As SettingDefinition.ShowWhen, for a whole group (and its Preferences tab).
  ShowWhen?: string[];
}

export const DefaultSettings: SettingDefinition[] = [
  // Machine settings are stored with this installation (Scope: 'INSTALL'),
  // not in the show file, and get the first Preferences tab.
  {
    Group: 'Machine',
    Key: 'SYSTEM_PREVENT_DISPLAY_SLEEP',
    Title: 'Prevent Display Sleep',
    Description: '',
    Type: 'BOOLEAN',
    DefaultValue: true,
    OnUpdateEvent: 'DisplaySleepSettingsChanged',
    Scope: 'INSTALL',
  },
  {
    Group: 'Machine',
    Key: 'SYSTEM_AUTO_MAXIMIZE_ON_BOOT',
    Title: 'Auto Maximise Window on Boot',
    Description: '',
    Type: 'BOOLEAN',
    DefaultValue: false,
    Scope: 'INSTALL',
  },
  {
    Group: 'Machine',
    Key: 'SYSTEM_CONFIRM_SHUTDOWN_ON_ALT_F4',
    Title: 'Stop Accidental Shutdowns',
    Description: 'Ask for confirmation before quitting ShowTrak.',
    Type: 'BOOLEAN',
    DefaultValue: true,
    OnUpdateEvent: 'ShutdownProtectionChanged',
    Scope: 'INSTALL',
  },
  {
    Group: 'Machine',
    Key: 'SYSTEM_AUTO_UPDATE_ENABLED',
    Title: 'Automatic Updates',
    Description:
      'Download new releases in the background. They install the next time ShowTrak restarts.',
    Type: 'BOOLEAN',
    DefaultValue: false,
    OnUpdateEvent: 'AutoUpdateSettingsChanged',
    Scope: 'INSTALL',
  },
  {
    Group: 'Machine',
    Key: 'SYSTEM_AUTOSAVE_ENABLED',
    Title: 'Enable Autosave',
    Description: '',
    Type: 'BOOLEAN',
    DefaultValue: true,
    OnUpdateEvent: 'AutosaveSettingsChanged',
    Scope: 'INSTALL',
  },
  {
    Group: 'Machine',
    Key: 'SYSTEM_AUTOSAVE_INTERVAL_MINUTES',
    Title: 'Autosave Interval',
    Description: '',
    Type: 'INTEGER',
    DefaultValue: 5,
    ShowWhen: ['SYSTEM_AUTOSAVE_ENABLED'],
    Unit: 'minutes',
    OnUpdateEvent: 'AutosaveSettingsChanged',
    Scope: 'INSTALL',
  },
  {
    Group: 'Machine',
    Key: 'SYSTEM_WORKSPACE_DEFAULT_EDITOR',
    Title: 'Workspace Default Editor',
    Description: 'Editor used to open script files from Script Manager.',
    Type: 'OPTION',
    DefaultValue: 'System Default',
    Options: ['System Default', 'Visual Studio Code'],
    Scope: 'INSTALL',
  },
  {
    Group: 'Machine',
    Key: 'SYSTEM_ALLOW_UNASSIGNED_CLIENTS',
    Title: 'Unassigned Clients',
    Description: 'Create empty client slots now and fill them with a real device later.',
    Type: 'BOOLEAN',
    DefaultValue: false,
    Scope: 'INSTALL',
  },
  {
    Group: 'Layout',
    Key: 'UI_GROUP_COLUMN_COUNT',
    Title: 'Group Columns',
    Description:
      'Full Width groups span every column. Other groups use their own width, capped at this count.',
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
    Description: '',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'Features',
    Key: 'UI_CLEAR_SELECTION_AFTER_ACTION',
    Title: 'Clear Selection After Actions',
    Description:
      'Deselect clients after running an action from the context menu. Other screens keep their selection.',
    Type: 'BOOLEAN',
    DefaultValue: false,
  },
  {
    Group: 'Features',
    Key: 'UI_EXECUTION_PANEL_DWELL_SECONDS',
    Title: 'Execution Panel Dwell Time',
    Description: 'How long the execution panel stays open after its last action finishes.',
    Type: 'SLIDER',
    DefaultValue: 5,
    Min: 0,
    Max: 60,
    Unit: 's',
  },
  {
    Group: 'Features',
    Key: 'CLIENT_SHOW_LAUNCH_COUNTDOWN',
    Title: 'Show Auto Launch Countdown',
    Description:
      'Show a cancellable countdown on clients before a launch script runs. The script runs either way.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'Network',
    Key: 'SYSTEM_OSC_ENABLED',
    Title: 'OSC Control',
    Description: '',
    Type: 'BOOLEAN',
    DefaultValue: true,
    OnUpdateEvent: 'OscSettingsChanged',
  },
  {
    Group: 'Network',
    Key: 'SYSTEM_OSC_PORT',
    Title: 'OSC Control Port',
    Description: '',
    Type: 'INTEGER',
    DefaultValue: OSC_PORT,
    ShowWhen: ['SYSTEM_OSC_ENABLED'],
    Min: 1,
    Max: 65535,
    OnUpdateEvent: 'OscSettingsChanged',
  },
  {
    Group: 'SDK / Integration API',
    Key: 'SDK_API_ENABLED',
    Title: 'SDK Control API',
    Description: 'Used by the ShowTrak SDK and integrations such as Bitfocus Companion.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'SDK / Integration API',
    Key: 'SDK_API_KEY',
    Title: 'SDK API Key',
    Description:
      'Integrations must present this key to connect. Change it to revoke every integration.',
    Type: 'STRING',
    DefaultValue: '',
    ShowWhen: ['SDK_API_ENABLED'],
  },
  {
    Group: 'SDK / Integration API',
    Key: 'SDK_ALLOW_REMOTE_PAIRING',
    Title: 'Allow ShowTrak Remote Pairing',
    Description: 'Allow new phones and tablets to pair. Already paired devices keep working.',
    Type: 'BOOLEAN',
    DefaultValue: true,
    ShowWhen: ['SDK_API_ENABLED'],
  },
  {
    Group: 'Monitoring',
    Key: 'MONITORING_DEFAULT_INTERVAL_MS',
    Title: 'Default Monitoring Interval',
    Description: 'Used by monitors and dummy clients that do not set their own.',
    Type: 'INTEGER',
    DefaultValue: DEFAULT_MONITORING_INTERVAL_MS,
    Min: 3000,
    Max: 300000,
    Unit: 'ms',
    OnUpdateEvent: 'MonitoringSettingsChanged',
  },
  {
    Group: 'Monitoring',
    Key: 'MONITORING_FAILURE_THRESHOLD',
    Title: 'Failures Before Offline',
    Description:
      'Consecutive failed checks before a check is marked offline. Monitors can override this.',
    Type: 'INTEGER',
    DefaultValue: 1,
    Min: 1,
    Max: 10,
    OnUpdateEvent: 'MonitoringSettingsChanged',
  },
  {
    Group: 'Monitoring',
    Key: 'CLIENT_OFFLINE_GRACE_SECONDS',
    Title: 'Client Disconnect Grace Period',
    Description:
      'How long a client can be disconnected before it is marked offline. Clients can override this.',
    Type: 'SLIDER',
    DefaultValue: 0,
    Min: MIN_OFFLINE_GRACE_SECONDS,
    Max: MAX_OFFLINE_GRACE_SECONDS,
    Unit: 's',
    OnUpdateEvent: 'MonitoringSettingsChanged',
  },
  {
    Group: 'Alerts',
    Key: 'ALERT_SOUND_VOLUME',
    Title: 'Alert Sound Volume',
    Description: '',
    Type: 'SLIDER',
    DefaultValue: 100,
    Min: 0,
    Max: 100,
    Unit: '%',
  },
  {
    Group: 'Alerts',
    Key: 'ALERT_SOUND_DEDUPE_WINDOW_MS',
    Title: 'Alert Sound Repeat Window',
    Description: 'Repeats of the same sound within this window are skipped. 0 plays every alert.',
    Type: 'INTEGER',
    DefaultValue: ALERT_AUDIO_DEDUPE_DEFAULT_MS,
    Min: 0,
    Max: ALERT_AUDIO_DEDUPE_MAX_MS,
    Unit: 'ms',
    OnUpdateEvent: 'AlertAudioSettingsChanged',
  },

  {
    Group: 'Web UI',
    Key: 'WEBUI_ENABLED',
    Title: 'Web UI Enabled',
    Description: '',
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
    Description: 'Require the passcode to open the Web UI.',
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
    Description: '',
    Type: 'STRING',
    DefaultValue: '',
    ShowWhen: ['WEBUI_PASSWORD_PROTECTION_ENABLED'],
    // Changing the passcode must invalidate every existing session so live
    // browsers are forced to re-authenticate with the new code.
    OnUpdateEvent: 'WebUiSettingsChanged',
  },
  {
    Group: 'Web UI Permissions',
    Key: 'WEBUI_ALLOW_IDENTIFY',
    Title: 'Identify Clients',
    Description: '',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'Web UI Permissions',
    Key: 'WEBUI_ALLOW_MODE_CHANGE',
    Title: 'Switch Show/Edit Mode',
    Description: 'Edit mode unlocks the management permissions below.',
    Type: 'BOOLEAN',
    DefaultValue: false,
  },
  {
    Group: 'Web UI Permissions',
    Key: 'WEBUI_ALLOW_ALERT_ACTIONS_TOGGLE',
    Title: 'Toggle Alert Actions',
    Description: 'Turn alert actions on and off for the whole server.',
    Type: 'BOOLEAN',
    DefaultValue: false,
  },
  {
    Group: 'Web UI Permissions',
    Key: 'WEBUI_ALLOW_CLIENT_MANAGEMENT',
    Title: 'Client Management',
    Description: 'Adopt, edit, replace and delete clients, and manage tags. Requires Edit mode.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'Web UI Permissions',
    Key: 'WEBUI_ALLOW_GROUP_MANAGEMENT',
    Title: 'Group Management',
    Description: 'Requires Edit mode.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'Web UI Permissions',
    Key: 'WEBUI_ALLOW_MONITORING_MANAGEMENT',
    Title: 'Monitoring Management',
    Description: 'Manage monitors and dummy clients. Requires Edit mode.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'Web UI Permissions',
    Key: 'WEBUI_ALLOW_MONITORING_ACTIONS',
    Title: 'Run Monitoring Actions',
    Description: 'Power, input, mute and fader controls on devices. Works in Show mode.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'Web UI Permissions',
    Key: 'WEBUI_ALLOW_ALERT_MANAGEMENT',
    Title: 'Alert Rule Management',
    Description: 'Requires Edit mode.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'Web UI Permissions',
    Key: 'WEBUI_ALLOW_UNASSIGNED_CLIENTS',
    Title: 'Unassigned Clients',
    Description: 'Requires Edit mode.',
    Type: 'BOOLEAN',
    DefaultValue: true,
    ShowWhen: ['SYSTEM_ALLOW_UNASSIGNED_CLIENTS'],
  },
  {
    Group: 'Web UI Permissions',
    Key: 'WEBUI_ALLOW_WOL',
    Title: 'Wake on LAN',
    Description: '',
    Type: 'BOOLEAN',
    DefaultValue: true,
    ShowWhen: ['SYSTEM_ALLOW_WOL'],
  },
  {
    Group: 'Web UI Permissions',
    Key: 'WEBUI_ALLOW_REMOTE_SCRIPT_EXECUTION',
    Title: 'Script Execution',
    Description: 'Run scripts and integrated events.',
    Type: 'BOOLEAN',
    DefaultValue: false,
  },
  // ShowTrak Remote permissions. Deliberately the SAME categories and the SAME
  // defaults as the Web UI above: both are remote surfaces reading one shared
  // capability model (Modules/RemoteAccess), and a divergence here would have to
  // be re-explained every time an operator compared the two panes. EDIT mode
  // remains the master gate for every management category regardless.
  {
    Group: 'ShowTrak Remote Permissions',
    Key: 'REMOTE_ALLOW_IDENTIFY',
    Title: 'Identify Clients',
    Description: '',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'ShowTrak Remote Permissions',
    Key: 'REMOTE_ALLOW_CLIENT_MANAGEMENT',
    Title: 'Client Management',
    Description: 'Edit clients and their tags. Requires Edit mode.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'ShowTrak Remote Permissions',
    Key: 'REMOTE_ALLOW_GROUP_MANAGEMENT',
    Title: 'Group Management',
    Description: 'Requires Edit mode.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'ShowTrak Remote Permissions',
    Key: 'REMOTE_ALLOW_MONITORING_MANAGEMENT',
    Title: 'Monitoring Management',
    Description: 'Manage monitors, dummy clients and FreeKiosk terminals. Requires Edit mode.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'ShowTrak Remote Permissions',
    Key: 'REMOTE_ALLOW_MONITORING_ACTIONS',
    Title: 'Run Monitoring Actions',
    Description: 'Power, input, mute and fader controls on devices. Works in Show mode.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'ShowTrak Remote Permissions',
    Key: 'REMOTE_ALLOW_ALERT_MANAGEMENT',
    Title: 'Alert Management',
    Description: 'Requires Edit mode.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'ShowTrak Remote Permissions',
    Key: 'REMOTE_ALLOW_UNASSIGNED_CLIENTS',
    Title: 'Create Unassigned Clients',
    Description: 'Requires Edit mode.',
    Type: 'BOOLEAN',
    DefaultValue: true,
    ShowWhen: ['SYSTEM_ALLOW_UNASSIGNED_CLIENTS'],
  },
  {
    Group: 'ShowTrak Remote Permissions',
    Key: 'REMOTE_ALLOW_WOL',
    Title: 'Wake on LAN',
    Description: '',
    Type: 'BOOLEAN',
    DefaultValue: true,
    ShowWhen: ['SYSTEM_ALLOW_WOL'],
  },
  {
    Group: 'ShowTrak Remote Permissions',
    Key: 'REMOTE_ALLOW_REMOTE_SCRIPT_EXECUTION',
    Title: 'Script Execution',
    Description: 'Run scripts and integrated events.',
    Type: 'BOOLEAN',
    DefaultValue: false,
  },
  {
    Group: 'System',
    Key: 'SYSTEM_LOG_LEVEL',
    Title: 'Log Level',
    Description: 'Use debug or trace when diagnosing issues.',
    Type: 'OPTION',
    DefaultValue: 'info',
    Options: ['error', 'warn', 'info', 'debug', 'trace'],
    OnUpdateEvent: 'LoggingSettingsChanged',
  },
  {
    Group: 'FOG Project',
    Key: 'FOG_ENABLED',
    Title: 'FOG Project Integration',
    Description: 'Schedule FOG imaging tasks against clients.',
    Type: 'BOOLEAN',
    DefaultValue: false,
    OnUpdateEvent: 'FogSettingsChanged',
  },
  {
    Group: 'FOG Project',
    Key: 'FOG_PROTOCOL',
    Title: 'Protocol',
    Description: 'Self-signed certificates are accepted.',
    Type: 'OPTION',
    DefaultValue: 'http',
    ShowWhen: ['FOG_ENABLED'],
    Options: ['http', 'https'],
    OnUpdateEvent: 'FogSettingsChanged',
  },
  {
    Group: 'FOG Project',
    Key: 'FOG_HOST',
    Title: 'FOG Server Address',
    Description: 'Hostname or IP only, e.g. 10.0.0.10.',
    Type: 'STRING',
    DefaultValue: '',
    ShowWhen: ['FOG_ENABLED'],
    OnUpdateEvent: 'FogSettingsChanged',
  },
  {
    Group: 'FOG Project',
    Key: 'FOG_PORT',
    Title: 'Port',
    Description: '0 uses the protocol default.',
    Type: 'INTEGER',
    DefaultValue: 0,
    ShowWhen: ['FOG_ENABLED'],
    Min: 0,
    Max: 65535,
    OnUpdateEvent: 'FogSettingsChanged',
  },
  {
    Group: 'FOG Project',
    Key: 'FOG_API_TOKEN',
    Title: 'API Token',
    Description: 'From FOG Configuration > FOG Settings > API System. Paste it exactly as shown.',
    Type: 'PASSWORD',
    DefaultValue: '',
    ShowWhen: ['FOG_ENABLED'],
    OnUpdateEvent: 'FogSettingsChanged',
  },
  {
    Group: 'FOG Project',
    Key: 'FOG_USER_TOKEN',
    Title: 'User Token',
    Description: 'From Users > your user > API. The user needs "User API Enable" ticked.',
    Type: 'PASSWORD',
    DefaultValue: '',
    ShowWhen: ['FOG_ENABLED'],
    OnUpdateEvent: 'FogSettingsChanged',
  },
  // One permission toggle per host-schedulable FOG task type. Generated from the task
  // type catalogue so the two cannot drift. Everything defaults to off: enabling the
  // integration must not, on its own, make it possible to wipe a machine.
  ...FOG_TASK_TYPES.map((Type): SettingDefinition => ({
    Group: 'FOG Permitted Actions',
    Key: FogTaskPermissionKey(Type.TaskTypeID),
    Title: Type.Name,
    Description: Type.Destructive ? 'Destructive. Can erase data on the target machine.' : '',
    Type: 'BOOLEAN',
    DefaultValue: false,
  })),
  // One toggle per FreeKiosk context-menu action, generated from the command map
  // so a command added there gets its preference with no change here. All on by
  // default, which is what the menu offered before these existed. They only
  // trim the menu: the view modal and OSC still reach every command.
  {
    Group: 'FreeKiosk',
    Key: FREEKIOSK_MENU_POLL_SETTING_KEY,
    Title: 'Poll Now',
    Description: '',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  ...(FREEKIOSK_COMMANDS as readonly FreeKioskCommandDef[])
    .filter(IsFreeKioskMenuCommand)
    .map((Command): SettingDefinition => ({
      Group: 'FreeKiosk',
      Key: FreeKioskMenuSettingKey(Command.ID),
      Title: Command.Label,
      Description: '',
      Type: 'BOOLEAN',
      DefaultValue: true,
    })),
];

export const Groups: SettingGroup[] = [
  { Name: 'Machine', Title: 'Machine Settings' },
  { Name: 'Layout', Title: 'Layout' },
  { Name: 'Features', Title: 'Features' },
  { Name: 'Network', Title: 'Network' },
  { Name: 'Monitoring', Title: 'Monitoring' },
  { Name: 'FreeKiosk', Title: 'FreeKiosk' },
  { Name: 'SDK / Integration API', Title: 'SDK / Integration API' },
  { Name: 'Alerts', Title: 'Alerts' },
  { Name: 'Web UI', Title: 'Web UI' },
  { Name: 'Web UI Permissions', Title: 'Web UI Permissions', ShowWhen: ['WEBUI_ENABLED'] },
  // ShowTrak Remote connects through the SDK namespace, so it is off with it.
  {
    Name: 'ShowTrak Remote Permissions',
    Title: 'ShowTrak Remote Permissions',
    ShowWhen: ['SDK_API_ENABLED'],
  },
  { Name: 'FOG Project', Title: 'FOG Project' },
  { Name: 'FOG Permitted Actions', Title: 'FOG Permitted Actions', ShowWhen: ['FOG_ENABLED'] },
  { Name: 'System', Title: 'System Settings' },
];
