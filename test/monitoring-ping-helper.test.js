const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// The Windows ping helper's client (src/Modules/MonitoringMethods/_ping-helper.ts):
// one long-lived process answers every ping over a line protocol. The real
// helper is Windows PowerShell; here a small Node script speaks the same
// protocol so the client's restart, timeout, fallback and idle handling can be
// exercised anywhere. The PowerShell side is checked on Windows by the
// validation script that ships with the change.
//
// The rule that matters most: anything the helper cannot answer properly comes
// back null, and ping.ts then runs ping.exe. A broken helper may cost speed but
// must never read a device as down.

const { PingHelperClient, ParseHelperAnswer, HELPER_SCRIPT, DefaultHelperCommand } = require(
  path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', '_ping-helper.js')
);

// Behaviour keyed on the address: answers, failures, stalls and crashes.
const FAKE = `
const rl = require('readline').createInterface({ input: process.stdin });
if (process.env.FAKE_NO_READY !== '1') process.stdout.write('READY 1\\n');
rl.on('line', (line) => {
  const [id, timeout, host] = line.split(' ');
  const say = (s) => process.stdout.write(id + ' ' + s + '\\n');
  if (host === 'up') say('OK 7');
  else if (host === 'fast') say('OK 0');
  else if (host === 'down') setTimeout(() => say('FAIL TimedOut'), Number(timeout));
  else if (host === 'unreachable') say('FAIL DestinationHostUnreachable');
  else if (host === 'nohost') say('ERR System.Net.Sockets.SocketException No such host is known');
  else if (host === 'weird') say('ERR System.InvalidOperationException something broke');
  else if (host === 'crash') process.exit(3);
  else if (host === 'split') { process.stdout.write(id + ' O'); setTimeout(() => process.stdout.write('K 12\\r\\n'), 20); }
  // 'stall': never answers
});
rl.on('close', () => process.exit(0));
`;

function client(Options = {}) {
  return new PingHelperClient(
    { File: process.execPath, Args: ['-e', FAKE] },
    { ResponseGraceMs: 300, ReadyTimeoutMs: 2000, IdleShutdownMs: 200, ...Options }
  );
}

const sleep = (Ms) => new Promise((R) => setTimeout(R, Ms));

test('answers map to what ping.exe would have reported', async () => {
  const C = client();
  try {
    assert.deepEqual(await C.Ping('up', 1000), { Success: true, LatencyMs: 7 });
    // ping.exe reads a sub-millisecond reply as "time<1ms" = 1.
    assert.deepEqual(await C.Ping('fast', 1000), { Success: true, LatencyMs: 1 });
    assert.deepEqual(await C.Ping('down', 50), { Success: false, Error: 'Host unreachable' });
    assert.deepEqual(await C.Ping('unreachable', 1000), {
      Success: false,
      Error: 'Destination host unreachable',
    });
    assert.deepEqual(await C.Ping('nohost', 1000), { Success: false, Error: 'Host unreachable' });
    assert.deepEqual(await C.Ping('split', 1000), { Success: true, LatencyMs: 12 });
  } finally {
    C.Shutdown();
  }
});

test('many pings share one process and resolve independently', async () => {
  const C = client();
  try {
    const Results = await Promise.all([
      C.Ping('down', 150),
      ...Array.from({ length: 20 }, () => C.Ping('up', 1000)),
    ]);
    assert.equal(Results.filter((R) => R && R.Success).length, 20);
    assert.equal(Results[0].Success, false);
  } finally {
    C.Shutdown();
  }
});

test('an unexpected helper error falls back instead of reading as down', async () => {
  const C = client();
  try {
    assert.equal(await C.Ping('weird', 1000), null);
    // The helper itself is fine and keeps answering.
    assert.deepEqual(await C.Ping('up', 1000), { Success: true, LatencyMs: 7 });
  } finally {
    C.Shutdown();
  }
});

