// Ambient declarations for the desktop renderer's vendored global libraries.
// These are loaded via <script> tags in src/UI/index.html (offline, no bundling)
// and referenced as globals throughout the renderer. jQuery ($) is typed via
// @types/jquery (tsconfig.renderer.json `types: ["jquery"]`).
//
// The interfaces below are intentionally *minimal* — they cover only the surface
// the renderer actually touches, not the vendors' full public API.

// ---- Howler (audio) -------------------------------------------------------

interface HowlOptions {
  src: string[];
  volume?: number;
  loop?: boolean;
  preload?: boolean;
  html5?: boolean;
}

interface Howl {
  play(): number;
  stop(): this;
  pause(): this;
  volume(value?: number): number | this;
  fade(from: number, to: number, duration: number): this;
}

interface HowlConstructor {
  new (options: HowlOptions): Howl;
}

declare const Howl: HowlConstructor;
declare const Howler: { volume(value?: number): number; mute(muted: boolean): void };

// ---- QRCode ---------------------------------------------------------------

interface QRCodeInstance {
  createDataURL(cellSize?: number, margin?: number): string;
}

interface QRCodeConstructor {
  new (element: Element | null, options: { text: string }): QRCodeInstance;
}

declare const QRCode: QRCodeConstructor;

// ---- Toastify -------------------------------------------------------------

interface ToastifyInstance {
  showToast(): void;
  hideToast(): void;
}

interface ToastifyConstructor {
  (options: Record<string, unknown>): ToastifyInstance;
}

declare const Toastify: ToastifyConstructor;

// ---- Bootstrap ------------------------------------------------------------

interface BootstrapComponent {
  show(): void;
  hide(): void;
  toggle(): void;
  dispose(): void;
}

interface BootstrapComponentConstructor {
  new (element: Element | null, options?: Record<string, unknown>): BootstrapComponent;
  getInstance(element: Element | null): BootstrapComponent | null;
  getOrCreateInstance(
    element: Element | null,
    options?: Record<string, unknown>
  ): BootstrapComponent;
}

declare const bootstrap: {
  Modal: BootstrapComponentConstructor;
  Collapse: BootstrapComponentConstructor;
  Popover: BootstrapComponentConstructor;
  Tooltip: BootstrapComponentConstructor;
  Tab: BootstrapComponentConstructor;
};

// Bootstrap's jQuery plugin bridge (not covered by @types/jquery).
interface JQuery<TElement = HTMLElement> {
  modal(action?: unknown): JQuery<TElement>;
  popover(action?: unknown): JQuery<TElement>;
  collapse(action?: unknown): JQuery<TElement>;
  tooltip(action?: unknown): JQuery<TElement>;
  tab(action?: unknown): JQuery<TElement>;
}

// ---- Renderer-scoped window globals ---------------------------------------

/** FLIP animation helper attached by 00-animations. */
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
  /** FLIP animation helper attached by 00-animations. */
  ShowTrakFlip?: ShowTrakFlipApi;
  /** QR code constructor (vendored, optionally lazy-loaded). */
  QRCode?: QRCodeConstructor;
  /** Safari/legacy AudioContext constructor. */
  webkitAudioContext?: typeof AudioContext;

  // Renderer-scoped `__`-prefixed globals (capabilities, guard flags, timers,
  // caches). Previously a blanket `[key: \`__${string}\`]: any` index signature.
  /** Web UI capability profile injected by the browser bootstrap. */
  __SHOWTRAK_CAPS__?: Record<string, unknown>;
  // __SHOWTRAK_CONFIRM_ACTIVE and __CLIENT_ONLINE_STATE were folded into the
  // 01-state module (ConfirmDialogActive / ClientOnlineState) and are no longer
  // window globals.
  /** Selected address family in the open client-info modal. */
  __ClientInfoNetFamily?: 'IPv4' | 'IPv6';
  /** Auto-dismiss timer handle for the execution toast. */
  __ShowTrakExecutionAutoDismissTimer?: ReturnType<typeof setTimeout> | null;
  /** Auto-dismiss timer handle for the deployment banner. */
  __ShowTrakDeploymentAutoDismissTimer?: ReturnType<typeof setTimeout> | null;
  /** Cached deployment banner state (survives partial re-renders). */
  __ShowTrakDeploymentUiState?: ShowTrakDeploymentUiState;
}
