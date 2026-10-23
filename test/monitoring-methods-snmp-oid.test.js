const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

// Exercises src/Modules/MonitoringMethods/snmp-oid.ts (generic SNMP GET with
// per-OID assertions) and the SNMPv3 credential helpers it shares with
// snmp-ups-v3 via _snmp-shared.ts.
//
// Only `net-snmp` is stubbed. The stub answers like a real agent would: a
// varbind per requested OID, with the BER type tag, an exception type
// (128/129/130) for a missing object, and — in v1 mode — a whole-request
// RequestFailedError(noSuchName) when any OID is missing.

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

const T = { Integer: 2, OctetString: 4, Null: 5, OID: 6, IpAddress: 64 };
Object.assign(T, { Counter: 65, Gauge: 66, TimeTicks: 67, Counter64: 70 });

const SYS_UPTIME = '1.3.6.1.2.1.1.3.0';
const SYS_NAME = '1.3.6.1.2.1.1.5.0';
const SYS_DESCR = '1.3.6.1.2.1.1.1.0';
const IF_OPER = '1.3.6.1.2.1.2.2.1.8.1';
const IF_HC_IN = '1.3.6.1.2.1.31.1.1.1.6.1';
const IF_MAC = '1.3.6.1.2.1.2.2.1.6.1';

function agentValues(Overrides = {}) {
  return {
    [SYS_UPTIME]: { type: T.TimeTicks, value: 8640000 }, // 1 day
    [SYS_NAME]: { type: T.OctetString, value: Buffer.from('Stage Left\0\0') },
    [SYS_DESCR]: { type: T.OctetString, value: Buffer.from('Acme Switch 9000') },
    [IF_OPER]: { type: T.Integer, value: 1 },
    [IF_HC_IN]: {
      type: T.Counter64,
      value: Buffer.from('0100000000000000', 'hex'), // 2^56: beyond Number precision
    },
    [IF_MAC]: { type: T.OctetString, value: Buffer.from('001a2b3c4d5e', 'hex') },
    ...Overrides,
  };
}

class RequestFailedError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'RequestFailedError';
    this.status = status;
  }
}

