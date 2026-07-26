const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { installJQuery } = require('./helpers/renderer-stubs');

// Exercises the pure decision layer of src/UI/js/app/monitoring-editor/.
//
// Two things here have consequences beyond the editor window:
//
//   1. The SAVE GATE. MonitoringPayloadIsValid decides whether a check is
//      complete enough to persist. Too lax and a half-configured check is saved
//      and silently never runs — the operator believes a device is monitored
//      when nothing is watching it. Too strict and a legitimate check (a
//      network-wide NDI discovery, which has no address) cannot be saved at all.
//
//   2. The DISCOVERY MERGE. Scan results arrive from several sources for the
//      same address, and a later, vaguer result must never overwrite a more
//      specific earlier one — otherwise a projector correctly identified by
//      PJLink degrades to a generic host as soon as an mDNS packet lands.

installJQuery();

const APP = path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app');
const Editor = require(path.join(APP, 'monitoring-editor', 'index.js'));
const State = require(path.join(APP, 'state/index.js'));

const {
  ParseIPv4ToNumber,
  ResolveMonitoringMethodHint,
  MergeNetworkDiscoveryResult,
  ResetNetworkDiscoveryState,
  BuildMonitoringPayload,
  MonitoringPayloadIsValid,
} = Editor;

const METHODS = [
  { ID: 'ping', Name: 'Ping' },
  { ID: 'http', Name: 'HTTP' },
  { ID: 'https', Name: 'HTTPS' },
  { ID: 'http-json', Name: 'HTTP JSON' },
  { ID: 'tcp-port', Name: 'TCP Port' },
  { ID: 'pjlink', Name: 'PJLink' },
  // The case the address rule exists for: a network-wide discovery method.
  { ID: 'ndi-source', Name: 'NDI Source', UsesAddress: false },
];

test.beforeEach(() => {
  State.setMonitoringMethodsCache(METHODS);
  State.setNetworkDiscoveryResults(new Map());
});

// --- Address parsing --------------------------------------------------------

test('a dotted-quad becomes a sortable number', () => {
  // Discovery results are ordered by this, so the operator reads the scan in
  // network order rather than in the order packets happened to arrive.
  assert.equal(ParseIPv4ToNumber('0.0.0.0'), 0);
  assert.equal(ParseIPv4ToNumber('255.255.255.255'), 4294967295);
  assert.ok(ParseIPv4ToNumber('10.0.0.2') > ParseIPv4ToNumber('10.0.0.1'));
  assert.ok(ParseIPv4ToNumber('10.0.1.0') > ParseIPv4ToNumber('10.0.0.255'));
});

test('the high octet does not overflow into a negative number', () => {
  // A signed shift here would sort every address above 127.x before 0.0.0.0.
  assert.ok(ParseIPv4ToNumber('192.168.1.1') > 0);
  assert.ok(ParseIPv4ToNumber('255.0.0.0') > ParseIPv4ToNumber('127.0.0.0'));
});

test('anything that is not a valid IPv4 address returns null', () => {
  for (const Value of [
    '10.0.0',
    '10.0.0.0.1',
    '10.0.0.256',
    '10.0.0.-1',
    '10.0.0.a',
    'hostname.local',
    'fe80::1',
    '',
    '   ',
    null,
    undefined,
    {},
  ]) {
    assert.equal(ParseIPv4ToNumber(Value), null, `address ${JSON.stringify(Value)}`);
  }
});

// --- Method hints -----------------------------------------------------------

test('a discovery hint resolves to a monitoring method that exists', () => {
  assert.equal(ResolveMonitoringMethodHint('ping'), 'ping');
  assert.equal(ResolveMonitoringMethodHint('PJLink'), 'pjlink');
  assert.equal(ResolveMonitoringMethodHint('  PING  '), 'ping');
});

