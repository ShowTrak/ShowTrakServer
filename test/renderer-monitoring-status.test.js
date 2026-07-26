const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Exercises the pure status/derivation layer of src/UI/js/app/monitoring.ts.
//
// This is what the operator reads to decide whether a UPS, a projector or a
// QLab machine is healthy. The failure that matters is not a crash but a
// plausible-looking wrong answer: a target reported Online because a check
// never ran, or an outage that disappears from the timeline because its samples
// landed in a block that got overwritten.
//
// Two behaviours here are subtle enough to be worth pinning explicitly:
//
//   - the offline-since timestamp comes from LastSuccessAt, NOT LastChecked.
//     LastChecked updates on every cycle including failures, so using it would
//     reset the "offline for 20 minutes" counter on every tick;
//   - a timeline block with no samples stays IDLE rather than inheriting a
//     neighbour, so a gap reads as "we don't know" instead of asserting a state
//     that was never observed.
//
// The module loads with no DOM (jQuery is only touched inside render functions).

const MODULE_PATH = path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app', 'monitoring.js');

const Monitoring = require(MODULE_PATH);
const {
  FormatInterval,
  FormatLatency,
  FormatMonitoringCheckSummary,
  FormatMonitoringAddressSub,
  FormatMonitoringMethodLabel,
  FormatMonitorStatus,
  FormatMonitorCompactStatus,
  IsMonitorAwaitingFirstCheck,
  GetMonitoringOfflineSince,
  MonitorStateLabel,
  DeriveSampleState,
  BuildStatusBlocksFromSamples,
  BuildOverallStatusBlocks,
  LiveCheckState,
  BuildLiveStatusText,
  MONITOR_STATE_SEVERITY,
} = Monitoring;

// Mirrors state/ui-drafts.ts — a 1-hour window split into 60 one-minute blocks.
const WINDOW_MS = 60 * 60 * 1000;
const BLOCK_COUNT = 60;
const BLOCK_MS = WINDOW_MS / BLOCK_COUNT;

const checks = (...methods) => ({ Checks: methods.map((Method) => ({ Method })) });

// --- Interval and latency formatting ---------------------------------------

test('intervals read in seconds below a minute and minutes above', () => {
  assert.equal(FormatInterval(5000), '5s');
  assert.equal(FormatInterval(59999), '60s');
  assert.equal(FormatInterval(60000), '1m');
  assert.equal(FormatInterval(90000), '1m 30s');
  assert.equal(FormatInterval(3600000), '60m');
});

test('an unusable interval reads as 0s, not NaN', () => {
  for (const Value of [null, undefined, 'soon', {}, NaN]) {
    assert.equal(FormatInterval(Value), '0s', `interval ${String(Value)}`);
  }
});

test('sub-millisecond latency is shown as <1ms rather than rounding to 0ms', () => {
  // A local check really can answer in under a millisecond, and "0ms" reads as
  // a broken measurement.
  assert.equal(FormatLatency(0.4), '<1ms');
  assert.equal(FormatLatency(0), '<1ms');
  assert.equal(FormatLatency(1), '1ms');
  assert.equal(FormatLatency(12.6), '13ms');
});

test('absent latency renders as nothing, so the caller can fall back', () => {
  assert.equal(FormatLatency(null), '');
  assert.equal(FormatLatency(undefined), '');
});

// --- Check summary ----------------------------------------------------------

test('known methods get their short label and duplicates collapse', () => {
  assert.equal(FormatMonitoringCheckSummary(checks('ping')), 'PING');
  assert.equal(FormatMonitoringCheckSummary(checks('ping', 'ping', 'ping')), 'PING');
  assert.equal(FormatMonitoringCheckSummary(checks('ping', 'dns')), 'PING & DNS');
  assert.equal(FormatMonitoringCheckSummary(checks('ping', 'dns', 'http')), 'PING, DNS & HTTP');
});

