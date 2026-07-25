const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Exercises src/UI/js/app/16-dummy-clients.ts and 10-alerts-tray.ts.
//
// Dummy clients are stand-ins for gear that cannot run the ShowTrak client but
// still heartbeats (media servers, bespoke show control). Their status text is
// the only indication an operator gets that one has stopped reporting.
//
// The alerts tray is where a degraded client, a missing USB device or an
// offline machine surfaces. The properties that matter are that an alert is
// counted exactly once, that dismissing removes it from the count without
// destroying the record, and that time is rendered in units an operator can act
// on.
//
// The alerts tray needs a DOM, so it gets a ~20-line micro-stub rather than
// jsdom — this is the third strategy from WP-1, used where a module touches the
// DOM narrowly. Everything else here is pure.

const APP = path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app');

// --- DOM micro-stub ---------------------------------------------------------
// Enough surface for the tray's indicator/render/toast paths. Installed before
// requiring the module, since the toast helper reads CSS at call time.
function fakeElement() {
  const El = {
    style: {},
    className: '',
    innerHTML: '',
    textContent: '',
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {},
    removeChild() {},
    remove() {},
    setAttribute() {},
    getAttribute: () => null,
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => fakeElement(),
    querySelectorAll: () => [],
    closest: () => null,
    focus() {},
    insertAdjacentHTML() {},
  };
  return El;
}
global.document = {
  getElementById: () => fakeElement(),
  querySelector: () => fakeElement(),
  querySelectorAll: () => [],
  createElement: fakeElement,
  body: fakeElement(),
};
global.CSS = { escape: (V) => String(V) };

const Dummy = require(path.join(APP, '16-dummy-clients.js'));
const Tray = require(path.join(APP, '10-alerts-tray.js'));

const { DummyCompactStatus, DummyDisplayIP, RenderDummyClientTile } = Dummy;
const { AddAlert, DismissAlert, DismissAllAlerts, UndismissedCount, iconForAlert, timeAgo } = Tray;

// ===========================================================================
// Dummy client status
// ===========================================================================

test('a reporting dummy shows Online', () => {
  assert.deepEqual(DummyCompactStatus({ Online: true, State: 'ONLINE' }), {
    text: 'Online',
    color: 'text-light',
    offline: false,
  });
});

test('a dummy that has never reported shows Idle, not Offline', () => {
  // IDLE is the state before the first heartbeat. Showing Offline would raise
  // an alarm for a device that was only just configured.
  assert.deepEqual(DummyCompactStatus({ State: 'IDLE' }), {
    text: 'Idle',
    color: 'text-light',
    offline: false,
  });
  assert.deepEqual(DummyCompactStatus({}), { text: 'Idle', color: 'text-light', offline: false });
});

test('an offline dummy defers to the offline-since counter', () => {
  // Empty text with offline:true is what lets the tile render a live "offline
  // for 4m" timer in place of a static word.
  assert.deepEqual(DummyCompactStatus({ State: 'OFFLINE', Online: true }), {
    text: '',
    color: 'text-light',
    offline: true,
  });
});

test('a degraded dummy shows its first warning, in warning colour', () => {
  const Result = DummyCompactStatus({
    Online: true,
    Degraded: true,
    DegradedWarnings: ['No heartbeat for 90s', 'Second issue'],
  });
  assert.deepEqual(Result, {
    text: 'No heartbeat for 90s',
    color: 'text-warning',
    offline: false,
  });
});

test('a degraded dummy with no warning still explains itself', () => {
  for (const Warnings of [[], null, undefined]) {
    const Result = DummyCompactStatus({ Online: true, Degraded: true, DegradedWarnings: Warnings });
    assert.equal(Result.text, 'Missed Heartbeat');
    assert.equal(Result.color, 'text-warning');
  }
});

test('the OFFLINE state outranks degraded', () => {
  // Once it has stopped reporting entirely, why it was degraded is moot.
  const Result = DummyCompactStatus({ State: 'OFFLINE', Online: true, Degraded: true });
  assert.equal(Result.offline, true);
  assert.equal(Result.text, '');
});

// --- Heartbeat source IP ----------------------------------------------------

test('loopback addresses all render as localhost', () => {
  // A dummy heartbeating from the server itself is a normal, supported setup;
  // showing ::ffff:127.0.0.1 makes it look like a misconfiguration.
  for (const IP of [
    '127.0.0.1',
    '::1',
    '0:0:0:0:0:0:0:1',
    'localhost',
    'LOCALHOST',
    '::ffff:127.0.0.1',
    '[::1]',
  ]) {
    assert.equal(DummyDisplayIP(IP), 'localhost', `IP ${IP}`);
  }
});

test('an IPv4-mapped IPv6 address is shown as plain IPv4', () => {
  // Node reports v4 peers this way on a dual-stack socket; the operator matches
  // what they see here against the address on the device.
  assert.equal(DummyDisplayIP('::ffff:10.0.0.5'), '10.0.0.5');
});

test('a BRACKETED IPv4-mapped address keeps its prefix — documented, not endorsed', () => {
  // Asymmetry in the normalisation order: the `::ffff:` prefix is stripped
  // before the brackets, so a bracketed one never matches the prefix test. The
  // plain and bracketed loopback forms both still resolve correctly, which is
  // why this has never been visible.
  //
  // Left alone because it is not reachable: this value comes from a socket's
  // remoteAddress, which is never bracketed — bracket syntax belongs to
  // `[host]:port` URLs, which is not what feeds this.
  assert.equal(DummyDisplayIP('[::ffff:10.0.0.5]'), '::ffff:10.0.0.5');
  assert.equal(DummyDisplayIP('[::1]'), 'localhost', 'loopback is unaffected either way');
});

