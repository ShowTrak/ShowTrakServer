// FreeKioskManager: CRUD, slugs, group ordering, and the fan-out of commands.
//
// Backed by an in-memory DB stub matching on SQL prefixes, the same shape the
// dummy-client manager tests use.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { startFreeKioskDevice } = require('./helpers/freekiosk-device');

function createLoggerStub() {
  return { debug: () => {}, error: () => {}, log: () => {}, warn: () => {} };
}

function createDbStub(rows = []) {
  return {
    rows,
    Manager: {
      All: async (sql) => {
        const text = String(sql);
        if (text.includes('FROM FreeKioskTerminals')) {
          return [null, rows.map((r) => ({ ...r }))];
        }
        // The slug service sweeps every client-namespace table; the rest are empty.
        return [null, []];
      },
      Run: async (sql, params) => {
        const text = String(sql);
        if (text.startsWith('INSERT INTO FreeKioskTerminals')) {
          rows.push({
            UUID: params[0],
            Nickname: params[1],
            Address: params[2],
            Port: params[3],
            ApiKey: params[4],
            Interval: params[5],
            TimeoutMs: params[6],
            Settings: params[7],
            GroupID: params[8],
            Weight: params[9],
            Slug: params[10],
            Timestamp: params[11],
          });
        } else if (text.startsWith('UPDATE FreeKioskTerminals SET Nickname')) {
          const row = rows.find((r) => r.UUID === params[7]);
          if (row) {
            row.Nickname = params[0];
            row.Address = params[1];
            row.Port = params[2];
            row.Interval = params[3];
            row.TimeoutMs = params[4];
            row.Settings = params[5];
            row.GroupID = params[6];
          }
        } else if (text.startsWith('UPDATE FreeKioskTerminals SET ApiKey')) {
          const row = rows.find((r) => r.UUID === params[1]);
          if (row) row.ApiKey = params[0];
        } else if (text.startsWith('UPDATE FreeKioskTerminals SET Slug')) {
          const row = rows.find((r) => r.UUID === params[1]);
          if (row) row.Slug = params[0];
        } else if (text.startsWith('UPDATE FreeKioskTerminals SET GroupID = ?, Weight')) {
          const row = rows.find((r) => r.UUID === params[2]);
          if (row) {
            row.GroupID = params[0];
            row.Weight = params[1];
          }
        } else if (text.startsWith('UPDATE FreeKioskTerminals SET GroupID = ? WHERE')) {
          const row = rows.find((r) => r.UUID === params[1]);
          if (row) row.GroupID = null;
        } else if (text.startsWith('DELETE FROM FreeKioskTerminals')) {
          const idx = rows.findIndex((r) => r.UUID === params[0]);
          if (idx !== -1) rows.splice(idx, 1);
        }
        return [null, { changes: 1 }];
      },
      RunWithoutDirtyTracking: async () => [null, { changes: 1 }],
    },
  };
}

function loadManager(dbStub, events) {
  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'FreeKioskManager', 'index.js');
  // The Slug service lives in a sibling module, so loadWithMocks (which only
  // clears the target module's own directory) will not reset it. Clear it here
  // so it re-binds to THIS test's DB stub rather than one an earlier test left.
  delete require.cache[require.resolve('../dist/Modules/Slug/index.js')];
  return loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => createLoggerStub() },
    '../DB': dbStub,
    '../Broadcast': { Manager: { emit: (...args) => events.push(args) } },
    '../Utils': require('../dist/Modules/Utils'),
  }).Manager;
}

async function withManager(run, rows = []) {
  const db = createDbStub(rows);
  const events = [];
  const Manager = loadManager(db, events);
  await Manager.Init();
  try {
    return await run(Manager, db, events);
  } finally {
    await Manager.Shutdown();
  }
}

// ---- Creation -------------------------------------------------------------

test('creates a terminal with sensible defaults', async () => {
  await withManager(async (Manager, db) => {
    const [err, terminal] = await Manager.Create({ Address: '192.168.1.50' });
    assert.equal(err, null);
    assert.equal(terminal.Address, '192.168.1.50');
    assert.equal(terminal.Port, 8080);
    assert.equal(terminal.Interval, 30000);
    assert.equal(terminal.TimeoutMs, 5000);
    assert.equal(terminal.Type, 'freekiosk');
    assert.equal(terminal.Version, 'FreeKiosk');
    // Unknown, not offline: nothing has been polled yet.
    assert.equal(terminal.State, 'IDLE');
    assert.equal(terminal.Online, false);
    assert.equal(db.rows.length, 1);
  });
});

