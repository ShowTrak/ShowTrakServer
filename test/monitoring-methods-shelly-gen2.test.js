const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const { loadWithMocks } = require('../test-support/load-with-mocks');

// The Shelly Gen2+ check against a fake `http` module that speaks the device's
// RPC-over-HTTP channel as shelly-api-docs.shelly.cloud/gen2 documents it: GET
// /rpc/<method>?<params> answered with the bare result, errors as
// {code, message}, and SHA-256 digest auth (user admin, realm = device id,
// response = SHA-256(HA1:nonce:nc:cnonce:auth:HA2)). The mock recomputes the
// digest itself, so a wrong hash or a wrong URI fails here as on a device.

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

const sha256 = (Value) => crypto.createHash('sha256').update(Value, 'utf8').digest('hex');
const REALM = 'shellypro4pm-f008d1d8b8b8';
const NONCE = '60dc59c6';

function parseAuthParams(Header) {
  const Params = {};
  const Re = /([a-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/gi;
  let Match;
  while ((Match = Re.exec(String(Header || ''))) !== null) {
    Params[Match[1].toLowerCase()] =
      Match[2] !== undefined ? Match[2].replace(/\\(.)/g, '$1') : Match[3];
  }
  return Params;
}

function makeResponse(Status, Headers, Body) {
  const Res = new EventEmitter();
  Res.statusCode = Status;
  Res.headers = Headers || {};
  setImmediate(() => {
    if (Body) Res.emit('data', Buffer.from(String(Body), 'utf8'));
    Res.emit('end');
  });
  return Res;
}

const DEVICE_INFO = {
  name: 'Rack PDU',
  id: REALM,
  mac: 'F008D1D8B8B8',
  model: 'SPSW-104PE16EU',
  gen: 2,
  fw_id: '20230913-114150/v1.0.3-gb1aa9a8',
  ver: '1.0.3',
  app: 'Pro4PM',
  auth_en: true,
  auth_domain: REALM,
};

function healthyStatus(Overrides = {}) {
  return {
    sys: { mac: 'F008D1D8B8B8', uptime: 1234 },
    wifi: { sta_ip: '10.0.0.40', status: 'got ip', ssid: 'Show', rssi: -58 },
    cloud: { connected: false },
    'switch:0': {
      id: 0,
      source: 'init',
      output: true,
      apower: 120.4,
      voltage: 231.2,
      current: 0.52,
      temperature: { tC: 41.2, tF: 106.2 },
    },
    'switch:1': { id: 1, output: false, apower: 0, voltage: 231.1, current: 0 },
    'input:0': { id: 0, state: false },
    'temperature:100': { id: 100, tC: 22.5, tF: 72.5 },
    'humidity:0': { id: 0, rh: 45 },
    ...Overrides,
  };
}

/**
 * @param {object} o
 * @param {object} o.routes    method -> result object, or (query) => result | { Status, Body }
 * @param {string} o.password  when set, digest auth is required
 * @param {boolean} o.refuse   emit ECONNREFUSED
 * @param {boolean} o.silent   never answer
 * @param {string} o.algorithm algorithm advertised in the challenge
 */
function makeShelly(o = {}) {
  const { routes = {}, password = null, refuse = false, silent = false } = o;
  const algorithm = o.algorithm || 'SHA-256';
  const calls = [];

  const request = (Opts) => {
    const Req = new EventEmitter();
    Req.destroy = (Err) => setImmediate(() => Req.emit('error', Err || new Error('destroyed')));
    Req.end = () => {
      const Headers = Opts.headers || {};
      calls.push({
        Method: Opts.method,
        Path: Opts.path,
        Port: Opts.port,
        Authorization: Headers.Authorization || null,
      });
      if (refuse) {
        return setImmediate(() =>
          Req.emit(
            'error',
            Object.assign(new Error(`connect ECONNREFUSED ${Opts.hostname}:${Opts.port}`), {
              code: 'ECONNREFUSED',
            })
          )
        );
      }
      if (silent) return;

      if (password != null) {
        const Provided = Headers.Authorization;
        const Challenge = `Digest qop="auth", realm="${REALM}", nonce="${NONCE}", algorithm=${algorithm}`;
        if (!Provided) {
          return Req.emit('response', makeResponse(401, { 'www-authenticate': Challenge }, ''));
        }
        const P = parseAuthParams(Provided.replace(/^Digest\s+/i, ''));
        const HA1 = sha256(`admin:${REALM}:${password}`);
        const HA2 = sha256(`${Opts.method}:${P.uri}`);
        const Want = sha256(`${HA1}:${P.nonce}:${P.nc}:${P.cnonce}:${P.qop}:${HA2}`);
        const Ok =
          P.username === 'admin' &&
          P.realm === REALM &&
          P.nonce === NONCE &&
          P.uri === Opts.path &&
          P.algorithm === 'SHA-256' &&
          P.qop === 'auth' &&
          P.nc === '00000001' &&
          P.response === Want;
        if (!Ok) {
          return Req.emit('response', makeResponse(401, { 'www-authenticate': Challenge }, ''));
        }
      }

      const Url = new URL(`http://x${Opts.path}`);
      const Method = Url.pathname.replace(/^\/rpc\//, '');
      const Query = Object.fromEntries(Url.searchParams.entries());
      let Route = routes[Method];
      if (typeof Route === 'function') Route = Route(Query);
      if (Route === undefined) {
        return Req.emit(
          'response',
          makeResponse(404, {}, JSON.stringify({ code: 404, message: `No handler for ${Method}` }))
        );
      }
      if (Route && Route.Status) {
        return Req.emit('response', makeResponse(Route.Status, {}, Route.Body));
      }
      Req.emit('response', makeResponse(200, {}, JSON.stringify(Route)));
    };
    return Req;
  };
  return { http: { request }, calls };
}

function load(device) {
  return loadWithMocks(methodPath('shelly-gen2.js'), { http: device.http });
}

const target = (Settings = {}) => ({
  Address: '10.0.0.40',
  Settings: { Timeout: 2000, ...Settings },
});

test('shelly-gen2 exposes the expected shape', () => {
  const m = load(makeShelly());
  assert.equal(m.ID, 'shelly-gen2');
  assert.equal(typeof m.Run, 'function');
  assert.equal(typeof m.RunAction, 'function');
  const keys = m.Settings.map((s) => s.Key);
  for (const key of [
    'Password',
    'SwitchesOn',
    'SwitchesOff',
    'MaxPower',
    'MinRssi',
    'CheckErrors',
  ]) {
    assert.ok(keys.includes(key), `missing setting ${key}`);
  }
  assert.ok(!keys.includes('Username'), 'the username is always admin');
  assert.equal(m.Settings.find((s) => s.Key === 'Password').Sensitive, true);
});

test('a healthy device is online and reports identity and readings', async () => {
  const dev = makeShelly({
    routes: { 'Shelly.GetDeviceInfo': DEVICE_INFO, 'Shelly.GetStatus': healthyStatus() },
  });
  const r = await load(dev).Run(target());
  assert.equal(r.Success, true);
  assert.ok(!r.Degraded, r.DegradedReason);
  assert.equal(r.DeviceName, 'Rack PDU');
  assert.equal(r.App, 'Pro4PM');
  assert.equal(r.Firmware, '1.0.3');
  assert.equal(r.Generation, 2);
  assert.deepEqual(
    r.Switches.map((s) => [s.Id, s.Output, s.Power]),
    [
      [0, true, 120.4],
      [1, false, 0],
    ]
  );
  assert.equal(r.Switches[0].TempC, 41.2);
  assert.deepEqual(r.Temperatures, [{ Id: 100, Value: 22.5 }]);
  assert.deepEqual(r.Humidities, [{ Id: 0, Value: 45 }]);
  assert.equal(r.WifiRssi, -58);
  assert.deepEqual(
    dev.calls.map((c) => [c.Method, c.Path, c.Port]),
    [
      ['GET', '/rpc/Shelly.GetDeviceInfo', 80],
      ['GET', '/rpc/Shelly.GetStatus', 80],
    ]
  );
});

test('digest auth: a correct password is accepted with SHA-256, a wrong one fails', async () => {
  const routes = { 'Shelly.GetDeviceInfo': DEVICE_INFO, 'Shelly.GetStatus': healthyStatus() };
  const dev = makeShelly({ routes, password: 's3cret"pw' });
  const ok = await load(dev).Run(target({ Password: 's3cret"pw' }));
  assert.equal(ok.Success, true, ok.Error);
  // Challenged then signed, per request.
  assert.deepEqual(
    dev.calls.map((c) => !!c.Authorization),
    [false, true, false, true]
  );
  assert.match(dev.calls[1].Authorization, /^Digest username="admin", realm="shellypro4pm/);
  assert.match(dev.calls[1].Authorization, /algorithm=SHA-256/);

  const bad = await load(makeShelly({ routes, password: 's3cret' })).Run(
    target({ Password: 'wrong' })
  );
  assert.equal(bad.Success, false);
  assert.match(bad.Error, /check the password/);

  const none = await load(makeShelly({ routes, password: 's3cret' })).Run(target());
  assert.equal(none.Success, false);
  assert.match(none.Error, /set its password/);
});

test('a challenge with an algorithm other than SHA-256 is refused, not guessed at', async () => {
  const dev = makeShelly({
    routes: { 'Shelly.GetDeviceInfo': DEVICE_INFO },
    password: 'pw',
    algorithm: 'MD5',
  });
  const r = await load(dev).Run(target({ Password: 'pw' }));
  assert.equal(r.Success, false);
  assert.match(r.Error, /Unsupported digest algorithm "MD5"/);
  assert.equal(dev.calls.length, 1);
});

test('brute-force throttling (HTTP 429) is reported as such', async () => {
  const dev = makeShelly({
    routes: { 'Shelly.GetDeviceInfo': { Status: 429, Body: '' } },
  });
  const r = await load(dev).Run(target());
  assert.equal(r.Success, false);
  assert.match(r.Error, /too many failed attempts/);
});

test('offline: refused connection and a silent device both fail inside the budget', async () => {
  const refused = await load(makeShelly({ refuse: true })).Run(target());
  assert.equal(refused.Success, false);
  assert.match(refused.Error, /ECONNREFUSED/);

  const Started = Date.now();
  const silent = await load(makeShelly({ silent: true })).Run(target({ Timeout: 600 }));
  assert.equal(silent.Success, false);
  assert.match(silent.Error, /timed out/i);
  assert.ok(Date.now() - Started < 2000, 'the probe must respect its timeout');
});

test('malformed replies and Gen1 devices are offline with a clear reason', async () => {
  const notJson = await load(
    makeShelly({ routes: { 'Shelly.GetDeviceInfo': { Status: 200, Body: '<html>' } } })
  ).Run(target());
  assert.equal(notJson.Success, false);
  assert.match(notJson.Error, /not a JSON object/);

  const notShelly = await load(
    makeShelly({ routes: { 'Shelly.GetDeviceInfo': { hello: 'world' } } })
  ).Run(target());
  assert.equal(notShelly.Success, false);
  assert.match(notShelly.Error, /not from a Gen2 or newer Shelly/);

  const gen1 = await load(
    makeShelly({ routes: { 'Shelly.GetDeviceInfo': { Status: 404, Body: 'Not Found' } } })
  ).Run(target());
  assert.equal(gen1.Success, false);
  assert.match(gen1.Error, /Gen1 Shelly devices/);
});

test('switch, power, temperature, humidity and RSSI conditions degrade with reasons', async () => {
  const dev = makeShelly({
    routes: {
      'Shelly.GetDeviceInfo': DEVICE_INFO,
      'Shelly.GetStatus': healthyStatus({
        wifi: { status: 'got ip', ssid: 'Show', rssi: -82 },
        'temperature:100': { id: 100, tC: 38.04 },
        'humidity:0': { id: 0, rh: 12 },
      }),
    },
  });
  const r = await load(dev).Run(
    target({
      SwitchesOn: ['0', '1'],
      SwitchesOff: [0, 7],
      CheckPower: true,
      MaxPower: 100,
      CheckTemperature: true,
      MinTemperature: 5,
      MaxTemperature: 35,
      CheckHumidity: true,
      MinHumidity: 20,
      MaxHumidity: 70,
      CheckRssi: true,
      MinRssi: -75,
    })
  );
  assert.equal(r.Success, true);
  assert.equal(r.Degraded, true);
  const reasons = r.DegradedReason.split('; ');
  assert.deepEqual(reasons, [
    'Switch 1 is off (expected on)',
    'Switch 0 is on (expected off)',
    'Switch 7 not found',
    'Switch 0 drawing 120.4 W (max 100 W)',
    'Temperature 100 38°C (max 35°C)',
    'Humidity 0 12% (min 20%)',
    'Wi-Fi signal -82 dBm (min -75 dBm)',
  ]);
});

test('thresholds are skipped when disabled, and RSSI is skipped off Wi-Fi', async () => {
  const dev = makeShelly({
    routes: {
      'Shelly.GetDeviceInfo': DEVICE_INFO,
      'Shelly.GetStatus': healthyStatus({
        wifi: { status: 'disconnected', ssid: null, rssi: -100 },
        'temperature:100': { id: 100, tC: 80 },
      }),
    },
  });
  const r = await load(dev).Run(target({ CheckRssi: true, MinRssi: -60 }));
  assert.equal(r.Success, true);
  assert.ok(!r.Degraded, r.DegradedReason);
});

test('component errors and meter alarm flags degrade; count_disabled does not', async () => {
  const status = healthyStatus({
    'switch:0': { id: 0, output: false, errors: ['overtemp', 'overpower'] },
    'temperature:101': { id: 101, tC: null, errors: ['read'] },
    'em:0': {
      id: 0,
      total_act_power: 900,
      a_voltage: 230,
      total_current: 4,
      b_errors: ['out_of_range:voltage'],
      c_flags: ['overcurrent'],
    },
    'em1:0': { id: 0, act_power: 10, voltage: 230, current: 0.1, flags: ['count_disabled'] },
  });
  const dev = makeShelly({
    routes: { 'Shelly.GetDeviceInfo': DEVICE_INFO, 'Shelly.GetStatus': status },
  });
  const m = load(dev);
  const r = await m.Run(target());
  assert.equal(r.Degraded, true);
  assert.deepEqual(r.DegradedReason.split('; '), [
    'em:0: B: out_of_range:voltage, C: overcurrent',
    'switch:0: overtemp, overpower',
    'temperature:101: read',
  ]);
  assert.deepEqual(
    r.Meters.map((x) => [x.Key, x.Power]),
    [
      ['em:0', 900],
      ['em1:0', 10],
    ]
  );

  const off = await load(
    makeShelly({ routes: { 'Shelly.GetDeviceInfo': DEVICE_INFO, 'Shelly.GetStatus': status } })
  ).Run(target({ CheckErrors: false }));
  assert.ok(!off.Degraded, off.DegradedReason);
});

test('actions: on/off/toggle send Switch.Set and Switch.Toggle with the right params', async () => {
  const dev = makeShelly({
    password: 'pw',
    routes: {
      'Switch.Set': () => ({ was_on: true }),
      'Switch.Toggle': () => ({ was_on: true }),
    },
  });
  const m = load(dev);
  const T = target({ Password: 'pw' });

  assert.deepEqual(await m.RunAction(T, 'switch.on', { Switch: '2' }), {
    Success: true,
    Detail: 'Switch 2 turned on',
  });
  assert.deepEqual(await m.RunAction(T, 'switch.off', { Switch: '2' }), {
    Success: true,
    Detail: 'Switch 2 turned off',
  });
  assert.deepEqual(await m.RunAction(T, 'switch.toggle', { Switch: '0' }), {
    Success: true,
    Detail: 'Switch 0 turned off',
  });
  const signed = dev.calls.filter((c) => c.Authorization).map((c) => c.Path);
  assert.deepEqual(signed, [
    '/rpc/Switch.Set?id=2&on=true',
    '/rpc/Switch.Set?id=2&on=false',
    '/rpc/Switch.Toggle?id=0',
  ]);
});

test('actions: power cycle uses toggle_after, and refuses a switch that is already off', async () => {
  let output = true;
  const dev = makeShelly({
    routes: {
      'Switch.GetStatus': (q) => ({ id: Number(q.id), output }),
      'Switch.Set': () => ({ was_on: true }),
    },
  });
  const m = load(dev);
  const r = await m.RunAction(target(), 'switch.cycle', { Switch: '1', OffSeconds: '10' });
  assert.deepEqual(r, {
    Success: true,
    Detail: 'Switch 1 turned off; the device turns it back on in 10 s',
  });
  assert.deepEqual(
    dev.calls.map((c) => c.Path),
    ['/rpc/Switch.GetStatus?id=1', '/rpc/Switch.Set?id=1&on=false&toggle_after=10']
  );

  output = false;
  const refused = await m.RunAction(target(), 'switch.cycle', { Switch: '1', OffSeconds: '10' });
  assert.equal(refused.Success, false);
  assert.match(refused.Error, /already off/);
  assert.equal(dev.calls.length, 3, 'nothing is sent after the status read');
});

test('actions: bad parameters are refused before anything is sent', async () => {
  const dev = makeShelly({ routes: {} });
  const m = load(dev);
  for (const [Action, Params, Pattern] of [
    ['switch.off', {}, /Switch must be a number/],
    ['switch.off', { Switch: 'all' }, /Switch must be a number/],
    ['switch.cycle', { Switch: '0' }, /Off time must be/],
    ['switch.cycle', { Switch: '0', OffSeconds: '0' }, /Off time must be/],
    ['switch.cycle', { Switch: '0', OffSeconds: '99999' }, /Off time must be/],
    ['reboot', { Switch: '0' }, /Unknown Shelly action/],
  ]) {
    const r = await m.RunAction(target(), Action, Params);
    assert.equal(r.Success, false);
    assert.match(r.Error, Pattern);
  }
  assert.equal(dev.calls.length, 0);
});

test('actions: a device RPC error (bad id, precondition) is passed to the operator', async () => {
  const dev = makeShelly({
    routes: {
      'Switch.Set': (q) =>
        q.id === '9'
          ? { Status: 500, Body: JSON.stringify({ code: -105, message: 'Bad id=9' }) }
          : {
              Status: 500,
              Body: JSON.stringify({ code: -109, message: 'Overtemp condition present' }),
            },
    },
  });
  const m = load(dev);
  const bad = await m.RunAction(target(), 'switch.on', { Switch: '9' });
  assert.deepEqual(bad, { Success: false, Error: 'This device has no switch 9' });
  const pre = await m.RunAction(target(), 'switch.on', { Switch: '0' });
  assert.equal(pre.Success, false);
  assert.match(pre.Error, /Overtemp condition present \(error -109\)/);
});

test('action metadata: off, toggle and cycle are destructive with no defaults', () => {
  const m = load(makeShelly());
  const byId = Object.fromEntries(m.Actions.map((a) => [a.ID, a]));
  assert.deepEqual(Object.keys(byId), ['switch.on', 'switch.off', 'switch.toggle', 'switch.cycle']);
  assert.ok(!byId['switch.on'].Destructive);
  for (const id of ['switch.off', 'switch.toggle', 'switch.cycle']) {
    assert.equal(byId[id].Destructive, true);
    for (const p of byId[id].Params) {
      assert.equal(p.Min, undefined);
      assert.equal(p.Max, undefined);
      assert.ok(p.Default === undefined || p.Default === '', `${id}/${p.Key} has a default`);
    }
  }
  assert.deepEqual(m.GetActionOptions({ Switches: [{ Id: 0 }, { Id: 1 }] }), {
    Switch: [
      { value: '0', label: 'Switch 0' },
      { value: '1', label: 'Switch 1' },
    ],
  });
  assert.deepEqual(m.GetActionOptions({}), {});
  assert.equal(
    m.DescribeAction('switch.cycle', { Switch: '3', OffSeconds: '5' }),
    'Power Cycle Switch 3 (5 s)'
  );
  assert.equal(m.DescribeAction('switch.off', { Switch: '' }), null);
});

test('Debug escapes every device-supplied value', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  const dev = makeShelly({
    routes: {
      'Shelly.GetDeviceInfo': { ...DEVICE_INFO, name: evil, app: evil, ver: evil },
      'Shelly.GetStatus': healthyStatus({
        wifi: { status: 'got ip', ssid: evil, rssi: -50 },
        [`switch:0`]: { id: 0, output: true, errors: [evil] },
      }),
    },
  });
  const m = load(dev);
  const T = target();
  const r = await m.Run(T);
  const html = m.Debug(r, T);
  assert.ok(!html.includes('<img'), 'raw markup leaked into the debug panel');
  assert.ok(html.includes('&lt;img'));

  const offline = m.Debug({ Success: false, Error: evil }, { Address: evil, Settings: {} });
  assert.ok(!offline.includes('<img'));
});
