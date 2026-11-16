const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

// The openGear frame check against a net-snmp stub that serves the objects of
// Ross's published OPEN-GEAR-FRAME-MIB and OPEN-GEAR-CARD-MIB (ROSS-MIBS-20220314)
// at their real OIDs. Only net-snmp is stubbed; the probe (snmp-oid's
// ProbeOids), the card-table fold and the evaluation all run for real.

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

const F = '1.3.6.1.4.1.27399.1.1.2.1';
const C = '1.3.6.1.4.1.27399.1.1.3.1.2.1';
const fo = (table, col) => `${F}.${table}.1.${col}.1`;
const card = (col, slot) => `${C}.${col}.1.${slot}`;

const INT = 2;
const STR = 4;
const int = (value) => ({ type: INT, value });
const str = (value) => ({ type: STR, value: Buffer.from(value, 'utf8') });

function healthyFrame(Overrides = {}) {
  return {
    [fo(2, 3)]: str('Rack 3 Frame A'),
    [fo(2, 5)]: str('MFC-OG3-N'),
    [fo(2, 8)]: str('SN123456'),
    [fo(2, 11)]: str('6.2.0'),
    [fo(2, 12)]: str('OG3-FR-CN'),
    [fo(3, 1)]: int(0),
    [fo(3, 2)]: int(1),
    [fo(3, 3)]: int(4),
    [fo(3, 5)]: int(3),
    [fo(4, 1)]: int(212),
    [fo(4, 5)]: int(31),
    [fo(4, 6)]: int(0),
    [fo(4, 7)]: int(24),
    [fo(4, 8)]: str('PS-OG3'),
    [fo(4, 9)]: str(''),
    [fo(4, 16)]: int(0x0001),
    [fo(4, 17)]: int(0x0004),
    [fo(5, 1)]: int(1),
    ...Overrides,
  };
}

function cardRows(Slots) {
  const Out = {};
  for (const [slot, product, online] of Slots) {
    Out[card(2, slot)] = str('Ross Video');
    Out[card(3, slot)] = str(product);
    Out[card(4, slot)] = str('1.05');
    Out[card(5, slot)] = int(online ? 1 : 2);
    Out[card(6, slot)] = { type: 6, value: '1.3.6.1.4.1.27399.1.1.3' };
  }
  return Out;
}

const HEALTHY_CARDS = cardRows([
  [2, 'DRA-8804', true],
  [4, 'UDC-8625A', true],
  [5, 'SFS-8221', false],
]);

/**
 * @param {object} o
 * @param {object} o.frame        oid -> varbind for GET
 * @param {object} o.cards        oid -> varbind for the card-table walk
 * @param {boolean} o.silent      never answer (timeout path)
 * @param {Error}   o.getError    fail every GET with this
 * @param {Error}   o.walkError   fail the walk with this
 * @param {boolean} o.v1Strict    answer a GET containing a missing OID with noSuchName (v1)
 */
