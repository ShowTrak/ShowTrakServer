const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { startMockServer, sendJson } = require('../test-support/video-processor-http-mock');

// ProPresenter check against a local mock of the ProPresenter API, shaped from
// the official OpenAPI document (openapi.propresenter.com, "ProPresenter API 1.0").

function load() {
  return loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', 'propresenter.js'),
    {}
  );
}

const item = (name, index = 0) => ({ uuid: `uuid-${name}`, name, index });

function routes(overrides = {}) {
  return {
    '/version': {
      name: 'FOH Pro7',
      platform: 'mac',
      os_version: '15.1',
      host_description: 'ProPresenter 7.16',
      api_version: 'v1',
    },
    '/v1/status/audience_screens': true,
    '/v1/status/stage_screens': true,
    '/v1/look/current': { id: item('Live look'), screens: [] },
    '/v1/presentation/slide_index': {
      presentation_index: { index: 2, presentation_id: item('Sunday Service') },
    },
    '/v1/playlist/active': {
      presentation: { playlist: item('Sunday'), item: item('Sunday Service') },
      announcements: { playlist: null, item: null },
    },
    '/v1/status/layers': {
      video_input: false,
      media: true,
      slide: true,
      announcements: false,
      props: false,
      messages: false,
      audio: false,
    },
    '/v1/timers/current': [
      { id: item('Countdown'), time: '00:04:59', state: 'running' },
      { id: item('Sermon'), time: '00:00:00', state: 'stopped' },
    ],
    '/v1/stage/message': '',
    '/v1/clear/groups': [{ id: item('Clear Slides'), layers: ['presentation'] }],
    '/v1/looks': [{ id: item('Default') }, { id: item('Lyrics Only', 1) }],
    ...overrides,
  };
}

// Serves routes() for GET; a number value is sent as that bare status, a
// function is called as a handler. Anything else (PUTs, triggers) answers 204.
async function withPro(table, fn, { triggers = 204 } = {}) {
  const server = await startMockServer((req, res) => {
    const key = req.url.split('?')[0];
    if (req.method === 'GET' && Object.prototype.hasOwnProperty.call(table, key)) {
      const value = table[key];
      if (typeof value === 'function') return value(req, res);
      if (typeof value === 'number') {
        res.writeHead(value);
        return res.end();
      }
      return sendJson(res, 200, value);
    }
    const status = typeof triggers === 'function' ? triggers(req) : triggers;
    res.writeHead(status);
    return res.end();
  });
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

function target(port, settings = {}) {
  return { Address: '127.0.0.1', Settings: { Port: port, Timeout: 2000, ...settings } };
}

test('a healthy ProPresenter reads its state from the documented endpoints', async () => {
  const pro = load();
  await withPro(routes(), async (server) => {
    const r = await pro.Run(target(server.port));
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, undefined);
    assert.equal(r.HostDescription, 'ProPresenter 7.16');
    assert.equal(r.MachineName, 'FOH Pro7');
    assert.equal(r.AudienceScreens, true);
    assert.equal(r.StageScreens, true);
    assert.equal(r.Look, 'Live look');
    assert.equal(r.Presentation, 'Sunday Service');
    assert.equal(r.SlideIndex, 2);
    assert.equal(r.Playlist, 'Sunday');
    assert.deepEqual(r.Layers.slide, true);
    assert.equal(r.Timers.length, 2);
    assert.equal(r.StageMessage, null);
    assert.deepEqual(r.ClearGroups, ['Clear Slides']);
    assert.deepEqual(r.Looks, ['Default', 'Lyrics Only']);
    // The check never changes anything: every request is a GET.
    assert.ok(server.requests.every((q) => q.method === 'GET'));
  });
});

test('audience screens off is degraded by default; stage screens only when asked', async () => {
  const pro = load();
  const table = routes({
    '/v1/status/audience_screens': false,
    '/v1/status/stage_screens': false,
  });
  await withPro(table, async (server) => {
    const r = await pro.Run(target(server.port));
    assert.equal(r.Degraded, true);
    assert.equal(r.DegradedReason, 'Audience screens off');
    const both = await pro.Run(target(server.port, { CheckStageScreens: true }));
    assert.equal(both.DegradedReason, 'Audience screens off; Stage screens off');
    const none = await pro.Run(target(server.port, { CheckAudienceScreens: false }));
    assert.equal(none.Degraded, undefined);
  });
});

