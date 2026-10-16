const test = require('node:test');
const assert = require('node:assert/strict');

const CM = '../dist/Modules/ClientManager';
const {
  CriticalListFrom,
  HasCriticalEntry,
  WithCriticalEntry,
  WithoutCriticalEntry,
  ProjectCriticalRow,
} = require(`${CM}/critical-kind`);
const { USB_SERIAL_KIND, USB_NAME_KIND } = require(`${CM}/usb`);
const { DISPLAY_KIND } = require(`${CM}/display`);
const { AUDIO_KIND } = require(`${CM}/audio`);
const { NETWORK_KIND } = require(`${CM}/network`);
const { APPLICATION_KIND, normalizeCriticalApplicationEntry } = require(`${CM}/applications`);

// Every monitored kind keeps the same per-client list in three places (side
// table, manager index, Client). These pin the shared bookkeeping, and the one
// property each kind must hold for it to work: the key an entry is stored under
// is already in the form a request's key normalises to.

const SAMPLES = [
  ['USB serial', USB_SERIAL_KIND, { SerialNumber: ' cl12345 ' }],
  ['USB name', USB_NAME_KIND, { ManufacturerName: 'Acme', ProductName: 'Dongle' }],
  ['display', DISPLAY_KIND, { DisplayID: ' edid:abc ' }],
  ['audio', AUDIO_KIND, { EndpointID: 'out:{0.0.0.00000000}.{abc}', Direction: 'output' }],
  ['network', NETWORK_KIND, { Name: 'en0' }],
  ['application', APPLICATION_KIND, { Name: ' QLab ' }],
];

for (const [Label, Kind, Raw] of SAMPLES) {
  test(`${Label}: a stored key round-trips through the key normaliser`, () => {
    const Entry = Kind.NormalizeEntry(Raw);
    assert.ok(Entry, `${Label} sample did not normalise`);
    const Key = Kind.KeyOf(Entry);
    assert.equal(Kind.NormalizeKey(Key), Key, 'Remove/Is would not find what Mark stored');
  });
}

test('a list is normalised and de-duplicated by key, the first entry winning', () => {
  const List = CriticalListFrom(USB_SERIAL_KIND, [
    { SerialNumber: 'abc', ProductName: 'First' },
    { SerialNumber: 'ABC', ProductName: 'Second' },
    { SerialNumber: '' },
    null,
    { SerialNumber: 'def' },
  ]);
  assert.deepEqual(
    List.map((E) => [E.SerialNumber, E.ProductName]),
    [
      ['ABC', 'First'],
      ['DEF', null],
    ]
  );
  assert.deepEqual(CriticalListFrom(USB_SERIAL_KIND, 'not a list'), []);
});

test('marking adds a new entry or replaces the one under the same key, without mutating', () => {
  const Start = CriticalListFrom(NETWORK_KIND, [{ Name: 'en0' }]);
  const Added = WithCriticalEntry(NETWORK_KIND, Start, { Name: 'en1' });
  assert.equal(Added.Added, true);
  assert.deepEqual(
    Added.List.map((E) => E.Name),
    ['en0', 'en1']
  );
  const Replaced = WithCriticalEntry(NETWORK_KIND, Added.List, {
    Name: 'en0',
    Address: '10.0.0.5',
  });
  assert.equal(Replaced.Added, false);
  assert.equal(Replaced.List.length, 2);
  assert.equal(Replaced.List[0].Address, '10.0.0.5');
  assert.equal(Start.length, 1, 'the original list was mutated');
  assert.equal(WithCriticalEntry(NETWORK_KIND, Start, {}), null);
});

test('unmarking removes by normalised key and reports when nothing was there', () => {
  const List = CriticalListFrom(USB_SERIAL_KIND, [{ SerialNumber: 'abc' }]);
  assert.equal(HasCriticalEntry(USB_SERIAL_KIND, List, ' abc '), true);
  assert.deepEqual(WithoutCriticalEntry(USB_SERIAL_KIND, List, 'abc'), []);
  assert.equal(WithoutCriticalEntry(USB_SERIAL_KIND, List, 'zzz'), null);
  assert.equal(WithoutCriticalEntry(USB_SERIAL_KIND, List, ''), null);
});

test('a stored row projects onto its client, key and entry; a malformed one is skipped', () => {
  const Projected = ProjectCriticalRow(DISPLAY_KIND, { UUID: 'c1', DisplayID: 'edid:abc' });
  assert.equal(Projected.UUID, 'c1');
  assert.equal(Projected.Key, 'edid:abc');
  assert.equal(Projected.Entry.DisplayID, 'edid:abc');
  assert.equal(ProjectCriticalRow(DISPLAY_KIND, { DisplayID: 'edid:abc' }), null);
  assert.equal(ProjectCriticalRow(DISPLAY_KIND, { UUID: 'c1' }), null);
});

test('an application entry reads the same from a stored row and a client record', () => {
  const FromRow = normalizeCriticalApplicationEntry({
    UUID: 'c1',
    ApplicationKey: 'qlab',
    ApplicationName: 'QLab',
    Timestamp: 5,
    RequireForeground: 1,
    RequireResponding: 0,
  });
  const FromRecord = normalizeCriticalApplicationEntry({
    Name: 'QLab',
    Timestamp: 5,
    RequireForeground: true,
    RequireResponding: false,
  });
  assert.deepEqual(FromRow, FromRecord);
  assert.deepEqual(FromRow, {
    Name: 'QLab',
    Key: 'qlab',
    Timestamp: 5,
    RequireForeground: true,
    RequireResponding: false,
  });
});

test('an application row from before migration 57 is still judged for responding', () => {
  const Entry = normalizeCriticalApplicationEntry({ ApplicationKey: 'x', ApplicationName: 'X' });
  assert.equal(Entry.RequireResponding, true);
  assert.equal(Entry.RequireForeground, false);
});
