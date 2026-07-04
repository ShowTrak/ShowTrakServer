const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'src', 'Modules', 'MonitoringMethods', name);
}

function load(name) {
  return loadWithMocks(methodPath(name), {});
}

test('ping Debug reports reachability and latency', () => {
  const ping = load('ping.js');
  const html = ping.Debug({ Success: true, LatencyMs: 12.4 }, { Address: '10.0.0.1' });
  assert.equal(typeof html, 'string');
  assert.match(html, /10\.0\.0\.1/);
  assert.match(html, /12 ms/);
  assert.match(html, /Yes/);

  const down = ping.Debug({ Success: false, Error: 'Host unreachable' }, { Address: '10.0.0.1' });
  assert.match(down, /Host unreachable/);
  assert.match(down, />No</);
});

test('tcp-port Debug shows configured port and open/closed state', () => {
  const tcp = load('tcp-port.js');
  const html = tcp.Debug(
    { Success: true, LatencyMs: 5 },
    { Address: 'host.example', Settings: { Port: 3389 } }
  );
  assert.match(html, /3389/);
  assert.match(html, /Accepting/);
});

test('dns Debug lists resolved records and escapes untrusted values', () => {
  const dns = load('dns.js');
  const html = dns.Debug(
    {
      Success: true,
      LatencyMs: 8,
      RecordType: 'A',
      Records: ['1.2.3.4', '<img src=x onerror=alert(1)>'],
    },
    { Address: 'example.com', Settings: { RecordType: 'A' } }
  );
  assert.match(html, /1\.2\.3\.4/);
  // The malicious record value must be HTML-escaped, not rendered as a tag.
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test('http Debug surfaces the response status code', () => {
  const http = load('http.js');
  const html = http.Debug(
    { Success: true, LatencyMs: 42, Status: 200 },
    { Address: 'example.com', Settings: { Path: '/health', Method: 'GET' } }
  );
  assert.match(html, /HTTP 200/);
  assert.match(html, /\/health/);
});

test('http-json Debug reports the resolved JSON value', () => {
  const httpJson = load('http-json.js');
  const html = httpJson.Debug(
    { Success: true, LatencyMs: 30, Status: 200, Mode: 'json', JsonPath: 'data.status', MatchedValue: 'ok' },
    { Address: 'example.com', Settings: { Scheme: 'https', Path: '/api' } }
  );
  assert.match(html, /data\.status/);
  assert.match(html, />ok</);
});

test('qlab Debug renders a row per workspace with name, id and passcode, escaping names', () => {
  const qlab = load('qlab.js');
  const html = qlab.Debug(
    {
      Success: true,
      LatencyMs: 15,
      Matched: true,
      Wanted: 'Main Show',
      Workspaces: [
        { uniqueID: 'ABC-123', displayName: 'Main Show', hasPasscode: true },
        { uniqueID: 'DEF-456', displayName: '<script>bad</script>', hasPasscode: false },
      ],
    },
    { Address: '10.0.0.5', Settings: { Port: 53000, Workspace: 'Main Show' } }
  );
  assert.match(html, /Main Show/);
  assert.match(html, /ABC-123/);
  assert.match(html, /DEF-456/);
  assert.match(html, /Passcode/);
  assert.match(html, /No passcode/);
  // Untrusted workspace name is escaped.
  assert.doesNotMatch(html, /<script>bad<\/script>/);
  assert.match(html, /&lt;script&gt;bad/);
});

test('MonitoringMethods.BuildDebug delegates to the method and guards unknowns', () => {
  const { Manager } = loadWithMocks(methodPath('index.js'), {});
  const html = Manager.BuildDebug('ping', { Success: true, LatencyMs: 3 }, { Address: '1.1.1.1' });
  assert.equal(typeof html, 'string');
  assert.match(html, /1\.1\.1\.1/);

  assert.equal(Manager.BuildDebug('does-not-exist', {}, {}), null);
});

// --- Advanced settings flags ------------------------------------------------
function advancedKeys(method) {
  return method.Settings.filter((f) => f.Advanced).map((f) => f.Key).sort();
}
function normalKeys(method) {
  return method.Settings.filter((f) => !f.Advanced).map((f) => f.Key).sort();
}

test('ping / tcp-port / qlab mark Timeout as an advanced setting', () => {
  assert.deepEqual(advancedKeys(load('ping.js')), ['Timeout']);
  assert.deepEqual(advancedKeys(load('tcp-port.js')), ['Timeout']);
  assert.deepEqual(advancedKeys(load('qlab.js')), ['Timeout']);
  // Core fields stay inline.
  assert.ok(normalKeys(load('tcp-port.js')).includes('Port'));
  assert.ok(normalKeys(load('qlab.js')).includes('Workspace'));
});

test('dns marks record type, resolver port and timeout advanced but keeps resolver + expected value inline', () => {
  const dns = load('dns.js');
  assert.deepEqual(advancedKeys(dns), ['RecordType', 'ResolverPort', 'Timeout']);
  const normal = normalKeys(dns);
  assert.ok(normal.includes('Resolver'));
  assert.ok(normal.includes('ExpectedValue'));
});

test('http marks status range, follow redirects, ignore tls errors and timeout advanced', () => {
  const http = load('http.js');
  assert.deepEqual(advancedKeys(http), [
    'ExpectedStatusMax',
    'ExpectedStatusMin',
    'FollowRedirects',
    'IgnoreTlsErrors',
    'Timeout',
  ]);
  const normal = normalKeys(http);
  assert.ok(normal.includes('Protocol'));
  assert.ok(normal.includes('Port'));
  assert.ok(normal.includes('Path'));
  assert.ok(normal.includes('Method'));
});

test('http-json marks Ignore TLS Errors and Timeout advanced', () => {
  const httpJson = load('http-json.js');
  assert.deepEqual(advancedKeys(httpJson), [
    'ExpectedStatusMax',
    'ExpectedStatusMin',
    'FollowRedirects',
    'IgnoreTlsErrors',
    'Timeout',
  ]);
  // The assertion inputs stay inline.
  const normal = normalKeys(httpJson);
  assert.ok(normal.includes('JsonPath'));
  assert.ok(normal.includes('ExpectedValue'));
});
