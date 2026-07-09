// Web UI bootstrap entry.
//
// Runs in the browser. It connects to the `/ui` Socket.IO namespace, performs
// the passcode handshake (when configured), installs the web `window.API` shim,
// injects the capability profile, and then lazily loads the SHARED renderer
// (`./main`) — the exact same modules the Electron desktop app runs.
//
// Load order is critical: the shared renderer's bootstrap orchestrator calls
// `window.API` as soon as `import('./main')` evaluates, so the shim +
// capabilities MUST be in place first.
import { createWebApi } from './web-api-shim';
import type { WebUiSocket } from './web-api-shim';

// Socket.IO connect options actually passed below (the client is a vendored
// browser global with no bundled types).
interface IoConnectOptions {
  transports: string[];
  auth: (cb: (data: { token?: string }) => void) => void;
  reconnection: boolean;
  reconnectionDelay: number;
  reconnectionDelayMax: number;
  timeout: number;
}

declare const io: (namespace: string, options: IoConnectOptions) => WebUiSocket;

/** Ack payload for `auth:login`. */
interface AuthLoginResponse {
  ok?: boolean;
  token?: string;
  error?: string;
}

const TOKEN_KEY = 'showtrak_token';
const PASS_KEY = 'showtrak_passcode';

// Credential persistence. localStorage (not sessionStorage) so an installed
// PWA can silently re-authenticate after the server restarts — session tokens
// are in-memory server-side, and without re-auth the server stops pushing live
// state to this socket. sessionStorage is read as a fallback for tokens issued
// by previous builds.
function getStored(key: string): string | null {
  try {
    return localStorage.getItem(key) || sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function setStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private browsing may deny storage; auth still works for this session */
  }
}

function clearStored(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* intentional: storage may be denied in private browsing; clearing is best-effort */
  }
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* intentional: storage may be denied in private browsing; clearing is best-effort */
  }
}

// Tag the surface as early as possible so capability CSS applies before paint.
try {
  document.body.classList.add('is-web');
} catch {
  /* body not ready yet; applyWebChrome re-adds it */
}

const socket = io('/ui', {
  transports: ['websocket', 'polling'],
  auth: (cb: (data: { token?: string }) => void) =>
    cb({ token: getStored(TOKEN_KEY) || undefined }),
  reconnection: true,
  reconnectionDelay: 800,
  reconnectionDelayMax: 4000,
  timeout: 6000,
});

interface WebConfig {
  Enabled: boolean;
  PasswordProtection: boolean;
  AllowRemoteScripts: boolean;
  WOLEnabled: boolean;
  Authed: boolean;
  Mode?: string;
  Version?: string;
}

/** Ack payload for `config:get`. */
interface ConfigGetResponse {
  data?: WebConfig;
}

let started = false;

