import { CreateLogger } from '../Logger';
import type { ClientManagerType } from '../ClientManager';
import type {
  DebugTrafficEntry,
  FreeKioskTerminalView,
  OSCRoute,
  OSCRouteValue,
  OSCRouteValueList,
} from '@showtrak/protocol';
import { OSC_PORT } from '../Config/constants';
import { Manager as Broadcast } from '../Broadcast';
import { RunWithAuditSource } from '../AuditLog/source';
import { Manager as ScriptManager } from '../ScriptManager';
import { Manager as DummyClientManager } from '../DummyClientManager';
import { Manager as GroupManager } from '../GroupManager';
import { Manager as TagManager } from '../TagManager';
import { Manager as ScriptWhitelistManager } from '../ScriptWhitelistManager';
import { Manager as MonitoringTargetManager } from '../MonitoringTargetManager';
import { Manager as MonitoringMethods } from '../MonitoringMethods';
import type { MonitoringSettingField } from '../MonitoringMethods/types';
import { Manager as FreeKioskManager } from '../FreeKioskManager';
import { Manager as IPCValidation } from '../IPCValidation';
import { FREEKIOSK_COMMANDS, GetFreeKioskCommand } from '../FreeKiosk/commands';
import type { FreeKioskCommandDef } from '../FreeKiosk/commands';
import { DisplayModeLabel } from '../FreeKiosk/metrics';
import { ControlService } from '../ControlService';
import { IsTransientNetworkError, DescribeError } from '@showtrak/protocol/runtime';

const Logger = CreateLogger('OSC');

import { Server } from 'node-osc';

// Minimal shape of the node-osc Server we use, so the mutable handle stays typed.
// `_sock` is node-osc's internal dgram socket: the library never attaches an
// 'error' handler to it, so we reach in to add one (see StartOSCServer).
interface OSCSocketLike {
  on(event: 'error', handler: (err: Error) => void): void;
}
interface OSCServerInstance {
  on(event: 'message', handler: (route: unknown, info?: OSCRemoteInfo) => void): void;
  on(event: 'error', handler: (err: Error, info?: OSCRemoteInfo) => void): void;
  close(cb?: () => void): void;
  _sock?: OSCSocketLike;
}

// Not-yet-migrated JS manager, typed loosely until its own migration.
import { Manager as ClientManager } from '../ClientManager';

// The live OSC server. Recreated when the OSC port setting changes (driven by
// main/live-settings via OSC.RestartServer), so the binding moves to the new
// port without an app restart. Settings/DB are intentionally not imported here
// to keep this module decoupled and testable.
let OSCServer: OSCServerInstance | null = null;
let CurrentOSCPort: number | null = null;

// Clamp a requested port to a valid range, falling back to the compiled-in
// default when unset or out of range.
function NormalizeOSCPort(Value: unknown): number {
  const Port = Number(Value);
  if (!Number.isFinite(Port) || Port < 1 || Port > 65535) return OSC_PORT;
  return Math.round(Port);
}

function StartOSCServer(Port: number): void {
  try {
    OSCServer = new Server(Port, '0.0.0.0', () => {
      Logger.log(`OSC Server is listening on port ${Port}`);
    });
    OSCServer!.on('message', HandleOSCMessage);
    // A bind failure (port already in use) or a transient network error is
    // emitted asynchronously on the underlying dgram socket, so the constructor's
    // try/catch can't catch it. Listen on the socket directly; node-osc exposes
    // it as `_sock`.
    const Sock = OSCServer!._sock;
    const SocketGuarded = Boolean(Sock && typeof Sock.on === 'function');
    if (SocketGuarded) {
      Sock!.on('error', (Err) => HandleOSCSocketError(Port, Err));
    }
    // node-osc emits 'error' on the Server for undecodable inbound packets. An
    // EventEmitter with no 'error' listener throws, so a single malformed UDP
    // datagram would crash the app; absorb them here as a warning instead.
    //
    // Since node-osc 11 the Server also re-emits socket errors, without the
    // remote-info argument that every decode failure carries. Those are already
    // covered by the `_sock` listener above, so only the rinfo-bearing case is a
    // bad packet; anything else falls through to the socket handling (which the
    // `_sock` listener does directly when it is available).
    OSCServer!.on('error', (Err, Info) => {
      if (!Info) {
        if (!SocketGuarded) HandleOSCSocketError(Port, Err);
        return;
      }
      Logger.warn(`Ignoring malformed OSC packet: ${DescribeError(Err)}`);
    });
    CurrentOSCPort = Port;
  } catch (Err) {
    OSCServer = null;
    Logger.error(`Failed to start OSC server on port ${Port}:`, Err);
    Broadcast.emit('Notify', `Failed to start OSC server on port ${Port}`, 'error');
  }
}

// Handle an asynchronous error on the OSC listener's socket. Transient network
// errors (interface loss) are logged and ignored; a bound 0.0.0.0 listener
// recovers on its own. A bind failure means the port is unusable, so we tear the
// dead socket down and surface it to the operator.
function HandleOSCSocketError(Port: number, Err: Error): void {
  if (IsTransientNetworkError(Err)) {
    Logger.warn(`OSC socket transient network error on port ${Port}: ${DescribeError(Err)}`);
    return;
  }
  Logger.error(`OSC socket error on port ${Port}: ${DescribeError(Err)}`);
  Broadcast.emit('Notify', `OSC server error on port ${Port}: ${DescribeError(Err)}`, 'error');
  StopOSCServer();
}

// Stop the OSC listener entirely (OSC control disabled). Safe to call when
// already stopped.
function StopOSCServer(): void {
  if (!OSCServer) return;
  try {
    OSCServer.close();
  } catch (Err) {
    Logger.error('Failed to close OSC server:', Err);
  }
  OSCServer = null;
  CurrentOSCPort = null;
}

// Rebind the OSC listener to the given port. No-op-safe when the port is
// unchanged so redundant setting broadcasts don't churn the socket.
function RestartOSCServer(Port: unknown): void {
  const Next = NormalizeOSCPort(Port);
  if (OSCServer && Next === CurrentOSCPort) return;
  StopOSCServer();
  StartOSCServer(Next);
}

