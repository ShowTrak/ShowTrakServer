const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

// Build a fake `net` module whose Socket emits scripted WATCHOUT replies.
//   scenario.reply   -> string written back after the command is sent (CRLF lines)
//   scenario.refuse  -> emit an ECONNREFUSED error instead of connecting
//   scenario.silent  -> connect but never reply (drives the timeout path)
function makeNetMock(scenario) {
  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      this._timeout = 0;
    }
    setTimeout(ms) {
      this._timeout = ms;
      // Mirror a real net.Socket: arm an idle timer that emits 'timeout'. This is
      // what lets scenarios that never produce a getStatus Reply (e.g. ping-only)
      // settle via the module's timeout fallback instead of hanging forever.
      // Not unref'd: the pending Run() promise needs this timer to keep the loop
      // alive until it fires; the module clears it via destroy() on settle.
      this._timer = globalThis.setTimeout(() => this.emit('timeout'), ms);
    }
    connect() {
      setImmediate(() => {
        if (scenario.refuse) {
          const err = new Error('connect ECONNREFUSED 127.0.0.1:3040');
          this.emit('error', err);
          return;
        }
        this.emit('connect');
      });
      return this;
    }
    write() {
      if (scenario.silent || scenario.refuse) return true;
      setImmediate(() => {
        this.emit('data', Buffer.from(scenario.reply, 'utf8'));
      });
      return true;
    }
    destroy() {
      if (this._timer) {
        globalThis.clearTimeout(this._timer);
        this._timer = null;
      }
      this.emit('close');
    }
  }
  // Drive the timeout path for silent servers: fire 'timeout' shortly after connect.
  if (scenario.silent) {
    const origConnect = FakeSocket.prototype.connect;
    FakeSocket.prototype.connect = function connect(...args) {
      const r = origConnect.apply(this, args);
      setImmediate(() => this.emit('timeout'));
      return r;
    };
  }
  return { Socket: FakeSocket };
}

function loadWatchout(scenario) {
  return loadWithMocks(methodPath('watchout-status.js'), { net: makeNetMock(scenario) });
}

// Representative getStatus Reply strings (field layout confirmed from the
// TroikaTronix community thread #8637 and Dataton's protocol docs):
//   Reply "<Filename>" Busy Health FullScreen ShowActive Online CurrentTime Playing Rate Standby [trailing]
const REPLY_READY_RUNNING =
  'Ready "6.6.2" 0\r\nReply "Gala Show" false 0 true true true 86398999 true 1 false 21921314\r\n';
const REPLY_WRONG_SHOW =
  'Reply "Some Other Show" false 0 true true true 12345 false 0 false 999\r\n';
const REPLY_NOT_READY = 'Reply "Gala Show" false 0 false false false 0 false 0 true 0\r\n';
const REPLY_NO_SHOW = 'Reply "" false 0 false false false 0 false 0 false 0\r\n';
const PING_ONLY = 'Ready "6.6.2" 0 true\r\n';

test('watchout method exposes the expected shape', () => {
  const wo = loadWatchout({ reply: REPLY_READY_RUNNING });
  assert.equal(wo.ID, 'watchout-status');
  assert.equal(wo.Name, 'Dataton WATCHOUT');
  assert.ok(Array.isArray(wo.Settings));
  const keys = wo.Settings.map((s) => s.Key);
  assert.deepEqual(keys, ['Port', 'Mode', 'ExpectedShow', 'Timeout']);
});

test('watchout method is Online when the show matches and is ready/running', async () => {
  const wo = loadWatchout({ reply: REPLY_READY_RUNNING });
  const result = await wo.Run({
    Address: '127.0.0.1',
    Settings: { Port: 3040, Mode: 'display', ExpectedShow: 'Gala Show', Timeout: 2000 },
  });
  assert.equal(result.Success, true);
  assert.ok(!result.Degraded);
  assert.equal(result.ShowName, 'Gala Show');
  assert.equal(result.Ready, true);
  assert.equal(result.Running, true);
  assert.equal(typeof result.LatencyMs, 'number');
});

test('watchout method is Online with no expected show when ready', async () => {
  const wo = loadWatchout({ reply: REPLY_READY_RUNNING });
  const result = await wo.Run({
    Address: '127.0.0.1',
    Settings: { Port: 3040, Timeout: 2000 },
  });
  assert.equal(result.Success, true);
  assert.ok(!result.Degraded);
});

