// Pure decision logic behind the Workflow Manager UI.
//
// No jsdom (declined project-wide) — these exercise the exported helpers, and
// the DOM-touching code sits behind `$('#…').length` guards that the chainable
// jQuery stub short-circuits.
//
// The tree helpers are the load-bearing part: the step editor addresses steps
// by their stable StepID rather than a position, so reordering, deleting and
// nesting all have to agree about which array a row actually lives in.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { installJQuery, installHowl } = require('./helpers/renderer-stubs');

installJQuery();
installHowl();

const APP = path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app');
const Workflows = require(path.join(APP, 'workflows.js'));

function step(Kind, extra = {}) {
  return {
    StepID: extra.StepID || `s-${Math.random().toString(36).slice(2, 8)}`,
    Kind,
    Enabled: true,
    ContinueOnError: false,
    ...extra,
  };
}

function tree() {
  return [
    step('action', { StepID: 'a', ActionID: 'pjlink/power.on' }),
    step('if', {
      StepID: 'b',
      Condition: { Left: 'check.Online', Operator: 'is', Right: false },
      Then: [step('delay', { StepID: 'c', Ms: 30000 })],
      Else: [step('stop', { StepID: 'd' })],
    }),
    step('action', { StepID: 'e', ActionID: 'slack-webhook' }),
  ];
}

// --- Tree walking ------------------------------------------------------------

test('countSteps counts nested steps, not just top-level ones', () => {
  // The list summary says "5 steps"; counting only the top level would claim 3
  // and understate what the workflow actually does.
  assert.equal(Workflows.countSteps(tree()), 5);
  assert.equal(Workflows.countSteps([]), 0);
});

test('flattenSteps preserves nesting as depth and branch', () => {
  const Flat = Workflows.flattenSteps(tree());
  assert.deepEqual(
    Flat.map((F) => [F.Step.StepID, F.Depth, F.Branch]),
    [
      ['a', 0, null],
      ['b', 0, null],
      ['c', 1, 'then'],
      ['d', 1, 'else'],
      ['e', 0, null],
    ]
  );
});

test('flattenSteps hands back the owning array so a row can mutate in place', () => {
  const Steps = tree();
  const Nested = Workflows.findFlatStep(Steps, 'c');
  // 'c' lives in the If step's Then array, not the top-level list. A row's
  // move/delete controls act on Parent, so getting this wrong would move the
  // wrong step or throw.
  assert.equal(Nested.Parent, Steps[1].Then);
  assert.equal(Nested.Index, 0);

  const Top = Workflows.findFlatStep(Steps, 'e');
  assert.equal(Top.Parent, Steps);
  assert.equal(Top.Index, 2);
});

test('findFlatStep returns null for an unknown ID', () => {
  assert.equal(Workflows.findFlatStep(tree(), 'nope'), null);
});

test('moveStep reorders within a branch and refuses to escape it', () => {
  const Steps = tree();

  // Moving the last top-level step up swaps it with the If.
  assert.equal(Workflows.moveStep(Workflows.findFlatStep(Steps, 'e'), -1), true);
  assert.deepEqual(
    Steps.map((S) => S.StepID),
    ['a', 'e', 'b']
  );

  // A lone step inside a branch cannot move out of it — there is nowhere to go.
  const Nested = Workflows.findFlatStep(Steps, 'c');
  assert.equal(Workflows.moveStep(Nested, -1), false);
  assert.equal(Workflows.moveStep(Nested, 1), false);
  assert.equal(Steps[2].Then[0].StepID, 'c', 'the nested step stays where it was');
});

// --- Summaries ---------------------------------------------------------------

function workflow(extra = {}) {
  return {
    WorkflowID: 1,
    Slug: 'test',
    Name: 'Test',
    Description: '',
    Icon: 'diagram-3',
    Colour: 6,
    Triggers: {
      Manual: true,
      Callable: true,
      Events: [],
      EventConfig: {},
      Scope: { Workspace: false, Groups: [], Clients: [], Tags: [] },
    },
    Steps: [],
    Return: { Name: 'Result', Type: 'boolean', From: '', Fallback: false },
    Enabled: true,
    Weight: 100,
    Timestamp: 0,
    UpdatedAt: 0,
    ...extra,
  };
}

