const test = require('node:test');
const assert = require('node:assert/strict');

// The Applications section of the client info modal (lib/applications.ts): one
// card per application with a Monitor toggle and, once monitored, a conditions
// table — running, responding, in the foreground — where anything this client
// cannot detect reads "Unsupported" in its row.
//
// Loaded from dist-test/ (see test/renderer-utils.test.js for why).

const Lib = require('../dist-test/UI/js/app/lib/applications.js');

function client(overrides = {}, capabilities = { Responding: true, Foreground: true }) {
  return {
    UUID: 'c1',
    Online: true,
    RunningApplications: {
      SampledAt: 1,
      TotalCount: 1,
      Truncated: false,
      Items: [],
      Status: { State: 'ok', Message: null, Platform: 'win32' },
      Foreground: 'Chrome',
      Capabilities: capabilities,
    },
    ...overrides,
  };
}

function app(overrides = {}) {
  return {
    Name: 'QLab',
    Key: 'qlab',
    Count: 1,
    IsRunning: true,
    IsCritical: true,
    Responding: true,
    IsForeground: true,
    RequireResponding: true,
    RequireForeground: false,
    ...overrides,
  };
}

test('an unmonitored application offers Monitor and no conditions', () => {
  const App = app({ IsCritical: false });
  assert.equal(Lib.ApplicationBadge(App, client()).Label, 'Monitor');
  assert.deepEqual(Lib.ApplicationConditionRows(App, client()), []);
  assert.deepEqual(Lib.ApplicationIssues(App, client()), []);
});

test('a monitored application lists its conditions with what it is doing now', () => {
  const Rows = Lib.ApplicationConditionRows(
    app({ Responding: false, IsForeground: false }),
    client()
  );
  assert.deepEqual(
    Rows.map((R) => [R.Label, R.Value, R.Supported, R.Checked, R.Locked, !!R.Failing]),
    [
      ['Is running', 'Yes', true, true, true, false],
      ['Is responding', 'No', true, true, false, true],
      ['Is in foreground', 'No', true, false, false, false],
    ]
  );
});

test('a condition this client cannot detect reads Unsupported, with no tick', () => {
  const Mac = client({}, { Responding: false, Foreground: true });
  const Rows = Lib.ApplicationConditionRows(app(), Mac);
  assert.deepEqual(
    Rows.find((R) => R.Field === 'RequireResponding'),
    {
      Field: 'RequireResponding',
      Label: 'Is responding',
      Value: 'Unsupported',
      Supported: false,
      Checked: true,
      Locked: false,
      Failing: null,
    }
  );
  // An older client reports no capabilities at all.
  const Old = client({}, undefined);
  delete Old.RunningApplications.Capabilities;
  assert.deepEqual(
    Lib.ApplicationConditionRows(app(), Old).map((R) => R.Value),
    ['Yes', 'Unsupported', 'Unsupported']
  );
});

test('issues follow the ticked conditions, and say who has the foreground', () => {
  const Unfocused = app({ RequireForeground: true, IsForeground: false });
  assert.deepEqual(Lib.ApplicationIssues(Unfocused, client()), [
    'Not in the foreground (Chrome is)',
  ]);
  assert.equal(Lib.ApplicationBadge(Unfocused, client()).State, 'issue');
  // Hung, but responding is not required.
  assert.deepEqual(
    Lib.ApplicationIssues(app({ Responding: false, RequireResponding: false }), client()),
    []
  );
  // Nothing focused is not evidence it lost focus.
  const Locked = client();
  Locked.RunningApplications.Foreground = null;
  assert.deepEqual(Lib.ApplicationIssues(Unfocused, Locked), []);
});

test('a closed monitored application is always missing', () => {
  const Closed = app({ IsRunning: false, Count: 0, Responding: undefined, IsForeground: false });
  assert.equal(Lib.ApplicationBadge(Closed, client()).Label, 'Not Running');
  assert.deepEqual(Lib.ApplicationIssues(Closed, client()), ['Not running']);
  assert.equal(Lib.ApplicationSummary(Closed), 'Not running');
});

test('the summary line reads instances, hangs and focus', () => {
  assert.equal(
    Lib.ApplicationSummary(app({ Count: 2, Responding: false })),
    'Running · 2 instances · Not responding · In foreground'
  );
});

test('a ticked table becomes a request; the running row is never sent', () => {
  assert.deepEqual(
    Lib.ApplicationConditionsPayload('QLab', { RequireRunning: false, RequireForeground: true }),
    { Name: 'QLab', RequireForeground: true }
  );
});
