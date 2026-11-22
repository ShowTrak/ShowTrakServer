// Page script of the splash (preloader) window, src/UI/preloader.html: writes the
// app's name and version under the logo.
//
// Bundled by esbuild to dist/UI/preloader.js (scripts/build-renderer.js), the
// path the page loads, and typechecked on its own by tsconfig.preloader.json:
// this window's `window.API` is the splash bridge (src/bridge_preloader.ts), not
// the main window's, so it must not share the renderer's global declarations.
import type { PreloaderAPI } from '../types/preloader-api';

declare global {
  interface Window {
    API: PreloaderAPI;
  }
}

async function Init(): Promise<void> {
  const Config = await window.API.GetConfig();
  const Footer = document.getElementById('FOOTER');
  if (!Footer) return;
  if (Config && Config.Application && Config.Application.Version && Config.Application.Name) {
    Footer.innerText = `${Config.Application.Name} v${Config.Application.Version}`;
  } else {
    Footer.innerText = 'ShowTrak Server';
  }
}
void Init();