interface RouteResult {
  ok: boolean;
  detail: string;
}

// Route params are extracted from the URL path parts, so every value is a string.
type OSCRequest = Record<string, string>;

// Source metadata for an inbound OSC packet: the sender IP and the message's
// OSC arguments. Routes dispatch on the address alone, so arguments never
// change which route runs; the routes that take values read them from here.
// HTTP-mirrored calls carry no Args.
interface OSCMeta {
  IP: string | null;
  Args?: OSCArg[];
}

// An OSC argument as node-osc decodes it, reduced to what a route can use.
type OSCArg = string | number | boolean;

// node-osc hands a message over as [address, ...args]. Numbers, strings and
// booleans pass through; anything else (blobs, nil) is turned into text so a
// stray type can't reach a device as an object.
function ExtractOSCArgs(Route: unknown): OSCArg[] {
  if (!Array.isArray(Route) || Route.length < 2) return [];
  return Route.slice(1).map((Arg) => {
    if (typeof Arg === 'number' || typeof Arg === 'string' || typeof Arg === 'boolean') return Arg;
    if (Arg && typeof Arg === 'object' && 'value' in (Arg as Record<string, unknown>)) {
      const Inner = (Arg as { value: unknown }).value;
      if (typeof Inner === 'number' || typeof Inner === 'string' || typeof Inner === 'boolean') {
        return Inner;
      }
    }
    return Arg == null ? '' : String(Arg);
  });
}

// Minimal shape of the UDP remote-info object node-osc passes to the handler.
interface OSCRemoteInfo {
  address?: string;
  family?: string;
  port?: number;
  size?: number;
}

// Debug-traffic payload emitted for the WebUI traffic inspector: the protocol's
// DebugTrafficEntry, less what emitDebugEntry stamps on it.
type OSCDebugPayload = Omit<DebugTrafficEntry, 'protocol' | 'timestamp'>;

type OSCRouteCallback = (Req: OSCRequest, Meta?: OSCMeta) => RouteResult | Promise<RouteResult>;

// Entity types reused from the (not-yet-migrated) managers via their typed public APIs.
type OSCGroup = NonNullable<Awaited<ReturnType<typeof GroupManager.Get>>[1]>;
type OSCClient = NonNullable<Awaited<ReturnType<ClientManagerType['GetAll']>>[1]>[number];
type OSCTag = NonNullable<Awaited<ReturnType<typeof TagManager.GetBySlug>>>;

// An OSCRouteValue (from the protocol) is one accepted value for a route's
// placeholder(s), as listed in the OSC/API reference, e.g. `pjlink/power.on`
// for a check action, `reboot` for a FreeKiosk command; an OSCRouteValueList
// is every value a route accepts. Plain data so it survives the JSON clone
// that pushes the route list to the renderer.

// A route in the table: the protocol's OSCRoute, as the OSC reference lists it
// (SetOSCList, whose JSON clone drops the handler), plus its handler.
interface OSCRouteEntry extends OSCRoute {
  Callback: OSCRouteCallback;
}

const Routes: OSCRouteEntry[] = [];

function emitDebugEntry(payload: OSCDebugPayload) {
  const Entry: DebugTrafficEntry = {
    protocol: 'osc',
    timestamp: Date.now(),
    ...payload,
  };
  Broadcast.emit('DebugTrafficEntry', Entry);
}

function failureResult(detail: unknown): RouteResult {
  return {
    ok: false,
    detail: String(detail || 'Request failed'),
  };
}

function successResult(detail: unknown = ''): RouteResult {
  return {
    ok: true,
    detail: String(detail || ''),
  };
}

// Resolve a real client addressed over OSC by either its UUID or its slug
// (slugs are the friendly, human-typed key). UUID is tried first so an exact
// UUID always wins; slug is the fallback. Returns null when neither matches.
async function resolveClientByKey(Key: string): Promise<OSCClient | null> {
  if (!Key) return null;
  const [Err, Client] = await ClientManager.Get(Key);
  if (!Err && Client) return Client;
  if (typeof ClientManager.GetBySlug === 'function') {
    return await ClientManager.GetBySlug(Key);
  }
  return null;
}

// Resolve a group addressed over OSC by either its numeric GroupID or its slug.
async function resolveGroupByKey(Key: string): Promise<OSCGroup | null> {
  const Trimmed = String(Key ?? '').trim();
  if (/^\d+$/.test(Trimmed)) {
    const [GroupErr, Group] = await GroupManager.Get(Number(Trimmed));
    if (!GroupErr && Group) return Group;
  }
  if (typeof GroupManager.GetBySlug === 'function') {
    return await GroupManager.GetBySlug(Trimmed);
  }
  return null;
}

async function getGroupClients(
  GroupIDRaw: string
): Promise<[RouteResult, null, null] | [null, OSCGroup, OSCClient[]]> {
  const Group = await resolveGroupByKey(GroupIDRaw);
  if (!Group) {
    return [failureResult(`Invalid Group "${GroupIDRaw}"`), null, null];
  }

  const [ClientsErr, Clients] = await ClientManager.GetAll();
  if (ClientsErr) {
    return [failureResult('Failed to fetch all clients'), null, null];
  }

  const GroupClients = (Clients || []).filter(
    (Client) => Number(Client.GroupID) === Number(Group.GroupID)
  );
  return [null, Group, GroupClients];
}

// Resolve a tag addressed over OSC by either its numeric TagID or its slug.
async function resolveTagByKey(Key: string): Promise<OSCTag | null> {
  const Trimmed = String(Key ?? '').trim();
  if (/^\d+$/.test(Trimmed)) {
    const [TagErr, Tag] = await TagManager.Get(Number(Trimmed));
    if (!TagErr && Tag) return Tag;
  }
  if (typeof TagManager.GetBySlug === 'function') {
    return await TagManager.GetBySlug(Trimmed);
  }
  return null;
}

