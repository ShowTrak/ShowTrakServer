// The offline splash page that the service worker (./sw.ts) serves for a
// navigation while ShowTrak Server is unreachable. It shows "Connecting..."
// while it probes the server, escalates to "Unable to Connect" after repeated
// failures, and reloads back into the real app as soon as the server answers.
//
// The page inlines everything it needs except the logo (which the worker
// precaches). Its script is the typed function RunOfflineSplash below, embedded
// into the markup as source text (Function.prototype.toString) and run by the
// page, not by the worker. That makes it subject to one rule: it must be
// self-contained, using only its parameters, its own locals and JavaScript
// built-ins, never anything else from this module or the bundle around it.
// test/webui-service-worker.test.js runs the embedded script in an empty vm
// context to prove it. esbuild's keepNames would break the rule by wrapping
// nested functions in a bundle-level __name() helper, so the worker is bundled
// without it (scripts/build-renderer.js).

/** How the splash page probes the server. */
export interface SplashProbeTiming {
  /** Consecutive failed probes before "Connecting..." gives way to "Unable to Connect". */
  ConnectAttempts: number;
  /** Delay between probes while "Connecting..." shows. */
  ConnectIntervalMs: number;
  /** Delay between probes once "Unable to Connect" shows. */
  RetryIntervalMs: number;
}

// Probe quickly during the "Connecting..." phase; after ConnectAttempts
// consecutive failures switch to "Unable to Connect" and keep probing at a
// slower cadence until the server answers, then re-enter the app.
export const SPLASH_PROBE_TIMING: SplashProbeTiming = {
  ConnectAttempts: 5,
  ConnectIntervalMs: 2000,
  RetryIntervalMs: 4000,
};

/** As much of the splash logo's <img> element as the page script uses. */
export interface SplashLogo {
  readonly complete: boolean;
  readonly naturalWidth: number;
  readonly style: { display: string };
  addEventListener(type: 'error', listener: () => void): void;
}

/**
 * The parts of the splash page's `window` that its script uses. Declared here
 * rather than taken from the DOM's types because this module is compiled with
 * the service worker (tsconfig.service-worker.json), where the DOM does not
 * exist; a worker must not see it.
 */
export interface SplashWindow {
  fetch(input: string, init: RequestInit): Promise<unknown>;
  readonly location: { replace(url: string): void };
  readonly document: {
    readonly body: { readonly classList: { add(token: string): void } };
    querySelector(selectors: string): SplashLogo | null;
  };
  setTimeout(handler: () => void, timeout: number): unknown;
}

/**
 * The splash page's script, run by the page with its `window`. It must stay
 * self-contained: see the note at the top of this file.
 */
export function RunOfflineSplash(page: SplashWindow, timing: SplashProbeTiming): void {
  // Without the logo (the precache is best-effort) the image is hidden rather
  // than shown broken. It can have failed before this script runs, so check as
  // well as listen.
  const logo = page.document.querySelector('.splash-logo');
  if (logo) {
    const hide = () => {
      logo.style.display = 'none';
    };
    logo.addEventListener('error', hide);
    if (logo.complete && logo.naturalWidth === 0) hide();
  }

  let failures = 0;
  async function probe(): Promise<void> {
    try {
      // Any HTTP response (even an error status) means the server is up.
      await page.fetch('/', { cache: 'no-store' });
      page.location.replace('/');
    } catch {
      failures += 1;
      if (failures >= timing.ConnectAttempts) page.document.body.classList.add('failed');
      page.setTimeout(
        probe,
        failures >= timing.ConnectAttempts ? timing.RetryIntervalMs : timing.ConnectIntervalMs
      );
    }
  }
  void probe();
}

// The page's whole script: the function above, called with the page's window.
const SPLASH_SCRIPT = `(${RunOfflineSplash.toString()})(window, ${JSON.stringify(SPLASH_PROBE_TIMING)});`;

export const OFFLINE_SPLASH = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#6d5bd0" />
    <title>ShowTrak</title>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      html, body { height: 100%; }
      body {
        font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
        background: radial-gradient(circle at 50% 80%, #151232 0%, #0c091c 100%);
        color: #f2f4f7;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 24px;
        text-align: center;
      }
      .splash-logo {
        position: absolute;
        top: calc(20px + env(safe-area-inset-top, 0px));
        left: 50%;
        transform: translateX(-50%);
        width: 44px;
        height: 44px;
        border-radius: 10px;
      }
      .spinner {
        width: 2rem;
        height: 2rem;
        border: 0.25em solid currentColor;
        border-right-color: transparent;
        border-radius: 50%;
        animation: splash-spin 0.75s linear infinite;
      }
      @keyframes splash-spin {
        to { transform: rotate(360deg); }
      }
      .splash-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
      }
      .splash-title { font-size: 1.25rem; font-weight: 600; }
      .splash-text { font-size: 0.9rem; color: #aab2bd; }
      .splash-retry {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 10px;
        font-size: 0.8rem;
        color: #aab2bd;
      }
      .splash-retry .spinner { width: 0.9rem; height: 0.9rem; border-width: 2px; }
      #SPLASH_FAILED { display: none; }
      body.failed #SPLASH_CONNECTING { display: none; }
      body.failed #SPLASH_FAILED { display: flex; }
    </style>
  </head>
  <body>
    <img class="splash-logo" src="/img/icon-filled.png" alt="ShowTrak" />
    <div id="SPLASH_CONNECTING" class="splash-state" role="status" aria-live="polite">
      <div class="spinner" aria-hidden="true"></div>
      <div class="splash-text">Connecting...</div>
    </div>
    <div id="SPLASH_FAILED" class="splash-state" role="alert">
      <div class="splash-title">Unable to Connect</div>
      <div class="splash-text">
        ShowTrak Server is offline or unreachable.<br />
        This page will reconnect automatically.
      </div>
      <div class="splash-retry">
        <span class="spinner" aria-hidden="true"></span>
        Waiting for the server...
      </div>
    </div>
    <script>
      ${SPLASH_SCRIPT}
    </script>
  </body>
</html>`;
