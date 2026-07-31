// Workflow IPC validators.
//
// WHERE THE SECURITY BOUNDARY SITS — read this before adding a check.
//
// These validators own SHAPE, SIZE and DEPTH. They deliberately cannot resolve
// an ActionID against the monitoring registry, because importing
// ../MonitoringMethods would drag in the Logger and CacheManager and break the
// isolation that lets validators load on their own under test.
//
// The registry is the allowlist instead: MonitoringMethods.RunAction refuses any
// unknown method or action outright, and MonitoringTargetManager.RunCheckAction
// is a second gate. That is a different arrangement from the FreeKiosk
// validators, which DO resolve their command against the registry — so do not
// assume the pattern here matches that one and add a hole trying to make it.
import { fail, isPlainObject } from './primitives';
import type { IPCValidationManager } from './index';

// A scoped entity identifier as produced by the scope picker: a UUID, or a
// prefixed form like "monitor:12" / "check:3".
const SCOPED_ID_PATTERN = /^[A-Za-z0-9_:-]{1,128}$/;

// Kept in step with WorkflowManager/steps.ts. Duplicated rather than imported so
// the validators stay free of any transitive manager import.
const STEP_KINDS = ['action', 'if', 'delay', 'prompt', 'call', 'stop'];
const ACTION_KINDS = ['method', 'alert', 'core'];
const OPERATORS = ['is', 'isNot', 'above', 'below', 'inside', 'outside', 'contains', 'notContains'];
const RETURN_TYPES = ['string', 'number', 'boolean'];
const RUN_MODES = ['normal', 'step'];

// Bounds, each with a reason.
//
// MAX_STEPS caps run time and the size of a WorkflowRuns history row.
// MAX_DEPTH is load-bearing: the walk below RECURSES, so an over-deep tree would
// overflow the stack inside the validator itself. The depth check therefore has
// to happen during the walk, not after it.
const MAX_STEPS = 200;
const MAX_DEPTH = 6;
const MAX_PARAM_KEYS = 48;
const MAX_STRING = 2048;

function boundedString(value: unknown, fieldName: string, max = MAX_STRING): string {
  const s = value == null ? '' : String(value);
  if (s.length > max) fail(`${fieldName} is too long (max ${max} characters)`);
  return s;
}

