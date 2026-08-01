// SDK control API (`/sdk`) Socket.IO namespace.
//
// The external-integration surface: the ShowTrak Server SDK (and anything built
// on it — the Companion module, the ShowTrak Remote app) connects here to drive
// the instance in real time and receive live status pushes. Supports multiple
// concurrent clients natively (Socket.IO fan-out).
//
// Two mechanisms, mirroring the Web UI namespace but purpose-built and simpler:
//   1. PUSH — one renderer sink (shared RendererBus) forwards an allowlist of
//      state channels to every connected socket, serialized for the wire.
//   2. COMMAND — a single `command` event dispatches to the transport-agnostic
//      ControlService once the handshake has authenticated.
//   3. RPC — a single `rpc` event dispatches to the SAME shared IPC handlers the
//      desktop uses, behind the SAME capability model as the Web UI (see
//      ../RemoteAccess). Deny by default, and available to PAIRED DEVICES ONLY.
//
// Auth is REQUIRED, and comes in two flavours that are NOT interchangeable:
//
//   API key    — a 48-hex secret, auto-generated on first boot, presented on
//                every handshake. This is how integrations connect. It is copied
//                into a config file by hand, so it is long and never typed.
//
//   Device token — issued when a ShowTrak Remote device pairs (with the
//                workspace PIN, a scanned pairing code, or nothing when PIN
//                protection is off) and persisted in the RemoteDevices table.
//                Revocable per device from Settings.
//
// The distinction matters beyond bookkeeping: a device session is stamped with
// AuthMode 'device', which is what the management bridge will gate on. An API key
// must never inherit privileges its holder did not ask for — a Companion install
// wants to fire cues, not delete groups.
//
// No key configured / disabled feature / wrong credential → refused at the
// handshake. Every branch that reaches next() without an error hands out control
// of a live show, so there is no default-allow path.