test('generic hints widen to the specific methods that can serve them', () => {
  // A scan can only tell that something answers on a web port; the editor picks
  // a concrete method so the operator does not have to.
  assert.equal(ResolveMonitoringMethodHint('web'), 'http');
  assert.equal(ResolveMonitoringMethodHint('tcp'), 'tcp-port');
});

test('a hint never resolves to a method that is not installed', () => {
  // Selecting a method the server does not offer would produce a check that can
  // never run.
  State.setMonitoringMethodsCache([{ ID: 'ping', Name: 'Ping' }]);
  assert.equal(ResolveMonitoringMethodHint('web'), null);
  assert.equal(ResolveMonitoringMethodHint('pjlink'), null);
  assert.equal(ResolveMonitoringMethodHint('ping'), 'ping');
});

test('an empty or unknown hint resolves to nothing', () => {
  for (const Value of ['', '   ', null, undefined, 'not-a-method']) {
    assert.equal(ResolveMonitoringMethodHint(Value), null, `hint ${JSON.stringify(Value)}`);
  }
});

// --- Discovery merge --------------------------------------------------------

const results = () => State.NetworkDiscoveryResults;
const at = (Address) => results().get(Address);

test('a scan result is stored under a normalised address key', () => {
  MergeNetworkDiscoveryResult({ Address: '  10.0.0.5  ', Source: 'probe' });
  assert.equal(results().size, 1);
  assert.equal(at('10.0.0.5').ID, '10.0.0.5');
});

test('results for the same address merge rather than replacing', () => {
  MergeNetworkDiscoveryResult({
    Address: '10.0.0.5',
    Source: 'probe',
    Hostname: 'projector.local',
  });
  MergeNetworkDiscoveryResult({
    Address: '10.0.0.5',
    Source: 'bonjour',
    ServiceType: '_http._tcp',
    Port: 80,
  });

  assert.equal(results().size, 1);
  assert.equal(at('10.0.0.5').Hostname, 'projector.local', 'the earlier hostname was lost');
  assert.equal(at('10.0.0.5').Services.length, 1);
});

test('a PJLink identification is never downgraded by a later vaguer result', () => {
  // The rule that matters. PJLink is the most specific thing a scan can say
  // about a projector; letting a subsequent mDNS or plain-probe result overwrite
  // it would turn a correctly identified projector back into a generic host,
  // and the operator would have to pick the method by hand.
  MergeNetworkDiscoveryResult({ Address: '10.0.0.5', Source: 'pjlink', MethodHint: 'pjlink' });
  MergeNetworkDiscoveryResult({ Address: '10.0.0.5', Source: 'probe', MethodHint: 'tcp' });
  MergeNetworkDiscoveryResult({ Address: '10.0.0.5', Source: 'bonjour', MethodHint: 'web' });

  assert.equal(at('10.0.0.5').MethodHint, 'pjlink');
  assert.equal(at('10.0.0.5').Source, 'pjlink');
});

test('a PJLink result arriving LAST still wins', () => {
  MergeNetworkDiscoveryResult({ Address: '10.0.0.5', Source: 'probe', MethodHint: 'tcp' });
  MergeNetworkDiscoveryResult({ Address: '10.0.0.5', Source: 'pjlink', MethodHint: 'pjlink' });

  assert.equal(at('10.0.0.5').MethodHint, 'pjlink');
  assert.equal(at('10.0.0.5').Source, 'pjlink');
});

test('a non-PJLink hint is still upgraded by a later, better one', () => {
  // The guard is specifically about not LOSING pjlink, not about freezing the
  // first hint that arrives.
  MergeNetworkDiscoveryResult({ Address: '10.0.0.5', Source: 'probe' });
  MergeNetworkDiscoveryResult({ Address: '10.0.0.5', Source: 'bonjour', MethodHint: 'web' });
  assert.equal(at('10.0.0.5').MethodHint, 'web');
});

