const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { startMockServer, sendJson } = require('../test-support/video-processor-http-mock');

function load() {
  return loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', 'barco-eventmaster.js'),
    {}
  );
}

// Shapes from Barco "JSON RPC for Encore3 Processors v10.0" (getFrameSettings,
// listSources) and the Companion module's powerStatus reader.
function frameSettings(cards = {}) {
  return {
    System: {
      id: 0,
      Name: 'System1',
      FrameCollection: {
        id: 0,
        Frame: {
          id: '74:fe:48:7f:22:30',
          Name: 'ENCORE3',
          Version: '10.0.0.b7e01ed8852.3640',
          OSVersion: '0.0.23',
          FrameType: 8,
          FrameTypeName: 'Encore3',
          Enet: { IP: '192.168.0.200', MacAddress: '74:fe:48:7f:22:30' },
          SysCard: {
            CardTypeLabel: 'MBoard',
            CardID: 0,
            CardStatusID: 2,
            CardStatusLabel: 'Ready',
            OverTemp: 0,
            FanWarn: 0,
            ...(cards.sys || {}),
          },
          Slot: [
            {
              Card: {
                CardStatusID: 2,
                CardStatusLabel: 'Ready',
                CardTypeLabel: 'HDMI 2.0 Input',
                CardID: 'Card1',
                OverTemp: 0,
                FanWarn: 0,
                ...(cards.slot1 || {}),
              },
            },
            {
              Card: {
                CardStatusID: 0,
                CardStatusLabel: 'Not Installed',
                CardTypeID: 255,
                CardTypeLabel: 'Unknown',
                CardID: 'Undefined',
              },
            },
          ],
        },
      },
    },
  };
}

const SOURCES = [
  {
    id: 0,
    Name: 'Camera',
    InputCfgIndex: 0,
    DestIndex: -1,
    UserKeyIndex: -1,
    Freeze: 0,
    InputCfgVideoStatus: 1,
  },
  {
    id: 1,
    Name: 'Laptop',
    InputCfgIndex: 1,
    DestIndex: -1,
    UserKeyIndex: -1,
    Freeze: 1,
    InputCfgVideoStatus: 4,
  },
  {
    id: 2,
    Name: 'Still1',
    InputCfgIndex: -1,
    StillIndex: 0,
    DestIndex: -1,
    UserKeyIndex: -1,
    Freeze: 0,
    InputCfgVideoStatus: 0,
  },
];

// listPresets reply shape from the Barco 8.2 guide.
const PRESETS = [
  { id: 0, Name: 'Walk In', LockMode: 0, presetSno: 1.0 },
  { id: 1, Name: 'Keynote', LockMode: 0, presetSno: 3.5 },
];

function device({
  frame = frameSettings(),
  power = { '74:fe:48:7f:22:30': { PowerSupply1Status: 3, PowerSupply2Status: 3 } },
  sources = SOURCES,
  presets = PRESETS,
  override = {},
} = {}) {
  return (req, res) => {
    const m = req.json && req.json.method;
    if (override[m]) return override[m](req, res);
    const reply = (response) =>
      sendJson(res, 200, { jsonrpc: '2.0', id: req.json.id, result: { success: 0, response } });
    if (m === 'getFrameSettings') return reply(frame);
    if (m === 'powerStatus') return reply(power);
    if (m === 'listSources') return reply(sources);
    if (m === 'listPresets') return reply(presets);
    if (m === 'activatePreset' || m === 'allTrans' || m === 'cut') return reply(null);
    return sendJson(res, 200, {
      jsonrpc: '2.0',
      id: req.json.id,
      error: { code: -32601, message: 'Method not found' },
    });
  };
}

