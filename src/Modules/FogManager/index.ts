// FogManager
// - Optional integration with a FOG Project server, letting imaging tasks be
//   scheduled against ShowTrak clients without leaving ShowTrak.
// - The integration is only ever considered available when the FOG_ENABLED setting
//   is on AND a probe of /fog/system/info actually succeeds. "Enabled" alone is a
//   statement of intent; "Healthy" is the thing the UI gates on.
// - ShowTrak deliberately never edits FOG configuration. It creates and observes
//   tasks; it does not assign images, edit hosts or change FOG settings. The one
//   place this is visible is Deploy, which requires the host to already have an
//   image assigned in FOG — we surface the assigned image rather than setting it.
// - All FOG state lives in its own tables (FogHosts, FogTasks) so the integration
//   can be turned off or removed without touching core client data.
import { CreateLogger } from '../Logger';
import { Manager as DB } from '../DB';
import { CreateFogRepository } from '../DB/repositories/fog';
import { Manager as BroadcastManager } from '../Broadcast';
import { Manager as SettingsManager } from '../SettingsManager';
import { Manager as ClientManager } from '../ClientManager';
import { Ok, Fail } from '../Utils';
import type { Result } from '../../types/result';
import type { FogTaskRow } from '../DB/rows';
import type {
  FogStatusView,
  FogHostView,
  FogTaskTypeView,
  FogTaskView,
} from '@showtrak/protocol';
import {
  FOG_TASK_TYPES,
  GetFogTaskType,
  FogTaskSupportsProgress,
  FogTaskPermissionKey,
  GetFogTaskStateName,
  FOG_TASK_POLL_INTERVAL_MS,
  FOG_UNHEALTHY_POLL_INTERVAL_MS,
} from '../Config/fog';
import {
  FogRequest,
  CheckHealth,
  ParseJson,
  ToNumber,
  ToText,
  ConfigIsComplete,
  type FogConfig,
} from './client';

const Logger = CreateLogger('FogManager');

const FogRepo = CreateFogRepository(DB);

// FOG states 0-3 are non-terminal; 4 (Complete) and 5 (Cancelled) are terminal.
const OPEN_STATE_IDS = [0, 1, 2, 3];
const STATE_COMPLETE = 4;
const STATE_CANCELLED = 5;

// A task that never appears in FOG's active list within this window is assumed to
// have finished before we first looked. This is not paranoia: fast task types such
// as Wake-Up complete almost immediately and may never be observed as active.
const UNSEEN_TASK_GRACE_MS = 90000;

// Finished tasks are kept this long so the panel can show recent history.
const FINISHED_TASK_RETENTION_MS = 24 * 60 * 60 * 1000;

// ---- Runtime state ---------------------------------------------------------

let Healthy = false;
let StatusMessage: string | null = null;
let LastCheckedAt: number | null = null;
let PollTimer: NodeJS.Timeout | null = null;
// Guards against overlapping polls when FOG is slow enough that a tick lands while
// the previous one is still in flight.
let PollInFlight = false;

// Host list is cached so the client editor dropdown still has something to show
// when FOG goes away mid-session. Staleness is acceptable here; an empty dropdown
// is not.
let HostCache: FogHostView[] = [];

async function LoadConfig(): Promise<FogConfig> {
  const Protocol = String((await SettingsManager.GetValue('FOG_PROTOCOL')) || 'http');
  return {
    Protocol: Protocol === 'https' ? 'https' : 'http',
    Host: String((await SettingsManager.GetValue('FOG_HOST')) || '').trim(),
    Port: ToNumber(await SettingsManager.GetValue('FOG_PORT'), 0),
    ApiToken: String((await SettingsManager.GetValue('FOG_API_TOKEN')) || '').trim(),
    UserToken: String((await SettingsManager.GetValue('FOG_USER_TOKEN')) || '').trim(),
  };
}

async function IsEnabled(): Promise<boolean> {
  return !!(await SettingsManager.GetValue('FOG_ENABLED'));
}

function Now(): number {
  return Date.now();
}

// ---- Health ----------------------------------------------------------------

async function RefreshHealth(): Promise<boolean> {
  const Enabled = await IsEnabled();
  if (!Enabled) {
    SetHealth(false, null);
    return false;
  }

  const Config = await LoadConfig();
  if (!ConfigIsComplete(Config)) {
    SetHealth(false, 'FOG integration is enabled but not fully configured');
    return false;
  }

  const Problem = await CheckHealth(Config);
  SetHealth(!Problem, Problem);
  return !Problem;
}