test('bonjour services accumulate but never duplicate', () => {
  // The same service is re-announced periodically; without dedupe the list
  // would grow without bound for as long as the scan is open.
  for (let i = 0; i < 5; i++) {
    MergeNetworkDiscoveryResult({
      Address: '10.0.0.5',
      Source: 'bonjour',
      ServiceType: '_http._tcp',
      Port: 80,
    });
  }
  MergeNetworkDiscoveryResult({
    Address: '10.0.0.5',
    Source: 'bonjour',
    ServiceType: '_pjlink._tcp',
    Port: 4352,
  });

  const Services = at('10.0.0.5').Services;
  assert.equal(Services.length, 2);
  assert.deepEqual(Services.map((S) => S.type).sort(), ['_http._tcp', '_pjlink._tcp']);
});

test('the same service type on a different port is a separate entry', () => {
  MergeNetworkDiscoveryResult({
    Address: '10.0.0.5',
    Source: 'bonjour',
    ServiceType: '_http._tcp',
    Port: 80,
  });
  MergeNetworkDiscoveryResult({
    Address: '10.0.0.5',
    Source: 'bonjour',
    ServiceType: '_http._tcp',
    Port: 8080,
  });
  assert.equal(at('10.0.0.5').Services.length, 2);
});

test('a non-bonjour result contributes no service entry', () => {
  MergeNetworkDiscoveryResult({
    Address: '10.0.0.5',
    Source: 'probe',
    ServiceType: '_http._tcp',
    Port: 80,
  });
  assert.deepEqual(at('10.0.0.5').Services, []);
});

test('a result with no usable address is ignored', () => {
  for (const Result of [null, undefined, {}, { Address: '' }, { Address: '   ' }]) {
    MergeNetworkDiscoveryResult(Result);
  }
  assert.equal(results().size, 0);
});

test('resetting discovery clears the accumulated results', () => {
  MergeNetworkDiscoveryResult({ Address: '10.0.0.5', Source: 'probe' });
  assert.equal(results().size, 1);

  ResetNetworkDiscoveryState();
  assert.equal(State.NetworkDiscoveryResults.size, 0);
});

// --- Payload construction ---------------------------------------------------

function editorState(Overrides = {}) {
  State.setMonitoringEditorState({
    Nickname: 'Rack UPS',
    Interval: 30000,
    GroupID: 1,
    Slug: '',
    OriginalSlug: '',
    Checks: [],
    ...Overrides,
  });
}

const check = (O = {}) => ({
  Name: 'Battery',
  Address: '10.0.0.9',
  Method: 'ping',
  Settings: {},
  DegradedThresholdMs: 500,
  ...O,
});

test('the payload carries the editor state through', () => {
  editorState({ Checks: [check()] });
  const Payload = BuildMonitoringPayload();

  assert.equal(Payload.Nickname, 'Rack UPS');
  assert.equal(Payload.Interval, 30000);
  assert.equal(Payload.GroupID, 1);
  assert.equal(Payload.Checks.length, 1);
  assert.equal(Payload.Checks[0].Method, 'ping');
});

test('whitespace is trimmed from the name and addresses', () => {
  editorState({ Nickname: '  Rack UPS  ', Checks: [check({ Address: '  10.0.0.9  ' })] });
  const Payload = BuildMonitoringPayload();

  assert.equal(Payload.Nickname, 'Rack UPS');
  assert.equal(Payload.Checks[0].Address, '10.0.0.9');
});

test('a negative or unusable degraded threshold floors at zero', () => {
  // A negative threshold would mark every reply degraded.
  editorState({
    Checks: [check({ DegradedThresholdMs: -100 }), check({ DegradedThresholdMs: 'soon' })],
  });
  const Payload = BuildMonitoringPayload();
  assert.equal(Payload.Checks[0].DegradedThresholdMs, 0);
  assert.equal(Payload.Checks[1].DegradedThresholdMs, 0);
});

