// --- Alerts Manager ---
const Alerts = [];
let AlertsVisible = false;
// Track adoption alerts per device UUID so we can auto-dismiss
const PendingAdoptionAlerts = new Map();

function AddAlert({
  type = 'info',
  severity = 'info',
  title = '',
  message = '',
  clientUUID = null,
  iconHtml = null,
}) {
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

function DismissAlert(id) {
  const a = Alerts.find((x) => x.id === id);
  if (a) {
    a.dismissed = true;
  }
  UpdateAlertsIndicator();
  if (AlertsVisible) RenderAlerts();
  // Remove matching toast, if present
  RemoveAlertToastById(id);
}

function DismissAllAlerts() {
  Alerts.forEach((a) => (a.dismissed = true));
  UpdateAlertsIndicator();
  if (AlertsVisible) RenderAlerts();
}

function UndismissedCount() {
  return Alerts.filter((a) => !a.dismissed).length;
}

function UpdateAlertsIndicator() {
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

function iconForAlert(a) {
  if (a && a.iconHtml) return a.iconHtml;
  if (a.type === 'usb') return '<i class="bi bi-usb-symbol"></i>';
  if (a.type === 'online') return '<i class="bi bi-wifi"></i>';
  if (a.type === 'offline') return '<i class="bi bi-wifi-off"></i>';
  return '<i class="bi bi-exclamation-circle"></i>';
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function RenderAlerts() {
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

function ToggleAlertsTray(force) {
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

document.addEventListener('DOMContentLoaded', () => {
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
});

// window.API.SetDevicesPendingAdoption(async (Data) => {
//   let Filler = '';
//   for (const { Hostname, IP, UUID, Version, State } of Data) {
//     let VersionArr = Version.split('.');
//     let MyVersionArr = Config.Application.Version.split('.');

//     let VersionCompatible = true;
//     if (VersionArr[0] !== MyVersionArr[0]) VersionCompatible = false;
//     if (VersionArr[1] !== MyVersionArr[1]) VersionCompatible = false;

//     let ButtonState = ` <div class="d-flex flex-column justify-content-center gap-0">
//                 <a class="btn btn-light btn-sm" onclick="AdoptDevice('${UUID}')">Adopt</a>
//             </div>`;
//     if (!VersionCompatible) {
//       ButtonState = ` <div class="d-flex flex-column justify-content-center gap-0">
//                 <a class="btn btn-danger btn-sm disabled" disabled>Incompatible Version (v${Safe(Version)})</a>
//             </div>`;
//     }
//     if (State === 'Adopting') {
//       ButtonState = `<div class="d-flex flex-column justify-content-center gap-0">
//                 <button class="btn btn-secondary btn-sm" disabled>
//                 <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
//                     Adopting...
//                 </button>
//             </div>`;
//     }

//     Filler += `<div class="SHOWTRAK_CLIENT_PENDING_ADOPTION rounded-3 d-flex justify-content-between p-3" data-uuid="${UUID}">
//             <div class="d-flex flex-column justify-content-center gap-1 text-start">
//                 <h6 class="card-title mb-0">${Safe(Hostname)}</h6>
//                 <small class="text-muted">${Safe(IP)}</small>
//                 <small class="text-muted">${Safe(UUID)} - v${Safe(Version)}</small>
//             </div>
//             ${ButtonState}
//         </div>`;
//   }
//   if (Data.length === 0) {
//     Filler = `<div class="SHOWTRAK_CLIENT_PENDING_ADOPTION rounded-3 text-center text-muted p-3">No devices pending adoption</div>`;
//   }
//   $('#DEVICES_PENDING_ADOPTION').html(Filler);
// });