test('a new terminal arms the not-displaying-content alarm and nothing else', async () => {
  await withManager(async (Manager) => {
    const [, terminal] = await Manager.Create({ Address: '10.0.0.5' });
    // A_ only: G_ keys are the per-section monitoring switches, and several are
    // on by default.
    const armed = Object.entries(terminal.Settings).filter(
      ([key, value]) => key.startsWith('A_') && key.endsWith('_On') && value === true
    );
    assert.deepEqual(
      armed.map(([key]) => key),
      ['A_content_displaying_On']
    );
  });
});

test('an address pasted out of a browser is reduced to a bare host', async () => {
  await withManager(async (Manager) => {
    const [err, terminal] = await Manager.Create({ Address: 'http://10.0.0.5:9999/kiosk' });
    assert.equal(err, null);
    // The scheme, the embedded port and the path all have to go: the port has
    // its own field, and a path left on the host corrupts every request line.
    assert.equal(terminal.Address, '10.0.0.5');
    assert.equal(terminal.Port, 8080);
  });
});

test('an unusable address is refused rather than stored', async () => {
  await withManager(async (Manager, db) => {
    for (const address of ['', '   ', 'not a host', 'http://']) {
      const [err] = await Manager.Create({ Address: address });
      assert.match(String(err), /valid IP address or hostname/i, JSON.stringify(address));
    }
    assert.equal(db.rows.length, 0);
  });
});

test('port, interval and timeout are clamped into their supported ranges', async () => {
  await withManager(async (Manager) => {
    const [, low] = await Manager.Create({
      Address: '10.0.0.1',
      Port: 0,
      Interval: 1,
      TimeoutMs: 1,
    });
    assert.equal(low.Port, 8080);
    assert.equal(low.Interval, 5000);
    assert.equal(low.TimeoutMs, 1000);

    const [, high] = await Manager.Create({
      Address: '10.0.0.2',
      Port: 999999,
      Interval: 10 ** 9,
      TimeoutMs: 10 ** 9,
    });
    assert.equal(high.Port, 8080);
    assert.equal(high.Interval, 300000);
    assert.equal(high.TimeoutMs, 30000);
  });
});

// ---- The API key ----------------------------------------------------------

test('the API key is stored but never broadcast', async () => {
  // The snapshot crosses to the Web UI and is stringified into alert history, so
  // a key in it would leak far beyond the machine that holds the show file.
  await withManager(async (Manager, db) => {
    const [, terminal] = await Manager.Create({ Address: '10.0.0.5', ApiKey: 'secret-key' });
    assert.equal(terminal.HasApiKey, true);
    assert.equal(db.rows[0].ApiKey, 'secret-key');
    assert.ok(!JSON.stringify(terminal).includes('secret-key'));
  });
});

test('only the editor read carries the key, and only for one terminal at a time', async () => {
  // The editor has to show the key it is about to let you change, so GetForEditor
  // is the one deliberate exception to the rule above. It has to stay an
  // exception: Get and GetAll feed the tiles and the Web UI push.
  await withManager(async (Manager) => {
    const [, created] = await Manager.Create({ Address: '10.0.0.5', ApiKey: 'secret-key' });

    const [err, forEditor] = await Manager.GetForEditor(created.UUID);
    assert.equal(err, null);
    assert.equal(forEditor.ApiKey, 'secret-key');
    assert.equal(forEditor.HasApiKey, true);

    const [, plain] = await Manager.Get(created.UUID);
    assert.equal('ApiKey' in plain, false);
    const [, all] = await Manager.GetAll();
    assert.ok(!JSON.stringify(all).includes('secret-key'));

    const [missing, none] = await Manager.GetForEditor('no-such-uuid');
    assert.ok(missing);
    assert.equal(none, null);
  });
});

test('an edit that omits the API key leaves it alone', async () => {
  // The editor always sends the field, so this path is what protects any other
  // caller (the SDK, a future bulk edit) from wiping a key it never asked about.
  await withManager(async (Manager, db) => {
    const [, created] = await Manager.Create({ Address: '10.0.0.5', ApiKey: 'secret-key' });
    const [err, updated] = await Manager.Update(created.UUID, { Nickname: 'Renamed' });
    assert.equal(err, null);
    assert.equal(updated.Nickname, 'Renamed');
    assert.equal(updated.HasApiKey, true);
    assert.equal(db.rows[0].ApiKey, 'secret-key');
  });
});

