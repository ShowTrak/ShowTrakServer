const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

const noopLogger = {
  CreateLogger: () => ({ log: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
};

function loadBonjour() {
  const published = [];
  const browsers = [];

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

  const bonjourMock = () => ({
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
    findOne: (_opts, cb) => {
      const b = makeBrowser();
      b._foundCb = cb;
      return b;
    },
  });

  const mocks = {
    bonjour: bonjourMock,
    '../Logger': noopLogger,
    '../OS': { Manager: { Hostname: 'TestHost' } },
    '../Config': { Config: { Application: { Port: 1234 }, Shared: { Version: '3.0.0' } } },
    '../ServerIdentity': { Manager: { GetIdentityToken: () => 'server-identity-token' } },
  };

  const { Manager } = loadWithMocks(
    path.join(__dirname, '..', 'src', 'Modules', 'Bonjour', 'index.js'),
    mocks
  );
  return { Manager, published, browsers };
}

test('Bonjour.Init publishes a service with hostname and port', () => {
  const { Manager, published } = loadBonjour();
  Manager.Init();
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
