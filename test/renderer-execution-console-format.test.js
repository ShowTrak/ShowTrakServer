const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Exercises src/UI/js/app/lib/execution-console-format.ts: how the execution
// console shows each kind of history entry, and the notes that explain gaps
// (trimmed history, a client too old to stream its console).

const { FormatConsoleEntry, GetConsoleNotes, FormatConsoleTime } = require(
  path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app', 'lib', 'execution-console-format.js')
);

const at = new Date(2026, 10, 18, 9, 5, 7).getTime();

test('output is shown as written; everything else gets its own timestamped line', () => {
  assert.equal(FormatConsoleTime(at), '09:05:07');
  assert.deepEqual(FormatConsoleEntry({ Seq: 1, Time: at, Kind: 'stdout', Text: 'a\nb' }), {
    Text: 'a\nb',
    Style: 'stdout',
    OwnLine: false,
  });
  assert.equal(FormatConsoleEntry({ Seq: 1, Time: at, Kind: 'stderr', Text: 'x' }).Style, 'stderr');
  assert.deepEqual(FormatConsoleEntry({ Seq: 1, Time: at, Kind: 'stage', Text: 'Queued' }), {
    Text: '[09:05:07] Queued',
    Style: 'stage',
    OwnLine: true,
  });
  assert.deepEqual(FormatConsoleEntry({ Seq: 1, Time: at, Kind: 'result', Text: 'Completed' }), {
    Text: '[09:05:07] Completed',
    Style: 'ok',
    OwnLine: true,
  });
  assert.deepEqual(
    FormatConsoleEntry({ Seq: 1, Time: at, Kind: 'result', Text: 'Disk full', Error: true }),
    { Text: '[09:05:07] Failed: Disk full', Style: 'error', OwnLine: true }
  );
  assert.equal(FormatConsoleEntry({ Seq: 1, Time: at, Kind: 'tail', Text: 'step' }).OwnLine, true);
});

test('notes explain what the console cannot show', () => {
  const clean = { Trimmed: false, HasStreamOutput: true, ClientTruncated: false };
  assert.deepEqual(GetConsoleNotes(clean, { Internal: false, SawTail: false }), []);
  assert.equal(
    GetConsoleNotes(
      { ...clean, Trimmed: true, ClientTruncated: true },
      { Internal: false, SawTail: false }
    ).length,
    2
  );
  // An older client: only sampled lines.
  const old = { ...clean, HasStreamOutput: false };
  assert.match(GetConsoleNotes(old, { Internal: false, SawTail: true })[0], /latest output line/);
  // ...but never for server-side actions, which have no console of their own.
  assert.deepEqual(GetConsoleNotes(old, { Internal: true, SawTail: true }), []);
});
