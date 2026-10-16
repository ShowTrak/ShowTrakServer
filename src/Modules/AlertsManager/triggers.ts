// The alert trigger catalog: the ONE place a trigger is declared.
//
// Everything else derives from this table. TRIGGERS (the ID constants the
// evaluators switch on), GetTriggers() (what the rule editor offers), the
// editor's allowlist, its picker grouping and the rule-summary phrasing all read
// it, so adding a trigger is one row here plus the code that raises it.
//
// Rows are ordered as the picker lists them: by category, then by row order.
// Summary completes "When <target> ..." in the rule list, so it is a verb phrase.

export const TRIGGER_CATALOG = [
  { ID: 'CLIENT_OFFLINE', Category: 'Status', Name: 'Client Offline', Summary: 'is offline' },
  { ID: 'CLIENT_DEGRADED', Category: 'Status', Name: 'Client Degraded', Summary: 'is degraded' },
  { ID: 'CLIENT_ONLINE', Category: 'Status', Name: 'Client Online', Summary: 'is online' },
  // RECOVERED is the degraded -> healthy edge of an entity whose degraded alert
  // was actually announced.
  {
    ID: 'CLIENT_RECOVERED',
    Category: 'Status',
    Name: 'Client Recovered',
    Summary: 'recovers from being degraded',
  },
  { ID: 'CLIENT_REBOOTED', Category: 'Status', Name: 'Client Restarted', Summary: 'restarts' },
  {
    ID: 'CLIENT_VERSION_CHANGED',
    Category: 'Status',
    Name: 'Client Version Changed',
    Summary: 'changes client version',
  },
  {
    ID: 'CLIENT_SLEEPING',
    Category: 'Status',
    Name: 'Client Going To Sleep',
    Summary: 'goes to sleep',
  },
  {
    ID: 'CLIENT_RESUMED',
    Category: 'Status',
    Name: 'Client Woke From Sleep',
    Summary: 'wakes from sleep',
  },
  // Monitored system checks (see ClientManager/system-checks). Each fires once
  // when its condition starts failing; the client reads degraded for as long as
  // it stands. Only monitored checks are judged.
  {
    ID: 'CPU_USAGE_HIGH',
    Category: 'Resources & Power',
    Name: 'CPU Usage High',
    Summary: 'has high CPU usage',
  },
  {
    ID: 'RAM_USAGE_HIGH',
    Category: 'Resources & Power',
    Name: 'Memory Usage High',
    Summary: 'has high memory usage',
  },
  {
    ID: 'UPTIME_HIGH',
    Category: 'Resources & Power',
    Name: 'Restart Overdue',
    Summary: 'is overdue a restart',
  },
  {
    ID: 'TEMPERATURE_HIGH',
    Category: 'Resources & Power',
    Name: 'Temperature High',
    Summary: 'runs hot',
  },
  {
    ID: 'THERMAL_STATE_HIGH',
    Category: 'Resources & Power',
    Name: 'Thermal Throttling',
    Summary: 'throttles to cool down',
  },
  {
    ID: 'BATTERY_LOW',
    Category: 'Resources & Power',
    Name: 'Battery Low',
    Summary: 'has a low battery',
  },
  {
    ID: 'BATTERY_NOT_CHARGING',
    Category: 'Resources & Power',
    Name: 'Battery Not Charging',
    Summary: 'stops charging its battery',
  },
  {
    ID: 'CRITICAL_POWER_ON_BATTERY',
    Category: 'Resources & Power',
    Name: 'Monitored Client On Battery',
    Summary: 'runs on battery while monitored',
  },
  // Mains/battery transitions on any client that reports power, monitored or not.
  {
    ID: 'POWER_ON_BATTERY',
    Category: 'Resources & Power',
    Name: 'Running On Battery',
    Summary: 'loses mains power',
  },
  {
    ID: 'POWER_RESTORED',
    Category: 'Resources & Power',
    Name: 'Mains Power Restored',
    Summary: 'gets mains power back',
  },
  {
    ID: 'APPLICATION_STARTED',
    Category: 'Applications',
    Name: 'Application Started',
    Summary: 'has an application started',
  },
  {
    ID: 'APPLICATION_STOPPED',
    Category: 'Applications',
    Name: 'Application Stopped',
    Summary: 'has an application stopped',
  },
  {
    ID: 'CRITICAL_APPLICATION_STARTED',
    Category: 'Applications',
    Name: 'Monitored Application Started',
    Summary: 'has a monitored application started',
  },
  {
    ID: 'CRITICAL_APPLICATION_STOPPED',
    Category: 'Applications',
    Name: 'Monitored Application Stopped',
    Summary: 'has a monitored application stopped',
  },
  {
    ID: 'NON_CRITICAL_APPLICATION_STARTED',
    Category: 'Applications',
    Name: 'Unmonitored Application Started',
    Summary: 'has an unmonitored application started',
  },
  {
    ID: 'NON_CRITICAL_APPLICATION_STOPPED',
    Category: 'Applications',
    Name: 'Unmonitored Application Stopped',
    Summary: 'has an unmonitored application stopped',
  },
  {
    ID: 'APPLICATION_NOT_RESPONDING',
    Category: 'Applications',
    Name: 'Application Not Responding',
    Summary: 'has an application stop responding',
  },
  {
    ID: 'CRITICAL_APPLICATION_NOT_RESPONDING',
    Category: 'Applications',
    Name: 'Monitored Application Not Responding',
    Summary: 'has a monitored application stop responding',
  },
  {
    ID: 'APPLICATION_RESPONDING',
    Category: 'Applications',
    Name: 'Application Responding Again',
    Summary: 'has an application start responding again',
  },
  {
    ID: 'CRITICAL_APPLICATION_MULTIPLE_INSTANCES',
    Category: 'Applications',
    Name: 'Monitored Application Running More Than Once',
    Summary: 'runs a monitored application more than once',
  },
  {
    ID: 'FOREGROUND_APPLICATION_CHANGED',
    Category: 'Applications',
    Name: 'Foreground Application Changed',
    Summary: 'changes its foreground application',
  },
  {
    ID: 'CRITICAL_APPLICATION_LOST_FOREGROUND',
    Category: 'Applications',
    Name: 'Monitored Application Lost Foreground',
    Summary: 'has a monitored application lose the foreground',
  },
  {
    ID: 'DISPLAY_CONNECTED',
    Category: 'Displays',
    Name: 'Display Connected',
    Summary: 'has a display connected',
  },
  {
    ID: 'DISPLAY_DISCONNECTED',
    Category: 'Displays',
    Name: 'Display Disconnected',
    Summary: 'has a display disconnected',
  },
  {
    ID: 'CRITICAL_DISPLAY_CONNECTED',
    Category: 'Displays',
    Name: 'Monitored Display Connected',
    Summary: 'has a monitored display connected',
  },
  {
    ID: 'CRITICAL_DISPLAY_DISCONNECTED',
    Category: 'Displays',
    Name: 'Monitored Display Disconnected',
    Summary: 'has a monitored display disconnected',
  },
  {
    ID: 'DISPLAY_CONFIGURATION_CHANGED',
    Category: 'Displays',
    Name: 'Display Configuration Changed',
    Summary: 'has a display change configuration',
  },
  {
    ID: 'NETWORK_INTERFACE_UP',
    Category: 'Network',
    Name: 'Network Interface Up',
    Summary: 'has a network interface come up',
  },
  {
    ID: 'NETWORK_INTERFACE_DOWN',
    Category: 'Network',
    Name: 'Network Interface Down',
    Summary: 'has a network interface go down',
  },
  {
    ID: 'CRITICAL_NETWORK_INTERFACE_DOWN',
    Category: 'Network',
    Name: 'Monitored Network Interface Down',
    Summary: 'has a monitored network interface go down',
  },
  {
    ID: 'NETWORK_ADDRESS_CHANGED',
    Category: 'Network',
    Name: 'Network Address Changed',
    Summary: 'changes a network address',
  },
  {
    ID: 'NETWORK_GATEWAY_CHANGED',
    Category: 'Network',
    Name: 'Network Router Changed',
    Summary: 'changes a network router',
  },
  {
    ID: 'USB_DEVICE_CONNECTED',
    Category: 'USB',
    Name: 'USB Device Connected',
    Summary: 'has a USB device connected',
  },
  {
    ID: 'USB_DEVICE_DISCONNECTED',
    Category: 'USB',
    Name: 'USB Device Disconnected',
    Summary: 'has a USB device disconnected',
  },
  {
    ID: 'NON_CRITICAL_USB_DEVICE_CONNECTED',
    Category: 'USB',
    Name: 'Unmonitored USB Device Connected',
    Summary: 'has an unmonitored USB device connected',
  },
  {
    ID: 'NON_CRITICAL_USB_DEVICE_DISCONNECTED',
    Category: 'USB',
    Name: 'Unmonitored USB Device Disconnected',
    Summary: 'has an unmonitored USB device disconnected',
  },
  {
    ID: 'CRITICAL_USB_DEVICE_CONNECTED',
    Category: 'USB',
    Name: 'Monitored USB Device Connected',
    Summary: 'has a monitored USB device connected',
  },
  {
    ID: 'CRITICAL_USB_DEVICE_DISCONNECTED',
    Category: 'USB',
    Name: 'Monitored USB Device Disconnected',
    Summary: 'has a monitored USB device disconnected',
  },
  {
    ID: 'USB_DEVICE_MOVED',
    Category: 'USB',
    Name: 'USB Device Moved',
    Summary: 'has a USB device moved to another port',
  },
  {
    ID: 'USB_FIRMWARE_CHANGED',
    Category: 'USB',
    Name: 'USB Firmware Changed',
    Summary: 'has a USB device change firmware',
  },
  {
    ID: 'USB_DEVICE_ERROR',
    Category: 'USB',
    Name: 'USB Device Error',
    Summary: 'has a USB device report a problem',
  },
  {
    ID: 'AUDIO_DEVICE_CONNECTED',
    Category: 'Audio',
    Name: 'Audio Device Connected',
    Summary: 'has an audio device connected',
  },
  {
    ID: 'AUDIO_DEVICE_DISCONNECTED',
    Category: 'Audio',
    Name: 'Audio Device Disconnected',
    Summary: 'has an audio device disconnected',
  },
  {
    ID: 'NON_CRITICAL_AUDIO_DEVICE_CONNECTED',
    Category: 'Audio',
    Name: 'Unmonitored Audio Device Connected',
    Summary: 'has an unmonitored audio device connected',
  },
  {
    ID: 'NON_CRITICAL_AUDIO_DEVICE_DISCONNECTED',
    Category: 'Audio',
    Name: 'Unmonitored Audio Device Disconnected',
    Summary: 'has an unmonitored audio device disconnected',
  },
  {
    ID: 'CRITICAL_AUDIO_DEVICE_CONNECTED',
    Category: 'Audio',
    Name: 'Monitored Audio Device Connected',
    Summary: 'has a monitored audio device connected',
  },
  {
    ID: 'CRITICAL_AUDIO_DEVICE_DISCONNECTED',
    Category: 'Audio',
    Name: 'Monitored Audio Device Disconnected',
    Summary: 'has a monitored audio device disconnected',
  },
  // Fire on a change to an endpoint that stays connected.
  {
    ID: 'AUDIO_DEFAULT_DEVICE_CHANGED',
    Category: 'Audio',
    Name: 'Default Audio Device Changed',
    Summary: 'changes its default audio device',
  },
  {
    ID: 'AUDIO_DEVICE_MUTED',
    Category: 'Audio',
    Name: 'Audio Device Muted',
    Summary: 'has an audio device muted',
  },
  {
    ID: 'AUDIO_FORMAT_CHANGED',
    Category: 'Audio',
    Name: 'Audio Format Changed',
    Summary: 'has an audio device change format',
  },
  {
    ID: 'AUDIO_VOLUME_OUT_OF_RANGE',
    Category: 'Audio',
    Name: 'Audio Level Out Of Range',
    Summary: 'has an audio level out of range',
  },
  {
    ID: 'SCRIPT_EXECUTION_FAILED',
    Category: 'Scripts & Kiosks',
    Name: 'Script Execution Failed',
    Summary: 'fails to execute a script',
  },
  // Fires on the false->true edge of one FreeKiosk metric alarm. A rule may
  // narrow it to specific metrics via TriggerConfig.Metrics; an empty or absent
  // list means every metric.
  {
    ID: 'FREEKIOSK_METRIC_ALARM',
    Category: 'Scripts & Kiosks',
    Name: 'FreeKiosk Metric Alarm',
    Summary: 'raises a FreeKiosk metric alarm',
  },
] as const satisfies ReadonlyArray<{
  ID: string;
  Category: string;
  Name: string;
  Summary: string;
}>;

export type TriggerID = (typeof TRIGGER_CATALOG)[number]['ID'];

/** ID constants, so call sites read TRIGGERS.CLIENT_OFFLINE and a typo fails to compile. */
const TRIGGERS = Object.fromEntries(TRIGGER_CATALOG.map((T) => [T.ID, T.ID])) as {
  readonly [K in TriggerID]: K;
};

export { TRIGGERS };
