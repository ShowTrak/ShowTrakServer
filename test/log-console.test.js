const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

// Exercises the hidden log console: the Logger's live feed and the hub in
// src/main/log-console.ts that streams it to open viewers. What matters most is
// that nothing is produced or sent for a viewer that is not open, and that a
// viewer's level is honoured server-side (it is the Web UI's bandwidth).

const FLUSH_WAIT_MS = 400;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function load(level = 'info') {
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-logs-'));
  const previous = { level: process.env.LOG_LEVEL, console: process.env.LOG_TO_CONSOLE };
  process.env.LOG_LEVEL = level;
  process.env.LOG_TO_CONSOLE = 'false';
  try {
    const Logger = loadWithMocks(path.join(__dirname, '..', 'dist', 'Modules', 'Logger', 'index'), {
      '../AppData': { Manager: { GetLogsDirectory: () => logsDir } },
    });
    const Hub = loadWithMocks(path.join(__dirname, '..', 'dist', 'main', 'log-console'), {
      '../Modules/Logger': Logger,
    });
    return { Logger, Hub, logsDir };
  } finally {
    process.env.LOG_LEVEL = previous.level;
    process.env.LOG_TO_CONSOLE = previous.console;
  }
}

test('with no console open, lines below the active level are not produced at all', () => {
  const { Logger } = load('info');
  const log = Logger.CreateLogger('Feed');
  const seen = [];
  Logger.SubscribeToLogFeed((Entry) => seen.push(Entry));

  log.debug('quiet');
  log.trace('quieter');
  log.info('loud');

  assert.deepEqual(
    seen.map((Entry) => Entry.Message),
    ['loud']
  );
  assert.equal(seen[0].Level, 'info');
  assert.equal(seen[0].Alias, 'Feed');
});

test('opening returns the backlog at the viewer level, and streams batches after it', async () => {
  const { Logger, Hub } = load('info');
  const log = Logger.CreateLogger('Feed');
  log.warn('old warning');
  log.info('old info');

  const batches = [];
  const Snapshot = Hub.OpenLogConsole('a', 'warn', (Entries) => batches.push(Entries));
  try {
    assert.equal(Snapshot.Level, 'warn');
    assert.deepEqual(
      Snapshot.Entries.map((Entry) => Entry.Message),
      ['old warning']
    );

    log.info('new info');
    log.error('new error');
    await wait(FLUSH_WAIT_MS);

    assert.equal(batches.length, 1, 'lines are batched, not sent one by one');
    assert.deepEqual(
      batches[0].map((Entry) => Entry.Message),
      ['new error']
    );
    assert.ok(batches[0][0].Seq > Snapshot.Entries[0].Seq, 'Seq keeps rising');
  } finally {
    Hub.CloseLogConsole('a');
  }
});

test('a trace viewer receives debug lines without them reaching the log file', async () => {
  const { Logger, Hub, logsDir } = load('info');
  const log = Logger.CreateLogger('Feed');
  const batches = [];
  Hub.OpenLogConsole('a', 'trace', (Entries) => batches.push(Entries));
  try {
    log.debug('debug only for the console');
    await wait(FLUSH_WAIT_MS);
    assert.deepEqual(
      batches.flat().map((Entry) => Entry.Message),
      ['debug only for the console']
    );
    const files = fs.readdirSync(logsDir).filter((f) => f.endsWith('.log'));
    const contents = files.map((f) => fs.readFileSync(path.join(logsDir, f), 'utf8')).join('');
    assert.doesNotMatch(contents, /debug only for the console/);
  } finally {
    Hub.CloseLogConsole('a');
  }
});

test('each viewer gets only its own level; closing stops delivery and verbose capture', async () => {
  const { Logger, Hub } = load('info');
  const log = Logger.CreateLogger('Feed');
  const quiet = [];
  const verbose = [];
  Hub.OpenLogConsole('quiet', 'error', (Entries) => quiet.push(...Entries));
  Hub.OpenLogConsole('verbose', 'debug', (Entries) => verbose.push(...Entries));

  log.debug('d');
  log.error('e');
  await wait(FLUSH_WAIT_MS);
  assert.deepEqual(
    quiet.map((Entry) => Entry.Message),
    ['e']
  );
  assert.deepEqual(
    verbose.map((Entry) => Entry.Message),
    ['d', 'e']
  );

  Hub.CloseLogConsole('quiet');
  Hub.CloseLogConsole('verbose');
  log.error('after close');
  await wait(FLUSH_WAIT_MS);
  assert.equal(quiet.length, 1);
  assert.equal(verbose.length, 2);

  // With everyone gone the feed level is cleared again: debug is not produced.
  const seen = [];
  const Unsubscribe = Logger.SubscribeToLogFeed((Entry) => seen.push(Entry.Message));
  log.debug('not produced');
  Unsubscribe();
  assert.deepEqual(seen, []);
});

