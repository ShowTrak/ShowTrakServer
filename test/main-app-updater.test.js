const test = require('node:test');
const assert = require('node:assert/strict');
const { installModuleMocks, matchesModule } = require('./helpers/main-mocks');

// src/main/app-updater.ts is @showtrak/protocol/electron-main's updater (whose
// behaviour the protocol's specs cover) pointed at this app's releases. What is
// the Server's own is that configuration: the wrong repository would offer
// another app's builds as updates, or none at all.

let Options = null;
const Created = { Register() {} };
const restore = installModuleMocks([
  {
    match: (r) => r === '@showtrak/protocol/electron-main',
    value: {
      CreateAppUpdater: (Given) => {
        Options = Given;
        return Created;
      },
    },
  },
  {
    match: matchesModule('/Modules/Logger'),
    value: { CreateLogger: (Alias) => ({ Alias }) },
  },
]);
test.after(() => restore());

const { Manager } = require('../dist/main/app-updater');

test("the updater checks ShowTrak Server's own GitHub releases", () => {
  assert.equal(Manager, Created, 'Manager is the kit updater itself');
  assert.equal(Options.Owner, 'ShowTrak');
  assert.equal(Options.Repo, 'ShowTrakServer');
  assert.equal(Options.UserAgent, 'ShowTrakServer');
  assert.equal(Options.TempConfigName, 'showtrak-app-update.yml');
  assert.equal(Options.Logger.Alias, 'AppUpdater');
});
