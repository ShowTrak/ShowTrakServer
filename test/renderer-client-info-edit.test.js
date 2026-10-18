const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/lib/client-info-edit.ts: when a client's view modal is
// editable, which MACs "Add from Client" offers, and the UpdateClient payload
// its Save sends. The DOM side (client-info-edit.ts) is a thin adapter over this.
//
// Loaded from dist-test/ (see test/renderer-utils.test.js for why).
const {
  BuildClientUpdatePayload,
  ClientSettingsDraftChanged,
  CollectClientMacCandidates,
  IsClientInfoEditable,
  MissingMacAddresses,
  NormalizeMac,
  OfflineGraceSummary,
} = require('../dist-test/UI/js/app/lib/client-info-edit.js');

// --- Edit gating ---------------------------------------------------------------

test('a ShowTrak client is editable in Edit mode on the desktop, and only then', () => {
  const Base = { AppMode: 'EDIT', CanManage: true, Kind: 'client' };
  assert.equal(IsClientInfoEditable(Base), true);
  assert.equal(IsClientInfoEditable({ ...Base, AppMode: 'SHOW' }), false);
  // The Web UI has no client editing at all.
  assert.equal(IsClientInfoEditable({ ...Base, CanManage: false }), false);
  assert.equal(IsClientInfoEditable({ ...Base, Kind: null }), false);
});

test('a monitor is editable in Edit mode too (its Settings tab)', () => {
  assert.equal(IsClientInfoEditable({ AppMode: 'EDIT', CanManage: true, Kind: 'target' }), true);
  assert.equal(IsClientInfoEditable({ AppMode: 'SHOW', CanManage: true, Kind: 'target' }), false);
});

test('a dummy client is editable in Edit mode too (its Settings tab)', () => {
  assert.equal(IsClientInfoEditable({ AppMode: 'EDIT', CanManage: true, Kind: 'dummy' }), true);
  assert.equal(IsClientInfoEditable({ AppMode: 'EDIT', CanManage: false, Kind: 'dummy' }), false);
});

test('every kind is editable from its view modal in Edit mode, and none in Show mode', () => {
  for (const Kind of ['client', 'integrated', 'target', 'dummy', 'freekiosk']) {
    assert.equal(IsClientInfoEditable({ AppMode: 'EDIT', CanManage: true, Kind }), true, Kind);
    assert.equal(IsClientInfoEditable({ AppMode: 'SHOW', CanManage: true, Kind }), false, Kind);
  }
});

// --- Wake on LAN candidates -------------------------------------------------------

test('Add from Client offers every non-internal MAC once, normalized', () => {
  const Candidates = CollectClientMacCandidates([
    { name: 'lo0', addresses: [{ mac: '00:00:00:00:00:00', internal: true }] },
    {
      name: 'en0',
      addresses: [
        { mac: 'a4:83:e7:01:02:03', internal: false },
        // IPv6 on the same NIC reports the same MAC again.
        { mac: 'A4-83-E7-01-02-03', internal: false },
      ],
    },
    // Locally administered (a virtual adapter): the server's own ingest skips
    // these, but the operator asking for every address gets it.
    { name: 'bridge0', addresses: [{ mac: '02:42:ac:11:00:02', internal: false }] },
  ]);
  assert.deepEqual(Candidates, [
    { MacAddress: 'A4:83:E7:01:02:03', InterfaceName: 'en0' },
    { MacAddress: '02:42:AC:11:00:02', InterfaceName: 'bridge0' },
  ]);
});

test('internal, all-zero and malformed addresses are never offered', () => {
  assert.deepEqual(
    CollectClientMacCandidates([
      { name: 'lo', addresses: [{ mac: 'aa:bb:cc:dd:ee:ff', internal: true }] },
      { name: 'utun0', addresses: [{ mac: '00:00:00:00:00:00', internal: false }] },
      { name: 'x', addresses: [{ mac: 'not-a-mac' }, { internal: false }, null] },
      null,
    ]),
    []
  );
  assert.deepEqual(CollectClientMacCandidates(undefined), []);
});

test('only addresses not already on the list are added', () => {
  const Existing = [{ MacAddress: 'AA:BB:CC:DD:EE:01' }];
  assert.deepEqual(
    MissingMacAddresses(
      ['aa-bb-cc-dd-ee-01', 'AA:BB:CC:DD:EE:02', 'aabbccddee02', 'junk'],
      Existing
    ),
    ['AA:BB:CC:DD:EE:02']
  );
  assert.deepEqual(MissingMacAddresses(['AA:BB:CC:DD:EE:03'], undefined), ['AA:BB:CC:DD:EE:03']);
});