function makeSnmp(o = {}) {
  const { frame = {}, cards = {}, silent = false, getError = null, walkError = null } = o;
  const sessions = [];
  const isErr = (vb) => vb && (vb.type === 128 || vb.type === 129 || vb.type === 130);
  const makeSession = (kind, target, auth, options) => {
    const s = {
      kind,
      target,
      auth,
      options,
      closed: false,
      gets: [],
      walks: [],
      on() {},
      close() {
        s.closed = true;
      },
      get(oids, cb) {
        s.gets.push(oids);
        if (silent) return;
        if (getError) return setImmediate(() => cb(getError));
        if (o.v1Strict && oids.some((oid) => !(oid in frame))) {
          return setImmediate(() =>
            cb(Object.assign(new Error('NoSuchName'), { name: 'RequestFailedError', status: 2 }))
          );
        }
        setImmediate(() =>
          cb(
            null,
            oids.map((oid) =>
              oid in frame ? { oid, ...frame[oid] } : { oid, type: 128, value: null }
            )
          )
        );
      },
      subtree(base, maxRep, feed, done) {
        s.walks.push(base);
        if (silent) return;
        if (walkError) return setImmediate(() => done(walkError));
        const all = Object.keys(cards)
          .filter((oid) => oid.startsWith(`${base}.`))
          .sort((a, b) => {
            const pa = a.split('.').map(Number);
            const pb = b.split('.').map(Number);
            for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
              if ((pa[i] ?? -1) !== (pb[i] ?? -1)) return (pa[i] ?? -1) - (pb[i] ?? -1);
            }
            return 0;
          })
          .map((oid) => ({ oid, ...cards[oid] }));
        setImmediate(() => {
          for (let i = 0; i < all.length; i += maxRep) {
            if (feed(all.slice(i, i + maxRep))) break;
          }
          done(null);
        });
      },
    };
    sessions.push(s);
    return s;
  };
  const snmp = {
    Version1: 0,
    Version2c: 1,
    Version3: 3,
    AuthProtocols: { none: 1, md5: 2, sha: 3, sha224: 4, sha256: 5, sha384: 6, sha512: 7 },
    PrivProtocols: { none: 1, des: 2, aes: 4, aes256b: 6, aes256r: 8 },
    SecurityLevel: { noAuthNoPriv: 1, authNoPriv: 2, authPriv: 3 },
    isVarbindError: isErr,
    createSession: (target, community, options) => makeSession('v1/2c', target, community, options),
    createV3Session: (target, user, options) => makeSession('v3', target, user, options),
  };
  return { snmp, sessions };
}

function load(stub) {
  return loadWithMocks(methodPath('opengear-frame.js'), { 'net-snmp': stub.snmp });
}

const target = (Settings = {}) => ({
  Address: '10.0.0.50',
  Settings: { Community: 'show', Timeout: 1500, Retries: 0, ...Settings },
});

test('opengear-frame exposes the expected shape', () => {
  const m = load(makeSnmp());
  assert.equal(m.ID, 'opengear-frame');
  assert.equal(typeof m.Run, 'function');
  assert.equal(typeof m.Debug, 'function');
  const keys = m.Settings.map((s) => s.Key);
  for (const key of ['Port', 'Version', 'Community', 'Slots', 'RequireBothPsus', 'Timeout']) {
    assert.ok(keys.includes(key), `missing setting ${key}`);
  }
  assert.equal(m.Settings.find((s) => s.Key === 'Community').Sensitive, true);
  assert.equal(m.Settings.find((s) => s.Key === 'Port').Default, 161);
  // Read-only: no actions.
  assert.equal(m.Actions, undefined);
});

test('a healthy frame is online with identity, PSU and card readings', async () => {
  const stub = makeSnmp({ frame: healthyFrame(), cards: HEALTHY_CARDS });
  const m = load(stub);
  const r = await m.Run(target({ Slots: ['2', '4'] }));
  assert.equal(r.Success, true, r.Error);
  assert.ok(!r.Degraded, r.DegradedReason);
  assert.equal(r.FrameName, 'Rack 3 Frame A');
  assert.equal(r.FrameProduct, 'OG3-FR-CN');
  assert.equal(r.ControllerProduct, 'MFC-OG3-N');
  assert.equal(r.ControllerFirmware, '6.2.0');
  assert.equal(r.FrameStatus, 0);
  assert.equal(r.AmbientTemp, 24);
  assert.equal(r.PowerW, 212);
  assert.deepEqual(
    r.Cards.map((c) => [c.Slot, c.Product, c.Online, c.Supplier, c.Software]),
    [
      [2, 'DRA-8804', true, 'Ross Video', '1.05'],
      [4, 'UDC-8625A', true, 'Ross Video', '1.05'],
      [5, 'SFS-8221', false, 'Ross Video', '1.05'],
    ]
  );
  // Two sessions (GET, walk), both closed, on the configured community and port.
  assert.equal(stub.sessions.length, 2);
  assert.ok(stub.sessions.every((s) => s.closed));
  assert.ok(stub.sessions.every((s) => s.auth === 'show' && s.options.port === 161));
  assert.equal(stub.sessions[0].options.version, 1);
  assert.deepEqual(stub.sessions[1].walks, [C]);
  assert.ok(stub.sessions[0].gets[0].includes(`${F}.3.1.1.1`), 'reads openGearFrameStatus.1');
});

