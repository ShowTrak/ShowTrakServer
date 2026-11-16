const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

// Exercises src/Modules/MonitoringMethods/igmp-querier.ts (IGMP querier per
// interface from IGMP-STD-MIB, RFC 2933, or MGMD-STD-MIB, RFC 5519).
//
// Only `net-snmp` is stubbed. The stub agent holds a flat OID -> varbind map
// and answers subtree() like net-snmp does: varbinds under the base OID, in
// OID order, fed in chunks, then doneCb(null); get() returns a varbind per OID
// with exception type 128 (noSuchObject) for anything it does not hold.

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

const T = { Integer: 2, OctetString: 4, IpAddress: 64, Gauge: 66, TimeTicks: 67 };
const IGMP = '1.3.6.1.2.1.85.1.1.1';
const MGMD = '1.3.6.1.2.1.185.1.2.1';
const IF_NAME = '1.3.6.1.2.1.31.1.1.1.1';
const IF_DESCR = '1.3.6.1.2.1.2.2.1.2';

// IGMP-STD-MIB rows: { ifIndex: { status, version, querier, upTime, expiry } }.
function igmpTable(rows) {
  const out = {};
  for (const [idx, r] of Object.entries(rows)) {
    if (r.status != null) out[`${IGMP}.3.${idx}`] = { type: T.Integer, value: r.status };
    if (r.version != null) out[`${IGMP}.4.${idx}`] = { type: T.Gauge, value: r.version };
    if (r.querier != null) out[`${IGMP}.5.${idx}`] = { type: T.IpAddress, value: r.querier };
    if (r.upTime != null) out[`${IGMP}.7.${idx}`] = { type: T.TimeTicks, value: r.upTime };
    if (r.expiry != null) out[`${IGMP}.8.${idx}`] = { type: T.TimeTicks, value: r.expiry };
    out[`${IGMP}.13.${idx}`] = { type: T.Gauge, value: 4 }; // igmpInterfaceGroups
  }
  return out;
}

function names(map) {
  const out = {};
  for (const [idx, name] of Object.entries(map)) {
    out[`${IF_NAME}.${idx}`] = { type: T.OctetString, value: Buffer.from(name) };
  }
  return out;
}

function defaultValues() {
  return {
    ...igmpTable({
      10: { status: 1, version: 2, querier: '10.0.10.1', upTime: 360000, expiry: 0 },
      20: { status: 1, version: 2, querier: '10.0.20.254', upTime: 6000, expiry: 21000 },
    }),
    ...names({ 10: 'vlan10', 20: 'vlan20' }),
  };
}

function compareOids(a, b) {
  const A = a.split('.').map(Number);
  const B = b.split('.').map(Number);
  for (let i = 0; i < Math.min(A.length, B.length); i++) if (A[i] !== B[i]) return A[i] - B[i];
  return A.length - B.length;
}

function makeSnmp(Options = {}) {
  const {
    values = defaultValues(),
    transportError = null,
    neverReply = false,
    walkAgentError = false,
  } = Options;
  const Snmp = {
    Version1: 'V1',
    Version2c: 'V2C',
    Version3: 'V3',
    AuthProtocols: { none: 'a:none', sha: 'a:sha', sha256: 'a:sha256', md5: 'a:md5' },
    PrivProtocols: { none: 'p:none', aes: 'p:aes', des: 'p:des' },
    SecurityLevel: { noAuthNoPriv: 'nn', authNoPriv: 'an', authPriv: 'ap' },
    sessions: [],
    created: [],
    createSession(address, community, options) {
      Snmp.created.push({ kind: 'v2', address, community, options });
      return Snmp.__makeSession();
    },
    createV3Session(address, user, options) {
      Snmp.created.push({ kind: 'v3', address, user, options });
      return Snmp.__makeSession();
    },
    __makeSession() {
      const Session = {
        closes: 0,
        walks: [],
        gets: [],
        on() {},
        close() {
          Session.closes += 1;
        },
        subtree(base, maxRep, feed, done) {
          Session.walks.push(base);
          if (neverReply) return;
          if (transportError) return void setImmediate(() => done(new Error(transportError)));
          if (walkAgentError) {
            const Err = new Error('genErr');
            Err.name = 'RequestFailedError';
            Err.status = 5;
            return void setImmediate(() => done(Err));
          }
          const oids = Object.keys(values)
            .filter((o) => o.startsWith(base + '.'))
            .sort(compareOids);
          setImmediate(() => {
            for (let i = 0; i < oids.length; i += maxRep) {
              const chunk = oids.slice(i, i + maxRep).map((o) => ({ oid: o, ...values[o] }));
              if (feed(chunk)) break;
            }
            done(null);
          });
        },
        get(oids, cb) {
          Session.gets.push(oids);
          setImmediate(() =>
            cb(
              null,
              oids.map((o) => (values[o] ? { oid: o, ...values[o] } : { oid: o, type: 128 }))
            )
          );
        },
      };
      Snmp.sessions.push(Session);
      return Session;
    },
  };
  return Snmp;
}