test('clearing the API key takes an explicit flag', async () => {
  await withManager(async (Manager, db) => {
    const [, created] = await Manager.Create({ Address: '10.0.0.5', ApiKey: 'secret-key' });
    const [err, updated] = await Manager.Update(created.UUID, { ClearApiKey: true });
    assert.equal(err, null);
    assert.equal(updated.HasApiKey, false);
    assert.equal(db.rows[0].ApiKey, null);
  });
});

// ---- Slugs ----------------------------------------------------------------

test('a generated slug is derived from the nickname', async () => {
  await withManager(async (Manager) => {
    const [, terminal] = await Manager.Create({ Address: '10.0.0.5', Nickname: 'Lobby Kiosk' });
    assert.equal(terminal.Slug, 'Lobby-Kiosk');
  });
});

test('slugs stay unique within the shared client namespace', async () => {
  await withManager(async (Manager) => {
    const [, first] = await Manager.Create({ Address: '10.0.0.5', Nickname: 'Kiosk' });
    const [, second] = await Manager.Create({ Address: '10.0.0.6', Nickname: 'Kiosk' });
    assert.equal(first.Slug, 'Kiosk');
    assert.equal(second.Slug, 'Kiosk-2');

    const [err] = await Manager.Create({ Address: '10.0.0.7', Slug: 'Kiosk' });
    assert.match(String(err), /already in use/i);
  });
});

test('renaming a terminal to its own slug is not a collision', async () => {
  await withManager(async (Manager) => {
    const [, terminal] = await Manager.Create({ Address: '10.0.0.5', Nickname: 'Kiosk' });
    const [err, updated] = await Manager.Update(terminal.UUID, { Slug: 'Kiosk' });
    assert.equal(err, null);
    assert.equal(updated.Slug, 'Kiosk');
  });
});

test('terminals are addressable by slug, case-insensitively', async () => {
  await withManager(async (Manager) => {
    await Manager.Create({ Address: '10.0.0.5', Nickname: 'Lobby' });
    const found = await Manager.GetBySlug('lobby');
    assert.ok(found);
    assert.equal(found.Nickname, 'Lobby');
    assert.equal(await Manager.GetBySlug('nope'), null);
  });
});

test('rows without a slug are back-filled at boot', async () => {
  const rows = [
    {
      UUID: 'uuid-legacy',
      Nickname: 'Old Kiosk',
      Address: '10.0.0.9',
      Port: 8080,
      ApiKey: null,
      Interval: 30000,
      TimeoutMs: 5000,
      Settings: '{}',
      GroupID: null,
      Weight: 100,
      Slug: null,
      Timestamp: 1,
    },
  ];
  await withManager(async (Manager, db) => {
    await Manager.BackfillSlugs();
    assert.equal(db.rows[0].Slug, 'Old-Kiosk');
  }, rows);
});

// ---- Update / delete ------------------------------------------------------

test('settings round-trip through an update', async () => {
  await withManager(async (Manager) => {
    const [, created] = await Manager.Create({ Address: '10.0.0.5' });
    const [err, updated] = await Manager.Update(created.UUID, {
      Settings: { A_battery_level_On: true, A_battery_level_Op: 'below', A_battery_level_V: 25 },
    });
    assert.equal(err, null);
    assert.equal(updated.Settings.A_battery_level_On, true);
    assert.equal(updated.Settings.A_battery_level_V, 25);
    // A key the alarm schema does not declare must not be carried forward.
    assert.equal('A_not_a_metric_On' in updated.Settings, false);
  });
});

test('deleting removes the row and stops its loop', async () => {
  await withManager(async (Manager, db, events) => {
    const [, created] = await Manager.Create({ Address: '10.0.0.5' });
    const [err, ok] = await Manager.Delete(created.UUID);
    assert.equal(err, null);
    assert.equal(ok, true);
    assert.equal(db.rows.length, 0);
    const [, list] = await Manager.GetAll();
    assert.equal(list.length, 0);
    assert.ok(events.some(([name]) => name === 'FreeKioskTerminalListChanged'));
  });
});