async function withServer(handler, fn) {
  const server = await startMockServer(handler);
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

function target(port, settings = {}) {
  return { Address: '127.0.0.1', Settings: { Port: port, Timeout: 2000, ...settings } };
}

test('barco-eventmaster: ID and Name', () => {
  const M = load();
  assert.equal(M.ID, 'barco-eventmaster');
  assert.equal(M.Name, 'Barco Event Master');
});

test('barco-eventmaster: healthy processor, read-only JSON-RPC POSTs to /jsonrpc', async () => {
  const M = load();
  await withServer(device(), async (s) => {
    const R = await M.Run(target(s.port));
    assert.equal(R.Success, true);
    assert.equal(R.Degraded, undefined);
    assert.deepEqual(
      s.requests.map((r) => [r.method, r.url, r.json.method, r.json.jsonrpc]),
      [
        ['POST', '/jsonrpc', 'getFrameSettings', '2.0'],
        ['POST', '/jsonrpc', 'powerStatus', '2.0'],
        ['POST', '/jsonrpc', 'listSources', '2.0'],
        ['POST', '/jsonrpc', 'listPresets', '2.0'],
      ]
    );
    // listPresets asks for every preset, screen and aux.
    assert.deepEqual(s.requests[3].json.params, { ScreenDest: -1, AuxDest: -1 });
    assert.equal(R.SystemName, 'System1');
    assert.equal(R.FrameType, 'Encore3');
    assert.equal(R.Version, '10.0.0.b7e01ed8852.3640');
    assert.equal(R.Cards.length, 3);
    assert.equal(R.Supplies.length, 2);
    assert.equal(R.Sources.filter((x) => x.Live).length, 2);
  });
});

test('barco-eventmaster: over-temperature and fan warnings', async () => {
  const M = load();
  const frame = frameSettings({ slot1: { OverTemp: 1 }, sys: { FanWarn: 1 } });
  await withServer(device({ frame }), async (s) => {
    let R = await M.Run(target(s.port));
    assert.equal(R.Degraded, true);
    assert.match(R.DegradedReason, /HDMI 2.0 Input \(Card1\): over temperature/);
    assert.match(R.DegradedReason, /MBoard \(0\): fan warning/);
    R = await M.Run(target(s.port, { CheckHardware: false }));
    assert.equal(R.Degraded, undefined);
  });
});

test('barco-eventmaster: card status only when enabled, Not Installed ignored', async () => {
  const M = load();
  const frame = frameSettings({ slot1: { CardStatusID: 3, CardStatusLabel: 'Failed' } });
  await withServer(device({ frame }), async (s) => {
    let R = await M.Run(target(s.port));
    assert.equal(R.Degraded, undefined);
    R = await M.Run(target(s.port, { CheckCards: true }));
    assert.equal(R.Degraded, true);
    assert.equal(R.DegradedReason, 'HDMI 2.0 Input (Card1): Failed');
  });
});

test('barco-eventmaster: power supplies', async () => {
  const M = load();
  const power = { f1: { PowerSupply1Status: 3, PowerSupply2Status: 1 } };
  await withServer(device({ power }), async (s) => {
    const R = await M.Run(target(s.port));
    assert.equal(R.Degraded, true);
    assert.equal(R.DegradedReason, 'Power supply 2: No AC');
  });
  const single = { f1: { PowerSupply1Status: 3, PowerSupply2Status: 0 } };
  await withServer(device({ power: single }), async (s) => {
    let R = await M.Run(target(s.port));
    assert.equal(R.Degraded, undefined);
    R = await M.Run(target(s.port, { RequireBothSupplies: true }));
    assert.equal(R.DegradedReason, 'Power supply 2: Not present');
  });
  const refused = {
    powerStatus: (req, res) =>
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: req.json.id,
        result: { success: 1, response: null },
      }),
  };
  await withServer(device({ override: refused }), async (s) => {
    let R = await M.Run(target(s.port));
    assert.equal(R.Success, true);
    assert.match(R.DegradedReason, /Power status: Request refused/);
    R = await M.Run(target(s.port, { CheckPower: false }));
    assert.equal(R.Degraded, undefined);
  });
});

