// Ctrl +/- / Ctrl+0 zoom for platforms that run menu-less.
//
// On macOS the `viewMenu` role in ./app-menu binds zoomIn/zoomOut/resetZoom for
// us. Everywhere else ShowTrak clears the application menu, so those accelerators
// never exist and the keys do nothing. This binds them on the window itself via
// `before-input-event`, which fires in the main process before the renderer sees
// the key, so the shortcuts work regardless of which element has focus.
import type { BrowserWindow as ElectronBrowserWindow } from 'electron';

// Chromium zoom levels are exponential (each whole level is a 1.2x factor). A
// half-level step gives ~10% increments, which is finer than Chrome's default
// ladder but matches what the ShowTrak UI's breakpoints tolerate. The bounds keep
// the window usable: below -2 the text is unreadable, above 3 the 1108px minimum
// width layout starts clipping.
const ZOOM_LEVEL_MIN = -2;
const ZOOM_LEVEL_MAX = 3;
const ZOOM_LEVEL_STEP = 0.5;

// Zoom delta for a key press, or null if the key isn't a zoom shortcut.
// Both the main row and the numpad are covered: Ctrl+Plus arrives as '+' on
// numpad and shift+'=' on the main row, and browsers conventionally accept the
// unshifted '=' too.
function zoomDeltaForKey(key: string, code: string): number | null {
  if (key === '+' || key === '=' || code === 'NumpadAdd') return ZOOM_LEVEL_STEP;
  if (key === '-' || key === '_' || code === 'NumpadSubtract') return -ZOOM_LEVEL_STEP;
  return null;
}

function clampZoomLevel(level: number): number {
  return Math.min(ZOOM_LEVEL_MAX, Math.max(ZOOM_LEVEL_MIN, level));
}

interface KeyboardInput {
  type: string;
  key: string;
  code: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
}

function applyWindowZoomShortcuts(windowInstance: ElectronBrowserWindow): void {
  if (!windowInstance || windowInstance.isDestroyed()) return;
  // macOS already has these on the native menu bar; binding them here as well
  // would double-apply the step when the menu accelerator also fires.
  if (process.platform === 'darwin') return;

  windowInstance.webContents.on(
    'before-input-event',
    (event: { preventDefault(): void }, input: KeyboardInput) => {
      if (input.type !== 'keyDown') return;
      // Ctrl (not Ctrl+Alt, which is AltGr on many non-US layouts and types real
      // characters). Shift is allowed through: Ctrl+Shift+'=' is how '+' is typed.
      if (!input.control || input.alt || input.meta) return;

      const { webContents } = windowInstance;

      if (input.key === '0' || input.code === 'Numpad0') {
        webContents.setZoomLevel(0);
        event.preventDefault();
        return;
      }

      const delta = zoomDeltaForKey(input.key, input.code);
      if (delta === null) return;

      webContents.setZoomLevel(clampZoomLevel(webContents.getZoomLevel() + delta));
      event.preventDefault();
    }
  );
}

export { applyWindowZoomShortcuts, ZOOM_LEVEL_MIN, ZOOM_LEVEL_MAX };
