// Ambient declarations for the desktop renderer's own window globals.
//
// The vendored libraries it loads with <script> tags (offline, no bundling) are
// typed elsewhere: jQuery ($) by @types/jquery (tsconfig.renderer.json `types:
// ["jquery"]`), Bootstrap (and its jQuery plugin bridge) and Howler by the
// renderer kit's shared/src/ui/vendors.d.ts, which the renderer programs include
// and ShowTrak Timers shares. Declaring them here again would clash.

// ---- Renderer-scoped window globals ---------------------------------------

/** FLIP animation helper attached by animations.ts. */
interface ShowTrakFlipApi {
  Enabled: () => boolean;
  Capture: (root: Element | null) => unknown;
  Play: (root: Element | null, previous: unknown) => void;
  AnimateReflow: (root: Element | null, renderFn: () => void) => void;
}

/** Deployment progress banner state cached on `window` across re-renders. */
interface ShowTrakDeploymentUiState {
  summary: {
    total: number;
    successful: number;
    failed: number;
    finished: boolean;
    pending: number;
    percent: number;
  } | null;
  requests: unknown[];
  holdUntil: number;
  hadRenderableDeployment: boolean;
}

interface Window {
  /** FLIP animation helper attached by animations.ts. */
  ShowTrakFlip?: ShowTrakFlipApi;
  /** Safari/legacy AudioContext constructor. */
  webkitAudioContext?: typeof AudioContext;

  // Renderer-scoped `__`-prefixed globals (capabilities, guard flags, timers,
  // caches). Previously a blanket `[key: \`__${string}\`]: any` index signature.
  /** Web UI capability profile injected by the browser bootstrap. */
  __SHOWTRAK_CAPS__?: Record<string, unknown>;
  // __SHOWTRAK_CONFIRM_ACTIVE and __CLIENT_ONLINE_STATE were folded into the
  // state modules (ConfirmDialogActive / ClientOnlineState) and are no longer
  // window globals.
  /** Auto-dismiss timer handle for the execution toast. */
  __ShowTrakExecutionAutoDismissTimer?: ReturnType<typeof setTimeout> | null;
  /** Auto-dismiss timer handle for the deployment banner. */
  __ShowTrakDeploymentAutoDismissTimer?: ReturnType<typeof setTimeout> | null;
  /** Cached deployment banner state (survives partial re-renders). */
  __ShowTrakDeploymentUiState?: ShowTrakDeploymentUiState;
}
