// Exercises the List view: the pure rules in src/UI/js/app/lib/list-view.ts and
// the list-only cells every tile now carries.
//
// What is at stake:
//   - the stored mode: an operator who had compact on must not be dropped back
//     into the full grid by an upgrade, and junk in localStorage must not leave
//     the page in no layout at all;
//   - the State column word must agree with the tile's colour class, or a red
//     row reads "Online";
//   - each row's history must be keyed by the tile's own data-uuid and built
//     the way the view modal builds it, or the row's graph and the modal it
//     opens disagree about the same hour;
//   - the history cell must be empty outside the list, so Grid and Compact do
//     not carry sixty hidden blocks per tile.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app');
const ListView = require(path.join(APP, 'lib', 'list-view.js'));
const ListCells = require(path.join(APP, 'list-view.js'));
const State = require(path.join(APP, 'state', 'index.js'));
const Monitoring = require(path.join(APP, 'monitoring.js'));
const FreeKiosk = require(path.join(APP, 'freekiosk.js'));

const MINUTE = 60 * 1000;
const NOW = 1_700_000_000_000;

// --- View mode -------------------------------------------------------------

test('only the three modes parse, case and whitespace aside', () => {
  assert.equal(ListView.ParseViewMode('list'), 'list');
  assert.equal(ListView.ParseViewMode(' Compact '), 'compact');
  for (const Junk of ['', 'table', null, undefined, 1, {}]) {
    assert.equal(ListView.ParseViewMode(Junk), null, String(Junk));
  }
});

test('the three-way setting wins over the legacy compact flag', () => {
  assert.equal(ListView.ResolveStoredViewMode('list', '1'), 'list');
  assert.equal(ListView.ResolveStoredViewMode('grid', '1'), 'grid');
});

test('an operator who had compact on before List existed stays in compact', () => {
  assert.equal(ListView.ResolveStoredViewMode(null, '1'), 'compact');
  assert.equal(ListView.ResolveStoredViewMode(null, '0'), 'grid');
  assert.equal(ListView.ResolveStoredViewMode(null, null), 'grid');
  assert.equal(ListView.ResolveStoredViewMode('garbage', null), 'grid');
});

test('the shortcut cycles in the order the switch shows them', () => {
  assert.equal(ListView.NextViewMode('grid'), 'compact');
  assert.equal(ListView.NextViewMode('compact'), 'list');
  assert.equal(ListView.NextViewMode('list'), 'grid');
});

test('the compact flag follows the view mode, for the SDK commands that read it', () => {
  State.setViewMode('compact');
  assert.equal(State.CompactMode, true);
  State.setViewMode('list');
  assert.equal(State.CompactMode, false);
  State.setViewMode('grid');
});

// --- State words -----------------------------------------------------------

test('a monitor reads Idle with no checks and Checking before the first lands', () => {
  assert.equal(ListView.MonitorListState({ CheckCount: 0 }), 'Idle');
  assert.equal(ListView.MonitorListState({ CheckCount: 2, LastChecked: null }), 'Checking');
});

test('a monitor with a verdict reads it, degraded winning over online', () => {
  const Checked = { CheckCount: 1, LastChecked: NOW };
  assert.equal(ListView.MonitorListState({ ...Checked, Online: true }), 'Online');
  assert.equal(ListView.MonitorListState({ ...Checked, Online: true, Degraded: true }), 'Degraded');
  assert.equal(ListView.MonitorListState({ ...Checked, Online: false }), 'Offline');
});

test('a dummy client reads its state, idle until its first heartbeat', () => {
  assert.equal(ListView.DummyListState({ State: 'IDLE' }), 'Idle');
  assert.equal(ListView.DummyListState({ State: 'ONLINE', Online: true }), 'Online');
  assert.equal(
    ListView.DummyListState({ State: 'ONLINE', Online: true, Degraded: true }),
    'Degraded'
  );
  assert.equal(ListView.DummyListState({ State: 'OFFLINE' }), 'Offline');
});

