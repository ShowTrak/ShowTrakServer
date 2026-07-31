// The workflow engine: step normalisation, condition evaluation, and the runner.
//
// The runner takes every outside-world dependency through WorkflowRunnerDeps,
// so all of this runs against fakes — no projectors, no database, no clock.
//
// What matters most here:
//  - Steps run in ORDER. AlertsManager fires its actions concurrently through
//    Promise.allSettled; a workflow that did the same could not express "power
//    on, wait, then check whether it worked", which is the entire point.
//  - A condition on a value with no reading NEVER matches. A recovery branch
//    that fires because a check has not reported yet is worse than one that
//    does nothing.
//  - A run always produces its declared Return, even when it aborts, so a
//    calling workflow never has to handle "no value".
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MODULE = path.join(__dirname, '..', 'dist', 'Modules', 'WorkflowManager');
const Steps = require(path.join(MODULE, 'steps.js'));
const Conditions = require(path.join(MODULE, 'conditions.js'));
const Runner = require(path.join(MODULE, 'runner.js'));
const Serialization = require(path.join(MODULE, 'serialization.js'));

// --- Step normalisation ------------------------------------------------------

test('NormalizeSteps mints stable IDs and fills defaults', () => {
  const { Steps: Out } = Steps.NormalizeSteps([
    { Kind: 'delay', Ms: 500 },
    { Kind: 'action', ActionID: 'pjlink/power.on' },
  ]);

  assert.equal(Out.length, 2);
  for (const Step of Out) {
    assert.ok(Step.StepID, 'every step needs an ID the debugger can address');
    assert.equal(Step.Enabled, true);
    // Off by default: a recovery sequence that carries on after its first failed
    // command is usually doing something worse than stopping.
    assert.equal(Step.ContinueOnError, false);
  }
  assert.equal(Out[1].Target.Mode, 'context', 'steps default to the run context');
});

test('NormalizeSteps preserves existing StepIDs across an edit', () => {
  // The debugger addresses steps by ID and conditions reference step results
  // through them, so a re-save must not renumber the program.
  const { Steps: First } = Steps.NormalizeSteps([{ Kind: 'delay', Ms: 100 }]);
  const ID = First[0].StepID;
  const { Steps: Second } = Steps.NormalizeSteps([{ ...First[0], Ms: 200 }]);
  assert.equal(Second[0].StepID, ID);
});

test('NormalizeSteps enforces nesting depth and reports what it dropped', () => {
  // Silent truncation would read as "saved fine" when part of the program went
  // missing, so the caller gets told.
  let Deep = [{ Kind: 'delay', Ms: 1 }];
  for (let i = 0; i < Steps.MAX_DEPTH + 3; i++) {
    Deep = [{ Kind: 'if', Condition: { Left: 'a', Operator: 'is' }, Then: Deep, Else: [] }];
  }
  const Result = Steps.NormalizeSteps(Deep);
  assert.ok(Result.Dropped.length, 'over-deep nesting must be reported, not silently cut');
  assert.match(Result.Dropped.join(' '), /Nesting/);
});

test('NormalizeSteps caps total steps including nested ones', () => {
  const Many = Array.from({ length: Steps.MAX_STEPS + 25 }, () => ({ Kind: 'delay', Ms: 1 }));
  const Result = Steps.NormalizeSteps(Many);
  assert.equal(Result.Count, Steps.MAX_STEPS);
  assert.match(Result.Dropped.join(' '), /first 200 steps/);
});

test('a prompt always ends up answerable', () => {
  // A prompt with no buttons could never be answered, and a default that is not
  // one of the buttons would store a value no branch tests for.
  const { Steps: Out } = Steps.NormalizeSteps([
    { Kind: 'prompt', Message: 'Go?', Buttons: [], DefaultValue: 'nonsense' },
  ]);
  const Prompt = Out[0];
  assert.ok(Prompt.Buttons.length >= 2);
  assert.ok(
    Prompt.Buttons.some((B) => B.Value === Prompt.DefaultValue),
    'the timeout default must be one of the offered answers'
  );
  assert.ok(Prompt.TimeoutMs >= Steps.MIN_PROMPT_TIMEOUT_MS);
});

