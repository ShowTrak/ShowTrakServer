// WorkflowManager.
//
// A Workflow is a named, reusable, callable unit of logic in three sections:
// Triggers (what starts it), Steps (the ordered program) and Return (the single
// value handed back). It follows the AlertsManager module idiom — in-memory
// list, lazy Init, Ok/Fail results, a payload-less list-changed broadcast — but
// diverges in two deliberate places:
//
//   * Steps run strictly in order, where alert actions fire concurrently.
//   * Workflows are hand-ordered by Weight like tags, where alert rules are
//     newest-first with no ordering at all.
import { Manager as DB } from '../DB';
import { Manager as BroadcastManager } from '../Broadcast';
import { Manager as TagManager } from '../TagManager';
import { Manager as MonitoringTargetManager } from '../MonitoringTargetManager';
import { Manager as ClientManager } from '../ClientManager';
import { Manager as AlertActions } from '../AlertActions';
import { CreateLogger } from '../Logger';
import { Ok, Fail } from '../Utils';
import { ScopeCoversEntity, ScopeReferencesTags } from '../ScopeMatching';
import * as SlugService from '../Slug';
import { CreateWorkflowsRepository } from '../DB/repositories/workflows';
import { CreateWorkflowRunsRepository } from '../DB/repositories/workflow-runs';
import { NormalizeSteps, CollectCalledWorkflowIDs, type WorkflowStep } from './steps';
import { NormalizeTriggers, TriggerEventMatches, WORKFLOW_TRIGGER_TYPES } from './triggers';
import { normalizeWorkflowRow, NormalizeReturn, type WorkflowView } from './serialization';
import {
  StartRun,
  AbortRun,
  ResumeRun,
  AnswerPrompt,
  GetRun,
  GetActiveRuns,
  AbortAllRuns,
  type WorkflowRunView,
  type WorkflowRunnerDeps,
  type WorkflowRunMode,
  type WorkflowActionOutcome,
} from './runner';
import type { Result } from '../../types/result';
import type { ScopeTag } from '../ScopeMatching';

const Logger = CreateLogger('WorkflowManager');

const WorkflowsRepo = CreateWorkflowsRepository(DB);
const RunsRepo = CreateWorkflowRunsRepository(DB);

// Lower than alerts' 10000: each row carries a per-step result array, so the
// rows are considerably fatter.
const RUN_HISTORY_MAX_ROWS = 5000;
const RUN_HISTORY_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

let Initialized = false;
let WorkflowList: WorkflowView[] = [];
let PruneTimer: ReturnType<typeof setInterval> | null = null;

export interface WorkflowCreatePayload {
  Name: string;
  Description?: string;
  Icon?: string;
  Colour?: number;
  Triggers?: unknown;
  Steps?: unknown;
  Return?: unknown;
  Enabled?: unknown;
}

export type WorkflowUpdatePayload = Partial<WorkflowCreatePayload>;

export interface WorkflowContextInput {
  ScopedID?: string | null;
  // Pre-built context from an alert or another workflow, used as-is when given.
  Context?: Record<string, unknown> | null;
}

// --- Context resolution ------------------------------------------------------

// Turn a ScopedID into the object conditions read. The dotted paths an operator
// writes (check.Online, client.Online) are the keys here, so this shape is
// effectively the condition vocabulary.
async function ResolveContext(ScopedID: string | null): Promise<Record<string, unknown>> {
  const Base: Record<string, unknown> = {
    ScopedID: ScopedID || null,
    EntityType: 'none',
    EntityName: '',
  };
  if (!ScopedID) return Base;

  if (ScopedID.startsWith('monitor:')) {
    const TargetID = Number(ScopedID.slice('monitor:'.length));
    const [, Target] = await MonitoringTargetManager.Get(TargetID);
    if (!Target) return Base;
    return {
      ...Base,
      EntityType: 'monitor',
      EntityName: Target.Nickname || '',
      TargetID,
      GroupID: Target.GroupID ?? null,
      monitor: Target,
    };
  }

  if (ScopedID.startsWith('check:')) {
    const CheckID = Number(ScopedID.slice('check:'.length));
    const [, Debug] = await MonitoringTargetManager.GetCheckDebug(CheckID);
    if (!Debug) return Base;
    return {
      ...Base,
      EntityType: 'monitor-check',
      EntityName: `Check ${CheckID}`,
      CheckID,
      check: Debug,
    };
  }

  const [, Client] = await ClientManager.Get(ScopedID);
  if (!Client) return Base;
  const Plain = Client as unknown as Record<string, unknown>;
  return {
    ...Base,
    EntityType: 'client',
    EntityName: Plain.Nickname || '',
    UUID: ScopedID,
    GroupID: Plain.GroupID ?? null,
    client: Plain,
  };
}