test('a FreeKiosk terminal reads its state', () => {
  assert.equal(ListView.FreeKioskListState({ State: 'ONLINE' }), 'Online');
  assert.equal(ListView.FreeKioskListState({ State: 'DEGRADED' }), 'Degraded');
  assert.equal(ListView.FreeKioskListState({ State: 'OFFLINE' }), 'Offline');
  assert.equal(ListView.FreeKioskListState({}), 'Idle');
});

// --- History column --------------------------------------------------------

const sample = (MinutesAgo, Online, Degraded = false) => ({
  ts: NOW - MinutesAgo * MINUTE,
  online: Online,
  degraded: Degraded,
  latencyMs: null,
});
const lastBlock = (Blocks) => Blocks[Blocks.length - 1];
const noEntities = { Clients: [], Monitors: [], Dummies: [], Kiosks: [] };

test('rows are keyed by the same ids the tiles carry as data-uuid', () => {
  const Blocks = ListView.BuildListHistoryBlocks(
    {},
    {
      Clients: [{ UUID: 'c1' }],
      Monitors: [{ TargetID: 4, Checks: [] }],
      Dummies: [{ UUID: 'd1' }],
      Kiosks: [{ UUID: 'k1' }],
    },
    NOW
  );
  assert.deepEqual([...Blocks.keys()].sort(), ['c1', 'dummy:d1', 'kiosk:k1', 'monitor:4']);
});

test('every row gets a full hour of blocks, grey where nothing was recorded', () => {
  const Blocks = ListView.BuildListHistoryBlocks(
    null,
    { ...noEntities, Clients: [{ UUID: 'c1' }] },
    NOW
  );
  const Row = Blocks.get('c1');
  assert.equal(Row.length, 60);
  assert.ok(Row.every((B) => B.state === 'IDLE'));
});

test('a client row is its own status series', () => {
  const Blocks = ListView.BuildListHistoryBlocks(
    { Clients: { c1: [sample(0.5, false)] } },
    { ...noEntities, Clients: [{ UUID: 'c1' }] },
    NOW
  );
  assert.equal(lastBlock(Blocks.get('c1')).state, 'OFFLINE');
});

test('a target row combines its checks, as the modal does', () => {
  // One check down, one up: the target is degraded, not offline.
  const Overview = { Checks: { 1: [sample(0.5, false)], 2: [sample(0.5, true)] } };
  const Monitor = { TargetID: 4, Checks: [{ CheckID: 1 }, { CheckID: 2 }] };
  const Blocks = ListView.BuildListHistoryBlocks(
    Overview,
    { ...noEntities, Monitors: [Monitor] },
    NOW
  );
  assert.equal(lastBlock(Blocks.get('monitor:4')).state, 'DEGRADED');

  const Both = { Checks: { 1: [sample(0.5, false)], 2: [sample(0.5, false)] } };
  const BothDown = ListView.BuildListHistoryBlocks(
    Both,
    { ...noEntities, Monitors: [Monitor] },
    NOW
  );
  assert.equal(lastBlock(BothDown.get('monitor:4')).state, 'OFFLINE');
});

test('a kiosk row carries a steady reading across the whole window', () => {
  // One stored sample from two hours ago: a flat run that is still running.
  const Overview = {
    Kiosks: { k1: [{ ts: NOW - 120 * MINUTE, ok: true, n: 20, s: null, breach: false }] },
  };
  const Blocks = ListView.BuildListHistoryBlocks(
    Overview,
    { ...noEntities, Kiosks: [{ UUID: 'k1' }] },
    NOW
  );
  assert.ok(Blocks.get('kiosk:k1').every((B) => B.state === 'ONLINE'));
});

// --- Tile cells ------------------------------------------------------------