test('frame status bits become reasons; the two overload bits share one', async () => {
  const stub = makeSnmp({
    frame: healthyFrame({ [fo(3, 1)]: int(0x0001 | 0x0008 | 0x0020 | 0x0040 | 0x0400 | 0x0800) }),
    cards: HEALTHY_CARDS,
  });
  const r = await load(stub).Run(target());
  assert.equal(r.Degraded, true);
  assert.deepEqual(r.DegradedReason.split('; '), [
    'Fan door open too long',
    'PSU overloaded',
    'Door fan stalled',
    'A card reports an error',
    'A card reports a warning',
  ]);
});

test('PSU faults are named per supply; a missing PSU only counts when both are required', async () => {
  const frame = healthyFrame({ [fo(4, 16)]: int(0x0001 | 0x0040 | 0x0010) });
  const r = await load(makeSnmp({ frame, cards: HEALTHY_CARDS })).Run(target());
  assert.equal(r.DegradedReason, 'PSU 1: fan fault, AC missing');

  const single = await load(makeSnmp({ frame: healthyFrame(), cards: HEALTHY_CARDS })).Run(
    target()
  );
  assert.ok(!single.Degraded, 'PSU 2 not fitted is fine by default');

  const both = await load(makeSnmp({ frame: healthyFrame(), cards: HEALTHY_CARDS })).Run(
    target({ RequireBothPsus: true })
  );
  assert.equal(both.DegradedReason, 'PSU 2 missing');
});

test('intake temperature is thresholded only when enabled, and 0 (door open) is no reading', async () => {
  const hot = healthyFrame({ [fo(4, 7)]: int(41) });
  const off = await load(makeSnmp({ frame: hot, cards: HEALTHY_CARDS })).Run(target());
  assert.ok(!off.Degraded);
  const on = await load(makeSnmp({ frame: hot, cards: HEALTHY_CARDS })).Run(
    target({ CheckTemperature: true, MaxAmbientTemperature: 35 })
  );
  assert.equal(on.DegradedReason, 'Intake 41°C (max 35°C)');
  const door = await load(
    makeSnmp({ frame: healthyFrame({ [fo(4, 7)]: int(0) }), cards: HEALTHY_CARDS })
  ).Run(target({ CheckTemperature: true, MaxAmbientTemperature: -5 }));
  assert.ok(!door.Degraded, door.DegradedReason);
});

test('monitored slots must hold an online card', async () => {
  const r = await load(makeSnmp({ frame: healthyFrame(), cards: HEALTHY_CARDS })).Run(
    target({ Slots: [2, '5', '7', 'x', '7'] })
  );
  assert.equal(r.Degraded, true);
  assert.deepEqual(r.DegradedReason.split('; '), ['Slot 5 SFS-8221 offline', 'Slot 7 empty']);
});

test('a failed card walk only degrades when slots are monitored', async () => {
  const walkError = new Error('Request timed out');
  const plain = await load(makeSnmp({ frame: healthyFrame(), walkError })).Run(target());
  assert.equal(plain.Success, true);
  assert.ok(!plain.Degraded);
  assert.equal(plain.CardError, 'Request timed out');

  const watched = await load(makeSnmp({ frame: healthyFrame(), walkError })).Run(
    target({ Slots: [2] })
  );
  assert.equal(watched.Degraded, true);
  assert.deepEqual(watched.DegradedReason.split('; '), [
    'Card table not readable',
    'Cards: Request timed out',
  ]);
});

