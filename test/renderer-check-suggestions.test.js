const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/lib/check-suggestions.ts: how the LAN discovery wizard
// turns what a scan saw on an address into a ranked list of checks.
//
// The ranking is the point. The first suggestion is what Add uses unless the
// operator changes it, so a vague match (an open web port) must never outrank
// a specific one (a HyperDeck's control port) on the same device.
//
// Loaded from dist-test/ (see test/renderer-utils.test.js for why).
const {
  SuggestChecks,
  FALLBACK_METHOD,
} = require('../dist-test/UI/js/app/lib/check-suggestions.js');

const METHODS = [
  { ID: 'ping', Name: 'Ping', Settings: [], Discovery: null },
  {
    ID: 'http',
    Name: 'HTTP',
    Settings: [
      { Key: 'Protocol', Type: 'select', Default: 'https' },
      { Key: 'Port', Type: 'number', Default: 0 },
    ],
    Discovery: {
      Confidence: 'low',
      TcpPorts: [80, 8080, 443],
      ServiceTypes: ['_http._tcp', '_https._tcp'],
      PortSetting: 'Port',
      PortSettings: {
        80: { Protocol: 'http' },
        8080: { Protocol: 'http' },
        443: { Protocol: 'https' },
      },
      ServiceSettings: { '_http._tcp': { Protocol: 'http' }, '_https._tcp': { Protocol: 'https' } },
    },
  },
  {
    ID: 'hyperdeck',
    Name: 'HyperDeck',
    Settings: [{ Key: 'Port', Type: 'number', Default: 9993, Required: true }],
    Discovery: { Confidence: 'high', TcpPorts: [9993], PortSetting: 'Port' },
  },
  {
    ID: 'qlab5',
    Name: 'QLab 5',
    Settings: [{ Key: 'Port', Type: 'number', Default: 53000, Required: true }],
    Discovery: {
      Confidence: 'high',
      TcpPorts: [53000],
      ServiceTypes: ['_qlab._tcp'],
      PortSetting: 'Port',
    },
  },
  {
    ID: 'qlab4',
    Name: 'QLab 4',
    Settings: [{ Key: 'Port', Type: 'number', Default: 53000, Required: true }],
    Discovery: {
      Confidence: 'medium',
      TcpPorts: [53000],
      ServiceTypes: ['_qlab._tcp'],
      PortSetting: 'Port',
    },
  },
  {
    ID: 'dante-device',
    Name: 'Dante Device',
    UsesAddress: false,
    Settings: [{ Key: 'DeviceName', Type: 'string', Default: '', Required: true }],
    Discovery: {
      Confidence: 'high',
      ServiceTypes: ['_netaudio-arc._udp'],
      NameSetting: 'DeviceName',
    },
  },
  {
    ID: 'mqtt-topic',
    Name: 'MQTT Topic',
    Settings: [
      { Key: 'Port', Type: 'number', Default: 1883, Required: true },
      { Key: 'Topic', Type: 'string', Default: '', Required: true },
    ],
    Discovery: { Confidence: 'high', TcpPorts: [1883], PortSetting: 'Port' },
  },
  {
    ID: 'pjlink',
    Name: 'PJLink',
    Settings: [],
    Discovery: { Confidence: 'high', PJLink: true, TcpPorts: [4352] },
  },
];

const ids = (Suggestions) => Suggestions.map((S) => S.Method);

test('a host with nothing recognisable still gets Ping', () => {
  assert.deepEqual(ids(SuggestChecks({ OpenPorts: [22, 445] }, METHODS)), [FALLBACK_METHOD]);
  assert.deepEqual(ids(SuggestChecks({}, METHODS)), [FALLBACK_METHOD]);
});

test('Ping is always last, and only offered when installed', () => {
  const S = SuggestChecks({ OpenPorts: [80] }, METHODS);
  assert.equal(S[S.length - 1].Method, 'ping');
  const NoPing = METHODS.filter((M) => M.ID !== 'ping');
  assert.deepEqual(ids(SuggestChecks({ OpenPorts: [80] }, NoPing)), ['http']);
});