test('an unknown method is humanised rather than dropped', () => {
  // A method added server-side that the renderer has no label for must still
  // appear — silently omitting it would understate what a target checks.
  assert.equal(FormatMonitoringCheckSummary(checks('snmp-ups-v3')), 'SNMP UPS V3');
  assert.equal(FormatMonitoringCheckSummary(checks('artnet_universe')), 'ARTNET UNIVERSE');
});

test('the summary truncates with a count instead of overflowing the tile', () => {
  const Summary = FormatMonitoringCheckSummary(checks('ping', 'dns', 'http', 'tcp-port', 'qlab'));
  assert.match(Summary, /\+ \d+ More$/);
  assert.ok(Summary.length <= 24 + 10, `summary too long: ${Summary}`);
});

test('at least one label always survives truncation', () => {
  // Even at an absurd budget the operator gets something rather than a bare
  // "+ 5 More".
  const Summary = FormatMonitoringCheckSummary(checks('ping', 'dns', 'http'), 1);
  assert.match(Summary, /^PING/);
});

test('a target with no usable checks summarises as empty', () => {
  for (const Target of [{ Checks: [] }, { Checks: [{ Method: '' }] }, { Checks: null }, {}, null]) {
    assert.equal(FormatMonitoringCheckSummary(Target), '', `target ${JSON.stringify(Target)}`);
  }
});

// --- Address and method labels ---------------------------------------------

test('an http address is reduced to its hostname', () => {
  assert.equal(
    FormatMonitoringAddressSub({ Address: 'https://qlab.local:8080/status' }),
    'qlab.local'
  );
  assert.equal(FormatMonitoringAddressSub({ Address: 'HTTP://10.0.0.5/health' }), '10.0.0.5');
});

test('an unparseable http address falls back to showing it whole', () => {
  // Better a long address than an empty field where one used to be.
  const Broken = 'http://[not a url';
  assert.equal(FormatMonitoringAddressSub({ Address: Broken }), Broken);
});

test('a non-http address is shown as-is', () => {
  assert.equal(FormatMonitoringAddressSub({ Address: '10.0.0.5' }), '10.0.0.5');
  assert.equal(FormatMonitoringAddressSub({}), '');
});

test('a multi-check target shows its check summary rather than one address', () => {
  const Target = { CheckCount: 3, Address: '10.0.0.5', ...checks('ping', 'dns') };
  assert.equal(FormatMonitoringAddressSub(Target), 'PING & DNS');

  // ...and falls back to a count when the checks cannot be summarised.
  assert.equal(FormatMonitoringAddressSub({ CheckCount: 3, Checks: [] }), '3 Checks');
});

test('the method label reflects how many checks a target has', () => {
  assert.equal(FormatMonitoringMethodLabel({ CheckCount: 0 }), 'NO CHECKS');
  assert.equal(FormatMonitoringMethodLabel({ CheckCount: 4 }), '4 CHECKS');
  assert.equal(FormatMonitoringMethodLabel({ CheckCount: 1, Method: 'ping' }), 'PING');
  assert.equal(FormatMonitoringMethodLabel({ Method: 'ping' }), 'PING');
  assert.equal(FormatMonitoringMethodLabel({}), '');
});

test('a target with zero checks says so rather than looking healthy', () => {
  // A target nobody configured a check for reports neither online nor offline;
  // "NO CHECKS" is the only honest label.
  assert.equal(FormatMonitoringMethodLabel({ CheckCount: 0, Method: 'ping' }), 'NO CHECKS');
});

// --- Status classification --------------------------------------------------

test('an online target shows its latency', () => {
  assert.equal(FormatMonitorStatus(true, 12, null, false), '12ms');
});

test('a degraded target shows the reason, falling back to latency', () => {
  assert.equal(FormatMonitorStatus(true, 12, 'Battery low', true), 'Battery low');
  assert.equal(FormatMonitorStatus(true, 12, '   ', true), '12ms');
  assert.equal(FormatMonitorStatus(true, 12, null, true), '12ms');
});