// Expand a tag into its member clients. Unlike a group (a single GroupID FK),
// tag membership is the dynamic Scope { Workspace, Groups[], Clients[], Tags[] },
// so a client belongs when it matches that scope, reusing the same predicate
// the script whitelist uses (Workspace = all, else by explicit UUID, group, or
// membership of another tag this one absorbs).
async function getTagClients(
  TagKeyRaw: string
): Promise<[RouteResult, null, null] | [null, OSCTag, OSCClient[]]> {
  const Tag = await resolveTagByKey(TagKeyRaw);
  if (!Tag) {
    return [failureResult(`Invalid Tag "${TagKeyRaw}"`), null, null];
  }

  const [ClientsErr, Clients] = await ClientManager.GetAll();
  if (ClientsErr) {
    return [failureResult('Failed to fetch all clients'), null, null];
  }

  // The tag list is needed to expand any tags this one absorbs.
  const AllTags = await TagManager.GetAllViews();
  const TagClients = (Clients || []).filter((Client) =>
    ScriptWhitelistManager.IsClientAllowed(Tag.Scope, Client, AllTags)
  );
  return [null, Tag, TagClients];
}

async function HandleOSCMessage(Route: unknown, Info: OSCRemoteInfo | undefined) {
  const RawPath = Array.isArray(Route) && Route.length > 0 ? String(Route[0] || '') : '';
  const ValidRoutes: OSCRouteEntry[] = [];

  Main: for (const PRoute of Routes) {
    const PRouteParts = PRoute.Path.split('/');
    const RouteParts = RawPath.split('/');
    if (PRouteParts.length !== RouteParts.length) continue Main;
    Sub: for (let i = 0; i < PRouteParts.length; i++) {
      // Equal-length arrays (checked above) → both indices are in-bounds.
      const PPart = PRouteParts[i]!;
      const RPart = RouteParts[i]!;
      if (PPart === RPart || PPart.startsWith(':')) continue Sub;
      continue Main;
    }
    ValidRoutes.push(PRoute);
  }

  if (!ValidRoutes || ValidRoutes.length === 0) {
    emitDebugEntry({
      valid: false,
      summary: RawPath || '[empty route]',
      detail: 'No matching OSC route',
    });
    return Logger.error(`Invalid OSC Route: ${RawPath}`);
  }

  for (const ValidRoute of ValidRoutes) {
    Logger.log(`Executing route: ${ValidRoute.Path}`);

    const Req: OSCRequest = {};

    const PRouteParts = ValidRoute.Path.split('/');
    const RouteParts = RawPath.split('/');

    for (let i = 0; i < PRouteParts.length; i++) {
      // Matched routes share RawPath's part count → both indices are in-bounds.
      const PPart = PRouteParts[i]!;
      if (PPart.startsWith(':')) {
        Req[PPart.substring(1)] = RouteParts[i]!;
      }
    }

    // Source address of the UDP packet (used by routes that record sender IPs)
    // and the message's arguments (used by routes that take values).
    const Meta: OSCMeta = {
      IP: Info && Info.address ? Info.address : null,
      Args: ExtractOSCArgs(Route),
    };

    const RequestComplete = await RunWithAuditSource(Meta.IP ? `OSC (${Meta.IP})` : 'OSC', () =>
      ValidRoute.Callback(Req, Meta)
    );
    const RequestPassed =
      RequestComplete && typeof RequestComplete === 'object'
        ? RequestComplete.ok !== false
        : RequestComplete !== false;
    const RequestDetail =
      RequestComplete && typeof RequestComplete === 'object' && RequestComplete.detail
        ? String(RequestComplete.detail)
        : ValidRoute.Title || ValidRoute.Path;

    if (!RequestPassed) {
      emitDebugEntry({
        valid: false,
        summary: RawPath,
        detail: RequestDetail,
        source: Meta.IP || null,
      });
      continue;
    }
    emitDebugEntry({
      valid: true,
      summary: RawPath,
      detail: RequestDetail,
      source: Meta.IP || null,
    });
    Broadcast.emit('Notify', `OSC Processed Successfully`, 'success', 1200);
    return Logger.success(`OSC Complete: ${RawPath}`);
  }
  return Logger.warn(`OSC Incomplete but has matching path: ${RawPath}`);
}

const OSC = {
  GetRoutes(): OSCRouteEntry[] {
    return Routes;
  },

  CreateRoute(
    Path: string,
    Callback: OSCRouteCallback,
    Title = 'Default OSC Route',
    Values?: OSCRouteValueList
  ): void {
    Routes.push({
      Title,
      Path,
      Callback,
      ...(Values ? { Values } : {}),
    });
  },

  // Rebind the OSC listener to the given port. Called by main/live-settings with
  // the configured port at boot and whenever the OSC port setting changes.
  RestartServer(Port: unknown): void {
    RestartOSCServer(Port);
  },

  // Stop the OSC listener (OSC control disabled). Called by main/live-settings.
  StopServer(): void {
    StopOSCServer();
  },
};

// System Control
OSC.CreateRoute(
  '/API/Shutdown',
  async (_Req) => {
    Logger.warn('Received shutdown command via OSC');
    Broadcast.emit('Shutdown');
    return successResult('Shutdown requested');
  },
  'Close the ShowTrak Server'
);

OSC.CreateRoute(
  '/API/Shutdown/Force',
  async (_Req) => {
    Logger.warn('Received force shutdown command via OSC');
    Broadcast.emit('ShutdownForce');
    return successResult('Force shutdown requested');
  },
  'Force close the ShowTrak Server without save/show-mode prompts'
);

// Individual Client Operations
// Clients are addressed by their slug: the encouraged, human-friendly key.
// resolveClientByKey still resolves a raw UUID as a transitional fallback, but
// the route param, docs and titles all lead with the slug.
OSC.CreateRoute(
  '/API/Client/:Slug/WakeOnLAN',
  async (Req) => {
    const Client = await resolveClientByKey(Req.Slug ?? '');
    if (!Client) {
      Broadcast.emit('Notify', `OSC - Invalid Client "${Req.Slug}"`, 'error');
      return failureResult(`Invalid Client "${Req.Slug}"`);
    }
    Broadcast.emit('OSCBulkAction', 'WOL', [Client.UUID], null);
    return successResult(`Wake-on-LAN queued for client "${Client.Slug || Client.UUID}"`);
  },
  'Send a WOL packet to a Client by its slug'
);