import crypto from 'crypto';
import type { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@showtrak/protocol';
import { CreateLogger } from '../Logger';
import { Manager as BroadcastManager } from '../Broadcast';
import { Manager as RemoteDeviceManager } from '../RemoteDeviceManager';
import { Manager as SettingsManager } from '../SettingsManager';
import { Manager as ClientManager } from '../ClientManager';
import { Manager as GroupManager } from '../GroupManager';
import { Manager as TagManager } from '../TagManager';
import { Manager as ScriptManager } from '../ScriptManager';
import { Manager as ScriptWhitelistManager } from '../ScriptWhitelistManager';
import { Manager as ModeManager } from '../ModeManager';
import { Manager as AlertsManager } from '../AlertsManager';
import { Manager as MonitoringTargetManager } from '../MonitoringTargetManager';
import { Manager as DummyClientManager } from '../DummyClientManager';
import { Manager as FreeKioskManager } from '../FreeKioskManager';
import {
  ToPublicClient,
  ToPublicGroup,
  ToPublicMonitor,
  ToPublicDummy,
  ToPublicFreeKiosk,
} from './serializers';
import { PasscodeMatches } from './webui-namespace';
import { RegisterRendererSink } from '../../main/renderer-bus';
import { GetHandler } from '../../main/handler-registry';
import { AuthorizeChannel } from '../RemoteAccess';
import { ControlService } from '../ControlService';

const Logger = CreateLogger('SdkServer');

// --- Handshake rate limiting ---------------------------------------------
// Per-IP failures are counted over a rolling window; tripping the threshold arms
// a short cool-off. State is in-memory and swept lazily on each handshake, so the
// map stays bounded to currently-active IPs without a lingering timer. Mirrors
// the Web UI login throttle in webui-namespace.ts (kept separate to avoid
// coupling the two).
//
// There are TWO instances below, with deliberately different thresholds, because
// the two credentials this namespace accepts are not remotely comparable in
// strength. Sharing one counter would force a single threshold that is either
// uselessly loose for the PIN or needlessly tight for the API key.
const SDK_AUTH_WINDOW_MS = 60 * 1000; // rolling window over which failures are counted
const SDK_AUTH_LOCKOUT_MS = 5 * 60 * 1000; // cool-off once a threshold trips

// The API key is a 192-bit random secret (24 random bytes), so this is NOT a
// brute-force defence — that keyspace is far out of reach. It is a deliberately
// GENEROUS abuse backstop: it only stops a broken or hostile client from
// hammering the handshake indefinitely.
const SDK_AUTH_MAX_FAILURES = 100;

// The workspace PIN is 4 digits — a 10,000-key space. This threshold IS the
// brute-force defence, so it matches the Web UI login throttle rather than the
// generous API-key figure above. At 100 failures/minute a 4-digit PIN falls in
// well under two hours; at 10 with a five-minute lockout it does not.
const SDK_PAIRING_MAX_FAILURES = 10;

interface SdkAuthRecord {
  failures: number;
  windowStart: number;
  lockedUntil: number;
}

/**
 * A per-IP failure counter with its own threshold. Each returned throttle owns a
 * private Map, so a device fumbling its PIN can never contribute to locking out
 * an integration presenting an API key, or vice versa.
 */
function CreateAuthThrottle(MaxFailures: number) {
  const Attempts = new Map<string, SdkAuthRecord>();
  return {
    // How long this IP must wait before another attempt (0 = not limited).
    RetryAfterMs(ip: string, now: number): number {
      const Rec = Attempts.get(ip);
      if (Rec && Rec.lockedUntil > now) return Rec.lockedUntil - now;
      return 0;
    },
    // Record a failure, arming a lockout once too many land inside the window.
    RecordFailure(ip: string, now: number): void {
      let Rec = Attempts.get(ip);
      if (!Rec || now - Rec.windowStart > SDK_AUTH_WINDOW_MS) {
        Rec = { failures: 0, windowStart: now, lockedUntil: 0 };
      }
      Rec.failures += 1;
      if (Rec.failures >= MaxFailures) {
        Rec.lockedUntil = now + SDK_AUTH_LOCKOUT_MS;
        Rec.failures = 0;
        Rec.windowStart = now;
      }
      Attempts.set(ip, Rec);
    },
    // Clear an IP's failure record after a success.
    Clear(ip: string): void {
      Attempts.delete(ip);
    },
    // Evict records that are neither locked nor inside their counting window.
    Sweep(now: number): void {
      for (const [Ip, Rec] of Attempts) {
        if (Rec.lockedUntil <= now && now - Rec.windowStart > SDK_AUTH_WINDOW_MS) {
          Attempts.delete(Ip);
        }
      }
    },
  };
}

const ApiKeyThrottle = CreateAuthThrottle(SDK_AUTH_MAX_FAILURES);
const PairingThrottle = CreateAuthThrottle(SDK_PAIRING_MAX_FAILURES);

// Structural socket/namespace types — the `/sdk` namespace speaks its own
// string-keyed command/push protocol, not the client wire contract.
interface SdkSocket {
  id: string;
  handshake: {
    address: string;
    auth: {
      apiKey?: string;
      /**
       * Explicit pairing intent. Required rather than inferred from the presence
       * of a PIN, because pairing with protection off carries no credential at
       * all — without an explicit flag, "pair me" and "I forgot my API key" would
       * be the same handshake.
       */
      pair?: boolean;
      pin?: string;
      pairingCode?: string;
      deviceToken?: string;
      deviceName?: string;
      platform?: string;
      [k: string]: unknown;
    };
  };
  /**
   * How this socket authenticated. Stamped by the handshake middleware and read
   * wherever privilege differs between an integration and a paired device — most
   * importantly by the Phase 0b `rpc` bridge, which is device-only.
   */
  AuthMode?: SdkAuthMode;
  /** Set for device sessions, so a revoked device can be found and ejected. */
  DeviceID?: string | null;
  /**
   * A freshly minted token, held between the middleware and the connection
   * handler. Socket.IO middleware cannot return a payload with next(), so a
   * successful pairing parks the plaintext token here and the connection handler
   * emits it. Cleared immediately after — this is the only moment it exists in
   * memory, and it must not outlive the emit.
   */
  PendingDeviceToken?: string | null;
  emit(event: string, ...args: unknown[]): boolean;
  on(event: string, listener: (...args: never[]) => void): void;
  disconnect(close?: boolean): void;
}
interface SdkNamespace {
  use(fn: (socket: SdkSocket, next: (err?: Error) => void) => void): void;
  on(event: 'connection', listener: (socket: SdkSocket) => void | Promise<void>): void;
  sockets: { values(): IterableIterator<SdkSocket> };
}

/** Which credential a connected socket presented at the handshake. */
type SdkAuthMode = 'apikey' | 'device';
type SdkIOServer = Server<ClientToServerEvents, ServerToClientEvents>;
type AckCallback = (response?: unknown) => void;

type PublicClientInput = Parameters<typeof ToPublicClient>[0];
type PublicGroupInput = Parameters<typeof ToPublicGroup>[0];
type PublicMonitorInput = Parameters<typeof ToPublicMonitor>[0];
type PublicDummyInput = Parameters<typeof ToPublicDummy>[0];
type PublicFreeKioskInput = Parameters<typeof ToPublicFreeKiosk>[0];

// Channels forwarded to every connected SDK socket (raw PushToRenderers names).
// Monitors and dummies ride their own list/update channels (as the Web UI does);
// the SDK projects each entity into a client-shaped view so integrations treat
// clients, monitors and dummies uniformly.
const SDK_PUSH_ALLOWLIST = new Set<string>([
  'SetFullClientList',
  'ClientUpdated',
  'SetFullMonitoringTargetList',
  'MonitoringTargetUpdated',
  'SetFullDummyClientList',
  'DummyClientUpdated',
  'SetFullFreeKioskTerminalList',
  'FreeKioskTerminalUpdated',
  'SetScriptList',
  'SetTagList',
  'ModeUpdated',
  'AlertActionsUpdated',
  'UpdateScriptExecutions',
  'Notify',
  // Management screens need more than a status grid does. These carry the state
  // a device editing the workspace has to see change under it — pending
  // adoptions appearing, an alert rule being edited at the desk, a USB device
  // plugged into a machine someone is standing at.
  'SetDevicesPendingAdoption',
  'SetFullAlertRuleList',
  'USBDeviceAdded',
  'USBDeviceRemoved',
  'SetOSCList',
  // Deliberately still excluded, matching the Web UI: desktop-only channels
  // (menu actions, show-file, fullscreen, native/app updates, network discovery)
  // and ANYTHING carrying settings — settings hold the SDK API key and the
  // workspace PIN, so a surface that could read them could mint its own access.
]);

// Serialize a push payload for the SDK wire (same client projection the Web UI
// and desktop consume). Monitor/dummy channels are projected to the client shape.
function TransformSdkPush(channel: string, args: unknown[]): unknown[] {
  switch (channel) {
    case 'SetFullClientList':
      return [
        ((args[0] as PublicClientInput[]) || []).map(ToPublicClient),
        ((args[1] as PublicGroupInput[]) || []).map(ToPublicGroup),
      ];
    case 'ClientUpdated':
      return [ToPublicClient(args[0] as PublicClientInput)];
    case 'SetFullMonitoringTargetList':
      return [((args[0] as PublicMonitorInput[]) || []).map(ToPublicMonitor)];
    case 'MonitoringTargetUpdated':
      return [ToPublicMonitor(args[0] as PublicMonitorInput)];
    case 'SetFullDummyClientList':
      return [((args[0] as PublicDummyInput[]) || []).map(ToPublicDummy)];
    case 'DummyClientUpdated':
      return [ToPublicDummy(args[0] as PublicDummyInput)];
    case 'SetFullFreeKioskTerminalList':
      return [((args[0] as PublicFreeKioskInput[]) || []).map(ToPublicFreeKiosk)];
    case 'FreeKioskTerminalUpdated':
      return [ToPublicFreeKiosk(args[0] as PublicFreeKioskInput)];
    default:
      return args;
  }
}

interface SdkConfig {
  Enabled: boolean;
  ApiKey: string;
  /** Whether phones/tablets may pair at all (SDK_ALLOW_REMOTE_PAIRING). */
  PairingEnabled: boolean;
  /**
   * Whether pairing must present the workspace PIN. Protection is only
   * meaningful when a passcode is actually set — the same rule the Web UI
   * applies, so "protection on, passcode blank" does not lock everyone out.
   */
  RequirePin: boolean;
  /** The workspace PIN itself (WEBUI_PASSWORD), shared with the Web UI. */
  Pin: string;
}

// Read SDK API settings, generating and persisting a key on first use so the
// operator always has one to copy into an integration.
//
// Pairing deliberately reads the WEB UI passcode rather than a second setting of
// its own: to an operator there is one "workspace PIN", and two PINs to keep
// straight would be worse than one. The Web UI's own settings remain the single
// place it is configured.
async function GetSdkConfig(): Promise<SdkConfig> {
  let Enabled = true;
  let ApiKey = '';
  let PairingEnabled = true;
  let ProtectionEnabled = false;
  let Pin = '';
  try {
    const EnabledValue = await SettingsManager.GetValue('SDK_API_ENABLED');
    Enabled = EnabledValue == null ? true : !!EnabledValue;
    ApiKey = String((await SettingsManager.GetValue('SDK_API_KEY')) || '').trim();
    const PairingValue = await SettingsManager.GetValue('SDK_ALLOW_REMOTE_PAIRING');
    PairingEnabled = PairingValue == null ? true : !!PairingValue;
    ProtectionEnabled = !!(await SettingsManager.GetValue('WEBUI_PASSWORD_PROTECTION_ENABLED'));
    Pin = String((await SettingsManager.GetValue('WEBUI_PASSWORD')) || '').trim();
  } catch {
    /* fall back to safe defaults */
  }
  return { Enabled, ApiKey, PairingEnabled, RequirePin: ProtectionEnabled && Pin.length > 0, Pin };
}

async function EnsureApiKey(): Promise<void> {
  try {
    const Existing = String((await SettingsManager.GetValue('SDK_API_KEY')) || '').trim();
    if (Existing) return;
    const Key = crypto.randomBytes(24).toString('hex');
    await SettingsManager.Set('SDK_API_KEY', Key);
    Logger.log('Generated a new SDK API key.');
  } catch (e) {
    Logger.error('Failed to ensure an SDK API key exists:', e);
  }
}

// Map a wire command name + args object to a ControlService call.
async function DispatchCommand(name: unknown, rawArgs: unknown) {
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
  const slug = String(args.slug ?? '');
  const scriptSlug = String(args.scriptSlug ?? '');
  const eventSlug = String(args.eventSlug ?? '');
  switch (name) {
    case 'wol.all':
      return ControlService.WakeAll();
    case 'wol.client':
      return ControlService.WakeClient(slug);
    case 'wol.group':
      return ControlService.WakeGroup(slug);
    case 'wol.tag':
      return ControlService.WakeTag(slug);
    case 'script.all':
      return ControlService.RunScriptOnAll(scriptSlug);
    case 'script.client':
      return ControlService.RunScriptOnClient(slug, scriptSlug);
    case 'script.group':
      return ControlService.RunScriptOnGroup(slug, scriptSlug);
    case 'script.tag':
      return ControlService.RunScriptOnTag(slug, scriptSlug);
    case 'event.all':
      return ControlService.TriggerEventOnAll(eventSlug);
    case 'event.client':
      return ControlService.TriggerEventOnClient(slug, eventSlug);
    case 'event.group':
      return ControlService.TriggerEventOnGroup(slug, eventSlug);
    case 'event.tag':
      return ControlService.TriggerEventOnTag(slug, eventSlug);
    case 'alerts.set':
      return ControlService.SetAlertsEnabled(!!args.enabled);
    case 'alerts.toggle':
      return ControlService.ToggleAlerts();
    case 'mode.set':
      return ControlService.SetMode(String(args.mode ?? 'SHOW'));
    case 'mode.toggle':
      return ControlService.ToggleMode();
    case 'identify.client':
      return ControlService.Identify(slug);
    case 'identify.stop':
      return ControlService.StopIdentify(slug);
    case 'modal.openClient':
      return ControlService.OpenClientModal(slug);
    case 'modal.closeAll':
      return ControlService.CloseModals();
    case 'show.save':
      return ControlService.SaveShow();
    case 'system.shutdown':
      return ControlService.Shutdown();
    case 'system.shutdownForce':
      return ControlService.ShutdownForce();
    default:
      return { ok: false, detail: `Unknown command "${String(name)}"` };
  }
}

function SetupSdkNamespace(io: SdkIOServer) {
  const sdk = io.of('/sdk') as unknown as SdkNamespace;

  // Ensure a key exists so the operator can always find one in Settings.
  EnsureApiKey().catch(() => {});

  // Forward allowlisted pushes to every connected socket (all are authed — the
  // handshake middleware refuses unauthenticated connections).
  RegisterRendererSink((channel: string, ...args: unknown[]) => {
    if (!SDK_PUSH_ALLOWLIST.has(channel)) return;
    let payload: unknown[];
    try {
      payload = TransformSdkPush(channel, args);
    } catch {
      return;
    }
    const sockets =
      sdk.sockets && typeof sdk.sockets.values === 'function' ? sdk.sockets.values() : [];
    for (const socket of sockets) {
      try {
        socket.emit(channel, ...payload);
      } catch {
        /* one dead socket must not block delivery to the rest */
      }
    }
  });

  // Handshake gate. Three credentials are accepted, in a fixed order so a socket
  // presenting more than one cannot shop for the most permissive:
  //
  //   1. deviceToken  — an already-paired ShowTrak Remote device.
  //   2. pair: true   — a device asking to pair, with the workspace PIN, a
  //                     scanned pairing code, or nothing when PIN protection is
  //                     off. Succeeds by minting a token, never by admitting an
  //                     unauthenticated socket.
  //   3. apiKey       — an integration (the SDK, Companion). Unchanged.
  //
  // Anything else is refused. Every path that reaches next() without an error is
  // a path that hands out control of a live show, so there is no default-allow
  // branch anywhere below.
  sdk.use((socket, next) => {
    void (async () => {
      const IP = String((socket.handshake && socket.handshake.address) || 'unknown');
      const Now = Date.now();
      try {
        ApiKeyThrottle.Sweep(Now);
        PairingThrottle.Sweep(Now);

        const Cfg = await GetSdkConfig();
        if (!Cfg.Enabled) return next(new Error('SDK API is disabled'));

        const Auth = (socket.handshake && socket.handshake.auth) || {};
        const PresentedToken = String(Auth.deviceToken || '').trim();
        const PresentedKey = String(Auth.apiKey || '');

        // --- 1. Paired device reconnecting ---------------------------------
        if (PresentedToken) {
          // Throttled as an abuse backstop only: a device token is 256 bits, so
          // this is the API-key threshold's job, not the PIN's.
          const RetryAfter = ApiKeyThrottle.RetryAfterMs(IP, Now);
          if (RetryAfter > 0) {
            Logger.warn('SDK handshake throttled', { ip: IP, retryAfterMs: RetryAfter });
            return next(
              new Error(`Too many failed attempts. Try again in ${Math.ceil(RetryAfter / 1000)}s`)
            );
          }
          const Device = await RemoteDeviceManager.Verify(PresentedToken);
          if (!Device) {
            ApiKeyThrottle.RecordFailure(IP, Now);
            // Distinct from 'Unauthorized' on purpose: the app must be able to
            // tell "this credential is dead, forget it and re-pair" from "the
            // server refused me", or it will retry a revoked token forever.
            return next(new Error('Device revoked'));
          }
          ApiKeyThrottle.Clear(IP);
          socket.AuthMode = 'device';
          socket.DeviceID = Device.DeviceID;
          return next();
        }

        // --- 2. Pairing request --------------------------------------------
        if (Auth.pair === true) {
          if (!Cfg.PairingEnabled) return next(new Error('Remote pairing is disabled'));

          const RetryAfter = PairingThrottle.RetryAfterMs(IP, Now);
          if (RetryAfter > 0) {
            Logger.warn('Remote pairing throttled', { ip: IP, retryAfterMs: RetryAfter });
            return next(
              new Error(`Too many failed attempts. Try again in ${Math.ceil(RetryAfter / 1000)}s`)
            );
          }

          const PresentedCode = String(Auth.pairingCode || '').trim();
          if (PresentedCode) {
            // A scanned code stands in for the PIN entirely — it is single-use
            // and expires in a minute, which makes it the stronger of the two.
            if (!RemoteDeviceManager.RedeemPairingCode(PresentedCode)) {
              PairingThrottle.RecordFailure(IP, Now);
              return next(new Error('Invalid or expired pairing code'));
            }
          } else if (Cfg.RequirePin) {
            const PresentedPin = String(Auth.pin || '').trim();
            if (!PresentedPin || !PasscodeMatches(PresentedPin, Cfg.Pin)) {
              PairingThrottle.RecordFailure(IP, Now);
              return next(new Error('Unauthorized'));
            }
          }
          // else: protection is off, so the workspace has no PIN to present.
          // This mirrors the Web UI, which lets a browser straight in under the
          // same setting — the operator has chosen an open workspace.

          const [PairErr, Paired] = await RemoteDeviceManager.Pair(Auth.deviceName, Auth.platform);
          if (PairErr || !Paired) return next(new Error('Pairing failed'));

          PairingThrottle.Clear(IP);
          socket.AuthMode = 'device';
          socket.DeviceID = Paired.DeviceID;
          socket.PendingDeviceToken = Paired.DeviceToken;
          return next();
        }

        // --- 3. Integration API key ----------------------------------------
        const RetryAfter = ApiKeyThrottle.RetryAfterMs(IP, Now);
        if (RetryAfter > 0) {
          Logger.warn('SDK handshake throttled', { ip: IP, retryAfterMs: RetryAfter });
          return next(
            new Error(`Too many failed attempts. Try again in ${Math.ceil(RetryAfter / 1000)}s`)
          );
        }
        if (!Cfg.ApiKey) return next(new Error('SDK API key not configured'));
        if (!PresentedKey || !PasscodeMatches(PresentedKey, Cfg.ApiKey)) {
          ApiKeyThrottle.RecordFailure(IP, Now);
          return next(new Error('Unauthorized'));
        }
        // A valid key clears the IP's failure record so a legitimate client is
        // never penalised for earlier misconfiguration.
        ApiKeyThrottle.Clear(IP);
        socket.AuthMode = 'apikey';
        socket.DeviceID = null;
        next();
      } catch {
        next(new Error('Auth failed'));
      }
    })();
  });

  const SendInitialState = async (socket: SdkSocket) => {
    try {
      const [cErr, clients] = await ClientManager.GetAll();
      const [gErr, groups] = await GroupManager.GetAll();
      socket.emit(
        'SetFullClientList',
        cErr || !clients ? [] : clients.map(ToPublicClient),
        gErr ? [] : (groups || []).map(ToPublicGroup)
      );

      try {
        const [, monitors] = await MonitoringTargetManager.GetAll();
        socket.emit('SetFullMonitoringTargetList', (monitors || []).map(ToPublicMonitor));
      } catch {
        socket.emit('SetFullMonitoringTargetList', []);
      }

      try {
        const [, dummies] = await DummyClientManager.GetAll();
        socket.emit('SetFullDummyClientList', (dummies || []).map(ToPublicDummy));
      } catch {
        socket.emit('SetFullDummyClientList', []);
      }

      try {
        const [, kiosks] = await FreeKioskManager.GetAll();
        socket.emit('SetFullFreeKioskTerminalList', (kiosks || []).map(ToPublicFreeKiosk));
      } catch {
        socket.emit('SetFullFreeKioskTerminalList', []);
      }

      try {
        const Tags = await TagManager.GetAllViews();
        socket.emit('SetTagList', Tags || []);
      } catch {
        socket.emit('SetTagList', []);
      }

      try {
        const Scripts = await ScriptWhitelistManager.DecorateCatalog(
          (await ScriptManager.GetScripts()) || []
        );
        socket.emit('SetScriptList', Scripts);
      } catch {
        socket.emit('SetScriptList', []);
      }

      socket.emit('ModeUpdated', ModeManager.Get());
      socket.emit('AlertActionsUpdated', AlertsManager.GetActionsEnabled());
    } catch (e) {
      Logger.error('SDK initial state failed:', e);
    }
  };

  // Eject the sockets belonging to a revoked device. Revocation has to reach a
  // LIVE session, not just the next handshake: the reason an operator revokes is
  // usually a phone that is out of their hands right now, and a connected socket
  // never re-presents its credential.
  BroadcastManager.on('RemoteDeviceRevoked', (DeviceID: unknown) => {
    const Target = typeof DeviceID === 'string' ? DeviceID : null;
    const Sockets =
      sdk.sockets && typeof sdk.sockets.values === 'function'
        ? Array.from(sdk.sockets.values())
        : [];
    for (const Socket of Sockets) {
      // A null DeviceID means "revoke all", so every device session goes.
      if (Socket.AuthMode !== 'device') continue;
      if (Target && Socket.DeviceID !== Target) continue;
      try {
        Socket.emit('revoked');
        Socket.disconnect(true);
      } catch {
        /* intentional: one dead socket must not block ejecting the rest */
      }
    }
  });

  sdk.on('connection', async (socket) => {
    Logger.log('SDK client connected', {
      id: socket.id,
      ip: socket.handshake.address,
      mode: socket.AuthMode,
    });

    // Hand back a token minted during this handshake. This is the only time the
    // plaintext exists outside the device — only its hash was persisted — so it
    // is emitted before any state and cleared immediately afterwards.
    if (socket.PendingDeviceToken) {
      const DeviceToken = socket.PendingDeviceToken;
      socket.PendingDeviceToken = null;
      socket.emit('paired', { deviceId: socket.DeviceID, deviceToken: DeviceToken });
    }

    await SendInitialState(socket);

    socket.on('command', (name: unknown, args: unknown, ack: AckCallback) => {
      void (async () => {
        try {
          const Result = await DispatchCommand(name, args);
          if (typeof ack === 'function') ack(Result);
        } catch (e) {
          Logger.error('SDK command failed:', e);
          if (typeof ack === 'function') ack({ ok: false, detail: 'Command failed' });
        }
      })();
    });

    // Management bridge. Dispatches to the SAME shared IPC handlers the desktop
    // and Web UI use, behind the SAME deny-by-default capability model — so a
    // mutation has exactly one implementation and one authorisation rule no
    // matter which surface asked for it.
    //
    // DEVICE SESSIONS ONLY. An API key lives in plaintext in a Companion config
    // file and was handed out to fire cues; silently widening every existing key
    // to "can delete every group" is privilege escalation for integrations that
    // never asked for it. Companion keeps the command surface it already had.
    socket.on('rpc', (channel: unknown, args: unknown, ack: AckCallback) => {
      void (async () => {
        try {
          if (socket.AuthMode !== 'device') {
            return ack && ack({ error: 'forbidden' });
          }
          if (typeof channel !== 'string') return ack && ack({ error: 'invalid_channel' });
          const Decision = await AuthorizeChannel('REMOTE', channel);
          if (!Decision.allowed) return ack && ack({ error: Decision.reason || 'forbidden' });
          const Handler = GetHandler(channel);
          if (typeof Handler !== 'function') return ack && ack({ error: 'unknown_channel' });
          const Args = Array.isArray(args) ? args : [];
          const Result = await Handler(null, ...Args);
          if (ack) ack({ result: Result });
        } catch (e) {
          Logger.error('SDK rpc failed:', e);
          if (ack) ack({ error: 'failed' });
        }
      })();
    });
  });

  return sdk;
}

export { SetupSdkNamespace, DispatchCommand, GetSdkConfig, SDK_PUSH_ALLOWLIST };
