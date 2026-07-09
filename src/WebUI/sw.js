// Offline splash service worker.
//
// The Web UI itself still bootstraps directly from the network (no app-shell
// caching, so stale bundles can never serve an outdated startup path). The
// worker exists for exactly one situation: navigating to the Web UI while
// ShowTrak Server is unreachable. Instead of the browser's error page it
// serves an embedded splash that shows "Connecting…" while it probes the
// server, escalates to "Unable to Connect" after repeated failures, and
// reloads back into the real app as soon as the server answers.
//
// Only the splash logo is precached (the splash inlines everything else), so
// the cache can never affect how the live app loads.

const CACHE_NAME = 'showtrak-sw-v1';
// Kept fresh opportunistically whenever the live app fetches it (see the asset
// handler below), so the splash logo tracks branding changes.
const PRECACHE_PATHS = ['/img/icon-filled.png'];

// How long a navigation may stay pending before the splash takes over. A dead
// host on a LAN often refuses instantly, but an unreachable/asleep one can
// hang for a minute or more — far too long to show a white page.
const NAVIGATION_TIMEOUT_MS = 8000;

const OFFLINE_SPLASH = `<!doctype html>
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
    <img class="splash-logo" src="/img/icon-filled.png" alt="ShowTrak" onerror="this.style.display='none'" />
    <div id="SPLASH_CONNECTING" class="splash-state" role="status" aria-live="polite">
      <div class="spinner" aria-hidden="true"></div>
      <div class="splash-text">Connecting&hellip;</div>
    </div>
    <div id="SPLASH_FAILED" class="splash-state" role="alert">
      <div class="splash-title">Unable to Connect</div>
      <div class="splash-text">
        ShowTrak Server is offline or unreachable.<br />
        This page will reconnect automatically.
      </div>
      <div class="splash-retry">
        <span class="spinner" aria-hidden="true"></span>
        Waiting for the server&hellip;
      </div>
    </div>
    <script>
      (() => {
        // Probe quickly during the "Connecting…" phase; after CONNECT_ATTEMPTS
        // consecutive failures switch to "Unable to Connect" and keep probing
        // at a slower cadence until the server answers, then re-enter the app.
        const CONNECT_ATTEMPTS = 5;
        const CONNECT_INTERVAL_MS = 2000;
        const RETRY_INTERVAL_MS = 4000;
        let failures = 0;
        async function probe() {
          try {
            // Any HTTP response (even an error status) means the server is up.
            await fetch('/', { cache: 'no-store' });
            location.replace('/');
          } catch {
            failures += 1;
            if (failures >= CONNECT_ATTEMPTS) document.body.classList.add('failed');
            setTimeout(probe, failures >= CONNECT_ATTEMPTS ? RETRY_INTERVAL_MS : CONNECT_INTERVAL_MS);
          }
        }
        probe();
      })();
    </script>
  </body>
</html>`;

function splashResponse() {
  return new Response(OFFLINE_SPLASH, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// Fetch by URL rather than re-using the navigation Request object: passing a
// navigate-mode Request back to fetch() with init overrides misbehaves on some
// engines, and the URL form keeps query strings while forcing revalidation.
// `redirect: 'manual'` because navigation requests only accept redirect-type
// (or non-redirected) responses; the browser follows the opaqueredirect itself.
function fetchNavigation(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NAVIGATION_TIMEOUT_MS);
  return fetch(url, {
    cache: 'no-store',
    credentials: 'include',
    redirect: 'manual',
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      // Best-effort: the splash hides its logo if the image is unavailable.
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.addAll(PRECACHE_PATHS);
      } catch {
        /* splash still works without the logo */
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: network with a timeout, offline splash as the fallback.
  if (request.mode === 'navigate') {
    event.respondWith(fetchNavigation(request.url).catch(() => splashResponse()));
    return;
  }

  // Everything else: straight to the network. Successful fetches of precached
  // paths refresh the cache; failures fall back to it (that is how the splash
  // gets its logo while the server is down).
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);
        if (response.ok && PRECACHE_PATHS.includes(url.pathname)) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, response.clone());
        }
        return response;
      } catch (err) {
        const cached = await caches.match(request);
        if (cached) return cached;
        throw err;
      }
    })()
  );
});
