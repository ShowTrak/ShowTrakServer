// The Workflow step model: kinds, limits, and normalisation of a step tree.
//
// Pure and I/O-free, and it must stay that way. The IPC validators import this
// to check a submitted tree, and validators are deliberately barred from
// importing managers, the DB or the Logger — pulling any of those in here would
// break that isolation and take the validator's unit tests with it.
import crypto from 'crypto';

export type WorkflowStepKind = 'action' | 'if' | 'delay' | 'prompt' | 'call' | 'stop';

// Where an action step's implementation comes from:
//   method — a control action declared by a monitoring method (PJLink power on)
//   alert  — an existing AlertActions transport (Slack, OSC, sound)
//   core   — a ShowTrak verb (wake, run script, trigger event)
export type WorkflowActionKind = 'method' | 'alert' | 'core';

// Which entity a step acts on. 'context' is the default and is what makes a
// workflow reusable: the same "Projector Recovery" runs against whichever
// projector triggered it, rather than being wired to one.
export interface WorkflowStepTarget {
  Mode: 'context' | 'scoped';
  // For Mode 'scoped': a UUID, monitor:<TargetID> or check:<CheckID>.
  ScopedID?: string;
}

export interface WorkflowCondition {
  // Dotted path into the run context, e.g. check.Online, vars.answer,
  // steps.<StepID>.Success.
  Left: string;
  Operator: WorkflowOperator;
  Right?: unknown;
  Right2?: unknown;
}

// Deliberately the same vocabulary as the FreeKiosk metric alarms
// (FreeKiosk/metrics.ts). Two condition editors in one product that use
// different words for the same comparison is a needless thing to make an
// operator learn twice.
export const WORKFLOW_OPERATORS = [
  'is',
  'isNot',
  'above',
  'below',
  'inside',
  'outside',
  'contains',
  'notContains',
] as const;

export type WorkflowOperator = (typeof WORKFLOW_OPERATORS)[number];

// Operators taking a second bound.
export const RANGE_OPERATORS: readonly WorkflowOperator[] = ['inside', 'outside'];

export interface WorkflowStepBase {
  // Stable id minted on create. The debugger addresses steps by it and
  // conditions reference step results through it, so it must survive reordering
  // and editing — an array index would not.
  StepID: string;
  Kind: WorkflowStepKind;
  Label?: string;
  Enabled: boolean;
  // Carry on to the next step when this one fails. Off by default: a recovery
  // sequence that keeps going after its first failed command is usually doing
  // something worse than stopping.
  ContinueOnError: boolean;
}

export interface WorkflowActionStep extends WorkflowStepBase {
  Kind: 'action';
  ActionKind: WorkflowActionKind;
  // For 'method' actions this is "<MethodID>/<ActionID>"; for the others it is
  // the action's own id.
  ActionID: string;
  Target: WorkflowStepTarget;
  Params: Record<string, unknown>;
  // Bind this step's result into vars.<StoreAs> for later conditions.
  StoreAs?: string;
}

export interface WorkflowIfStep extends WorkflowStepBase {
  Kind: 'if';
  Condition: WorkflowCondition;
  Then: WorkflowStep[];
  Else: WorkflowStep[];
}

export interface WorkflowDelayStep extends WorkflowStepBase {
  Kind: 'delay';
  Ms: number;
}

export interface WorkflowPromptStep extends WorkflowStepBase {
  Kind: 'prompt';
  Message: string;
  Buttons: Array<{ Value: string; Label: string; Style?: string }>;
  // Required, not optional. An unattended server with no one to answer must not
  // leave a run wedged forever holding a device lock.
  TimeoutMs: number;
  DefaultValue: string;
  StoreAs: string;
}

export interface WorkflowCallStep extends WorkflowStepBase {
  Kind: 'call';
  WorkflowID: number;
  StoreAs?: string;
}

export interface WorkflowStopStep extends WorkflowStepBase {
  Kind: 'stop';
  Reason?: string;
}

export type WorkflowStep =
  | WorkflowActionStep
  | WorkflowIfStep
  | WorkflowDelayStep
  | WorkflowPromptStep
  | WorkflowCallStep
  | WorkflowStopStep;

// Bounds. Each exists for a stated reason, not as arbitrary paranoia.
//
// MAX_STEPS caps run time and the size of a WorkflowRuns history row.
// MAX_DEPTH is load-bearing: normalisation and validation both recurse through
// Then/Else, so a deeply nested tree would overflow the stack inside the
// validator itself. The depth check therefore has to happen DURING the walk.
export const MAX_STEPS = 200;
export const MAX_DEPTH = 6;
export const MAX_DELAY_MS = 3_600_000;
export const MIN_PROMPT_TIMEOUT_MS = 1_000;
export const MAX_PROMPT_TIMEOUT_MS = 600_000;

