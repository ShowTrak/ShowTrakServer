const test = require('node:test');
const assert = require('node:assert/strict');

const { TRIGGER_CATALOG, TRIGGERS } = require('../dist/Modules/AlertsManager/triggers');

// The trigger catalog is the single declaration of every alert trigger: the
// evaluators' ID constants, the editor's picker, its allowlist and the rule
// summaries all derive from it. These pin the properties those consumers rely on.

test('every trigger is declared once, with a name, a summary and a category', () => {
  const Seen = new Set();
  for (const Row of TRIGGER_CATALOG) {
    assert.ok(!Seen.has(Row.ID), `${Row.ID} is declared twice`);
    Seen.add(Row.ID);
    for (const Field of ['Name', 'Summary', 'Category']) {
      assert.ok(String(Row[Field] || '').trim(), `${Row.ID} has no ${Field}`);
    }
  }
});

test('TRIGGERS exposes exactly the catalog IDs, each mapped to itself', () => {
  assert.deepEqual(Object.keys(TRIGGERS).sort(), TRIGGER_CATALOG.map((T) => T.ID).sort());
  for (const [Key, Value] of Object.entries(TRIGGERS)) assert.equal(Key, Value);
});

test('each category is one contiguous run, so the picker groups in catalog order', () => {
  // The editor groups by first appearance of a category; a category split in two
  // would list some of its triggers under a heading further down than expected.
  const Closed = new Set();
  let Current = null;
  for (const { ID, Category } of TRIGGER_CATALOG) {
    if (Category !== Current) {
      assert.ok(!Closed.has(Category), `${ID} reopens category "${Category}"`);
      if (Current) Closed.add(Current);
      Current = Category;
    }
  }
});

test('no two triggers share a summary phrase', () => {
  // A shared phrase makes two different rules read identically in the rule list.
  const Phrases = new Map();
  for (const { ID, Summary } of TRIGGER_CATALOG) {
    assert.ok(!Phrases.has(Summary), `${ID} shares "${Summary}" with ${Phrases.get(Summary)}`);
    Phrases.set(Summary, ID);
  }
});