// --- Action dispatch ---------------------------------------------------------

// Which check a method action runs against. 'context' uses whatever the run was
// started against, which is what makes a workflow reusable across every
// projector rather than wired to one.
function resolveCheckID(
  Step: Extract<WorkflowStep, { Kind: 'action' }>,
  Context: Record<string, unknown>
): number | null {
  const Raw =
    Step.Target.Mode === 'scoped'
      ? String(Step.Target.ScopedID || '')
      : String(Context.ScopedID || '');
  if (!Raw.startsWith('check:')) return null;
  const ID = Number(Raw.slice('check:'.length));
  return Number.isFinite(ID) ? ID : null;
}

async function RunActionStep(
  Step: Extract<WorkflowStep, { Kind: 'action' }>,
  _Run: WorkflowRunView,
  Context: Record<string, unknown>
): Promise<WorkflowActionOutcome> {
  if (Step.ActionKind === 'method') {
    const CheckID = resolveCheckID(Step, Context);
    if (CheckID == null) {
      return {
        Success: false,
        Error:
          'This step needs a monitoring check to act on — pick one, or run the workflow against a check',
      };
    }
    // ActionID is "<MethodID>/<ActionID>"; only the action half reaches the
    // check, since the check already knows its own method.
    const ActionID = Step.ActionID.includes('/')
      ? Step.ActionID.slice(Step.ActionID.indexOf('/') + 1)
      : Step.ActionID;
    const [Err, Result] = await MonitoringTargetManager.RunCheckAction(
      CheckID,
      ActionID,
      Step.Params
    );
    if (Err || !Result) return { Success: false, Error: Err || 'Action failed' };
    return {
      Success: !!Result.Success,
      Detail: Result.Detail,
      Error: Result.Error,
      Data: { Confirmed: Result.Confirmed },
    };
  }

  if (Step.ActionKind === 'alert') {
    const Result = await AlertActions.Execute(
      { Type: Step.ActionID, Settings: Step.Params },
      Context
    );
    return {
      Success: !!(Result && Result.Success),
      Error: Result && Result.Error ? String(Result.Error) : undefined,
    };
  }

  return { Success: false, Error: `Unsupported action type "${Step.ActionKind}"` };
}

// --- Runner wiring -----------------------------------------------------------

function buildDeps(): WorkflowRunnerDeps {
  return {
    RunAction: RunActionStep,

    CallWorkflow: async (WorkflowID, Context, Depth, Visited) => {
      const Target = WorkflowList.find((W) => W.WorkflowID === Number(WorkflowID));
      if (!Target) return { Success: false, Return: null, Error: 'Workflow not found' };
      if (!Target.Enabled) return { Success: false, Return: null, Error: 'Workflow is disabled' };

      const Run = await StartRun(
        {
          WorkflowID: Target.WorkflowID,
          WorkflowName: Target.Name,
          Steps: Target.Steps,
          Return: Target.Return,
          Mode: 'normal',
          TriggerSource: 'call',
          ContextScopedID: (Context.ScopedID as string) || null,
          Context,
          Depth,
          Visited,
        },
        buildDeps()
      );

      return {
        Success: Run.Status === 'completed',
        Return: Run.ReturnValue,
        Error: Run.Error,
      };
    },

    Emit: (Run) => BroadcastManager.emit('WorkflowRunUpdated', Run),

    Persist: (Run) => {
      void RunsRepo.Insert({
        WorkflowID: Run.WorkflowID,
        RunKey: Run.RunKey,
        TriggerSource: Run.TriggerSource,
        ContextScopedID: Run.ContextScopedID,
        Status: Run.Status,
        Context: JSON.stringify({ Vars: Run.Vars }),
        Steps: JSON.stringify(Run.Steps),
        ReturnValue: JSON.stringify(Run.ReturnValue ?? null),
        StartedAt: Run.StartedAt,
        FinishedAt: Run.FinishedAt || Date.now(),
      }).then(([Err]) => {
        if (Err) Logger.error('Failed to persist workflow run', Err);
      });
    },

    Now: () => Date.now(),

    // Wake early on abort rather than holding a run — and a device lock — for
    // the rest of a long wait.
    Sleep: (Ms, Signal) =>
      new Promise<void>((Resolve) => {
        const Step = Math.min(Ms, 250);
        const Deadline = Date.now() + Ms;
        const Tick = () => {
          if (Signal.Aborted || Date.now() >= Deadline) return Resolve();
          setTimeout(Tick, Math.min(Step, Math.max(0, Deadline - Date.now())));
        };
        Tick();
      }),
  };
}

