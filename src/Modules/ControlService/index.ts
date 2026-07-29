// ControlService — transport-agnostic command surface for external integrations.
//
// The WebSocket control API (`/sdk` namespace) dispatches every command through
// this module. Commands are addressed by SLUG (clients/groups/tags/scripts), the
// encouraged human-friendly key; a raw UUID/ID still resolves as a transitional
// fallback via the managers' Get methods.
//
// Dispatch strategy mirrors the split the OSC module and Web UI already use:
//   - Open-modal / view are renderer concerns → emitted as an `OSCBulkAction`
//     broadcast the renderer applies (fire-and-forget).
//   - Real server actions (WOL, scripts, integrated events, save) go through the
//     SAME shared IPC handlers the desktop uses (via the handler registry), so
//     validation, whitelist gating and execution feedback are reused verbatim.
//   - Mode / alert-actions are authoritative server state → set on their managers.

import { CreateLogger } from '../Logger';
import { Manager as Broadcast } from '../Broadcast';
import { Manager as ClientManager } from '../ClientManager';
import { Manager as GroupManager } from '../GroupManager';
import { Manager as TagManager } from '../TagManager';
import { Manager as ScriptManager } from '../ScriptManager';
import { Manager as ScriptWhitelistManager } from '../ScriptWhitelistManager';
import { Manager as ModeManager } from '../ModeManager';
import { Manager as AlertsManager } from '../AlertsManager';
import { Manager as MonitoringTargetManager } from '../MonitoringTargetManager';
import { Manager as DummyClientManager } from '../DummyClientManager';
import { GetHandler } from '../../main/handler-registry';

const Logger = CreateLogger('ControlService');

export interface CommandResult {
  ok: boolean;
  detail: string;
}

interface ResolvedClient {
  UUID: string;
  Slug?: string | null;
  OperatingSystem?: string | null;
  Integrated?: unknown;
  GroupID?: number | null;
}

const ok = (detail = ''): CommandResult => ({ ok: true, detail: String(detail || '') });
const fail = (detail: unknown): CommandResult => ({
  ok: false,
  detail: String(detail || 'Request failed'),
});

// --- Resolution (slug-first, UUID/ID fallback) ---------------------------

async function resolveClientByKey(Key: string): Promise<ResolvedClient | null> {
  if (!Key) return null;
  const [Err, Client] = await ClientManager.Get(Key);
  if (!Err && Client) return Client as ResolvedClient;
  if (typeof ClientManager.GetBySlug === 'function') {
    return (await ClientManager.GetBySlug(Key)) as ResolvedClient | null;
  }
  return null;
}

async function getAllClients(): Promise<ResolvedClient[]> {
  const [Err, Clients] = await ClientManager.GetAll();
  if (Err || !Clients) return [];
  return Clients as ResolvedClient[];
}

async function resolveGroupClients(
  Key: string
): Promise<[CommandResult, null] | [null, ResolvedClient[]]> {
  const Trimmed = String(Key ?? '').trim();
  let Group = null;
  if (/^\d+$/.test(Trimmed)) {
    const [GroupErr, ByID] = await GroupManager.Get(Number(Trimmed));
    if (!GroupErr && ByID) Group = ByID;
  }
  if (!Group && typeof GroupManager.GetBySlug === 'function') {
    Group = await GroupManager.GetBySlug(Trimmed);
  }
  if (!Group) return [fail(`Invalid Group "${Key}"`), null];
  const Clients = await getAllClients();
  return [null, Clients.filter((c) => Number(c.GroupID) === Number(Group.GroupID))];
}