function SetHealth(Next: boolean, Message: string | null): void {
  const Changed = Next !== Healthy || Message !== StatusMessage;
  Healthy = Next;
  StatusMessage = Message;
  LastCheckedAt = Now();
  if (Changed) {
    if (Message) Logger.warn(`FOG integration unavailable: ${Message}`);
    else if (Next) Logger.log('FOG integration connected');
    BroadcastManager.emit('FogStatusChanged');
  }
}

// ---- Task polling ----------------------------------------------------------

interface FogActiveTask {
  id: unknown;
  hostID: unknown;
  typeID: unknown;
  stateID: unknown;
  percent: unknown;
  pct: unknown;
}

// Reconcile our FogTasks rows against FOG's live active-task list.
//
// FOG's task-creation endpoint returns no task ID (the body is the literal string
// `null`), so a newly scheduled row has no FOG identifier. The first poll that sees
// an active task on the same host with the same type adopts it. That match is
// inherently best-effort — if the same task type is scheduled twice on one host in
// quick succession the pairing is arbitrary — but the alternative is no tracking at
// all, and the displayed state is correct either way.
async function ReconcileTasks(Config: FogConfig): Promise<boolean> {
  const [OpenErr, OpenRows] = await FogRepo.GetOpenTasks();
  if (OpenErr) {
    Logger.error(`Failed to read open FOG tasks: ${String(OpenErr)}`);
    return false;
  }
  if (!OpenRows || !OpenRows.length) return false;

  const Response = await FogRequest(Config, '/task/active', 'GET');
  if (!Response.Success) {
    Logger.warn(`Could not read FOG active tasks: ${Response.Error}`);
    return false;
  }

  const Payload = ParseJson<{ tasks?: FogActiveTask[] }>(Response);
  const ActiveTasks = Payload && Array.isArray(Payload.tasks) ? Payload.tasks : [];

  // Tasks we have already paired to a record, so two records cannot adopt the same
  // live FOG task.
  const ClaimedTaskIDs = new Set<number>();
  let Changed = false;
  const Timestamp = Now();

  for (const Row of OpenRows) {
    let Match: FogActiveTask | null = null;

    if (Row.FogTaskID != null) {
      Match =
        ActiveTasks.find(
          (Task) => ToNumber(Task.id, -1) === Row.FogTaskID && !ClaimedTaskIDs.has(Row.FogTaskID!)
        ) || null;
    } else {
      Match =
        ActiveTasks.find(
          (Task) =>
            ToNumber(Task.hostID, -1) === Row.FogHostID &&
            ToNumber(Task.typeID, -1) === Row.TaskTypeID &&
            !ClaimedTaskIDs.has(ToNumber(Task.id, -1))
        ) || null;
    }

    if (Match) {
      const TaskID = ToNumber(Match.id, 0);
      ClaimedTaskIDs.add(TaskID);
      const StateID = ToNumber(Match.stateID, Row.StateID);
      // FOG exposes both `percent` (display text) and `pct` (numeric). Prefer the
      // text, fall back to the number, and only show it once actually in progress —
      // percent is meaningless while a task is still queued.
      const Percent =
        StateID === 3 ? ToText(Match.percent) || `${ToNumber(Match.pct, 0)}%` : null;

      if (Row.FogTaskID !== TaskID || Row.StateID !== StateID || Row.Percent !== Percent) {
        await FogRepo.UpdateTaskProgress(Row.FogTaskRecordID, TaskID, StateID, Percent, Timestamp);
        Changed = true;
      }
      continue;
    }

    // No longer active. If we know its FOG task ID we can ask FOG for the real
    // terminal state, which distinguishes Complete from Cancelled.
    if (Row.FogTaskID != null) {
      const FinalState = await ReadFinalState(Config, Row.FogTaskID);
      await FogRepo.UpdateTaskProgress(
        Row.FogTaskRecordID,
        Row.FogTaskID,
        FinalState,
        null,
        Timestamp
      );
      Changed = true;
      continue;
    }

    // Never seen active and never given an ID. Past the grace window, assume it ran
    // and finished between polls rather than leaving it pending forever.
    if (Timestamp - Row.CreatedAt > UNSEEN_TASK_GRACE_MS) {
      await FogRepo.UpdateTaskProgress(
        Row.FogTaskRecordID,
        null,
        STATE_COMPLETE,
        null,
        Timestamp
      );
      Changed = true;
    }
  }

  return Changed;
}