// --- Manager -----------------------------------------------------------------

function startPruning(): void {
  if (PruneTimer) return;
  const Prune = () => {
    void RunsRepo.PruneToMaxRows(RUN_HISTORY_MAX_ROWS).then(([Err]) => {
      if (Err) Logger.error('Failed to prune workflow run history', Err);
    });
  };
  Prune();
  PruneTimer = setInterval(Prune, RUN_HISTORY_PRUNE_INTERVAL_MS);
  if (typeof PruneTimer.unref === 'function') PruneTimer.unref();
}

async function loadTagsIfNeeded(): Promise<ScopeTag[] | undefined> {
  // Only pay for the tag list when some workflow's scope actually references
  // tags — the same lazy check AlertsManager makes per event.
  if (!WorkflowList.some((W) => W.Enabled && ScopeReferencesTags(W.Triggers.Scope))) {
    return undefined;
  }
  return (await TagManager.GetAllViews()) as unknown as ScopeTag[];
}

async function coversEntity(
  Workflow: WorkflowView,
  ScopedID: string,
  GroupID: number | null,
  Tags: ScopeTag[] | undefined
): Promise<boolean> {
  const Scope = Workflow.Triggers.Scope;
  // Per-check targeting is strictly opt-in and ignores Workspace/Group/Tag, so a
  // workflow scoped to "everything" does not fan out across every check on every
  // target. Same rule AlertsManager applies.
  if (ScopedID.startsWith('check:')) {
    return (Scope.Clients as unknown[]).map((C) => String(C)).includes(ScopedID);
  }
  if (Scope.Workspace) return true;
  return ScopeCoversEntity(Scope, { ScopedID, GroupID }, Tags);
}

