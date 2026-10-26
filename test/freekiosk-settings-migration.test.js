// FreeKiosk condition settings across the change to stating conditions as
// expectations.
//
// Two things keep an old show file honest. Migration 59 converts the uptime
// threshold from seconds to days (and switches off uptime comparisons that no
// longer exist). ParseSettings then disarms any other condition stored with a
// comparison its metric stopped offering, because otherwise the old threshold
// would be judged by whatever comparison is left: a health check armed as
// "is overheat" would become "expected overheat" and alert on a good battery.
const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');

const Schema = require('../dist/Modules/DB/schema');
const { ParseSettings } = require('../dist/Modules/FreeKioskManager/normalize');
const { EvaluateAllAlarms } = require('../dist/Modules/FreeKiosk/alarms');

function migrate(rows) {
  const migration = Schema.Migrations.find((entry) => entry.Version === 59);
  const db = new sqlite3.Database(':memory:');
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('CREATE TABLE FreeKioskTerminals (UUID TEXT PRIMARY KEY, Settings TEXT)');
      for (const [uuid, settings] of rows) {
        db.run('INSERT INTO FreeKioskTerminals VALUES (?, ?)', [uuid, settings]);
      }
      db.run(migration.SQL, (err) => {
        if (err) return reject(err);
        db.all('SELECT UUID, Settings FROM FreeKioskTerminals ORDER BY UUID', (allErr, out) => {
          db.close();
          if (allErr) return reject(allErr);
          resolve(Object.fromEntries(out.map((row) => [row.UUID, row.Settings])));
        });
      });
    });
  });
}

test('migration 59 converts an uptime limit from seconds to days', async () => {
  const out = await migrate([
    [
      'a',
      JSON.stringify({
        A_device_uptime_On: true,
        A_device_uptime_Op: 'above',
        A_device_uptime_V: 604800,
      }),
    ],
  ]);
  assert.deepEqual(JSON.parse(out.a), { A_device_uptime_On: true, A_device_uptime_V: 7 });
});

test('migration 59 switches off uptime comparisons that no longer exist', async () => {
  const out = await migrate([
    [
      'a',
      JSON.stringify({
        A_device_uptime_On: true,
        A_device_uptime_Op: 'decreases',
        A_device_uptime_V: 0,
      }),
    ],
    [
      'b',
      JSON.stringify({
        A_device_uptime_On: false,
        A_device_uptime_Op: 'below',
        A_device_uptime_V: 60,
      }),
    ],
  ]);
  for (const key of ['a', 'b']) {
    assert.deepEqual(
      JSON.parse(out[key]),
      { A_device_uptime_On: false, A_device_uptime_V: 7 },
      key
    );
  }
});

test('migration 59 leaves other settings, other terminals and bad JSON alone', async () => {
  const other = JSON.stringify({ A_battery_level_On: true, A_battery_level_V: 20 });
  const out = await migrate([
    ['a', other],
    ['b', 'not json'],
    ['c', null],
    [
      'd',
      JSON.stringify({ G_Device_On: true, A_device_uptime_Op: 'above', A_device_uptime_V: 86400 }),
    ],
  ]);
  assert.equal(out.a, other);
  assert.equal(out.b, 'not json');
  assert.equal(out.c, null);
  assert.deepEqual(JSON.parse(out.d), { G_Device_On: true, A_device_uptime_V: 1 });
});

test('a condition stored with a withdrawn comparison is disarmed and reset', () => {
  // battery_health used to offer "is" (alert when it IS overheat). It now only
  // takes the expected state, so carrying "overheat" across would alarm on
  // every healthy battery.
  const settings = ParseSettings({
    G_Battery_On: true,
    A_battery_health_On: true,
    A_battery_health_Op: 'is',
    A_battery_health_V: 'overheat',
  });
  assert.equal(settings.A_battery_health_On, false);
  assert.equal(settings.A_battery_health_V, 'good');
  assert.equal(settings.A_battery_health_Op, undefined, 'a lone comparison stores no operator');
  assert.deepEqual(
    EvaluateAllAlarms({ battery_health: 'good' }, settings).filter((r) => r.Breach),
    []
  );
});

test('a withdrawn comparison on a metric that keeps a picker resets to its default', () => {
  const settings = ParseSettings({
    A_screen_brightness_On: true,
    A_screen_brightness_Op: 'inside',
    A_screen_brightness_V: 40,
    A_screen_brightness_V2: 60,
  });
  assert.equal(settings.A_screen_brightness_On, false);
  assert.equal(settings.A_screen_brightness_Op, 'below');
  assert.equal(settings.A_screen_brightness_V, 10);
});

test('a comparison still offered is kept exactly as stored', () => {
  const stored = {
    A_battery_plugged_On: true,
    A_battery_plugged_Op: 'is',
    A_battery_plugged_V: 'none',
  };
  assert.deepEqual(ParseSettings(stored), stored);
});