export = function registerWorkflowValidators(Manager: IPCValidationManager): void {
  Manager.WorkflowID = (value: unknown, fieldName = 'WorkflowID') => {
    if (typeof value === 'number') {
      if (!Number.isInteger(value) || value <= 0) fail(`${fieldName} must be a positive integer`);
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim();
      if (!/^\d+$/.test(normalized)) fail(`${fieldName} must be numeric`);
      return parseInt(normalized, 10);
    }
    fail(`${fieldName} is invalid`);
    return 0;
  };

  Manager.WorkflowScopedID = (value: unknown, fieldName = 'ScopedID') => {
    const s = typeof value === 'string' ? value.trim() : '';
    if (!s || !SCOPED_ID_PATTERN.test(s)) fail(`${fieldName} is invalid`);
    return s;
  };

  Manager.WorkflowRunKey = (value: unknown, fieldName = 'RunKey') => {
    const s = typeof value === 'string' ? value.trim() : '';
    if (!s || s.length > 128) fail(`${fieldName} is invalid`);
    return s;
  };

  Manager.WorkflowRunMode = (value: unknown, fieldName = 'Mode') => {
    const s = typeof value === 'string' ? value.trim() : 'normal';
    if (!RUN_MODES.includes(s)) fail(`${fieldName} must be one of: ${RUN_MODES.join(', ')}`);
    return s;
  };

  Manager.WorkflowParams = (value: unknown) => {
    if (value === undefined || value === null) return {};
    if (!isPlainObject(value)) fail('Params must be an object');
    const Keys = Object.keys(value);
    if (Keys.length > MAX_PARAM_KEYS) fail(`Too many parameters (max ${MAX_PARAM_KEYS})`);
    const Out: Record<string, unknown> = {};
    for (const Key of Keys) {
      const Raw = (value as Record<string, unknown>)[Key];
      // Params are coerced against the action's own schema downstream; only the
      // envelope is policed here.
      if (typeof Raw === 'string') boundedString(Raw, `Params.${Key}`);
      Out[Key] = Raw;
    }
    return Out;
  };

  Manager.WorkflowScope = (value: unknown) => {
    if (!isPlainObject(value)) fail('Workflow scope must be an object');
    const Groups: number[] = [];
    if (Array.isArray(value.Groups)) {
      for (const g of value.Groups) {
        const id = Manager.GroupID(g, 'Workflow scope group ID');
        if (id != null) Groups.push(id);
      }
    }
    const Clients: string[] = [];
    if (Array.isArray(value.Clients)) {
      for (const c of value.Clients) {
        const s = typeof c === 'string' ? c.trim() : '';
        if (!s) continue;
        if (!SCOPED_ID_PATTERN.test(s)) fail('Workflow scope client ID is invalid');
        Clients.push(s);
      }
    }
    const Tags: number[] = [];
    if (Array.isArray(value.Tags)) {
      for (const t of value.Tags) {
        const id = Manager.TagID(t, 'Workflow scope tag ID');
        if (id != null) Tags.push(id);
      }
    }
    return {
      Workspace: !!value.Workspace,
      Groups: Array.from(new Set(Groups)),
      Clients: Array.from(new Set(Clients)),
      Tags: Array.from(new Set(Tags)),
    };
  };

  Manager.WorkflowTriggers = (value: unknown) => {
    if (!isPlainObject(value)) fail('Triggers must be an object');
    const Events: string[] = [];
    if (Array.isArray(value.Events)) {
      for (const e of value.Events) {
        const s = typeof e === 'string' ? e.trim() : '';
        // The event vocabulary is validated by the manager against the shared
        // trigger catalogue; here it only has to look like an identifier.
        if (!s || !/^[A-Z0-9_]{1,64}$/.test(s)) fail('Trigger event is invalid');
        Events.push(s);
      }
    }
    return {
      Manual: value.Manual === undefined ? true : !!value.Manual,
      Callable: value.Callable === undefined ? true : !!value.Callable,
      Events: Array.from(new Set(Events)),
      EventConfig: isPlainObject(value.EventConfig) ? value.EventConfig : {},
      Scope: Manager.WorkflowScope(value.Scope === undefined ? {} : value.Scope),
    };
  };

  Manager.WorkflowReturn = (value: unknown) => {
    if (value === undefined || value === null) return {};
    if (!isPlainObject(value)) fail('Return must be an object');
    const Type = typeof value.Type === 'string' ? value.Type.trim() : 'boolean';
    if (!RETURN_TYPES.includes(Type)) {
      fail(`Return type must be one of: ${RETURN_TYPES.join(', ')}`);
    }
    return {
      Name: boundedString(value.Name, 'Return name', 128),
      Type,
      From: boundedString(value.From, 'Return source', 256),
      Fallback: value.Fallback,
    };
  };

  Manager.WorkflowSteps = (value: unknown) => {
    let Count = 0;

    const walk = (raw: unknown, depth: number, where: string): Record<string, unknown>[] => {
      if (raw === undefined || raw === null) return [];
      if (!Array.isArray(raw)) fail(`${where} must be a list of steps`);
      if (depth > MAX_DEPTH) fail(`Steps are nested more than ${MAX_DEPTH} levels deep`);

      const Out: Record<string, unknown>[] = [];
      for (const item of raw as unknown[]) {
        if (!isPlainObject(item)) fail(`${where} contains something that is not a step`);
        Count++;
        if (Count > MAX_STEPS) fail(`A workflow may have at most ${MAX_STEPS} steps`);

        const Kind = typeof item.Kind === 'string' ? item.Kind.trim() : '';
        if (!STEP_KINDS.includes(Kind)) fail(`Unknown step type "${Kind}"`);

        const Step: Record<string, unknown> = {
          StepID: boundedString(item.StepID, 'StepID', 64),
          Kind,
          Label: boundedString(item.Label, 'Step label', 200),
          Enabled: item.Enabled === undefined ? true : !!item.Enabled,
          ContinueOnError: !!item.ContinueOnError,
        };

        if (Kind === 'action') {
          const ActionKind = typeof item.ActionKind === 'string' ? item.ActionKind.trim() : '';
          if (!ACTION_KINDS.includes(ActionKind)) fail('Unknown action type');
          const ActionID = boundedString(item.ActionID, 'ActionID', 128).trim();
          if (!ActionID) fail('An action step needs an action');
          Step.ActionKind = ActionKind;
          Step.ActionID = ActionID;
          Step.Params = Manager.WorkflowParams(item.Params);
          Step.StoreAs = boundedString(item.StoreAs, 'StoreAs', 64);
          Step.Target = isPlainObject(item.Target)
            ? {
                Mode: item.Target.Mode === 'scoped' ? 'scoped' : 'context',
                ScopedID:
                  item.Target.Mode === 'scoped'
                    ? Manager.WorkflowScopedID(item.Target.ScopedID, 'Step target')
                    : undefined,
              }
            : { Mode: 'context' };
        } else if (Kind === 'if') {
          if (!isPlainObject(item.Condition)) fail('An If step needs a condition');
          const Operator =
            typeof item.Condition.Operator === 'string' ? item.Condition.Operator.trim() : '';
          if (!OPERATORS.includes(Operator)) fail(`Unknown condition operator "${Operator}"`);
          Step.Condition = {
            Left: boundedString(item.Condition.Left, 'Condition value', 256),
            Operator,
            Right: item.Condition.Right,
            Right2: item.Condition.Right2,
          };
          Step.Then = walk(item.Then, depth + 1, 'Then');
          Step.Else = walk(item.Else, depth + 1, 'Else');
        } else if (Kind === 'delay') {
          const Ms = Number(item.Ms);
          if (!Number.isFinite(Ms) || Ms < 0) fail('A Wait step needs a duration');
          Step.Ms = Ms;
        } else if (Kind === 'prompt') {
          Step.Message = boundedString(item.Message, 'Prompt message', 500);
          Step.Buttons = Array.isArray(item.Buttons)
            ? (item.Buttons as unknown[]).slice(0, 4).map((b) => {
                if (!isPlainObject(b)) fail('A prompt answer is invalid');
                return {
                  Value: boundedString((b as Record<string, unknown>).Value, 'Answer value', 64),
                  Label: boundedString((b as Record<string, unknown>).Label, 'Answer label', 64),
                  Style: boundedString((b as Record<string, unknown>).Style, 'Answer style', 32),
                };
              })
            : [];
          Step.TimeoutMs = Number(item.TimeoutMs);
          Step.DefaultValue = boundedString(item.DefaultValue, 'Default answer', 64);
          Step.StoreAs = boundedString(item.StoreAs, 'StoreAs', 64);
        } else if (Kind === 'call') {
          Step.WorkflowID = Manager.WorkflowID(item.WorkflowID, 'Called workflow');
          Step.StoreAs = boundedString(item.StoreAs, 'StoreAs', 64);
        } else {
          Step.Reason = boundedString(item.Reason, 'Stop reason', 200);
        }

        Out.push(Step);
      }
      return Out;
    };

    return walk(value, 1, 'Steps');
  };

  Manager.WorkflowCreatePayload = (value: unknown) => {
    if (!isPlainObject(value)) fail('Workflow payload must be an object');
    const Name = boundedString(value.Name, 'Name', 120).trim();
    if (!Name) fail('A workflow needs a name');
    return {
      Name,
      Description: boundedString(value.Description, 'Description', 1000),
      Icon: boundedString(value.Icon, 'Icon', 64),
      Colour: value.Colour === undefined ? 6 : Manager.TagColour(value.Colour, 'Colour'),
      Triggers: Manager.WorkflowTriggers(value.Triggers === undefined ? {} : value.Triggers),
      Steps: Manager.WorkflowSteps(value.Steps),
      Return: Manager.WorkflowReturn(value.Return),
      Enabled: value.Enabled === undefined ? true : !!value.Enabled,
    };
  };

  // Patch semantics: only the keys actually present are validated and returned,
  // so a partial edit cannot blank the sections it did not touch.
  Manager.WorkflowUpdatePayload = (value: unknown) => {
    if (!isPlainObject(value)) fail('Workflow payload must be an object');
    const Out: Record<string, unknown> = {};
    const has = (Key: string) => Object.prototype.hasOwnProperty.call(value, Key);

    if (has('Name')) {
      const Name = boundedString(value.Name, 'Name', 120).trim();
      if (!Name) fail('A workflow needs a name');
      Out.Name = Name;
    }
    if (has('Description')) Out.Description = boundedString(value.Description, 'Description', 1000);
    if (has('Icon')) Out.Icon = boundedString(value.Icon, 'Icon', 64);
    if (has('Colour')) Out.Colour = Manager.TagColour(value.Colour, 'Colour');
    if (has('Triggers')) Out.Triggers = Manager.WorkflowTriggers(value.Triggers);
    if (has('Steps')) Out.Steps = Manager.WorkflowSteps(value.Steps);
    if (has('Return')) Out.Return = Manager.WorkflowReturn(value.Return);
    if (has('Enabled')) Out.Enabled = !!value.Enabled;
    return Out;
  };

  Manager.WorkflowOrderList = (value: unknown, fieldName = 'WorkflowIDs') => {
    if (!Array.isArray(value)) fail(`${fieldName} must be an array`);
    return (value as unknown[]).map((ID) => Manager.WorkflowID(ID, 'Workflow ID'));
  };

  Manager.WorkflowPromptAnswer = (value: unknown) => {
    if (!isPlainObject(value)) fail('Prompt answer must be an object');
    return {
      RunKey: Manager.WorkflowRunKey(value.RunKey),
      StepID: boundedString(value.StepID, 'StepID', 64).trim(),
      Value: boundedString(value.Value, 'Answer', 64).trim(),
    };
  };

  Manager.MonitoringCheckActionID = (value: unknown, fieldName = 'ActionID') => {
    const s = typeof value === 'string' ? value.trim() : '';
    if (!s || s.length > 128) fail(`${fieldName} is invalid`);
    return s;
  };
};