const Manager = {
  async Init(): Promise<void> {
    if (Initialized) return;
    Initialized = true;
    const [Err, Rows] = await WorkflowsRepo.GetAll();
    if (Err) {
      Logger.error('Failed to load workflows', Err);
      WorkflowList = [];
      return;
    }
    WorkflowList = (Rows || []).map(normalizeWorkflowRow);
    startPruning();
  },

  async Reload(): Promise<void> {
    // A run holding a reference to a workflow that may not exist after a show
    // import is a live hazard, not something to let finish.
    const Stopped = AbortAllRuns();
    if (Stopped) Logger.warn(`Aborted ${Stopped} running workflow(s) before reload`);
    Initialized = false;
    WorkflowList = [];
    await Manager.Init();
    BroadcastManager.emit('WorkflowListChanged');
  },

  async GetAll(): Promise<Result<WorkflowView[]>> {
    if (!Initialized) await Manager.Init();
    return Ok(WorkflowList.slice());
  },

  async Get(WorkflowID: unknown): Promise<Result<WorkflowView>> {
    if (!Initialized) await Manager.Init();
    const Found = WorkflowList.find((W) => W.WorkflowID === Number(WorkflowID));
    return Found ? Ok(Found) : Fail('Workflow not found');
  },

  async GetBySlug(Slug: unknown): Promise<WorkflowView | null> {
    if (!Initialized) await Manager.Init();
    const Lower = String(Slug || '')
      .trim()
      .toLowerCase();
    if (!Lower) return null;
    return WorkflowList.find((W) => (W.Slug || '').toLowerCase() === Lower) || null;
  },

  GetTriggerTypes: () => WORKFLOW_TRIGGER_TYPES,

  // Workflows offered manually against one entity.
  async GetForContext(ScopedID: unknown): Promise<Result<WorkflowView[]>> {
    if (!Initialized) await Manager.Init();
    const ID = String(ScopedID || '').trim();
    if (!ID) return Ok([]);

    const Context = await ResolveContext(ID);
    const GroupID = (Context.GroupID as number | null) ?? null;
    const Tags = await loadTagsIfNeeded();

    const Out: WorkflowView[] = [];
    for (const Workflow of WorkflowList) {
      if (!Workflow.Enabled || !Workflow.Triggers.Manual) continue;
      if (await coversEntity(Workflow, ID, GroupID, Tags)) Out.push(Workflow);
    }
    return Ok(Out);
  },

  async Create(Payload: WorkflowCreatePayload): Promise<Result<WorkflowView>> {
    if (!Initialized) await Manager.Init();

    const Name = String(Payload.Name || '').trim();
    if (!Name) return Fail('A workflow needs a name');

    const Now = Date.now();
    const Steps = NormalizeSteps(Payload.Steps).Steps;
    const Row = {
      Name,
      Description: String(Payload.Description || ''),
      Icon: String(Payload.Icon || 'diagram-3'),
      Colour: Number.isFinite(Number(Payload.Colour)) ? Number(Payload.Colour) : 6,
      Triggers: JSON.stringify(NormalizeTriggers(Payload.Triggers)),
      Steps: JSON.stringify(Steps),
      Return: JSON.stringify(NormalizeReturn(Payload.Return)),
      Enabled: Payload.Enabled === undefined ? 1 : Payload.Enabled ? 1 : 0,
      // New workflows land at the end of the hand-ordered list.
      Weight: WorkflowList.length ? Math.max(...WorkflowList.map((W) => W.Weight)) + 10 : 100,
      Timestamp: Now,
      UpdatedAt: Now,
    };

    const [Err, Res] = await WorkflowsRepo.Insert(Row);
    if (Err || !Res) return Fail('Failed to create workflow');

    const Slug = await SlugService.GenerateUniqueWorkflowSlug(
      Name,
      SlugService.WorkflowOwner(Res.lastID)
    );
    await WorkflowsRepo.UpdateSlug(Res.lastID, Slug);

    const Created = normalizeWorkflowRow({ WorkflowID: Res.lastID, Slug, ...Row });
    WorkflowList.push(Created);
    BroadcastManager.emit('WorkflowListChanged');
    return Ok(Created);
  },

  async Update(WorkflowID: unknown, Payload: WorkflowUpdatePayload): Promise<Result<WorkflowView>> {
    if (!Initialized) await Manager.Init();
    const ID = Number(WorkflowID);
    const Existing = WorkflowList.find((W) => W.WorkflowID === ID);
    if (!Existing) return Fail('Workflow not found');

    const has = (Key: keyof WorkflowUpdatePayload) =>
      Object.prototype.hasOwnProperty.call(Payload, Key);

    const Steps = has('Steps') ? NormalizeSteps(Payload.Steps).Steps : Existing.Steps;

    // Refuse an edit that would make a workflow reach itself. The runner also
    // guards at run time — it has to, since a cycle can be formed through an
    // alert action the save-time walk cannot see — but catching it here is what
    // stops an operator saving something that looks fine and fails mid-show.
    if (has('Steps')) {
      const Cycle = FindCallCycle(ID, Steps);
      if (Cycle) return Fail(Cycle);
    }

    const Row = {
      Name: has('Name') ? String(Payload.Name || '').trim() : Existing.Name,
      Description: has('Description') ? String(Payload.Description || '') : Existing.Description,
      Icon: has('Icon') ? String(Payload.Icon || 'diagram-3') : Existing.Icon,
      Colour: has('Colour') ? Number(Payload.Colour) || 0 : Existing.Colour,
      Triggers: JSON.stringify(
        has('Triggers') ? NormalizeTriggers(Payload.Triggers) : Existing.Triggers
      ),
      Steps: JSON.stringify(Steps),
      Return: JSON.stringify(has('Return') ? NormalizeReturn(Payload.Return) : Existing.Return),
      Enabled: has('Enabled') ? (Payload.Enabled ? 1 : 0) : Existing.Enabled ? 1 : 0,
      Weight: Existing.Weight,
      UpdatedAt: Date.now(),
    };
    if (!Row.Name) return Fail('A workflow needs a name');

    const [Err] = await WorkflowsRepo.Update(ID, Row);
    if (Err) return Fail('Failed to update workflow');

    const Updated = normalizeWorkflowRow({
      WorkflowID: ID,
      Slug: Existing.Slug,
      Timestamp: Existing.Timestamp,
      ...Row,
    });
    WorkflowList = WorkflowList.map((W) => (W.WorkflowID === ID ? Updated : W));
    BroadcastManager.emit('WorkflowListChanged');
    return Ok(Updated);
  },

  async Delete(WorkflowID: unknown): Promise<Result<boolean>> {
    if (!Initialized) await Manager.Init();
    const ID = Number(WorkflowID);

    // Refuse rather than leaving a dangling call step behind. Silently breaking
    // another workflow is worse than making the operator unpick it.
    const Callers = WorkflowList.filter(
      (W) => W.WorkflowID !== ID && CollectCalledWorkflowIDs(W.Steps).includes(ID)
    );
    if (Callers.length) {
      return Fail(`Used by ${Callers.map((W) => `"${W.Name}"`).join(', ')}`);
    }

    const [Err] = await WorkflowsRepo.Delete(ID);
    if (Err) return Fail('Failed to delete workflow');
    void RunsRepo.DeleteForWorkflow(ID);
    WorkflowList = WorkflowList.filter((W) => W.WorkflowID !== ID);
    BroadcastManager.emit('WorkflowListChanged');
    return Ok(true);
  },

  SetEnabled: (WorkflowID: unknown, Enabled: unknown): Promise<Result<WorkflowView>> =>
    Manager.Update(WorkflowID, { Enabled: !!Enabled }),

  // Re-stamp weights in steps of ten, appending anything the caller left out —
  // the same idiom TagManager.SetOrder uses.
  async SetOrder(OrderedIDs: unknown[]): Promise<Result<boolean>> {
    if (!Initialized) await Manager.Init();
    const Wanted = (Array.isArray(OrderedIDs) ? OrderedIDs : []).map((ID) => Number(ID));
    const Known = new Set(WorkflowList.map((W) => W.WorkflowID));
    const Ordered = Wanted.filter((ID) => Known.has(ID));
    for (const W of WorkflowList) if (!Ordered.includes(W.WorkflowID)) Ordered.push(W.WorkflowID);

    let Weight = 100;
    for (const ID of Ordered) {
      const [Err] = await WorkflowsRepo.UpdateWeight(ID, Weight);
      if (Err) return Fail('Failed to reorder workflows');
      const Found = WorkflowList.find((W) => W.WorkflowID === ID);
      if (Found) Found.Weight = Weight;
      Weight += 10;
    }
    WorkflowList.sort((A, B) => A.Weight - B.Weight || A.WorkflowID - B.WorkflowID);
    BroadcastManager.emit('WorkflowListChanged');
    return Ok(true);
  },

  async SetSlug(WorkflowID: unknown, Slug: unknown): Promise<Result<boolean>> {
    if (!Initialized) await Manager.Init();
    const ID = Number(WorkflowID);
    const Existing = WorkflowList.find((W) => W.WorkflowID === ID);
    if (!Existing) return Fail('Workflow not found');

    const [SlugErr, Resolved] = await SlugService.ResolveWorkflowSlugEdit(
      Slug,
      SlugService.WorkflowOwner(ID)
    );
    if (SlugErr || !Resolved) return Fail(SlugErr || 'Invalid slug');

    const [Err] = await WorkflowsRepo.UpdateSlug(ID, Resolved);
    if (Err) return Fail('Failed to update slug');
    Existing.Slug = Resolved;
    BroadcastManager.emit('WorkflowListChanged');
    return Ok(true);
  },

  // Give slugs to rows that arrived without one (an imported show file predating
  // this feature), mirroring the monitoring-target back-fill on boot.
  async BackfillSlugs(): Promise<number> {
    if (!Initialized) await Manager.Init();
    let Filled = 0;
    for (const Workflow of WorkflowList) {
      if (Workflow.Slug) continue;
      const Slug = await SlugService.GenerateUniqueWorkflowSlug(
        Workflow.Name,
        SlugService.WorkflowOwner(Workflow.WorkflowID)
      );
      const [Err] = await WorkflowsRepo.UpdateSlug(Workflow.WorkflowID, Slug);
      if (Err) continue;
      Workflow.Slug = Slug;
      Filled++;
    }
    if (Filled) BroadcastManager.emit('WorkflowListChanged');
    return Filled;
  },

  // --- Running ---------------------------------------------------------------

  async Run(
    WorkflowID: unknown,
    ContextInput: WorkflowContextInput = {},
    TriggerSource = 'manual',
    Mode: WorkflowRunMode = 'normal'
  ): Promise<Result<WorkflowRunView>> {
    if (!Initialized) await Manager.Init();
    const [Err, Workflow] = await Manager.Get(WorkflowID);
    if (Err || !Workflow) return Fail(Err || 'Workflow not found');
    if (!Workflow.Enabled) return Fail('Workflow is disabled');
    if (!Workflow.Steps.length) return Fail('Workflow has no steps');

    const ScopedID = ContextInput.ScopedID ? String(ContextInput.ScopedID) : null;
    const Context = ContextInput.Context || (await ResolveContext(ScopedID));

    const Run = await StartRun(
      {
        WorkflowID: Workflow.WorkflowID,
        WorkflowName: Workflow.Name,
        Steps: Workflow.Steps,
        Return: Workflow.Return,
        Mode,
        TriggerSource,
        ContextScopedID: ScopedID,
        Context,
        Depth: 0,
        Visited: new Set<number>(),
      },
      buildDeps()
    );
    return Ok(Run);
  },

  Abort: (RunKey: unknown): Result<boolean> =>
    AbortRun(String(RunKey)) ? Ok(true) : Fail('Run not found'),

  Step: (RunKey: unknown): Result<boolean> =>
    ResumeRun(String(RunKey), true) ? Ok(true) : Fail('Run is not paused'),

  Continue: (RunKey: unknown): Result<boolean> =>
    ResumeRun(String(RunKey), false) ? Ok(true) : Fail('Run is not paused'),

  AnswerPrompt: (RunKey: unknown, StepID: unknown, Value: unknown): Result<boolean> =>
    AnswerPrompt(String(RunKey), String(StepID), String(Value))
      ? Ok(true)
      : Fail('No prompt is waiting'),

  GetRun: (RunKey: unknown) => GetRun(String(RunKey)),
  GetActiveRuns,

  async GetHistory(WorkflowID: unknown, Limit = 25): Promise<Result<unknown[]>> {
    const [Err, Rows] = await RunsRepo.GetRecent(Number(WorkflowID), Math.min(200, Limit));
    if (Err) return Fail('Failed to read run history');
    return Ok(Rows || []);
  },

  // --- Event triggers --------------------------------------------------------

  // Called with the same context AlertsManager builds for its own rules.
  async HandleEvent(Context: Record<string, unknown>): Promise<void> {
    if (!Initialized) await Manager.Init();
    if (!WorkflowList.length) return;

    const Tags = await loadTagsIfNeeded();
    const ScopedID = String(Context.ScopedID || buildScopedID(Context) || '');
    const GroupID = (Context.GroupID as number | null) ?? null;

    for (const Workflow of WorkflowList) {
      if (!Workflow.Enabled || !Workflow.Triggers.Events.length) continue;
      if (!TriggerEventMatches(Workflow.Triggers, Context.TriggerType, Context)) continue;
      if (ScopedID && !(await coversEntity(Workflow, ScopedID, GroupID, Tags))) continue;

      // Fire-and-forget: one workflow's failure must not stop the next from
      // running, and the caller is an event handler that cannot wait.
      void Manager.Run(
        Workflow.WorkflowID,
        { ScopedID: ScopedID || null, Context },
        String(Context.TriggerType || 'event')
      ).then(([RunErr]) => {
        if (RunErr) Logger.error(`Workflow "${Workflow.Name}" failed to start: ${RunErr}`);
      });
    }
  },
};

// Rebuild the ScopedID an event context refers to, since AlertsManager contexts
// carry the parts rather than the composed id.
function buildScopedID(Context: Record<string, unknown>): string | null {
  if (Context.CheckID != null) return `check:${Context.CheckID}`;
  if (Context.EntityType === 'monitor' && Context.TargetID != null) {
    return `monitor:${Context.TargetID}`;
  }
  return Context.UUID ? String(Context.UUID) : null;
}

// Walk the call graph from a proposed step tree looking for a path back to
// StartID. Returns a message naming the offender, or null when the graph is
// acyclic.
function FindCallCycle(StartID: number, Steps: readonly WorkflowStep[]): string | null {
  const Seen = new Set<number>([StartID]);
  const Queue = CollectCalledWorkflowIDs(Steps);

  while (Queue.length) {
    const Next = Queue.shift() as number;
    if (Next === StartID) return 'A workflow cannot end up calling itself';
    if (Seen.has(Next)) continue;
    Seen.add(Next);
    const Child = WorkflowList.find((W) => W.WorkflowID === Next);
    if (Child) Queue.push(...CollectCalledWorkflowIDs(Child.Steps));
  }
  return null;
}

export { Manager };