function makeSnmp(Options = {}) {
  const {
    values = agentValues(),
    v1 = false,
    transportError = null,
    createThrows = null,
    neverReply = false,
    pduError = null,
  } = Options;

  const Snmp = {
    Version1: 'V1',
    Version2c: 'V2C',
    Version3: 'V3',
    AuthProtocols: {
      none: 'auth:none',
      sha: 'auth:sha',
      sha256: 'auth:sha256',
      sha512: 'auth:sha512',
      sha224: 'auth:sha224',
      sha384: 'auth:sha384',
      md5: 'auth:md5',
    },
    PrivProtocols: {
      none: 'priv:none',
      aes: 'priv:aes',
      aes256b: 'priv:aes256b',
      aes256r: 'priv:aes256r',
      des: 'priv:des',
    },
    SecurityLevel: { noAuthNoPriv: 'noAuthNoPriv', authNoPriv: 'authNoPriv', authPriv: 'authPriv' },
    isVarbindError: (Vb) => !!(Vb && Vb.type >= 128 && Vb.type <= 130),
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
      if (createThrows) throw new Error(createThrows);
      const Session = {
        closes: 0,
        gets: [],
        handlers: {},
        on(event, fn) {
          Session.handlers[event] = fn;
        },
        close() {
          Session.closes += 1;
        },
        get(oids, cb) {
          Session.gets.push(oids);
          if (neverReply) return;
          if (transportError) return void cb(new Error(transportError));
          if (pduError && oids.length > 1) {
            return void cb(new RequestFailedError(pduError.message, pduError.status));
          }
          const Has = (Oid) => Object.prototype.hasOwnProperty.call(values, Oid);
          if (v1) {
            const Missing = oids.find((Oid) => !Has(Oid));
            if (Missing) return void cb(new RequestFailedError(`NoSuchName: ${Missing}`, 2));
          }
          cb(
            null,
            oids.map((Oid) => (Has(Oid) ? { oid: Oid, ...values[Oid] } : { oid: Oid, type: 128 }))
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
  return loadWithMocks(methodPath('snmp-oid.js'), { 'net-snmp': Snmp });
}

const target = (Settings = {}, Address = '10.0.0.40') => ({ Address, Settings });

// --- Entry parsing -------------------------------------------------------------

test('entries parse into OID, comparison and value', () => {
  const { ParseEntry } = load(makeSnmp())._internal;
  const P = (S) => {
    const E = ParseEntry(S);
    return [E.Oid, E.Op, E.Expected];
  };
  assert.deepEqual(P('1.3.6.1.2.1.1.5.0'), ['1.3.6.1.2.1.1.5.0', 'present', '']);
  assert.deepEqual(P('.1.3.6.1.2.1.1.5.0 = Stage Left'), [SYS_NAME, 'equals', 'Stage Left']);
  assert.deepEqual(P('1.3.6.1.2.1.1.5.0=Stage'), [SYS_NAME, 'equals', 'Stage']);
  assert.deepEqual(P('1.3.6.1.2.1.1.5.0 == x'), [SYS_NAME, 'equals', 'x']);
  assert.deepEqual(P('1.3.6.1.2.1.1.5.0 != x'), [SYS_NAME, 'not-equals', 'x']);
  assert.deepEqual(P('1.3.6.1.2.1.1.5.0 <> x'), [SYS_NAME, 'not-equals', 'x']);
  assert.deepEqual(P('1.3.6 > 10'), ['1.3.6', 'greater', '10']);
  assert.deepEqual(P('1.3.6 < -2.5'), ['1.3.6', 'less', '-2.5']);
  assert.deepEqual(P('1.3.6 CONTAINS Acme Switch'), ['1.3.6', 'contains', 'Acme Switch']);
  assert.deepEqual(P('1.3.6 present'), ['1.3.6', 'present', '']);
  assert.deepEqual(P('1.3.6 = " padded "'), ['1.3.6', 'equals', ' padded ']);
  assert.deepEqual(P('1.3.6 = ""'), ['1.3.6', 'equals', '']);
});

test('malformed entries are rejected with a message naming the entry', () => {
  const { ParseEntry } = load(makeSnmp())._internal;
  for (const [Bad, Pattern] of [
    ['sysName.0', /numeric OID/],
    ['iso.3.6.1', /numeric OID/],
    ['1', /numeric OID/],
    ['1.3.6.1x = 2', /invalid OID/],
    ['1.3.6.1. = 2', /invalid OID/],
    ['1.3.6.1 ~ 2', /unknown comparison/],
    ['1.3.6.1 equals 2', /unknown comparison/],
    ['1.3.6.1 > warm', /needs a number/],
    ['1.3.6.1 <', /needs a number/],
    ['1.3.6.1 contains', /contains needs a value/],
    ['1.3.6.1 contains ""', /contains needs a value/],
    ['1.3.6.1 =', /= needs a value/],
    ['1.3.6.1 present yes', /present takes no value/],
    ['1.3.6.99999999999', /numeric OID/],
  ]) {
    assert.throws(() => ParseEntry(Bad), Pattern, Bad);
  }
});

test('an invalid entry fails the check with a config error, without touching the network', async () => {
  const Snmp = makeSnmp();
  const M = load(Snmp);
  const R = await M.Run(target({ Oids: [SYS_NAME, 'not-an-oid'] }));
  assert.equal(R.Success, false);
  assert.match(R.Error, /Invalid OID entry "not-an-oid"/);
  assert.equal(Snmp.sessions.length, 0);
});

test('config errors: address, port, empty list, too many entries, v3 credentials', async () => {
  const M = load(makeSnmp());
  assert.equal((await M.Run(target({}, ''))).Error, 'No address configured');
  assert.match((await M.Run(target({ Port: 70000 }))).Error, /Invalid port/);
  assert.equal((await M.Run(target({ Oids: [] }))).Error, 'No OIDs configured');
  const Many = Array.from({ length: 65 }, (_, I) => `1.3.6.1.4.1.${I}`);
  assert.match((await M.Run(target({ Oids: Many }))).Error, /Too many/);
  assert.equal(
    (await M.Run(target({ Version: '3', Oids: [SYS_NAME] }))).Error,
    'No SNMPv3 username configured'
  );
  assert.equal(
    (await M.Run(target({ Version: '3', Username: 'ops', Oids: [SYS_NAME] }))).Error,
    'Auth password required when an auth protocol is set'
  );
});

// --- Happy path ----------------------------------------------------------------

test('reads every OID in one GET, de-duplicated, with type and decoded value', async () => {
  const Snmp = makeSnmp();
  const M = load(Snmp);
  const R = await M.Run(
    target({
      Oids: [
        SYS_UPTIME,
        `${SYS_NAME} = stage left`,
        `${IF_OPER} = 1`,
        `${IF_HC_IN} > 72057594037927935`,
        `${IF_HC_IN} < 72057594037927937`,
        `${IF_MAC} = 00:1A:2B:3C:4D:5E`,
        `${SYS_DESCR} contains switch`,
      ],
    })
  );
  assert.equal(R.Success, true, R.DegradedReason);
  assert.ok(!R.Degraded, R.DegradedReason);
  assert.equal(typeof R.LatencyMs, 'number');
  assert.equal(Snmp.sessions.length, 1);
  assert.deepEqual(Snmp.sessions[0].gets, [
    [SYS_UPTIME, SYS_NAME, IF_OPER, IF_HC_IN, IF_MAC, SYS_DESCR],
  ]);
  assert.equal(Snmp.sessions[0].closes, 1);

  const ByOid = Object.fromEntries(R.Values.map((V) => [V.Oid, V]));
  assert.deepEqual(ByOid[SYS_UPTIME], { Oid: SYS_UPTIME, Type: 'TimeTicks', Value: '8640000' });
  assert.deepEqual(ByOid[SYS_NAME], { Oid: SYS_NAME, Type: 'OctetString', Value: 'Stage Left' });
  assert.deepEqual(ByOid[IF_OPER], { Oid: IF_OPER, Type: 'Integer', Value: '1' });
  assert.equal(ByOid[IF_HC_IN].Type, 'Counter64');
  assert.equal(ByOid[IF_HC_IN].Value, '72057594037927936');
  assert.deepEqual(ByOid[IF_MAC], {
    Oid: IF_MAC,
    Type: 'OctetString',
    Value: '00 1A 2B 3C 4D 5E',
    Hex: true,
  });
  assert.equal(R.Assertions.length, 7);
  assert.ok(R.Assertions.every((A) => A.Passed));
  // The result must survive JSON (no Buffers, no bigints).
  assert.doesNotThrow(() => JSON.stringify(R));
});

test('v1 / v2c sessions carry the community, version and a budget-split timeout', async () => {
  for (const [Version, Expected] of [
    ['1', 'V1'],
    ['2c', 'V2C'],
    [undefined, 'V2C'],
    ['bogus', 'V2C'],
  ]) {
    const Snmp = makeSnmp();
    await load(Snmp).Run(
      target({ Version, Community: 'backstage', Oids: [SYS_NAME], Timeout: 3000, Retries: 2 })
    );
    const C = Snmp.created[0];
    assert.equal(C.kind, 'v2');
    assert.equal(C.community, 'backstage');
    assert.equal(C.options.version, Expected);
    assert.equal(C.options.port, 161);
    assert.equal(C.options.retries, 2);
    assert.equal(C.options.timeout, 1000, 'three attempts share the 3000 ms budget');
  }
});

test('v3 builds a USM user from the shared credential helpers', async () => {
  const Snmp = makeSnmp();
  const R = await load(Snmp).Run(
    target({
      Version: '3',
      Username: 'ops',
      AuthProtocol: 'sha256',
      AuthPassword: 'authpass1',
      PrivProtocol: 'aes',
      PrivPassword: 'privpass1',
      Context: 'bridge1',
      Oids: [SYS_NAME],
    })
  );
  assert.equal(R.Success, true);
  const C = Snmp.created[0];
  assert.equal(C.kind, 'v3');
  assert.equal(C.options.version, 'V3');
  assert.equal(C.options.context, 'bridge1');
  assert.deepEqual(C.user, {
    name: 'ops',
    level: 'authPriv',
    authProtocol: 'auth:sha256',
    authKey: 'authpass1',
    privProtocol: 'priv:aes',
    privKey: 'privpass1',
  });
});

// --- Degraded --------------------------------------------------------------------

test('a missing OID is Degraded, named once with its exception', async () => {
  const Values = agentValues();
  delete Values[IF_OPER];
  const Snmp = makeSnmp({
    values: {
      ...Values,
      '1.3.6.1.4.1.9.9.9.0': { type: 129 },
      '1.3.6.1.4.1.9.9.8.0': { type: 130 },
    },
  });
  const R = await load(Snmp).Run(
    target({
      Oids: [
        SYS_NAME,
        IF_OPER,
        `${IF_OPER} = 1`,
        '1.3.6.1.4.1.9.9.9.0',
        '1.3.6.1.4.1.9.9.8.0 present',
      ],
    })
  );
  assert.equal(R.Success, true);
  assert.equal(R.Degraded, true);
  assert.equal(
    R.DegradedReason,
    `${IF_OPER}: noSuchObject; 1.3.6.1.4.1.9.9.9.0: noSuchInstance; 1.3.6.1.4.1.9.9.8.0: endOfMibView`
  );
  const Oper = R.Values.find((V) => V.Oid === IF_OPER);
  assert.equal(Oper.Exception, 'noSuchObject');
  assert.equal(Oper.Value, null);
});

test('each assertion that fails names the OID, the value and the expectation', async () => {
  const Cases = [
    [`${IF_OPER} = 2`, `${IF_OPER} = 1 (expected = 2)`],
    [`${IF_OPER} != 1`, `${IF_OPER} = 1 (expected != 1)`],
    [`${IF_OPER} > 1`, `${IF_OPER} = 1 (expected > 1)`],
    [`${IF_OPER} < 1`, `${IF_OPER} = 1 (expected < 1)`],
    [`${SYS_NAME} = Stage Right`, `${SYS_NAME} = "Stage Left" (expected = Stage Right)`],
    [`${SYS_NAME} != STAGE LEFT`, `${SYS_NAME} = "Stage Left" (expected != STAGE LEFT)`],
    [
      `${SYS_DESCR} contains router`,
      `${SYS_DESCR} = "Acme Switch 9000" (expected to contain "router")`,
    ],
    [`${SYS_NAME} > 3`, `${SYS_NAME} = "Stage Left" is not a number (expected > 3)`],
    [
      `${IF_MAC} = 00:1a:2b:3c:4d:00`,
      `${IF_MAC} = 00 1A 2B 3C 4D 5E (expected = 00:1a:2b:3c:4d:00)`,
    ],
    [
      `${IF_HC_IN} > 72057594037927936`,
      `${IF_HC_IN} = 72057594037927936 (expected > 72057594037927936)`,
    ],
  ];
  for (const [Entry, Reason] of Cases) {
    const R = await load(makeSnmp()).Run(target({ Oids: [Entry] }));
    assert.equal(R.Success, true, Entry);
    assert.equal(R.Degraded, true, Entry);
    assert.equal(R.DegradedReason, Reason);
    assert.equal(R.Assertions[0].Passed, false);
  }
});

test('passing comparisons across types do not degrade', async () => {
  const Values = agentValues({
    '1.3.6.1.4.1.1.1.0': { type: T.OctetString, value: Buffer.from(' 23.5 ') },
    '1.3.6.1.4.1.1.2.0': { type: T.Gauge, value: 4294967295 },
    '1.3.6.1.4.1.1.3.0': { type: T.IpAddress, value: '10.0.0.1' },
    '1.3.6.1.4.1.1.4.0': { type: T.OID, value: '1.3.6.1.4.1.9' },
    '1.3.6.1.4.1.1.5.0': { type: T.Integer, value: -40 },
    '1.3.6.1.4.1.1.6.0': { type: T.OctetString, value: Buffer.alloc(0) },
  });
  for (const Entry of [
    '1.3.6.1.4.1.1.1.0 > 20',
    '1.3.6.1.4.1.1.1.0 < 23.6',
    '1.3.6.1.4.1.1.2.0 = 4294967295',
    '1.3.6.1.4.1.1.2.0 > 4294967294.5',
    '1.3.6.1.4.1.1.3.0 = 10.0.0.1',
    '1.3.6.1.4.1.1.4.0 contains 4.1.9',
    '1.3.6.1.4.1.1.5.0 < -39',
    '1.3.6.1.4.1.1.5.0 = -40.0',
    '1.3.6.1.4.1.1.6.0 = ""',
    `${IF_MAC} contains 3c4d`,
    `${SYS_UPTIME} > 100`,
  ]) {
    const R = await load(makeSnmp({ values: Values })).Run(target({ Oids: [Entry] }));
    assert.ok(R.Success && !R.Degraded, `${Entry}: ${R.DegradedReason}`);
  }
});

test('non-printable OctetStrings decode as hex; printable as text', () => {
  const { DecodeOctets } = load(makeSnmp())._internal;
  assert.deepEqual(DecodeOctets(Buffer.from('Main PDU')), { Text: 'Main PDU', Hex: false });
  assert.deepEqual(DecodeOctets(Buffer.from('café\r\n')), { Text: 'café\r\n', Hex: false });
  assert.deepEqual(DecodeOctets(Buffer.from([0x00, 0x01, 0xff])), {
    Text: '00 01 FF',
    Hex: true,
  });
  assert.deepEqual(DecodeOctets(Buffer.from([0xc3, 0x28])), { Text: 'C3 28', Hex: true });
  assert.deepEqual(DecodeOctets(Buffer.from([0, 0])), { Text: '', Hex: false });
});

// --- v1 and error-status fallback ---------------------------------------------------

test('v1: a noSuchName reply falls back to per-OID GETs and names the missing OID', async () => {
  const Values = agentValues();
  delete Values[IF_OPER];
  const Snmp = makeSnmp({ values: Values, v1: true });
  const R = await load(Snmp).Run(
    target({ Version: '1', Oids: [`${SYS_NAME} = Stage Left`, IF_OPER] })
  );
  assert.equal(R.Success, true);
  assert.equal(R.Degraded, true);
  assert.equal(R.DegradedReason, `${IF_OPER}: noSuchName`);
  assert.deepEqual(Snmp.sessions[0].gets, [[SYS_NAME, IF_OPER], [SYS_NAME], [IF_OPER]]);
  assert.equal(R.Values.find((V) => V.Oid === SYS_NAME).Value, 'Stage Left');
  assert.equal(Snmp.sessions[0].closes, 1);
});

test('a tooBig reply on the batch falls back to reading OIDs one at a time', async () => {
  const Snmp = makeSnmp({ pduError: { message: 'TooBig', status: 1 } });
  const R = await load(Snmp).Run(target({ Oids: [SYS_NAME, SYS_DESCR] }));
  assert.equal(R.Success, true);
  assert.ok(!R.Degraded);
  assert.equal(Snmp.sessions[0].gets.length, 3);
});

// --- Offline --------------------------------------------------------------------------

test('no response is Offline with the transport message', async () => {
  const Snmp = makeSnmp({ transportError: 'Request timed out' });
  const R = await load(Snmp).Run(target({ Oids: [SYS_NAME] }));
  assert.equal(R.Success, false);
  assert.equal(R.Error, 'Request timed out');
  assert.equal(Snmp.sessions[0].closes, 1);
});

test('a session that never answers is cut off by the whole-probe budget', async () => {
  const Snmp = makeSnmp({ neverReply: true });
  const Started = Date.now();
  const R = await load(Snmp).Run(target({ Oids: [SYS_NAME], Timeout: 500 }));
  const Elapsed = Date.now() - Started;
  assert.equal(R.Success, false);
  assert.match(R.Error, /No SNMP reply within 500 ms/);
  assert.ok(Elapsed < 900, `took ${Elapsed}ms`);
  assert.equal(Snmp.sessions[0].closes, 1);
});

test('a socket error settles once and a session that cannot be created is Offline', async () => {
  const Snmp = makeSnmp({ neverReply: true });
  const M = load(Snmp);
  const Pending = M.Run(target({ Oids: [SYS_NAME] }));
  await new Promise((r) => setImmediate(r));
  Snmp.sessions[0].handlers.error(new Error('EHOSTUNREACH'));
  const R = await Pending;
  assert.equal(R.Error, 'EHOSTUNREACH');
  assert.equal(Snmp.sessions[0].closes, 1);

  const R2 = await load(makeSnmp({ createThrows: 'bad address' })).Run(
    target({ Oids: [SYS_NAME] })
  );
  assert.equal(R2.Success, false);
  assert.equal(R2.Error, 'bad address');
});

// --- Settings and Debug ------------------------------------------------------------------

test('settings: credentials are Sensitive and gated on the version', () => {
  const M = load(makeSnmp());
  const F = (Key) => M.Settings.find((S) => S.Key === Key);
  assert.equal(F('Community').Sensitive, true);
  assert.deepEqual(F('Community').VisibleWhen, { Key: 'Version', In: ['1', '2c'] });
  for (const Key of ['Username', 'AuthProtocol', 'AuthPassword', 'PrivProtocol', 'PrivPassword']) {
    assert.deepEqual(F(Key).VisibleWhen, { Key: 'Version', Equals: '3' }, Key);
  }
  assert.equal(F('AuthPassword').Sensitive, true);
  assert.equal(F('PrivPassword').Sensitive, true);
  assert.equal(F('Oids').Type, 'list');
  assert.deepEqual(F('Oids').Default, [SYS_UPTIME]);
  assert.equal(M.ID, 'snmp-oid');
  assert.ok(M.Name && M.Description && M.DefaultInterval > 0);
});

test('Debug shows every OID with its type and value, and the failing assertion', async () => {
  const M = load(makeSnmp());
  const Settings = {
    Community: 'secret-community',
    Oids: [SYS_UPTIME, `${SYS_NAME} = Stage Right`, IF_MAC, '1.3.6.1.4.1.77.0'],
  };
  const R = await M.Run(target(Settings));
  const Html = M.Debug(R, target(Settings));
  assert.match(Html, /TimeTicks/);
  assert.match(Html, /8640000 \(1d 0h 0m\)/);
  assert.match(Html, /OctetString/);
  assert.match(Html, /Stage Left/);
  assert.match(Html, /Expected = Stage Right · failed/);
  assert.match(Html, /Hex: 00 1A 2B 3C 4D 5E/);
  assert.match(Html, /noSuchObject/);
  assert.match(Html, /Degraded/);
  assert.doesNotMatch(Html, /secret-community/, 'the community string is a credential');
});

test('Debug escapes device-supplied text and renders offline', async () => {
  const M = load(
    makeSnmp({
      values: agentValues({ [SYS_NAME]: { type: T.OctetString, value: Buffer.from('<b>x</b>') } }),
    })
  );
  const R = await M.Run(target({ Oids: [SYS_NAME] }));
  const Html = M.Debug(R, target({ Oids: [SYS_NAME] }));
  assert.doesNotMatch(Html, /<b>x<\/b>/);
  assert.match(Html, /&lt;b&gt;x/);

  const Off = M.Debug({ Success: false, Error: 'Request timed out' }, target({}));
  assert.match(Off, /Offline/);
  assert.match(Off, /Request timed out/);

  const V3 = M.Debug(
    { Success: false, Error: 'x' },
    target({ Version: '3', Username: 'ops', AuthProtocol: 'sha', PrivProtocol: 'aes' })
  );
  assert.match(V3, /v3 · ops · authPriv \(sha\/aes\)/);
});
