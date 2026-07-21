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

// A controllable fake `bonjour-service` factory: no real network is touched.
// Unlike the NDI fake, Dante browses TWO service types off one instance, so the
// fake keeps a browser (and its handlers) per `find()` call and lets a test emit
// against a chosen service type.
function fakeBonjour() {
  const browsers = new Map(); // type -> { up, down }
  let responseHandler = null;

  function makeBrowser(type) {
    const handlers = { up: null, down: null };
    browsers.set(type, handlers);
    return {
      on(event, fn) {
        if (event === 'up') handlers.up = fn;
        else if (event === 'down') handlers.down = fn;
      },
      start() {},
      update() {},
      stop() {},
    };
  }

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
    find(opts) {
      return makeBrowser(opts.type);
    },
    destroy() {},
  };
  // Regular function (not arrow) so the production wrapper's `new Bonjour(...)` works.
  function factory() {
    return instance;
  }
  factory.emitUp = (type, svc) => {
    const h = browsers.get(type);
    if (h && h.up) h.up(svc);
  };
  factory.emitDown = (type, svc) => {
    const h = browsers.get(type);
    if (h && h.down) h.down(svc);
  };
  factory.emitResponse = (packet) => responseHandler && responseHandler(packet);
  return factory;
}

// A PTR re-announcement packet for one Dante device, as multicast-dns would surface.
function dantePtrResponse(fqdn, serviceFqdn) {
  return {
    answers: [
      { type: 'PTR', name: serviceFqdn || '_netaudio-arc._udp.local', data: fqdn, ttl: 120 },
    ],
  };
}

function loadDante(bonjour) {
  return loadWithMocks(methodPath('_dante-shared.js'), {
    'bonjour-service': { Bonjour: bonjour || fakeBonjour() },
    '../Logger': loggerStub(),
  });
}

// --- match logic (pure) ------------------------------------------------------

test('MatchesDevice does case-insensitive substring matching in contains mode', () => {
  const { MatchesDevice } = loadDante()._internal;
  assert.equal(MatchesDevice('Yamaha-QL5-Rack', 'ql5', 'contains'), true);
  assert.equal(MatchesDevice('Yamaha-QL5-Rack', 'YAMAHA', 'contains'), true);
  assert.equal(MatchesDevice('Yamaha-QL5-Rack', 'CL5', 'contains'), false);
});

test('MatchesDevice requires a full case-insensitive match in exact mode', () => {
  const { MatchesDevice } = loadDante()._internal;
  assert.equal(MatchesDevice('Yamaha-QL5-Rack', 'yamaha-ql5-rack', 'exact'), true);
  assert.equal(MatchesDevice('Yamaha-QL5-Rack', 'QL5', 'exact'), false);
});

test('MatchesDevice never matches an empty target', () => {
  const { MatchesDevice } = loadDante()._internal;
  assert.equal(MatchesDevice('Anything', '', 'contains'), false);
  assert.equal(MatchesDevice('Anything', '   ', 'exact'), false);
});

// --- fqdn / TXT parsing (pure) ----------------------------------------------

test('DeriveNameFromFqdn strips any known Dante service suffix', () => {
  const { DeriveNameFromFqdn } = loadDante()._internal;
  assert.equal(DeriveNameFromFqdn('AudioRack._netaudio-arc._udp.local'), 'AudioRack');
  assert.equal(DeriveNameFromFqdn('AudioRack._netaudio-cmc._udp.local.'), 'AudioRack');
  // Unknown suffix is left intact rather than being mangled.
  assert.equal(
    DeriveNameFromFqdn('AudioRack._something._tcp.local'),
    'AudioRack._something._tcp.local'
  );
});

test('ParseTxt lifts ARC and CMC keys and drops absent ones', () => {
  const { ParseTxt } = loadDante()._internal;
  const arc = ParseTxt({
    model: 'AVIO-2x2',
    router_vers: '4.2.1',
    rate: '48000',
    latency_ns: '1000000',
    router_info: 'Dante Via',
  });
  assert.equal(arc.Model, 'AVIO-2x2');
  assert.equal(arc.Firmware, '4.2.1');
  assert.equal(arc.SampleRate, 48000);
  assert.equal(arc.LatencyNs, 1000000);
  assert.equal(arc.RouterInfo, 'Dante Via');
  assert.equal(arc.Mac, undefined);

  const cmc = ParseTxt({ id: '001c25be39850000' });
  assert.equal(cmc.Mac, '001c25be39850000');
  assert.equal(cmc.Model, undefined);

  assert.deepEqual(ParseTxt(null), {});
});