test('re-opening with a new level replaces the filter for that viewer', async () => {
  const { Logger, Hub } = load('info');
  const log = Logger.CreateLogger('Feed');
  const got = [];
  Hub.OpenLogConsole('a', 'error', (Entries) => got.push(...Entries));
  try {
    const Snapshot = Hub.OpenLogConsole('a', 'info', (Entries) => got.push(...Entries));
    assert.equal(Snapshot.Level, 'info');
    log.info('now visible');
    await wait(FLUSH_WAIT_MS);
    assert.deepEqual(
      got.map((Entry) => Entry.Message),
      ['now visible']
    );
  } finally {
    Hub.CloseLogConsole('a');
  }
});

test('an unknown level falls back to info', () => {
  const { Hub } = load('info');
  try {
    assert.equal(Hub.OpenLogConsole('a', 'loud', () => undefined).Level, 'info');
  } finally {
    Hub.CloseLogConsole('a');
  }
});

test('a viewer whose send throws is dropped', async () => {
  const { Logger, Hub } = load('info');
  const log = Logger.CreateLogger('Feed');
  let calls = 0;
  Hub.OpenLogConsole('gone', 'info', () => {
    calls++;
    throw new Error('Sender destroyed');
  });
  log.info('one');
  await wait(FLUSH_WAIT_MS);
  log.info('two');
  await wait(FLUSH_WAIT_MS);
  assert.equal(calls, 1);
});

test('very long messages are truncated for the feed only', () => {
  const { Logger } = load('info');
  const log = Logger.CreateLogger('Feed');
  const seen = [];
  const Unsubscribe = Logger.SubscribeToLogFeed((Entry) => seen.push(Entry.Message));
  log.info('x'.repeat(25000));
  Unsubscribe();
  assert.ok(seen[0].length < 25000);
  assert.match(seen[0], /5000 more characters in the log file\)$/);
});

test('the in-memory backlog is capped by lines', () => {
  const { Logger } = load('info');
  const log = Logger.CreateLogger('Feed');
  for (let i = 0; i < 1500; i++) log.info(`line ${i}`);
  const Backlog = Logger.GetLogFeedBacklog();
  assert.equal(Backlog.length, 1000);
  assert.equal(Backlog[Backlog.length - 1].Message, 'line 1499');
});

test('the in-memory backlog is capped by characters, keeping the newest', () => {
  const { Logger } = load('info');
  const log = Logger.CreateLogger('Feed');
  for (let i = 0; i < 200; i++) log.info(`${i} `.padEnd(20000, 'x'));
  const Backlog = Logger.GetLogFeedBacklog();
  const Chars = Backlog.reduce((Sum, Entry) => Sum + Entry.Message.length, 0);
  assert.ok(Backlog.length < 200);
  assert.ok(Chars <= 1_000_000, `backlog holds ${Chars} characters`);
  assert.match(Backlog[Backlog.length - 1].Message, /^199 /);
});

test('a starved flush holds a bounded batch, newest lines kept', async () => {
  const { Logger, Hub } = load('info');
  const log = Logger.CreateLogger('Feed');
  const got = [];
  Hub.OpenLogConsole('a', 'info', (Entries) => got.push(...Entries));
  try {
    // Synchronous, so no flush can run in between.
    for (let i = 0; i < 300; i++) log.info(`${i} `.padEnd(20000, 'x'));
    await wait(FLUSH_WAIT_MS);
    const Chars = got.reduce((Sum, Entry) => Sum + Entry.Message.length, 0);
    assert.ok(got.length < 300);
    assert.ok(Chars <= 2_000_000, `batch held ${Chars} characters`);
    assert.match(got[got.length - 1].Message, /^299 /);
  } finally {
    Hub.CloseLogConsole('a');
  }
});