test('expected look and presentation compare without regard to case', async () => {
  const pro = load();
  await withPro(routes(), async (server) => {
    const ok = await pro.Run(
      target(server.port, { ExpectedLook: 'live LOOK', ExpectedPresentation: ' sunday service ' })
    );
    assert.equal(ok.Degraded, undefined);
    const bad = await pro.Run(
      target(server.port, { ExpectedLook: 'Lyrics Only', ExpectedPresentation: 'Wedding' })
    );
    assert.equal(
      bad.DegradedReason,
      'Look Live look (expected Lyrics Only); Presentation Sunday Service (expected Wedding)'
    );
  });
});

test('no active presentation is degraded only when one is expected', async () => {
  const pro = load();
  const table = routes({
    '/v1/presentation/slide_index': { presentation_index: null },
    '/v1/playlist/active': { presentation: { playlist: null, item: null } },
  });
  await withPro(table, async (server) => {
    const r = await pro.Run(target(server.port));
    assert.equal(r.Degraded, undefined);
    assert.equal(r.Presentation, null);
    const expected = await pro.Run(target(server.port, { ExpectedPresentation: 'Sunday Service' }));
    assert.equal(expected.DegradedReason, 'No presentation active (expected Sunday Service)');
  });
});

test('the active playlist item stands in when slide_index does not name the presentation', async () => {
  const pro = load();
  await withPro(routes({ '/v1/presentation/slide_index': 404 }), async (server) => {
    const r = await pro.Run(target(server.port, { ExpectedPresentation: 'Sunday Service' }));
    assert.equal(r.Degraded, undefined);
    assert.equal(r.Presentation, 'Sunday Service');
    assert.equal(r.SlideIndex, null);
  });
});

test('a 404 for /version (Network off) is offline with a hint', async () => {
  const pro = load();
  await withPro(
    {},
    async (server) => {
      const r = await pro.Run(target(server.port));
      assert.equal(r.Success, false);
      assert.match(r.Error, /HTTP 404/);
      assert.match(r.Error, /Enable Network/);
    },
    { triggers: 404 }
  );
});

test('a /version reply without the promised fields is not ProPresenter', async () => {
  const pro = load();
  await withPro(routes({ '/version': { name: 'something else' } }), async (server) => {
    const r = await pro.Run(target(server.port));
    assert.equal(r.Success, false);
    assert.match(r.Error, /not as the ProPresenter API/);
  });
});

