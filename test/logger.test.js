const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function loadLogger(logsDir) {
  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'Logger', 'index');
  return loadWithMocks(modulePath, {
    '../AppData': { Manager: { GetLogsDirectory: () => logsDir } },
  });
}

test('Logger writes leveled lines to the daily log file', async () => {
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-logs-'));
  const previousLevel = process.env.LOG_LEVEL;
  const previousConsole = process.env.LOG_TO_CONSOLE;
  process.env.LOG_LEVEL = 'trace';
  process.env.LOG_TO_CONSOLE = 'false';

  try {
    const Logger = loadLogger(logsDir);
    const log = Logger.CreateLogger('TestModule');

    log.info('hello world');
    log.warn('a warning');
    log.error(new Error('boom'));
    log.success('great');
    log.database('db message');
    log.databaseError('db failed');
    log.debug('debug detail');
    log.trace('trace detail');
    log.silent('silent line');
    log.log({ nested: true });

    const child = log.child('Sub');
    assert.equal(child.Alias, 'TestModule:Sub');
    child.info('from child');

    // Wait for the async write queue to drain as far as the last line written.
    // A fixed pause was too short on a loaded CI runner, which then read the
    // file before the child's line had landed.
    const readLog = () => {
      const files = fs.readdirSync(logsDir).filter((f) => f.endsWith('.log'));
      return files.length ? fs.readFileSync(path.join(logsDir, files[0]), 'utf8') : '';
    };
    let contents = readLog();
    for (let waited = 0; !/from child/.test(contents) && waited < 5000; waited += 25) {
      await new Promise((r) => setTimeout(r, 25));
      contents = readLog();
    }
    assert.notEqual(contents, '', 'a daily log file was written');
    assert.match(contents, /hello world/);
    assert.match(contents, /a warning/);
    assert.match(contents, /boom/);
    assert.match(contents, /TestModule:SUB|TestModule:Sub/i);
    // JSON-serializable args are stringified.
    assert.match(contents, /\{"nested":true\}/);
  } finally {
    process.env.LOG_LEVEL = previousLevel;
    process.env.LOG_TO_CONSOLE = previousConsole;
  }
});

test('Logger.configure toggles level gating', async () => {
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-logs-'));
  const previousConsole = process.env.LOG_TO_CONSOLE;
  process.env.LOG_TO_CONSOLE = 'false';

  try {
    const Logger = loadLogger(logsDir);
    // Raise the level so debug/trace are suppressed; functions must not throw.
    Logger.configure({ level: 'error', toFile: true, toConsole: false });
    const log = Logger.CreateLogger('Cfg');
    log.debug('should be gated');
    log.trace('should be gated');
    log.error('still logged');

    await new Promise((r) => setTimeout(r, 50));
    const files = fs.readdirSync(logsDir).filter((f) => f.endsWith('.log'));
    const contents = files.length ? fs.readFileSync(path.join(logsDir, files[0]), 'utf8') : '';
    assert.match(contents, /still logged/);
  } finally {
    process.env.LOG_TO_CONSOLE = previousConsole;
  }
});

// --- Default level derivation ----------------------------------------------
//
// This went wrong silently and stayed wrong: the default was derived from
// NODE_ENV alone, but a packaged Electron app has no NODE_ENV, so every shipped
// server ran at 'debug' and wrote debug chatter to its daily log file forever.
// Nothing caught it because SYSTEM_LOG_LEVEL *looked* correct; it defaults to
// 'info', and main/live-settings.ts skips applying a still-default setting at
// boot, so the settings UI read "info" while the logger did not.
//
// The signal is `process.defaultApp`, which Electron sets only when the app was
// launched from a checkout. These tests pin all three inputs (packaged build,
// NODE_ENV, LOG_LEVEL) so the derivation cannot quietly drift again.

