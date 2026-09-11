const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

const ACTIONS = {
  'power.on': { ID: 'power.on', Label: 'Power On', Icon: 'power', Group: 'Power' },
  'input.set': {
    ID: 'input.set',
    Label: 'Set Input',
    Icon: 'box-arrow-in-right',
    Group: 'Input',
    Params: [{ Key: 'Input', Label: 'Input', Type: 'string', Default: '' }],
  },
};

// A stand-in registry with one method that owns the two actions above.
function methodsMock() {
  return {
    Manager: {
      GetAction: (method, actionID) => (method === 'pjlink' ? ACTIONS[actionID] || null : null),
      NormalizeActionParams: (method, actionID, input) => {
        const action = method === 'pjlink' ? ACTIONS[actionID] : null;
        if (!action) return {};
        const out = {};
        for (const field of action.Params || []) {
          const value = input && input[field.Key];
          out[field.Key] = value == null || value === '' ? field.Default : String(value);
        }
        return out;
      },
      DescribeAction: (method, actionID, params) => {
        const action = method === 'pjlink' ? ACTIONS[actionID] : null;
        if (!action) return actionID;
        return params.Input ? `${action.Label} - ${params.Input}` : action.Label;
      },
    },
    // Key order must be deterministic or the same favourite would hash two ways.
    stableStringify: require('../dist/Modules/MonitoringMethods').stableStringify,
  };
}

// An in-memory stand-in for the MonitoringActionFavourites table, including the
// unique index that makes starring idempotent.
function dbMock(rows = []) {
  let nextID = rows.reduce((max, row) => Math.max(max, row.FavouriteID), 0) + 1;
  const deleted = [];
  return {
    rows,
    deleted,
    Manager: {
      All: async () => [null, rows.slice()],
      Run: async (sql, params) => {
        if (sql.includes('INSERT OR IGNORE INTO MonitoringActionFavourites')) {
          const [Method, ActionID, Params, Weight, Timestamp] = params;
          const clash = rows.find(
            (row) => row.Method === Method && row.ActionID === ActionID && row.Params === Params
          );
          if (clash) return [null, { lastID: clash.FavouriteID }];
          const row = { FavouriteID: nextID++, Method, ActionID, Params, Weight, Timestamp };
          rows.push(row);
          return [null, { lastID: row.FavouriteID }];
        }
        if (sql.includes('DELETE FROM MonitoringActionFavourites WHERE Method')) {
          const [Method, ActionID, Params] = params;
          for (let i = rows.length - 1; i >= 0; i--) {
            const row = rows[i];
            if (row.Method === Method && row.ActionID === ActionID && row.Params === Params) {
              deleted.push(row);
              rows.splice(i, 1);
            }
          }
          return [null, { changes: 1 }];
        }
        if (sql.includes('DELETE FROM MonitoringActionFavourites WHERE FavouriteID')) {
          const [ID] = params;
          for (let i = rows.length - 1; i >= 0; i--) {
            if (rows[i].FavouriteID === ID) {
              deleted.push(rows[i]);
              rows.splice(i, 1);
            }
          }
          return [null, { changes: 1 }];
        }
        return [null, { changes: 0 }];
      },
    },
  };
}

function load(db, events) {
  const modulePath = path.join(
    __dirname,
    '..',
    'dist',
    'Modules',
    'MonitoringActionFavourites',
    'index.js'
  );
  return loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => ({ error: () => {}, warn: () => {}, log: () => {} }) },
    '../DB': db,
    '../Broadcast': { Manager: { emit: (event, payload) => events.push([event, payload]) } },
    '../MonitoringMethods': methodsMock(),
    '../Utils': require('../dist/Modules/Utils'),
  }).Manager;
}

