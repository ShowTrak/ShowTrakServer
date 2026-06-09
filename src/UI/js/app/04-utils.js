function Safe(Input) {
  if (typeof Input === 'string') {
    return Input.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  if (typeof Input === 'number') {
    return Input.toString();
  }
  if (Array.isArray(Input)) {
    return Input.map(Safe);
  }
  return Input;
}

// Show QR modal for a given URL
async function ShowQRModal(url) {
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
    $('#SHOWTRAK_QR_URL').text(url);
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
      $canvas.html(`<div class="text-muted small">Unable to generate QR code</div>`);
    }
    // Show modal
    const modal = new bootstrap.Modal(document.getElementById(modalId));
    modal.show();
  } catch {}
}

// Format bytes into a short human-readable string (e.g., 15.2 GB)
function FormatBytes(bytes) {
  const n = typeof bytes === 'number' ? bytes : parseFloat(bytes);
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

