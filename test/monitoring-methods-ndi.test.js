const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function loggerStub() {
  const noop = () => {};
  const logger = {
    log: noop,
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    success: noop,
    child: () => logger,
  };
  return { CreateLogger: () => logger };
}

// A controllable fake `bonjour-service` factory: no real network is touched. The
// test can drive the mDNS browser by emitting synthetic `up`/`down` service events,
// and the raw multicast-dns `response` stream (exposed at `instance.server.mdns`)
// that the shared browser taps for per-announcement freshness.
function fakeBonjour() {
  let upHandler = null;
  let downHandler = null;
  let responseHandler = null;
  const browser = {
    on(event, fn) {
      if (event === 'up') upHandler = fn;
      else if (event === 'down') downHandler = fn;
    },
    start() {},
    update() {},
    stop() {},
  };
  const mdns = {
    on(event, fn) {
      if (event === 'response') responseHandler = fn;
    },
    removeListener(event, fn) {
      if (event === 'response' && responseHandler === fn) responseHandler = null;
    },
  };
  const instance = {
    server: { mdns },
    find() {
      return browser;
    },
    destroy() {},
  };
  // Regular function (not arrow) so the production wrapper's `new Bonjour(...)` works.
  function factory() {
    return instance;
  }
  factory.emitUp = (svc) => upHandler && upHandler(svc);
  factory.emitDown = (svc) => downHandler && downHandler(svc);
  factory.emitResponse = (packet) => responseHandler && responseHandler(packet);
  return factory;
}

// A PTR re-announcement packet for one NDI source, as multicast-dns would surface.
function ndiPtrResponse(fqdn) {
  return { answers: [{ type: 'PTR', name: '_ndi._tcp.local', data: fqdn, ttl: 120 }] };
}

function loadNdi(bonjour) {
  return loadWithMocks(methodPath('_ndi-shared.js'), {
    'bonjour-service': { Bonjour: bonjour || fakeBonjour() },
    '../Logger': loggerStub(),
  });
}

// --- match logic (pure) ------------------------------------------------------

test('MatchesSource does case-insensitive substring matching in contains mode', () => {
  const { MatchesSource } = loadNdi()._internal;
  assert.equal(MatchesSource('STUDIO-PC (Camera 1)', 'camera 1', 'contains'), true);
  assert.equal(MatchesSource('STUDIO-PC (Camera 1)', 'CAMERA', 'contains'), true);
  assert.equal(MatchesSource('STUDIO-PC (Camera 1)', 'Camera 2', 'contains'), false);
});

test('MatchesSource requires a full case-insensitive match in exact mode', () => {
  const { MatchesSource } = loadNdi()._internal;
  assert.equal(MatchesSource('STUDIO-PC (Camera 1)', 'studio-pc (camera 1)', 'exact'), true);
  assert.equal(MatchesSource('STUDIO-PC (Camera 1)', 'Camera 1', 'exact'), false);
});

test('MatchesSource never matches an empty target', () => {
  const { MatchesSource } = loadNdi()._internal;
  assert.equal(MatchesSource('Anything', '', 'contains'), false);
  assert.equal(MatchesSource('Anything', '   ', 'exact'), false);
});

test('NormalizeMatchMode defaults to contains for anything but "exact"', () => {
  const { NormalizeMatchMode } = loadNdi()._internal;
  assert.equal(NormalizeMatchMode('exact'), 'exact');
  assert.equal(NormalizeMatchMode('contains'), 'contains');
  assert.equal(NormalizeMatchMode('nonsense'), 'contains');
  assert.equal(NormalizeMatchMode(undefined), 'contains');
});

// --- evaluation logic (pure) -------------------------------------------------

function source(name, lastSeenAt) {
  return { Name: name, LastSeenAt: lastSeenAt };
}

function baseParams(overrides = {}) {
  return {
    Snapshot: { Ready: true, Error: null, Sources: [] },
    SourceName: 'Camera 1',
    MatchMode: 'contains',
    GracePeriodMs: 8000,
    Now: 10000,
    ...overrides,
  };
}