test('barco-eventmaster: input signal and freeze', async () => {
  const M = load();
  await withServer(device(), async (s) => {
    let R = await M.Run(target(s.port, { CheckSignal: true }));
    assert.equal(R.Degraded, true);
    // The still (not a live input) is ignored.
    assert.equal(R.DegradedReason, 'Laptop: No signal');
    R = await M.Run(target(s.port, { CheckSignal: true, Sources: ['camera'] }));
    assert.equal(R.Degraded, undefined);
    R = await M.Run(target(s.port, { CheckSignal: true, Sources: ['Camera', 'Missing'] }));
    assert.equal(R.DegradedReason, 'Source "Missing": not found');
    R = await M.Run(target(s.port, { CheckFrozen: true }));
    assert.equal(R.DegradedReason, 'Laptop: frozen');
  });
});

test('barco-eventmaster: multi-frame FrameCollection array', async () => {
  const M = load();
  const a = frameSettings().System.FrameCollection.Frame;
  const b = { ...a, Name: 'E2-B', FrameTypeName: 'E2', Slot: [] };
  const frame = {
    System: {
      Name: 'Sys',
      FrameCollection: { Frame: [a, { ...b, SysCard: { ...a.SysCard, OverTemp: 1 } }] },
    },
  };
  await withServer(device({ frame }), async (s) => {
    const R = await M.Run(target(s.port));
    assert.equal(R.Frames.length, 2);
    assert.match(R.DegradedReason, /E2-B MBoard \(0\): over temperature/);
  });
});

test('barco-eventmaster: offline on refused, JSON-RPC error, wrong device and garbage', async () => {
  const M = load();
  const server = await startMockServer((_req, res) => sendJson(res, 200, {}));
  const port = server.port;
  await server.close();
  let R = await M.Run(target(port));
  assert.equal(R.Success, false);

  const rpcError = {
    getFrameSettings: (req, res) =>
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: req.json.id,
        error: { code: -32000, message: 'busy' },
      }),
  };
  await withServer(device({ override: rpcError }), async (s) => {
    R = await M.Run(target(s.port));
    assert.equal(R.Success, false);
    assert.match(R.Error, /JSON-RPC error: busy/);
  });
  await withServer(device({ frame: { Something: 'else' } }), async (s) => {
    R = await M.Run(target(s.port));
    assert.equal(R.Success, false);
    assert.match(R.Error, /not with Event Master/);
  });
  await withServer(
    (_req, res) => sendJson(res, 200, 'not json at all'),
    async (s) => {
      R = await M.Run(target(s.port));
      assert.equal(R.Success, false);
    }
  );
  await withServer(
    (_req, res) => sendJson(res, 404, {}),
    async (s) => {
      R = await M.Run(target(s.port));
      assert.equal(R.Success, false);
      assert.match(R.Error, /HTTP 404/);
    }
  );
});

test('barco-eventmaster: the timeout bounds the whole probe, not each call', async () => {
  const M = load();
  // Each reply takes 250ms; three calls need ~750ms, past the 500ms budget.
  const slow = device();
  await withServer(
    (req, res) => setTimeout(() => slow(req, res), 250),
    async (s) => {
      const Started = Date.now();
      const R = await M.Run(target(s.port, { Timeout: 500, CheckSignal: true }));
      assert.ok(Date.now() - Started < 900, 'capped near the budget');
      // The frame read made it; the later reads were cut off and surface as
      // degraded rather than silently passing.
      assert.equal(R.Success, true);
      assert.equal(R.Degraded, true);
      assert.match(R.DegradedReason, /timed out/i);
    }
  );
});

test('barco-eventmaster: Debug renders cards, supplies and sources, escaping values', async () => {
  const M = load();
  const sources = [{ ...SOURCES[0], Name: '<img src=x>' }];
  await withServer(device({ sources }), async (s) => {
    const R = await M.Run(target(s.port));
    const Html = M.Debug(R, target(s.port));
    assert.match(Html, /Encore3/);
    assert.match(Html, /Power supply 1/);
    assert.match(Html, /&lt;img src=x&gt;/);
    assert.doesNotMatch(Html, /<img/);
    assert.doesNotMatch(Html, /Not Installed/);
  });
  const Off = M.Debug({ Success: false, Error: 'ECONNREFUSED' }, { Address: '10.0.0.2' });
  assert.match(Off, /ECONNREFUSED/);
  assert.match(Off, /9999/);
});

