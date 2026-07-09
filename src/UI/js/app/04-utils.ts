import { ensureQRCodeLib } from './lib/qrcode-loader';
import { openModal } from './lib/modal';
// Side-effect import kept to preserve the historical module evaluation order
// (14-selection-init runs Init() and subscription wiring at import time until
// Phase 7 of REFACTOR_PLAN.md).
import './14-selection-init';

// Escape a value for interpolation into HTML. Escapes all five significant
// entities (ampersand first), so the result is safe in text content AND in
// double- or single-quoted attribute values.
export function Safe(Input: unknown): string | boolean | null | undefined | unknown[] {
  if (typeof Input === 'string') {
    return Input.replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  if (typeof Input === 'number') {
    return Input.toString();
  }
  if (Array.isArray(Input)) {
    return Input.map(Safe);
  }
  if (Input === null || Input === undefined || typeof Input === 'boolean') {
    return Input;
  }
  // Objects/functions have no meaningful HTML form; stringify defensively so
  // they can never carry markup through an interpolation.
  return Safe(String(Input));
}

// Extract a human-readable message from an unknown thrown value (catch clauses
// are typed `unknown`). Falls back to a caller-supplied default, then String().
export function ErrorMessage(Err: unknown, Fallback = ''): string {
  if (Err && typeof Err === 'object' && 'message' in Err) {
    const Message = (Err as { message?: unknown }).message;
    if (typeof Message === 'string' && Message.length > 0) return Message;
  }
  if (Fallback) return Fallback;
  return String(Err);
}

export function HandleNonFatalError(Context: unknown, Error: unknown = null) {
  try {
    const Label = Context ? `[NonFatal] ${Context}` : '[NonFatal]';
    if (Error) {
      console.warn(Label, Error);
      return;
    }
    console.warn(Label);
  } catch {
    /* intentional: this is the last-resort error reporter; it must never throw */
  }
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
    // Ensure QRCode library is present (load dynamically if needed)
    await ensureQRCodeLib();
    const modalId = 'SHOWTRAK_QR_MODAL';
    let $modal = $('#' + modalId);
    if ($modal.length === 0) {
      $('body').append(`
        <div class="modal fade" id="${modalId}" tabindex="-1" aria-hidden="true">
          <div class="modal-dialog modal-sm modal-dialog-centered">
            <div class="modal-content">
              <div class="modal-body text-center">
                <div class="d-flex justify-content-center"><img class="SHOWTRAK_MODEL_CORE_LOGO" src="./img/icon.png" alt="ShowTrak Logo" /></div>
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
    // Render QR
    const $canvas = $('#SHOWTRAK_QR_CANVAS');
    $canvas.html('');
    try {
      // Resolve QRCode constructor from global
      let QR = null;
      if (typeof window !== 'undefined' && typeof window.QRCode !== 'undefined') QR = window.QRCode;
      else if (typeof QRCode !== 'undefined') QR = QRCode;
      if (!QR) throw new Error('qr-lib-missing');
      // Preferred: let the library append an <img> to the container element
      const el = $canvas.get(0);
      if (!el) throw new Error('qr-container-missing');
      // Append QR image
      new QR(el, { text: String(url) });
      // Force size for consistency
      const img = $canvas.find('img').get(0);
      if (img) {
        img.width = 220;
        img.height = 220;
        img.alt = 'QR code';
      } else {
        // Fallback: generate data URL manually if no image was appended
        const gen = new QR(null, { text: String(url) });
        const dataUrl = gen.createDataURL(4, 4);
        const im2 = document.createElement('img');
        im2.src = dataUrl;
        im2.alt = 'QR code';
        im2.width = 220;
        im2.height = 220;
        $canvas.append(im2);
      }
    } catch (e) {
      // Hard failure: show a short notice (no clickable link)
      HandleNonFatalError('ShowQRModal:Render', e);
      $canvas.html(`<div class="text-muted small">Unable to generate QR code</div>`);
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
