const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Exercises src/Modules/ScriptExecutionManager/output-log.ts: an execution's
// console history. It must hand a polling viewer only what is new, stay
// bounded however much a script prints, and not show an older client's sampled
// "latest line" alongside real output it would duplicate.

const { ExecutionLog, MAX_LOG_CHARS, MAX_CHUNK_CHARS } = require(
  path.join(__dirname, '..', 'dist', 'Modules', 'ScriptExecutionManager', 'output-log.js')
);

test('entries get increasing Seqs and Since returns only what is new', () => {
  const Log = new ExecutionLog();
  Log.Stage('Queued', 1);
  Log.Output('stdout', 'hello\n', 2);
  const First = Log.Since(0);
  assert.deepEqual(
    First.Entries.map((E) => [E.Seq, E.Kind, E.Text]),
    [
      [1, 'stage', 'Queued'],
      [2, 'stdout', 'hello\n'],
    ]
  );
  Log.Output('stderr', 'warn\n', 3);
  Log.Result(null, 4);
  const Next = Log.Since(First.LastSeq);
  assert.deepEqual(
    Next.Entries.map((E) => E.Kind),
    ['stderr', 'result']
  );
  assert.equal(Next.LastSeq, 4);
  assert.deepEqual(Log.Since(4).Entries, []);
});

test('repeated stages and tails are recorded once', () => {
  const Log = new ExecutionLog();
  Log.Stage('Running', 1);
  Log.Stage('Running', 2);
  Log.Tail('step 1', 3);
  Log.Tail('step 1', 4);
  Log.Tail('step 2', 5);
  assert.deepEqual(
    Log.Since(0).Entries.map((E) => E.Text),
    ['Running', 'step 1', 'step 2']
  );
});

test('sampled tail lines give way to real output', () => {
  // A newer client's progress line can arrive just before its first output
  // batch; it is the same text, so it is dropped rather than shown twice.
  const Log = new ExecutionLog();
  Log.Stage('Running', 1);
  Log.Tail('from progress', 2);
  Log.Output('stdout', 'from progress\n', 3);
  Log.Tail('duplicate of real output', 4);
  assert.deepEqual(
    Log.Since(0).Entries.map((E) => E.Kind),
    ['stage', 'stdout']
  );
  assert.equal(Log.HasStreamOutput, true);
});

test('a failure is recorded as an error result', () => {
  const Log = new ExecutionLog();
  Log.Result('exit code 3', 1);
  const [Entry] = Log.Since(0).Entries;
  assert.equal(Entry.Kind, 'result');
  assert.equal(Entry.Error, true);
  assert.equal(Entry.Text, 'exit code 3');
});

test('the log is capped: oldest entries go first and Trimmed is set', () => {
  const Log = new ExecutionLog();
  const Chunk = 'x'.repeat(MAX_CHUNK_CHARS);
  const Count = Math.ceil(MAX_LOG_CHARS / MAX_CHUNK_CHARS) + 3;
  for (let i = 0; i < Count; i++) Log.Output('stdout', Chunk, i);
  const { Entries, LastSeq } = Log.Since(0);
  const Total = Entries.reduce((N, E) => N + E.Text.length, 0);
  assert.ok(Total <= MAX_LOG_CHARS, `kept ${Total} chars`);
  assert.equal(Log.Trimmed, true);
  assert.equal(LastSeq, Count, 'Seqs keep counting after a trim');
  assert.equal(Entries[Entries.length - 1].Seq, Count, 'the newest output is kept');
});

test('a single oversized chunk is cut to the chunk limit', () => {
  const Log = new ExecutionLog();
  Log.Output('stdout', 'y'.repeat(MAX_CHUNK_CHARS * 2), 1);
  assert.equal(Log.Since(0).Entries[0].Text.length, MAX_CHUNK_CHARS);
});