test('operations on an unknown terminal fail cleanly', async () => {
  await withManager(async (Manager) => {
    for (const call of [
      () => Manager.Update('nope', {}),
      () => Manager.Delete('nope'),
      () => Manager.Capture('nope', 'screenshot'),
      () => Manager.GetCameraList('nope'),
    ]) {
      const [err] = await call();
      assert.match(String(err), /not found/i);
    }
    const [getErr, value] = await Manager.Get('nope');
    assert.match(String(getErr), /not found/i);
    assert.equal(value, null);
  });
});

// ---- Group ordering -------------------------------------------------------

test('terminals move between groups on the shared weight scale', async () => {
  await withManager(async (Manager, db) => {
    const [, created] = await Manager.Create({ Address: '10.0.0.5' });
    const [err] = await Manager.SetGroupAndWeight(created.UUID, 3, 20);
    assert.equal(err, null);
    assert.equal(db.rows[0].GroupID, 3);
    assert.equal(db.rows[0].Weight, 20);

    await Manager.MoveGroupToNoGroup(3);
    assert.equal(db.rows[0].GroupID, null);
  });
});

test('a terminal pointing at a deleted group is reconciled to no group', async () => {
  await withManager(async (Manager, db) => {
    const [, created] = await Manager.Create({ Address: '10.0.0.5' });
    await Manager.SetGroupAndWeight(created.UUID, 99, 10);
    await Manager.ReconcileOrphanedGroups([1, 2, 3]);
    assert.equal(db.rows[0].GroupID, null);
  });
});

// ---- Commands and captures ------------------------------------------------

test('an unknown command is refused before anything is sent', async () => {
  await withManager(async (Manager) => {
    const [, created] = await Manager.Create({ Address: '127.0.0.1' });
    for (const id of ['js', 'nope', '']) {
      const [err] = await Manager.SendCommand([created.UUID], id);
      assert.match(String(err), /unknown freekiosk command/i);
    }
  });
});

test('a command fans out and reports per-terminal results', async () => {
  const device = await startFreeKioskDevice({});
  try {
    await withManager(async (Manager) => {
      const [, good] = await Manager.Create({ Address: '127.0.0.1', Port: device.port });
      const [, bad] = await Manager.Create({ Address: '127.0.0.1', Port: 1 });

      const [err, summary] = await Manager.SendCommand([good.UUID, bad.UUID, 'ghost'], 'wake');
      assert.equal(err, null);
      assert.equal(summary.Total, 3);
      // One unreachable terminal must not stop the others being commanded.
      assert.equal(summary.Succeeded, 1);
      assert.equal(summary.Failed, 2);
      const ok = summary.Results.find((r) => r.UUID === good.UUID);
      assert.equal(ok.Success, true);
      assert.equal(ok.Error, null);
      assert.ok(summary.Results.find((r) => r.UUID === 'ghost').Error);
    });
  } finally {
    await device.close();
  }
});

test('a device with remote control disabled is recorded as such', async () => {
  const device = await startFreeKioskDevice({ allowControl: false });
  try {
    await withManager(async (Manager) => {
      const [, created] = await Manager.Create({ Address: '127.0.0.1', Port: device.port });
      const before = await Manager.Get(created.UUID);
      // Unknowable until something is sent — the device only reveals the setting
      // by refusing a command.
      assert.equal(before[1].ControlEnabled, null);

      const [, summary] = await Manager.SendCommand([created.UUID], 'wake');
      assert.equal(summary.Succeeded, 0);
      const after = await Manager.Get(created.UUID);
      assert.equal(after[1].ControlEnabled, false);
      assert.equal(after[1].Metrics.control_enabled, null);
    });
  } finally {
    await device.close();
  }
});

test('a successful command marks remote control as available', async () => {
  const device = await startFreeKioskDevice({});
  try {
    await withManager(async (Manager) => {
      const [, created] = await Manager.Create({ Address: '127.0.0.1', Port: device.port });
      await Manager.SendCommand([created.UUID], 'wake');
      const [, terminal] = await Manager.Get(created.UUID);
      assert.equal(terminal.ControlEnabled, true);
    });
  } finally {
    await device.close();
  }
});

test('a refused privileged command is reported as a failure', async () => {
  const device = await startFreeKioskDevice({ refuseCommands: true });
  try {
    await withManager(async (Manager) => {
      const [, created] = await Manager.Create({ Address: '127.0.0.1', Port: device.port });
      const [, summary] = await Manager.SendCommand([created.UUID], 'reboot');
      assert.equal(summary.Succeeded, 0);
      assert.equal(summary.Results[0].Error, 'Reboot requires Device Owner mode');
    });
  } finally {
    await device.close();
  }
});