test('a tile carries its checkbox, state word and history cell', () => {
  State.setViewMode('grid');
  const Html = FreeKiosk.RenderFreeKioskTile({
    UUID: 'k1',
    Nickname: 'Lobby',
    Address: '10.0.0.5',
    Port: 8080,
    State: 'DEGRADED',
    DegradedWarnings: [],
    Metrics: {},
  });
  assert.match(Html, /class="LIST_CHECK"/);
  assert.match(Html, /data-type="LIST_STATE">Degraded</);
  assert.match(Html, /class="LIST_HISTORY" data-history-key="kiosk:k1"><\/div>/);
});

test('the history cell is empty outside the list and a placeholder inside it', () => {
  State.setViewMode('compact');
  assert.equal(ListCells.ListHistoryCellHtml('c1'), '');
  State.setViewMode('list');
  assert.match(ListCells.ListHistoryCellHtml('c1'), /status-timeline is-pending/);
  State.setViewMode('grid');
});

test('the state word is escaped like everything else on the tile', () => {
  assert.match(ListCells.RenderListRowCells('x', '<b>'), /&lt;b&gt;/);
});

test('a pending device has no history cell to fill', () => {
  assert.ok(
    !ListCells.RenderListRowCells('p1', 'Discovered', { History: false }).includes('LIST_HISTORY')
  );
});

test('a monitor tile states the same verdict its colour shows', () => {
  State.setViewMode('grid');
  const Html = Monitoring.RenderMonitoringTargetTile({
    TargetID: 7,
    Nickname: 'Projector',
    Address: '10.0.0.9',
    CheckCount: 1,
    LastChecked: NOW,
    Online: false,
    Checks: [],
  });
  assert.match(Html, /data-type="LIST_STATE">Offline</);
  assert.match(Html, /data-history-key="monitor:7"/);
});

test('the list has one heading row, status first and the history last', () => {
  const Html = ListCells.RenderListTableHeader();
  const Columns = [...Html.matchAll(/data-list-column="([^"]+)"/g)].map((M) => M[1]);
  assert.deepEqual(Columns, ['state', 'name', 'type', 'address', 'detail', 'history']);
  // Group headers carry only their checkbox now; the labels live up here.
  assert.ok(!ListCells.RenderListGroupHeaderCells().includes('LIST_COLUMN_LABEL'));
});

// --- Check rows ------------------------------------------------------------

const check = (O = {}) => ({
  CheckID: 11,
  TargetID: 7,
  Name: 'Shutter',
  Address: '10.0.0.9',
  Method: 'pjlink',
  Weight: 0,
  LastChecked: NOW,
  Online: true,
  Degraded: false,
  LastLatencyMs: 4.4,
  LastError: null,
  ...O,
});

test('a check row is selected as check:<CheckID>', () => {
  assert.equal(ListView.CheckRowID(11), 'check:11');
});

test('a check reads Checking until its first probe, then its verdict', () => {
  assert.equal(ListView.MonitorCheckListState(check({ LastChecked: null })), 'Checking');
  assert.equal(ListView.MonitorCheckStateClass(check({ LastChecked: null })), 'IDLE');
  assert.equal(ListView.MonitorCheckListState(check()), 'Online');
  assert.equal(ListView.MonitorCheckStateClass(check()), 'ONLINE');
  assert.equal(ListView.MonitorCheckListState(check({ Degraded: true })), 'Degraded');
  assert.equal(ListView.MonitorCheckListState(check({ Online: false })), 'Offline');
  // Offline has no class: the base row is already the offline colour.
  assert.equal(ListView.MonitorCheckStateClass(check({ Online: false })), '');
});

test("a check's details are its latency while up and its reason while not", () => {
  assert.equal(ListView.MonitorCheckDetail(check()), '4ms');
  assert.equal(ListView.MonitorCheckDetail(check({ LastLatencyMs: 0.2 })), '<1ms');
  assert.equal(
    ListView.MonitorCheckDetail(check({ Online: false, LastError: ' Timed out ' })),
    'Timed out'
  );
  assert.equal(ListView.MonitorCheckDetail(check({ LastChecked: null })), '');
});

