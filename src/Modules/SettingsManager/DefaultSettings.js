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
    Group: 'Notifications',
    Key: 'NOTIFY_ON_USB_DEVICE_CONNECT',
    Title: 'Notify on USB Device Connect',
    Description: 'Send a notification when a USB device connects to a client.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'Notifications',
    Key: 'AUDIO_ON_USB_DEVICE_CONNECT',
    Title: 'Play audio on USB Device Connect',
    Description: 'Play a sound when a USB device connects to a client.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },

  {
    Group: 'Notifications',
    Key: 'NOTIFY_ON_USB_DEVICE_DISCONNECT',
    Title: 'Notify on USB Device Disconnect',
    Description: 'Send a notification when a USB device disconnects from a client.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'Notifications',
    Key: 'AUDIO_ON_USB_DEVICE_DISCONNECT',
    Title: 'Play audio on USB Device Disconnect',
    Description: 'Play a sound when a USB device connects to a client.',
    Type: 'BOOLEAN',
    DefaultValue: true,
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
    Description: 'Requires confirmation before shutting down ShowTrak when pressing Alt+F4.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'System',
    Key: 'SYSTEM_AUTO_UPDATE',
    Title: 'Automatic Updates (Reboot Required)',
    Description: 'Automatically update ShowTrak to the latest stable version.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  // Demo settings to showcase new data types
  {
    Group: 'Demo',
    Key: 'DEMO_INTEGER_EXAMPLE',
    Title: 'Demo Integer',
    Description: 'An example integer setting with debounced auto-save.',
    Type: 'INTEGER',
    DefaultValue: 10,
  },
  {
    Group: 'Demo',
    Key: 'DEMO_STRING_EXAMPLE',
    Title: 'Demo String',
    Description: 'An example string setting with debounced auto-save.',
    Type: 'STRING',
    DefaultValue: 'Hello World',
  },
  {
    Group: 'Demo',
    Key: 'DEMO_OPTION_EXAMPLE',
    Title: 'Demo Option',
    Description: 'An example dropdown (option) setting with auto-save.',
    Type: 'OPTION',
    DefaultValue: 'Medium',
    Options: ['Low', 'Medium', 'High'],
  },
];

const Groups = [
  // { Name: "UI", Title: "User Interface" },
  { Name: 'Notifications', Title: 'Notifications' },
  { Name: 'Features', Title: 'Features' },
  { Name: 'System', Title: 'System Settings' },
  { Name: 'Demo', Title: 'Demo Settings' },
];

module.exports = {
  DefaultSettings,
  Groups,
};