test('EvaluateNdi is online when a matching source was seen within the grace window', () => {
  const { EvaluateNdi } = loadNdi()._internal;
  const res = EvaluateNdi(
    baseParams({
      Snapshot: { Ready: true, Error: null, Sources: [source('STUDIO-PC (Camera 1)', 8000)] },
    })
  );
  assert.equal(res.Success, true);
  assert.equal(res.Matched, true);
  assert.equal(res.MatchedName, 'STUDIO-PC (Camera 1)');
  assert.equal(res.LatencyMs, 2000); // Now - LastSeenAt
  assert.equal(res.VisibleCount, 1);
});

test('EvaluateNdi is offline with a source count when nothing matches', () => {
  const { EvaluateNdi } = loadNdi()._internal;
  const res = EvaluateNdi(
    baseParams({
      SourceName: 'Camera 9',
      Snapshot: {
        Ready: true,
        Error: null,
        Sources: [source('STUDIO-PC (Camera 1)', 9000), source('STUDIO-PC (Camera 2)', 9500)],
      },
    })
  );
  assert.equal(res.Success, false);
  assert.equal(res.Matched, false);
  assert.match(res.Error, /NDI source not found \(2 sources visible\)/);
  assert.equal(res.VisibleCount, 2);
});

test('EvaluateNdi ignores sources older than the grace window', () => {
  const { EvaluateNdi } = loadNdi()._internal;
  const res = EvaluateNdi(
    baseParams({
      Now: 20000,
      GracePeriodMs: 8000,
      Snapshot: { Ready: true, Error: null, Sources: [source('STUDIO-PC (Camera 1)', 1000)] },
    })
  );
  assert.equal(res.Success, false);
  assert.equal(res.VisibleCount, 0);
  assert.match(res.Error, /NDI source not found \(0 sources visible\)/);
});

test('EvaluateNdi reports browser-starting before the browser is ready', () => {
  const { EvaluateNdi } = loadNdi()._internal;
  const res = EvaluateNdi(baseParams({ Snapshot: { Ready: false, Error: null, Sources: [] } }));
  assert.equal(res.Success, false);
  assert.match(res.Error, /starting/);
});

test('EvaluateNdi surfaces a browser error', () => {
  const { EvaluateNdi } = loadNdi()._internal;
  const res = EvaluateNdi(
    baseParams({ Snapshot: { Ready: false, Error: 'EADDRINUSE', Sources: [] } })
  );
  assert.equal(res.Success, false);
  assert.match(res.Error, /EADDRINUSE/);
});

// --- Run() / config validation ----------------------------------------------

test('RunNdi rejects a missing source name', () => {
  const ndi = loadNdi();
  const res = ndi.RunNdi({ Address: '', Settings: { SourceName: '' } });
  assert.equal(res.Success, false);
  assert.match(res.Error, /No NDI source name/);
});

test('RunNdi reads the shared browser cache and reports online for a discovered source', () => {
  const bonjour = fakeBonjour();
  const ndi = loadNdi(bonjour);
  try {
    // First Run() lazily starts the browser and registers the mDNS handlers.
    const before = ndi.RunNdi({ Settings: { SourceName: 'Camera 1', MatchMode: 'contains' } });
    assert.equal(before.Success, false); // nothing discovered yet

    // A source appears on the network.
    bonjour.emitUp({ name: 'STUDIO-PC (Camera 1)', type: 'ndi', protocol: 'tcp' });

    const online = ndi.RunNdi({ Settings: { SourceName: 'Camera 1', MatchMode: 'contains' } });
    assert.equal(online.Success, true);
    assert.equal(online.MatchedName, 'STUDIO-PC (Camera 1)');
    assert.equal(online.VisibleCount, 1);

    // Exact mode against the short name should NOT match the full instance name.
    const exact = ndi.RunNdi({ Settings: { SourceName: 'Camera 1', MatchMode: 'exact' } });
    assert.equal(exact.Success, false);

    // The source goes away -> offline again.
    bonjour.emitDown({ name: 'STUDIO-PC (Camera 1)' });
    const offline = ndi.RunNdi({ Settings: { SourceName: 'Camera 1', MatchMode: 'contains' } });
    assert.equal(offline.Success, false);
    assert.match(offline.Error, /NDI source not found/);
  } finally {
    ndi._internal.NdiBrowser.Stop();
  }
});

