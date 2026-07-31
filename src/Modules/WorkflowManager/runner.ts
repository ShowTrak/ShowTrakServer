// The workflow executor.
//
// Steps run STRICTLY IN ORDER, unlike AlertsManager.executeRule which fires its
// actions concurrently through Promise.allSettled. That difference is the whole
// point: "power the projector on, wait 30s, then check whether it worked" is
// meaningless if the three happen at once.
//
// The walk keeps an explicit cursor rather than relying on the JS call stack, so
// the step debugger can say where a run is, and a paused run is just a run
// waiting on a gate.
//
// Every dependency that touches the outside world arrives through
// WorkflowRunnerDeps. The runner therefore imports no managers, which is what
// makes the sequencing, branching, abort and recursion behaviour testable
// against fakes instead of against real projectors.
import { EvaluateCondition } from './conditions';
import { CoerceReturnValue, type WorkflowReturn } from './serialization';
import { ResolvePath } from './conditions';
import type { WorkflowStep } from './steps';

export type WorkflowRunStatus = 'running' | 'paused' | 'completed' | 'failed' | 'aborted';
export type WorkflowStepStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';
export type WorkflowRunMode = 'normal' | 'step';

export interface WorkflowRunStepView {
  StepID: string;
  Kind: string;
  Label: string;
  // Nesting level, so the renderer can draw the tree without re-walking it.
  Depth: number;
  // Which branch of an enclosing If this step sits in.
  Branch: 'then' | 'else' | null;
  Status: WorkflowStepStatus;
  Detail?: string;
  Error?: string;
  DurationMs?: number;
}

export interface WorkflowPromptRequest {
  RunKey: string;
  StepID: string;
  Message: string;
  Buttons: Array<{ Value: string; Label: string; Style?: string }>;
  ExpiresAt: number;
}

export interface WorkflowRunView {
  RunKey: string;
  WorkflowID: number;
  WorkflowName: string;
  Mode: WorkflowRunMode;
  Status: WorkflowRunStatus;
  TriggerSource: string;
  ContextScopedID: string | null;
  CurrentStepID: string | null;
  Steps: WorkflowRunStepView[];
  Vars: Record<string, unknown>;
  ReturnValue: unknown;
  Prompt: WorkflowPromptRequest | null;
  StartedAt: number;
  FinishedAt: number | null;
  Error?: string;
}

export interface WorkflowActionOutcome {
  Success: boolean;
  Detail?: string;
  Error?: string;
  Data?: Record<string, unknown>;
}

export interface WorkflowCallOutcome {
  Success: boolean;
  Return: unknown;
  Error?: string;
}

export interface WorkflowRunnerDeps {
  // Perform one action step. The manager wires this to MonitoringMethods,
  // AlertActions or ControlService depending on the step's ActionKind.
  RunAction(
    Step: Extract<WorkflowStep, { Kind: 'action' }>,
    Run: WorkflowRunView,
    Context: Record<string, unknown>
  ): Promise<WorkflowActionOutcome>;
  // Run a nested workflow and return its Return value. Depth and Visited are
  // threaded so the callee can enforce the recursion guards.
  CallWorkflow(
    WorkflowID: number,
    Context: Record<string, unknown>,
    Depth: number,
    Visited: ReadonlySet<number>
  ): Promise<WorkflowCallOutcome>;
  // Push the run's current state to the renderer. Called on every transition —
  // this is what draws the live position indicator.
  Emit(Run: WorkflowRunView): void;
  // Record a settled run in WorkflowRuns.
  Persist(Run: WorkflowRunView): void;
  Now(): number;
  Sleep(Ms: number, Signal: { Aborted: boolean }): Promise<void>;
}

// Guards. These stop a footgun, not an attacker: extracting shared logic into
// sub-workflows is the entire purpose of the Return section, so a workflow
// eventually calling itself is a matter of when, not whether.
export const MAX_CALL_DEPTH = 8;
export const MAX_RUN_MS = 30 * 60 * 1000;

interface RunState {
  View: WorkflowRunView;
  Aborted: boolean;
  // Resolved to let a paused run take one step or resume freely.
  Gate: (() => void) | null;
  StepOnce: boolean;
  // Resolves a pending prompt.
  AnswerPrompt: ((Value: string) => void) | null;
  PromptTimer: ReturnType<typeof setTimeout> | null;
  Deadline: number;
  ByID: Map<string, WorkflowRunStepView>;
}