test('the slug is only sent when the operator actually changed it', () => {
  // A slug is an OSC/API address. Re-sending an unchanged one is harmless, but
  // sending one that was never set would mint an identifier the operator did
  // not ask for and that external integrations would then depend on.
  editorState({ Slug: '', OriginalSlug: '' });
  assert.ok(!('Slug' in BuildMonitoringPayload()));

  editorState({ Slug: 'rack-ups', OriginalSlug: 'rack-ups' });
  assert.ok(!('Slug' in BuildMonitoringPayload()), 'an unchanged slug should not be resent');

  editorState({ Slug: 'rack-ups-2', OriginalSlug: 'rack-ups' });
  assert.equal(BuildMonitoringPayload().Slug, 'rack-ups-2');
});

test('a blank slug never clears an existing one by accident', () => {
  editorState({ Slug: '   ', OriginalSlug: 'rack-ups' });
  assert.ok(!('Slug' in BuildMonitoringPayload()));
});

test('an existing check keeps its id so it is updated, not recreated', () => {
  // Losing the CheckID would delete and recreate the check, discarding its
  // entire status history.
  editorState({ Checks: [check({ CheckID: 42 }), check()] });
  const Payload = BuildMonitoringPayload();

  assert.equal(Payload.Checks[0].CheckID, 42);
  assert.ok(!('CheckID' in Payload.Checks[1]), 'a new check must not carry a null id');
});

// --- The save gate ----------------------------------------------------------

test('a fully configured target is valid', () => {
  editorState({ Checks: [check()] });
  assert.equal(MonitoringPayloadIsValid(BuildMonitoringPayload()), true);
});

test('a target with no checks is valid, and renders as degraded', () => {
  // Deliberate: an operator can create the target first and add checks after.
  editorState({ Checks: [] });
  assert.equal(MonitoringPayloadIsValid(BuildMonitoringPayload()), true);
});

test('a target with no name cannot be saved', () => {
  // The name is how it appears in the client list; an unnamed target is
  // unfindable.
  for (const Nickname of ['', '   ']) {
    editorState({ Nickname, Checks: [check()] });
    assert.equal(MonitoringPayloadIsValid(BuildMonitoringPayload()), false);
  }
});

test('a check with no method cannot be saved', () => {
  editorState({ Checks: [check({ Method: '' })] });
  assert.equal(MonitoringPayloadIsValid(BuildMonitoringPayload()), false);
});

test('a check that needs an address cannot be saved without one', () => {
  // The failure this prevents: a saved check that silently never runs, while
  // the target sits in the list looking monitored.
  for (const Address of ['', '   ']) {
    editorState({ Checks: [check({ Address })] });
    assert.equal(MonitoringPayloadIsValid(BuildMonitoringPayload()), false);
  }
});

test('a method that does not use an address can be saved without one', () => {
  // The other direction: a network-wide NDI discovery has no address to give,
  // and requiring one would make it impossible to configure at all.
  editorState({ Checks: [check({ Method: 'ndi-source', Address: '' })] });
  assert.equal(MonitoringPayloadIsValid(BuildMonitoringPayload()), true);
});

test('an unknown method is assumed to need an address', () => {
  // Fail closed: if the renderer has not been told whether a method uses an
  // address, requiring one is the safer default — a check with a spurious
  // address is fixable, one that silently never runs is not noticed.
  editorState({ Checks: [check({ Method: 'method-from-the-future', Address: '' })] });
  assert.equal(MonitoringPayloadIsValid(BuildMonitoringPayload()), false);

  editorState({ Checks: [check({ Method: 'method-from-the-future', Address: '10.0.0.1' })] });
  assert.equal(MonitoringPayloadIsValid(BuildMonitoringPayload()), true);
});

test('one bad check invalidates the whole payload', () => {
  editorState({ Checks: [check(), check({ Address: '' })] });
  assert.equal(MonitoringPayloadIsValid(BuildMonitoringPayload()), false);
});