export interface WorkflowStepKindDescriptor {
  Kind: WorkflowStepKind;
  Label: string;
  Icon: string;
  Description: string;
}

// The palette the step editor renders. Order is the order they are offered in.
export const WORKFLOW_STEP_KINDS: readonly WorkflowStepKindDescriptor[] = Object.freeze([
  {
    Kind: 'action',
    Label: 'Do something',
    Icon: 'lightning-charge',
    Description:
      'Send a device command, run an alert action, or use a ShowTrak verb like Wake On LAN.',
  },
  {
    Kind: 'if',
    Label: 'If / Else',
    Icon: 'signpost-split',
    Description: 'Branch on a check reading, a stored value, or an earlier step’s result.',
  },
  {
    Kind: 'delay',
    Label: 'Wait',
    Icon: 'hourglass-split',
    Description: 'Pause before the next step — for example while a projector warms up.',
  },
  {
    Kind: 'prompt',
    Label: 'Ask the user',
    Icon: 'question-circle',
    Description: 'Ask an operator a question and branch on the answer. Times out to a default.',
  },
  {
    Kind: 'call',
    Label: 'Run another workflow',
    Icon: 'diagram-3',
    Description: 'Run a workflow and keep its Return value.',
  },
  {
    Kind: 'stop',
    Label: 'Stop',
    Icon: 'stop-circle',
    Description: 'End the run here. The Return falls back to its default.',
  },
]);

export function MintStepID(): string {
  return crypto.randomUUID();
}

function asString(Value: unknown, Fallback = ''): string {
  return Value == null ? Fallback : String(Value);
}

function asBool(Value: unknown, Fallback: boolean): boolean {
  return Value === undefined || Value === null ? Fallback : !!Value;
}

function clampInt(Value: unknown, Min: number, Max: number, Fallback: number): number {
  const N = Number(Value);
  if (!Number.isFinite(N)) return Fallback;
  return Math.max(Min, Math.min(Max, N | 0));
}

function normalizeTarget(Input: unknown): WorkflowStepTarget {
  const Raw = Input && typeof Input === 'object' ? (Input as Record<string, unknown>) : {};
  const ScopedID = asString(Raw.ScopedID).trim();
  // An explicit target with no id is meaningless; fall back to the context so a
  // half-filled editor state cannot produce a step that targets nothing.
  if (Raw.Mode === 'scoped' && ScopedID) return { Mode: 'scoped', ScopedID };
  return { Mode: 'context' };
}

function normalizeCondition(Input: unknown): WorkflowCondition {
  const Raw = Input && typeof Input === 'object' ? (Input as Record<string, unknown>) : {};
  const Operator = WORKFLOW_OPERATORS.includes(Raw.Operator as WorkflowOperator)
    ? (Raw.Operator as WorkflowOperator)
    : 'is';
  return {
    Left: asString(Raw.Left).trim(),
    Operator,
    Right: Raw.Right,
    Right2: Raw.Right2,
  };
}

function normalizeButtons(Input: unknown): WorkflowPromptStep['Buttons'] {
  const Raw = Array.isArray(Input) ? Input : [];
  const Out: WorkflowPromptStep['Buttons'] = [];
  const Seen = new Set<string>();
  for (const Item of Raw) {
    const Obj = Item && typeof Item === 'object' ? (Item as Record<string, unknown>) : {};
    const Value = asString(Obj.Value).trim();
    if (!Value || Seen.has(Value)) continue;
    Seen.add(Value);
    Out.push({
      Value,
      Label: asString(Obj.Label).trim() || Value,
      Style: asString(Obj.Style).trim() || 'secondary',
    });
    if (Out.length >= 4) break;
  }
  // A prompt with no buttons could never be answered, so give it the obvious
  // pair rather than producing an unanswerable step.
  if (!Out.length) {
    return [
      { Value: 'yes', Label: 'Yes', Style: 'primary' },
      { Value: 'no', Label: 'No', Style: 'secondary' },
    ];
  }
  return Out;
}

export interface NormalizeStepsResult {
  Steps: WorkflowStep[];
  // Total steps kept, counting nested ones.
  Count: number;
  // Reasons steps were dropped, for the caller to surface. Silent truncation
  // would read as "saved fine" when part of the program went missing.
  Dropped: string[];
}