test('transport failures are all reported as plain Offline', () => {
  // The operator does not need the errno; they need to know it is unreachable.
  for (const Error of [
    'connect ECONNREFUSED 10.0.0.5:80',
    'read ECONNRESET',
    'connect EHOSTUNREACH',
    'connect ENETUNREACH',
    'Request timed out',
    'timeout of 5000ms exceeded',
    'socket hang up',
    'no route to host',
    'network is unreachable',
  ]) {
    assert.equal(FormatMonitorStatus(false, null, Error, false), 'Offline', `error: ${Error}`);
  }
});

test('name-resolution and certificate failures get their own labels', () => {
  // These are configuration faults, not the device being down — telling them
  // apart is what stops an operator power-cycling a healthy machine.
  for (const Error of ['getaddrinfo ENOTFOUND qlab.local', 'EAI_AGAIN', 'NXDOMAIN returned']) {
    assert.equal(FormatMonitorStatus(false, null, Error, false), 'DNS Error', `error: ${Error}`);
  }
  for (const Error of [
    'unable to verify the first certificate',
    'self signed certificate in chain',
    'TLS handshake failed',
    'Hostname/IP does not match certificate',
  ]) {
    assert.equal(FormatMonitorStatus(false, null, Error, false), 'TLS Error', `error: ${Error}`);
  }
});

test('an HTTP status code is surfaced exactly', () => {
  // 401 and 503 mean very different things and both mean the host is up.
  assert.equal(
    FormatMonitorStatus(false, null, 'Unexpected HTTP 503 from server', false),
    'HTTP 503'
  );
  assert.equal(FormatMonitorStatus(false, null, 'http 401 unauthorized', false), 'HTTP 401');
});

test('an unrecognised error is passed through rather than hidden', () => {
  assert.equal(
    FormatMonitorStatus(false, null, 'QLab returned no workspaces', false),
    'QLab returned no workspaces'
  );
  assert.equal(FormatMonitorStatus(false, null, '', false), 'Offline');
  assert.equal(FormatMonitorStatus(false, null, null, false), 'Offline');
});

test('classification order puts transport failures ahead of the HTTP match', () => {
  // A timeout while talking to an HTTP endpoint is a timeout, not an HTTP code.
  assert.equal(
    FormatMonitorStatus(false, null, 'timeout contacting HTTP 200 endpoint', false),
    'Offline'
  );
});

// --- Compact status ---------------------------------------------------------

test('the compact label prefers latency, then falls back to a stable word', () => {
  assert.deepEqual(FormatMonitorCompactStatus(true, 15, false, false), {
    text: '15ms',
    color: 'text-light',
  });
  assert.deepEqual(FormatMonitorCompactStatus(true, null, false, false), {
    text: 'Online',
    color: 'text-light',
  });
  assert.deepEqual(FormatMonitorCompactStatus(false, null, false, false), {
    text: 'Offline',
    color: 'text-light',
  });
});

test('a degraded target with no latency is the only compact state that is coloured', () => {
  const Degraded = FormatMonitorCompactStatus(true, null, true, false);
  assert.deepEqual(Degraded, { text: 'Degraded', color: 'text-warning' });
});

test('idle outranks degraded, because an idle target has not been measured', () => {
  // Reporting "Degraded" for a target that never ran a check would be asserting
  // a state nobody observed.
  assert.equal(FormatMonitorCompactStatus(true, null, true, true).text, 'Idle');
  assert.equal(FormatMonitorCompactStatus(false, null, false, true).text, 'Idle');
});

// --- Awaiting the first check ----------------------------------------------

test('a target with checks that has never run one is awaiting its first check', () => {
  assert.equal(IsMonitorAwaitingFirstCheck({ CheckCount: 2, LastChecked: null }), true);
  // Once a check has landed the target has a real verdict, however bad.
  assert.equal(IsMonitorAwaitingFirstCheck({ CheckCount: 2, LastChecked: 1700000000000 }), false);
  // No checks configured is idle, which is a different thing entirely: there is
  // nothing to wait for.
  assert.equal(IsMonitorAwaitingFirstCheck({ CheckCount: 0, LastChecked: null }), false);
  assert.equal(IsMonitorAwaitingFirstCheck(null), false);
});