test('MAC normalization matches the server', () => {
  const { NormalizeMacAddress } = require('../dist/Modules/MacAddress');
  for (const Value of ['aa:bb:cc:dd:ee:ff', 'AA-BB-CC-DD-EE-FF', 'aabb.ccdd.eeff', 'xyz', '', 12]) {
    assert.equal(NormalizeMac(Value), NormalizeMacAddress(Value), String(Value));
  }
});

// --- Saving ------------------------------------------------------------------------

const DRAFT = {
  Slug: 'foh-pc',
  Nickname: 'FOH PC',
  GroupID: '3',
  OfflineGraceSeconds: '',
  RunOnLaunchScriptID: '',
  RunOnLaunchDelaySeconds: '10',
  Variables: null,
};
const ORIGINAL = { Slug: 'foh-pc', Hostname: 'FOH-PC-01', Integrated: false };

test('Save sends the same shape the client editor always did', () => {
  assert.deepEqual(BuildClientUpdatePayload(DRAFT, ORIGINAL), {
    Nickname: 'FOH PC',
    GroupID: 3,
    OfflineGraceSeconds: null,
    RunOnLaunchScriptID: null,
    RunOnLaunchDelaySeconds: null,
  });
});

test('an emptied nickname falls back to the hostname, and No Group is null', () => {
  const Payload = BuildClientUpdatePayload({ ...DRAFT, Nickname: '', GroupID: 'null' }, ORIGINAL);
  assert.equal(Payload.Nickname, 'FOH-PC-01');
  assert.equal(Payload.GroupID, null);
});

test('the slug travels only when changed, and emptying it keeps the old one', () => {
  assert.equal('Slug' in BuildClientUpdatePayload(DRAFT, ORIGINAL), false);
  assert.equal('Slug' in BuildClientUpdatePayload({ ...DRAFT, Slug: '  ' }, ORIGINAL), false);
  assert.equal(
    BuildClientUpdatePayload({ ...DRAFT, Slug: ' stage-pc ' }, ORIGINAL).Slug,
    'stage-pc'
  );
});

test('a launch delay is clamped to the minimum, and dropped without a script', () => {
  const WithScript = (Delay) =>
    BuildClientUpdatePayload(
      { ...DRAFT, RunOnLaunchScriptID: 'abc', RunOnLaunchDelaySeconds: Delay },
      ORIGINAL
    );
  assert.equal(WithScript('25').RunOnLaunchDelaySeconds, 25);
  assert.equal(WithScript('3').RunOnLaunchDelaySeconds, 10);
  assert.equal(WithScript('').RunOnLaunchDelaySeconds, 10);
  assert.equal(WithScript('25').RunOnLaunchScriptID, 'abc');
});

test('an explicit disconnect grace is sent as a number, the default as null', () => {
  assert.equal(
    BuildClientUpdatePayload({ ...DRAFT, OfflineGraceSeconds: '0' }, ORIGINAL).OfflineGraceSeconds,
    0
  );
  assert.equal(BuildClientUpdatePayload(DRAFT, ORIGINAL).OfflineGraceSeconds, null);
});

test('an emptied variable inherits (null), never pins an empty string', () => {
  const Payload = BuildClientUpdatePayload(
    { ...DRAFT, Variables: { 1: 'GAME_A', 2: '' } },
    ORIGINAL
  );
  assert.deepEqual(Payload.Variables, { 1: 'GAME_A', 2: null });
  // No rows shown: no Variables key, which would read as "clear every override".
  assert.equal('Variables' in BuildClientUpdatePayload(DRAFT, ORIGINAL), false);
});

test('an SDK client never sends launch fields or variables', () => {
  const Payload = BuildClientUpdatePayload(
    { ...DRAFT, RunOnLaunchScriptID: 'abc', Variables: { 1: 'x' } },
    { ...ORIGINAL, Integrated: true }
  );
  assert.equal('RunOnLaunchScriptID' in Payload, false);
  assert.equal('RunOnLaunchDelaySeconds' in Payload, false);
  assert.equal('Variables' in Payload, false);
});

test('Save is offered only once the form differs from what it was filled with', () => {
  assert.equal(ClientSettingsDraftChanged(DRAFT, { ...DRAFT }), false);
  assert.equal(ClientSettingsDraftChanged(DRAFT, { ...DRAFT, Nickname: 'FOH' }), true);
  assert.equal(ClientSettingsDraftChanged(DRAFT, { ...DRAFT, Variables: { 1: '' } }), true);
  assert.equal(ClientSettingsDraftChanged(null, DRAFT), false);
});

test('the read-only grace names an override or what the default resolves to', () => {
  assert.equal(OfflineGraceSummary(null, 3), 'Use default (3 seconds)');
  assert.equal(OfflineGraceSummary(undefined, 0), 'Use default (Offline immediately)');
  assert.equal(OfflineGraceSummary(1, 5), '1 second');
  // The Web UI cannot read the Preferences value, so does not guess it.
  assert.equal(OfflineGraceSummary(null, null), 'Use default');
});
