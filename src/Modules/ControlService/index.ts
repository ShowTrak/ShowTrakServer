// ControlService: transport-agnostic command surface for external integrations.
//
// The WebSocket control API (`/sdk` namespace) dispatches every command through
// this module. Commands are addressed by SLUG (clients/groups/tags/scripts), the
// encouraged human-friendly key; a raw UUID/ID still resolves as a transitional
// fallback via the managers' Get methods.
//
// Dispatch strategy mirrors the split the OSC module and Web UI already use:
//   - Monitor check actions, FreeKiosk commands and dummy heartbeats go to their
//     managers, mirroring the OSC routes that offer the same show-time verbs.
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
import { Manager as IdentifyManager } from '../IdentifyManager';
import { Manager as MonitoringTargetManager } from '../MonitoringTargetManager';
import { Manager as DummyClientManager } from '../DummyClientManager';
import { Manager as FreeKioskManager } from '../FreeKioskManager';
import { Manager as MonitoringMethods } from '../MonitoringMethods';
import { Manager as IPCValidation } from '../IPCValidation';
import { Manager as ScriptExecutionManager } from '../ScriptExecutionManager';
import { GetRetryTarget } from '../ScriptExecutionManager/retry';
import { GetFreeKioskCommand } from '../FreeKiosk/commands';
import { DescribeError } from '@showtrak/protocol/runtime';
import { GetHandler } from '../../main/handler-registry';
import type {
  AssertTrue,
  ChannelListCheck,
  FreeKioskTerminalView,
  OSCBulkActionType,
  SdkCommandResult,
  SdkViewMode,
} from '@showtrak/protocol';

const Logger = CreateLogger('ControlService');

// Every command answers with the protocol's SdkCommandResult: `/sdk` acks it as
// it is, and the OSC routes that delegate here return it as their route result.

interface ResolvedClient {
  UUID: string;
  Slug?: string | null;
  OperatingSystem?: string | null;
  Integrated?: unknown;
  GroupID?: number | null;
}