test('starring is idempotent, and unstarring removes exactly the starred row', async () => {
  const events = [];
  const db = dbMock();
  const Manager = load(db, events);
  await Manager.Init();

  const [err, list] = await Manager.Set('pjlink', 'power.on', {}, true);
  assert.equal(err, null);
  assert.equal(list.length, 1);
  assert.equal(list[0].Label, 'Power On');
  assert.equal(list[0].Icon, 'power');
  assert.equal(Manager.Has('pjlink', 'power.on', {}), true);
  assert.equal(events.filter(([e]) => e === 'SetFullMonitoringActionFavouriteList').length, 1);

  // The star is a toggle in a UI that may be several clicks ahead of the DB, so
  // setting a state it is already in must succeed quietly rather than duplicate.
  const [, again] = await Manager.Set('pjlink', 'power.on', {}, true);
  assert.equal(again.length, 1);
  assert.equal(db.rows.length, 1);
  assert.equal(events.filter(([e]) => e === 'SetFullMonitoringActionFavouriteList').length, 1);

  const [, removed] = await Manager.Set('pjlink', 'power.on', {}, false);
  assert.equal(removed.length, 0);
  assert.equal(Manager.Has('pjlink', 'power.on', {}), false);

  // Unstarring something that was never starred is equally quiet.
  const [unstarErr, still] = await Manager.Set('pjlink', 'power.on', {}, false);
  assert.equal(unstarErr, null);
  assert.equal(still.length, 0);
});

test('parameters are part of a favourite identity, so two inputs are two entries', async () => {
  const events = [];
  const db = dbMock();
  const Manager = load(db, events);
  await Manager.Init();

  await Manager.Set('pjlink', 'input.set', { Input: '31' }, true);
  await Manager.Set('pjlink', 'input.set', { Input: '32' }, true);
  const list = Manager.GetAll();
  assert.deepEqual(
    list.map((entry) => entry.Label),
    ['Set Input - 31', 'Set Input - 32']
  );
  assert.equal(Manager.Has('pjlink', 'input.set', { Input: '31' }), true);
  assert.equal(Manager.Has('pjlink', 'input.set', { Input: '99' }), false);

  // Unstarring one leaves the other alone.
  await Manager.Set('pjlink', 'input.set', { Input: '31' }, false);
  assert.deepEqual(
    Manager.GetAll().map((entry) => entry.Params.Input),
    ['32']
  );
});

test('parameters normalize before they become an identity', async () => {
  const events = [];
  const db = dbMock();
  const Manager = load(db, events);
  await Manager.Init();

  // A parameter the action never declared is not part of the identity, so it
  // cannot produce a second row that looks identical on the menu.
  await Manager.Set('pjlink', 'input.set', { Input: '31', Stray: 'x' }, true);
  await Manager.Set('pjlink', 'input.set', { Input: '31' }, true);
  assert.equal(db.rows.length, 1);
  assert.deepEqual(JSON.parse(db.rows[0].Params), { Input: '31' });
});

test('an unknown action is refused rather than stored as a dead menu entry', async () => {
  const events = [];
  const Manager = load(dbMock(), events);
  await Manager.Init();

  const [err] = await Manager.Set('pjlink', 'nope', {}, true);
  assert.match(err, /Unknown action/);
  const [methodErr] = await Manager.Set('not-a-method', 'power.on', {}, true);
  assert.match(methodErr, /Unknown action/);
});

test('a favourite whose action no longer exists is dropped at load', async () => {
  const events = [];
  const db = dbMock([
    {
      FavouriteID: 1,
      Method: 'pjlink',
      ActionID: 'power.on',
      Params: '{}',
      Weight: 1,
      Timestamp: 1,
    },
    // Left behind by a method that was renamed or removed in a later version.
    { FavouriteID: 2, Method: 'gone', ActionID: 'power.on', Params: '{}', Weight: 2, Timestamp: 1 },
  ]);
  const Manager = load(db, events);
  await Manager.Init();

  assert.deepEqual(
    Manager.GetAll().map((entry) => entry.FavouriteID),
    [1]
  );
  assert.deepEqual(
    db.deleted.map((row) => row.FavouriteID),
    [2]
  );
});
