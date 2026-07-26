const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Exercises the pure trigger/summary layer of src/UI/js/app/alert-rules.ts.
//
// An alert rule is "when THESE machines do THIS, do THAT". The summary line is
// how an operator confirms, at a glance and often minutes before a show, that a
// rule says what they meant. A wrong summary is worse than no summary: it
// actively reassures them about a rule that does something else.
//
// The trigger normaliser is the security-adjacent part. It is an ALLOWLIST, so
// anything not on it is dropped rather than passed through -- a rule cannot be
// made to fire on an arbitrary string, and a stale rule referencing a removed
// trigger degrades to "no triggers" instead of matching everything.
//
// settings.ts constructs Howl instances at module scope (a vendor global),
// which this module transitively imports -- hence the stub before requiring.

global.Howl = function Howl() {
  return { play() {}, stop() {}, volume() {}, unload() {} };
};

const APP = path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app');

const AlertRules = require(path.join(APP, 'alert-rules.js'));
const State = require(path.join(APP, 'state/index.js'));

const {
  NormalizeAlertTriggerTypes,
  DefaultAlertTriggerTypes,
  triggerSummaryText,
  triggersSummaryText,
  summarizeActionType,
  naturalJoin,
  targetNameFromScopedID,
  scopedTargetsInfo,
  buildRuleSummary,
} = AlertRules;

const { ALERT_TRIGGER_ALLOWLIST } = State;

function seed({ clients = [], monitors = [], dummies = [], groups = [] } = {}) {
  State.setAllClients(clients);
  State.setMonitoringTargets(monitors);
  State.setDummyClients(dummies);
  if (State.setAlertScopeGroups) State.setAlertScopeGroups(groups);
}

test.beforeEach(() => seed());

// --- Trigger normalisation --------------------------------------------------

test('every allowlisted trigger survives normalisation', () => {
  for (const Trigger of ALERT_TRIGGER_ALLOWLIST) {
    assert.deepEqual(NormalizeAlertTriggerTypes([Trigger]), [Trigger], `trigger ${Trigger}`);
  }
});

test('triggers are case-normalised and trimmed', () => {
  // The value arrives from a checkbox list and from stored rules written by
  // older versions; both spellings have to resolve to the canonical one.
  assert.deepEqual(NormalizeAlertTriggerTypes(['client_offline']), ['CLIENT_OFFLINE']);
  assert.deepEqual(NormalizeAlertTriggerTypes(['  Client_Offline  ']), ['CLIENT_OFFLINE']);
});

test('anything not on the allowlist is dropped, never passed through', () => {
  // This is the point of the allowlist: a rule must not be constructible that
  // fires on an arbitrary string, and a stale rule naming a removed trigger has
  // to degrade to "no triggers" rather than matching everything.
  assert.deepEqual(NormalizeAlertTriggerTypes(['NOT_A_TRIGGER']), []);
  assert.deepEqual(NormalizeAlertTriggerTypes(['*']), []);
  assert.deepEqual(NormalizeAlertTriggerTypes(['CLIENT_OFFLINE', 'MADE_UP']), ['CLIENT_OFFLINE']);
});

test('duplicates collapse so a rule cannot double-fire', () => {
  assert.deepEqual(
    NormalizeAlertTriggerTypes(['CLIENT_OFFLINE', 'client_offline', 'CLIENT_OFFLINE']),
    ['CLIENT_OFFLINE']
  );
});

test('order is preserved, so the summary reads as the operator selected', () => {
  assert.deepEqual(NormalizeAlertTriggerTypes(['CLIENT_ONLINE', 'CLIENT_OFFLINE']), [
    'CLIENT_ONLINE',
    'CLIENT_OFFLINE',
  ]);
});

test('a bare (non-array) trigger value is accepted', () => {
  // Older rules stored a single string rather than a list.
  assert.deepEqual(NormalizeAlertTriggerTypes('CLIENT_OFFLINE'), ['CLIENT_OFFLINE']);
});

test('an absent or unusable trigger set normalises to empty', () => {
  for (const Value of [null, undefined, [], [null], [undefined], [''], [{}], [42]]) {
    assert.deepEqual(NormalizeAlertTriggerTypes(Value), [], `value ${JSON.stringify(Value)}`);
  }
});

test('a new rule always starts with exactly one valid trigger', () => {
  // A rule saved with no trigger would never fire, and nothing on screen would
  // explain why.
  const Default = DefaultAlertTriggerTypes();
  assert.equal(Default.length, 1);
  assert.ok(ALERT_TRIGGER_ALLOWLIST.has(Default[0]), `${Default[0]} is not allowlisted`);
});

// --- Trigger phrasing -------------------------------------------------------

test('every allowlisted trigger has its own phrase', () => {
  // A trigger that falls through to the generic "triggers" produces a summary
  // that cannot be distinguished from another rule's.
  const Phrases = new Map();
  for (const Trigger of ALERT_TRIGGER_ALLOWLIST) {
    const Phrase = triggerSummaryText(Trigger);
    assert.notEqual(Phrase, 'triggers', `${Trigger} has no phrase of its own`);
    assert.ok(!Phrases.has(Phrase), `${Trigger} shares a phrase with ${Phrases.get(Phrase)}`);
    Phrases.set(Phrase, Trigger);
  }
});