test("a command the terminal's mode makes meaningless never reaches the device", async () => {
  // FreeKiosk answers a WebView command in app mode with executed:true and does
  // nothing — confirmed against a real device, where POSTing a URL in app mode
  // left webview.currentUrl untouched. Sending it anyway would have ShowTrak
  // report a success on the device's behalf that never happened, so the refusal
  // happens here and the request is never made at all.
  const device = await startFreeKioskDevice({});
  try {
    await withManager(async (Manager) => {
      const [, created] = await Manager.Create({
        Address: '127.0.0.1',
        Port: device.port,
        Settings: { DisplayMode: 'external_app', ModePackage: 'com.example.app' },
      });
      const before = device.requests.length;

      const [err, summary] = await Manager.SendCommand([created.UUID], 'reload');
      assert.equal(err, null);
      assert.equal(summary.Succeeded, 0);
      assert.match(String(summary.Results[0].Error), /does nothing.*External app mode/i);
      assert.equal(device.requests.length, before, 'nothing may be sent');
    });
  } finally {
    await device.close();
  }
});

test('the same command is sent when the terminal is in the mode it applies to', async () => {
  // The inverse of the test above — without it, a bug that refused everything
  // would look like correct behaviour.
  const device = await startFreeKioskDevice({});
  try {
    await withManager(async (Manager) => {
      const [, created] = await Manager.Create({
        Address: '127.0.0.1',
        Port: device.port,
        Settings: { DisplayMode: 'webview' },
      });
      const [, summary] = await Manager.SendCommand([created.UUID], 'reload');
      assert.equal(summary.Succeeded, 1);
      assert.ok(device.requests.some((R) => R.path === '/api/reload'));
    });
  } finally {
    await device.close();
  }
});

test('captures reach the renderer as data URLs', async () => {
  const device = await startFreeKioskDevice({ imageBytes: 64 });
  try {
    await withManager(async (Manager) => {
      const [, created] = await Manager.Create({ Address: '127.0.0.1', Port: device.port });
      const [err, image] = await Manager.Capture(created.UUID, 'screenshot');
      assert.equal(err, null);
      assert.match(image.DataUrl, /^data:image\/png;base64,/);

      const [listErr, cameras] = await Manager.GetCameraList(created.UUID);
      assert.equal(listErr, null);
      assert.equal(cameras.length, 2);
    });
  } finally {
    await device.close();
  }
});

test('polling on demand fills in the readings and reports latency', async () => {
  const device = await startFreeKioskDevice({});
  try {
    await withManager(async (Manager) => {
      const [, created] = await Manager.Create({ Address: '127.0.0.1', Port: device.port });
      const [err, summary] = await Manager.RunNow([created.UUID]);
      assert.equal(err, null);
      assert.equal(summary.Succeeded, 1);

      const [, terminal] = await Manager.Get(created.UUID);
      assert.equal(terminal.Online, true);
      assert.equal(terminal.State, 'ONLINE');
      assert.equal(terminal.Metrics.battery_level, 87);
      assert.equal(terminal.Hostname, 'SM-T510');
      assert.equal(terminal.IP, '192.168.1.50');
      assert.ok(terminal.LastLatencyMs >= 0);
      assert.ok(terminal.LastSuccessAt > 0);
    });
  } finally {
    await device.close();
  }
});

test('a terminal that stops displaying content goes degraded on the shipped defaults', async () => {
  const device = await startFreeKioskDevice({
    status: { screen: { on: false, screensaverActive: false, brightness: 0 } },
  });
  try {
    await withManager(async (Manager) => {
      const [, created] = await Manager.Create({ Address: '127.0.0.1', Port: device.port });
      await Manager.RunNow([created.UUID]);
      const [, terminal] = await Manager.Get(created.UUID);
      assert.equal(terminal.Online, true);
      assert.equal(terminal.Degraded, true);
      assert.equal(terminal.State, 'DEGRADED');
      assert.deepEqual(terminal.DegradedWarnings, ['Displaying Content is No (expected Yes)']);
      assert.equal(terminal.Alarms[0].Key, 'content_displaying');
    });
  } finally {
    await device.close();
  }
});

