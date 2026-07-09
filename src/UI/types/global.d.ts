// Ambient global augmentation for the desktop renderer.
// Types the Electron preload bridge exposed at `window.API`.
//
// The authoritative contract (ShowTrakAPI) is defined in shared/src/preload.d.ts
// and implemented on the main side by src/bridge_main.ts. The renderer now
// consumes it directly (the former `Loosen<>` relaxation was removed in Phase 6
// of REFACTOR_PLAN.md once the return/subscribe types were tightened).
import type { ShowTrakAPI } from '@showtrak/protocol';

declare global {
  interface Window {
    API: ShowTrakAPI;
  }
}

export {};
