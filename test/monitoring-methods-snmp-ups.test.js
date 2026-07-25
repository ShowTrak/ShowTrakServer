const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

// Exercises src/Modules/MonitoringMethods/snmp-ups.ts, snmp-ups-v3.ts and the
// _snmp-ups-shared.ts logic they both delegate to.
//
// Both files reported ~70% LINES but **0% functions** before this: requiring the
// module runs the Settings array and the OID tables, so the file looks covered
// while not one probe, threshold or session decision has ever executed.
//
// What is actually at stake: a UPS check is how the operator learns the rack is
// on battery. The two directions that matter are a false "healthy" (nobody is
// told the mains dropped) and a false "offline" (an alarm every poll, which
// trains the operator to ignore the panel). The probe deliberately treats a
// missing MIB object as `null` — plenty of cards do not populate temperature or
// input voltage — while treating a transport failure as offline, and that
// distinction is exactly what this pins.
//
// Only `net-snmp` is stubbed; the real UPS-MIB OID table, health evaluation,
// threshold parsing and debug rendering all run.

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

const OID = {
  BatteryStatus: '1.3.6.1.2.1.33.1.2.1.0',
  Charge: '1.3.6.1.2.1.33.1.2.4.0',
  MinutesRemaining: '1.3.6.1.2.1.33.1.2.3.0',
  Temperature: '1.3.6.1.2.1.33.1.2.7.0',
  OutputSource: '1.3.6.1.2.1.33.1.4.1.0',
  AlarmsPresent: '1.3.6.1.2.1.33.1.6.1.0',
  Load: (I) => `1.3.6.1.2.1.33.1.4.4.1.5.${I}`,
  InputVoltage: (I) => `1.3.6.1.2.1.33.1.3.3.1.3.${I}`,
};

/** A UPS answering every OID with healthy readings on line 1. */
function healthyUps(Overrides = {}) {
  return {
    [OID.BatteryStatus]: 2, // Normal
    [OID.Charge]: 100,
    [OID.MinutesRemaining]: 45,
    [OID.Temperature]: 24,
    [OID.OutputSource]: 3, // Normal (mains)
    [OID.Load(1)]: 30,
    [OID.InputVoltage(1)]: 240,
    [OID.AlarmsPresent]: 0,
    ...Overrides,
  };
}

/**
 * A net-snmp stub. Records every session it hands out (and how it was created)
 * so tests can assert on the transport decisions, not just the readings.
 */