async function resolveTagClients(
  Key: string
): Promise<[CommandResult, null] | [null, ResolvedClient[]]> {
  const Trimmed = String(Key ?? '').trim();
  let Tag = null;
  if (/^\d+$/.test(Trimmed)) {
    const [TagErr, ByID] = await TagManager.Get(Number(Trimmed));
    if (!TagErr && ByID) Tag = ByID;
  }
  if (!Tag && typeof TagManager.GetBySlug === 'function') {
    Tag = await TagManager.GetBySlug(Trimmed);
  }
  if (!Tag) return [fail(`Invalid Tag "${Key}"`), null];
  const Clients = await getAllClients();
  // The full tag list expands any tags this one absorbs (tags can nest).
  const AllTags = await TagManager.GetAllViews();
  return [
    null,
    Clients.filter((c) => ScriptWhitelistManager.IsClientAllowed(Tag.Scope, c, AllTags)),
  ];
}

function isIntegrated(client: ResolvedClient): boolean {
  if (client.Integrated === true) return true;
  return (
    String(client.OperatingSystem || '')
      .trim()
      .toLowerCase() === 'integrated'
  );
}

// --- Dispatch helpers ----------------------------------------------------

// Call a shared IPC handler by channel; treat a tuple [Err, _] with a truthy
// Err as failure. Returns a CommandResult.
async function dispatchHandler(
  channel: string,
  args: unknown[],
  detail: string
): Promise<CommandResult> {
  const Handler = GetHandler(channel);
  if (typeof Handler !== 'function') return fail(`Handler "${channel}" unavailable`);
  const Result = await Handler(null, ...args);
  if (Array.isArray(Result) && Result[0]) return fail(Result[0]);
  return ok(detail);
}

function emitBulk(type: string, uuids: string[], arg: unknown = null): void {
  Broadcast.emit('OSCBulkAction', type, uuids, arg);
}

// --- Public command surface ---------------------------------------------