test('RunNdi respects the grace period when reading the cache', () => {
  const bonjour = fakeBonjour();
  const ndi = loadNdi(bonjour);
  try {
    ndi.RunNdi({ Settings: { SourceName: 'Camera 1' } }); // start browser
    bonjour.emitUp({ name: 'STUDIO-PC (Camera 1)' });

    // A tiny grace window (clamped to the 1000ms floor) will still see the
    // just-announced source; the point is that Run wires the setting through.
    const res = ndi.RunNdi({ Settings: { SourceName: 'Camera 1', GracePeriodMs: 1 } });
    assert.equal(res.Success, true);
  } finally {
    ndi._internal.NdiBrowser.Stop();
  }
});

test('mDNS re-announcements keep a source fresh after the grace window (regression: bonjour up fires once)', () => {
  // bonjour emits `up` exactly once per source; without the raw response tap the
  // timestamp would freeze at discovery and the source would go stale forever.
  const bonjour = fakeBonjour();
  const ndi = loadNdi(bonjour);
  const { NdiBrowser } = ndi._internal;
  try {
    ndi.RunNdi({ Settings: { SourceName: 'Camera 1' } }); // start browser + tap
    // Discovery: bonjour reports the source with a real fqdn.
    bonjour.emitUp({ name: 'STUDIO-PC (Camera 1)', fqdn: 'STUDIO-PC (Camera 1)._ndi._tcp.local' });
    assert.equal(NdiBrowser.Snapshot().Sources.length, 1);
    const seenAtDiscovery = NdiBrowser.Snapshot().Sources[0].LastSeenAt;

    // A later re-announcement (from a periodic re-query) must refresh LastSeenAt,
    // even though bonjour does NOT re-emit `up`.
    bonjour.emitResponse(ndiPtrResponse('STUDIO-PC (Camera 1)._ndi._tcp.local'));
    const refreshed = NdiBrowser.Snapshot().Sources[0].LastSeenAt;
    assert.ok(refreshed >= seenAtDiscovery, 'timestamp should advance on re-announcement');

    // And a re-announcement can resurrect a source the retention sweep dropped,
    // since bonjour would never re-emit `up` for it.
    NdiBrowser._testClearSources();
    assert.equal(NdiBrowser.Snapshot().Sources.length, 0);
    bonjour.emitResponse(ndiPtrResponse('STUDIO-PC (Camera 1)._ndi._tcp.local'));
    const recovered = NdiBrowser.Snapshot().Sources;
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].Name, 'STUDIO-PC (Camera 1)');
  } finally {
    NdiBrowser.Stop();
  }
});

test('the ndi-source method module exposes the expected contract', () => {
  const mod = loadWithMocks(methodPath('ndi-source.js'), {
    bonjour: fakeBonjour(),
    '../Logger': loggerStub(),
  });
  assert.equal(mod.ID, 'ndi-source');
  assert.equal(mod.Name, 'NDI Source Presence');
  assert.ok(Array.isArray(mod.Settings));
  const keys = mod.Settings.map((s) => s.Key);
  assert.deepEqual(keys, ['SourceName', 'MatchMode', 'GracePeriodMs']);
  const grace = mod.Settings.find((s) => s.Key === 'GracePeriodMs');
  assert.equal(grace.Advanced, true);
  assert.equal(grace.Default, 8000);
  const mode = mod.Settings.find((s) => s.Key === 'MatchMode');
  assert.equal(mode.Type, 'select');
  assert.equal(mode.Default, 'contains');
  assert.equal(typeof mod.Run, 'function');
  assert.equal(typeof mod.Debug, 'function');
});