function el(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function show(id: string) {
  const node = el(id);
  if (node) node.classList.remove('d-none');
}

function hide(id: string) {
  const node = el(id);
  if (node) node.classList.add('d-none');
}

// The iOS status bar tints to <meta name="theme-color">. Keep it on the purple
// accent for both the login screen (set in the static HTML) and the logged-in
// app so the status bar matches the theme throughout.
function setThemeColor(color: string) {
  try {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', color);
  } catch {
    /* non-fatal: status bar keeps its current tint */
  }
}

// Hide the desktop-only chrome. CSS (body.is-web) is the primary mechanism; this
// is a defensive backup in case markup changes.
function applyWebChrome() {
  try {
    setThemeColor('#6d5bd0');
    document.body.classList.add('is-web');
    const dragbar = document.querySelector('.dragbar');
    if (dragbar) dragbar.classList.add('d-none');
    const settingsMenu = el('SETTINGS_MENU_DROPDOWN');
    if (settingsMenu) settingsMenu.classList.add('d-none');
    const modeShow = el('MODE_BTN_SHOW') as HTMLButtonElement | null;
    const modeEdit = el('MODE_BTN_EDIT') as HTMLButtonElement | null;
    const alertToggle = el('ALERT_ACTIONS_TOGGLE_BTN') as HTMLButtonElement | null;
    if (modeShow) {
      modeShow.disabled = true;
      modeShow.setAttribute('aria-disabled', 'true');
      modeShow.title = 'Show mode is controlled by the desktop app';
    }
    if (modeEdit) {
      modeEdit.disabled = true;
      modeEdit.setAttribute('aria-disabled', 'true');
      modeEdit.title = 'Edit mode is controlled by the desktop app';
    }
    if (alertToggle) {
      alertToggle.disabled = true;
      alertToggle.setAttribute('aria-disabled', 'true');
      alertToggle.title = 'Alert actions are controlled by the desktop app';
    }
  } catch {
    /* non-fatal */
  }
}

function buildCapabilities(config: WebConfig) {
  return {
    isWeb: true,
    showNavbar: false,
    showCogs: false,
    showModeToggle: false,
    canToggleAlertActions: false,
    requiresPasscode: !!config.PasswordProtection,
    allowRemoteScripts: !!config.AllowRemoteScripts,
    wolEnabled: !!config.WOLEnabled,
  };
}

// Install the shim + capabilities, hide the login/loading overlays, then load
// the shared renderer and request a fresh state snapshot once it has subscribed.
async function startApp(config: WebConfig) {
  if (started) {
    // Re-entered after a re-login while the app is already running: make sure
    // the auth overlays are gone before re-hydrating.
    hide('WEB_LOGIN_OVERLAY');
    hide('WEB_LOADING_OVERLAY');
    socket.emit('bootstrap:get');
    return;
  }
  started = true;
  window.__SHOWTRAK_CAPS__ = buildCapabilities(config);
  window.API = createWebApi(socket);
  try {
    const { setSettings } = await import('./01-state');
    const initialSettings = await window.API.GetSettings();
    if (Array.isArray(initialSettings)) {
      setSettings(initialSettings);
    }
  } catch {
    /* settings will arrive again via the shared init path if needed */
  }
  try {
    if ('caches' in window) {
      // Clear caches left behind by previous Web UI builds, but keep the
      // offline-splash service worker's cache (its logo precache).
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => !key.startsWith('showtrak-sw-')).map((key) => caches.delete(key))
      );
    }
  } catch {
    /* stale caches are best-effort only */
  }
  applyWebChrome();
  hide('WEB_LOGIN_OVERLAY');
  hide('WEB_LOADING_OVERLAY');
  // Importing ./main runs the bootstrap orchestrator: every module registers
  // its subscriptions synchronously (no DOMContentLoaded replay needed — the
  // former ready handlers are called directly), then Init() runs.
  await import('./main');
  // The shared modules have now registered their subscriptions; ask the server
  // to re-emit the full initial state so nothing is missed.
  socket.emit('bootstrap:get');
}

// The passcode being entered on the keypad. The hidden input mirrors this value
// so the existing submitLogin() read path (and browser autofill) keep working.
// The passcode is always exactly 4 digits (enforced by the WEBUI_PASSWORD
// setting), so the dots row is a fixed length of PIN_LENGTH.
let pinValue = '';
const PIN_LENGTH = 4;

function renderPinDots() {
  const dots = el('WEB_LOGIN_DOTS');
  if (!dots) return;
  // Always render PIN_LENGTH dots; fill one per entered digit.
  dots.classList.toggle('is-empty', pinValue.length === 0);
  let html = '';
  for (let i = 0; i < PIN_LENGTH; i++) {
    const filled = i < pinValue.length ? ' is-filled' : '';
    html += `<span class="web-pin-dot${filled}"></span>`;
  }
  dots.innerHTML = html;
}

function setPin(next: string) {
  pinValue = next.slice(0, PIN_LENGTH);
  const input = el('WEB_LOGIN_INPUT') as HTMLInputElement | null;
  if (input) input.value = pinValue;
  renderPinDots();
}

function pinAppend(digit: string) {
  if (pinValue.length >= PIN_LENGTH) return;
  setLoginError('');
  setPin(pinValue + digit);
  // The passcode is a fixed length; submit automatically once it is complete
  // so the enter key is optional. Defer so the final dot paints first.
  if (pinValue.length === PIN_LENGTH) {
    setTimeout(submitLogin, 120);
  }
}

function pinBackspace() {
  setLoginError('');
  setPin(pinValue.slice(0, -1));
}

function showLogin() {
  hide('WEB_LOADING_OVERLAY');
  show('WEB_LOGIN_OVERLAY');
  setPin('');
}

function showDisabled() {
  hide('WEB_LOADING_OVERLAY');
  hide('WEB_LOGIN_OVERLAY');
  show('WEB_DISABLED_NOTICE');
}

function setLoginError(message: string) {
  const errNode = el('WEB_LOGIN_ERROR');
  if (errNode) {
    errNode.textContent = message;
    errNode.classList.toggle('d-none', !message);
  }
}