test('unknown step kinds are dropped rather than carried into a run', () => {
  const Result = Steps.NormalizeSteps([{ Kind: 'launch-missiles' }, { Kind: 'stop' }]);
  assert.equal(Result.Steps.length, 1);
  assert.equal(Result.Steps[0].Kind, 'stop');
  assert.match(Result.Dropped.join(' '), /Unknown step type/);
});

test('CollectCalledWorkflowIDs finds calls nested inside branches', () => {
  const { Steps: Out } = Steps.NormalizeSteps([
    {
      Kind: 'if',
      Condition: { Left: 'x', Operator: 'is' },
      Then: [{ Kind: 'call', WorkflowID: 7 }],
      Else: [{ Kind: 'call', WorkflowID: 9 }],
    },
  ]);
  assert.deepEqual(Steps.CollectCalledWorkflowIDs(Out).sort(), [7, 9]);
});

// --- Conditions --------------------------------------------------------------

test('a value with no reading never matches, whatever the operator', () => {
  // Inherited deliberately from the FreeKiosk metric alarms: absence of evidence
  // is not evidence of a fault.
  const Context = { check: { Online: null }, vars: {} };
  for (const Operator of Steps.WORKFLOW_OPERATORS) {
    const Result = Conditions.EvaluateCondition(
      { Left: 'check.Online', Operator, Right: 'anything', Right2: 10 },
      Context
    );
    assert.equal(Result.Matched, false, `${Operator} must not match a missing reading`);
    assert.match(Result.Reason, /no reading/);
  }

  // A path that does not exist at all behaves the same way.
  const Missing = Conditions.EvaluateCondition(
    { Left: 'check.Nonexistent', Operator: 'is', Right: 'x' },
    Context
  );
  assert.equal(Missing.Matched, false);
});

test('is / isNot compare booleans, numbers and text sensibly', () => {
  const Context = { check: { Online: false, Latency: 42, Error: 'DNS failure' } };
  const check = (Left, Operator, Right) =>
    Conditions.EvaluateCondition({ Left, Operator, Right }, Context).Matched;

  // A select field hands back the string 'false'; it must match a real boolean.
  assert.equal(check('check.Online', 'is', false), true);
  assert.equal(check('check.Online', 'is', 'false'), true);
  assert.equal(check('check.Online', 'isNot', true), true);
  assert.equal(check('check.Latency', 'is', '42'), true);
  assert.equal(check('check.Error', 'is', 'dns failure'), true, 'text compares case-insensitively');
});

test('range operators tolerate bounds entered the wrong way round', () => {
  const Context = { check: { Latency: 50 } };
  const inside = (A, B) =>
    Conditions.EvaluateCondition(
      { Left: 'check.Latency', Operator: 'inside', Right: A, Right2: B },
      Context
    ).Matched;

  // Silently never matching would be a worse answer than doing the obvious thing.
  assert.equal(inside(10, 100), true);
  assert.equal(inside(100, 10), true);
});

test('condition reasons name the value, for the run log', () => {
  const Result = Conditions.EvaluateCondition(
    { Left: 'check.Online', Operator: 'is', Right: false },
    { check: { Online: false } }
  );
  assert.equal(Result.Matched, true);
  assert.match(Result.Reason, /check\.Online/);
});

// --- The runner --------------------------------------------------------------

function makeDeps(overrides = {}) {
  const Log = [];
  const Emitted = [];
  const Persisted = [];
  return {
    Log,
    Emitted,
    Persisted,
    Deps: {
      RunAction: async (Step) => {
        Log.push(Step.ActionID);
        return { Success: true, Detail: `ran ${Step.ActionID}` };
      },
      CallWorkflow: async () => ({ Success: true, Return: null }),
      Emit: (Run) => Emitted.push({ Status: Run.Status, Current: Run.CurrentStepID }),
      Persist: (Run) => Persisted.push(Run),
      Now: () => Date.now(),
      Sleep: async (Ms) => {
        Log.push(`wait:${Ms}`);
      },
      ...overrides,
    },
  };
}

function build(steps) {
  return Steps.NormalizeSteps(steps).Steps;
}

const DEFAULT_RETURN = Serialization.NormalizeReturn({
  Name: 'Result',
  Type: 'boolean',
  From: 'vars.ok',
  Fallback: false,
});

