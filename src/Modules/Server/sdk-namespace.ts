// SDK control API (`/sdk`) Socket.IO namespace.
//
// The external-integration surface: the ShowTrak Server SDK (and anything built
// on it — the Companion module, future apps) connects here to drive the instance
// in real time and receive live status pushes. Supports multiple concurrent
// clients natively (Socket.IO fan-out).
//
// Two mechanisms, mirroring the Web UI namespace but purpose-built and simpler:
//   1. PUSH — one renderer sink (shared RendererBus) forwards an allowlist of
//      state channels to every connected socket, serialized for the wire.
//   2. COMMAND — a single `command` event dispatches to the transport-agnostic
//      ControlService after API-key auth.
//
// Auth is a REQUIRED API key (constant-time compared), read from settings and
// auto-generated on first boot. No key configured / disabled feature / wrong key
// → the connection is refused at the handshake.

import crypto from 'crypto';
import type { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@showtrak/protocol';
import { CreateLogger } from '../Logger';
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
import { ControlService } from '../ControlService';

const Logger = CreateLogger('SdkServer');

// --- Handshake rate limiting ---------------------------------------------
// The API key is a 192-bit random secret (24 random bytes), so this is NOT a
// brute-force defence — that keyspace is far out of reach. It is a deliberately
// GENEROUS abuse backstop: it only stops a broken or hostile client from
// hammering the handshake indefinitely. Per-IP failures are counted over a
// rolling window; tripping the (high) threshold arms a short cool-off. State is
// in-memory and swept lazily on each handshake, so the map stays bounded to
// currently-active IPs without a lingering timer. Mirrors the Web UI login
// throttle in webui-namespace.ts (kept separate to avoid coupling the two).
const SDK_AUTH_MAX_FAILURES = 100; // very generous: failures per window before lockout
const SDK_AUTH_WINDOW_MS = 60 * 1000; // rolling window over which failures are counted
const SDK_AUTH_LOCKOUT_MS = 5 * 60 * 1000; // cool-off once the threshold trips
interface SdkAuthRecord {
  failures: number;
  windowStart: number;
  lockedUntil: number;
}
const SdkAuthAttempts = new Map<string, SdkAuthRecord>();

// How long this IP must wait before another handshake attempt (0 = not limited).
function AuthRetryAfterMs(ip: string, now: number): number {
  const Rec = SdkAuthAttempts.get(ip);
  if (Rec && Rec.lockedUntil > now) return Rec.lockedUntil - now;
  return 0;
}

// Record a failed handshake, arming a lockout once too many failures land inside
// the rolling window.
function RecordAuthFailure(ip: string, now: number): void {
  let Rec = SdkAuthAttempts.get(ip);
  if (!Rec || now - Rec.windowStart > SDK_AUTH_WINDOW_MS) {
    Rec = { failures: 0, windowStart: now, lockedUntil: 0 };
  }
  Rec.failures += 1;
  if (Rec.failures >= SDK_AUTH_MAX_FAILURES) {
    Rec.lockedUntil = now + SDK_AUTH_LOCKOUT_MS;
    Rec.failures = 0;
    Rec.windowStart = now;
  }
  SdkAuthAttempts.set(ip, Rec);
}

// Clear an IP's failure record after a successful handshake.
function ClearAuthFailures(ip: string): void {
  SdkAuthAttempts.delete(ip);
}

// Evict records that are neither locked nor inside their counting window.
function SweepAuthFailures(now: number): void {
  for (const [Ip, Rec] of SdkAuthAttempts) {
    if (Rec.lockedUntil <= now && now - Rec.windowStart > SDK_AUTH_WINDOW_MS) {
      SdkAuthAttempts.delete(Ip);
    }
  }
}

// Structural socket/namespace types — the `/sdk` namespace speaks its own
// string-keyed command/push protocol, not the client wire contract.
interface SdkSocket {
  id: string;
  handshake: { address: string; auth: { apiKey?: string; [k: string]: unknown } };
  emit(event: string, ...args: unknown[]): boolean;
  on(event: string, listener: (...args: never[]) => void): void;
}
interface SdkNamespace {
  use(fn: (socket: SdkSocket, next: (err?: Error) => void) => void): void;
  on(event: 'connection', listener: (socket: SdkSocket) => void | Promise<void>): void;
  sockets: { values(): IterableIterator<SdkSocket> };
}
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
}

// Read SDK API settings, generating and persisting a key on first use so the
// operator always has one to copy into an integration.
async function GetSdkConfig(): Promise<SdkConfig> {
  let Enabled = true;
  let ApiKey = '';
  try {
    const EnabledValue = await SettingsManager.GetValue('SDK_API_ENABLED');
    Enabled = EnabledValue == null ? true : !!EnabledValue;
    ApiKey = String((await SettingsManager.GetValue('SDK_API_KEY')) || '').trim();
  } catch {
    /* fall back to safe defaults */
  }
  return { Enabled, ApiKey };
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
    // Unlike OSC, the SDK carries a structured payload, so a target can be
    // named separately from the workflow rather than encoded into a path.
    case 'workflow.run':
      return ControlService.RunWorkflow(
        String(args.workflowSlug ?? ''),
        args.target == null ? null : String(args.target)
      );
    case 'workflow.abort':
      return ControlService.AbortWorkflowRun(String(args.runKey ?? ''));
    case 'alerts.set':
      return ControlService.SetAlertsEnabled(!!args.enabled);
    case 'alerts.toggle':
      return ControlService.ToggleAlerts();
    case 'mode.set':
      return ControlService.SetMode(String(args.mode ?? 'SHOW'));
    case 'mode.toggle':
      return ControlService.ToggleMode();
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

  // Required-API-key gate at the handshake, behind a generous per-IP throttle.
  sdk.use((socket, next) => {
    void (async () => {
      const IP = String((socket.handshake && socket.handshake.address) || 'unknown');
      const Now = Date.now();
      try {
        SweepAuthFailures(Now);
        const RetryAfter = AuthRetryAfterMs(IP, Now);
        if (RetryAfter > 0) {
          Logger.warn('SDK handshake throttled', { ip: IP, retryAfterMs: RetryAfter });
          return next(
            new Error(`Too many failed attempts. Try again in ${Math.ceil(RetryAfter / 1000)}s`)
          );
        }
        const Cfg = await GetSdkConfig();
        if (!Cfg.Enabled) return next(new Error('SDK API is disabled'));
        if (!Cfg.ApiKey) return next(new Error('SDK API key not configured'));
        const Presented = String((socket.handshake.auth && socket.handshake.auth.apiKey) || '');
        if (!Presented || !PasscodeMatches(Presented, Cfg.ApiKey)) {
          RecordAuthFailure(IP, Now);
          return next(new Error('Unauthorized'));
        }
        // A valid key clears the IP's failure record so a legitimate client is
        // never penalised for earlier misconfiguration.
        ClearAuthFailures(IP);
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

  sdk.on('connection', async (socket) => {
    Logger.log('SDK client connected', { id: socket.id, ip: socket.handshake.address });
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
  });

  return sdk;
}

export { SetupSdkNamespace, DispatchCommand, GetSdkConfig, SDK_PUSH_ALLOWLIST };