OSC.CreateRoute(
  '/API/Client/:Slug/RunScript/:ScriptID',
  async (Req) => {
    const Client = await resolveClientByKey(Req.Slug ?? '');
    if (!Client) {
      Broadcast.emit('Notify', `OSC - Invalid Client "${Req.Slug}"`, 'error');
      return failureResult(`Invalid Client "${Req.Slug}"`);
    }
    const Script = await ScriptManager.Get(Req.ScriptID ?? '');
    if (!Script) {
      Broadcast.emit('Notify', `OSC - Invalid Script ID "${Req.ScriptID}"`, 'error');
      return failureResult(`Invalid Script ID "${Req.ScriptID}"`);
    }
    Broadcast.emit('OSCBulkAction', 'ExecuteScript', [Client.UUID], Req.ScriptID);
    return successResult(
      `Script "${Req.ScriptID}" queued for client "${Client.Slug || Client.UUID}"`
    );
  },
  'Execute a script on a Client by its slug and Script ID'
);

// Dummy Client Operations. A dummy's DummyID IS its slug, so the heartbeat is
// addressed by slug like every other client route.
OSC.CreateRoute(
  '/API/Dummy/:Slug/Heartbeat',
  async (Req, Meta) => {
    const [Err] = await DummyClientManager.Heartbeat(
      Req.Slug ?? '',
      Meta && Meta.IP ? Meta.IP : null
    );
    if (Err) {
      Broadcast.emit('Notify', `OSC - ${Err}`, 'error');
      return failureResult(String(Err));
    }
    return successResult(`Dummy heartbeat accepted for "${Req.Slug}"`);
  },
  'Deliver a heartbeat to a Dummy Client by its slug'
);

// Group Operations. Groups are addressed by their slug: the encouraged key.
// getGroupClients/resolveGroupByKey still accept a numeric GroupID as a
// transitional fallback, but the param, docs and titles lead with the slug.
OSC.CreateRoute(
  '/API/Group/:Slug/WakeOnLAN',
  async (Req) => {
    const [GroupErr, Group, GroupClients] = await getGroupClients(Req.Slug ?? '');
    if (GroupErr) {
      Broadcast.emit('Notify', `OSC - ${GroupErr.detail}`, 'error');
      return GroupErr;
    }

    const UUIDs = GroupClients.map((Client) => Client.UUID);
    Broadcast.emit('OSCBulkAction', 'WOL', UUIDs, null);
    return successResult(
      `Wake-on-LAN queued for ${UUIDs.length} clients in group "${Group.Title}" (${Group.Slug || Group.GroupID})`
    );
  },
  'Send a WOL packet to all offline members of a Group by its slug'
);

OSC.CreateRoute(
  '/API/Group/:Slug/RunScript/:ScriptID',
  async (Req) => {
    const [GroupErr, Group, GroupClients] = await getGroupClients(Req.Slug ?? '');
    if (GroupErr) {
      Broadcast.emit('Notify', `OSC - ${GroupErr.detail}`, 'error');
      return GroupErr;
    }

    const Script = await ScriptManager.Get(Req.ScriptID ?? '');
    if (!Script) {
      Broadcast.emit('Notify', `OSC - Invalid Script ID "${Req.ScriptID}"`, 'error');
      return failureResult(`Invalid Script ID "${Req.ScriptID}"`);
    }

    const UUIDs = GroupClients.map((Client) => Client.UUID);
    Broadcast.emit('OSCBulkAction', 'ExecuteScript', UUIDs, Req.ScriptID);
    return successResult(
      `Script "${Req.ScriptID}" queued for ${UUIDs.length} clients in group "${Group.Title}" (${Group.Slug || Group.GroupID})`
    );
  },
  'Execute a script on all online members of a Group by its slug and Script ID'
);

// Tag routes mirror the Group routes exactly, but membership is the tag's
// dynamic scope rather than a single GroupID (see getTagClients). A tag is
// addressed by its slug (which doubles as its label) or, transitionally, its
// numeric TagID.
OSC.CreateRoute(
  '/API/Tag/:Slug/WakeOnLAN',
  async (Req) => {
    const [TagErr, Tag, TagClients] = await getTagClients(Req.Slug ?? '');
    if (TagErr) {
      Broadcast.emit('Notify', `OSC - ${TagErr.detail}`, 'error');
      return TagErr;
    }

    const UUIDs = TagClients.map((Client) => Client.UUID);
    Broadcast.emit('OSCBulkAction', 'WOL', UUIDs, null);
    return successResult(
      `Wake-on-LAN queued for ${UUIDs.length} clients with tag "${Tag.Slug || Tag.TagID}"`
    );
  },
  'Send a WOL packet to all offline clients carrying a Tag by its slug'
);

OSC.CreateRoute(
  '/API/Tag/:Slug/RunScript/:ScriptID',
  async (Req) => {
    const [TagErr, Tag, TagClients] = await getTagClients(Req.Slug ?? '');
    if (TagErr) {
      Broadcast.emit('Notify', `OSC - ${TagErr.detail}`, 'error');
      return TagErr;
    }

    const Script = await ScriptManager.Get(Req.ScriptID ?? '');
    if (!Script) {
      Broadcast.emit('Notify', `OSC - Invalid Script ID "${Req.ScriptID}"`, 'error');
      return failureResult(`Invalid Script ID "${Req.ScriptID}"`);
    }

    const UUIDs = TagClients.map((Client) => Client.UUID);
    Broadcast.emit('OSCBulkAction', 'ExecuteScript', UUIDs, Req.ScriptID);
    return successResult(
      `Script "${Req.ScriptID}" queued for ${UUIDs.length} clients with tag "${Tag.Slug || Tag.TagID}"`
    );
  },
  'Execute a script on all online clients carrying a Tag by its slug and Script ID'
);

