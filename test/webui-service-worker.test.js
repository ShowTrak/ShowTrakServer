const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Covers the Web UI's offline-splash service worker (src/WebUI/sw.ts and
// src/WebUI/offline-splash.ts) through the bundle that is actually served,
// dist/WebUI/sw.js: it is run as a classic script in a vm context that stands in
// for a ServiceWorkerGlobalScope, and driven through its event listeners.
//
// The splash page's script is a function embedded into the splash markup as
// source text, so it has to run on its own in the page. The last tests run it in
// a context holding only the four page globals it may use: a bundle-level
// helper leaking into it (esbuild's keepNames __name(), for one) would throw.

const SW_BUNDLE = path.join(__dirname, '..', 'dist', 'WebUI', 'sw.js');
const ORIGIN = 'http://192.168.1.20:3000';
const CACHE_NAME = 'showtrak-sw-v1';
const LOGO = '/img/icon-filled.png';

// Lets every pending promise callback run.
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fakeCaches() {
  const stores = new Map();
  const log = [];
  const storeFor = (name) => {
    if (!stores.has(name)) {
      const entries = new Map();
      stores.set(name, {
        entries,
        addAll: async (paths) => {
          log.push(['addAll', name, [...paths]]);
          for (const p of paths) entries.set(p, `cached ${p}`);
        },
        put: async (request, response) => {
          log.push(['put', name, request.url, response]);
          entries.set(new URL(request.url).pathname, response);
        },
      });
    }
    return stores.get(name);
  };
  return {
    stores,
    log,
    api: {
      open: async (name) => {
        log.push(['open', name]);
        return storeFor(name);
      },
      keys: async () => [...stores.keys()],
      delete: async (name) => {
        log.push(['delete', name]);
        return stores.delete(name);
      },
      match: async (request) => {
        const pathname = new URL(request.url).pathname;
        for (const store of stores.values()) {
          if (store.entries.has(pathname)) return store.entries.get(pathname);
        }
        return undefined;
      },
    },
  };
}

// Runs the bundle against stubs. `fetch` is the network; timers are manual so
// the navigation timeout can be fired without waiting for it.
function loadWorker({ fetch = async () => new Response('ok') } = {}) {
  const listeners = new Map();
  const calls = [];
  const timers = [];
  const caches = fakeCaches();
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type, listener) => listeners.set(type, listener),
    skipWaiting: async () => calls.push('skipWaiting'),
    clients: { claim: async () => calls.push('claim') },
  };
  const context = vm.createContext({
    self,
    caches: caches.api,
    fetch: (...args) => {
      calls.push(['fetch', ...args]);
      return fetch(...args);
    },
    Response,
    URL,
    AbortController,
    setTimeout: (handler, ms) => {
      const timer = { handler, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      if (timer) timer.cleared = true;
    },
  });
  vm.runInContext(fs.readFileSync(SW_BUNDLE, 'utf8'), context, { filename: SW_BUNDLE });
  return { listeners, calls, timers, caches };
}

function extendableEvent() {
  const pending = [];
  return { pending, waitUntil: (promise) => pending.push(promise) };
}

// Dispatches a fetch event; resolves to the response the worker answered with,
// or to null when it left the request to the browser.
async function dispatchFetch(worker, { url, method = 'GET', mode = 'cors' }) {
  let answered = null;
  const request = { url, method, mode };
  worker.listeners.get('fetch')({ request, respondWith: (value) => (answered = value) });
  return answered === null ? null : answered;
}