test('ParseTxt coerces Buffer TXT values and ignores non-numeric numerics', () => {
  const { ParseTxt } = loadDante()._internal;
  const info = ParseTxt({ model: Buffer.from('AVIO-2x2'), rate: 'not-a-number' });
  assert.equal(info.Model, 'AVIO-2x2');
  assert.equal(info.SampleRate, undefined);
});

test('FormatSampleRate and FormatDanteLatency render operator-facing units', () => {
  const { FormatSampleRate, FormatDanteLatency } = loadDante()._internal;
  assert.equal(FormatSampleRate(48000), '48 kHz');
  assert.equal(FormatSampleRate(44100), '44.1 kHz');
  assert.equal(FormatSampleRate(0), '—');
  assert.equal(FormatDanteLatency(1000000), '1 ms');
  assert.equal(FormatDanteLatency(250000), '0.25 ms');
  assert.equal(FormatDanteLatency('nope'), '—');
});

// --- evaluation logic (pure) -------------------------------------------------

function device(name, lastSeenAt, info) {
  return { Name: name, LastSeenAt: lastSeenAt, Services: ['arc'], Info: info || {} };
}

function baseParams(overrides = {}) {
  return {
    Snapshot: { Ready: true, Error: null, Devices: [] },
    DeviceName: 'AudioRack',
    MatchMode: 'contains',
    GracePeriodMs: 8000,
    Now: 10000,
    ...overrides,
  };
}

test('EvaluateDante is online when a matching device was seen within the grace window', () => {
  const { EvaluateDante } = loadDante()._internal;
  const res = EvaluateDante(
    baseParams({
      Snapshot: {
        Ready: true,
        Error: null,
        Devices: [device('AudioRack-FOH', 8000, { Model: 'AVIO-2x2' })],
      },
    })
  );
  assert.equal(res.Success, true);
  assert.equal(res.Matched, true);
  assert.equal(res.MatchedName, 'AudioRack-FOH');
  assert.equal(res.MatchedInfo.Model, 'AVIO-2x2');
  assert.equal(res.LatencyMs, 2000); // Now - LastSeenAt
  assert.equal(res.VisibleCount, 1);
});

test('EvaluateDante is offline with a device count when nothing matches', () => {
  const { EvaluateDante } = loadDante()._internal;
  const res = EvaluateDante(
    baseParams({
      DeviceName: 'Monitors',
      Snapshot: {
        Ready: true,
        Error: null,
        Devices: [device('AudioRack-FOH', 9000), device('AudioRack-Stage', 9500)],
      },
    })
  );
  assert.equal(res.Success, false);
  assert.equal(res.Matched, false);
  assert.match(res.Error, /Dante device not found \(2 devices visible\)/);
  assert.equal(res.VisibleCount, 2);
});

test('EvaluateDante ignores devices older than the grace window', () => {
  const { EvaluateDante } = loadDante()._internal;
  const res = EvaluateDante(
    baseParams({
      Now: 20000,
      GracePeriodMs: 8000,
      Snapshot: { Ready: true, Error: null, Devices: [device('AudioRack-FOH', 1000)] },
    })
  );
  assert.equal(res.Success, false);
  assert.equal(res.VisibleCount, 0);
  assert.match(res.Error, /Dante device not found \(0 devices visible\)/);
});

test('EvaluateDante reports browser-starting before the browser is ready', () => {
  const { EvaluateDante } = loadDante()._internal;
  const res = EvaluateDante(baseParams({ Snapshot: { Ready: false, Error: null, Devices: [] } }));
  assert.equal(res.Success, false);
  assert.match(res.Error, /starting/);
});

test('EvaluateDante surfaces a browser error', () => {
  const { EvaluateDante } = loadDante()._internal;
  const res = EvaluateDante(
    baseParams({ Snapshot: { Ready: false, Error: 'EADDRINUSE', Devices: [] } })
  );
  assert.equal(res.Success, false);
  assert.match(res.Error, /EADDRINUSE/);
});

// --- Run() / config validation ----------------------------------------------

test('RunDante rejects a missing device name', () => {
  const dante = loadDante();
  const res = dante.RunDante({ Address: '', Settings: { DeviceName: '' } });
  assert.equal(res.Success, false);
  assert.match(res.Error, /No Dante device name/);
});