// Bulk All Operations
OSC.CreateRoute(
  '/API/All/WakeOnLAN',
  async (_Req) => {
    const [Err, AllClients] = await ClientManager.GetAll();
    if (Err || !AllClients) {
      Broadcast.emit('Notify', `OSC - Failed to fetch all clients.`, 'error');
      return failureResult('Failed to fetch all clients');
    }
    Broadcast.emit(
      'OSCBulkAction',
      'WOL',
      AllClients.map((Client) => Client.UUID),
      null
    );
    return successResult(`Wake-on-LAN queued for ${AllClients.length} clients`);
  },
  'Send a WOL packet to all offline Clients'
);

OSC.CreateRoute(
  '/API/All/RunScript/:ScriptID',
  async (Req) => {
    const [Err, AllClients] = await ClientManager.GetAll();
    if (Err || !AllClients) {
      Broadcast.emit('Notify', `OSC - Failed to fetch all clients.`, 'error');
      return failureResult('Failed to fetch all clients');
    }
    const Script = await ScriptManager.Get(Req.ScriptID ?? '');
    if (!Script) {
      Broadcast.emit('Notify', `OSC - Invalid Script ID "${Req.ScriptID}"`, 'error');
      return failureResult(`Invalid Script ID "${Req.ScriptID}"`);
    }
    Broadcast.emit(
      'OSCBulkAction',
      'ExecuteScript',
      AllClients.map((Client) => Client.UUID),
      Req.ScriptID
    );
    return successResult(`Script "${Req.ScriptID}" queued for ${AllClients.length} clients`);
  },
  'Execute a script on all online Clients by Script ID'
);

// Integrated Event Operations.
//
// Unlike WOL/RunScript (which the renderer applies from an `OSCBulkAction`
// broadcast), integrated events have no renderer branch, so these delegate to
// ControlService (the same command surface the SDK uses). That reuses its
// integrated-client filtering and dispatches through the shared
// TriggerIntegratedEvent IPC handler, so an event fired over OSC behaves
// identically to one fired from the SDK or the context menu.
//
// ControlService.CommandResult is shape-compatible with RouteResult ({ ok,
// detail }), so its return value is the route result verbatim.
async function runEventCommand(Command: Promise<RouteResult>): Promise<RouteResult> {
  const Result = await Command;
  if (!Result.ok) {
    Broadcast.emit('Notify', `OSC - ${Result.detail}`, 'error');
  }
  return Result;
}

OSC.CreateRoute(
  '/API/Client/:Slug/TriggerEvent/:EventID',
  async (Req) =>
    runEventCommand(ControlService.TriggerEventOnClient(Req.Slug ?? '', Req.EventID ?? '')),
  'Trigger an integrated event on a Client by its slug and Event ID'
);

OSC.CreateRoute(
  '/API/Group/:Slug/TriggerEvent/:EventID',
  async (Req) =>
    runEventCommand(ControlService.TriggerEventOnGroup(Req.Slug ?? '', Req.EventID ?? '')),
  'Trigger an integrated event on all integrated members of a Group by its slug and Event ID'
);

OSC.CreateRoute(
  '/API/Tag/:Slug/TriggerEvent/:EventID',
  async (Req) =>
    runEventCommand(ControlService.TriggerEventOnTag(Req.Slug ?? '', Req.EventID ?? '')),
  'Trigger an integrated event on all integrated clients carrying a Tag by its slug and Event ID'
);

OSC.CreateRoute(
  '/API/All/TriggerEvent/:EventID',
  async (Req) => runEventCommand(ControlService.TriggerEventOnAll(Req.EventID ?? '')),
  'Trigger an integrated event on all integrated Clients by Event ID'
);

// Monitoring Check Actions.
//
// A monitoring check reads a device; an action DOES something to it: power a
// projector on, close its shutter, select an input. The route names the method
// that owns the action, so every check type shares one shape and a new one
// becomes OSC-addressable the moment it declares actions, with no route here:
//
//   /API/Monitor/<target-slug>/<method>/<action>
//   /API/Monitor/<target-slug>/<method>/<action>/<value>
//
// e.g. /API/Monitor/proj-sl/pjlink/power.on
//      /API/Monitor/proj-sl/pjlink/input.set/31
//
// Values can travel two ways, and both keep working:
//
//   - As OSC arguments, in the order the action declares its parameters:
//       /API/Monitor/qsys-main/qsys-core/snapshot.load "Show" 3 2.5
//     This reaches every parameter, carries spaces, and keeps numbers typed.
//   - As a trailing path segment (the original form), which fills the FIRST
//     parameter. Any arguments then fill the parameters after it:
//       /API/Monitor/qsys-main/qsys-core/snapshot.load/Show 3 2.5
//
// An empty-string argument means "use the default", so a sender with fixed
// fields (QLab) can skip an optional value. A trailing 'list' parameter takes
// every remaining argument, and a comma-separated string splits into items.
// Extra arguments are ignored rather than refused, as they were before the
// router read arguments at all.
function isBlank(Value: unknown): boolean {
  return Value === undefined || Value === null || Value === '';
}

function asListValue(Values: unknown[]): unknown[] {
  return Values.flatMap((Value) =>
    typeof Value === 'string'
      ? Value.split(',')
          .map((Part) => Part.trim())
          .filter(Boolean)
      : [Value]
  ).filter((Value) => !isBlank(Value));
}

// Map positional values onto a parameter schema. Returns the params object, or
// an error naming the first required parameter left without a value.
function positionalParams(
  Fields: MonitoringSettingField[],
  Values: unknown[]
): [string, null] | [null, Record<string, unknown>] {
  const Params: Record<string, unknown> = {};
  for (let I = 0; I < Fields.length; I++) {
    const Field = Fields[I]!;
    const IsLastList = Field.Type === 'list' && I === Fields.length - 1;
    if (IsLastList) {
      const Items = asListValue(Values.slice(I));
      if (Items.length) Params[Field.Key] = Items;
    } else if (Field.Type === 'list') {
      if (!isBlank(Values[I])) Params[Field.Key] = asListValue([Values[I]]);
    } else if (!isBlank(Values[I])) {
      Params[Field.Key] = Values[I];
    }
    if (Field.Required && !(Field.Key in Params) && isBlank(Field.Default)) {
      return [`needs a value for ${Field.Label || Field.Key} (value ${I + 1})`, null];
    }
  }
  return [null, Params];
}

