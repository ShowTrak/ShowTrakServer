// Offline splash service worker.
//
// The Web UI itself still bootstraps directly from the network (no app-shell
// caching, so stale bundles can never serve an outdated startup path). The
// worker exists for exactly one situation: navigating to the Web UI while
// ShowTrak Server is unreachable. Instead of the browser's error page it
// serves an embedded splash (./offline-splash.ts) that shows "Connecting..."
// while it probes the server, escalates to "Unable to Connect" after repeated
// failures, and reloads back into the real app as soon as the server answers.
//
// Only the splash logo is precached (the splash inlines everything else), so
// the cache can never affect how the live app loads.
//
// Bundled by esbuild to dist/WebUI/sw.js, served at /sw.js (scripts/build-renderer.js),
// and typechecked with the WebWorker library only (tsconfig.service-worker.json).
import { OFFLINE_SPLASH } from './offline-splash';

// The worker's global scope. The WebWorker library types `self` as a plain
// worker; this file only ever runs as a service worker.
declare const self: ServiceWorkerGlobalScope;

const CACHE_NAME = 'showtrak-sw-v1';
// Kept fresh opportunistically whenever the live app fetches it (see the asset
// handler below), so the splash logo tracks branding changes.
const PRECACHE_PATHS = ['/img/icon-filled.png'];

// How long a navigation may stay pending before the splash takes over. A dead
// host on a LAN often refuses instantly, but an unreachable/asleep one can
// hang for a minute or more, far too long to show a white page.
const NAVIGATION_TIMEOUT_MS = 8000;

function splashResponse(): Response {
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
function fetchNavigation(url: string): Promise<Response> {
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