test('malformed status replies leave readings empty instead of crashing', async () => {
  const pro = load();
  const table = routes({
    '/v1/status/audience_screens': 'yes please',
    '/v1/look/current': [1, 2, 3],
    '/v1/timers/current': { not: 'a list' },
    '/v1/status/layers': (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{broken');
    },
  });
  await withPro(table, async (server) => {
    const r = await pro.Run(target(server.port, { ExpectedLook: 'Live look' }));
    assert.equal(r.Success, true);
    assert.equal(r.Layers, null);
    assert.deepEqual(r.Timers, []);
    assert.equal(r.DegradedReason, 'Audience screen status not reported; Live look not reported');
  });
});

test('ProPresenter that stops answering mid-probe is offline within the budget', async () => {
  const pro = load();
  await withPro(routes({ '/v1/timers/current': () => {} }), async (server) => {
    const started = Date.now();
    const r = await pro.Run(target(server.port, { Timeout: 600 }));
    assert.equal(r.Success, false);
    assert.match(r.Error, /stopped answering/);
    assert.ok(Date.now() - started < 1500);
  });
});

test('nothing listening is offline', async () => {
  const port = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const r = await load().Run(target(port));
  assert.equal(r.Success, false);
  assert.match(r.Error, /ECONNREFUSED/);
});

// --- Actions -------------------------------------------------------------------

test('destructive actions are marked and their params have no default or clamp', () => {
  const pro = load();
  const byId = Object.fromEntries(pro.Actions.map((a) => [a.ID, a]));
  for (const id of [
    'clear.group',
    'clear.layer',
    'clear.all',
    'look.set',
    'audience.disable',
    'stage.disable',
  ]) {
    assert.equal(byId[id].Destructive, true, `${id} should be destructive`);
  }
  for (const id of ['cue.next', 'cue.previous', 'audience.enable', 'stage.enable']) {
    assert.ok(!byId[id].Destructive, `${id} should not be destructive`);
  }
  for (const a of pro.Actions) {
    for (const p of a.Params || []) {
      assert.equal(p.Default, undefined);
      assert.equal(p.Min, undefined);
      assert.equal(p.Max, undefined);
    }
  }
});

test('Next and Previous Cue use the documented trigger endpoints', async () => {
  const pro = load();
  await withPro(routes(), async (server) => {
    assert.deepEqual(await pro.RunAction(target(server.port), 'cue.next', {}), {
      Success: true,
      Detail: 'Next cue triggered',
    });
    await pro.RunAction(target(server.port), 'cue.previous', {});
    assert.deepEqual(
      server.requests.map((q) => `${q.method} ${q.url}`),
      ['GET /v1/trigger/next', 'GET /v1/trigger/previous']
    );
  });
});

test('Trigger Clear Group encodes the name and reports an unknown group', async () => {
  const pro = load();
  const triggers = (req) => (req.url.includes('Clear%20Slides') ? 204 : 404);
  await withPro(
    routes(),
    async (server) => {
      const ok = await pro.RunAction(target(server.port), 'clear.group', { Group: 'Clear Slides' });
      assert.deepEqual(ok, { Success: true, Detail: 'Clear group Clear Slides triggered' });
      assert.equal(server.requests[0].url, '/v1/clear/group/Clear%20Slides/trigger');
      const missing = await pro.RunAction(target(server.port), 'clear.group', { Group: 'Nope' });
      assert.equal(missing.Success, false);
      assert.match(missing.Error, /no clear group called "Nope"/);
      const blank = await pro.RunAction(target(server.port), 'clear.group', { Group: '  ' });
      assert.equal(blank.Success, false);
    },
    { triggers }
  );
});

test('Clear Layer accepts only the documented layers', async () => {
  const pro = load();
  await withPro(routes(), async (server) => {
    const ok = await pro.RunAction(target(server.port), 'clear.layer', { Layer: 'Video Input' });
    assert.deepEqual(ok, { Success: true, Detail: 'Video input layer cleared' });
    assert.equal(server.requests[0].url, '/v1/clear/layer/video_input');
    const bad = await pro.RunAction(target(server.port), 'clear.layer', { Layer: 'everything' });
    assert.equal(bad.Success, false);
    assert.match(bad.Error, /Choose a layer/);
    assert.equal(server.requests.length, 1, 'an invalid layer sends nothing');
  });
});

test('Clear All clears each documented layer and reports a partial failure', async () => {
  const pro = load();
  await withPro(routes(), async (server) => {
    const r = await pro.RunAction(target(server.port), 'clear.all', {});
    assert.deepEqual(r, { Success: true, Detail: 'All layers cleared' });
    assert.deepEqual(
      server.requests.map((q) => q.url),
      [
        '/v1/clear/layer/audio',
        '/v1/clear/layer/props',
        '/v1/clear/layer/messages',
        '/v1/clear/layer/announcements',
        '/v1/clear/layer/slide',
        '/v1/clear/layer/media',
        '/v1/clear/layer/video_input',
      ]
    );
  });
  const triggers = (req) => (req.url.endsWith('/messages') ? 500 : 204);
  await withPro(
    routes(),
    async (server) => {
      const r = await pro.RunAction(target(server.port), 'clear.all', {});
      assert.equal(r.Success, false);
      assert.match(r.Error, /^Cleared audio, props, but failed to clear messages/);
    },
    { triggers }
  );
});

test('Set Look triggers the named look', async () => {
  const pro = load();
  await withPro(routes(), async (server) => {
    const r = await pro.RunAction(target(server.port), 'look.set', { Look: 'Lyrics Only' });
    assert.deepEqual(r, { Success: true, Detail: 'Look set to Lyrics Only' });
    assert.equal(server.requests[0].url, '/v1/look/Lyrics%20Only/trigger');
  });
});

test('screen toggles PUT a JSON boolean to the status endpoints', async () => {
  const pro = load();
  await withPro(routes(), async (server) => {
    const off = await pro.RunAction(target(server.port), 'audience.disable', {});
    assert.deepEqual(off, { Success: true, Detail: 'Audience screens switched off' });
    await pro.RunAction(target(server.port), 'stage.enable', {});
    assert.deepEqual(
      server.requests.map((q) => [q.method, q.url, q.body]),
      [
        ['PUT', '/v1/status/audience_screens', 'false'],
        ['PUT', '/v1/status/stage_screens', 'true'],
      ]
    );
  });
});

test('an action against an unreachable ProPresenter fails with the socket error', async () => {
  const port = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const r = await load().RunAction(target(port), 'cue.next', {});
  assert.equal(r.Success, false);
  assert.match(r.Error, /ECONNREFUSED/);
});

test('an unknown action is refused', async () => {
  const r = await load().RunAction(target(1), 'macro.trigger', {});
  assert.equal(r.Success, false);
  assert.match(r.Error, /Unknown ProPresenter action/);
});

test('GetActionOptions offers the reported clear groups and looks', () => {
  const pro = load();
  assert.deepEqual(
    pro.GetActionOptions({ Success: true, ClearGroups: ['Clear Slides'], Looks: ['Default'] }),
    {
      Group: [{ value: 'Clear Slides', label: 'Clear Slides' }],
      Look: [{ value: 'Default', label: 'Default' }],
    }
  );
  assert.deepEqual(pro.GetActionOptions({ Success: false }), {});
  assert.deepEqual(pro.GetActionOptions(null), {});
});

test('DescribeAction binds the parameter into the label', () => {
  const pro = load();
  assert.equal(
    pro.DescribeAction('clear.group', { Group: 'Clear Slides' }),
    'Clear Group - Clear Slides'
  );
  assert.equal(pro.DescribeAction('clear.layer', { Layer: 'slide' }), 'Clear Slide');
  assert.equal(pro.DescribeAction('look.set', { Look: 'Default' }), 'Set Look - Default');
  assert.equal(pro.DescribeAction('clear.layer', { Layer: 'bogus' }), null);
  assert.equal(pro.DescribeAction('cue.next', {}), null);
});

// --- Debug ---------------------------------------------------------------------

test('Debug escapes every value ProPresenter sent', async () => {
  const pro = load();
  const evil = '<script>alert(1)</script>';
  const table = routes({
    '/version': {
      name: evil,
      platform: evil,
      os_version: evil,
      host_description: evil,
      api_version: evil,
    },
    '/v1/look/current': { id: item(evil) },
    '/v1/presentation/slide_index': {
      presentation_index: { index: 0, presentation_id: item(evil) },
    },
    '/v1/playlist/active': { presentation: { playlist: item(evil), item: item(evil) } },
    '/v1/timers/current': [{ id: item(evil), time: evil, state: evil }],
    '/v1/stage/message': evil,
  });
  await withPro(table, async (server) => {
    const t = target(server.port, { ExpectedLook: 'x' });
    const html = pro.Debug(await pro.Run(t), t);
    assert.ok(!html.includes('<script>'), 'raw markup must not reach the panel');
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  });
  const offline = pro.Debug({ Success: false, Error: '<b>boom</b>' }, { Address: '<x>' });
  assert.ok(!offline.includes('<b>boom') && !offline.includes('<x>'));
});

test('Debug shows the screens, look, presentation and timers', async () => {
  const pro = load();
  await withPro(routes(), async (server) => {
    const t = target(server.port);
    const html = pro.Debug(await pro.Run(t), t);
    assert.match(html, /Sunday Service \(cue 3\)/);
    assert.match(html, /Live look/);
    assert.match(html, /Slide, Media/);
    assert.match(html, /Countdown/);
    assert.match(html, /00:04:59/);
  });
});
