const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function loadLogger(logsDir) {
  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'Logger', 'index.js');
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

    // Allow the async write queue to drain.
    await new Promise((r) => setTimeout(r, 100));

    const files = fs.readdirSync(logsDir).filter((f) => f.endsWith('.log'));
    assert.equal(files.length >= 1, true);
    const contents = fs.readFileSync(path.join(logsDir, files[0]), 'utf8');
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
    Logger.configure({ level: 'error', toFile: true, toConsole: false, retentionDays: 7 });
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