// Read a task's terminal state directly. Falls back to Complete when FOG cannot
// tell us — the task is definitively no longer running either way.
async function ReadFinalState(Config: FogConfig, FogTaskID: number): Promise<number> {
  const Response = await FogRequest(Config, `/task/${FogTaskID}`, 'GET');
  if (!Response.Success) return STATE_COMPLETE;
  const Task = ParseJson<{ stateID?: unknown }>(Response);
  if (!Task || Task.stateID == null) return STATE_COMPLETE;
  const StateID = ToNumber(Task.stateID, STATE_COMPLETE);
  return OPEN_STATE_IDS.includes(StateID) ? STATE_COMPLETE : StateID;
}

async function PollOnce(): Promise<void> {
  if (PollInFlight) return;
  PollInFlight = true;
  try {
    const WasHealthy = Healthy;
    const NowHealthy = await RefreshHealth();
    if (!NowHealthy) return;

    const Config = await LoadConfig();
    const Changed = await ReconcileTasks(Config);

    // Prune old finished tasks opportunistically rather than on a separate timer.
    await FogRepo.PruneFinishedTasksBefore(Now() - FINISHED_TASK_RETENTION_MS);

    // Push when task state moved, or when FOG just came back — the panel shows the
    // connection state too, so recovery is itself worth rendering.
    if (Changed || !WasHealthy) BroadcastManager.emit('FogTasksUpdated');
  } catch (Err) {
    Logger.error(`FOG poll failed: ${Err instanceof Error ? Err.message : String(Err)}`);
  } finally {
    PollInFlight = false;
    ScheduleNextPoll();
  }
}

// Self-rescheduling timer rather than setInterval, so the backoff interval can
// change between ticks and a slow poll can never stack up behind itself.
function ScheduleNextPoll(): void {
  if (PollTimer) {
    clearTimeout(PollTimer);
    PollTimer = null;
  }
  if (!Manager.Running) return;
  const Interval = Healthy ? FOG_TASK_POLL_INTERVAL_MS : FOG_UNHEALTHY_POLL_INTERVAL_MS;
  PollTimer = setTimeout(() => {
    void PollOnce();
  }, Interval);
}

// ---- Views -----------------------------------------------------------------

async function ResolveClientName(
  UUID: string | null,
  Fallback: string | null
): Promise<string | null> {
  if (!UUID) return Fallback;
  try {
    if (typeof ClientManager.Get !== 'function') return Fallback;
    const [Err, Client] = await ClientManager.Get(UUID);
    if (Err || !Client) return Fallback;
    return Client.Nickname || Client.Hostname || Fallback;
  } catch {
    // A deleted client must not stop the task list rendering.
    return Fallback;
  }
}

async function TaskRowToView(Row: FogTaskRow): Promise<FogTaskView> {
  return {
    FogTaskRecordID: Row.FogTaskRecordID,
    UUID: Row.UUID,
    ClientName: await ResolveClientName(Row.UUID, Row.FogHostName),
    FogHostID: Row.FogHostID,
    FogHostName: Row.FogHostName,
    FogTaskID: Row.FogTaskID,
    TaskTypeID: Row.TaskTypeID,
    TaskTypeName: Row.TaskTypeName,
    SupportsProgress: FogTaskSupportsProgress(Row.TaskTypeID),
    StateID: Row.StateID,
    StateName: GetFogTaskStateName(Row.StateID),
    Percent: Row.Percent,
    LastError: Row.LastError,
    CreatedAt: Row.CreatedAt,
    UpdatedAt: Row.UpdatedAt,
  };
}

// ---- Public API ------------------------------------------------------------

