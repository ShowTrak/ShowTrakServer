const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/lib/log-console-budget.ts — the cap on what the hidden
// log console holds. The console can be left open for days, so what it keeps
// must be bounded by characters as well as lines: a line can be 20,000
// characters long.
const {
  MAX_LINES,
  MAX_CHARS,
  EntryChars,
  NewestWithinBudget,
} = require('../dist-test/UI/js/app/lib/log-console-budget.js');

const entry = (Seq, Message = 'x') => ({
  Seq,
  Time: 0,
  Level: 'info',
  Type: 'Info',
  Alias: 'T',
  Message,
});

test('a batch within budget is returned as is', () => {
  const Entries = [entry(1), entry(2), entry(3)];
  assert.equal(NewestWithinBudget(Entries), Entries);
});

test('beyond the line cap only the newest lines are kept, in order', () => {
  const Entries = Array.from({ length: MAX_LINES + 50 }, (_, i) => entry(i + 1));
  const Kept = NewestWithinBudget(Entries);
  assert.equal(Kept.length, MAX_LINES);
  assert.equal(Kept[0].Seq, 51);
  assert.equal(Kept[Kept.length - 1].Seq, MAX_LINES + 50);
});

test('long lines are capped by characters long before the line cap', () => {
  const Long = 'y'.repeat(20000);
  const Entries = Array.from({ length: 500 }, (_, i) => entry(i + 1, Long));
  const Kept = NewestWithinBudget(Entries);
  const Chars = Kept.reduce((Sum, E) => Sum + EntryChars(E), 0);
  assert.ok(Kept.length < 500);
  assert.ok(Chars <= MAX_CHARS);
  assert.equal(Kept[Kept.length - 1].Seq, 500, 'the newest line always survives');
});

test('a single line over the whole budget is still kept', () => {
  const Huge = entry(1, 'z'.repeat(MAX_CHARS + 10));
  assert.deepEqual(
    NewestWithinBudget([entry(0), Huge]).map((E) => E.Seq),
    [1]
  );
});

test('an empty batch stays empty', () => {
  assert.deepEqual(NewestWithinBudget([]), []);
});