test("barco-eventmaster: power keys in Barco's PwrStatus spelling are read too", async () => {
  const M = load();
  const power = { f1: { PwrStatus1: 3, PwrStatus2: 2 } };
  await withServer(device({ power }), async (s) => {
    const R = await M.Run(target(s.port));
    assert.equal(R.DegradedReason, 'Power supply 2: No DC');
  });
});

test('barco-eventmaster: a 404 on the frame read points at the path setting', async () => {
  const M = load();
  await withServer(
    (req, res) => sendJson(res, 404, 'Not Found'),
    async (s) => {
      const R = await M.Run(target(s.port));
      assert.equal(R.Success, false);
      assert.match(R.Error, /Path setting/);
    }
  );
});

test('barco-eventmaster: a failed preset list never degrades the check', async () => {
  const M = load();
  const refused = {
    listPresets: (req, res) =>
      sendJson(res, 200, { jsonrpc: '2.0', id: req.json.id, result: { success: 5 } }),
  };
  await withServer(device({ override: refused }), async (s) => {
    const R = await M.Run(target(s.port));
    assert.equal(R.Success, true);
    assert.equal(R.Degraded, undefined);
    assert.equal(R.Presets, null);
    assert.deepEqual(M.GetActionOptions(R), {});
  });
});

// --- Actions -----------------------------------------------------------------

test('barco-eventmaster: action set and Destructive flags', () => {
  const M = load();
  const byId = Object.fromEntries(M.Actions.map((a) => [a.ID, a]));
  assert.deepEqual(Object.keys(byId), [
    'preset.preview',
    'preset.program',
    'transition.take',
    'transition.cut',
  ]);
  // Preview changes nothing the audience sees, so it needs no confirmation.
  assert.ok(!byId['preset.preview'].Destructive);
  for (const id of ['preset.program', 'transition.take', 'transition.cut']) {
    assert.equal(byId[id].Destructive, true, id);
  }
  for (const a of M.Actions) assert.ok(!a.AllowedWhileOffline, a.ID);
  // The preset is the only param, so the trailing OSC value fills it.
  for (const id of ['preset.preview', 'preset.program']) {
    assert.deepEqual(
      byId[id].Params.map((p) => p.Key),
      ['Preset'],
      id
    );
  }
  const SuperPassword = M.Settings.find((f) => f.Key === 'SuperPassword');
  assert.equal(SuperPassword.Sensitive, true);
});

test('barco-eventmaster: preset choices come from listPresets', async () => {
  const M = load();
  await withServer(device(), async (s) => {
    const R = await M.Run(target(s.port));
    assert.deepEqual(M.GetActionOptions(R), {
      Preset: [
        { value: '1.00', label: '1.00 · Walk In' },
        { value: '3.50', label: '3.50 · Keynote' },
      ],
    });
  });
});

test('barco-eventmaster: Recall Preset sends activatePreset by number or name', async () => {
  const M = load();
  await withServer(device(), async (s) => {
    let r = await M.RunAction(target(s.port), 'preset.preview', { Preset: '3.50' });
    assert.deepEqual(r, { Success: true, Detail: 'Preset 3.50 recalled to Preview' });
    r = await M.RunAction(target(s.port), 'preset.program', { Preset: 'Keynote' });
    assert.deepEqual(r, { Success: true, Detail: 'Preset "Keynote" recalled to Program' });
    assert.deepEqual(
      s.requests.map((q) => [q.method, q.url, q.json.method, q.json.params]),
      [
        ['POST', '/jsonrpc', 'activatePreset', { presetSno: 3.5, type: 0 }],
        ['POST', '/jsonrpc', 'activatePreset', { presetName: 'Keynote', type: 1 }],
      ]
    );
  });
});