test('critical and non-critical variants read differently', () => {
  // These are the pairs an operator is most likely to confuse, and the whole
  // point of having both is that they mean different things.
  const Critical = triggerSummaryText('CRITICAL_USB_DEVICE_DISCONNECTED');
  const NonCritical = triggerSummaryText('NON_CRITICAL_USB_DEVICE_DISCONNECTED');
  const Any = triggerSummaryText('USB_DEVICE_DISCONNECTED');

  assert.match(Critical, /critical/);
  assert.match(NonCritical, /non-critical/);
  assert.equal(new Set([Critical, NonCritical, Any]).size, 3);
});

test('an unknown trigger falls back to a neutral phrase', () => {
  assert.equal(triggerSummaryText('NOT_A_TRIGGER'), 'triggers');
  assert.equal(triggerSummaryText(''), 'triggers');
});

test('multiple triggers are joined with "or", because any one fires the rule', () => {
  // "and" would imply all of them must happen, which is the opposite of what
  // the rule does.
  assert.equal(triggersSummaryText(['CLIENT_OFFLINE']), 'is offline');
  assert.equal(triggersSummaryText(['CLIENT_OFFLINE', 'CLIENT_ONLINE']), 'is offline or is online');
  assert.equal(
    triggersSummaryText(['CLIENT_OFFLINE', 'CLIENT_ONLINE', 'CLIENT_DEGRADED']),
    'is offline, is online, or is degraded'
  );
});

test('a rule with no valid triggers says so rather than reading as complete', () => {
  assert.equal(triggersSummaryText([]), 'triggers');
  assert.equal(triggersSummaryText(['MADE_UP']), 'triggers');
});

// --- Action phrasing --------------------------------------------------------

test('each action type is described in the operator’s terms, singular and plural', () => {
  const Types = [
    ['osc-trigger', /OSC message/],
    ['discord-webhook', /Discord/],
    ['slack-webhook', /Slack/],
    ['teams-webhook', /Teams/],
    ['telegram-bot', /Telegram/],
    ['http-api', /HTTP request/],
    ['play-sound', /alert sound/],
    ['play-custom-audio', /custom audio asset/],
    ['showtrak-alert', /ShowTrak alert/],
  ];

  for (const [Type, Pattern] of Types) {
    const One = summarizeActionType(Type, 1);
    const Many = summarizeActionType(Type, 3);
    assert.match(One, Pattern, `${Type} singular`);
    assert.match(Many, Pattern, `${Type} plural`);
    assert.match(Many, /\b3\b/, `${Type} plural should carry the count`);
    assert.notEqual(One, Many);
  }
});

test('an unknown action type still produces a readable phrase', () => {
  // Actions can be added server-side ahead of the renderer knowing about them.
  const One = summarizeActionType('brand-new-action', 1);
  const Many = summarizeActionType('brand-new-action', 2);
  assert.match(One, /^run /);
  assert.match(Many, /^run 2 /);
});

test('a list is joined with "and", since every action runs', () => {
  assert.equal(naturalJoin([]), '');
  assert.equal(naturalJoin(['a']), 'a');
  assert.equal(naturalJoin(['a', 'b']), 'a and b');
  assert.equal(naturalJoin(['a', 'b', 'c']), 'a, b, and c');
  assert.equal(naturalJoin(null), '');
});

// --- Target naming ----------------------------------------------------------

test('a client is named by nickname, then hostname, then id', () => {
  seed({
    clients: [
      { UUID: 'c1', Nickname: 'FOH PC', Hostname: 'foh-01' },
      { UUID: 'c2', Hostname: 'stage-01' },
      { UUID: 'c3' },
    ],
  });

  assert.equal(targetNameFromScopedID('c1'), 'FOH PC');
  assert.equal(targetNameFromScopedID('c2'), 'stage-01');
  assert.equal(targetNameFromScopedID('c3'), 'c3');
});

test('a monitor is resolved through its scoped id', () => {
  seed({ monitors: [{ TargetID: 7, Nickname: 'Rack UPS' }] });
  assert.equal(targetNameFromScopedID('monitor:7'), 'Rack UPS');
});

test('a monitor with no nickname falls back to its address, then a label', () => {
  seed({ monitors: [{ TargetID: 7, Address: '10.0.0.9' }] });
  assert.equal(targetNameFromScopedID('monitor:7'), '10.0.0.9');

  seed({ monitors: [{ TargetID: 7 }] });
  assert.equal(targetNameFromScopedID('monitor:7'), 'Target 7');
});

test('a dummy is named ahead of a client with the same id', () => {
  seed({
    dummies: [{ UUID: 'shared', Nickname: 'Media Server' }],
    clients: [{ UUID: 'shared', Nickname: 'A Client' }],
  });
  assert.equal(targetNameFromScopedID('shared'), 'Media Server');
});

