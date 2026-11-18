const test = require('node:test');
const assert = require('node:assert/strict');

// Live client patches as the renderer applies them (lib/client-patches): one
// merged object per client, patched in place so every list holding it agrees.
const { ApplyClientPatch, IndexClients } = require('../dist-test/UI/js/app/lib/client-patches');

test('a patch updates only its fields, in place, and drops removed ones', () => {
  const Vitals = { CPU: { UsagePercentage: 5 } };
  const Client = { UUID: 'a', Nickname: 'PC', Online: false, Vitals, Gone: 1 };
  const List = [Client];
  const Copy = List.slice();
  const Index = IndexClients(List);

  ApplyClientPatch(Index.get('a'), { UUID: 'a', Online: true, $Removed: ['Gone'] });
  assert.equal(List[0], Client, 'the same object, so every list sees it');
  assert.equal(Copy[0].Online, true);
  assert.equal(Client.Nickname, 'PC');
  assert.equal(Client.Vitals, Vitals);
  assert.equal('Gone' in Client, false);
  assert.equal('$Removed' in Client, false);
});

test('IndexClients skips entries without a UUID', () => {
  const Index = IndexClients([{ UUID: 'a' }, null, { Nickname: 'x' }]);
  assert.deepEqual([...Index.keys()], ['a']);
});