test('barco-eventmaster: Take and Cut send allTrans and cut', async () => {
  const M = load();
  await withServer(device(), async (s) => {
    assert.deepEqual(await M.RunAction(target(s.port), 'transition.take', {}), {
      Success: true,
      Detail: 'Take sent',
    });
    assert.deepEqual(await M.RunAction(target(s.port), 'transition.cut', {}), {
      Success: true,
      Detail: 'Cut sent',
    });
    assert.deepEqual(
      s.requests.map((q) => [q.json.method, q.json.params, q.json.jsonrpc]),
      [
        ['allTrans', {}, '2.0'],
        ['cut', {}, '2.0'],
      ]
    );
  });
});

test('barco-eventmaster: multi-operator settings add operatorId or the super password', async () => {
  const M = load();
  await withServer(device(), async (s) => {
    await M.RunAction(
      target(s.port, { OperatorMode: 'operator', OperatorId: 2 }),
      'preset.preview',
      { Preset: '1' }
    );
    await M.RunAction(
      target(s.port, { OperatorMode: 'super', SuperPassword: 'abc' }),
      'transition.take',
      {}
    );
    await M.RunAction(target(s.port, { OperatorMode: 'off', OperatorId: 2 }), 'transition.cut');
    assert.deepEqual(
      s.requests.map((q) => q.json.params),
      [{ presetSno: 1, type: 0, operatorId: 2 }, { password: 'abc' }, {}]
    );
  });
});

test('barco-eventmaster: bad params and refusals give specific errors', async () => {
  const M = load();
  await withServer(
    device({
      override: {
        activatePreset: (req, res) =>
          sendJson(res, 200, { jsonrpc: '2.0', id: req.json.id, result: { success: 2 } }),
        allTrans: (req, res) =>
          sendJson(res, 200, { jsonrpc: '2.0', id: req.json.id, result: { success: 7 } }),
      },
    }),
    async (s) => {
      let r = await M.RunAction(target(s.port), 'preset.preview', { Preset: '  ' });
      assert.deepEqual(r, { Success: false, Error: 'Enter a preset number or name' });
      r = await M.RunAction(target(s.port), 'preset.program', {});
      assert.deepEqual(r, { Success: false, Error: 'Enter a preset number or name' });
      assert.equal(s.requests.length, 0, 'invalid params never reach the processor');

      r = await M.RunAction(target(s.port), 'preset.program', { Preset: '9' });
      assert.equal(r.Success, false);
      assert.match(r.Error, /refused the recall \(code 2\)/);
      r = await M.RunAction(target(s.port), 'transition.take', {});
      assert.match(r.Error, /refused the take \(code 7\)/);
      r = await M.RunAction(target(s.port), 'nope', {});
      assert.match(r.Error, /Unknown Event Master action/);
    }
  );
  const r = await M.RunAction({ Address: '', Settings: {} }, 'transition.take', {});
  assert.deepEqual(r, { Success: false, Error: 'No address configured' });
});

test('barco-eventmaster: an unreachable processor fails the action', async () => {
  const M = load();
  const s = await startMockServer(() => {});
  const port = s.port;
  await s.close();
  const r = await M.RunAction(target(port), 'transition.cut', {});
  assert.equal(r.Success, false);
  assert.ok(r.Error);
});

test('barco-eventmaster: DescribeAction binds the preset and destination', () => {
  const M = load();
  assert.equal(
    M.DescribeAction('preset.program', { Preset: '3' }),
    'Recall Preset 3.00 to Program'
  );
  assert.equal(
    M.DescribeAction('preset.preview', { Preset: 'Walk In' }),
    'Recall Preset "Walk In" to Preview'
  );
  assert.equal(M.DescribeAction('preset.program', {}), null);
  assert.equal(M.DescribeAction('transition.take', {}), null);
});