test("each check gets its own history beside its target's combined one", () => {
  const Overview = { Checks: { 11: [sample(0.5, false)], 12: [sample(0.5, true)] } };
  const Blocks = ListView.BuildListHistoryBlocks(
    Overview,
    { ...noEntities, Monitors: [{ TargetID: 7, Checks: [{ CheckID: 11 }, { CheckID: 12 }] }] },
    NOW
  );
  assert.equal(lastBlock(Blocks.get('check:11')).state, 'OFFLINE');
  assert.equal(lastBlock(Blocks.get('check:12')).state, 'ONLINE');
  assert.equal(lastBlock(Blocks.get('monitor:7')).state, 'DEGRADED');
});

test('a target renders a row per check, collapsed until expanded', () => {
  State.setViewMode('list');
  const Html = Monitoring.RenderMonitoringTargetTile({
    TargetID: 7,
    Nickname: 'Projector',
    Address: '10.0.0.9',
    CheckCount: 2,
    LastChecked: NOW,
    Online: true,
    Checks: [check(), check({ CheckID: 12, Name: 'Lamp', Weight: 1 })],
  });
  assert.match(Html, /class="LIST_EXPAND" data-target-id="7" aria-expanded="false"/);
  assert.match(Html, /title="Show 2 checks"/);
  const Rows = [...Html.matchAll(/class="SHOWTRAK_PC MONITOR_CHECK ([^"]*)" data-uuid="([^"]+)"/g)];
  assert.deepEqual(
    Rows.map((M) => M[2]),
    ['check:11', 'check:12']
  );
  assert.ok(Rows.every((M) => M[1].includes('is-collapsed')));
  // Never draggable on their own: a check moves with its target.
  assert.match(Html, /data-uuid="check:11"[^>]*draggable="false"/);
  assert.match(Html, /data-history-key="check:11"/);
  State.setViewMode('grid');
});

test('a target with no checks has nothing to expand', () => {
  const Html = Monitoring.RenderMonitoringTargetTile({
    TargetID: 8,
    Nickname: 'Idle',
    CheckCount: 0,
    Checks: [],
  });
  assert.ok(!Html.includes('LIST_EXPAND'));
  assert.ok(!Html.includes('MONITOR_CHECK'));
});

test('a selected target shows its checks as selected without selecting them', () => {
  State.setViewMode('list');
  State.setSelected(['monitor:7']);
  const Target = {
    TargetID: 7,
    Nickname: 'Projector',
    CheckCount: 2,
    LastChecked: NOW,
    Online: true,
    Checks: [check(), check({ CheckID: 12, Weight: 1 })],
  };
  const Held = [
    ...Monitoring.RenderMonitoringTargetTile(Target).matchAll(/MONITOR_CHECK ([^"]*)"/g),
  ];
  assert.equal(Held.length, 2);
  assert.ok(Held.every((M) => M[1].includes('PARENT_SELECTED')));
  // Display only: the check ids never join the selection, or an action would
  // run on the device once for the target and again for the check.
  assert.deepEqual(State.Selected, ['monitor:7']);

  State.setSelected([]);
  const Free = [
    ...Monitoring.RenderMonitoringTargetTile(Target).matchAll(/MONITOR_CHECK ([^"]*)"/g),
  ];
  assert.ok(Free.every((M) => !M[1].includes('PARENT_SELECTED')));
  State.setViewMode('grid');
});

test('a selected monitor, dummy or kiosk keeps its highlight through a re-render', () => {
  // Client tiles always did; these three dropped it on every full list push.
  State.setSelected(['monitor:7', 'kiosk:k1']);
  assert.match(
    Monitoring.RenderMonitoringTargetTile({ TargetID: 7, CheckCount: 0, Checks: [] }),
    /class="SHOWTRAK_PC MONITOR [^"]*SELECTED"/
  );
  assert.match(
    FreeKiosk.RenderFreeKioskTile({ UUID: 'k1', State: 'ONLINE', Metrics: {} }),
    /class="SHOWTRAK_PC FREEKIOSK ONLINE SELECTED"/
  );
  State.setSelected([]);
});
