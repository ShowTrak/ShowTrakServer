// Ambient global augmentation for the desktop renderer.
// Types the Electron preload bridge exposed at `window.API`.
//
// The authoritative contract (ShowTrakAPI) is defined in shared/src/preload.d.ts
// and implemented on the main side by src/bridge_main.ts. The renderer now
// consumes it directly (the former `Loosen<>` relaxation was removed in Phase 6
// of REFACTOR_PLAN.md once the return/subscribe types were tightened).
import type { ShowTrakAPI } from '@showtrak/protocol';
import type { ClientPatch } from '../js/app/lib/client-patches';

/**
 * Server-internal additions to the shared contract. These channels carry
 * messages that only the desktop window and the Web UI (which ship with the
 * server) ever receive, so they live here rather than in the protocol package
 * that external SDK consumers build against.
 */
interface ServerRendererAPI {
  /** Batched field-level client changes (see lib/client-patches). */
  ClientPatches(Callback: (Patches: ClientPatch[]) => void): () => void;
}

declare global {
  interface Window {
    API: ShowTrakAPI & ServerRendererAPI;
  }
}

export {};