test('a target awaiting its first check reads as Checking, not Offline', () => {
  // Runtime monitor state is RAM-only and starts at Online: false, so for the
  // first check cycle after the server starts every target on the page would
  // otherwise paint red — an outage the operator can see is not real, which is
  // the fastest way to teach them to ignore a red tile.
  assert.deepEqual(FormatMonitorCompactStatus(false, null, false, false, true), {
    text: 'Checking',
    color: 'text-light',
  });
});

test('awaiting a first check never reads as Online either', () => {
  // The opposite failure matters just as much: a device that is genuinely dead
  // when the server comes up must not be papered over with a green tile while
  // its first probe is outstanding.
  const Pending = FormatMonitorCompactStatus(false, null, false, false, true);
  assert.notEqual(Pending.text, 'Online');
  // A latency reading means a probe answered, so it outranks the pending label.
  assert.deepEqual(FormatMonitorCompactStatus(true, 12, false, false, true), {
    text: '12ms',
    color: 'text-light',
  });
});

// --- Offline-since ----------------------------------------------------------

test('offline-since counts from the last confirmed success', () => {
  // The trap this guards: LastChecked updates on every cycle INCLUDING failures,
  // so using it would restart the "offline for 20 minutes" counter every tick
  // and an outage would never appear to age.
  assert.equal(GetMonitoringOfflineSince({ LastSuccessAt: 1700000000123 }), '1700000000123');
  assert.equal(GetMonitoringOfflineSince({ LastSuccessAt: 1700000000123.7 }), '1700000000124');
});

test('a target that has never succeeded reports no offline-since at all', () => {
  // Rendering epoch 0 would claim the target has been down since 1970.
  for (const Target of [
    { LastSuccessAt: 0 },
    { LastSuccessAt: null },
    { LastSuccessAt: 'x' },
    {},
    null,
  ]) {
    assert.equal(GetMonitoringOfflineSince(Target), '', `target ${JSON.stringify(Target)}`);
  }
});

test('offline-since ignores LastChecked entirely', () => {
  assert.equal(
    GetMonitoringOfflineSince({ LastChecked: 1700000000000, Timestamp: 1700000000000 }),
    ''
  );
});

// --- State labels and severity ---------------------------------------------

test('every state has a label and anything unknown reads as Idle', () => {
  assert.equal(MonitorStateLabel('ONLINE'), 'Online');
  assert.equal(MonitorStateLabel('DEGRADED'), 'Degraded');
  assert.equal(MonitorStateLabel('OFFLINE'), 'Offline');
  assert.equal(MonitorStateLabel('UNAVAILABLE'), 'Unavailable');
  for (const State of ['IDLE', '', 'nonsense', null, undefined]) {
    assert.equal(MonitorStateLabel(State), 'Idle', `state ${JSON.stringify(State)}`);
  }
});

test('severity orders the states so the worst one wins a block', () => {
  assert.ok(MONITOR_STATE_SEVERITY.OFFLINE > MONITOR_STATE_SEVERITY.DEGRADED);
  assert.ok(MONITOR_STATE_SEVERITY.DEGRADED > MONITOR_STATE_SEVERITY.ONLINE);
  // Idle and unavailable sort below every real state so they can never displace
  // an observation.
  assert.ok(MONITOR_STATE_SEVERITY.IDLE < MONITOR_STATE_SEVERITY.ONLINE);
  assert.ok(MONITOR_STATE_SEVERITY.UNAVAILABLE < MONITOR_STATE_SEVERITY.ONLINE);
});

test('a sample is classified offline first, then degraded', () => {
  assert.equal(DeriveSampleState({ online: false, degraded: true }), 'OFFLINE');
  assert.equal(DeriveSampleState({ online: true, degraded: true }), 'DEGRADED');
  assert.equal(DeriveSampleState({ online: true, degraded: false }), 'ONLINE');
  assert.equal(DeriveSampleState(null), null);
  assert.equal(DeriveSampleState(undefined), null);
});

// --- Timeline blocks --------------------------------------------------------