export const ControlService = {
  // Wake-on-LAN (server-side via the shared WakeOnLan handler) -------------
  async WakeAll(): Promise<CommandResult> {
    const uuids = (await getAllClients()).map((c) => c.UUID);
    return dispatchHandler('WakeOnLan', [uuids], `Wake-on-LAN queued for ${uuids.length} clients`);
  },
  async WakeClient(slug: string): Promise<CommandResult> {
    const c = await resolveClientByKey(slug);
    if (!c) return fail(`Invalid Client "${slug}"`);
    return dispatchHandler('WakeOnLan', [[c.UUID]], `Wake-on-LAN queued for "${c.Slug || c.UUID}"`);
  },
  async WakeGroup(slug: string): Promise<CommandResult> {
    const [err, clients] = await resolveGroupClients(slug);
    if (err) return err;
    const uuids = clients.map((c) => c.UUID);
    return dispatchHandler('WakeOnLan', [uuids], `Wake-on-LAN queued for group "${slug}"`);
  },
  async WakeTag(slug: string): Promise<CommandResult> {
    const [err, clients] = await resolveTagClients(slug);
    if (err) return err;
    const uuids = clients.map((c) => c.UUID);
    return dispatchHandler('WakeOnLan', [uuids], `Wake-on-LAN queued for tag "${slug}"`);
  },

  // Scripts (by script slug = folder ID) ----------------------------------
  async RunScriptOnAll(scriptSlug: string): Promise<CommandResult> {
    if (!(await ScriptManager.Get(scriptSlug))) return fail(`Invalid Script "${scriptSlug}"`);
    const uuids = (await getAllClients()).map((c) => c.UUID);
    return dispatchHandler(
      'ExecuteScript',
      [scriptSlug, uuids, false],
      `Script "${scriptSlug}" queued for ${uuids.length} clients`
    );
  },
  async RunScriptOnClient(slug: string, scriptSlug: string): Promise<CommandResult> {
    const c = await resolveClientByKey(slug);
    if (!c) return fail(`Invalid Client "${slug}"`);
    if (!(await ScriptManager.Get(scriptSlug))) return fail(`Invalid Script "${scriptSlug}"`);
    return dispatchHandler(
      'ExecuteScript',
      [scriptSlug, [c.UUID], false],
      `Script "${scriptSlug}" queued for "${c.Slug || c.UUID}"`
    );
  },
  async RunScriptOnGroup(slug: string, scriptSlug: string): Promise<CommandResult> {
    const [err, clients] = await resolveGroupClients(slug);
    if (err) return err;
    if (!(await ScriptManager.Get(scriptSlug))) return fail(`Invalid Script "${scriptSlug}"`);
    return dispatchHandler(
      'ExecuteScript',
      [scriptSlug, clients.map((c) => c.UUID), false],
      `Script "${scriptSlug}" queued for group "${slug}"`
    );
  },
  async RunScriptOnTag(slug: string, scriptSlug: string): Promise<CommandResult> {
    const [err, clients] = await resolveTagClients(slug);
    if (err) return err;
    if (!(await ScriptManager.Get(scriptSlug))) return fail(`Invalid Script "${scriptSlug}"`);
    return dispatchHandler(
      'ExecuteScript',
      [scriptSlug, clients.map((c) => c.UUID), false],
      `Script "${scriptSlug}" queued for tag "${slug}"`
    );
  },

  // Integrated events (integrated clients only) ---------------------------
  async TriggerEventOnAll(eventSlug: string): Promise<CommandResult> {
    const uuids = (await getAllClients()).filter(isIntegrated).map((c) => c.UUID);
    if (uuids.length === 0) return fail('No integrated clients');
    return dispatchHandler(
      'TriggerIntegratedEvent',
      [eventSlug, uuids],
      `Event "${eventSlug}" queued for ${uuids.length} integrated clients`
    );
  },
  async TriggerEventOnClient(slug: string, eventSlug: string): Promise<CommandResult> {
    const c = await resolveClientByKey(slug);
    if (!c) return fail(`Invalid Client "${slug}"`);
    if (!isIntegrated(c)) return fail(`Client "${slug}" is not an integrated client`);
    return dispatchHandler(
      'TriggerIntegratedEvent',
      [eventSlug, [c.UUID]],
      `Event "${eventSlug}" queued for "${c.Slug || c.UUID}"`
    );
  },
  async TriggerEventOnGroup(slug: string, eventSlug: string): Promise<CommandResult> {
    const [err, clients] = await resolveGroupClients(slug);
    if (err) return err;
    const uuids = clients.filter(isIntegrated).map((c) => c.UUID);
    if (uuids.length === 0) return fail(`No integrated clients in group "${slug}"`);
    return dispatchHandler(
      'TriggerIntegratedEvent',
      [eventSlug, uuids],
      `Event "${eventSlug}" queued for group "${slug}"`
    );
  },
  async TriggerEventOnTag(slug: string, eventSlug: string): Promise<CommandResult> {
    const [err, clients] = await resolveTagClients(slug);
    if (err) return err;
    const uuids = clients.filter(isIntegrated).map((c) => c.UUID);
    if (uuids.length === 0) return fail(`No integrated clients with tag "${slug}"`);
    return dispatchHandler(
      'TriggerIntegratedEvent',
      [eventSlug, uuids],
      `Event "${eventSlug}" queued for tag "${slug}"`
    );
  },

  // Alerts (authoritative server state) -----------------------------------
  async SetAlertsEnabled(enabled: boolean): Promise<CommandResult> {
    const State = AlertsManager.SetActionsEnabled(!!enabled);
    return ok(`Alert actions ${State ? 'enabled' : 'disabled'}`);
  },
  async ToggleAlerts(): Promise<CommandResult> {
    const State = AlertsManager.SetActionsEnabled(!AlertsManager.GetActionsEnabled());
    return ok(`Alert actions ${State ? 'enabled' : 'disabled'}`);
  },

  // Show / Edit mode (authoritative server state) -------------------------
  async SetMode(mode: string): Promise<CommandResult> {
    const Next = String(mode).toUpperCase() === 'EDIT' ? 'EDIT' : 'SHOW';
    ModeManager.Set(Next);
    return ok(`Mode set to ${Next}`);
  },
  async ToggleMode(): Promise<CommandResult> {
    const Next = ModeManager.Get() === 'EDIT' ? 'SHOW' : 'EDIT';
    ModeManager.Set(Next);
    return ok(`Mode set to ${Next}`);
  },

  // Open the entity view modal (desktop renderer only) --------------------
  // Slugs share one namespace across clients, monitoring targets and dummies, so
  // resolve across all three and tag the bulk action with the entity type; the
  // renderer routes each to its matching view (client info / monitor history /
  // dummy history). Integrated clients (QLab, etc.) have no host details, so the
  // client info window still refuses to open for them.
  //
  // Modal actions are addressed at the operator's own desktop window: the web
  // namespace drops them (WEB_SUPPRESSED_BULK_ACTIONS) so a Companion press does
  // not throw a modal up on every logged-in browser as well.
  async OpenClientModal(slug: string): Promise<CommandResult> {
    const c = await resolveClientByKey(slug);
    if (c) {
      if (isIntegrated(c)) return fail(`"${c.Slug || c.UUID}" is not a ShowTrak client`);
      emitBulk('OpenClientModal', [c.UUID], 'client');
      return ok(`Opened modal for "${c.Slug || c.UUID}"`);
    }

    const monitor =
      typeof MonitoringTargetManager.GetBySlug === 'function'
        ? await MonitoringTargetManager.GetBySlug(slug)
        : null;
    if (monitor) {
      emitBulk('OpenClientModal', [String(monitor.TargetID)], 'monitor');
      return ok(`Opened monitor modal for "${monitor.Slug || monitor.TargetID}"`);
    }

    const dummy =
      typeof DummyClientManager.GetBySlug === 'function'
        ? await DummyClientManager.GetBySlug(slug)
        : null;
    if (dummy) {
      emitBulk('OpenClientModal', [dummy.UUID], 'dummy');
      return ok(`Opened dummy modal for "${dummy.DummyID || dummy.UUID}"`);
    }

    return fail(`Invalid Client "${slug}"`);
  },

  // Dismiss every open modal on the desktop renderer. No targets — the renderer
  // closes whatever it currently has open.
  async CloseModals(): Promise<CommandResult> {
    emitBulk('CloseModals', []);
    return ok('Closed all modals');
  },

  // Save the current show file --------------------------------------------
  async SaveShow(): Promise<CommandResult> {
    const Handler = GetHandler('Show:Save');
    if (typeof Handler !== 'function') return fail('Save handler unavailable');
    try {
      const Result = await Handler(null);
      if (Array.isArray(Result) && Result[0]) return fail(Result[0]);
      // The desktop's own Save button shows this toast from the renderer wrapper;
      // the SDK calls the handler directly, so surface the same notification here.
      Broadcast.emit('Notify', 'Saved ShowTrak file.', 'success');
      return ok('Show saved (a Save-As dialog may appear if no file is set)');
    } catch (e) {
      Logger.error('SaveShow failed', e);
      return fail('Save failed');
    }
  },

  // Shutdown ---------------------------------------------------------------
  // Mirrors the OSC /API/Shutdown routes: the same Broadcast events the desktop
  // menu raises, so save prompts and show-mode guards behave identically. The
  // graceful variant may be blocked by those prompts; Force skips them.
  async Shutdown(): Promise<CommandResult> {
    Logger.warn('Received shutdown command via SDK');
    Broadcast.emit('Shutdown');
    return ok('Shutdown requested');
  },
  async ShutdownForce(): Promise<CommandResult> {
    Logger.warn('Received force shutdown command via SDK');
    Broadcast.emit('ShutdownForce');
    return ok('Force shutdown requested');
  },
};

export type ControlServiceType = typeof ControlService;