function runOptions(steps, extra = {}) {
  return {
    WorkflowID: 1,
    WorkflowName: 'Test',
    Steps: steps,
    Return: DEFAULT_RETURN,
    Mode: 'normal',
    TriggerSource: 'test',
    ContextScopedID: null,
    Context: {},
    Depth: 0,
    Visited: new Set(),
    ...extra,
  };
}

test('steps run strictly in order, not concurrently', async () => {
  // The behaviour that separates a workflow from an alert rule.
  const { Log, Deps } = makeDeps();
  const steps = build([
    { Kind: 'action', ActionID: 'first' },
    { Kind: 'delay', Ms: 30 },
    { Kind: 'action', ActionID: 'second' },
  ]);

  const Run = await Runner.StartRun(runOptions(steps), Deps);
  assert.deepEqual(Log, ['first', 'wait:30', 'second']);
  assert.equal(Run.Status, 'completed');
});

test('a failed step halts the run unless it opts into continuing', async () => {
  const { Log, Deps } = makeDeps({
    RunAction: async (Step) => {
      Log.push(Step.ActionID);
      return Step.ActionID === 'boom'
        ? { Success: false, Error: 'device said no' }
        : { Success: true };
    },
  });

  const halting = build([
    { Kind: 'action', ActionID: 'boom' },
    { Kind: 'action', ActionID: 'never' },
  ]);
  const Run = await Runner.StartRun(runOptions(halting), Deps);
  assert.deepEqual(Log, ['boom']);
  assert.equal(Run.Status, 'failed');
  assert.equal(Run.Steps.find((S) => S.Label === 'boom').Error, 'device said no');
  // Steps never reached read as skipped rather than sitting pending forever.
  assert.equal(Run.Steps.find((S) => S.Label === 'never').Status, 'skipped');

  Log.length = 0;
  const continuing = build([
    { Kind: 'action', ActionID: 'boom', ContinueOnError: true },
    { Kind: 'action', ActionID: 'after' },
  ]);
  const Second = await Runner.StartRun(runOptions(continuing), Deps);
  assert.deepEqual(Log, ['boom', 'after']);
  assert.equal(Second.Status, 'completed');
});

test('If runs only the branch it took and marks the other skipped', async () => {
  const { Log, Deps } = makeDeps();
  const steps = build([
    {
      Kind: 'if',
      Condition: { Left: 'check.Online', Operator: 'is', Right: false },
      Then: [{ Kind: 'action', ActionID: 'recover' }],
      Else: [{ Kind: 'action', ActionID: 'all-good' }],
    },
  ]);

  const Run = await Runner.StartRun(
    runOptions(steps, { Context: { check: { Online: false } } }),
    Deps
  );
  assert.deepEqual(Log, ['recover']);
  assert.equal(Run.Steps.find((S) => S.Label === 'all-good').Status, 'skipped');
  assert.equal(Run.Steps.find((S) => S.Label === 'recover').Status, 'ok');
});

test('a later condition can read an earlier step result', async () => {
  const { Log, Deps } = makeDeps({
    RunAction: async (Step) => {
      Log.push(Step.ActionID);
      return { Success: Step.ActionID !== 'power-on' };
    },
  });

  const first = build([{ Kind: 'action', ActionID: 'power-on' }])[0];
  const steps = [
    first,
    ...build([
      {
        Kind: 'if',
        Condition: { Left: `steps.${first.StepID}.Success`, Operator: 'is', Right: false },
        Then: [{ Kind: 'action', ActionID: 'escalate' }],
        Else: [],
        // Without this the failing first step would halt the run before the
        // branch that exists to handle exactly that failure.
      },
    ]),
  ];
  first.ContinueOnError = true;

  await Runner.StartRun(runOptions(steps), Deps);
  assert.deepEqual(Log, ['power-on', 'escalate']);
});

test('a stop step ends the run cleanly and skips the rest', async () => {
  const { Log, Deps } = makeDeps();
  const steps = build([
    { Kind: 'action', ActionID: 'one' },
    { Kind: 'stop', Reason: 'nothing to do' },
    { Kind: 'action', ActionID: 'two' },
  ]);

  const Run = await Runner.StartRun(runOptions(steps), Deps);
  assert.deepEqual(Log, ['one']);
  assert.equal(Run.Status, 'completed');
  assert.equal(Run.Steps.find((S) => S.Label === 'two').Status, 'skipped');
});