const Runs = new Map<string, RunState>();
let RunCounter = 0;

function stepLabel(Step: WorkflowStep): string {
  if (Step.Label) return Step.Label;
  switch (Step.Kind) {
    case 'action':
      return Step.ActionID || 'Action';
    case 'if':
      return 'If';
    case 'delay':
      return `Wait ${Math.round(Step.Ms / 100) / 10}s`;
    case 'prompt':
      return Step.Message;
    case 'call':
      return 'Run workflow';
    default:
      return 'Stop';
  }
}

// Pre-build the flat display list so the renderer has stable rows from the
// moment a run starts, rather than rows appearing as they execute.
function buildStepViews(
  Steps: readonly WorkflowStep[],
  Depth: number,
  Branch: 'then' | 'else' | null,
  Out: WorkflowRunStepView[]
): void {
  for (const Step of Steps) {
    Out.push({
      StepID: Step.StepID,
      Kind: Step.Kind,
      Label: stepLabel(Step),
      Depth,
      Branch,
      Status: 'pending',
    });
    if (Step.Kind === 'if') {
      buildStepViews(Step.Then, Depth + 1, 'then', Out);
      buildStepViews(Step.Else, Depth + 1, 'else', Out);
    }
  }
}

export function GetRun(RunKey: string): WorkflowRunView | null {
  const State = Runs.get(RunKey);
  return State ? State.View : null;
}

export function GetActiveRuns(): WorkflowRunView[] {
  return Array.from(Runs.values()).map((S) => S.View);
}

export function AbortRun(RunKey: string): boolean {
  const State = Runs.get(RunKey);
  if (!State) return false;
  State.Aborted = true;
  // Release anything the run is waiting on so it notices promptly.
  if (State.AnswerPrompt) State.AnswerPrompt(State.View.Prompt?.Buttons[0]?.Value || '');
  if (State.Gate) {
    const Release = State.Gate;
    State.Gate = null;
    Release();
  }
  return true;
}

// Resume a paused run: one step, or run on freely.
export function ResumeRun(RunKey: string, Once: boolean): boolean {
  const State = Runs.get(RunKey);
  if (!State || !State.Gate) return false;
  State.StepOnce = Once;
  const Release = State.Gate;
  State.Gate = null;
  Release();
  return true;
}

export function AnswerPrompt(RunKey: string, StepID: string, Value: string): boolean {
  const State = Runs.get(RunKey);
  if (!State || !State.AnswerPrompt) return false;
  if (State.View.Prompt && State.View.Prompt.StepID !== StepID) return false;
  const Resolve = State.AnswerPrompt;
  State.AnswerPrompt = null;
  if (State.PromptTimer) {
    clearTimeout(State.PromptTimer);
    State.PromptTimer = null;
  }
  Resolve(Value);
  return true;
}

export interface StartRunOptions {
  WorkflowID: number;
  WorkflowName: string;
  Steps: readonly WorkflowStep[];
  Return: WorkflowReturn;
  Mode: WorkflowRunMode;
  TriggerSource: string;
  ContextScopedID: string | null;
  // The entity context a condition can read: client.*, monitor.*, check.*.
  Context: Record<string, unknown>;
  Depth: number;
  Visited: ReadonlySet<number>;
}

