import { QrToSvg } from '@showtrak/protocol/ui/qr-svg';
import { HandleNonFatalError } from '@showtrak/protocol/ui/errors';
import { openModal } from './lib/modal';
import { Settings } from './state';

// The renderer's HTML escaper and error helpers are the renderer kit's, shared
// with ShowTrak Timers, and re-exported here for the modules that import them
// from utils.
export { Safe } from '@showtrak/protocol/ui/html';
export { ErrorMessage, HandleNonFatalError } from '@showtrak/protocol/ui/errors';

// Master alert volume as a 0..1 multiplier, read live from the current settings
// snapshot (ALERT_SOUND_VOLUME, a 0-100 slider). Defaults to full volume when
// the setting is absent or malformed so alerts are never silently muted.
export function GetAlertVolume(): number {
  const Setting = Array.isArray(Settings)
    ? Settings.find((s) => s && s.Key === 'ALERT_SOUND_VOLUME')
    : null;
  if (!Setting) return 1;
  const Pct = Number(Setting.Value);
  if (!Number.isFinite(Pct)) return 1;
  return Math.min(1, Math.max(0, Pct / 100));
}

export async function WithNonFatal<T>(
  Context: unknown,
  Operation: () => T | Promise<T>,
  Fallback: T | null = null
): Promise<T | null> {
  try {
    return await Operation();
  } catch (Error) {
    HandleNonFatalError(Context, Error);
    return Fallback;
  }
}

// Show QR modal for a given URL
export async function ShowQRModal(url: string | undefined) {
  try {
    const modalId = 'SHOWTRAK_QR_MODAL';
    let $modal = $('#' + modalId);
    if ($modal.length === 0) {
      $('body').append(`
        <div class="modal fade" id="${modalId}" tabindex="-1" aria-hidden="true">
          <div class="modal-dialog modal-sm modal-dialog-centered">
            <div class="modal-content">
              <div class="modal-body text-center">
                <strong class="mb-1">Scan to Open</strong>
                <div id="SHOWTRAK_QR_CANVAS" class="d-flex justify-content-center my-2"></div>
                <div class="small text-muted" id="SHOWTRAK_QR_URL"></div>
                <div class="d-grid mt-2">
                  <button type="button" class="btn btn-light" data-bs-dismiss="modal">Close</button>
                </div>
              </div>
            </div>
          </div>
        </div>`);
      $modal = $('#' + modalId);
    }
    // Set URL text
    $('#SHOWTRAK_QR_URL').text(url ?? '');
    // Render QR as an inline SVG. This is pure in-process computation (no
    // external library, no dynamic script load, no canvas), so it works offline
    // and has no runtime dependencies to fail.
    const $canvas = $('#SHOWTRAK_QR_CANVAS');
    $canvas.html('');
    try {
      if (!url) throw new Error('qr-url-missing');
      // Set the SVG via innerHTML (not jQuery's $(string), which mis-namespaces
      // SVG elements so they don't render). The container is sized in CSS.
      const svg = QrToSvg(String(url), { border: 2, size: 220 });
      $canvas.html(svg);
    } catch (e) {
      // Hard failure: show a short notice (no clickable link)
      HandleNonFatalError('ShowQRModal:Render', e);
      $canvas.html(`<div class="text-muted small">Failed to generate QR code.</div>`);
    }
    // Show modal
    openModal(modalId);
  } catch (e) {
    HandleNonFatalError('ShowQRModal', e);
  }
}

// Format bytes into a short human-readable string (e.g., 15.2 GB)
export function FormatBytes(bytes: unknown) {
  const n = typeof bytes === 'number' ? bytes : parseFloat(String(bytes));
  if (!isFinite(n) || n < 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let idx = 0;
  let val = n;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  const precision = val >= 10 || idx === 0 ? 0 : 1; // keep 1 decimal for small MB/GB
  return `${val.toFixed(precision)} ${units[idx]}`;
}