test('a prompt times out to its declared default', async () => {
  // An unattended server has nobody to answer. Without the timeout the run would
  // wedge forever, potentially holding a device lock.
  const { Log, Deps } = makeDeps();
  const steps = build([
    {
      Kind: 'prompt',
      Message: 'Power it back on?',
      Buttons: [
        { Value: 'yes', Label: 'Yes' },
        { Value: 'no', Label: 'No' },
      ],
      TimeoutMs: 1000,
      DefaultValue: 'no',
      StoreAs: 'answer',
    },
    {
      Kind: 'if',
      Condition: { Left: 'vars.answer', Operator: 'is', Right: 'yes' },
      Then: [{ Kind: 'action', ActionID: 'power-on' }],
      Else: [{ Kind: 'action', ActionID: 'stand-down' }],
    },
  ]);

  const Run = await Runner.StartRun(runOptions(steps), Deps);
  assert.equal(Run.Vars.answer, 'no');
  assert.deepEqual(Log, ['stand-down']);
});

test('answering a prompt resolves it and takes the matching branch', async () => {
  const { Log, Deps } = makeDeps();
  const steps = build([
    {
      Kind: 'prompt',
      Message: 'Power it back on?',
      Buttons: [
        { Value: 'yes', Label: 'Yes' },
        { Value: 'no', Label: 'No' },
      ],
      TimeoutMs: 30000,
      DefaultValue: 'no',
      StoreAs: 'answer',
    },
    {
      Kind: 'if',
      Condition: { Left: 'vars.answer', Operator: 'is', Right: 'yes' },
      Then: [{ Kind: 'action', ActionID: 'power-on' }],
      Else: [],
    },
  ]);

  const Name = 'prompt-answered';
  const Pending = Runner.StartRun(runOptions(steps, { WorkflowName: Name }), Deps);

  // Wait for the prompt to be raised, then answer it.
  let Run = null;
  for (let i = 0; i < 100 && !Run; i++) {
    await new Promise((r) => setTimeout(r, 10));
    Run = Runner.GetActiveRuns().find((R) => R.WorkflowName === Name && R.Prompt);
  }
  assert.ok(Run, 'the run should have raised a prompt');
  assert.equal(Runner.AnswerPrompt(Run.RunKey, Run.Prompt.StepID, 'yes'), true);

  const Finished = await Pending;
  assert.equal(Finished.Vars.answer, 'yes');
  assert.deepEqual(Log, ['power-on']);
});

// Find THIS test's run by its unique name. Filtering on status alone would pick
// up any run another test left in flight, which is how a hang gets blamed on the
// wrong test.
async function waitForPausedRun(Name) {
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 10));
    const Run = Runner.GetActiveRuns().find(
      (R) => R.WorkflowName === Name && R.Status === 'paused'
    );
    if (Run) return Run;
  }
  return null;
}

test('step mode pauses before each step until told to continue', async () => {
  const { Log, Deps } = makeDeps();
  const Name = 'step-mode';
  const steps = build([
    { Kind: 'action', ActionID: 'one' },
    { Kind: 'action', ActionID: 'two' },
  ]);

  const Pending = Runner.StartRun(runOptions(steps, { Mode: 'step', WorkflowName: Name }), Deps);

  let Run = await waitForPausedRun(Name);
  assert.ok(Run, 'a step-mode run pauses before its first step');
  assert.deepEqual(Log, [], 'nothing runs until the operator steps');

  // Step once: the run executes exactly one step and pauses again.
  Runner.ResumeRun(Run.RunKey, true);
  Run = await waitForPausedRun(Name);
  assert.ok(Run, 'the run pauses again before the second step');
  assert.deepEqual(Log, ['one'], 'stepping runs exactly one step');

  Runner.ResumeRun(Run.RunKey, false);
  const Finished = await Pending;
  assert.deepEqual(Log, ['one', 'two']);
  assert.equal(Finished.Status, 'completed');
});

test('aborting a run stops it and still yields the fallback Return', async () => {
  const { Log, Deps } = makeDeps();
  const Name = 'abort-me';
  const steps = build([
    { Kind: 'action', ActionID: 'one' },
    { Kind: 'action', ActionID: 'two' },
  ]);

  const Pending = Runner.StartRun(runOptions(steps, { Mode: 'step', WorkflowName: Name }), Deps);
  const Run = await waitForPausedRun(Name);
  assert.ok(Run);
  Runner.AbortRun(Run.RunKey);

  const Finished = await Pending;
  assert.equal(Finished.Status, 'aborted');
  assert.deepEqual(Log, [], 'an aborted run does not run the step it was paused on');
  // A caller must never have to handle "no value".
  assert.equal(Finished.ReturnValue, false);
});