function submitLogin() {
  const password = pinValue;
  if (!password) {
    setLoginError('Enter the passcode.');
    return;
  }
  setLoginError('');
  socket.emit('auth:login', { password }, (res: AuthLoginResponse) => {
    if (res && res.ok) {
      if (res.token) setStored(TOKEN_KEY, res.token);
      // Remember the accepted passcode so reconnects (and future visits) can
      // re-authenticate without prompting.
      setStored(PASS_KEY, password);
      socket.emit('config:get', (cfg: ConfigGetResponse) => {
        if (cfg && cfg.data) startApp(cfg.data);
      });
      return;
    }
    if (res && res.error === 'disabled') return showDisabled();
    setLoginError('Incorrect passcode. Please try again.');
    setPin('');
  });
}

// Silently re-authenticate with the stored passcode. Falls back to `onFail`
// (typically the login screen) when nothing is stored or the server rejects
// it — rejected credentials are cleared so the keypad is the next stop. On
// success the server re-runs SendInitialState, which refreshes all live state.
function tryStoredLogin(onFail: () => void) {
  const stored = getStored(PASS_KEY);
  if (!stored) return onFail();
  socket.emit('auth:login', { password: stored }, (res: AuthLoginResponse) => {
    if (res && res.ok) {
      if (res.token) setStored(TOKEN_KEY, res.token);
      if (started) {
        hide('WEB_LOGIN_OVERLAY');
        return;
      }
      socket.emit('config:get', (cfg: ConfigGetResponse) => {
        if (cfg && cfg.data) startApp(cfg.data);
      });
      return;
    }
    if (res && res.error === 'disabled') return showDisabled();
    clearStored(PASS_KEY);
    clearStored(TOKEN_KEY);
    onFail();
  });
}

function wireLogin() {
  const pad = el('WEB_LOGIN_PAD');
  if (pad) {
    pad.addEventListener('click', (e: Event) => {
      const key = e.target && (e.target as HTMLElement).closest('.web-pin-key');
      if (!key) return;
      const action = key.getAttribute('data-action');
      if (action === 'submit') return submitLogin();
      if (action === 'backspace') return pinBackspace();
      const digit = key.getAttribute('data-key');
      if (digit) pinAppend(digit);
    });
  }

  // Physical keyboard support: only while the login overlay is visible.
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    const overlay = el('WEB_LOGIN_OVERLAY');
    if (!overlay || overlay.classList.contains('d-none')) return;
    if (e.key >= '0' && e.key <= '9') {
      pinAppend(e.key);
      e.preventDefault();
    } else if (e.key === 'Backspace') {
      pinBackspace();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      submitLogin();
      e.preventDefault();
    }
  });
}

wireLogin();

// Server greeting: decides whether to prompt for a passcode or start directly.
socket.on('hello', (config: WebConfig) => {
  if (started) {
    // Reconnected after the app already booted. If the session token survived,
    // just re-hydrate. If it did not (server restarts clear its in-memory
    // sessions), re-authenticate with the stored passcode — without this the
    // server never pushes live updates to this socket again and the UI silently
    // goes stale. No stored/valid passcode -> back to the login screen.
    if (config.Authed || !config.PasswordProtection) {
      socket.emit('bootstrap:get');
    } else {
      tryStoredLogin(showLogin);
    }
    return;
  }
  if (!config.Enabled) return showDisabled();
  if (config.PasswordProtection && !config.Authed) return tryStoredLogin(showLogin);
  startApp(config);
});

// Connection loss covers the app with the disconnected splash. Socket.IO keeps
// reconnecting in the background (reconnection: true, infinite attempts); on
// success the splash hides and the `hello` handler re-hydrates the state.
socket.on('disconnect', (reason: string) => {
  show('WEB_DISCONNECTED_OVERLAY');
  // Socket.IO does not auto-reconnect when the SERVER initiated the disconnect
  // (only on transport drops). This surface must always find its way back, so
  // reconnect manually in that case.
  if (reason === 'io server disconnect') socket.connect();
});

socket.on('connect', () => {
  hide('WEB_DISCONNECTED_OVERLAY');
});

// Register the offline-splash service worker. It never caches the app shell;
// it only serves a "Connecting…" splash when ShowTrak Server is unreachable
// and reloads back into the app once the server answers (see WebUI/sw.js).
try {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
} catch {
  /* non-fatal */
}