/** A sample placed a given number of minutes before now. */
const sample = (minutesAgo, extra = {}) => ({
  ts: Date.now() - minutesAgo * 60 * 1000,
  online: true,
  degraded: false,
  ...extra,
});

test('the timeline is always a fixed grid, however many samples arrived', () => {
  // A fixed grid is what makes two targets visually comparable.
  for (const Samples of [[], [sample(5)], Array.from({ length: 500 }, (_, i) => sample(i / 10))]) {
    const Blocks = BuildStatusBlocksFromSamples(Samples);
    assert.equal(Blocks.length, BLOCK_COUNT);
  }
});

test('a block with no samples stays IDLE rather than inheriting a neighbour', () => {
  // The property that keeps the timeline honest: a gap means "we have no data",
  // not "it was fine". Filling gaps would hide the outage that caused them.
  const Blocks = BuildStatusBlocksFromSamples([sample(5)]);
  const Empty = Blocks.filter((B) => B.count === 0);
  assert.ok(Empty.length > 50, 'expected most of the window to be empty');
  for (const Block of Empty) {
    assert.equal(Block.state, 'IDLE');
    assert.equal(Block.latencyMs, null);
  }
});

test('the worst state in a block wins', () => {
  // One failed check inside a minute must colour that minute, or a flapping
  // target looks perfectly healthy at a glance.
  const Blocks = BuildStatusBlocksFromSamples([
    sample(5, { online: true }),
    sample(5, { online: true, degraded: true }),
    sample(5, { online: false }),
  ]);
  const Block = Blocks.find((B) => B.count === 3);
  assert.ok(Block, 'the samples did not land in one block');
  assert.equal(Block.state, 'OFFLINE');
  assert.deepEqual(Block.counts, { ONLINE: 1, DEGRADED: 1, OFFLINE: 1 });
});

test('a block averages the latency of its samples', () => {
  const Blocks = BuildStatusBlocksFromSamples([
    sample(5, { latencyMs: 10 }),
    sample(5, { latencyMs: 20 }),
    sample(5, { latencyMs: null }),
  ]);
  const Block = Blocks.find((B) => B.count === 3);
  assert.equal(Block.latencyMs, 15, 'the null sample should not drag the mean to 10');
});

test('samples outside the window are ignored', () => {
  const Blocks = BuildStatusBlocksFromSamples([
    { ts: Date.now() - WINDOW_MS * 2, online: false },
    { ts: Date.now() + 60_000, online: false },
  ]);
  assert.equal(
    Blocks.reduce((A, B) => A + B.count, 0),
    0
  );
});

test('unusable samples are discarded without breaking the grid', () => {
  const Blocks = BuildStatusBlocksFromSamples([
    null,
    undefined,
    { ts: 'not a time', online: true },
    { online: true },
    sample(5),
  ]);
  assert.equal(Blocks.length, BLOCK_COUNT);
  assert.equal(
    Blocks.reduce((A, B) => A + B.count, 0),
    1
  );
});

test('the blocks tile the window contiguously', () => {
  const Blocks = BuildStatusBlocksFromSamples([]);
  for (let i = 1; i < Blocks.length; i++) {
    assert.equal(Blocks[i].start, Blocks[i - 1].end, `gap before block ${i}`);
    assert.equal(Blocks[i].end - Blocks[i].start, BLOCK_MS);
  }
});

test('a non-array sample set is treated as empty', () => {
  for (const Value of [null, undefined, 'nope', {}]) {
    assert.equal(BuildStatusBlocksFromSamples(Value).length, BLOCK_COUNT);
  }
});

// --- Overall timeline -------------------------------------------------------

const blocksWith = (states) =>
  states.map((State) => ({
    start: 0,
    end: 0,
    state: State,
    count: State === 'IDLE' ? 0 : 1,
    counts: {
      ONLINE: State === 'ONLINE' ? 1 : 0,
      DEGRADED: State === 'DEGRADED' ? 1 : 0,
      OFFLINE: State === 'OFFLINE' ? 1 : 0,
    },
    latencyMs: null,
  }));

