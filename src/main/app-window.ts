// Main-window ownership for the Electron main process.
//
// `src/main.ts` used to hold `MainWindow` as a module-local `let`, which meant
// every handler / broadcast subscriber that needed to guard against window
// teardown had to live in the same 2,600-line closure. Extracting the window
// reference behind get/set/has accessors lets the decomposed registrar and
// broadcast-bridge modules share it without a giant `deps` object, while main.ts
// remains the sole writer (it creates and tears down the BrowserWindow).

import type { BrowserWindow } from 'electron';
import { PushToRenderers } from './renderer-bus';

// The live BrowserWindow, or null before creation / after teardown. Callers that
// dereference the getter (`.webContents`/`.close()`) or hand it to Electron's
// `showMessageBox` guard with `hasMainWindow()` first (and assert / branch on the
// result), so the real value domain is expressed here rather than hidden behind `any`.
let MainWindow: BrowserWindow | null = null;

function getMainWindow(): BrowserWindow | null {
  return MainWindow;
}

function setMainWindow(window: BrowserWindow | null): void {
  MainWindow = window;
}

// True when a usable (non-destroyed) window exists. The canonical guard used
// before any webContents access or dialog parenting.
function hasMainWindow(): boolean {
  return !!MainWindow && !MainWindow.isDestroyed();
}

// Navbar/title sync when the open ShowTrak file path changes. Best-effort: the
// window may be mid-teardown, in which case the update is simply dropped.
function sendShowFileUpdated(filePath: string | null): void {
  try {
    if (hasMainWindow()) {
      PushToRenderers('ShowFileUpdated', filePath || null);
    }
  } catch {
    // Window may be mid-teardown; navbar update is non-critical.
  }
}

export { getMainWindow, setMainWindow, hasMainWindow, sendShowFileUpdated };