test('buildWorkflowSummary describes step count and how it starts', () => {
  const Summary = Workflows.buildWorkflowSummary(
    workflow({
      Steps: tree(),
      Triggers: {
        Manual: true,
        Callable: false,
        Events: ['CLIENT_OFFLINE'],
        EventConfig: {},
        Scope: { Workspace: false, Groups: [], Clients: [], Tags: [] },
      },
    })
  );
  assert.match(Summary, /5 steps/);
  assert.match(Summary, /manually/);
  assert.match(Summary, /1 event/);
});

test('a workflow nothing can start says so, and is flagged', () => {
  // The single most likely configuration mistake: every trigger turned off
  // leaves a workflow that looks fine in the list and never runs.
  const Orphan = workflow({
    Triggers: {
      Manual: false,
      Callable: false,
      Events: [],
      EventConfig: {},
      Scope: { Workspace: false, Groups: [], Clients: [], Tags: [] },
    },
  });
  assert.equal(Workflows.isUnreachable(Orphan), true);
  assert.match(Workflows.buildWorkflowSummary(Orphan), /nothing can start it/i);

  assert.equal(Workflows.isUnreachable(workflow()), false);
});

test('the summary mentions the Return only when one is configured', () => {
  assert.doesNotMatch(Workflows.buildWorkflowSummary(workflow()), /returns/);
  const WithReturn = workflow({
    Return: { Name: 'Confirmed', Type: 'boolean', From: 'vars.answer', Fallback: false },
  });
  assert.match(Workflows.buildWorkflowSummary(WithReturn), /returns Confirmed/);
});

test('describeStep prefers an operator-set label over the generated one', () => {
  assert.equal(
    Workflows.describeStep(step('delay', { Ms: 5000, Label: 'Let it warm up' })),
    'Let it warm up'
  );
  assert.equal(Workflows.describeStep(step('delay', { Ms: 5000 })), 'Wait 5s');
  assert.match(
    Workflows.describeStep(
      step('if', { Condition: { Left: 'check.Online', Operator: 'is', Right: false } })
    ),
    /check\.Online is/
  );
});

// --- Step construction -------------------------------------------------------

test('makeStep produces a usable step for every kind', () => {
  for (const Kind of ['action', 'if', 'delay', 'prompt', 'call', 'stop']) {
    const Step = Workflows.makeStep(Kind);
    assert.equal(Step.Kind, Kind);
    assert.ok(Step.StepID, `${Kind} needs an ID`);
    assert.equal(Step.Enabled, true);
    assert.equal(Step.ContinueOnError, false);
  }

  // A new prompt must be answerable and must have a timeout default that is one
  // of its own buttons, or a timed-out run stores a value no branch tests for.
  const Prompt = Workflows.makeStep('prompt');
  assert.ok(Prompt.Buttons.length >= 2);
  assert.ok(Prompt.Buttons.some((B) => B.Value === Prompt.DefaultValue));
  assert.ok(Prompt.TimeoutMs > 0);

  // A new action defaults to acting on the run's context, which is what makes
  // the workflow reusable rather than wired to one machine.
  assert.equal(Workflows.makeStep('action').Target.Mode, 'context');
});

test('buildWorkflowPayload sends every section', () => {
  const Payload = Workflows.buildWorkflowPayload(workflow({ Steps: tree() }));
  for (const Key of ['Name', 'Triggers', 'Steps', 'Return', 'Enabled']) {
    assert.ok(Object.prototype.hasOwnProperty.call(Payload, Key), `payload needs ${Key}`);
  }
  // WorkflowID is addressed separately by the update call, not carried in body.
  assert.equal(Payload.WorkflowID, undefined);
});