const Manager = {
  Running: false,

  // Started from main boot. Safe to call when the integration is disabled: the
  // poller runs regardless and simply reports "not enabled" until it is turned on,
  // which is what makes toggling the setting take effect without a restart.
  async Start(): Promise<void> {
    if (Manager.Running) return;
    Manager.Running = true;
    await PollOnce();
  },

  Stop(): void {
    Manager.Running = false;
    if (PollTimer) {
      clearTimeout(PollTimer);
      PollTimer = null;
    }
  },

  // Re-probe immediately. Bound to the FogSettingsChanged event so editing the
  // address or a token gives instant feedback rather than waiting out the interval.
  async SettingsChanged(): Promise<void> {
    HostCache = [];
    if (!Manager.Running) return;
    await PollOnce();
  },

  async GetStatus(): Promise<FogStatusView> {
    return {
      Enabled: await IsEnabled(),
      Healthy,
      Message: StatusMessage,
      LastCheckedAt,
    };
  },

  // Force a fresh probe and return the resulting status. Used by the settings UI's
  // connection test.
  async TestConnection(): Promise<FogStatusView> {
    await RefreshHealth();
    return Manager.GetStatus();
  },

  // Task types the operator has permitted in settings. The modal renders exactly
  // this list, so a type that is off here cannot even be selected.
  async GetPermittedTaskTypes(): Promise<FogTaskTypeView[]> {
    const Permitted: FogTaskTypeView[] = [];
    for (const Type of FOG_TASK_TYPES) {
      const Allowed = await SettingsManager.GetValue(FogTaskPermissionKey(Type.TaskTypeID));
      if (!Allowed) continue;
      Permitted.push({
        TaskTypeID: Type.TaskTypeID,
        Name: Type.Name,
        Destructive: Type.Destructive,
        RequiresSnapinID: !!Type.RequiresSnapinID,
      });
    }
    return Permitted;
  },

  // Fetch the FOG host list for the client editor dropdown. Degrades to the last
  // known list when FOG is unreachable rather than erroring, so opening the editor
  // never depends on FOG being up.
  async GetHosts(): Promise<Result<FogHostView[]>> {
    if (!(await IsEnabled())) return Ok<FogHostView[]>([]);

    const Config = await LoadConfig();
    if (!ConfigIsComplete(Config)) return Ok<FogHostView[]>(HostCache);

    const Response = await FogRequest(Config, '/host', 'GET');
    if (!Response.Success) {
      Logger.warn(`Could not read FOG hosts: ${Response.Error}`);
      // Cache, not an error: the caller wants to render a dropdown either way.
      return Ok<FogHostView[]>(HostCache);
    }

    const Payload = ParseJson<{ hosts?: Record<string, unknown>[] }>(Response);
    const Hosts = Payload && Array.isArray(Payload.hosts) ? Payload.hosts : [];

    HostCache = Hosts.map((Host) => {
      const Image = Host.image as { name?: unknown } | undefined;
      return {
        FogHostID: ToNumber(Host.id, 0),
        Name: ToText(Host.name) || `Host ${ToNumber(Host.id, 0)}`,
        MacAddress: ToText(Host.primac) || null,
        ImageName: ToText(Host.imagename) || (Image ? ToText(Image.name) : '') || null,
      };
    }).sort((A, B) => A.Name.localeCompare(B.Name));

    return Ok<FogHostView[]>(HostCache);
  },

  async GetHostLink(UUID: string): Promise<Result<{ FogHostID: number; FogHostName: string | null } | null>> {
    const [Err, Row] = await FogRepo.GetHostLink(UUID);
    if (Err) return Fail(String(Err));
    if (!Row) return Ok<{ FogHostID: number; FogHostName: string | null } | null>(null);
    return Ok<{ FogHostID: number; FogHostName: string | null } | null>({
      FogHostID: Row.FogHostID,
      FogHostName: Row.FogHostName,
    });
  },

  // Link a ShowTrak client to a FOG host. Passing a null/0 host ID clears the link.
  // The host name is cached alongside the ID purely so the editor can label the
  // link when FOG is unreachable.
  async SetHostLink(UUID: string, FogHostID: number | null): Promise<Result<void>> {
    if (!UUID) return Fail('No client specified');

    if (FogHostID == null || FogHostID <= 0) {
      const [Err] = await FogRepo.DeleteHostLink(UUID);
      if (Err) return Fail(String(Err));
      BroadcastManager.emit('FogTasksUpdated');
      return Ok<void>();
    }

    const Hosts = HostCache.length ? HostCache : ((await Manager.GetHosts())[1] ?? []);
    const Host = Hosts.find((Candidate) => Candidate.FogHostID === FogHostID) || null;

    const [Err] = await FogRepo.UpsertHostLink(UUID, FogHostID, Host ? Host.Name : null, Now());
    if (Err) return Fail(String(Err));
    BroadcastManager.emit('FogTasksUpdated');
    return Ok<void>();
  },

  async GetTasks(): Promise<Result<FogTaskView[]>> {
    const [Err, Rows] = await FogRepo.GetAllTasks();
    if (Err) return Fail(String(Err));
    const Views: FogTaskView[] = [];
    for (const Row of Rows || []) Views.push(await TaskRowToView(Row));
    return Ok<FogTaskView[]>(Views);
  },

  // Schedule a task against the FOG host linked to a ShowTrak client.
  //
  // Every gate is re-checked here rather than trusted from the renderer: enabled,
  // healthy, the task type is host-schedulable, and the operator has permitted that
  // specific type. The UI applies the same rules, but the UI is not the authority.
  async ScheduleTask(
    UUID: string,
    TaskTypeID: number,
    SnapinID: number | null = null
  ): Promise<Result<void>> {
    if (!(await IsEnabled())) return Fail('FOG integration is not enabled');
    if (!Healthy) return Fail(StatusMessage || 'FOG server is not reachable');

    const TaskType = GetFogTaskType(TaskTypeID);
    if (!TaskType) return Fail('That task type cannot be scheduled against a host');

    const Allowed = await SettingsManager.GetValue(FogTaskPermissionKey(TaskTypeID));
    if (!Allowed) return Fail(`"${TaskType.Name}" is not permitted in the FOG settings`);

    const [LinkErr, Link] = await FogRepo.GetHostLink(UUID);
    if (LinkErr) return Fail(String(LinkErr));
    if (!Link) return Fail('This client is not linked to a FOG host');

    const Body: Record<string, unknown> = { taskTypeID: TaskTypeID };

    // Single Snapin targets one specific snapin, passed through deploySnapins.
    // FOG overloads that field: true/-1 means all snapins, a positive number means
    // that snapin ID, anything else means none.
    if (TaskType.RequiresSnapinID) {
      if (SnapinID == null || SnapinID <= 0) {
        return Fail(`"${TaskType.Name}" requires a snapin ID`);
      }
      Body.deploySnapins = SnapinID;
    }

    const Config = await LoadConfig();
    const Response = await FogRequest(Config, `/host/${Link.FogHostID}/task`, 'POST', Body);

    if (!Response.Success) {
      return Fail(Response.Error || 'FOG rejected the task');
    }

    // Success is signalled by the 200 alone — FOG returns the literal string `null`
    // and no task ID, so the record starts unpaired and the poller adopts it.
    const [InsertErr] = await FogRepo.InsertTask(
      UUID,
      Link.FogHostID,
      Link.FogHostName,
      TaskTypeID,
      TaskType.Name,
      Now()
    );
    if (InsertErr) return Fail(String(InsertErr));

    Logger.log(`Scheduled FOG task "${TaskType.Name}" on host ${Link.FogHostID}`);

    // Push immediately so the panel reflects the new task without waiting for the
    // next 30s tick, then poll shortly after to pick up the real task ID and state.
    BroadcastManager.emit('FogTasksUpdated');
    setTimeout(() => {
      void PollOnce();
    }, 2000);

    return Ok<void>();
  },

  // Cancel a running FOG task from the panel.
  //
  // FOG cancels an active task via DELETE on the task resource — the mirror of the
  // GET /task/{id} used to read a task's terminal state. A task we have not yet
  // paired to a FOG task ID cannot be cancelled: FOG's create endpoint returns no ID,
  // so until the poller adopts a live task there is nothing to address. That window
  // is short (the follow-up poll runs 2s after scheduling), so the operator just
  // retries in a moment.
  async CancelTask(FogTaskRecordID: number): Promise<Result<void>> {
    if (!(await IsEnabled())) return Fail('FOG integration is not enabled');
    if (!Healthy) return Fail(StatusMessage || 'FOG server is not reachable');

    const [ReadErr, Row] = await FogRepo.GetTask(FogTaskRecordID);
    if (ReadErr) return Fail(String(ReadErr));
    if (!Row) return Fail('That task no longer exists');
    if (!OPEN_STATE_IDS.includes(Row.StateID)) return Fail('That task has already finished');
    if (Row.FogTaskID == null) {
      return Fail('FOG has not picked this task up yet — try again in a moment');
    }

    const Config = await LoadConfig();
    const Response = await FogRequest(Config, `/task/${Row.FogTaskID}`, 'DELETE');
    // A 404 means FOG already dropped the task (it finished or was cancelled there);
    // treat that as success rather than blocking the operator on a stale record.
    if (!Response.Success && Response.StatusCode !== 404) {
      return Fail(Response.Error || 'FOG refused to cancel the task');
    }

    await FogRepo.UpdateTaskProgress(
      Row.FogTaskRecordID,
      Row.FogTaskID,
      STATE_CANCELLED,
      null,
      Now()
    );
    Logger.log(`Cancelled FOG task ${Row.FogTaskID} on host ${Row.FogHostID}`);

    // Cancelled is terminal, so the poller will leave this row alone from here — push
    // now so the panel reflects it immediately rather than at the next 30s tick.
    BroadcastManager.emit('FogTasksUpdated');

    return Ok<void>();
  },
};

export { Manager };