async function runMonitorAction(
  Slug: string,
  Method: string,
  ActionID: string,
  Value: string | null,
  Args: OSCArg[] = []
): Promise<RouteResult> {
  const Target =
    typeof MonitoringTargetManager.GetBySlug === 'function'
      ? await MonitoringTargetManager.GetBySlug(Slug)
      : null;
  if (!Target) {
    Broadcast.emit('Notify', `OSC - Invalid Monitor "${Slug}"`, 'error');
    return failureResult(`Invalid Monitor "${Slug}"`);
  }

  const Action = MonitoringMethods.GetAction(Method, ActionID);
  if (!Action) {
    Broadcast.emit('Notify', `OSC - Unknown action "${Method}/${ActionID}"`, 'error');
    return failureResult(`Unknown action "${Method}/${ActionID}"`);
  }

  const Fields = Array.isArray(Action.Params) ? Action.Params : [];
  if (Value != null && !Fields.length) {
    return failureResult(`Action "${Method}/${ActionID}" takes no value`);
  }
  // A no-value action ignores arguments, as it always has.
  const Values: unknown[] = Fields.length ? (Value != null ? [Value, ...Args] : [...Args]) : [];
  const [ParamsErr, Params] = positionalParams(Fields, Values);
  if (ParamsErr !== null) {
    const Detail = `${Action.Label} ${ParamsErr}`;
    Broadcast.emit('Notify', `OSC - ${Detail}`, 'error');
    return failureResult(Detail);
  }
  const Shown = Values.filter((Entry) => !isBlank(Entry));

  const [Err, Summary] = await MonitoringTargetManager.RunAction(
    [Target.TargetID],
    Method,
    ActionID,
    Params
  );
  if (Err || !Summary) {
    Broadcast.emit('Notify', `OSC - ${Err || 'Action failed'}`, 'error');
    return failureResult(Err || 'Action failed');
  }
  if (Summary.Failed > 0) {
    // The projector's own refusal ("warming up", "wrong password") is the only
    // useful thing to report here, so it is surfaced verbatim rather than
    // flattened into a count.
    const Reason = Summary.Results.find((Entry) => !Entry.Success)?.Error || 'Action failed';
    Broadcast.emit('Notify', `OSC - ${Action.Label}: ${Reason}`, 'error');
    return failureResult(`${Action.Label} on "${Target.Slug || Target.TargetID}": ${Reason}`);
  }
  return successResult(
    `${Action.Label} sent to "${Target.Slug || Target.TargetID}"${Shown.length ? ` (${Shown.join(', ')})` : ''}`
  );
}

// The placeholder a value-taking route shows for its trailing segment: the
// range when the parameter declares one, else the parameter's name.
function describeValueParam(Field: MonitoringSettingField): string {
  if (typeof Field.Min === 'number' && typeof Field.Max === 'number') {
    return `<${Field.Min}-${Field.Max}>`;
  }
  return `<${Field.Label || Field.Key}>`;
}

// How the reference describes the values an action takes beyond the path:
// "Values as OSC arguments: <Bank> <Snapshot> [Ramp]".
function describeArgs(Fields: MonitoringSettingField[]): string {
  return Fields.map((Field) => {
    const Name = Field.Label || Field.Key;
    const Shape = Field.Type === 'list' ? `${Name}...` : Name;
    return Field.Required && isBlank(Field.Default) ? `<${Shape}>` : `[${Shape}]`;
  }).join(' ');
}

// Every action every monitoring method declares, split by whether it takes a
// value, so each Monitor route lists exactly the paths it will accept. Methods
// register at import, so the catalogue is complete by the time this runs.
// Value-taking actions also note their full OSC-argument form.
function monitorActionValues(WithValue: boolean): OSCRouteValueList {
  const Methods = typeof MonitoringMethods.GetAll === 'function' ? MonitoringMethods.GetAll() : [];
  const Entries: OSCRouteValue[] = [];
  for (const Method of Methods) {
    for (const Action of Method.Actions || []) {
      const First = Array.isArray(Action.Params) ? Action.Params[0] : undefined;
      // The plain route accepts every action now (values as arguments); the
      // path-value route only those with a parameter to fill.
      if (WithValue && !First) continue;
      const Fields = Array.isArray(Action.Params) ? Action.Params : [];
      const Notes = [
        Fields.length > 1 || (Fields.length === 1 && !WithValue)
          ? `Values as OSC arguments: ${describeArgs(Fields)}.`
          : '',
        Fields.length > 1 && WithValue
          ? `With a path value, arguments fill the rest: ${describeArgs(Fields.slice(1))}.`
          : '',
        Action.Note || '',
      ].filter(Boolean);
      Entries.push({
        Value: `${Method.ID}/${Action.ID}${First && WithValue ? `/${describeValueParam(First)}` : ''}`,
        Label: `${Method.Name} - ${Action.Label}`,
        ...(Notes.length ? { Note: Notes.join(' ') } : {}),
      });
    }
  }
  return { Param: WithValue ? 'Method/ActionID/Value' : 'Method/ActionID', Entries };
}

OSC.CreateRoute(
  '/API/Monitor/:Slug/:Method/:ActionID',
  async (Req, Meta) =>
    runMonitorAction(Req.Slug ?? '', Req.Method ?? '', Req.ActionID ?? '', null, Meta?.Args),
  'Run a check action on a Monitor by its slug, method and action ID',
  monitorActionValues(false)
);

OSC.CreateRoute(
  '/API/Monitor/:Slug/:Method/:ActionID/:Value',
  async (Req, Meta) =>
    runMonitorAction(
      Req.Slug ?? '',
      Req.Method ?? '',
      Req.ActionID ?? '',
      Req.Value ?? '',
      Meta?.Args
    ),
  'Run a check action that takes a value (e.g. pjlink/input.set/31) on a Monitor',
  monitorActionValues(true)
);

