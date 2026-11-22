// Ambient global augmentation for the desktop renderer.
// Types the Electron preload bridge exposed at `window.API`.
//
// The authoritative contract (ShowTrakAPI) is defined in shared/src/preload.d.ts
// and implemented on the main side by src/bridge_main.ts. The renderer
// consumes it directly, the desktop-and-Web-UI-only ClientPatches push included.
import type { ShowTrakAPI } from '@showtrak/protocol';

declare global {
  interface Window {
    API: ShowTrakAPI;
  }
}

export {};
