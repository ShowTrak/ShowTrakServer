// Development only: reload the window when the built renderer changes.
//
// `npm start` (scripts/dev.js) rebuilds dist/UI in place as the renderer
// sources, markup and CSS change. Reloading the page re-runs the renderer, which
// pulls fresh state through 'Loaded', while the main process (connected client
// sockets, monitoring loops, the open show) carries on untouched. Restarting
// Electron for a CSS tweak used to cost all of that.
//
// Inert unless scripts/dev.js set SHOWTRAK_DEV_RELOAD=1, and never in a
// packaged app.
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { CreateLogger } from '../Modules/Logger';
import { getMainWindow, hasMainWindow } from './app-window';

const Logger = CreateLogger('DevReload');

// A rebuild writes several files in quick succession; reload once they settle.
const SETTLE_MS = 250;

let Started = false;

export function StartDevReload(): void {
  if (Started || app.isPackaged || process.env.SHOWTRAK_DEV_RELOAD !== '1') return;
  Started = true;

  const Root = path.join(__dirname, '..', 'UI');
  let Timer: ReturnType<typeof setTimeout> | null = null;
  try {
    fs.watch(Root, { recursive: true }, () => {
      if (Timer) clearTimeout(Timer);
      Timer = setTimeout(() => {
        Timer = null;
        const Window = getMainWindow();
        if (Window && hasMainWindow()) {
          Logger.log('Renderer rebuilt; reloading the window');
          Window.webContents.reloadIgnoringCache();
        }
      }, SETTLE_MS);
    });
    Logger.log(`Watching ${Root} for renderer rebuilds`);
  } catch (Err) {
    Logger.warn('Could not watch the renderer output; reload the window manually.', Err);
  }
}