// FreeKiosk Terminal Commands.
//
//   /API/FreeKiosk/<terminal-slug>/<command>
//   /API/FreeKiosk/<terminal-slug>/<command>/<value>
//   /API/Group/<group-slug>/FreeKiosk/<command>[/<value>]
//   /API/Tag/<tag-slug>/FreeKiosk/<command>[/<value>]
//   /API/All/FreeKiosk/<command>[/<value>]
//
// e.g. /API/FreeKiosk/lobby-tablet/reboot
//      /API/FreeKiosk/lobby-tablet/brightness/40
//      /API/FreeKiosk/lobby-tablet/brightness 40   (value as an OSC argument)
//      /API/Group/foyer/FreeKiosk/screen.off
//
// The command map in FreeKiosk/commands is the allowlist, and the value runs
// through the same validator as the view modal's FreeKiosk:Command channel, so
// OSC can send exactly what the UI can and nothing more; /api/js stays
// unreachable. As with check actions, the value fills the command's one
// parameter, from the path or the first OSC argument. The Group, Tag
// and All forms send to every FreeKiosk terminal they cover; other client types
// are not touched.
// The terminals a FreeKiosk route addresses, plus how to name them in the
// notification ("lobby-tablet", or "3 FreeKiosk terminals in group ...").
type FreeKioskTargets = [string, null, null] | [null, FreeKioskTerminalView[], string];

// `Where` is the trailing scope (` in group "Foyer" (foyer)`), empty for All.
function describeTerminalSet(Terminals: FreeKioskTerminalView[], Where: string): FreeKioskTargets {
  if (!Terminals.length) return [`No FreeKiosk terminals${Where}`, null, null];
  const Noun = Terminals.length === 1 ? 'FreeKiosk terminal' : 'FreeKiosk terminals';
  return [null, Terminals, `${Terminals.length} ${Noun}${Where}`];
}

async function getFreeKioskTerminalBySlug(Slug: string): Promise<FreeKioskTargets> {
  const Terminal =
    typeof FreeKioskManager.GetBySlug === 'function'
      ? await FreeKioskManager.GetBySlug(Slug)
      : null;
  if (!Terminal) return [`Invalid FreeKiosk Terminal "${Slug}"`, null, null];
  return [null, [Terminal], `"${Terminal.Slug || Terminal.UUID}"`];
}

async function getGroupFreeKioskTerminals(GroupKey: string): Promise<FreeKioskTargets> {
  const Group = await resolveGroupByKey(GroupKey);
  if (!Group) return [`Invalid Group "${GroupKey}"`, null, null];
  const [Err, Terminals] = await FreeKioskManager.GetAll();
  if (Err) return ['Failed to fetch FreeKiosk terminals', null, null];
  const Members = (Terminals || []).filter(
    (Terminal) => Terminal.GroupID != null && Number(Terminal.GroupID) === Number(Group.GroupID)
  );
  return describeTerminalSet(
    Members,
    ` in group "${Group.Title}" (${Group.Slug || Group.GroupID})`
  );
}

// Terminals are tag members by bare UUID or by group, like any other client, so
// the same scope predicate as getTagClients decides membership.
async function getTagFreeKioskTerminals(TagKey: string): Promise<FreeKioskTargets> {
  const Tag = await resolveTagByKey(TagKey);
  if (!Tag) return [`Invalid Tag "${TagKey}"`, null, null];
  const [Err, Terminals] = await FreeKioskManager.GetAll();
  if (Err) return ['Failed to fetch FreeKiosk terminals', null, null];
  const AllTags = await TagManager.GetAllViews();
  const Members = (Terminals || []).filter((Terminal) =>
    ScriptWhitelistManager.IsClientAllowed(Tag.Scope, Terminal, AllTags)
  );
  return describeTerminalSet(Members, ` in tag "${Tag.Slug || Tag.TagID}"`);
}

async function getAllFreeKioskTerminals(): Promise<FreeKioskTargets> {
  const [Err, Terminals] = await FreeKioskManager.GetAll();
  if (Err) return ['Failed to fetch FreeKiosk terminals', null, null];
  return describeTerminalSet(Terminals || [], '');
}

// A command's value can come from the path (`brightness/40`, the original form)
// or, over OSC, from the first argument (`brightness 40`). The path wins when
// both are present. A command that takes no value ignores arguments, as it
// always has.
async function runFreeKioskCommand(
  Targets: Promise<FreeKioskTargets>,
  CommandID: string,
  PathValue: string | null,
  Args: OSCArg[] = []
): Promise<RouteResult> {
  const fail = (Detail: string): RouteResult => {
    Broadcast.emit('Notify', `OSC - ${Detail}`, 'error');
    return failureResult(Detail);
  };

  const [TargetErr, Terminals, Target] = await Targets;
  if (Terminals === null) return fail(TargetErr);

  const Command = GetFreeKioskCommand(CommandID);
  if (!Command) return fail(`Unknown FreeKiosk command "${CommandID}"`);

  const First = Array.isArray(Command.Params) ? Command.Params[0] : undefined;
  if (PathValue != null && !First) return fail(`${Command.Label} takes no value`);
  const ArgValue = First && !isBlank(Args[0]) ? String(Args[0]) : null;
  const Value = PathValue != null ? PathValue : ArgValue;
  if (Value == null && First) {
    return fail(`${Command.Label} needs a value, e.g. ${CommandID}/${describeValueParam(First)}`);
  }

  let Params: Record<string, unknown>;
  try {
    Params = IPCValidation.FreeKioskCommandParams(
      CommandID,
      First && Value != null ? { [First.Key]: Value } : {}
    );
  } catch (Err) {
    return fail(`${Command.Label}: ${DescribeError(Err)}`);
  }

  const UUIDs = Terminals.map((Terminal) => Terminal.UUID);
  const [Err, Summary] = await FreeKioskManager.SendCommand(UUIDs, CommandID, Params);
  if (Err || !Summary) return fail(Err || `${Command.Label} failed`);
  if (Summary.Failed > 0) {
    // The device's own refusal ("needs Device Owner", "remote control is
    // disabled") is the useful part, so it is surfaced verbatim, per terminal
    // when several were addressed, since each may refuse for its own reason.
    const Failures = Summary.Results.filter((Entry) => !Entry.Success);
    const Reasons =
      Terminals.length === 1
        ? Failures[0]?.Error || 'Command failed'
        : Failures.map((Entry) => {
            const Terminal = Terminals.find((Candidate) => Candidate.UUID === Entry.UUID);
            const Name = Terminal ? Terminal.Slug || Terminal.UUID : Entry.UUID;
            return `"${Name}": ${Entry.Error || 'Command failed'}`;
          }).join('; ');
    const Count = Terminals.length === 1 ? '' : ` (${Summary.Failed} failed)`;
    return fail(`${Command.Label} on ${Target}${Count}: ${Reasons}`);
  }
  return successResult(`${Command.Label} sent to ${Target}${Value != null ? ` (${Value})` : ''}`);
}