// Coerce an arbitrary submitted tree into well-formed steps, dropping anything
// unusable rather than throwing. Enforces MAX_STEPS and MAX_DEPTH during the
// walk.
export function NormalizeSteps(Input: unknown): NormalizeStepsResult {
  const Dropped: string[] = [];
  let Count = 0;

  const walk = (Raw: unknown, Depth: number): WorkflowStep[] => {
    if (!Array.isArray(Raw)) return [];
    if (Depth > MAX_DEPTH) {
      Dropped.push(`Nesting deeper than ${MAX_DEPTH} levels was removed`);
      return [];
    }

    const Out: WorkflowStep[] = [];
    for (const Item of Raw) {
      if (Count >= MAX_STEPS) {
        Dropped.push(`Only the first ${MAX_STEPS} steps were kept`);
        break;
      }
      const Obj = Item && typeof Item === 'object' ? (Item as Record<string, unknown>) : null;
      if (!Obj) continue;

      const Kind = asString(Obj.Kind) as WorkflowStepKind;
      if (!WORKFLOW_STEP_KINDS.some((K) => K.Kind === Kind)) {
        Dropped.push(`Unknown step type "${Kind}" was removed`);
        continue;
      }

      const Base: WorkflowStepBase = {
        StepID: asString(Obj.StepID).trim() || MintStepID(),
        Kind,
        Label: asString(Obj.Label).trim() || undefined,
        Enabled: asBool(Obj.Enabled, true),
        ContinueOnError: asBool(Obj.ContinueOnError, false),
      };
      Count++;

      if (Kind === 'action') {
        const ActionKind = (['method', 'alert', 'core'] as const).includes(
          Obj.ActionKind as WorkflowActionKind
        )
          ? (Obj.ActionKind as WorkflowActionKind)
          : 'method';
        Out.push({
          ...Base,
          Kind: 'action',
          ActionKind,
          ActionID: asString(Obj.ActionID).trim(),
          Target: normalizeTarget(Obj.Target),
          Params:
            Obj.Params && typeof Obj.Params === 'object'
              ? (Obj.Params as Record<string, unknown>)
              : {},
          StoreAs: asString(Obj.StoreAs).trim() || undefined,
        });
        continue;
      }

      if (Kind === 'if') {
        Out.push({
          ...Base,
          Kind: 'if',
          Condition: normalizeCondition(Obj.Condition),
          Then: walk(Obj.Then, Depth + 1),
          Else: walk(Obj.Else, Depth + 1),
        });
        continue;
      }

      if (Kind === 'delay') {
        Out.push({ ...Base, Kind: 'delay', Ms: clampInt(Obj.Ms, 0, MAX_DELAY_MS, 1000) });
        continue;
      }

      if (Kind === 'prompt') {
        const Buttons = normalizeButtons(Obj.Buttons);
        const Default = asString(Obj.DefaultValue).trim();
        Out.push({
          ...Base,
          Kind: 'prompt',
          Message: asString(Obj.Message).trim() || 'Continue?',
          Buttons,
          TimeoutMs: clampInt(Obj.TimeoutMs, MIN_PROMPT_TIMEOUT_MS, MAX_PROMPT_TIMEOUT_MS, 60_000),
          // The default must be one of the buttons, or a timeout would store a
          // value no branch tests for.
          DefaultValue: Buttons.some((B) => B.Value === Default)
            ? Default
            : Buttons[Buttons.length - 1]!.Value,
          StoreAs: asString(Obj.StoreAs).trim() || 'answer',
        });
        continue;
      }

      if (Kind === 'call') {
        Out.push({
          ...Base,
          Kind: 'call',
          WorkflowID: clampInt(Obj.WorkflowID, 0, Number.MAX_SAFE_INTEGER, 0),
          StoreAs: asString(Obj.StoreAs).trim() || undefined,
        });
        continue;
      }

      Out.push({ ...Base, Kind: 'stop', Reason: asString(Obj.Reason).trim() || undefined });
    }
    return Out;
  };

  const Steps = walk(Input, 1);
  return { Steps, Count, Dropped: Array.from(new Set(Dropped)) };
}

// Walk every step in a tree, including nested ones. Used to find call targets
// (cycle detection) and to resolve a StepID to its step.
export function ForEachStep(
  Steps: readonly WorkflowStep[],
  Visit: (Step: WorkflowStep) => void
): void {
  for (const Step of Steps) {
    Visit(Step);
    if (Step.Kind === 'if') {
      ForEachStep(Step.Then, Visit);
      ForEachStep(Step.Else, Visit);
    }
  }
}

// Every workflow this tree calls directly.
export function CollectCalledWorkflowIDs(Steps: readonly WorkflowStep[]): number[] {
  const IDs = new Set<number>();
  ForEachStep(Steps, (Step) => {
    if (Step.Kind === 'call' && Step.WorkflowID > 0) IDs.add(Step.WorkflowID);
  });
  return Array.from(IDs);
}