function load(Snmp) {
  return loadWithMocks(methodPath('igmp-querier.js'), { 'net-snmp': Snmp });
}

const target = (Settings = {}, Address = '10.0.0.2') => ({
  Address,
  Settings: { Timeout: 1000, ...Settings },
});

// --- Happy path ------------------------------------------------------------

test('every interface with a querier is Online, with names and local querier', async () => {
  const Snmp = makeSnmp();
  const M = load(Snmp);
  const R = await M.Run(target());
  assert.equal(R.Success, true);
  assert.equal(R.Degraded, undefined);
  assert.equal(R.Mib, 'igmp');
  assert.equal(R.Rows.length, 2);
  const [v10, v20] = R.Rows;
  assert.equal(v10.IfName, 'vlan10');
  assert.equal(v10.Querier, '10.0.10.1');
  assert.equal(v10.IsLocal, true, 'expiry 0 with a querier means this device');
  assert.equal(v20.IsLocal, false);
  assert.equal(v20.IgmpVersion, 2);
  assert.deepEqual(Snmp.sessions[0].walks, [IGMP]);
  assert.equal(Snmp.sessions[0].closes, 1);
  assert.equal(Snmp.created[0].community, 'public');
});

test('listed interfaces match by name or ifIndex; others are not judged', async () => {
  const values = {
    ...defaultValues(),
    ...igmpTable({ 30: { status: 1, querier: '0.0.0.0' } }),
    ...names({ 30: 'vlan30' }),
  };
  const M = load(makeSnmp({ values }));
  const R = await M.Run(target({ Interfaces: ['VLAN10', '20'] }));
  assert.equal(R.Success, true);
  assert.equal(R.Degraded, undefined);
  assert.deepEqual(
    R.Verdicts.map((v) => [v.Label, v.Verdict]),
    [
      ['VLAN10', 'ok'],
      ['20', 'ok'],
    ]
  );
});

// --- Degraded / Offline conditions -------------------------------------------

test('no querier (0.0.0.0) on an interface is Degraded by default', async () => {
  const values = {
    ...defaultValues(),
    ...igmpTable({ 30: { status: 1, querier: '0.0.0.0' } }),
    ...names({ 30: 'vlan30' }),
  };
  const M = load(makeSnmp({ values }));
  const R = await M.Run(target());
  assert.equal(R.Success, true);
  assert.equal(R.Degraded, true);
  assert.equal(R.DegradedReason, 'vlan30: no querier');
});

test('MissingState offline turns a missing querier into Offline, rows kept', async () => {
  const values = { ...defaultValues(), ...igmpTable({ 30: { status: 1, querier: '0.0.0.0' } }) };
  const M = load(makeSnmp({ values }));
  const T = target({ MissingState: 'offline' });
  const R = await M.Run(T);
  assert.equal(R.Success, false);
  assert.equal(R.AgentAnswered, true);
  assert.match(R.Error, /ifIndex 30: no querier/);
  const Html = M.Debug(R, T);
  assert.match(Html, /No querier/);
  assert.match(Html, /Reply time/);
});