test('RunDante reads the shared browser cache and reports online for a discovered device', () => {
  const bonjour = fakeBonjour();
  const dante = loadDante(bonjour);
  try {
    // First Run() lazily starts the browsers and registers the mDNS handlers.
    const before = dante.RunDante({ Settings: { DeviceName: 'AudioRack', MatchMode: 'contains' } });
    assert.equal(before.Success, false); // nothing discovered yet

    bonjour.emitUp('netaudio-arc', {
      name: 'AudioRack-FOH',
      fqdn: 'AudioRack-FOH._netaudio-arc._udp.local',
      txt: { model: 'AVIO-2x2', rate: '48000' },
    });

    const online = dante.RunDante({ Settings: { DeviceName: 'AudioRack', MatchMode: 'contains' } });
    assert.equal(online.Success, true);
    assert.equal(online.MatchedName, 'AudioRack-FOH');
    assert.equal(online.MatchedInfo.Model, 'AVIO-2x2');
    assert.equal(online.VisibleCount, 1);

    // Exact mode against a substring should NOT match the full device name.
    const exact = dante.RunDante({ Settings: { DeviceName: 'AudioRack', MatchMode: 'exact' } });
    assert.equal(exact.Success, false);

    // The device goes away -> offline again.
    bonjour.emitDown('netaudio-arc', { name: 'AudioRack-FOH' });
    const offline = dante.RunDante({ Settings: { DeviceName: 'AudioRack' } });
    assert.equal(offline.Success, false);
    assert.match(offline.Error, /Dante device not found/);
  } finally {
    dante._internal.DanteBrowser.Stop();
  }
});

test('a device seen on both ARC and CMC collapses into one record with merged TXT', () => {
  const bonjour = fakeBonjour();
  const dante = loadDante(bonjour);
  const { DanteBrowser } = dante._internal;
  try {
    dante.RunDante({ Settings: { DeviceName: 'AudioRack' } }); // start browsers

    // ARC carries model/rate; CMC carries the MAC. Same device, two services.
    bonjour.emitUp('netaudio-arc', {
      name: 'AudioRack-FOH',
      txt: { model: 'AVIO-2x2', rate: '48000' },
    });
    bonjour.emitUp('netaudio-cmc', {
      name: 'AudioRack-FOH',
      txt: { id: '001c25be39850000' },
    });

    const devices = DanteBrowser.Snapshot().Devices;
    assert.equal(devices.length, 1, 'both service types must merge into one device');
    assert.equal(devices[0].Info.Model, 'AVIO-2x2');
    assert.equal(devices[0].Info.SampleRate, 48000);
    assert.equal(devices[0].Info.Mac, '001c25be39850000', 'CMC TXT must not clobber ARC TXT');
    assert.deepEqual(devices[0].Services, ['arc', 'cmc']);
  } finally {
    DanteBrowser.Stop();
  }
});

test('a goodbye on one service type does not evict a device still visible on the other', () => {
  const bonjour = fakeBonjour();
  const dante = loadDante(bonjour);
  const { DanteBrowser } = dante._internal;
  try {
    dante.RunDante({ Settings: { DeviceName: 'AudioRack' } });
    bonjour.emitUp('netaudio-arc', { name: 'AudioRack-FOH', txt: { model: 'AVIO-2x2' } });
    bonjour.emitUp('netaudio-cmc', { name: 'AudioRack-FOH', txt: { id: 'aabb' } });

    // ARC says goodbye; CMC is still announcing, so the device stays present.
    bonjour.emitDown('netaudio-arc', { name: 'AudioRack-FOH' });
    let devices = DanteBrowser.Snapshot().Devices;
    assert.equal(devices.length, 1, 'device must survive a goodbye on one service type');
    assert.deepEqual(devices[0].Services, ['cmc']);

    // CMC goes too -> now it is genuinely gone.
    bonjour.emitDown('netaudio-cmc', { name: 'AudioRack-FOH' });
    devices = DanteBrowser.Snapshot().Devices;
    assert.equal(devices.length, 0);
  } finally {
    DanteBrowser.Stop();
  }
});

test('device identity is case-insensitive so the same device never double-lists', () => {
  const bonjour = fakeBonjour();
  const dante = loadDante(bonjour);
  const { DanteBrowser } = dante._internal;
  try {
    dante.RunDante({ Settings: { DeviceName: 'AudioRack' } });
    bonjour.emitUp('netaudio-arc', { name: 'AudioRack-FOH' });
    bonjour.emitUp('netaudio-cmc', { name: 'audiorack-foh' });
    assert.equal(DanteBrowser.Snapshot().Devices.length, 1);
  } finally {
    DanteBrowser.Stop();
  }
});

