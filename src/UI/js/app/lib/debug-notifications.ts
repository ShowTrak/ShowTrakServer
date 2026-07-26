// Dev-only helper: fires one of every notification/alert style so the visual
// treatment of each can be eyeballed side by side. Wired to the
// Settings > Debug > "Test Notifications" item, which is revealed only on
// uncompiled builds (app.isPackaged === false; see init.ts).
import { AddAlert } from '../alerts-tray';
import { Notify, showAlertStyleToast } from './toasts';

const SEVERITIES = ['info', 'success', 'warning', 'error'] as const;

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function TestAllNotifications() {
  const steps: Array<() => void> = [];

  // 1. Title-only toasts (the Notify() path) — one per severity accent.
  for (const type of SEVERITIES) {
    steps.push(() => Notify(`${cap(type)} notification (title only)`, type, 20000));
  }

  // 2. Title + message toasts — the multi-line layout, one per severity.
  for (const type of SEVERITIES) {
    steps.push(() =>
      showAlertStyleToast({
        title: `${cap(type)} with message`,
        message: `Example ${type} notification with a longer body line for the two-row layout.`,
        type,
        duration: 20000,
      })
    );
  }

  // 3. Tray alerts with type-specific icons. AddAlert both pushes to the alerts
  //    tray and spawns a linked toast, so these also exercise the usb/online/
  //    offline/default icon variants and the tray/toast dismiss sync.
  const trayAlerts = [
    {
      type: 'usb',
      severity: 'warning',
      title: 'USB device removed',
      message: 'Stream Deck disconnected from FOH-PC.',
    },
    {
      type: 'online',
      severity: 'success',
      title: 'Client online',
      message: 'LX-1 came online.',
    },
    {
      type: 'offline',
      severity: 'error',
      title: 'Client offline',
      message: 'LX-1 went offline.',
    },
    {
      type: 'info',
      severity: 'info',
      title: 'General alert',
      message: 'Default alert icon and accent.',
    },
  ];
  for (const alert of trayAlerts) {
    steps.push(() => AddAlert(alert));
  }

  // Stagger so each animates in and stacks cleanly rather than landing at once.
  steps.forEach((fn, i) => setTimeout(fn, i * 100));
}