test('a listed interface absent from the table, or inactive, counts as missing', async () => {
  const values = { ...defaultValues(), ...igmpTable({ 40: { status: 2, querier: '10.0.40.1' } }) };
  const M = load(makeSnmp({ values }));
  const R = await M.Run(target({ Interfaces: ['vlan99', '40'] }));
  assert.equal(R.Degraded, true);
  assert.match(R.DegradedReason, /vlan99: not in the IGMP table/);
  assert.match(R.DegradedReason, /40: IGMP not active/);
});

test('inactive rows are ignored when no interfaces are listed', async () => {
  const values = { ...defaultValues(), ...igmpTable({ 40: { status: 2 } }) };
  const M = load(makeSnmp({ values }));
  const R = await M.Run(target());
  assert.equal(R.Degraded, undefined);
});

test('an unexpected querier is Degraded, even with MissingState offline', async () => {
  const M = load(makeSnmp());
  const R = await M.Run(target({ ExpectedQuerier: '10.0.10.1', MissingState: 'offline' }));
  assert.equal(R.Success, true);
  assert.equal(R.Degraded, true);
  assert.equal(R.DegradedReason, 'vlan20: querier 10.0.20.254 (expected 10.0.10.1)');
});

test('an invalid expected querier is refused', async () => {
  const M = load(makeSnmp());
  const R = await M.Run(target({ ExpectedQuerier: 'core-switch' }));
  assert.equal(R.Success, false);
  assert.match(R.Error, /not an IPv4 address/);
});

// --- MGMD fallback --------------------------------------------------------------

test('Automatic falls back to MGMD-STD-MIB, reading ipv4 rows only', async () => {
  const values = {
    // mgmdRouterInterfaceQuerier is an InetAddress: 4 raw octets for ipv4.
    [`${MGMD}.3.10.1`]: { type: T.OctetString, value: Buffer.from([10, 0, 10, 2]) },
    [`${MGMD}.5.10.1`]: { type: T.Integer, value: 1 },
    [`${MGMD}.6.10.1`]: { type: T.Gauge, value: 3 },
    [`${MGMD}.8.10.1`]: { type: T.TimeTicks, value: 100 },
    [`${MGMD}.9.10.1`]: { type: T.TimeTicks, value: 2000 },
    // An ipv6 (MLD) row on the same interface: skipped.
    [`${MGMD}.3.10.2`]: { type: T.OctetString, value: Buffer.alloc(16) },
    [`${MGMD}.5.10.2`]: { type: T.Integer, value: 1 },
    [`${IF_DESCR}.10`]: { type: T.OctetString, value: Buffer.from('Vlan 10\0') },
  };
  const Snmp = makeSnmp({ values });
  const M = load(Snmp);
  const R = await M.Run(target());
  assert.equal(R.Success, true, R.Error);
  assert.equal(R.Degraded, undefined);
  assert.equal(R.Mib, 'mgmd');
  assert.equal(R.Rows.length, 1);
  assert.equal(R.Rows[0].Querier, '10.0.10.2');
  assert.equal(R.Rows[0].IgmpVersion, 3);
  assert.equal(R.Rows[0].IfName, 'Vlan 10', 'ifDescr is the fallback name');
  assert.deepEqual(Snmp.sessions[0].walks, [IGMP, MGMD]);
});

test('no rows in either MIB is reported as no querier, with an honest note', async () => {
  const M = load(makeSnmp({ values: {} }));
  const T = target();
  const R = await M.Run(T);
  assert.equal(R.Success, true);
  assert.equal(R.Degraded, true);
  assert.equal(R.DegradedReason, 'No active IGMP interfaces reported');
  assert.match(M.Debug(R, T), /vendor MIB/);
});

test('Mib igmp does not fall back', async () => {
  const Snmp = makeSnmp({ values: {} });
  const M = load(Snmp);
  await M.Run(target({ Mib: 'igmp' }));
  assert.deepEqual(Snmp.sessions[0].walks, [IGMP]);
});

// --- Offline ------------------------------------------------------------------

