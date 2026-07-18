// Web UI (`/ui`) Socket.IO namespace — generic transport bridge.
//
// The Web UI runs the SAME renderer as the Electron desktop app. To achieve
// that, this namespace exposes the desktop's IPC surface to the browser over
// Socket.IO, split into two mechanisms:
//
//   1. PUSH: a renderer sink (registered with the shared RendererBus) forwards
//      every main-process push to authed web sockets, applying a per-channel
//      allowlist + serialization. This is the same fan-out the desktop window
//      receives, so the two surfaces cannot drift.
//
//   2. RPC: a generic `rpc` event dispatches to the SAME IPC handler functions
//      the desktop uses (via the shared HandlerRegistry), after applying a
//      strict server-side allowlist + capability gating. NEVER blind-proxy the
//      full IPC surface — deny by default (OWASP: broken access control).
//
// Auth remains a simple in-memory session-token model gated on the existing
// WEBUI_PASSWORD settings.
import crypto from 'crypto';
import type { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@showtrak/protocol';
import { CreateLogger } from '../Logger';
import { Config } from '../Config';
import { Manager as BroadcastManager } from '../Broadcast';
import { Manager as ClientManager } from '../ClientManager';
import { Manager as GroupManager } from '../GroupManager';
import { Manager as MonitoringTargetManager } from '../MonitoringTargetManager';
import { Manager as DummyClientManager } from '../DummyClientManager';
import { Manager as AlertsManager } from '../AlertsManager';
import { Manager as SettingsManager } from '../SettingsManager';
import { Manager as ScriptManager } from '../ScriptManager';
import { Manager as ScriptWhitelistManager } from '../ScriptWhitelistManager';
import { Manager as ModeManager } from '../ModeManager';
import { ToPublicClient, ToPublicGroup } from './serializers';
import { RegisterRendererSink } from '../../main/renderer-bus';
import { GetHandler } from '../../main/handler-registry';
import type { SubscribeChannel } from '../IPCRegistry/channels';

const Logger = CreateLogger('WebServer');

// The `/ui` namespace is a generic string-keyed transport: it emits push
// channels and RPC events that are NOT part of the client wire contract, and it
// stamps per-session auth state onto each socket. It is therefore modelled with
// a purpose-built structural type rather than the strictly-typed socket.io
// Socket, and obtained from the typed server via a single controlled assertion.
interface WebSocket {
  id: string;
  Authed?: boolean;
  SessionToken?: string | null;
  handshake: {
    address: string;
    auth: { token?: string; [key: string]: unknown };
    query: { token?: string; [key: string]: string | string[] | undefined };
  };
  emit(event: string, ...args: unknown[]): boolean;
  on(event: string, listener: (...args: never[]) => void): void;
}
interface WebNamespace {
  use(fn: (socket: WebSocket, next: (err?: Error) => void) => void): void;
  on(event: 'connection', listener: (socket: WebSocket) => void | Promise<void>): void;
  sockets: { values(): IterableIterator<WebSocket> };
}
// The Socket.IO server bound to the shared client wire contract (as accepted by
// SetupClientNamespace); the web namespace is derived from it.
type WebIOServer = Server<ClientToServerEvents, ServerToClientEvents>;
// Ack callback passed by the browser with each RPC-style event.
type AckCallback = (response?: unknown) => void;

// Source shapes accepted by the public serializers (used when transforming push
// payloads for the web wire).
type PublicClientInput = Parameters<typeof ToPublicClient>[0];
type PublicGroupInput = Parameters<typeof ToPublicGroup>[0];

// In-memory map of currently valid Web UI session tokens to their expiry (epoch
// ms). Expiry is sliding: a token's lifetime is renewed on each validated use,
// so an active browser stays logged in while an abandoned token lapses after
// SESSION_TTL_MS of inactivity. Cleared on restart, on logout, and on a Web UI
// settings change.
const WebSessions = new Map<string, number>();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h idle lifetime
const SESSION_SWEEP_INTERVAL_MS = 10 * 60 * 1000; // background eviction cadence

// Mint a new session token valid for SESSION_TTL_MS from `now`.
function IssueToken(now: number): string {
  const token = crypto.randomBytes(24).toString('hex');
  WebSessions.set(token, now + SESSION_TTL_MS);
  return token;
}

// Validate a presented token, renewing its lifetime on success (sliding expiry).
// An expired token is evicted and treated as invalid.
function IsValidToken(token: string | null | undefined, now: number): boolean {
  if (!token) return false;
  const ExpiresAt = WebSessions.get(token);
  if (ExpiresAt === undefined) return false;
  if (ExpiresAt <= now) {
    WebSessions.delete(token);
    return false;
  }
  WebSessions.set(token, now + SESSION_TTL_MS);
  return true;
}

// Drop every token whose lifetime has lapsed, keeping the map bounded so
// abandoned sessions (tabs closed without logging out) cannot accumulate.
function SweepExpiredSessions(now: number): void {
  for (const [Token, ExpiresAt] of WebSessions) {
    if (ExpiresAt <= now) WebSessions.delete(Token);
  }
}

// --- Login rate limiting --------------------------------------------------
// WEBUI_PASSWORD is a 4-digit PIN (10k keyspace), so an unthrottled login
// handler is trivially brute-forceable. Track failed attempts per client IP and
// lock that IP out for a cooling-off window once it trips the threshold. State
// is in-memory (matching the session model) and swept alongside sessions.
const LOGIN_MAX_FAILURES = 10; // failures allowed within the window before lockout
const LOGIN_WINDOW_MS = 60 * 1000; // rolling window over which failures are counted
const LOGIN_LOCKOUT_MS = 5 * 60 * 1000; // lockout duration once the threshold trips
interface LoginAttemptRecord {
  failures: number;
  windowStart: number;
  lockedUntil: number;
}
const LoginAttempts = new Map<string, LoginAttemptRecord>();

// How long this IP must wait before another login attempt (0 = not limited).
function LoginRetryAfterMs(ip: string, now: number): number {
  const Rec = LoginAttempts.get(ip);
  if (Rec && Rec.lockedUntil > now) return Rec.lockedUntil - now;
  return 0;
}

// Record a failed attempt, arming a lockout once too many failures land inside
// the rolling window.
function RecordLoginFailure(ip: string, now: number): void {
  let Rec = LoginAttempts.get(ip);
  if (!Rec || now - Rec.windowStart > LOGIN_WINDOW_MS) {
    Rec = { failures: 0, windowStart: now, lockedUntil: 0 };
  }
  Rec.failures += 1;
  if (Rec.failures >= LOGIN_MAX_FAILURES) {
    Rec.lockedUntil = now + LOGIN_LOCKOUT_MS;
    Rec.failures = 0;
    Rec.windowStart = now;
  }
  LoginAttempts.set(ip, Rec);
}

// Clear an IP's failure record after a successful login.
function ClearLoginFailures(ip: string): void {
  LoginAttempts.delete(ip);
}

// Evict attempt records that are neither locked nor inside their counting
// window, keeping the map bounded to currently-active clients.
function SweepLoginAttempts(now: number): void {
  for (const [Ip, Rec] of LoginAttempts) {
    if (Rec.lockedUntil <= now && now - Rec.windowStart > LOGIN_WINDOW_MS) {
      LoginAttempts.delete(Ip);
    }
  }
}

// Constant-time passcode comparison. Hashing both sides to a fixed-width digest
// before timingSafeEqual keeps the comparison independent of both content and
// length (timingSafeEqual itself requires equal-length buffers). NOTE: the
// passcode is still stored in plaintext settings — hashing at rest is a separate,
// larger change; this only removes the compare-time timing side channel.
function PasscodeMatches(input: string, expected: string): boolean {
  const A = crypto.createHash('sha256').update(input, 'utf8').digest();
  const B = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(A, B);
}

// --- Capability model -----------------------------------------------------
// Which invoke channels the web surface may reach, and under what conditions.
// Anything not listed here is denied. Grouped by the gate that governs it.

// Always allowed for an authed session (read-only / non-mutating).
const WEB_READ_CHANNELS = new Set([
  'Config:Get',
  'GetClient',
  'GetClientHistory',
  'GetClientApplicationHistory',
  'GetClientUSBHistory',
  'GetClientDisplayHistory',
  'GetAllGroups',
  'Mode:Get',
  'GetMonitoringMethods',
  'GetAllMonitoringTargets',
  'GetMonitoringTarget',
  'GetMonitoringCheckHistory',
  'GetMonitoringCheckDebug',
  'GetDummyClientHistory',
  'GetAllDummyClients',
  'GetDummyClient',
  'GenerateDummyClientDefaults',
  'GetAlertTriggers',
  'GetAlertActionTypes',
  'GetAllAlertRules',
  'GetAlertRule',
  'AlertActionsEnabled:Get',
  'Audio:GetAll',
  'Audio:GetData',
]);

// Allowed regardless of mode: non-destructive, show-time actions (identifying
// a client just flashes an overlay on its screen — no state is mutated).
const WEB_IDENTIFY_CHANNELS = new Set(['IdentifyClient', 'StopIdentifyingClient']);

// Management mutations, split into finite capability categories so each can be
// permitted/denied independently from the Web UI Permissions settings. Every
// category ALSO requires the server to be in EDIT mode — edit-mode is
// authoritative on the desktop and the web merely mirrors it, so the per-category
// toggles further restrict (never widen) what a browser may mutate.
const WEB_CLIENT_CHANNELS = new Set([
  'UpdateClient',
  'MarkClientUSBDeviceCritical',
  'RemoveClientUSBDeviceCritical',
  'MarkClientUSBNameCritical',
  'RemoveClientUSBNameCritical',
  'MarkClientApplicationCritical',
  'RemoveClientApplicationCritical',
  'MarkClientDisplayCritical',
  'RemoveClientDisplayCritical',
  'UnadoptClient',
  'ReplaceClient',
  'AdoptDevice',
]);
const WEB_GROUP_CHANNELS = new Set([
  'CreateGroup',
  'RenameGroup',
  'DeleteGroup',
  'Groups:SetOrder',
  'Groups:SetFullWidth',
  'Groups:SetKeyBind',
  'Groups:SetSlug',
  'SetGroupOrder',
]);
const WEB_MONITORING_CHANNELS = new Set([
  'CreateMonitoringTarget',
  'UpdateMonitoringTarget',
  'DeleteMonitoringTarget',
  'RunMonitoringCheckNow',
  'RunAllMonitoringChecksNow',
  'CreateDummyClient',
  'UpdateDummyClient',
  'DeleteDummyClient',
  'ResetDummyClientToIdle',
]);
const WEB_ALERT_CHANNELS = new Set([
  'CreateAlertRule',
  'UpdateAlertRule',
  'DeleteAlertRule',
  'SetAlertRuleEnabled',
]);
// Creating unassigned slots is its own category because it is additionally
// gated on the global SYSTEM_ALLOW_UNASSIGNED_CLIENTS feature flag (the main
// registrar re-checks that flag and remains the authority).
const WEB_UNASSIGNED_CHANNELS = new Set(['CreateUnassignedClients']);

// Union of every edit-mode-gated channel. Retained for callers/tests that reason
// about "all management mutations" without caring about the category split.
const WEB_EDIT_CHANNELS = new Set([
  ...WEB_CLIENT_CHANNELS,
  ...WEB_GROUP_CHANNELS,
  ...WEB_MONITORING_CHANNELS,
  ...WEB_ALERT_CHANNELS,
  ...WEB_UNASSIGNED_CHANNELS,
]);

// Allowed when remote script execution is enabled (SHOW-time actions).
const WEB_SCRIPT_CHANNELS = new Set(['ExecuteScript', 'TriggerIntegratedEvent']);

// Allowed when the global Wake-on-LAN feature AND the Web UI WOL permission are
// both enabled.
const WEB_WOL_CHANNELS = new Set(['WakeOnLan']);

// Push channels the web surface receives. Desktop-only channels (menu actions,
// show-file, fullscreen, native/app updates, network-discovery, and settings
// that may contain secrets) are intentionally excluded.
// `satisfies` guarantees every entry is a real registry SubscribeChannel at
// compile time (a typo or a channel removed from the registry fails the build).
// The Set stays `Set<string>` so the hot-path `.has(channel: string)` lookup
// keeps its plain-string signature.
const WEB_PUSH_CHANNELS = [
  'SetFullClientList',
  'ClientUpdated',
  'SetScriptList',
  'SetOSCList',
  'SetDevicesPendingAdoption',
  'UpdateScriptExecutions',
  'USBDeviceAdded',
  'USBDeviceRemoved',
  'SetFullMonitoringTargetList',
  'MonitoringTargetUpdated',
  'SetFullDummyClientList',
  'DummyClientUpdated',
  'SetFullAlertRuleList',
  'AlertTriggered',
  'CreateShowTrakAlert',
  'Notify',
  'PlaySound',
  'PlayCustomAudio',
  'OSCBulkAction',
  'DebugTrafficEntry',
  'ModeUpdated',
  'AlertActionsUpdated',
  'AudioAssetsUpdated',
] as const satisfies readonly SubscribeChannel[];
const WEB_PUSH_ALLOWLIST = new Set<string>(WEB_PUSH_CHANNELS);

// Serialize a push payload for the web wire. Most channels already carry plain
// objects; client-bearing channels must be run through ToPublicClient so the
// browser receives the same shape the desktop renderer consumes.
function TransformWebPush(channel: string, args: unknown[]): unknown[] {
  switch (channel) {
    case 'SetFullClientList':
      return [
        ((args[0] as PublicClientInput[]) || []).map(ToPublicClient),
        ((args[1] as PublicGroupInput[]) || []).map(ToPublicGroup),
      ];
    case 'ClientUpdated':
      return [ToPublicClient(args[0] as PublicClientInput)];
    case 'USBDeviceAdded':
    case 'USBDeviceRemoved':
      return [ToPublicClient(args[0] as PublicClientInput), args[1]];
    default:
      return args;
  }
}

// Read a boolean setting, treating an unset value (null/undefined) as the
// supplied default so the permission model matches DefaultSettings even if a key
// has never been persisted.
const ReadBool = async (Key: string, Default: boolean): Promise<boolean> => {
  const Value = await SettingsManager.GetValue(Key);
  return Value == null ? Default : !!Value;
};

// Snapshot of the relevant Web UI settings used for permissions.
const GetWebConfig = async () => {
  let Enabled = true;
  let ProtectionEnabled = false;
  let Password = '';
  let AllowRemoteScripts = false;
  let WOLEnabled = false;
  // Finite Web UI action permissions. Management categories default ON (matching
  // the historical "allowed while in Edit mode" behavior); scripts default OFF.
  let AllowIdentify = true;
  let AllowClientManagement = true;
  let AllowGroupManagement = true;
  let AllowMonitoringManagement = true;
  let AllowAlertManagement = true;
  let AllowWebWOL = true;
  let AllowUnassignedClients = true;
  let UnassignedClientsEnabled = false;
  try {
    Enabled = !!(await SettingsManager.GetValue('WEBUI_ENABLED'));
    ProtectionEnabled = !!(await SettingsManager.GetValue('WEBUI_PASSWORD_PROTECTION_ENABLED'));
    Password = String((await SettingsManager.GetValue('WEBUI_PASSWORD')) || '').trim();
    AllowRemoteScripts = await ReadBool('WEBUI_ALLOW_REMOTE_SCRIPT_EXECUTION', false);
    WOLEnabled = !!(await SettingsManager.GetValue('SYSTEM_ALLOW_WOL'));
    AllowIdentify = await ReadBool('WEBUI_ALLOW_IDENTIFY', true);
    AllowClientManagement = await ReadBool('WEBUI_ALLOW_CLIENT_MANAGEMENT', true);
    AllowGroupManagement = await ReadBool('WEBUI_ALLOW_GROUP_MANAGEMENT', true);
    AllowMonitoringManagement = await ReadBool('WEBUI_ALLOW_MONITORING_MANAGEMENT', true);
    AllowAlertManagement = await ReadBool('WEBUI_ALLOW_ALERT_MANAGEMENT', true);
    AllowWebWOL = await ReadBool('WEBUI_ALLOW_WOL', true);
    AllowUnassignedClients = await ReadBool('WEBUI_ALLOW_UNASSIGNED_CLIENTS', true);
    UnassignedClientsEnabled = !!(await SettingsManager.GetValue(
      'SYSTEM_ALLOW_UNASSIGNED_CLIENTS'
    ));
  } catch {
    /* intentional: fall back to the safe defaults set above if settings can't be read */
  }
  if (Enabled === undefined) Enabled = true;
  // Protection is only meaningful when a passcode is actually set.
  const RequireAuth = ProtectionEnabled && Password.length > 0;
  return {
    Enabled,
    ProtectionEnabled,
    Password,
    AllowRemoteScripts,
    WOLEnabled,
    AllowIdentify,
    AllowClientManagement,
    AllowGroupManagement,
    AllowMonitoringManagement,
    AllowAlertManagement,
    AllowWebWOL,
    AllowUnassignedClients,
    UnassignedClientsEnabled,
    RequireAuth,
  };
};

// Public-facing config (never leaks the password itself). Also carries the
// capability hints the web renderer uses to build its Capabilities object.
const GetPublicConfig = async (socket: WebSocket) => {
  const Cfg = await GetWebConfig();
  return {
    Enabled: Cfg.Enabled,
    PasswordProtection: Cfg.RequireAuth,
    AllowRemoteScripts: Cfg.AllowRemoteScripts,
    // Effective WOL availability for the browser: the global feature AND the
    // dedicated Web UI WOL permission must both be on.
    WOLEnabled: Cfg.WOLEnabled && Cfg.AllowWebWOL,
    // Effective availability of unassigned-slot creation for the browser: the
    // global feature AND the dedicated Web UI permission must both be on. The
    // browser uses this to show/hide the + menu entry, since it cannot read
    // settings directly.
    UnassignedClientsEnabled: Cfg.UnassignedClientsEnabled && Cfg.AllowUnassignedClients,
    Authed: !Cfg.RequireAuth || !!(socket && socket.Authed),
    Mode: ModeManager.Get(),
    Version: Config.Application.Version,
  };
};

// Is this socket allowed to receive/act on data right now?
const IsAuthed = async (socket: WebSocket) => {
  const Cfg = await GetWebConfig();
  if (!Cfg.Enabled) return false;
  if (!Cfg.RequireAuth) return true;
  return !!(socket && socket.Authed);
};

// Decide whether an authed web session may invoke a given channel. Deny by
// default; only the explicitly allowlisted channels pass, subject to the
// governing capability gate.
const AuthorizeWebChannel = async (channel: string) => {
  if (WEB_READ_CHANNELS.has(channel)) return { allowed: true, reason: null };
  const Cfg = await GetWebConfig();
  if (WEB_IDENTIFY_CHANNELS.has(channel)) {
    if (!Cfg.AllowIdentify) return { allowed: false, reason: 'forbidden' };
    return { allowed: true, reason: null };
  }
  // Management categories: EDIT mode is the master gate, then the per-category
  // permission. Report the mode requirement first so the UX message is accurate.
  const Category = WEB_CLIENT_CHANNELS.has(channel)
    ? Cfg.AllowClientManagement
    : WEB_GROUP_CHANNELS.has(channel)
      ? Cfg.AllowGroupManagement
      : WEB_MONITORING_CHANNELS.has(channel)
        ? Cfg.AllowMonitoringManagement
        : WEB_ALERT_CHANNELS.has(channel)
          ? Cfg.AllowAlertManagement
          : WEB_UNASSIGNED_CHANNELS.has(channel)
            ? Cfg.UnassignedClientsEnabled && Cfg.AllowUnassignedClients
            : null;
  if (Category !== null) {
    if (ModeManager.Get() !== 'EDIT') return { allowed: false, reason: 'edit_mode_required' };
    if (!Category) return { allowed: false, reason: 'forbidden' };
    return { allowed: true, reason: null };
  }
  if (WEB_SCRIPT_CHANNELS.has(channel)) {
    if (!Cfg.AllowRemoteScripts) return { allowed: false, reason: 'forbidden' };
    return { allowed: true, reason: null };
  }
  if (WEB_WOL_CHANNELS.has(channel)) {
    if (!Cfg.WOLEnabled || !Cfg.AllowWebWOL) return { allowed: false, reason: 'forbidden' };
    return { allowed: true, reason: null };
  }
  return { allowed: false, reason: 'forbidden' };
};

// Wire the `/ui` namespace onto the provided Socket.IO server. `_ServerManager`
// is retained for signature compatibility; script dispatch now flows through the
// shared IPC handlers.
function SetupWebUiNamespace(io: WebIOServer, _ServerManager?: unknown) {
  const ui = io.of('/ui') as WebNamespace;

  // Periodically evict lapsed sessions and stale login-attempt records so neither
  // map grows unbounded over a long-running server. Unref'd so it never keeps the
  // process alive on its own.
  const SweepTimer = setInterval(() => {
    const Now = Date.now();
    SweepExpiredSessions(Now);
    SweepLoginAttempts(Now);
  }, SESSION_SWEEP_INTERVAL_MS);
  if (SweepTimer && typeof SweepTimer.unref === 'function') SweepTimer.unref();

  // Renderer sink: forward allowlisted pushes to every authed web socket. One
  // sink services the whole namespace (not per-socket) so it stays in lockstep
  // with the desktop window sink.
  RegisterRendererSink((channel: string, ...args: unknown[]) => {
    if (!WEB_PUSH_ALLOWLIST.has(channel)) return;
    let payload: unknown[];
    try {
      payload = TransformWebPush(channel, args);
    } catch {
      return;
    }
    const sockets =
      ui.sockets && typeof ui.sockets.values === 'function' ? ui.sockets.values() : [];
    for (const socket of sockets) {
      if (socket && socket.Authed) {
        try {
          socket.emit(channel, ...payload);
        } catch {
          /* intentional: one dead/closing socket must not block the push to the rest */
        }
      }
    }
  });

  // Re-evaluate every live session whenever the Web UI enable/protection/passcode
  // settings change. Without this, enabling protection (or changing the passcode)
  // would never re-prompt already-connected browsers, and disabling the Web UI
  // would not eject in-flight sessions — the reported bug.
  const HandleWebUiSettingsChanged = async () => {
    // Drop every token: reconnects and the re-greeting below must pass the NEW
    // gate. A session that is still valid simply re-authenticates seamlessly
    // (its stored passcode still matches); one that isn't is forced to log in.
    WebSessions.clear();
    let Cfg;
    try {
      Cfg = await GetWebConfig();
    } catch {
      return;
    }
    // Only sessions that need no passcode (enabled + protection off/unset) stay
    // implicitly authed; everyone else is dropped to unauthed. This also stops
    // the renderer sink (which reads socket.Authed) from pushing to them.
    const ImplicitlyAuthed = Cfg.Enabled && !Cfg.RequireAuth;
    const sockets =
      ui.sockets && typeof ui.sockets.values === 'function' ? Array.from(ui.sockets.values()) : [];
    for (const socket of sockets) {
      try {
        socket.Authed = ImplicitlyAuthed;
        socket.SessionToken = null;
        // Re-greet so the client re-runs its auth decision: show the passcode
        // keypad, the disabled notice, or silently re-hydrate as appropriate.
        socket.emit('hello', await GetPublicConfig(socket));
      } catch {
        /* one bad socket must not block re-evaluation of the rest */
      }
    }
  };
  BroadcastManager.on('WebUiSettingsChanged', () => {
    HandleWebUiSettingsChanged().catch((e) =>
      Logger.error('Web UI settings change handling failed:', e)
    );
  });

  // Validate any token presented in the handshake so reconnects stay logged in.
  ui.use((socket, next) => {
    try {
      const Token =
        (socket.handshake.auth && socket.handshake.auth.token) ||
        (socket.handshake.query && socket.handshake.query.token) ||
        null;
      socket.Authed = IsValidToken(Token, Date.now());
      socket.SessionToken = socket.Authed ? Token : null;
    } catch {
      socket.Authed = false;
    }
    next();
  });

  ui.on('connection', async (socket) => {
    try {
      Logger.log('Web UI connected', { id: socket.id, ip: socket.handshake.address });
    } catch {
      /* intentional: connection logging is best-effort */
    }

    // When no passcode is configured, every session is implicitly authed. Mark
    // the flag so the (synchronous) renderer sink can decide delivery without an
    // async settings lookup on the hot push path.
    try {
      const Cfg = await GetWebConfig();
      if (!Cfg.RequireAuth) socket.Authed = true;
    } catch {
      /* intentional: leave socket.Authed as-is (default false) if config can't be read */
    }

    // Emit the full initial state using the SAME channels the desktop renderer
    // consumes, so the shared renderer hydrates identically on both surfaces.
    const SendInitialState = async () => {
      try {
        if (!(await IsAuthed(socket))) return;
        const [cErr, clients] = await ClientManager.GetAll();
        const [gErr, groups] = await GroupManager.GetAll();
        socket.emit(
          'SetFullClientList',
          cErr || !clients ? [] : clients.map(ToPublicClient),
          gErr ? [] : (groups || []).map(ToPublicGroup)
        );

        const [mErr, monitors] = await MonitoringTargetManager.GetAll();
        socket.emit('SetFullMonitoringTargetList', mErr ? [] : monitors || []);

        const [dErr, dummies] = await DummyClientManager.GetAll();
        socket.emit('SetFullDummyClientList', dErr ? [] : dummies || []);

        const [aErr, rules] = await AlertsManager.GetAll();
        socket.emit('SetFullAlertRuleList', aErr ? [] : rules || []);

        let scripts: unknown[] = [];
        try {
          // Decorate with per-show whitelist scopes (Whitelist: null when
          // unrestricted) so the browser context menu can hide a script for
          // non-whitelisted clients, matching the desktop push.
          scripts = await ScriptWhitelistManager.DecorateCatalog(
            (await ScriptManager.GetScripts()) || []
          );
        } catch {
          /* intentional: fall back to an empty script list if the read fails */
        }
        socket.emit('SetScriptList', scripts);

        socket.emit('ModeUpdated', ModeManager.Get());
        socket.emit('AlertActionsUpdated', AlertsManager.GetActionsEnabled());
      } catch (e) {
        Logger.error('Web UI initial state failed:', e);
      }
    };

    // Tell the client whether it must authenticate before anything else.
    socket.emit('hello', await GetPublicConfig(socket));
    await SendInitialState();

    // --- Authentication handlers -------------------------------------------
    socket.on('auth:login', async (payload: { password?: unknown } | undefined, cb: AckCallback) => {
      try {
        const Cfg = await GetWebConfig();
        if (!Cfg.Enabled) {
          return cb && cb({ error: 'disabled' });
        }
        const Now = Date.now();
        if (!Cfg.RequireAuth) {
          socket.Authed = true;
          const token = IssueToken(Now);
          socket.SessionToken = token;
          await SendInitialState();
          return cb && cb({ ok: true, token });
        }
        // Throttle brute force against the 4-digit PIN: an IP that has tripped
        // the failure threshold is refused outright until its lockout elapses.
        const IP = (socket.handshake && socket.handshake.address) || 'unknown';
        const RetryAfterMs = LoginRetryAfterMs(IP, Now);
        if (RetryAfterMs > 0) {
          return cb && cb({ error: 'rate_limited', retryAfterMs: RetryAfterMs });
        }
        const Passcode = String((payload && payload.password) || '').trim();
        if (!PasscodeMatches(Passcode, Cfg.Password)) {
          RecordLoginFailure(IP, Now);
          return cb && cb({ error: 'invalid_password' });
        }
        ClearLoginFailures(IP);
        const token = IssueToken(Now);
        socket.Authed = true;
        socket.SessionToken = token;
        await SendInitialState();
        if (cb) cb({ ok: true, token });
      } catch (e) {
        if (cb) cb({ error: 'failed' });
      }
    });

    socket.on('auth:logout', async (cb: AckCallback) => {
      try {
        if (socket.SessionToken) WebSessions.delete(socket.SessionToken);
        socket.Authed = false;
        socket.SessionToken = null;
        if (cb) cb({ ok: true });
      } catch (e) {
        if (cb) cb({ error: 'failed' });
      }
    });

    socket.on('config:get', async (cb: AckCallback) => {
      try {
        if (cb) cb({ data: await GetPublicConfig(socket) });
      } catch {
        if (cb) cb({ error: 'failed' });
      }
    });

    // Re-request the full initial state (e.g. after reconnect).
    socket.on('bootstrap:get', async () => {
      await SendInitialState();
    });

    // --- Generic RPC bridge -------------------------------------------------
    // Dispatches to the SAME IPC handler the desktop uses, after auth + a strict
    // allowlist + capability gate. `args` is the positional argument array; the
    // handler's first (Electron event) argument is passed as null.
    socket.on('rpc', async (channel: unknown, args: unknown, cb: AckCallback) => {
      try {
        if (!(await IsAuthed(socket))) return cb && cb({ error: 'unauthorized' });
        if (typeof channel !== 'string') return cb && cb({ error: 'invalid_channel' });
        const Decision = await AuthorizeWebChannel(channel);
        if (!Decision.allowed) return cb && cb({ error: Decision.reason || 'forbidden' });
        const Handler = GetHandler(channel);
        if (typeof Handler !== 'function') return cb && cb({ error: 'unknown_channel' });
        const Args = Array.isArray(args) ? args : [];
        const Result = await Handler(null, ...Args);
        if (cb) cb({ result: Result });
      } catch (e) {
        Logger.error('Web UI rpc failed:', e);
        if (cb) cb({ error: 'failed' });
      }
    });
  });

  return ui;
}

export {
  SetupWebUiNamespace,
  WEB_READ_CHANNELS,
  WEB_IDENTIFY_CHANNELS,
  WEB_EDIT_CHANNELS,
  WEB_CLIENT_CHANNELS,
  WEB_GROUP_CHANNELS,
  WEB_MONITORING_CHANNELS,
  WEB_ALERT_CHANNELS,
  WEB_UNASSIGNED_CHANNELS,
  WEB_SCRIPT_CHANNELS,
  WEB_WOL_CHANNELS,
  WEB_PUSH_ALLOWLIST,
  AuthorizeWebChannel,
  IssueToken,
  IsValidToken,
  SweepExpiredSessions,
  LoginRetryAfterMs,
  RecordLoginFailure,
  ClearLoginFailures,
  SweepLoginAttempts,
  PasscodeMatches,
  SESSION_TTL_MS,
  LOGIN_MAX_FAILURES,
  LOGIN_LOCKOUT_MS,
};
