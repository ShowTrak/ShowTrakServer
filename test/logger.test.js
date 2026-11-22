const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

// src/Modules/Logger is @showtrak/protocol/runtime's CreateAppLogging (level
// gating, the default level, batched daily-file writes: covered by the
// protocol's specs) configured for ShowTrak Server. What is the Server's own is
// that configuration, checked here: the logs folder in AppData and the name its
// lines and files carry. The live feed its log console reads is covered by
// log-console.test.js.

function loadLogger(logsDir) {
  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'Logger', 'index');
  return loadWithMocks(modulePath, {
    '../AppData': { Manager: { GetLogsDirectory: () => logsDir } },
  });
}

test("Logger writes ShowTrakServer's daily log file in the AppData logs folder", async (t) => {
  const logsDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-logs-')), 'Logs');
  const previous = { level: process.env.LOG_LEVEL, console: process.env.LOG_TO_CONSOLE };
  process.env.LOG_LEVEL = 'trace';
  process.env.LOG_TO_CONSOLE = 'false';
  t.after(() => {
    for (const [Key, Value] of [
      ['LOG_LEVEL', previous.level],
      ['LOG_TO_CONSOLE', previous.console],
    ]) {
      if (Value === undefined) delete process.env[Key];
      else process.env[Key] = Value;
    }
  });

  const Logger = loadLogger(logsDir);
  assert.ok(fs.existsSync(logsDir), 'the logs folder is created with the logger');
  const log = Logger.CreateLogger('TestModule');
  log.info('hello world');
  log.child('Sub').warn('from child');
  log.trace({ nested: true });
  await Logger.flushLogWrites();

  const files = fs.readdirSync(logsDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^ShowTrakServer-\d{4}-\d{2}-\d{2}\.log$/);
  const contents = fs.readFileSync(path.join(logsDir, files[0]), 'utf8');
  assert.match(contents, /\[ShowTrakServer\] \[TESTMODULE\s*\] \[INFO\s*\] hello world/);
  assert.match(contents, /\[TESTMODULE:SUB\s*\] \[WARN\s*\] from child/);
  assert.match(contents, /\{"nested":true\}/);
});
