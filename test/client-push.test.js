const test = require('node:test');
const assert = require('node:assert/strict');

// The batched client push pipeline (src/Modules/Server/client-push.ts): changes
// are queued per client and flushed together, once per client per flush with
// its latest state, and each surface diffs against what it last sent.
const Push = require('../dist/Modules/Server/client-push');

test.beforeEach(() => Push.ResetClientPushes());

test('a flush delivers each queued client once, at its latest state, to every sink', () => {
  const Seen = [];
  const Off = Push.RegisterClientPushSink((Batch) => Seen.push(Batch.Clients.map((C) => C.UUID)));
  try {
    const A = { UUID: 'a' };
    Push.QueueClientPush(A);
    Push.QueueClientPush({ UUID: 'b' });
    Push.QueueClientPush(A);
    Push.QueueClientPush(null);
    Push.QueueClientPush({ UUID: '' });
    Push.FlushClientPushes();
    assert.deepEqual(Seen, [['a', 'b']]);
    // Nothing queued: nothing delivered.
    Push.FlushClientPushes();
    assert.equal(Seen.length, 1);
  } finally {
    Off();
  }
});

test('queued clients flush on their own after the push interval', async () => {
  const Seen = [];
  const Off = Push.RegisterClientPushSink((Batch) => Seen.push(Batch.Clients.length));
  try {
    Push.QueueClientPush({ UUID: 'timed' });
    assert.deepEqual(Seen, []);
    await new Promise((resolve) => setTimeout(resolve, Push.CLIENT_PUSH_INTERVAL_MS + 50));
    assert.deepEqual(Seen, [1]);
  } finally {
    Off();
  }
});

test('the public projection is computed once per client per flush and shared', () => {
  const Views = [];
  const Offs = [
    Push.RegisterClientPushSink((Batch) => Views.push(Batch.PublicOf(0))),
    Push.RegisterClientPushSink((Batch) => Views.push(Batch.PublicOf(0))),
    // A sink that never asks costs no projection, and one that throws costs the others nothing.
    Push.RegisterClientPushSink(() => {
      throw new Error('surface down');
    }),
  ];
  try {
    Push.QueueClientPush({ UUID: 'shared', Nickname: 'PC', Online: true });
    Push.FlushClientPushes();
    assert.equal(Views.length, 2);
    assert.equal(Views[0], Views[1]);
    assert.equal(Views[0].UUID, 'shared');
    assert.equal(Views[0].Type, 'client');
  } finally {
    for (const Off of Offs) Off();
  }
});

test('DiffIntoBaseline sends only changed fields, names removed ones, and honours Skip', () => {
  const Baseline = {};
  const Vitals = { CPU: { UsagePercentage: 1 } };
  const Source = { UUID: 'x', Online: true, Vitals, Raw: [1] };
  const Skip = new Set(['Raw']);

  assert.deepEqual(Push.DiffIntoBaseline('x', Baseline, Source, Skip), {
    UUID: 'x',
    Online: true,
    Vitals,
  });
  assert.equal(Push.DiffIntoBaseline('x', Baseline, Source, Skip), null, 'nothing moved');

  // A new object with equal content is still a change: views are rebuilt only
  // when they change, so a new reference means new content.
  Source.Vitals = { CPU: { UsagePercentage: 1 } };
  assert.deepEqual(Push.DiffIntoBaseline('x', Baseline, Source, Skip), {
    UUID: 'x',
    Vitals: Source.Vitals,
  });

  // A field explicitly set to undefined is a change too.
  Source.Online = undefined;
  assert.deepEqual(Push.DiffIntoBaseline('x', Baseline, Source, Skip), {
    UUID: 'x',
    Online: undefined,
  });

  delete Source.Online;
  assert.deepEqual(Push.DiffIntoBaseline('x', Baseline, Source, Skip), {
    UUID: 'x',
    $Removed: ['Online'],
  });
  assert.equal('Online' in Baseline, false);
});