test('a crash falls back for what was in flight, and the next ping restarts it', async () => {
  const C = client();
  try {
    const InFlight = C.Ping('stall', 5000);
    const Crash = C.Ping('crash', 1000);
    assert.equal(await Crash, null);
    assert.equal(await InFlight, null);
    assert.deepEqual(await C.Ping('up', 1000), { Success: true, LatencyMs: 7 });
  } finally {
    C.Shutdown();
  }
});

test('a wedged helper is replaced once a request outlives its timeout', async () => {
  const C = client();
  try {
    // Once it is up (a request sent while it starts also gets the start-up allowance).
    assert.ok(await C.Ping('up', 1000));
    const Started = Date.now();
    assert.equal(await C.Ping('stall', 100), null, 'falls back');
    assert.ok(Date.now() - Started < 2000, 'within its timeout plus the grace');
    assert.deepEqual(await C.Ping('up', 1000), { Success: true, LatencyMs: 7 });
  } finally {
    C.Shutdown();
  }
});

test('repeated failures disable the helper for a while', async () => {
  const C = client({ FailureLimit: 2, DisableMs: 60_000 });
  try {
    assert.equal(await C.Ping('crash', 1000), null);
    assert.equal(C.Available(), true);
    assert.equal(await C.Ping('crash', 1000), null);
    assert.equal(C.Available(), false, 'disabled after the second failure');
    assert.equal(await C.Ping('up', 1000), null, 'and pings fall back without starting it');
    assert.equal(C.Running, false);
  } finally {
    C.Shutdown();
  }
});

test('a helper that never reports ready is given up on', async () => {
  const C = new PingHelperClient(
    { File: process.execPath, Args: ['-e', 'setInterval(() => {}, 1000)'] },
    { ReadyTimeoutMs: 150, ResponseGraceMs: 100, IdleShutdownMs: 200 }
  );
  try {
    assert.equal(await C.Ping('up', 100), null);
  } finally {
    C.Shutdown();
  }
});

test('a helper that cannot start falls back at once', async () => {
  const C = new PingHelperClient({ File: '/nonexistent/powershell.exe', Args: [] });
  assert.equal(await C.Ping('up', 1000), null);
  C.Shutdown();
});

test('an idle helper shuts itself down and starts again on demand', async () => {
  const C = client({ IdleShutdownMs: 100 });
  try {
    assert.ok(await C.Ping('up', 1000));
    assert.equal(C.Running, true);
    await sleep(300);
    assert.equal(C.Running, false, 'stopped after going idle');
    assert.deepEqual(await C.Ping('up', 1000), { Success: true, LatencyMs: 7 });
  } finally {
    C.Shutdown();
  }
});

test('an address that is not a single token is never sent', async () => {
  const C = client();
  try {
    for (const Address of ['two words', 'line\nbreak', '', 'x'.repeat(300)]) {
      assert.equal(await C.Ping(Address, 1000), null, JSON.stringify(Address));
    }
    assert.equal(C.Running, false, 'nothing was started for them');
  } finally {
    C.Shutdown();
  }
});

test('answer parsing', () => {
  assert.equal(ParseHelperAnswer('OK', 'abc'), null);
  assert.deepEqual(ParseHelperAnswer('FAIL', 'TtlExpired'), {
    Success: false,
    Error: 'TTL expired',
  });
  assert.deepEqual(ParseHelperAnswer('FAIL', 'Unknown'), {
    Success: false,
    Error: 'Host unreachable',
  });
  assert.equal(ParseHelperAnswer('HELLO', 'x'), undefined);
});

test('the shipped command runs the stock Windows PowerShell with the script encoded', () => {
  const Command = DefaultHelperCommand();
  assert.match(Command.File, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  const Encoded = Command.Args[Command.Args.indexOf('-EncodedCommand') + 1];
  assert.equal(Buffer.from(Encoded, 'base64').toString('utf16le'), HELPER_SCRIPT);
  // A command that names the pipeline-input variable makes powershell.exe read
  // stdin itself, which would swallow the requests.
  assert.doesNotMatch(HELPER_SCRIPT, /\$input\b/i);
  assert.ok(HELPER_SCRIPT.includes("Reply 'READY 1'"));
});
