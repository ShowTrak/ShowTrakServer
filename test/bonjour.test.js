const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

const noopLogger = {
  CreateLogger: () => ({ log: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
};

function loadBonjour(settings = {}) {
  const published = [];
  const browsers = [];
  const settingsReads = [];

  function makeBrowser() {
    const b = { handlers: {}, started: false, updated: 0 };
    b.on = (event, cb) => {
      b.handlers[event] = cb;
    };
    b.start = () => {
      b.started = true;
    };
    b.update = () => {
      b.updated += 1;
    };
    browsers.push(b);
    return b;
  }

  // Regular function (not arrow) so the production wrapper's `new Bonjour(...)` works.
  function bonjourMock() {
    return {
      publish: (opts) => {
        const service = { opts, handlers: {}, started: false };
        service.on = (event, cb) => {
          service.handlers[event] = cb;
        };
        service.start = () => {
          service.started = true;
        };
        published.push(service);
        return service;
      },
      find: () => makeBrowser(),
      findOne: (_opts, _timeout, cb) => {
        const b = makeBrowser();
        b._foundCb = cb;
        return b;
      },
    };
  }

  const mocks = {
    'bonjour-service': { Bonjour: bonjourMock },
    '../Logger': noopLogger,
    '../OS': { Manager: { Hostname: 'TestHost' } },
    '../Config': { Config: { Application: { Port: 1234 }, Shared: { Version: '3.0.0' } } },
    '../ServerIdentity': { Manager: { GetIdentityToken: () => 'server-identity-token' } },
    // Stubbed for the usual reason: unstubbed, SettingsManager pulls in ../DB and
    // opens a live sqlite connection at module load — green locally, broken on CI.
    '../SettingsManager': {
      Manager: {
        GetValue: async (Key) => {
          settingsReads.push(Key);
          if (settings.__throws) throw new Error('settings unavailable');
          return settings[Key];
        },
      },
    },
  };

  const { Manager } = loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'Bonjour', 'index.js'),
    mocks
  );
  return { Manager, published, browsers, settingsReads };
}

test('Bonjour.Init publishes a service with hostname and port', async () => {
  const { Manager, published } = loadBonjour();
  await Manager.Init();
  assert.equal(published.length >= 1, true);
  const service = published[0];
  assert.match(service.opts.name, /TestHost/);
  assert.equal(service.opts.port, 1234);
  assert.equal(service.opts.type, 'showtrak');
  assert.equal(service.opts.txt.ServerIdentity, 'server-identity-token');
  assert.equal(service.started, true);
});

test('Bonjour.Find starts a browser for showtrak services', () => {
  const { Manager, browsers } = loadBonjour();
  Manager.Find();
  assert.ok(browsers.some((b) => b.started === true));
});

test('Bonjour.OnFind registers a callback for discovered services', () => {
  const { Manager, browsers } = loadBonjour();
  const seen = [];
  Manager.OnFind((service) => seen.push(service));
  const browser = browsers[browsers.length - 1];
  assert.equal(typeof browser.handlers.up, 'function');
  browser.handlers.up({ host: 'peer', port: 9000 });
  assert.deepEqual(seen, [{ host: 'peer', port: 9000 }]);
});

// --- ShowTrak Remote discovery hints -----------------------------------------
//
// These let the app's server list say "PIN required", or grey out a server that
// will refuse the connection anyway, WITHOUT anyone having to tap it first. They
// are advisory only — mDNS is unauthenticated and trivially spoofed, so the
// handshake re-reads every one of these and remains the authority.

test('Init advertises the discovery hints Remote reads', async () => {
  const { Manager, published } = loadBonjour({
    SDK_API_ENABLED: 1,
    SDK_ALLOW_REMOTE_PAIRING: 1,
    WEBUI_PASSWORD_PROTECTION_ENABLED: 1,
    WEBUI_PASSWORD: '1234',
  });
  await Manager.Init();

  const { txt } = published[0].opts;
  assert.equal(txt.Name, 'TestHost');
  assert.equal(txt.SdkEnabled, '1');
  assert.equal(txt.Pairing, '1');
  assert.equal(txt.PinRequired, '1');
});

test('protection with a blank passcode is not advertised as requiring a PIN', async () => {
  // The handshake applies exactly this rule. Advertising otherwise would make the
  // app prompt for a PIN the server never checks.
  const Loaded = loadBonjour({
    WEBUI_PASSWORD_PROTECTION_ENABLED: 1,
    WEBUI_PASSWORD: '   ',
  });
  await Loaded.Manager.Init();

  assert.equal(Loaded.published[0].opts.txt.PinRequired, '0');
});

test('an unset hint defaults to the same value the handshake defaults to', async () => {
  // A server upgraded from a build with no such setting must not advertise
  // itself as disabled and get greyed out in every discovery list.
  const Loaded = loadBonjour({});
  await Loaded.Manager.Init();

  assert.equal(Loaded.published[0].opts.txt.SdkEnabled, '1');
  assert.equal(Loaded.published[0].opts.txt.Pairing, '1');
});

test('a settings failure still publishes the service, minus the hints', async () => {
  // Losing the hints degrades the list to "tap and find out", which is what an
  // older server does anyway. Not advertising at all would make the server
  // invisible.
  const Loaded = loadBonjour({ __throws: true });
  await Loaded.Manager.Init();

  const { txt } = Loaded.published[0].opts;
  assert.equal(txt.ServerIdentity, 'server-identity-token');
  assert.equal(txt.SdkEnabled, undefined);
});