const ok = (detail = ''): SdkCommandResult => ({ ok: true, detail: String(detail || '') });
const fail = (detail: unknown): SdkCommandResult => ({
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

// A group by slug, or by numeric GroupID as the transitional fallback.
async function resolveGroup(Key: string) {
  const Trimmed = String(Key ?? '').trim();
  let Group = null;
  if (/^\d+$/.test(Trimmed)) {
    const [GroupErr, ByID] = await GroupManager.Get(Number(Trimmed));
    if (!GroupErr && ByID) Group = ByID;
  }
  if (!Group && typeof GroupManager.GetBySlug === 'function') {
    Group = await GroupManager.GetBySlug(Trimmed);
  }
  return Group || null;
}

// A tag by slug, or by numeric TagID as the transitional fallback.
async function resolveTag(Key: string) {
  const Trimmed = String(Key ?? '').trim();
  let Tag = null;
  if (/^\d+$/.test(Trimmed)) {
    const [TagErr, ByID] = await TagManager.Get(Number(Trimmed));
    if (!TagErr && ByID) Tag = ByID;
  }
  if (!Tag && typeof TagManager.GetBySlug === 'function') {
    Tag = await TagManager.GetBySlug(Trimmed);
  }
  return Tag || null;
}

async function resolveGroupClients(
  Key: string
): Promise<[SdkCommandResult, null] | [null, ResolvedClient[]]> {
  const Group = await resolveGroup(Key);
  if (!Group) return [fail(`Invalid Group "${Key}"`), null];
  const Clients = await getAllClients();
  return [null, Clients.filter((c) => Number(c.GroupID) === Number(Group.GroupID))];
}

async function resolveTagClients(
  Key: string
): Promise<[SdkCommandResult, null] | [null, ResolvedClient[]]> {
  const Tag = await resolveTag(Key);
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
// Err as failure. Returns a SdkCommandResult.
async function dispatchHandler(
  channel: string,
  args: unknown[],
  detail: string
): Promise<SdkCommandResult> {
  const Handler = GetHandler(channel);
  if (typeof Handler !== 'function') return fail(`Handler "${channel}" unavailable`);
  const Result = await Handler(null, ...args);
  if (Array.isArray(Result) && Result[0]) return fail(Result[0]);
  return ok(detail);
}

function emitBulk(type: OSCBulkActionType, uuids: string[], arg: unknown = null): void {
  Broadcast.emit('OSCBulkAction', type, uuids, arg);
}

// The desktop's three client-list layouts (src/UI/js/app/lib/list-view.ts):
// exactly the protocol's SdkViewMode, which view.set names.
const VIEW_MODES = ['grid', 'compact', 'list'] as const;
type _ViewModesMatch = AssertTrue<ChannelListCheck<SdkViewMode, typeof VIEW_MODES>>;

function parseViewMode(Value: unknown): SdkViewMode | null {
  const Text = typeof Value === 'string' ? Value.trim().toLowerCase() : '';
  return (VIEW_MODES as readonly string[]).includes(Text) ? (Text as SdkViewMode) : null;
}

// A command's optional single value. Integrations fill it from a text field, so
// a blank field means "no value", the same as leaving it out.
function optionalValue(Value: unknown): string | null {
  if (Value == null) return null;
  const Text = String(Value).trim();
  return Text === '' ? null : Text;
}

// --- FreeKiosk terminal targets ------------------------------------------
// Mirrors the OSC FreeKiosk routes (src/Modules/OSC), which address terminals
// the same four ways. Terminals are client-shaped, so a group or tag covers
// them by GroupID or scope exactly as it covers clients; other client types in
// the same group or tag are never touched.

/** The terminals a command addresses and how to name them, or why there are none. */
type KioskTargets = [string, null, null] | [null, FreeKioskTerminalView[], string];

function describeTerminals(Terminals: FreeKioskTerminalView[], Where: string): KioskTargets {
  if (!Terminals.length) return [`No FreeKiosk terminals${Where}`, null, null];
  const Noun = Terminals.length === 1 ? 'FreeKiosk terminal' : 'FreeKiosk terminals';
  return [null, Terminals, `${Terminals.length} ${Noun}${Where}`];
}

async function allTerminals(): Promise<FreeKioskTerminalView[] | null> {
  const [Err, Terminals] = await FreeKioskManager.GetAll();
  return Err ? null : Terminals || [];
}

async function resolveKioskTargets(
  Scope: 'terminal' | 'group' | 'tag' | 'all',
  Key: string
): Promise<KioskTargets> {
  if (Scope === 'terminal') {
    const Terminal =
      typeof FreeKioskManager.GetBySlug === 'function'
        ? await FreeKioskManager.GetBySlug(Key)
        : null;
    if (!Terminal) return [`Invalid FreeKiosk Terminal "${Key}"`, null, null];
    return [null, [Terminal], `"${Terminal.Slug || Terminal.UUID}"`];
  }
  if (Scope === 'group') {
    const Group = await resolveGroup(Key);
    if (!Group) return [`Invalid Group "${Key}"`, null, null];
    const Terminals = await allTerminals();
    if (!Terminals) return ['Failed to fetch FreeKiosk terminals', null, null];
    return describeTerminals(
      Terminals.filter((T) => T.GroupID != null && Number(T.GroupID) === Number(Group.GroupID)),
      ` in group "${Group.Slug || Group.GroupID}"`
    );
  }
  if (Scope === 'tag') {
    const Tag = await resolveTag(Key);
    if (!Tag) return [`Invalid Tag "${Key}"`, null, null];
    const Terminals = await allTerminals();
    if (!Terminals) return ['Failed to fetch FreeKiosk terminals', null, null];
    const AllTags = await TagManager.GetAllViews();
    return describeTerminals(
      Terminals.filter((T) => ScriptWhitelistManager.IsClientAllowed(Tag.Scope, T, AllTags)),
      ` in tag "${Tag.Slug || Tag.TagID}"`
    );
  }
  const Terminals = await allTerminals();
  if (!Terminals) return ['Failed to fetch FreeKiosk terminals', null, null];
  return describeTerminals(Terminals, '');
}

async function sendKioskCommand(
  Targets: Promise<KioskTargets>,
  CommandID: string,
  RawValue: unknown
): Promise<SdkCommandResult> {
  const [TargetErr, Terminals, Target] = await Targets;
  if (Terminals === null) return fail(TargetErr);

  // The command map is the allowlist, so an integration can send exactly what
  // the view modal and OSC can, and never a raw device endpoint.
  const Command = GetFreeKioskCommand(CommandID);
  if (!Command) return fail(`Unknown FreeKiosk command "${CommandID}"`);

  const Value = optionalValue(RawValue);
  const First = Array.isArray(Command.Params) ? Command.Params[0] : undefined;
  if (Value != null && !First) return fail(`${Command.Label} takes no value`);
  if (Value == null && First) return fail(`${Command.Label} needs a value`);

  let Params: Record<string, unknown>;
  try {
    Params = IPCValidation.FreeKioskCommandParams(
      CommandID,
      First && Value != null ? { [First.Key]: Value } : {}
    );
  } catch (Err) {
    return fail(`${Command.Label}: ${DescribeError(Err)}`);
  }

  const [Err, Summary] = await FreeKioskManager.SendCommand(
    Terminals.map((T) => T.UUID),
    CommandID,
    Params
  );
  if (Err || !Summary) return fail(Err || `${Command.Label} failed`);
  if (Summary.Failed > 0) {
    // The device's own refusal ("needs Device Owner") is the useful part.
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
  return ok(`${Command.Label} sent to ${Target}${Value != null ? ` (${Value})` : ''}`);
}

// --- Public command surface ---------------------------------------------

export const ControlService = {
  // Wake-on-LAN (server-side via the shared WakeOnLan handler) -------------
  async WakeAll(): Promise<SdkCommandResult> {
    const uuids = (await getAllClients()).map((c) => c.UUID);
    return dispatchHandler('WakeOnLan', [uuids], `Wake-on-LAN queued for ${uuids.length} clients`);
  },
  async WakeClient(slug: string): Promise<SdkCommandResult> {
    const c = await resolveClientByKey(slug);
    if (!c) return fail(`Invalid Client "${slug}"`);
    return dispatchHandler('WakeOnLan', [[c.UUID]], `Wake-on-LAN queued for "${c.Slug || c.UUID}"`);
  },
  async WakeGroup(slug: string): Promise<SdkCommandResult> {
    const [err, clients] = await resolveGroupClients(slug);
    if (err) return err;
    const uuids = clients.map((c) => c.UUID);
    return dispatchHandler('WakeOnLan', [uuids], `Wake-on-LAN queued for group "${slug}"`);
  },
  async WakeTag(slug: string): Promise<SdkCommandResult> {
    const [err, clients] = await resolveTagClients(slug);
    if (err) return err;
    const uuids = clients.map((c) => c.UUID);
    return dispatchHandler('WakeOnLan', [uuids], `Wake-on-LAN queued for tag "${slug}"`);
  },

  // Scripts (by script slug = folder ID) ----------------------------------
  async RunScriptOnAll(scriptSlug: string): Promise<SdkCommandResult> {
    if (!(await ScriptManager.Get(scriptSlug))) return fail(`Invalid Script "${scriptSlug}"`);
    const uuids = (await getAllClients()).map((c) => c.UUID);
    return dispatchHandler(
      'ExecuteScript',
      [scriptSlug, uuids, false],
      `Script "${scriptSlug}" queued for ${uuids.length} clients`
    );
  },
  async RunScriptOnClient(slug: string, scriptSlug: string): Promise<SdkCommandResult> {
    const c = await resolveClientByKey(slug);
    if (!c) return fail(`Invalid Client "${slug}"`);
    if (!(await ScriptManager.Get(scriptSlug))) return fail(`Invalid Script "${scriptSlug}"`);
    return dispatchHandler(
      'ExecuteScript',
      [scriptSlug, [c.UUID], false],
      `Script "${scriptSlug}" queued for "${c.Slug || c.UUID}"`
    );
  },
  async RunScriptOnGroup(slug: string, scriptSlug: string): Promise<SdkCommandResult> {
    const [err, clients] = await resolveGroupClients(slug);
    if (err) return err;
    if (!(await ScriptManager.Get(scriptSlug))) return fail(`Invalid Script "${scriptSlug}"`);
    return dispatchHandler(
      'ExecuteScript',
      [scriptSlug, clients.map((c) => c.UUID), false],
      `Script "${scriptSlug}" queued for group "${slug}"`
    );
  },
  async RunScriptOnTag(slug: string, scriptSlug: string): Promise<SdkCommandResult> {
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
  async TriggerEventOnAll(eventSlug: string): Promise<SdkCommandResult> {
    const uuids = (await getAllClients()).filter(isIntegrated).map((c) => c.UUID);
    if (uuids.length === 0) return fail('No integrated clients');
    return dispatchHandler(
      'TriggerIntegratedEvent',
      [eventSlug, uuids],
      `Event "${eventSlug}" queued for ${uuids.length} integrated clients`
    );
  },
  async TriggerEventOnClient(slug: string, eventSlug: string): Promise<SdkCommandResult> {
    const c = await resolveClientByKey(slug);
    if (!c) return fail(`Invalid Client "${slug}"`);
    if (!isIntegrated(c)) return fail(`Client "${slug}" is not an integrated client`);
    return dispatchHandler(
      'TriggerIntegratedEvent',
      [eventSlug, [c.UUID]],
      `Event "${eventSlug}" queued for "${c.Slug || c.UUID}"`
    );
  },
  async TriggerEventOnGroup(slug: string, eventSlug: string): Promise<SdkCommandResult> {
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
  async TriggerEventOnTag(slug: string, eventSlug: string): Promise<SdkCommandResult> {
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
  async SetAlertsEnabled(enabled: boolean): Promise<SdkCommandResult> {
    const State = AlertsManager.SetActionsEnabled(!!enabled);
    return ok(`Alert actions ${State ? 'enabled' : 'disabled'}`);
  },
  async ToggleAlerts(): Promise<SdkCommandResult> {
    const State = AlertsManager.SetActionsEnabled(!AlertsManager.GetActionsEnabled());
    return ok(`Alert actions ${State ? 'enabled' : 'disabled'}`);
  },

  // Show / Edit mode (authoritative server state) -------------------------
  async SetMode(mode: string): Promise<SdkCommandResult> {
    const Next = String(mode).toUpperCase() === 'EDIT' ? 'EDIT' : 'SHOW';
    ModeManager.Set(Next);
    return ok(`Mode set to ${Next}`);
  },
  async ToggleMode(): Promise<SdkCommandResult> {
    const Next = ModeManager.Get() === 'EDIT' ? 'SHOW' : 'EDIT';
    ModeManager.Set(Next);
    return ok(`Mode set to ${Next}`);
  },

  // Open the entity view modal (desktop renderer only) --------------------
  // Slugs share one namespace across clients, monitoring targets, dummies and
  // FreeKiosk terminals, so resolve across all of them and tag the bulk action
  // with the entity type; the
  // renderer routes each to its matching view (client info / monitor history /
  // dummy history). Integrated clients (QLab, etc.) have no host details, so the
  // client info window still refuses to open for them.
  //
  // Modal actions are addressed at the operator's own desktop window: the web
  // namespace drops them (WEB_SUPPRESSED_BULK_ACTIONS) so a Companion press does
  // not throw a modal up on every logged-in browser as well.
  async OpenClientModal(slug: string): Promise<SdkCommandResult> {
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

    const kiosk =
      typeof FreeKioskManager.GetBySlug === 'function'
        ? await FreeKioskManager.GetBySlug(slug)
        : null;
    if (kiosk) {
      emitBulk('OpenClientModal', [kiosk.UUID], 'freekiosk');
      return ok(`Opened FreeKiosk modal for "${kiosk.Slug || kiosk.UUID}"`);
    }

    return fail(`Invalid Client "${slug}"`);
  },

  // Identify ---------------------------------------------------------------
  // Flash the identify overlay on a client's own screen. Unlike every other
  // command here this mutates nothing and is safe in SHOW mode, which is the
  // point: it exists for the operator standing in front of a rack trying to work
  // out which machine is which, and that is a job done from a phone.
  //
  // Identify is addressed by UUID at the manager, so resolve the slug first. Only
  // real clients can be identified: monitors, dummies and FreeKiosk terminals
  // have no ShowTrak agent to draw the overlay, so they never resolve here.
  async Identify(slug: string): Promise<SdkCommandResult> {
    const c = await resolveClientByKey(slug);
    if (!c) return fail(`Invalid Client "${slug}"`);
    const [Err] = await IdentifyManager.Identify(c.UUID);
    if (Err) return fail(Err);
    return ok(`Identifying "${c.Slug || c.UUID}"`);
  },

  async StopIdentify(slug: string): Promise<SdkCommandResult> {
    const c = await resolveClientByKey(slug);
    if (!c) return fail(`Invalid Client "${slug}"`);
    const [Err] = await IdentifyManager.Stop(c.UUID);
    if (Err) return fail(Err);
    return ok(`Stopped identifying "${c.Slug || c.UUID}"`);
  },

  // Dismiss every open modal on the desktop renderer. No targets; the renderer
  // closes whatever it currently has open.
  async CloseModals(): Promise<SdkCommandResult> {
    emitBulk('CloseModals', []);
    return ok('Closed all modals');
  },

  // Client-list layout ------------------------------------------------------
  // Applied by every renderer that receives it, the desktop and each Web UI
  // browser alike (unlike the modal actions, which are desktop-only). `mode`
  // names the layout (grid / compact / list); SDKs before 1.8 send only
  // `compact`, which still means compact vs grid.
  async SetView(mode: unknown, compact?: unknown): Promise<SdkCommandResult> {
    let Next = parseViewMode(mode);
    if (!Next && mode == null && typeof compact === 'boolean') {
      Next = compact ? 'compact' : 'grid';
    }
    if (!Next) return fail(`Unknown view "${String(mode ?? '')}"`);
    emitBulk('SetViewMode', [], Next);
    return ok(`View set to ${Next}`);
  },
  async ToggleCompactView(): Promise<SdkCommandResult> {
    emitBulk('ToggleCompactView', []);
    return ok('Toggled the compact view');
  },

  // Monitoring check actions -----------------------------------------------
  // The /sdk twin of the OSC Monitor routes: power a projector on, recall a
  // console scene. `value` fills the action's first declared parameter (what a
  // single text field can address); `params` names any of them outright and
  // wins over `value`. Both are normalised against the action's own schema, as
  // the desktop's RunMonitoringAction channel does.
  async RunMonitorAction(
    slug: string,
    method: string,
    actionId: string,
    value?: unknown,
    params?: unknown
  ): Promise<SdkCommandResult> {
    const Target =
      typeof MonitoringTargetManager.GetBySlug === 'function'
        ? await MonitoringTargetManager.GetBySlug(slug)
        : null;
    if (!Target) return fail(`Invalid Monitor "${slug}"`);

    const Action = MonitoringMethods.GetAction(method, actionId);
    if (!Action) return fail(`Unknown action "${method}/${actionId}"`);

    const Raw: Record<string, unknown> = {};
    const Value = optionalValue(value);
    if (Value != null) {
      const First = Array.isArray(Action.Params) ? Action.Params[0] : null;
      if (!First) return fail(`Action "${method}/${actionId}" takes no value`);
      Raw[First.Key] = Value;
    }
    if (params != null) {
      if (typeof params !== 'object' || Array.isArray(params)) {
        return fail('Action parameters must be an object');
      }
      Object.assign(Raw, params);
    }
    let Params: Record<string, unknown>;
    try {
      Params = IPCValidation.MonitoringActionParams(method, actionId, Raw);
    } catch (Err) {
      return fail(`${Action.Label}: ${DescribeError(Err)}`);
    }

    const [Err, Summary] = await MonitoringTargetManager.RunAction(
      [Target.TargetID],
      method,
      actionId,
      Params
    );
    if (Err || !Summary) return fail(Err || 'Action failed');
    if (Summary.Failed > 0) {
      // The device's own refusal ("warming up", "wrong password") verbatim.
      const Reason = Summary.Results.find((Entry) => !Entry.Success)?.Error || 'Action failed';
      return fail(`${Action.Label} on "${Target.Slug || Target.TargetID}": ${Reason}`);
    }
    return ok(
      `${Action.Label} sent to "${Target.Slug || Target.TargetID}"${Value != null ? ` (${Value})` : ''}`
    );
  },

  // FreeKiosk terminal commands --------------------------------------------
  // The /sdk twin of the OSC FreeKiosk routes. `value` fills the command's one
  // parameter (brightness, volume) and runs through the same validator.
  async FreeKioskCommandOnTerminal(
    slug: string,
    commandId: string,
    value?: unknown
  ): Promise<SdkCommandResult> {
    return sendKioskCommand(resolveKioskTargets('terminal', slug), commandId, value);
  },
  async FreeKioskCommandOnGroup(
    slug: string,
    commandId: string,
    value?: unknown
  ): Promise<SdkCommandResult> {
    return sendKioskCommand(resolveKioskTargets('group', slug), commandId, value);
  },
  async FreeKioskCommandOnTag(
    slug: string,
    commandId: string,
    value?: unknown
  ): Promise<SdkCommandResult> {
    return sendKioskCommand(resolveKioskTargets('tag', slug), commandId, value);
  },
  async FreeKioskCommandOnAll(commandId: string, value?: unknown): Promise<SdkCommandResult> {
    return sendKioskCommand(resolveKioskTargets('all', ''), commandId, value);
  },

  // Dummy clients -----------------------------------------------------------
  // The /sdk twin of OSC /API/Dummy/<slug>/Heartbeat. No IP is recorded: the
  // socket belongs to the integration relaying the heartbeat, not to whatever
  // the dummy stands for, so its address would be the wrong one.
  async DummyHeartbeat(slug: string): Promise<SdkCommandResult> {
    const [Err] = await DummyClientManager.Heartbeat(slug, null);
    if (Err) return fail(Err);
    return ok(`Dummy heartbeat accepted for "${slug}"`);
  },

  // Script executions (the execution panel) ---------------------------------
  // Retry every failed execution that can be retried: what the panel's Retry
  // button does. Goes through the same handler, so the whitelist, per-client
  // queue and audit log apply exactly as on the first run.
  async RetryFailedExecutions(): Promise<SdkCommandResult> {
    const Executions = await ScriptExecutionManager.GetAllExecutions();
    const RequestIDs = Executions.filter((Execution) => GetRetryTarget(Execution)).map(
      (Execution) => Execution.RequestID
    );
    if (RequestIDs.length === 0) return ok('No failed executions to retry');
    const Handler = GetHandler('Scripts:RetryExecutions');
    if (typeof Handler !== 'function') return fail('Retry handler unavailable');
    const Result = await Handler(null, RequestIDs);
    if (Array.isArray(Result) && Result[0]) return fail(Result[0]);
    const Retried =
      Array.isArray(Result) && Result[1] && typeof Result[1] === 'object'
        ? Number((Result[1] as { Retried?: unknown }).Retried) || 0
        : RequestIDs.length;
    return ok(`Retried ${Retried} failed execution${Retried === 1 ? '' : 's'}`);
  },
  // Clear finished rows from the panel. Anything still queued or running stays.
  async ClearSettledExecutions(): Promise<SdkCommandResult> {
    return dispatchHandler('Scripts:ClearSettledExecutions', [], 'Cleared finished executions');
  },

  // Save the current show file --------------------------------------------
  async SaveShow(): Promise<SdkCommandResult> {
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
  async Shutdown(): Promise<SdkCommandResult> {
    Logger.warn('Received shutdown command via SDK');
    Broadcast.emit('Shutdown');
    return ok('Shutdown requested');
  },
  async ShutdownForce(): Promise<SdkCommandResult> {
    Logger.warn('Received force shutdown command via SDK');
    Broadcast.emit('ShutdownForce');
    return ok('Force shutdown requested');
  },
};

export type ControlServiceType = typeof ControlService;