function makeSnmp(Options = {}) {
  const {
    values = {},
    transportError = null,
    createThrows = null,
    getThrows = null,
    emitSessionError = null,
    silent = false,
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
    isVarbindError: (Vb) => !!(Vb && Vb.__error),
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
        requestedOids: null,
        handlers: {},
        on(event, fn) {
          Session.handlers[event] = fn;
        },
        close() {
          Session.closes += 1;
        },
        get(oids, cb) {
          Session.requestedOids = oids;
          if (getThrows) throw new Error(getThrows);
          if (emitSessionError) {
            Session.handlers.error(new Error(emitSessionError));
            // A real socket error can be followed by the request callback; the
            // probe must ignore the second settle.
            if (!silent)
              cb(
                null,
                oids.map(() => ({ value: 1 }))
              );
            return;
          }
          if (transportError) {
            cb(new Error(transportError));
            return;
          }
          cb(
            null,
            oids.map((Oid) =>
              Object.prototype.hasOwnProperty.call(values, Oid)
                ? { value: values[Oid] }
                : { __error: true }
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

function loadUps(snmpMock) {
  return loadWithMocks(methodPath('snmp-ups.js'), { 'net-snmp': snmpMock });
}
function loadUpsV3(snmpMock) {
  return loadWithMocks(methodPath('snmp-ups-v3.js'), { 'net-snmp': snmpMock });
}

const target = (Settings = {}, Address = '10.0.0.20') => ({ Address, Settings });

// --- The probe: which OIDs go on the wire ----------------------------------

test('the probe reads the full standard UPS-MIB set, indexed by output line', async () => {
  const Snmp = makeSnmp({ values: healthyUps() });
  const Ups = loadUps(Snmp);

  await Ups.Run(target({ OutputIndex: 3 }));

  assert.deepEqual(Snmp.sessions[0].requestedOids, [
    OID.BatteryStatus,
    OID.Charge,
    OID.MinutesRemaining,
    OID.Temperature,
    OID.OutputSource,
    OID.Load(3),
    OID.InputVoltage(3),
    OID.AlarmsPresent,
  ]);
});

test('a healthy UPS reports success with every reading carried through', async () => {
  const Snmp = makeSnmp({ values: healthyUps() });
  const Ups = loadUps(Snmp);

  const Result = await Ups.Run(target());

  assert.equal(Result.Success, true);
  assert.ok(!Result.Degraded);
  assert.equal(Result.BatteryStatus, 2);
  assert.equal(Result.OutputSource, 3);
  assert.equal(Result.BatteryCharge, 100);
  assert.equal(Result.MinutesRemaining, 45);
  assert.equal(Result.Load, 30);
  assert.equal(Result.Temperature, 24);
  assert.equal(Result.InputVoltage, 240);
  assert.equal(Result.AlarmsPresent, 0);
  assert.equal(typeof Result.LatencyMs, 'number');
});

test('an object the card does not implement reads as null, not as a failure', async () => {
  // Plenty of RFC 1628 cards never populate battery temperature or input
  // voltage. Failing the whole check on that would make the method unusable on
  // exactly the hardware it claims to support.
  const Values = healthyUps();
  delete Values[OID.Temperature];
  delete Values[OID.InputVoltage(1)];

  const Ups = loadUps(makeSnmp({ values: Values }));
  const Result = await Ups.Run(target());

  assert.equal(Result.Success, true);
  assert.equal(Result.Temperature, null);
  assert.equal(Result.InputVoltage, null);
});

test('a non-numeric varbind value reads as null rather than NaN', async () => {
  const Ups = loadUps(
    makeSnmp({ values: healthyUps({ [OID.Charge]: Buffer.from('not a number') }) })
  );
  const Result = await Ups.Run(target());
  assert.equal(Result.BatteryCharge, null);
});

test('the session is closed exactly once, on every outcome', async () => {
  for (const Options of [
    { values: healthyUps() },
    { transportError: 'read timeout' },
    { emitSessionError: 'EHOSTUNREACH' },
  ]) {
    const Snmp = makeSnmp(Options);
    const Ups = loadUps(Snmp);
    await Ups.Run(target());
    assert.equal(
      Snmp.sessions[0].closes,
      1,
      `session leaked or double-closed for ${JSON.stringify(Object.keys(Options))}`
    );
  }
});

// --- Transport failure vs. missing data ------------------------------------

test('a transport failure is reported offline with the underlying message', async () => {
  const Ups = loadUps(makeSnmp({ transportError: 'Request timed out' }));
  const Result = await Ups.Run(target());
  assert.equal(Result.Success, false);
  assert.equal(Result.Error, 'Request timed out');
});

test('a socket error settles the probe once, ignoring a late reply', async () => {
  // net-snmp can emit 'error' on the socket AND still invoke the request
  // callback; a second settle would resolve an already-resolved promise and
  // (worse) close the session twice.
  const Snmp = makeSnmp({ emitSessionError: 'EHOSTUNREACH' });
  const Ups = loadUps(Snmp);

  const Result = await Ups.Run(target());
  assert.equal(Result.Success, false);
  assert.equal(Result.Error, 'EHOSTUNREACH');
  assert.equal(Snmp.sessions[0].closes, 1);
});

test('a session that cannot be created is offline, not a crash', async () => {
  // Bad credentials or an unresolvable host make net-snmp throw synchronously.
  const Ups = loadUps(makeSnmp({ createThrows: 'Invalid community' }));
  const Result = await Ups.Run(target());
  assert.equal(Result.Success, false);
  assert.equal(Result.Error, 'Invalid community');
});

test('a get() that throws synchronously is offline, not an unhandled rejection', async () => {
  const Ups = loadUps(makeSnmp({ getThrows: 'socket already closed' }));
  const Result = await Ups.Run(target());
  assert.equal(Result.Success, false);
  assert.equal(Result.Error, 'socket already closed');
});

// --- Config validation ------------------------------------------------------

test('a target with no address never opens a session', async () => {
  const Snmp = makeSnmp({ values: healthyUps() });
  const Ups = loadUps(Snmp);

  for (const T of [target({}, ''), target({}, '   '), target({}, null), { Settings: {} }, {}]) {
    const Result = await Ups.Run(T);
    assert.equal(Result.Success, false, `${JSON.stringify(T)} was probed anyway`);
    assert.equal(Result.Error, 'No address configured');
  }
  assert.equal(Snmp.created.length, 0);
});

test('an out-of-range port is rejected before any traffic', async () => {
  const Snmp = makeSnmp({ values: healthyUps() });
  const Ups = loadUps(Snmp);

  for (const Port of [0, -1, 65536, 999999]) {
    const Result = await Ups.Run(target({ Port }));
    assert.equal(Result.Success, false);
    assert.match(Result.Error, /Invalid port/);
  }
  assert.equal(Snmp.created.length, 0);
});

test('session options come from the parsed config', async () => {
  const Snmp = makeSnmp({ values: healthyUps() });
  const Ups = loadUps(Snmp);

  await Ups.Run(
    target({ Port: 1610, Community: 'showtrak', Version: '1', Timeout: 9000, Retries: 3 })
  );

  const [Created] = Snmp.created;
  assert.equal(Created.address, '10.0.0.20');
  assert.equal(Created.community, 'showtrak');
  assert.deepEqual(Created.options, {
    port: 1610,
    version: 'V1',
    timeout: 9000,
    retries: 3,
  });
});

test('defaults are applied for anything unset or unparseable', async () => {
  const Snmp = makeSnmp({ values: healthyUps() });
  const Ups = loadUps(Snmp);

  await Ups.Run(target({ Port: 'not a port', Timeout: 'soon', Retries: 'lots' }));

  const [Created] = Snmp.created;
  assert.equal(Created.community, 'public');
  assert.equal(Created.options.port, 161);
  assert.equal(Created.options.version, 'V2C', 'anything but "1" means v2c');
  assert.equal(Created.options.timeout, 4000);
  assert.equal(Created.options.retries, 1);
});

test('the timeout is floored at 500ms so a typo cannot make every poll fail', async () => {
  const Snmp = makeSnmp({ values: healthyUps() });
  const Ups = loadUps(Snmp);
  await Ups.Run(target({ Timeout: 1 }));
  assert.equal(Snmp.created[0].options.timeout, 500);
});

test('an empty community falls back to public rather than authenticating as ""', async () => {
  const Snmp = makeSnmp({ values: healthyUps() });
  const Ups = loadUps(Snmp);
  await Ups.Run(target({ Community: '' }));
  assert.equal(Snmp.created[0].community, 'public');
});

test('the output index is clamped to a real line number', async () => {
  const Ups = loadUps(makeSnmp({ values: healthyUps() }));
  const { ParseConfig } = Ups._internal;

  assert.equal(ParseConfig(target({ OutputIndex: 0 })).OutputIndex, 1);
  assert.equal(ParseConfig(target({ OutputIndex: -4 })).OutputIndex, 1);
  assert.equal(ParseConfig(target({ OutputIndex: 2.9 })).OutputIndex, 2);
  assert.equal(ParseConfig(target({})).OutputIndex, 1);
});

test('ParseConfig tolerates a target with no settings at all', () => {
  const Ups = loadUps(makeSnmp());
  const Config = Ups._internal.ParseConfig({ Address: '10.0.0.1' });
  assert.equal(Config.Community, 'public');
  assert.equal(Config.Port, 161);
});

// --- Health evaluation ------------------------------------------------------

const THRESHOLDS = { MinCharge: 50, MaxLoad: 90, MaxTemperature: 45 };

test('the conditions that mean the show is at risk are each reported', () => {
  const { EvaluateHealth } = loadUps(makeSnmp())._internal;

  // The one that matters most: mains has dropped and the rack is on battery.
  assert.deepEqual(EvaluateHealth({ OutputSource: 5 }, THRESHOLDS), ['On battery']);
  assert.deepEqual(EvaluateHealth({ OutputSource: 4 }, THRESHOLDS), ['On bypass']);
  assert.deepEqual(EvaluateHealth({ BatteryStatus: 3 }, THRESHOLDS), ['Low battery']);
  assert.deepEqual(EvaluateHealth({ BatteryStatus: 4 }, THRESHOLDS), ['Battery depleted']);
  assert.deepEqual(EvaluateHealth({ OutputSource: 1 }, THRESHOLDS), ['Output source: Other']);
  assert.deepEqual(EvaluateHealth({ OutputSource: 2 }, THRESHOLDS), ['Output source: None']);
});

test('normal readings raise nothing', () => {
  const { EvaluateHealth } = loadUps(makeSnmp())._internal;
  assert.deepEqual(
    EvaluateHealth(
      {
        BatteryStatus: 2,
        OutputSource: 3,
        Charge: 100,
        Load: 10,
        Temperature: 20,
        AlarmsPresent: 0,
      },
      THRESHOLDS
    ),
    []
  );
  // Booster / reducer mean the UPS is correcting voltage — normal operation.
  assert.deepEqual(EvaluateHealth({ OutputSource: 6 }, THRESHOLDS), []);
  assert.deepEqual(EvaluateHealth({ OutputSource: 7 }, THRESHOLDS), []);
  // Unknown battery status is not a fault on its own.
  assert.deepEqual(EvaluateHealth({ BatteryStatus: 1 }, THRESHOLDS), []);
});

test('active alarms are counted and pluralised', () => {
  const { EvaluateHealth } = loadUps(makeSnmp())._internal;
  assert.deepEqual(EvaluateHealth({ AlarmsPresent: 1 }, THRESHOLDS), ['1 active alarm']);
  assert.deepEqual(EvaluateHealth({ AlarmsPresent: 3 }, THRESHOLDS), ['3 active alarms']);
  assert.deepEqual(EvaluateHealth({ AlarmsPresent: 0 }, THRESHOLDS), []);
});

test('thresholds are strict inequalities, so a reading exactly at the limit passes', () => {
  const { EvaluateHealth } = loadUps(makeSnmp())._internal;
  assert.deepEqual(EvaluateHealth({ Charge: 50, Load: 90, Temperature: 45 }, THRESHOLDS), []);
  assert.deepEqual(EvaluateHealth({ Charge: 49 }, THRESHOLDS), ['Charge 49% < 50%']);
  assert.deepEqual(EvaluateHealth({ Load: 91 }, THRESHOLDS), ['Load 91% > 90%']);
  assert.deepEqual(EvaluateHealth({ Temperature: 46 }, THRESHOLDS), ['Temp 46°C > 45°C']);
});

test('a disabled factor is not evaluated, but the fault conditions still are', () => {
  // The toggles exist because many cards report a permanently-low charge or an
  // idle-load figure that would otherwise alarm forever. Turning one off must
  // not also silence "on battery".
  const { EvaluateHealth } = loadUps(makeSnmp())._internal;
  const Off = { ...THRESHOLDS, CheckCharge: false, CheckLoad: false, CheckTemperature: false };

  assert.deepEqual(EvaluateHealth({ Charge: 1, Load: 100, Temperature: 90 }, Off), []);
  assert.deepEqual(EvaluateHealth({ Charge: 1, OutputSource: 5 }, Off), ['On battery']);
});

test('an absent flag counts as enabled, so checks saved before the toggles still evaluate', () => {
  const { EvaluateHealth } = loadUps(makeSnmp())._internal;
  assert.deepEqual(EvaluateHealth({ Charge: 10 }, THRESHOLDS), ['Charge 10% < 50%']);
});

test('a null reading is never compared against a threshold', () => {
  const { EvaluateHealth } = loadUps(makeSnmp())._internal;
  assert.deepEqual(
    EvaluateHealth(
      { Charge: null, Load: null, Temperature: null, AlarmsPresent: null, OutputSource: null },
      THRESHOLDS
    ),
    []
  );
});

test('every breached factor is reported, not just the first', async () => {
  // The operator needs the whole picture in one line; stopping at the first
  // reason would hide that the batteries are also flat.
  const Ups = loadUps(
    makeSnmp({
      values: healthyUps({
        [OID.OutputSource]: 5,
        [OID.BatteryStatus]: 3,
        [OID.Charge]: 20,
        [OID.Load(1)]: 95,
        [OID.AlarmsPresent]: 2,
      }),
    })
  );

  const Result = await Ups.Run(target({ MinCharge: 50, MaxLoad: 90 }));

  assert.equal(Result.Success, true, 'a degraded UPS is still reachable');
  assert.equal(Result.Degraded, true);
  assert.deepEqual(Result.DegradedReason.split('; '), [
    'Low battery',
    'On battery',
    '2 active alarms',
    'Charge 20% < 50%',
    'Load 95% > 90%',
  ]);
});

// --- Threshold parsing ------------------------------------------------------

test('an unusable maximum falls back to the default rather than alarming forever', async () => {
  // MaxLoad and MaxTemperature come from numeric inputs the operator edits. A
  // saved 0 or a negative would make every reading breach the limit, so a
  // non-positive value is discarded in favour of the default.
  const Ups = loadUps(
    makeSnmp({ values: healthyUps({ [OID.Load(1)]: 40, [OID.Temperature]: 30 }) })
  );

  for (const Settings of [
    { MaxLoad: 0, MaxTemperature: 0 },
    { MaxLoad: -5, MaxTemperature: -10 },
    { MaxLoad: 'x', MaxTemperature: 'x' },
    {},
  ]) {
    const Result = await Ups.Run(target(Settings));
    assert.ok(!Result.Degraded, `settings ${JSON.stringify(Settings)} produced a false alarm`);
  }
});

test('an out-of-range MinCharge is clamped into 0-100, not discarded', async () => {
  // Deliberately different from the maximums above: a minimum has a meaningful
  // clamp (0 and 100 are both valid asks), so 500 means "always full" rather
  // than "use the default". Worth pinning because the two behaviours differ.
  const Ups = loadUps(makeSnmp({ values: healthyUps({ [OID.Charge]: 60 }) }));

  const Clamped = await Ups.Run(target({ MinCharge: 500 }));
  assert.equal(Clamped.Degraded, true);
  assert.match(Clamped.DegradedReason, /Charge 60% < 100%/);

  const Negative = await Ups.Run(target({ MinCharge: -20 }));
  assert.ok(!Negative.Degraded, 'a negative minimum should clamp to 0, not invert the check');
});

// --- Debug rendering --------------------------------------------------------

test('the debug panel shows the host, transport identity and readings', async () => {
  const Ups = loadUps(makeSnmp({ values: healthyUps() }));
  const T = target({ Port: 1610, Community: 'showtrak', Version: '2c' });
  const Result = await Ups.Run(T);

  const Html = Ups.Debug(Result, T);
  assert.match(Html, /10\.0\.0\.20:1610/);
  assert.match(Html, /v2c · showtrak/);
  assert.match(Html, /Healthy/);
  assert.match(Html, /Normal/); // battery status + output source labels
  assert.match(Html, /100%/);
  assert.match(Html, /45 min/);
  assert.match(Html, /240 V/);
});

test('the debug panel escapes the community string', () => {
  // It is operator-entered free text rendered into the debug modal.
  const Ups = loadUps(makeSnmp());
  const Html = Ups.Debug({ Success: true }, target({ Community: '<img src=x onerror=alert(1)>' }));
  assert.doesNotMatch(Html, /<img/);
  assert.match(Html, /&lt;img/);
});

test('an offline UPS renders the error and a plain-language note', () => {
  const Ups = loadUps(makeSnmp());
  const Html = Ups.Debug({ Success: false, Error: 'Request timed out' }, target());
  assert.match(Html, /Offline/);
  assert.match(Html, /Request timed out/);
  assert.match(Html, /Could not reach the UPS over SNMP/);
});

test('an offline result with no error string still says something useful', () => {
  const Ups = loadUps(makeSnmp());
  assert.match(Ups.Debug({ Success: false }, target()), /No SNMP reply/);
});

test('a degraded UPS renders its reason in place of the Healthy pill', () => {
  const Ups = loadUps(makeSnmp());
  const Html = Ups.Debug({ Success: true, Degraded: true, DegradedReason: 'On battery' }, target());
  assert.match(Html, /On battery/);
  assert.doesNotMatch(Html, />Healthy</);
});

test('unmapped status codes render the raw number instead of undefined', () => {
  const Ups = loadUps(makeSnmp());
  const Html = Ups.Debug({ Success: true, BatteryStatus: 99, OutputSource: 42 }, target());
  assert.match(Html, /99/);
  assert.match(Html, /42/);
  assert.doesNotMatch(Html, /undefined/);
});

test('the v1/v2c method advertises the settings the editor renders', () => {
  const Ups = loadUps(makeSnmp());
  assert.equal(Ups.ID, 'snmp-ups');
  const Keys = Ups.Settings.map((S) => S.Key);
  assert.deepEqual(Keys, [
    'Port',
    'Community',
    'Version',
    'OutputIndex',
    'CheckCharge',
    'MinCharge',
    'CheckLoad',
    'MaxLoad',
    'CheckTemperature',
    'MaxTemperature',
    'Timeout',
    'Retries',
  ]);
  // Each threshold field is only shown once its own check is enabled.
  for (const Key of ['MinCharge', 'MaxLoad', 'MaxTemperature']) {
    const Field = Ups.Settings.find((S) => S.Key === Key);
    assert.equal(Field.VisibleWhen.Equals, true);
  }
});

// --- SNMPv3 -----------------------------------------------------------------

const v3target = (Settings = {}, Address = '10.0.0.30') => ({
  Address,
  Settings: {
    Username: 'showtrak',
    AuthPassword: 'authpass',
    PrivPassword: 'privpass',
    ...Settings,
  },
});

test('v3 refuses to probe without the credentials its level requires', async () => {
  const Snmp = makeSnmp({ values: healthyUps() });
  const V3 = loadUpsV3(Snmp);

  const Cases = [
    [{ Username: '' }, /No SNMPv3 username/],
    [{ AuthPassword: '' }, /Auth password required/],
    [{ PrivPassword: '' }, /Priv password required/],
  ];
  for (const [Settings, Expected] of Cases) {
    const Result = await V3.Run(v3target(Settings));
    assert.equal(Result.Success, false);
    assert.match(Result.Error, Expected);
  }
  assert.equal(Snmp.created.length, 0, 'a session was opened with incomplete credentials');
});

test('v3 rejects a missing address and a bad port like the v2c method', async () => {
  const Snmp = makeSnmp({ values: healthyUps() });
  const V3 = loadUpsV3(Snmp);

  assert.match((await V3.Run(v3target({}, ''))).Error, /No address configured/);
  assert.match((await V3.Run(v3target({ Port: 70000 }))).Error, /Invalid port/);
  assert.equal(Snmp.created.length, 0);
});

test('v3 builds an authPriv user by default', async () => {
  const Snmp = makeSnmp({ values: healthyUps() });
  const V3 = loadUpsV3(Snmp);

  await V3.Run(v3target());

  const [Created] = Snmp.created;
  assert.equal(Created.kind, 'v3');
  assert.deepEqual(Created.user, {
    name: 'showtrak',
    level: 'authPriv',
    authProtocol: 'auth:sha',
    authKey: 'authpass',
    privProtocol: 'priv:aes',
    privKey: 'privpass',
  });
  assert.equal(Created.options.version, 'V3');
});

test('privacy is forced off when authentication is off', async () => {
  // Priv without auth is not valid SNMPv3. Letting the two disagree produces a
  // user the card rejects, which reads to the operator as "UPS offline".
  const Snmp = makeSnmp({ values: healthyUps() });
  const V3 = loadUpsV3(Snmp);

  await V3.Run(v3target({ AuthProtocol: 'none', PrivProtocol: 'aes256b', AuthPassword: '' }));

  assert.deepEqual(Snmp.created[0].user, { name: 'showtrak', level: 'noAuthNoPriv' });
});

test('auth without privacy yields authNoPriv and omits the priv fields', async () => {
  const Snmp = makeSnmp({ values: healthyUps() });
  const V3 = loadUpsV3(Snmp);

  await V3.Run(v3target({ PrivProtocol: 'none' }));

  assert.deepEqual(Snmp.created[0].user, {
    name: 'showtrak',
    level: 'authNoPriv',
    authProtocol: 'auth:sha',
    authKey: 'authpass',
  });
});

test('an unrecognised protocol falls back to a strong default, never to none', () => {
  // Downgrading an unknown value to 'none' would silently drop authentication
  // and encryption on a check the operator configured as secure.
  const V3 = loadUpsV3(makeSnmp());
  const Config = V3._internal.ParseConfig(
    v3target({ AuthProtocol: 'rot13', PrivProtocol: 'rot13' })
  );
  assert.equal(Config.AuthProtocol, 'sha');
  assert.equal(Config.PrivProtocol, 'aes');
});

test('every offered protocol maps to a real net-snmp constant', () => {
  const V3 = loadUpsV3(makeSnmp());
  const { ParseConfig, BuildUser } = V3._internal;

  for (const Auth of ['sha', 'sha224', 'sha256', 'sha384', 'sha512', 'md5']) {
    const User = BuildUser(ParseConfig(v3target({ AuthProtocol: Auth })));
    assert.equal(User.authProtocol, `auth:${Auth}`, `auth protocol ${Auth}`);
  }
  for (const Priv of ['aes', 'aes256b', 'aes256r', 'des']) {
    const User = BuildUser(ParseConfig(v3target({ PrivProtocol: Priv })));
    assert.equal(User.privProtocol, `priv:${Priv}`, `priv protocol ${Priv}`);
  }
});

test('a context is only sent when one is configured', async () => {
  const Snmp = makeSnmp({ values: healthyUps() });
  const V3 = loadUpsV3(Snmp);

  await V3.Run(v3target());
  assert.ok(!('context' in Snmp.created[0].options));

  await V3.Run(v3target({ Context: 'ups-a' }));
  assert.equal(Snmp.created[1].options.context, 'ups-a');
});

test('v3 runs the same probe and health evaluation as v2c', async () => {
  const V3 = loadUpsV3(makeSnmp({ values: healthyUps({ [OID.OutputSource]: 5 }) }));
  const Result = await V3.Run(v3target({ OutputIndex: 2 }));

  assert.equal(Result.Success, true);
  assert.equal(Result.Degraded, true);
  assert.match(Result.DegradedReason, /On battery/);
});

test('the v3 debug panel names the user and its effective security level', () => {
  const V3 = loadUpsV3(makeSnmp());
  const Result = { Success: true };

  assert.match(V3.Debug(Result, v3target()), /showtrak · authPriv \(sha\/aes\)/);
  assert.match(
    V3.Debug(Result, v3target({ PrivProtocol: 'none' })),
    /showtrak · authNoPriv \(sha\)/
  );
  assert.match(
    V3.Debug(Result, v3target({ AuthProtocol: 'none' })),
    /showtrak · noAuthNoPriv(?! \()/
  );
});

test('the v3 debug panel escapes the username', () => {
  const V3 = loadUpsV3(makeSnmp());
  const Html = V3.Debug({ Success: true }, v3target({ Username: '<script>x</script>' }));
  assert.doesNotMatch(Html, /<script>/);
});

test('the v3 method advertises its own credential settings', () => {
  const V3 = loadUpsV3(makeSnmp());
  assert.equal(V3.ID, 'snmp-ups-v3');
  const Keys = V3.Settings.map((S) => S.Key);
  for (const Key of ['Username', 'AuthProtocol', 'AuthPassword', 'PrivProtocol', 'PrivPassword']) {
    assert.ok(Keys.includes(Key), `${Key} is not offered in the editor`);
  }
  assert.ok(!Keys.includes('Community'), 'v3 must not offer a community string');
});

test('both methods share the same interval and report a name and description', () => {
  const Ups = loadUps(makeSnmp());
  const V3 = loadUpsV3(makeSnmp());
  assert.equal(Ups.DefaultInterval, V3.DefaultInterval);
  for (const M of [Ups, V3]) {
    assert.ok(M.Name.length > 0);
    assert.ok(M.Description.length > 0);
  }
});