test('RunDante respects the grace period when reading the cache', () => {
  const bonjour = fakeBonjour();
  const dante = loadDante(bonjour);
  try {
    dante.RunDante({ Settings: { DeviceName: 'AudioRack' } }); // start browsers
    bonjour.emitUp('netaudio-arc', { name: 'AudioRack-FOH' });

    // A tiny grace window (clamped to the 1000ms floor) will still see the
    // just-announced device; the point is that Run wires the setting through.
    const res = dante.RunDante({ Settings: { DeviceName: 'AudioRack', GracePeriodMs: 1 } });
    assert.equal(res.Success, true);
  } finally {
    dante._internal.DanteBrowser.Stop();
  }
});

test('mDNS re-announcements keep a device fresh after the grace window (regression: bonjour up fires once)', () => {
  // bonjour emits `up` exactly once per service; without the raw response tap the
  // timestamp would freeze at discovery and the device would go stale forever.
  const bonjour = fakeBonjour();
  const dante = loadDante(bonjour);
  const { DanteBrowser } = dante._internal;
  try {
    dante.RunDante({ Settings: { DeviceName: 'AudioRack' } }); // start browsers + tap
    bonjour.emitUp('netaudio-arc', {
      name: 'AudioRack-FOH',
      fqdn: 'AudioRack-FOH._netaudio-arc._udp.local',
    });
    assert.equal(DanteBrowser.Snapshot().Devices.length, 1);
    const seenAtDiscovery = DanteBrowser.Snapshot().Devices[0].LastSeenAt;

    // A later re-announcement (from a periodic re-query) must refresh LastSeenAt,
    // even though bonjour does NOT re-emit `up`.
    bonjour.emitResponse(dantePtrResponse('AudioRack-FOH._netaudio-arc._udp.local'));
    const refreshed = DanteBrowser.Snapshot().Devices[0].LastSeenAt;
    assert.ok(refreshed >= seenAtDiscovery, 'timestamp should advance on re-announcement');

    // And a re-announcement can resurrect a device the retention sweep dropped,
    // since bonjour would never re-emit `up` for it.
    DanteBrowser._testClearDevices();
    assert.equal(DanteBrowser.Snapshot().Devices.length, 0);
    bonjour.emitResponse(dantePtrResponse('AudioRack-FOH._netaudio-arc._udp.local'));
    const recovered = DanteBrowser.Snapshot().Devices;
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].Name, 'AudioRack-FOH');
  } finally {
    DanteBrowser.Stop();
  }
});

test('a CMC re-announcement also refreshes the device (both service types are tapped)', () => {
  const bonjour = fakeBonjour();
  const dante = loadDante(bonjour);
  const { DanteBrowser } = dante._internal;
  try {
    dante.RunDante({ Settings: { DeviceName: 'AudioRack' } });
    bonjour.emitResponse(
      dantePtrResponse('AudioRack-FOH._netaudio-cmc._udp.local', '_netaudio-cmc._udp.local')
    );
    const devices = DanteBrowser.Snapshot().Devices;
    assert.equal(devices.length, 1);
    assert.equal(devices[0].Name, 'AudioRack-FOH');
  } finally {
    DanteBrowser.Stop();
  }
});

test('the dante-device method module exposes the expected contract', () => {
  const mod = loadWithMocks(methodPath('dante-device.js'), {
    'bonjour-service': { Bonjour: fakeBonjour() },
    '../Logger': loggerStub(),
  });
  assert.equal(mod.ID, 'dante-device');
  assert.equal(mod.Name, 'Dante Device Presence');
  assert.equal(mod.UsesAddress, false);
  assert.equal(mod.SupportsLatencyThreshold, false);
  assert.ok(Array.isArray(mod.Settings));
  const keys = mod.Settings.map((s) => s.Key);
  assert.deepEqual(keys, ['DeviceName', 'MatchMode', 'GracePeriodMs']);
  const grace = mod.Settings.find((s) => s.Key === 'GracePeriodMs');
  assert.equal(grace.Advanced, true);
  assert.equal(grace.Default, 8000);
  const mode = mod.Settings.find((s) => s.Key === 'MatchMode');
  assert.equal(mode.Type, 'select');
  assert.equal(mode.Default, 'contains');
});