// The commands each FreeKiosk route accepts, straight from the allowlist.
function freeKioskCommandValues(WithValue: boolean): OSCRouteValueList {
  const Entries: OSCRouteValue[] = [];
  for (const Command of FREEKIOSK_COMMANDS as readonly FreeKioskCommandDef[]) {
    const First = Array.isArray(Command.Params) ? Command.Params[0] : undefined;
    // The plain route accepts every command (a value as an OSC argument); the
    // path-value route only those that take one.
    if (WithValue && !First) continue;
    const Notes = [
      First && !WithValue ? `Value as an OSC argument: ${describeValueParam(First)}.` : '',
      Command.Modes ? `${Command.Modes.map(DisplayModeLabel).join(' / ')} mode only.` : '',
      Command.Note || '',
    ].filter(Boolean);
    Entries.push({
      Value: `${Command.ID}${First && WithValue ? `/${describeValueParam(First)}` : ''}`,
      Label: Command.Label,
      ...(Notes.length ? { Note: Notes.join(' ') } : {}),
    });
  }
  return { Param: WithValue ? 'CommandID/Value' : 'CommandID', Entries };
}

OSC.CreateRoute(
  '/API/FreeKiosk/:Slug/:CommandID',
  async (Req, Meta) =>
    runFreeKioskCommand(
      getFreeKioskTerminalBySlug(Req.Slug ?? ''),
      Req.CommandID ?? '',
      null,
      Meta?.Args
    ),
  'Send a command (e.g. reboot) to a FreeKiosk Terminal by its slug and command ID',
  freeKioskCommandValues(false)
);

OSC.CreateRoute(
  '/API/FreeKiosk/:Slug/:CommandID/:Value',
  async (Req, Meta) =>
    runFreeKioskCommand(
      getFreeKioskTerminalBySlug(Req.Slug ?? ''),
      Req.CommandID ?? '',
      Req.Value ?? '',
      Meta?.Args
    ),
  'Send a command that takes a value (e.g. brightness/40) to a FreeKiosk Terminal',
  freeKioskCommandValues(true)
);

OSC.CreateRoute(
  '/API/Group/:Slug/FreeKiosk/:CommandID',
  async (Req, Meta) =>
    runFreeKioskCommand(
      getGroupFreeKioskTerminals(Req.Slug ?? ''),
      Req.CommandID ?? '',
      null,
      Meta?.Args
    ),
  'Send a command (e.g. reboot) to every FreeKiosk Terminal in a Group by its slug',
  freeKioskCommandValues(false)
);

OSC.CreateRoute(
  '/API/Group/:Slug/FreeKiosk/:CommandID/:Value',
  async (Req, Meta) =>
    runFreeKioskCommand(
      getGroupFreeKioskTerminals(Req.Slug ?? ''),
      Req.CommandID ?? '',
      Req.Value ?? '',
      Meta?.Args
    ),
  'Send a command that takes a value (e.g. brightness/40) to every FreeKiosk Terminal in a Group',
  freeKioskCommandValues(true)
);

OSC.CreateRoute(
  '/API/Tag/:Slug/FreeKiosk/:CommandID',
  async (Req, Meta) =>
    runFreeKioskCommand(
      getTagFreeKioskTerminals(Req.Slug ?? ''),
      Req.CommandID ?? '',
      null,
      Meta?.Args
    ),
  'Send a command (e.g. reboot) to every FreeKiosk Terminal carrying a Tag by its slug',
  freeKioskCommandValues(false)
);

OSC.CreateRoute(
  '/API/Tag/:Slug/FreeKiosk/:CommandID/:Value',
  async (Req, Meta) =>
    runFreeKioskCommand(
      getTagFreeKioskTerminals(Req.Slug ?? ''),
      Req.CommandID ?? '',
      Req.Value ?? '',
      Meta?.Args
    ),
  'Send a command that takes a value (e.g. brightness/40) to every FreeKiosk Terminal carrying a Tag',
  freeKioskCommandValues(true)
);

OSC.CreateRoute(
  '/API/All/FreeKiosk/:CommandID',
  async (Req, Meta) =>
    runFreeKioskCommand(getAllFreeKioskTerminals(), Req.CommandID ?? '', null, Meta?.Args),
  'Send a command (e.g. reboot) to every FreeKiosk Terminal',
  freeKioskCommandValues(false)
);

OSC.CreateRoute(
  '/API/All/FreeKiosk/:CommandID/:Value',
  async (Req, Meta) =>
    runFreeKioskCommand(
      getAllFreeKioskTerminals(),
      Req.CommandID ?? '',
      Req.Value ?? '',
      Meta?.Args
    ),
  'Send a command that takes a value (e.g. brightness/40) to every FreeKiosk Terminal',
  freeKioskCommandValues(true)
);

// Bind the listener on load using the compiled-in default port so OSC control
// works immediately. main/live-settings applies the configured port (and any
// later change) via OSC.RestartServer, keeping this module free of settings/DB.
StartOSCServer(OSC_PORT);

export { OSC };