test('a target that no longer exists shows its id rather than vanishing', () => {
  // The operator needs to see that a rule references something missing; a blank
  // name would read as an empty rule.
  seed();
  assert.equal(targetNameFromScopedID('deleted-uuid'), 'deleted-uuid');
  assert.equal(targetNameFromScopedID('monitor:99'), 'Target 99');
  assert.equal(targetNameFromScopedID(''), 'Target');
  assert.equal(targetNameFromScopedID(null), 'Target');
});

// --- Scope counting ---------------------------------------------------------

test('a workspace rule counts every entity currently known', () => {
  seed({
    clients: [
      { UUID: 'c1', Nickname: 'One' },
      { UUID: 'c2', Nickname: 'Two' },
    ],
  });
  const Info = scopedTargetsInfo({ Scope: { Workspace: true } });
  assert.equal(Info.Count, 2);
  assert.equal(Info.SingleName, null, 'more than one target has no single name');
});

test('a single-target rule is named, not counted', () => {
  // "When FOH PC is offline" is far more useful than "when one of 1 targets".
  seed({ clients: [{ UUID: 'c1', Nickname: 'FOH PC' }] });
  const Info = scopedTargetsInfo({ Scope: { Clients: ['c1'] } });
  assert.equal(Info.Count, 1);
  assert.equal(Info.SingleName, 'FOH PC');
});

test('a rule with no scope targets nothing', () => {
  seed({ clients: [{ UUID: 'c1' }] });
  assert.equal(scopedTargetsInfo({}).Count, 0);
  assert.equal(scopedTargetsInfo({ Scope: {} }).Count, 0);
  assert.equal(scopedTargetsInfo(null).Count, 0);
});

test('a scope naming a deleted client does not inflate the count', () => {
  // A rule that claims 3 targets while only 1 exists would misrepresent its
  // reach every time the operator reads it.
  seed({ clients: [{ UUID: 'c1', Nickname: 'One' }] });
  const Info = scopedTargetsInfo({ Scope: { Clients: ['c1', 'gone', 'also-gone'] } });
  assert.equal(Info.Count, 1);
  assert.equal(Info.SingleName, 'One');
});

// --- The rule summary -------------------------------------------------------

test('a complete rule reads as one sentence', () => {
  seed({ clients: [{ UUID: 'c1', Nickname: 'FOH PC' }] });

  const Summary = buildRuleSummary({
    TriggerTypes: ['CLIENT_OFFLINE'],
    Scope: { Clients: ['c1'] },
    Actions: [{ Type: 'showtrak-alert' }],
  });

  assert.equal(Summary, 'When FOH PC is offline, create a ShowTrak alert.');
});

test('repeated action types are counted rather than repeated', () => {
  seed({ clients: [{ UUID: 'c1', Nickname: 'FOH PC' }] });

  const Summary = buildRuleSummary({
    TriggerTypes: ['CLIENT_OFFLINE'],
    Scope: { Clients: ['c1'] },
    Actions: [{ Type: 'osc-trigger' }, { Type: 'osc-trigger' }, { Type: 'showtrak-alert' }],
  });

  assert.match(Summary, /send 2 OSC messages/);
  assert.match(Summary, /and create a ShowTrak alert/);
});

test('a multi-target rule is described by count', () => {
  seed({ clients: [{ UUID: 'c1' }, { UUID: 'c2' }, { UUID: 'c3' }] });

  const Summary = buildRuleSummary({
    TriggerTypes: ['CLIENT_OFFLINE'],
    Scope: { Workspace: true },
    Actions: [{ Type: 'showtrak-alert' }],
  });

  assert.match(Summary, /one of 3 targets/);
});

test('a rule with no actions says so instead of trailing off', () => {
  // A rule that triggers and does nothing is a real and confusing state; the
  // summary has to name it so the operator can see the rule is incomplete.
  seed({ clients: [{ UUID: 'c1', Nickname: 'FOH PC' }] });

  const Summary = buildRuleSummary({
    TriggerTypes: ['CLIENT_OFFLINE'],
    Scope: { Clients: ['c1'] },
    Actions: [],
  });

  assert.match(Summary, /take no actions\.$/);
});

test('an empty rule still produces a sentence rather than throwing', () => {
  seed();
  for (const Rule of [{}, null, undefined, { Actions: null, Scope: null }]) {
    const Summary = buildRuleSummary(Rule);
    assert.match(Summary, /^When .* triggers, take no actions\.$/, `rule ${JSON.stringify(Rule)}`);
  }
});

test('a multi-trigger, multi-action rule reads correctly end to end', () => {
  seed({ clients: [{ UUID: 'c1', Nickname: 'FOH PC' }] });

  const Summary = buildRuleSummary({
    TriggerTypes: ['CLIENT_OFFLINE', 'CLIENT_DEGRADED'],
    Scope: { Clients: ['c1'] },
    Actions: [{ Type: 'showtrak-alert' }, { Type: 'play-sound' }],
  });

  assert.equal(
    Summary,
    'When FOH PC is offline or is degraded, create a ShowTrak alert and play an alert sound.'
  );
});