export async function StartRun(
  Options: StartRunOptions,
  Deps: WorkflowRunnerDeps
): Promise<WorkflowRunView> {
  const Now = Deps.Now();
  const RunKey = `run-${++RunCounter}-${Now}`;

  const StepViews: WorkflowRunStepView[] = [];
  buildStepViews(Options.Steps, 0, null, StepViews);

  const View: WorkflowRunView = {
    RunKey,
    WorkflowID: Options.WorkflowID,
    WorkflowName: Options.WorkflowName,
    Mode: Options.Mode,
    Status: 'running',
    TriggerSource: Options.TriggerSource,
    ContextScopedID: Options.ContextScopedID,
    CurrentStepID: null,
    Steps: StepViews,
    Vars: {},
    ReturnValue: undefined,
    Prompt: null,
    StartedAt: Now,
    FinishedAt: null,
  };

  const State: RunState = {
    View,
    Aborted: false,
    Gate: null,
    StepOnce: Options.Mode === 'step',
    AnswerPrompt: null,
    PromptTimer: null,
    Deadline: Now + MAX_RUN_MS,
    ByID: new Map(StepViews.map((S) => [S.StepID, S])),
  };
  Runs.set(RunKey, State);

  // The context a condition reads: the entity, plus vars and step results that
  // accumulate as the run proceeds.
  const EvalContext: Record<string, unknown> = {
    ...Options.Context,
    vars: View.Vars,
    steps: {} as Record<string, unknown>,
  };

  const emit = () => Deps.Emit(View);
  emit();

  // Pause before a step when in step mode. Returns false if the run was aborted
  // while paused.
  const gate = async (): Promise<boolean> => {
    if (State.Aborted) return false;
    if (!State.StepOnce) return true;
    View.Status = 'paused';
    emit();
    await new Promise<void>((Resolve) => {
      State.Gate = Resolve;
    });
    if (State.Aborted) return false;
    View.Status = 'running';
    emit();
    return true;
  };

  const setStatus = (
    StepID: string,
    Status: WorkflowStepStatus,
    Extra: Partial<WorkflowRunStepView> = {}
  ) => {
    const Row = State.ByID.get(StepID);
    if (!Row) return;
    Row.Status = Status;
    Object.assign(Row, Extra);
  };

  // Mark a whole subtree skipped — the branch not taken, or everything after a
  // stop. A blank row would leave an operator wondering whether it is still
  // coming.
  const markSkipped = (Steps: readonly WorkflowStep[]) => {
    for (const Step of Steps) {
      const Row = State.ByID.get(Step.StepID);
      if (Row && Row.Status === 'pending') Row.Status = 'skipped';
      if (Step.Kind === 'if') {
        markSkipped(Step.Then);
        markSkipped(Step.Else);
      }
    }
  };

  // 'stop' unwinds the whole walk; 'halt' is a failure that ends the run.
  type Flow = 'continue' | 'stop' | 'halt';

  const runSteps = async (Steps: readonly WorkflowStep[]): Promise<Flow> => {
    for (const Step of Steps) {
      if (State.Aborted) return 'halt';
      if (Deps.Now() > State.Deadline) {
        View.Error = `Workflow exceeded ${Math.round(MAX_RUN_MS / 60000)} minutes`;
        return 'halt';
      }

      if (!Step.Enabled) {
        setStatus(Step.StepID, 'skipped');
        if (Step.Kind === 'if') {
          markSkipped(Step.Then);
          markSkipped(Step.Else);
        }
        emit();
        continue;
      }

      if (!(await gate())) return 'halt';

      View.CurrentStepID = Step.StepID;
      setStatus(Step.StepID, 'running');
      emit();
      const Started = Deps.Now();

      const finish = (Status: WorkflowStepStatus, Extra: Partial<WorkflowRunStepView> = {}) => {
        setStatus(Step.StepID, Status, { ...Extra, DurationMs: Deps.Now() - Started });
        emit();
      };

      if (Step.Kind === 'stop') {
        finish('ok', { Detail: Step.Reason || 'Stopped' });
        return 'stop';
      }

      if (Step.Kind === 'delay') {
        await Deps.Sleep(Step.Ms, State);
        if (State.Aborted) return 'halt';
        finish('ok');
        continue;
      }

      if (Step.Kind === 'if') {
        const Verdict = EvaluateCondition(Step.Condition, EvalContext);
        finish('ok', { Detail: Verdict.Reason });
        const Taken = Verdict.Matched ? Step.Then : Step.Else;
        const NotTaken = Verdict.Matched ? Step.Else : Step.Then;
        markSkipped(NotTaken);
        emit();
        const Result = await runSteps(Taken);
        if (Result !== 'continue') return Result;
        continue;
      }

      if (Step.Kind === 'prompt') {
        const ExpiresAt = Deps.Now() + Step.TimeoutMs;
        View.Prompt = {
          RunKey,
          StepID: Step.StepID,
          Message: Step.Message,
          Buttons: Step.Buttons,
          ExpiresAt,
        };
        emit();

        const Answer = await new Promise<string>((Resolve) => {
          State.AnswerPrompt = Resolve;
          // An unattended server has nobody to answer. Timing out to the
          // declared default is what stops a run wedging forever holding a
          // device lock.
          State.PromptTimer = setTimeout(() => {
            State.AnswerPrompt = null;
            State.PromptTimer = null;
            Resolve(Step.DefaultValue);
          }, Step.TimeoutMs);
        });

        View.Prompt = null;
        if (State.Aborted) return 'halt';
        View.Vars[Step.StoreAs] = Answer;
        const Chosen = Step.Buttons.find((B) => B.Value === Answer);
        finish('ok', { Detail: `Answered ${Chosen ? Chosen.Label : Answer}` });
        continue;
      }

      if (Step.Kind === 'call') {
        if (Options.Depth >= MAX_CALL_DEPTH) {
          finish('failed', { Error: `Workflows are nested more than ${MAX_CALL_DEPTH} deep` });
          if (!Step.ContinueOnError) return 'halt';
          continue;
        }
        if (Options.Visited.has(Step.WorkflowID)) {
          finish('failed', { Error: 'This workflow is already running further up the chain' });
          if (!Step.ContinueOnError) return 'halt';
          continue;
        }

        const Nested = new Set(Options.Visited);
        Nested.add(Options.WorkflowID);
        const Outcome = await Deps.CallWorkflow(
          Step.WorkflowID,
          EvalContext,
          Options.Depth + 1,
          Nested
        );
        if (Step.StoreAs) View.Vars[Step.StoreAs] = Outcome.Return;
        (EvalContext.steps as Record<string, unknown>)[Step.StepID] = {
          Success: Outcome.Success,
          Return: Outcome.Return,
        };
        if (Outcome.Success) {
          finish('ok', { Detail: `Returned ${JSON.stringify(Outcome.Return)}` });
          continue;
        }
        finish('failed', { Error: Outcome.Error || 'Nested workflow failed' });
        if (!Step.ContinueOnError) return 'halt';
        continue;
      }

      // Kind === 'action'
      const Outcome = await Deps.RunAction(Step, View, EvalContext);
      (EvalContext.steps as Record<string, unknown>)[Step.StepID] = {
        Success: Outcome.Success,
        Detail: Outcome.Detail,
        Error: Outcome.Error,
        ...(Outcome.Data || {}),
      };
      if (Step.StoreAs) {
        View.Vars[Step.StoreAs] = Outcome.Success;
      }
      if (Outcome.Success) {
        finish('ok', { Detail: Outcome.Detail });
        continue;
      }
      finish('failed', { Error: Outcome.Error || 'Step failed' });
      if (!Step.ContinueOnError) return 'halt';
    }
    return 'continue';
  };

  let Flow: Flow = 'continue';
  try {
    Flow = await runSteps(Options.Steps);
  } catch (Err) {
    View.Error = Err && (Err as Error).message ? (Err as Error).message : String(Err);
    Flow = 'halt';
  }

  // Anything never reached reads as skipped rather than sitting pending forever.
  markSkipped(Options.Steps);

  View.CurrentStepID = null;
  View.Prompt = null;
  View.FinishedAt = Deps.Now();
  if (State.PromptTimer) clearTimeout(State.PromptTimer);

  if (State.Aborted) View.Status = 'aborted';
  else if (Flow === 'halt') View.Status = 'failed';
  else View.Status = 'completed';

  // Resolve the Return. A run that aborted, stopped early or whose path never
  // set the value still returns the declared fallback, so a caller never has to
  // handle "no value".
  const Resolved =
    View.Status === 'completed' && Options.Return.From
      ? ResolvePath(EvalContext, Options.Return.From)
      : undefined;
  View.ReturnValue = CoerceReturnValue(
    Resolved === undefined || Resolved === null ? Options.Return.Fallback : Resolved,
    Options.Return.Type
  );

  emit();
  Deps.Persist(View);
  Runs.delete(RunKey);
  return View;
}

// Abort everything in flight. Used when the show file is reloaded out from under
// running workflows — a run holding a reference to a workflow that no longer
// exists is a live hazard, not something to let finish.
export function AbortAllRuns(): number {
  const Keys = Array.from(Runs.keys());
  for (const Key of Keys) AbortRun(Key);
  return Keys.length;
}