test('a transport error is Offline and the session is closed', async () => {
  const Snmp = makeSnmp({ transportError: 'Request timed out' });
  const M = load(Snmp);
  const R = await M.Run(target());
  assert.equal(R.Success, false);
  assert.equal(R.Error, 'Request timed out');
  assert.equal(Snmp.sessions[0].closes, 1);
});

test('an agent that never replies times out within the budget', async () => {
  const Snmp = makeSnmp({ neverReply: true });
  const M = load(Snmp);
  const Started = Date.now();
  const R = await M.Run(target({ Timeout: 500 }));
  assert.equal(R.Success, false);
  assert.match(R.Error, /No SNMP reply within 500 ms/);
  assert.ok(Date.now() - Started < 1500);
  assert.equal(Snmp.sessions[0].closes, 1);
});

test('an agent error status ends the walk without going Offline', async () => {
  const M = load(makeSnmp({ walkAgentError: true }));
  const R = await M.Run(target());
  assert.equal(R.Success, true);
  assert.equal(R.Degraded, true);
});

test('v3 credentials are validated and used', async () => {
  const Snmp = makeSnmp();
  const M = load(Snmp);
  const Bad = await M.Run(target({ Version: '3' }));
  assert.match(Bad.Error, /No SNMPv3 username/);
  const R = await M.Run(
    target({
      Version: '3',
      Username: 'mon',
      AuthProtocol: 'sha',
      AuthPassword: 'pw12345678',
      PrivProtocol: 'none',
    })
  );
  assert.equal(R.Success, true);
  assert.equal(Snmp.created[0].kind, 'v3');
  assert.equal(Snmp.created[0].user.name, 'mon');
});

// --- Parsing --------------------------------------------------------------------

test('malformed varbinds are skipped and queriers decoded defensively', () => {
  const { BuildRows, DecodeQuerier } = load(makeSnmp())._internal;
  assert.equal(DecodeQuerier('10.1.2.3'), '10.1.2.3');
  assert.equal(DecodeQuerier('0.0.0.0'), null);
  assert.equal(DecodeQuerier('300.1.1.1'), null);
  assert.equal(DecodeQuerier(Buffer.from([192, 168, 1, 1])), '192.168.1.1');
  assert.equal(DecodeQuerier(Buffer.from([1, 2, 3])), null);
  assert.equal(DecodeQuerier(null), null);
  const Rows = BuildRows('igmp', [
    null,
    { oid: '1.3.6.1.2.1.1.1.0', value: 'x' },
    { oid: `${IGMP}.5.7`, type: 128 },
    { oid: `${IGMP}.5.0`, type: T.IpAddress, value: '1.1.1.1' },
    { oid: `${IGMP}.5.8.1`, type: T.IpAddress, value: '1.1.1.1' },
    { oid: `${IGMP}.5.9`, type: T.IpAddress, value: { bogus: true } },
    { oid: `${IGMP}.3.9`, type: T.Integer, value: 'active' },
  ]);
  assert.equal(Rows.length, 1);
  assert.equal(Rows[0].IfIndex, 9);
  assert.equal(Rows[0].Querier, null);
  assert.equal(Rows[0].Status, null);
});

// --- Debug ---------------------------------------------------------------------

test('Debug escapes interface names and never shows the community', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  const values = { ...defaultValues(), ...names({ 10: evil }) };
  const M = load(makeSnmp({ values }));
  const T = target({ Community: 'S3cretCommunity', Interfaces: ['<b>x</b>', '10'] });
  const R = await M.Run(T);
  const Html = M.Debug(R, T);
  assert.ok(!Html.includes('<img'), Html);
  assert.ok(!Html.includes('<b>x'));
  assert.ok(Html.includes('&lt;img'));
  assert.ok(!Html.includes('S3cretCommunity'));
  assert.match(Html, /this device/);
  const Offline = M.Debug({ Success: false, Error: '<svg onload=1>' }, T);
  assert.ok(!Offline.includes('<svg'));
  assert.match(Offline, /Failed to read the IGMP table/);
});