// Load the Logger with the environment scripted, write one debug + one info
// line, and report which of them reached the log file.
async function captureDefaultLevelBehaviour({ packaged, nodeEnv, logLevel }) {
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-logs-default-'));

  const previous = {
    level: process.env.LOG_LEVEL,
    console: process.env.LOG_TO_CONSOLE,
    nodeEnv: process.env.NODE_ENV,
    defaultApp: process.defaultApp,
  };

  process.env.LOG_TO_CONSOLE = 'false';
  if (logLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = logLevel;
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  // A packaged build is the ABSENCE of process.defaultApp.
  if (packaged) delete process.defaultApp;
  else process.defaultApp = true;

  try {
    const Logger = loadLogger(logsDir);
    const log = Logger.CreateLogger('DefaultLevel');
    log.debug('debug-line-marker');
    log.info('info-line-marker');

    await new Promise((r) => setTimeout(r, 100));
    const files = fs.readdirSync(logsDir).filter((f) => f.endsWith('.log'));
    const contents = files.length ? fs.readFileSync(path.join(logsDir, files[0]), 'utf8') : '';
    return {
      debugLogged: contents.includes('debug-line-marker'),
      infoLogged: contents.includes('info-line-marker'),
    };
  } finally {
    if (previous.level === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previous.level;
    if (previous.console === undefined) delete process.env.LOG_TO_CONSOLE;
    else process.env.LOG_TO_CONSOLE = previous.console;
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.nodeEnv;
    if (previous.defaultApp === undefined) delete process.defaultApp;
    else process.defaultApp = previous.defaultApp;
  }
}

test('a packaged build defaults to info, so debug never reaches the log file', async () => {
  const result = await captureDefaultLevelBehaviour({ packaged: true, nodeEnv: undefined });
  assert.equal(result.infoLogged, true, 'info must still be recorded in a shipped build');
  assert.equal(
    result.debugLogged,
    false,
    'a shipped server must not write debug output to its daily log file'
  );
});

test('a checkout run defaults to debug', async () => {
  const result = await captureDefaultLevelBehaviour({ packaged: false, nodeEnv: undefined });
  assert.equal(result.debugLogged, true, 'running from a checkout keeps the verbose default');
});

test('NODE_ENV=production still forces info when not packaged', async () => {
  const result = await captureDefaultLevelBehaviour({ packaged: false, nodeEnv: 'production' });
  assert.equal(result.debugLogged, false);
  assert.equal(result.infoLogged, true);
});

test('LOG_LEVEL overrides the packaged default, so a field server can be made verbose', async () => {
  const result = await captureDefaultLevelBehaviour({
    packaged: true,
    nodeEnv: undefined,
    logLevel: 'debug',
  });
  assert.equal(
    result.debugLogged,
    true,
    'LOG_LEVEL=debug is how a misbehaving server on site produces detail without a rebuild'
  );
});

test('a burst of lines lands in order, in a handful of appends rather than one each', async (t) => {
  // File writes are batched: lines logged while an append is in flight go out
  // together once it lands. Order must survive that.
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-logs-'));
  const previous = { level: process.env.LOG_LEVEL, console: process.env.LOG_TO_CONSOLE };
  process.env.LOG_LEVEL = 'info';
  process.env.LOG_TO_CONSOLE = 'false';
  t.after(() => {
    process.env.LOG_LEVEL = previous.level;
    process.env.LOG_TO_CONSOLE = previous.console;
  });

  let Appends = 0;
  const RealAppend = fs.promises.appendFile;
  t.mock.method(fs.promises, 'appendFile', (...Args) => {
    Appends++;
    return RealAppend.apply(fs.promises, Args);
  });

  const Logger = loadLogger(logsDir);
  const log = Logger.CreateLogger('Burst');
  for (let I = 0; I < 500; I++) log.info(`line ${I}`);
  await Logger.flushLogWrites();

  const [File] = fs.readdirSync(logsDir).filter((f) => f.endsWith('.log'));
  const Lines = fs
    .readFileSync(path.join(logsDir, File), 'utf8')
    .split('\n')
    .filter((L) => / line \d+$/.test(L))
    .map((L) => Number(L.match(/ line (\d+)$/)[1]));
  assert.deepEqual(
    Lines,
    Array.from({ length: 500 }, (_, I) => I),
    'every line, in order'
  );
  assert.ok(Appends <= 3, `${Appends} appends for 500 lines`);
});

test('logging recovers when the log folder is removed while running', async (t) => {
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-logs-'));
  const previous = { level: process.env.LOG_LEVEL, console: process.env.LOG_TO_CONSOLE };
  process.env.LOG_LEVEL = 'info';
  process.env.LOG_TO_CONSOLE = 'false';
  t.after(() => {
    process.env.LOG_LEVEL = previous.level;
    process.env.LOG_TO_CONSOLE = previous.console;
  });
  const Logger = loadLogger(logsDir);
  const log = Logger.CreateLogger('Gone');
  log.info('before');
  await Logger.flushLogWrites();
  fs.rmSync(logsDir, { recursive: true, force: true });
  log.info('after');
  await Logger.flushLogWrites();
  const [File] = fs.readdirSync(logsDir).filter((f) => f.endsWith('.log'));
  assert.match(fs.readFileSync(path.join(logsDir, File), 'utf8'), /after/);
});
