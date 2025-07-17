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
        Group: "Features",
        Key: "SYSTEM_ALLOW_WOL",
        Title: "Wake on LAN",
        Description: "Enable Wake on LAN functionality to wake up clients remotely.",
        Type: "BOOLEAN",
        DefaultValue: true,
    },
    {
        Group: "Features",
        Key: "SYSTEM_ALLOW_SCRIPT_EDITS",
        Title: "Allow Script Edits",
        Description: "You can disable the ability to upload scripts to clients here.",
        Type: "BOOLEAN",
        DefaultValue: true,
    },
    {
        Group: "System",
        Key: "SYSTEM_PREVENT_DISPLAY_SLEEP",
        Title: "Prevent Display Sleep",
        Description: "Prevents the display from going to sleep while ShowTrak is running.",
        Type: "BOOLEAN",
        DefaultValue: true,
    },
    {
        Group: "System",
        Key: "SYSTEM_CONFIRM_SHUTDOWN_ON_ALT_F4",
        Title: "Stop Accidental Shutdowns (Reboot Required)",
        Description: "Requires confirmation before shutting down ShowTrak when pressing Alt+F4.",
        Type: "BOOLEAN",
        DefaultValue: true,
    },
    {
        Group: "System",
        Key: "SYSTEM_AUTO_UPDATE",
        Title: "Automatic Updates (Reboot Required)",
        Description: "Automatically update ShowTrak to the latest stable version.",
        Type: "BOOLEAN",
        DefaultValue: true,
    },
];

const Groups = [
    // { Name: "UI", Title: "User Interface" },
    { Name: "Features", Title: "Features" },
    { Name: "System", Title: "System Settings" },
]

module.exports = {
    DefaultSettings, 
    Groups
};