test('the Return is resolved from the run context and coerced to its type', async () => {
  const { Deps } = makeDeps();
  const steps = build([
    {
      Kind: 'prompt',
      Message: 'ok?',
      Buttons: [{ Value: 'yes', Label: 'Yes' }],
      TimeoutMs: 1000,
      DefaultValue: 'yes',
      StoreAs: 'answer',
    },
  ]);

  const Run = await Runner.StartRun(
    runOptions(steps, {
      Return: Serialization.NormalizeReturn({
        Name: 'Confirmed',
        Type: 'boolean',
        From: 'vars.answer',
        Fallback: false,
      }),
    }),
    Deps
  );

  // 'yes' stored as text, handed back as the declared boolean.
  assert.equal(Run.ReturnValue, true);
});

test('a call step refuses to re-enter a workflow already in the chain', async () => {
  const { Deps } = makeDeps();
  const steps = build([{ Kind: 'call', WorkflowID: 5 }]);

  // Extracting shared logic into sub-workflows is the point of Return, so a
  // workflow eventually calling itself is a matter of when, not whether.
  const Run = await Runner.StartRun(
    runOptions(steps, { WorkflowID: 5, Visited: new Set([5]) }),
    Deps
  );
  assert.equal(Run.Status, 'failed');
  assert.match(Run.Steps[0].Error, /already running/i);
});

test('a call step refuses to nest deeper than the limit', async () => {
  const { Deps } = makeDeps();
  const steps = build([{ Kind: 'call', WorkflowID: 2 }]);
  const Run = await Runner.StartRun(runOptions(steps, { Depth: Runner.MAX_CALL_DEPTH }), Deps);
  assert.equal(Run.Status, 'failed');
  assert.match(Run.Steps[0].Error, /nested more than/i);
});

test('a call step binds the callee Return into vars', async () => {
  const { Log, Deps } = makeDeps({
    CallWorkflow: async () => ({ Success: true, Return: true }),
  });
  const steps = build([
    { Kind: 'call', WorkflowID: 2, StoreAs: 'confirmed' },
    {
      Kind: 'if',
      Condition: { Left: 'vars.confirmed', Operator: 'is', Right: true },
      Then: [{ Kind: 'action', ActionID: 'go-ahead' }],
      Else: [],
    },
  ]);

  const Run = await Runner.StartRun(runOptions(steps), Deps);
  assert.equal(Run.Vars.confirmed, true);
  assert.deepEqual(Log, ['go-ahead']);
});

test('disabled steps are skipped without running', async () => {
  const { Log, Deps } = makeDeps();
  const steps = build([
    { Kind: 'action', ActionID: 'skipped', Enabled: false },
    { Kind: 'action', ActionID: 'ran' },
  ]);

  const Run = await Runner.StartRun(runOptions(steps), Deps);
  assert.deepEqual(Log, ['ran']);
  assert.equal(Run.Steps.find((S) => S.Label === 'skipped').Status, 'skipped');
});

test('a settled run is persisted once and leaves the active list', async () => {
  const { Persisted, Deps } = makeDeps();
  const steps = build([{ Kind: 'action', ActionID: 'one' }]);
  const Run = await Runner.StartRun(runOptions(steps), Deps);

  assert.equal(Persisted.length, 1);
  assert.equal(Persisted[0].RunKey, Run.RunKey);
  assert.equal(Runner.GetRun(Run.RunKey), null, 'a finished run must not linger as active');
});

test('the run emits on every transition so the debugger can follow it', async () => {
  const { Emitted, Deps } = makeDeps();
  const steps = build([
    { Kind: 'action', ActionID: 'one' },
    { Kind: 'action', ActionID: 'two' },
  ]);
  await Runner.StartRun(runOptions(steps), Deps);

  // Start, plus running/finished for each step, plus the settle.
  assert.ok(Emitted.length >= 5, `expected several emits, got ${Emitted.length}`);
  assert.equal(Emitted[Emitted.length - 1].Status, 'completed');
});
