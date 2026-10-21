// Which of the view modal's tabs carry an active alarm, so the rail can mark
// them with a warning icon. Status is marked whenever anything is alarming;
// the tab a condition is configured on is marked too (a display configuration
// change marks Video).
//
// A client's alarms arrive as its DegradedWarnings text, which is only
// published once the start-up window has passed and is empty while offline.
// The texts are a MIRROR of the *_WARNINGS tables in Modules/ClientManager
// (the renderer cannot import across its bundle boundary); the test checks
// them against the real tables. A warning not listed here (an SDK client's own
// reason, or one added later) still marks Status.
//
// FreeKiosk alarms map through their metric's registry section, exactly as
// the section cards are placed (FreeKioskSectionTab). Monitors and dummy
// clients only have Status to show an alarm on.
import { FreeKioskSectionTab } from './client-info-tabs';
import type { ClientInfoTabKey } from './client-info-tabs';

export const CLIENT_WARNING_TABS: Readonly<Record<string, ClientInfoTabKey>> = {
  // USB_WARNINGS
  'Missing USB Device': 'usb',
  'USB Device Moved': 'usb',
  'USB Firmware Changed': 'usb',
  'USB Device Error': 'usb',
  // STORAGE_WARNINGS
  'Missing Storage Volume': 'storage',
  'Low Disk Space': 'storage',
  'Storage Volume Read-Only': 'storage',
  'Storage Health Warning': 'storage',
  // DISPLAY_WARNINGS
  'Missing Display': 'video',
  'Display Configuration Changed': 'video',
  // AUDIO_WARNINGS
  'Missing Audio Device': 'audio',
  'Audio Device Not Default': 'audio',
  'Audio Format Changed': 'audio',
  'Audio Device Muted': 'audio',
  'Audio Level Out Of Range': 'audio',
  // NETWORK_WARNINGS
  'Missing Network Interface': 'network',
  'Network Address Changed': 'network',
  'Network Router Changed': 'network',
  // Applications (client.ts and health.ts)
  'Monitored Application Issue': 'apps',
  'Application Not Responding': 'apps',
  'Application Not In Foreground': 'apps',
  // SYSTEM_CHECK_WARNINGS, by the card each check sits on
  'High CPU Usage': 'usage',
  'High Memory Usage': 'usage',
  'Restart Overdue': 'usage',
  'Running On Battery': 'power',
  'Battery Low': 'power',
  'Battery Not Charging': 'power',
  'High Temperature': 'power',
  'Thermal Throttling': 'power',
};

interface DegradedLike {
  Degraded?: boolean;
  DegradedWarnings?: readonly string[] | null;
}

interface CheckLike {
  Online?: boolean;
  Degraded?: boolean;
  LastChecked?: number | null;
}

interface FreeKioskAlarmLike {
  Key: string;
}

interface FreeKioskMetricLike {
  Key: string;
  Section: string;
}

/** A ShowTrak or SDK client: Status, plus the tab of each warning. */
export function ClientAlarmTabs(Client: DegradedLike | null | undefined): ClientInfoTabKey[] {
  if (!Client || !Client.Degraded) return [];
  const Warnings = Array.isArray(Client.DegradedWarnings) ? Client.DegradedWarnings : [];
  const Tabs = new Set<ClientInfoTabKey>(['status']);
  for (const Warning of Warnings) {
    const Tab = CLIENT_WARNING_TABS[String(Warning)];
    if (Tab) Tabs.add(Tab);
  }
  return [...Tabs];
}

/**
 * A monitor: Status when any check reads offline or degraded. A check that has
 * never run has no verdict yet, so it is not an alarm.
 */
export function MonitorAlarmTabs(
  Checks: readonly (CheckLike | null | undefined)[] | null | undefined
): ClientInfoTabKey[] {
  const Alarming = (Checks || []).some(
    (Check) => !!Check && Check.LastChecked != null && (!Check.Online || !!Check.Degraded)
  );
  return Alarming ? ['status'] : [];
}

/** A dummy client: Status while a heartbeat is overdue. */
export function DummyAlarmTabs(Dummy: DegradedLike | null | undefined): ClientInfoTabKey[] {
  return Dummy && Dummy.Degraded ? ['status'] : [];
}

/** A FreeKiosk terminal: Status, plus the tab each breaching reading is drawn on. */
export function FreeKioskAlarmTabs(
  Alarms: readonly FreeKioskAlarmLike[] | null | undefined,
  Metrics: readonly FreeKioskMetricLike[] | null | undefined
): ClientInfoTabKey[] {
  const List = Array.isArray(Alarms) ? Alarms : [];
  if (List.length === 0) return [];
  const SectionByKey = new Map((Metrics || []).map((Metric) => [Metric.Key, Metric.Section]));
  const Tabs = new Set<ClientInfoTabKey>(['status']);
  for (const Alarm of List) {
    const Section = SectionByKey.get(Alarm.Key);
    // Before the catalogue has loaded the section is unknown; Status alone
    // still says something is wrong.
    if (Section) Tabs.add(FreeKioskSectionTab(Section));
  }
  return [...Tabs];
}