test('a specific port outranks a generic web port on the same device', () => {
  // HyperDecks serve a web page too. The control port is what identifies one.
  const S = SuggestChecks({ OpenPorts: [80, 9993] }, METHODS);
  assert.deepEqual(ids(S), ['hyperdeck', 'http', 'ping']);
  assert.equal(S[0].Reason, 'Port 9993 open');
});

test('equal confidence is broken by how many signals agreed', () => {
  // QLab 5 (high) still beats QLab 4 (medium) whatever the signals; within a
  // confidence level, an advertised service AND an open port beats one alone.
  const S = SuggestChecks(
    { OpenPorts: [53000, 9993], Services: [{ type: '_qlab._tcp', port: 53000 }] },
    METHODS
  );
  assert.deepEqual(ids(S), ['qlab5', 'hyperdeck', 'qlab4', 'ping']);
  assert.equal(S[0].Reason, 'Advertises _qlab._tcp · Port 53000 open');
});

test('service types match case-insensitively', () => {
  const S = SuggestChecks({ Services: [{ type: '_QLab._TCP', port: 53000 }] }, METHODS);
  assert.equal(S[0].Method, 'qlab5');
});

test('the port is only pre-filled when it differs from the default', () => {
  // A default-port match leaves the setting alone so the check keeps following
  // the method's default; an unusual port is carried over so it connects.
  const Default = SuggestChecks({ OpenPorts: [9993] }, METHODS)[0];
  assert.deepEqual(Default.Settings, {});

  const Web = SuggestChecks({ OpenPorts: [8080] }, METHODS)[0];
  assert.equal(Web.Method, 'http');
  assert.deepEqual(Web.Settings, { Protocol: 'http', Port: 8080 });
});

test('a probed port wins over an advertised one', () => {
  const S = SuggestChecks(
    { OpenPorts: [80], Services: [{ type: '_http._tcp', port: 8080 }] },
    METHODS
  );
  assert.deepEqual(S[0].Settings, { Protocol: 'http', Port: 80 });
});

test('name-matched methods take the advertised instance name', () => {
  const S = SuggestChecks(
    { Services: [{ type: '_netaudio-arc._udp', port: 4440, name: 'Stage-Box-1' }] },
    METHODS
  );
  assert.equal(S[0].Method, 'dante-device');
  assert.deepEqual(S[0].Settings, { DeviceName: 'Stage-Box-1' });
  assert.equal(S[0].NeedsSetup, false);
});

test('a suggestion with an empty required setting is flagged as needing setup', () => {
  // MQTT needs a topic nobody can discover; the operator should know before
  // adding a check that will fail until it is filled in.
  const S = SuggestChecks({ OpenPorts: [1883] }, METHODS);
  assert.equal(S[0].Method, 'mqtt-topic');
  assert.equal(S[0].NeedsSetup, true);
  // A required setting that has a default is not missing.
  assert.equal(SuggestChecks({ OpenPorts: [9993] }, METHODS)[0].NeedsSetup, false);
});

test('a PJLink reply matches PJLink', () => {
  const S = SuggestChecks({ PJLink: true }, METHODS);
  assert.equal(S[0].Method, 'pjlink');
  assert.equal(S[0].Reason, 'Answered PJLink search');
});

test('methods without a discovery signature are never suggested', () => {
  const Methods = [...METHODS, { ID: 'tcp-port', Name: 'TCP Port', Settings: [] }];
  assert.ok(!ids(SuggestChecks({ OpenPorts: [80, 9993] }, Methods)).includes('tcp-port'));
});

test('the matched port or service sets the protocol a dual-protocol method uses', () => {
  // The HTTP method defaults to HTTPS; a device found on port 80 would fail
  // every probe if that default were left alone.
  const Secure = SuggestChecks({ OpenPorts: [443] }, METHODS)[0];
  assert.deepEqual(Secure.Settings, { Protocol: 'https', Port: 443 });

  const Advertised = SuggestChecks({ Services: [{ type: '_https._tcp', port: 8443 }] }, METHODS)[0];
  assert.deepEqual(Advertised.Settings, { Protocol: 'https', Port: 8443 });

  // An open port overrides what was advertised, protocol included.
  const Both = SuggestChecks(
    { OpenPorts: [80], Services: [{ type: '_https._tcp', port: 8443 }] },
    METHODS
  )[0];
  assert.deepEqual(Both.Settings, { Protocol: 'http', Port: 80 });
});
