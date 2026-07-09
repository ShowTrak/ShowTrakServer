// Ensure the QRCode library is loaded; if missing, load the vendor script dynamically.
// Leaf module: must not import from any app module (04-utils depends on it).
export function ensureQRCodeLib() {
  return new Promise<void>((resolve) => {
    try {
      if (typeof window !== 'undefined' && typeof window.QRCode !== 'undefined') return resolve();
      // Attempt to load from the same path used in index.html
      const existing = document.querySelector('script[data-dyn="qrcode"]');
      if (existing) {
        // If already loading, poll a bit until available
        let tries = 0;
        const timer = setInterval(() => {
          tries++;
          if (typeof window !== 'undefined' && typeof window.QRCode !== 'undefined') {
            clearInterval(timer);
            return resolve();
          }
          if (tries > 50) {
            clearInterval(timer);
            return resolve();
          }
        }, 50);
        return;
      }
      const s = document.createElement('script');
      s.src = './vendors/qrcode/qrcode.min.js';
      s.async = false;
      s.dataset.dyn = 'qrcode';
      s.onload = () => resolve();
      s.onerror = () => resolve();
      document.head.appendChild(s);
    } catch {
      resolve();
    }
  });
}