test('watchout method is Degraded (Wrong show) when the loaded show differs', async () => {
  const wo = loadWatchout({ reply: REPLY_WRONG_SHOW });
  const result = await wo.Run({
    Address: '127.0.0.1',
    Settings: { Port: 3040, ExpectedShow: 'Gala Show', Timeout: 2000 },
  });
  assert.equal(result.Success, true);
  assert.equal(result.Degraded, true);
  assert.equal(result.DegradedReason, 'Wrong show');
});

test('watchout method is Degraded (Not ready) when the show is not active/online', async () => {
  const wo = loadWatchout({ reply: REPLY_NOT_READY });
  const result = await wo.Run({
    Address: '127.0.0.1',
    Settings: { Port: 3040, ExpectedShow: 'Gala Show', Timeout: 2000 },
  });
  assert.equal(result.Success, true);
  assert.equal(result.Degraded, true);
  assert.equal(result.DegradedReason, 'Not ready');
});

test('watchout method is Degraded (No show loaded) when no show is open', async () => {
  const wo = loadWatchout({ reply: REPLY_NO_SHOW });
  const result = await wo.Run({
    Address: '127.0.0.1',
    Settings: { Port: 3040, Timeout: 2000 },
  });
  assert.equal(result.Success, true);
  assert.equal(result.Degraded, true);
  assert.equal(result.DegradedReason, 'No show loaded');
});

test('watchout method is Degraded (Status unavailable) when only ping answers', async () => {
  const wo = loadWatchout({ reply: PING_ONLY });
  const result = await wo.Run({
    Address: '127.0.0.1',
    Settings: { Port: 3040, Timeout: 500 },
  });
  assert.equal(result.Success, true);
  assert.equal(result.Degraded, true);
  assert.equal(result.DegradedReason, 'Status unavailable');
});

test('watchout method is Offline when the connection is refused', async () => {
  const wo = loadWatchout({ refuse: true });
  const result = await wo.Run({
    Address: '127.0.0.1',
    Settings: { Port: 3040, Timeout: 1000 },
  });
  assert.equal(result.Success, false);
  assert.match(result.Error, /No status reply/i);
});

test('watchout method is Offline when the target never replies', async () => {
  const wo = loadWatchout({ silent: true });
  const result = await wo.Run({
    Address: '127.0.0.1',
    Settings: { Port: 3040, Timeout: 600 },
  });
  assert.equal(result.Success, false);
  assert.match(result.Error, /No status reply/i);
});

test('watchout method validates address and port', async () => {
  const wo = loadWatchout({ reply: REPLY_READY_RUNNING });
  assert.equal((await wo.Run({})).Success, false);
  assert.equal((await wo.Run({ Address: '127.0.0.1', Settings: { Port: 70000 } })).Success, false);
});

test('watchout internal helpers parse replies and match shows', () => {
  const wo = loadWatchout({ reply: REPLY_READY_RUNNING });
  const { ParseWatchoutReply, ParseStatusLine, NormalizeShow, ShowMatches, IsReady } = wo._internal;

  const parsed = ParseWatchoutReply(REPLY_READY_RUNNING);
  assert.equal(parsed.Kind, 'reply');
  assert.equal(parsed.Status.ShowName, 'Gala Show');
  assert.equal(parsed.Status.ShowActive, true);
  assert.equal(parsed.Status.Online, true);
  assert.equal(parsed.Status.Playing, true);
  assert.equal(parsed.Status.CurrentTime, 86398999);

  // Prefers the getStatus Reply over the preceding Ready line.
  const preferReply = ParseWatchoutReply('Ready "6.6"\r\n' + REPLY_WRONG_SHOW);
  assert.equal(preferReply.Kind, 'reply');

  // Ping-only Ready falls back to a 'ready' kind.
  assert.equal(ParseWatchoutReply(PING_ONLY).Kind, 'ready');

  // Error line is surfaced.
  const err = ParseWatchoutReply('Error something bad\r\n');
  assert.equal(err.Kind, 'error');
  assert.match(err.ErrorText, /something bad/);

  // With Only='reply', a bare Ready yields null so the socket keeps waiting.
  assert.equal(ParseWatchoutReply(PING_ONLY, 'reply'), null);

  const status = ParseStatusLine(REPLY_NOT_READY.trim());
  assert.equal(status.ShowName, 'Gala Show');
  assert.equal(IsReady(status), false);

  assert.equal(NormalizeShow('C:\\Shows\\Gala.watch'), 'gala');
  assert.equal(ShowMatches('Gala Show', 'gala show'), true);
  assert.equal(ShowMatches('Gala Show', 'other'), false);
  assert.equal(ShowMatches('anything', ''), true); // no expectation configured
});