test('a bracketed IPv6 address is unwrapped but kept', () => {
  assert.equal(DummyDisplayIP('[fe80::1]'), 'fe80::1');
  assert.equal(DummyDisplayIP('fe80::1'), 'fe80::1');
});

test('an ordinary address passes through unchanged', () => {
  assert.equal(DummyDisplayIP('10.0.0.5'), '10.0.0.5');
  assert.equal(DummyDisplayIP('  10.0.0.5  '), '10.0.0.5');
});

test('an absent address says so rather than rendering blank', () => {
  for (const IP of ['', '   ', null, undefined, 42, {}]) {
    assert.equal(DummyDisplayIP(IP), 'Unknown IP', `IP ${JSON.stringify(IP)}`);
  }
});

// --- Tile ------------------------------------------------------------------

test('the dummy tile carries the scoped id the selection layer expects', () => {
  // Must match BuildGroupSelectableIDs' `dummy:<UUID>`, or a group-title click
  // selects the tile visually while acting on nothing.
  const Html = RenderDummyClientTile({ UUID: 'd1', Nickname: 'Media Server', State: 'IDLE' });
  assert.match(Html, /data-uuid="dummy:d1"/);
  assert.match(Html, /Media Server/);
});

test('the dummy tile escapes operator-entered text', () => {
  const Html = RenderDummyClientTile({
    UUID: 'd1',
    Nickname: '<img src=x onerror=alert(1)>',
    State: 'IDLE',
  });
  assert.doesNotMatch(Html, /<img/);
  assert.match(Html, /&lt;img/);
});

// ===========================================================================
// Alerts tray
// ===========================================================================

test.beforeEach(() => DismissAllAlerts());

test('an added alert is counted once and returns a usable id', () => {
  const Id = AddAlert({ title: 'USB device removed', type: 'usb' });
  assert.equal(typeof Id, 'string');
  assert.ok(Id.length > 0);
  assert.equal(UndismissedCount(), 1);
});

test('alert ids are unique even when raised in the same millisecond', () => {
  // Client offline events arrive in bursts; colliding ids would make dismissing
  // one dismiss another.
  const Ids = new Set();
  for (let i = 0; i < 200; i++) Ids.add(AddAlert({ title: `alert ${i}` }));
  assert.equal(Ids.size, 200);
  assert.equal(UndismissedCount(), 200);
});

test('dismissing removes an alert from the count', () => {
  const First = AddAlert({ title: 'one' });
  AddAlert({ title: 'two' });
  assert.equal(UndismissedCount(), 2);

  DismissAlert(First);
  assert.equal(UndismissedCount(), 1);
});

test('dismissing an unknown id is a no-op, not a crash', () => {
  AddAlert({ title: 'one' });
  assert.doesNotThrow(() => DismissAlert('no-such-id'));
  assert.doesNotThrow(() => DismissAlert(undefined));
  assert.equal(UndismissedCount(), 1);
});

test('dismissing twice does not drive the count negative', () => {
  const Id = AddAlert({ title: 'one' });
  DismissAlert(Id);
  DismissAlert(Id);
  assert.equal(UndismissedCount(), 0);
});

test('dismiss-all clears everything and stays safe when empty', () => {
  AddAlert({ title: 'one' });
  AddAlert({ title: 'two' });
  DismissAllAlerts();
  assert.equal(UndismissedCount(), 0);
  assert.doesNotThrow(() => DismissAllAlerts());
});

test('a dismissed alert can still be re-raised as a new one', () => {
  // The same client going offline twice must alert twice, not be suppressed by
  // the earlier dismissal.
  const First = AddAlert({ title: 'Client offline', clientUUID: 'c1' });
  DismissAlert(First);
  const Second = AddAlert({ title: 'Client offline', clientUUID: 'c1' });

  assert.notEqual(First, Second);
  assert.equal(UndismissedCount(), 1);
});

// --- Icons and time ---------------------------------------------------------

test('each alert type has its own icon, with a generic fallback', () => {
  assert.match(iconForAlert({ type: 'usb' }), /bi-usb-symbol/);
  assert.match(iconForAlert({ type: 'online' }), /bi-wifi"/);
  assert.match(iconForAlert({ type: 'offline' }), /bi-wifi-off/);
  assert.match(iconForAlert({ type: 'anything-else' }), /bi-exclamation-circle-fill/);
  assert.match(iconForAlert({}), /bi-exclamation-circle-fill/);
});

test('a caller-supplied icon wins over the type default', () => {
  // Alert rules can carry their own icon so a custom rule is recognisable.
  assert.equal(
    iconForAlert({ type: 'usb', iconHtml: '<i class="custom"></i>' }),
    '<i class="custom"></i>'
  );
});

test('elapsed time is rendered in the largest useful unit', () => {
  const Now = Date.now();
  assert.equal(timeAgo(Now), '0s ago');
  assert.equal(timeAgo(Now - 45_000), '45s ago');
  assert.equal(timeAgo(Now - 5 * 60_000), '5m ago');
  assert.equal(timeAgo(Now - 3 * 3600_000), '3h ago');
  assert.equal(timeAgo(Now - 2 * 86400_000), '2d ago');
});

test('the unit boundaries do not skip or double up', () => {
  const Now = Date.now();
  assert.equal(timeAgo(Now - 59_000), '59s ago');
  assert.equal(timeAgo(Now - 60_000), '1m ago');
  assert.equal(timeAgo(Now - 59 * 60_000), '59m ago');
  assert.equal(timeAgo(Now - 60 * 60_000), '1h ago');
  assert.equal(timeAgo(Now - 23 * 3600_000), '23h ago');
  assert.equal(timeAgo(Now - 24 * 3600_000), '1d ago');
});