test('turning that alarm off returns the terminal to online', async () => {
  const device = await startFreeKioskDevice({
    status: { screen: { on: false, screensaverActive: false } },
  });
  try {
    await withManager(async (Manager) => {
      const [, created] = await Manager.Create({ Address: '127.0.0.1', Port: device.port });
      await Manager.Update(created.UUID, { Settings: { A_content_displaying_On: false } });
      await Manager.RunNow([created.UUID]);
      const [, terminal] = await Manager.Get(created.UUID);
      assert.equal(terminal.Degraded, false);
      assert.equal(terminal.State, 'ONLINE');
    });
  } finally {
    await device.close();
  }
});

test('an unreachable terminal reads offline, not degraded', async () => {
  // Degraded means "answering, but something is wrong". With no data at all
  // there is nothing to judge, so it must be plainly offline.
  await withManager(async (Manager) => {
    const [, created] = await Manager.Create({ Address: '127.0.0.1', Port: 1, TimeoutMs: 1000 });
    await Manager.RunNow([created.UUID]);
    const [, terminal] = await Manager.Get(created.UUID);
    assert.equal(terminal.Online, false);
    assert.equal(terminal.Degraded, false);
    assert.equal(terminal.State, 'OFFLINE');
    assert.ok(terminal.LastError);
  });
});

test('readings are kept when a poll fails so the modal is not blank', async () => {
  const device = await startFreeKioskDevice({});
  let port;
  try {
    port = device.port;
    await withManager(async (Manager) => {
      const [, created] = await Manager.Create({ Address: '127.0.0.1', Port: port });
      await Manager.RunNow([created.UUID]);
      const [, healthy] = await Manager.Get(created.UUID);
      await device.close();

      await Manager.RunNow([created.UUID]);
      const [, terminal] = await Manager.Get(created.UUID);
      assert.equal(terminal.Online, false);
      // The last thing it said is more useful than a blank panel; LastSuccessAt
      // is what marks the readings stale, so the failed poll must not advance it
      // even though it did advance LastChecked.
      assert.equal(terminal.Metrics.battery_level, 87);
      assert.equal(terminal.LastSuccessAt, healthy.LastSuccessAt);
      assert.ok(terminal.LastChecked >= terminal.LastSuccessAt);
    });
  } finally {
    await device.close().catch(() => {});
  }
});

test('a reboot that drops the connection is reported as success, not a hang-up error', async () => {
  // A tablet that actually reboots tears down its HTTP server mid-response, so
  // the socket dies before an answer arrives. Reporting "socket hang up" there
  // marks the command failed precisely when it worked — and teaches an operator
  // to ignore the one error that would matter if it were real.
  const device = await startFreeKioskDevice({ hangUp: true });
  try {
    await withManager(async (Manager) => {
      const [, created] = await Manager.Create({ Address: '127.0.0.1', Port: device.port });
      const [err, summary] = await Manager.SendCommand([created.UUID], 'reboot');
      assert.equal(err, null);
      assert.equal(summary.Succeeded, 1);
      assert.equal(summary.Results[0].Error, null);
    });
  } finally {
    await device.close();
  }
});

test('the same dropped connection on an ordinary command is still a failure', async () => {
  // The exemption is narrow on purpose: only commands that expect to take the
  // connection down with them may treat a hang-up as success. A beep that loses
  // its connection genuinely failed.
  const device = await startFreeKioskDevice({ hangUp: true });
  try {
    await withManager(async (Manager) => {
      const [, created] = await Manager.Create({ Address: '127.0.0.1', Port: device.port });
      const [, summary] = await Manager.SendCommand([created.UUID], 'audio.beep');
      assert.equal(summary.Succeeded, 0);
      assert.match(String(summary.Results[0].Error), /closed the connection/i);
    });
  } finally {
    await device.close();
  }
});

test('a reboot the device refuses is still a failure, disconnect exemption or not', async () => {
  // Without Device Owner the device answers 200/success:true with executed:false
  // rather than dropping the connection. That path must stay a failure, or
  // Reboot could never report anything but success.
  const device = await startFreeKioskDevice({ refuseCommands: true });
  try {
    await withManager(async (Manager) => {
      const [, created] = await Manager.Create({ Address: '127.0.0.1', Port: device.port });
      const [, summary] = await Manager.SendCommand([created.UUID], 'reboot');
      assert.equal(summary.Succeeded, 0);
      assert.equal(summary.Results[0].Error, 'Reboot requires Device Owner mode');
    });
  } finally {
    await device.close();
  }
});
