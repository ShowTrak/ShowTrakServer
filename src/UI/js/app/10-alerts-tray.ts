import { Safe } from './04-utils';
// Side-effect import kept to preserve the historical module evaluation order
// (subscription wiring happens at import time until Phase 7 of REFACTOR_PLAN.md).
import './11-modals';
import { RemoveAlertToastById, showAlertStyleToast } from './14-selection-init';
// --- Alerts Manager ---
/** A single entry in the alerts tray. */
interface Alert {
  id: string;
  type: string;
  severity: string;
  title: string;
  message: string;
  clientUUID: string | null;
  iconHtml: string | null;
  time: number;
  dismissed: boolean;
}

/** Input accepted by {@link AddAlert}; every field is optional and defaulted. */
interface AddAlertInput {
  type?: string;
  severity?: string;
  title?: string;
  message?: string;
  clientUUID?: string | null;
  iconHtml?: string | null;
}

export const Alerts: Alert[] = [];
export let AlertsVisible = false;
// Track adoption alerts per device UUID so we can auto-dismiss
export const PendingAdoptionAlerts = new Map<string, string>();

export function AddAlert({
  type = 'info',
  severity = 'info',
  title = '',
  message = '',
  clientUUID = null,
  iconHtml = null,
}: AddAlertInput) {
  const alert = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    severity,
    title,
    message,
    clientUUID,
    iconHtml,
    time: Date.now(),
    dismissed: false,
  };
  Alerts.unshift(alert);
  UpdateAlertsIndicator();
  if (AlertsVisible) RenderAlerts();
  // Also show a top-center toast linked to this alert
  showAlertStyleToast({
    id: alert.id,
    title: alert.title || 'Alert',
    message: alert.message || '',
    type: alert.severity || alert.type || 'info',
    duration: 6000,
    linkAlert: true,
    iconHtml: alert.iconHtml,
  });
  return alert.id;
}

export function DismissAlert(id: string | undefined) {
  const a = Alerts.find((x) => x.id === id);
  if (a) {
    a.dismissed = true;
  }
  UpdateAlertsIndicator();
  if (AlertsVisible) RenderAlerts();
  // Remove matching toast, if present
  RemoveAlertToastById(id);
}

export function DismissAllAlerts() {
  Alerts.forEach((a) => (a.dismissed = true));
  UpdateAlertsIndicator();
  if (AlertsVisible) RenderAlerts();
}

export function UndismissedCount() {
  return Alerts.filter((a) => !a.dismissed).length;
}

export function UpdateAlertsIndicator() {
  const count = UndismissedCount();
  const btn = document.getElementById('ALERTS_BUTTON');
  if (!btn) return;
  const badge = btn.querySelector('.alerts-count');
  if (badge) {
    if (count > 0) {
      badge.textContent = String(count);
      badge.classList.remove('d-none');
    } else {
      badge.classList.add('d-none');
    }
  }
  if (count > 0) btn.classList.add('has-alerts');
  else btn.classList.remove('has-alerts');
}

export function iconForAlert(a: { type?: string; iconHtml?: string | null }) {
  if (a && a.iconHtml) return a.iconHtml;
  if (a.type === 'usb') return '<i class="bi bi-usb-symbol"></i>';
  if (a.type === 'online') return '<i class="bi bi-wifi"></i>';
  if (a.type === 'offline') return '<i class="bi bi-wifi-off"></i>';
  return '<i class="bi bi-exclamation-circle"></i>';
}

export function timeAgo(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function RenderAlerts() {
  const tray = document.getElementById('ALERTS_TRAY');
  const list = document.getElementById('ALERTS_LIST');
  if (!tray || !list) return;
  const items = Alerts.filter((a) => !a.dismissed);
  if (items.length === 0) {
    list.innerHTML = `<div class="text-muted p-2 text-center">No alerts</div>`;
  } else {
    let html = '';
    for (const a of items) {
      html += `
      <div class="alert-item" data-id="${a.id}" data-severity="${Safe(String(a.severity || a.type || 'info').toLowerCase())}">
				<div class="alert-icon">${iconForAlert(a)}</div>
				<div class="alert-content">
					<div><strong>${Safe(a.title || 'Alert')}</strong></div>
					${a.message ? `<div class="alert-meta">${Safe(a.message)}</div>` : ''}
				</div>
				<div class="alert-dismiss">
					<small class="alert-meta">${timeAgo(a.time)}</small>
					<button class="btn-dismiss" title="Dismiss" aria-label="Dismiss">✕</button>
				</div>
			</div>`;
    }
    list.innerHTML = html;
    // Bind dismiss buttons
    $(list)
      .find('.alert-item .btn-dismiss')
      .off('click')
      .on('click', function () {
        const id = $(this).closest('.alert-item').attr('data-id');
        DismissAlert(id);
      });
  }
}

export function ToggleAlertsTray(force?: boolean) {
  const tray = document.getElementById('ALERTS_TRAY');
  if (!tray) return;
  const next = typeof force === 'boolean' ? force : !AlertsVisible;
  AlertsVisible = next;
  if (AlertsVisible) {
    tray.hidden = false;
    RenderAlerts();
    // Outside click to close
    $(document)
      .off('mousedown.alerts touchstart.alerts')
      .on('mousedown.alerts touchstart.alerts', function (e) {
        const inside = $(e.target).closest('#ALERTS_TRAY, #ALERTS_BUTTON').length > 0;
        if (!inside) ToggleAlertsTray(false);
      });
  } else {
    tray.hidden = true;
    $(document).off('mousedown.alerts touchstart.alerts');
  }
}

// Formerly a DOMContentLoaded handler; called by the bootstrap orchestrator in
// main.ts once the DOM is parsed — never at import time.
export function InitAlertsTray() {
  const btn = document.getElementById('ALERTS_BUTTON');
  if (btn && !btn.dataset.bound) {
    btn.addEventListener('click', () => ToggleAlertsTray());
    btn.dataset.bound = '1';
  }
  const disAll = document.getElementById('ALERTS_DISMISS_ALL');
  if (disAll && !disAll.dataset.bound) {
    disAll.addEventListener('click', () => {
      DismissAllAlerts();
    });
    disAll.dataset.bound = '1';
  }
}
