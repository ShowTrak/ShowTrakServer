import { CreateLogger } from '../Logger';
import type { ClientManagerType } from '../ClientManager';
import { OSC_PORT } from '../Config/constants';
import { Manager as Broadcast } from '../Broadcast';
import { Manager as ScriptManager } from '../ScriptManager';
import { Manager as DummyClientManager } from '../DummyClientManager';
import { Manager as GroupManager } from '../GroupManager';
import { Manager as TagManager } from '../TagManager';
import { Manager as ScriptWhitelistManager } from '../ScriptWhitelistManager';
import { ControlService } from '../ControlService';
import { IsTransientNetworkError, DescribeError } from '@showtrak/protocol/runtime';

const Logger = CreateLogger('OSC');

const { Server } = require('node-osc');

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

// Not-yet-migrated JS manager — typed loosely until its own migration.
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
    // datagram would crash the app — absorb them here as a warning instead.
    //
    // Since node-osc 11 the Server also re-emits socket errors, without the
    // remote-info argument that every decode failure carries. Those are already
    // covered by the `_sock` listener above, so only the rinfo-bearing case is a
    // bad packet — anything else falls through to the socket handling (which the
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
// errors (interface loss) are logged and ignored — a bound 0.0.0.0 listener
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

// Source metadata for an inbound OSC packet (currently just the sender IP).
interface OSCMeta {
  IP: string | null;
}

// Minimal shape of the UDP remote-info object node-osc passes to the handler.
interface OSCRemoteInfo {
  address?: string;
  family?: string;
  port?: number;
  size?: number;
}

// Debug-traffic payload emitted for the WebUI traffic inspector.
interface OSCDebugPayload {
  valid: boolean;
  summary: string;
  detail: string;
  source?: string | null;
}

type OSCRouteCallback = (Req: OSCRequest, Meta?: OSCMeta) => RouteResult | Promise<RouteResult>;

// Entity types reused from the (not-yet-migrated) managers via their typed public APIs.
type OSCGroup = NonNullable<Awaited<ReturnType<typeof GroupManager.Get>>[1]>;
type OSCClient = NonNullable<Awaited<ReturnType<ClientManagerType['GetAll']>>[1]>[number];
type OSCTag = NonNullable<Awaited<ReturnType<typeof TagManager.GetBySlug>>>;

interface OSCRoute {
  Title: string;
  Path: string;
  Callback: OSCRouteCallback;
}

const Routes: OSCRoute[] = [];

function emitDebugEntry(payload: OSCDebugPayload) {
  Broadcast.emit('DebugTrafficEntry', {
    protocol: 'osc',
    timestamp: Date.now(),
    ...payload,
  });
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
// so a client belongs when it matches that scope — reusing the same predicate
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
  const ValidRoutes: OSCRoute[] = [];

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

    // Source address of the UDP packet (used by routes that record sender IPs).
    const Meta = { IP: Info && Info.address ? Info.address : null };

    const RequestComplete = await ValidRoute.Callback(Req, Meta);
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
  GetRoutes(): OSCRoute[] {
    return Routes;
  },

  CreateRoute(Path: string, Callback: OSCRouteCallback, Title = 'Default OSC Route'): void {
    Routes.push({
      Title,
      Path,
      Callback,
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
// Clients are addressed by their slug — the encouraged, human-friendly key.
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

// Group Operations. Groups are addressed by their slug — the encouraged key.
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
// Unlike WOL/RunScript — which the renderer applies from an `OSCBulkAction`
// broadcast — integrated events have no renderer branch, so these delegate to
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

// Bind the listener on load using the compiled-in default port so OSC control
// works immediately. main/live-settings applies the configured port (and any
// later change) via OSC.RestartServer — keeping this module free of settings/DB.
StartOSCServer(OSC_PORT);

export { OSC };