/** Build N per-check timelines whose first block carries the given state. */
function overallFirstBlock(FirstStates) {
  const PerCheck = FirstStates.map((State) => {
    const Row = blocksWith(Array.from({ length: BLOCK_COUNT }, () => 'IDLE'));
    Row[0] = blocksWith([State])[0];
    return Row;
  });
  return BuildOverallStatusBlocks(PerCheck)[0];
}

test('a target is only OFFLINE when every reporting check is offline', () => {
  // This mirrors the server aggregation. Getting it wrong in the other
  // direction — offline as soon as any check fails — would make a target with
  // one flaky check look dead while it is still serving.
  assert.equal(overallFirstBlock(['OFFLINE', 'OFFLINE']).state, 'OFFLINE');
  assert.equal(overallFirstBlock(['OFFLINE', 'ONLINE']).state, 'DEGRADED');
  assert.equal(overallFirstBlock(['DEGRADED', 'ONLINE']).state, 'DEGRADED');
  assert.equal(overallFirstBlock(['ONLINE', 'ONLINE']).state, 'ONLINE');
});

test('checks that reported nothing do not count toward the verdict', () => {
  // An IDLE check must not turn "every check is offline" into "not every check
  // is offline" and downgrade a genuine outage to Degraded.
  assert.equal(overallFirstBlock(['OFFLINE', 'IDLE']).state, 'OFFLINE');
  assert.equal(overallFirstBlock(['OFFLINE', 'UNAVAILABLE']).state, 'OFFLINE');
  assert.equal(overallFirstBlock(['IDLE', 'IDLE']).state, 'IDLE');
});

test('the overall block sums the per-check sample counts', () => {
  const Block = overallFirstBlock(['ONLINE', 'DEGRADED', 'OFFLINE']);
  assert.deepEqual(Block.counts, { ONLINE: 1, DEGRADED: 1, OFFLINE: 1 });
});

test('the overall timeline keeps the same fixed grid', () => {
  for (const PerCheck of [[], [[]], null, undefined]) {
    const Blocks = BuildOverallStatusBlocks(PerCheck || []);
    assert.equal(Blocks.length, BLOCK_COUNT);
    assert.ok(Blocks.every((B) => B.state === 'IDLE'));
  }
});

// --- Live status ------------------------------------------------------------

test('a check that has never run is Idle, not Offline', () => {
  // Before the first cycle there is nothing to report, and showing Offline would
  // raise an alarm for a check that was only just configured.
  assert.equal(LiveCheckState({ LastChecked: null, Online: false }), 'IDLE');
  assert.equal(LiveCheckState({ Online: true }), 'IDLE');
  assert.equal(LiveCheckState(null), 'IDLE');
});

test('a check that has run is classified offline before degraded', () => {
  assert.equal(LiveCheckState({ LastChecked: 1, Online: false, Degraded: true }), 'OFFLINE');
  assert.equal(LiveCheckState({ LastChecked: 1, Online: true, Degraded: true }), 'DEGRADED');
  assert.equal(LiveCheckState({ LastChecked: 1, Online: true }), 'ONLINE');
});

test('the live status line explains each state in the operator’s language', () => {
  assert.equal(BuildLiveStatusText('IDLE', null, null), 'Idle');
  assert.equal(BuildLiveStatusText('UNAVAILABLE', null, null), 'No checks configured');
  assert.equal(BuildLiveStatusText('ONLINE', 12, null), 'Online · 12ms');
  assert.equal(BuildLiveStatusText('ONLINE', null, null), 'Online');
  assert.equal(BuildLiveStatusText('DEGRADED', 12, 'Battery low'), 'Degraded · Battery low');
  assert.equal(BuildLiveStatusText('DEGRADED', 12, '  '), 'Degraded');
});

test('the offline live status reuses the error classifier', () => {
  assert.equal(BuildLiveStatusText('OFFLINE', null, 'connect ECONNREFUSED'), 'Offline');
  assert.equal(BuildLiveStatusText('OFFLINE', null, 'getaddrinfo ENOTFOUND x'), 'DNS Error');
  assert.equal(BuildLiveStatusText('OFFLINE', null, null), 'Offline');
});