async function splashFromWorker() {
  const worker = loadWorker({
    fetch: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  const response = await dispatchFetch(worker, { url: `${ORIGIN}/`, mode: 'navigate' });
  return response.text();
}

test('the worker registers install, activate and fetch listeners', () => {
  const worker = loadWorker();
  assert.deepEqual([...worker.listeners.keys()].sort(), ['activate', 'fetch', 'install']);
});

test('install precaches the splash logo, then activates at once', async () => {
  const worker = loadWorker();
  const event = extendableEvent();
  worker.listeners.get('install')(event);
  await Promise.all(event.pending);
  assert.deepEqual(worker.caches.log, [
    ['open', CACHE_NAME],
    ['addAll', CACHE_NAME, [LOGO]],
  ]);
  assert.deepEqual(worker.calls, ['skipWaiting']);
});

test('install still activates when the logo cannot be precached', async () => {
  const worker = loadWorker();
  worker.caches.api.open = async () => {
    throw new Error('quota exceeded');
  };
  const event = extendableEvent();
  worker.listeners.get('install')(event);
  await Promise.all(event.pending);
  assert.deepEqual(worker.calls, ['skipWaiting']);
});

test('activate drops every other cache and takes control of open pages', async () => {
  const worker = loadWorker();
  await worker.caches.api.open('showtrak-sw-v0');
  await worker.caches.api.open(CACHE_NAME);
  await worker.caches.api.open('unrelated');
  const event = extendableEvent();
  worker.listeners.get('activate')(event);
  await Promise.all(event.pending);
  assert.deepEqual([...worker.caches.stores.keys()], [CACHE_NAME]);
  assert.deepEqual(worker.calls, ['claim']);
});

test('requests other than same-origin GETs are left to the browser', async () => {
  const worker = loadWorker();
  assert.equal(await dispatchFetch(worker, { url: `${ORIGIN}/API/x`, method: 'POST' }), null);
  assert.equal(
    await dispatchFetch(worker, { url: 'https://cdn.example.com/x.js', mode: 'navigate' }),
    null
  );
  assert.equal(worker.calls.length, 0);
});

test('a navigation goes to the network by URL, uncached, with manual redirects', async () => {
  const page = new Response('<html>app</html>');
  const worker = loadWorker({ fetch: async () => page });
  const response = await dispatchFetch(worker, { url: `${ORIGIN}/?view=list`, mode: 'navigate' });
  assert.equal(await response, page);
  const [, url, init] = worker.calls.find((call) => call[0] === 'fetch');
  assert.equal(url, `${ORIGIN}/?view=list`);
  assert.equal(init.cache, 'no-store');
  assert.equal(init.credentials, 'include');
  assert.equal(init.redirect, 'manual');
  assert.ok(init.signal, 'the request can be aborted');
  // The timeout is armed for 8 s and disarmed once the response arrives.
  assert.equal(worker.timers.length, 1);
  assert.equal(worker.timers[0].ms, 8000);
  await settle();
  assert.equal(worker.timers[0].cleared, true);
});

test('a navigation that fails is answered with the offline splash', async () => {
  const worker = loadWorker({
    fetch: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  const response = await dispatchFetch(worker, { url: `${ORIGIN}/`, mode: 'navigate' });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const html = await response.text();
  assert.match(html, /<div id="SPLASH_CONNECTING"[^>]*>/);
  assert.match(html, /Connecting\.\.\./);
  assert.match(html, /<div id="SPLASH_FAILED"[^>]*>/);
  assert.match(html, /Unable to Connect/);
  assert.match(html, /<img class="splash-logo" src="\/img\/icon-filled\.png" alt="ShowTrak" \/>/);
});

test('a navigation still pending after 8 s is aborted and gets the splash', async () => {
  let signal = null;
  const worker = loadWorker({
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        signal = init.signal;
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
  });
  const pending = dispatchFetch(worker, { url: `${ORIGIN}/`, mode: 'navigate' });
  await settle();
  assert.equal(signal.aborted, false);
  const [timer] = worker.timers;
  assert.equal(timer.ms, 8000);
  timer.handler();
  assert.equal(signal.aborted, true);
  const response = await pending;
  assert.equal(response.status, 503);
  assert.match(await response.text(), /Connecting\.\.\./);
});

test('a fetched logo refreshes the cache; other assets and failures do not', async () => {
  const logo = new Response('png', { status: 200 });
  const worker = loadWorker({
    fetch: async (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === LOGO) return logo;
      if (pathname === '/missing.png') return new Response('', { status: 404 });
      return new Response('js');
    },
  });

  const response = await dispatchFetch(worker, { url: `${ORIGIN}${LOGO}`, mode: 'no-cors' });
  assert.equal(response, logo, 'the network response itself is returned');
  const put = worker.caches.log.find((entry) => entry[0] === 'put');
  assert.equal(put[1], CACHE_NAME);
  assert.equal(put[2], `${ORIGIN}${LOGO}`);
  assert.notEqual(put[3], logo, 'a clone is cached, so the body can still be read');
  assert.equal(await put[3].text(), 'png');

  worker.caches.log.length = 0;
  await dispatchFetch(worker, { url: `${ORIGIN}/main.js` });
  await dispatchFetch(worker, { url: `${ORIGIN}/missing.png` });
  assert.equal(
    worker.caches.log.some((entry) => entry[0] === 'put'),
    false
  );
});

test('an asset the network cannot fetch comes from the cache, or fails as before', async () => {
  const failure = new TypeError('Failed to fetch');
  const worker = loadWorker({
    fetch: async () => {
      throw failure;
    },
  });
  const install = extendableEvent();
  worker.listeners.get('install')(install);
  await Promise.all(install.pending);

  const cached = await dispatchFetch(worker, { url: `${ORIGIN}${LOGO}`, mode: 'no-cors' });
  assert.equal(cached, `cached ${LOGO}`);

  await assert.rejects(
    dispatchFetch(worker, { url: `${ORIGIN}/main.js` }),
    (err) => err === failure
  );
});

// --- The splash page's embedded script ------------------------------------

function splashScript(html) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1, 'the splash has exactly one script');
  return scripts[0];
}

// The splash page's globals, and nothing else: no bundle, no Node.
function splashPage({ logoComplete = false, logoWidth = 0 } = {}) {
  const state = {
    serverUp: false,
    probes: [],
    timers: [],
    replaced: [],
    classes: new Set(),
    logoListeners: new Map(),
  };
  const logo = {
    complete: logoComplete,
    naturalWidth: logoWidth,
    style: { display: '' },
    addEventListener: (type, listener) => state.logoListeners.set(type, listener),
  };
  const sandbox = {
    fetch: async (url, init) => {
      state.probes.push({ url, cache: init.cache });
      if (!state.serverUp) throw new TypeError('Failed to fetch');
      return { status: 503 };
    },
    location: { replace: (url) => state.replaced.push(url) },
    document: {
      body: { classList: { add: (name) => state.classes.add(name) } },
      querySelector: (selector) => (selector === '.splash-logo' ? logo : null),
    },
    setTimeout: (handler, ms) => {
      state.timers.push({ handler, ms });
      return state.timers.length;
    },
  };
  sandbox.window = sandbox;
  return { sandbox: vm.createContext(sandbox), state, logo };
}

// Fires the most recent probe timer and lets the probe finish.
async function nextProbe(state) {
  state.timers.at(-1).handler();
  await settle();
}

test('the embedded splash script runs on its own and fails over after 5 probes', async () => {
  const html = await splashFromWorker();
  const script = splashScript(html);
  assert.doesNotMatch(script, /__name/, 'no bundle helper in the embedded function');

  const { sandbox, state } = splashPage();
  vm.runInContext(script, sandbox);
  await settle();

  // First probe straight away; "Connecting..." stays for five failures, 2 s apart.
  assert.equal(state.probes.length, 1);
  assert.deepEqual(state.probes[0], { url: '/', cache: 'no-store' });
  for (let failures = 1; failures < 5; failures++) {
    assert.equal(state.timers.at(-1).ms, 2000);
    assert.equal(state.classes.has('failed'), false, `still connecting after ${failures}`);
    await nextProbe(state);
  }
  // The fifth failure shows "Unable to Connect" and slows down to every 4 s.
  assert.equal(state.probes.length, 5);
  assert.equal(state.classes.has('failed'), true);
  assert.equal(state.timers.at(-1).ms, 4000);
  await nextProbe(state);
  assert.equal(state.timers.at(-1).ms, 4000);
  assert.deepEqual(state.replaced, []);

  // Any answer at all (even an error status) goes back into the app.
  state.serverUp = true;
  const timersBefore = state.timers.length;
  await nextProbe(state);
  assert.deepEqual(state.replaced, ['/']);
  assert.equal(state.timers.length, timersBefore, 'probing stops once the server answers');
});

test('the splash hides its logo when the image fails, before or after the script runs', async () => {
  const script = splashScript(await splashFromWorker());
  assert.doesNotMatch(script, /onerror/);

  const loading = splashPage();
  vm.runInContext(script, loading.sandbox);
  assert.equal(loading.logo.style.display, '');
  loading.state.logoListeners.get('error')();
  assert.equal(loading.logo.style.display, 'none');

  const alreadyBroken = splashPage({ logoComplete: true, logoWidth: 0 });
  vm.runInContext(script, alreadyBroken.sandbox);
  assert.equal(alreadyBroken.logo.style.display, 'none');

  const loaded = splashPage({ logoComplete: true, logoWidth: 192 });
  vm.runInContext(script, loaded.sandbox);
  assert.equal(loaded.logo.style.display, '');
  await settle();
});

test('the splash markup carries no inline event handlers', async () => {
  const html = await splashFromWorker();
  assert.doesNotMatch(html, /\son[a-z]+=/i);
});