test('offline: no reply within the budget, or a transport error', async () => {
  const Started = Date.now();
  const silent = await load(makeSnmp({ silent: true })).Run(target({ Timeout: 600 }));
  assert.equal(silent.Success, false);
  assert.match(silent.Error, /No SNMP reply within 600 ms/);
  assert.ok(Date.now() - Started < 2000);

  const err = await load(makeSnmp({ getError: new Error('connect EHOSTUNREACH') })).Run(target());
  assert.equal(err.Success, false);
  assert.match(err.Error, /EHOSTUNREACH/);
});

test('an agent without the openGear frame MIB is not treated as a frame', async () => {
  const r = await load(makeSnmp({ frame: {} })).Run(target());
  assert.equal(r.Success, false);
  assert.match(r.Error, /does not report the openGear frame MIB/);
});

test('v1 agents that answer noSuchName still yield the objects they have', async () => {
  const frame = healthyFrame();
  delete frame[fo(4, 9)]; // PSU2 model absent
  const stub = makeSnmp({ frame, cards: HEALTHY_CARDS, v1Strict: true });
  const r = await load(stub).Run(target({ Version: '1' }));
  assert.equal(r.Success, true, r.Error);
  assert.equal(r.FrameStatus, 0);
  assert.equal(r.Psu2Model, null);
  assert.equal(stub.sessions[0].options.version, 0);
});

test('v3 builds a USM session and validates credentials first', async () => {
  const missing = await load(makeSnmp({ frame: healthyFrame() })).Run(target({ Version: '3' }));
  assert.equal(missing.Success, false);
  assert.match(missing.Error, /No SNMPv3 username/);

  const stub = makeSnmp({ frame: healthyFrame(), cards: HEALTHY_CARDS });
  const r = await load(stub).Run(
    target({
      Version: '3',
      Username: 'monitor',
      AuthProtocol: 'sha',
      AuthPassword: 'authpass1',
      PrivProtocol: 'aes',
      PrivPassword: 'privpass1',
    })
  );
  assert.equal(r.Success, true, r.Error);
  assert.equal(stub.sessions[0].kind, 'v3');
  assert.equal(stub.sessions[0].auth.name, 'monitor');
});

test('malformed card OIDs are ignored by the fold', () => {
  const m = load(makeSnmp());
  const rows = m._internal.FoldCardRows([
    { oid: `${C}.3.1.2`, value: Buffer.from('DRA-8804') },
    { oid: `${C}.3.2.2`, value: Buffer.from('other frame') },
    { oid: `${C}.3.1`, value: Buffer.from('short') },
    { oid: '1.3.6.1.2.1.1.5.0', value: Buffer.from('sysName') },
    { oid: `${C}.5.1.2`, value: 7 },
    null,
  ]);
  assert.deepEqual(rows, [
    { Slot: 2, Supplier: null, Product: 'DRA-8804', Software: null, Online: null },
  ]);
});

test('Debug escapes every frame-supplied value and hides the community', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  const stub = makeSnmp({
    frame: healthyFrame({ [fo(2, 3)]: str(evil), [fo(4, 8)]: str(evil) }),
    cards: { ...cardRows([[3, evil, true]]), [card(2, 3)]: str(evil) },
  });
  const m = load(stub);
  const T = target({ Slots: ['3'], Community: 'topsecret' });
  const r = await m.Run(T);
  const html = m.Debug(r, T);
  assert.ok(!html.includes('<img'), 'raw markup leaked into the debug panel');
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('topsecret'), 'the community string is a credential');

  const offline = m.Debug({ Success: false, Error: evil }, { Address: evil, Settings: {} });
  assert.ok(!offline.includes('<img'));
  const walkFail = m.Debug(
    { Success: true, Cards: null, CardError: evil, DegradedReason: evil, Degraded: true },
    T
  );
  assert.ok(!walkFail.includes('<img'));
});
