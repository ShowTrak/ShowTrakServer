const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// The LAN discovery signatures in src/Modules/MonitoringMethods/discovery.ts are
// keyed by method ID and name settings by key, so a renamed method or setting
// would silently stop being suggested (or pre-fill a setting that does not
// exist). These hold the map to the real catalogue.

const METHODS = path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods');
const { Manager } = require(path.join(METHODS, 'index.js'));
const { MethodDiscovery } = require(path.join(METHODS, 'discovery.js'));

const Catalogue = Manager.GetAll();
const byID = new Map(Catalogue.map((Method) => [Method.ID, Method]));

test('every discovery signature belongs to an installed method', () => {
  for (const ID of Object.keys(MethodDiscovery)) {
    assert.ok(byID.has(ID), `discovery.ts lists '${ID}', which is not a monitoring method`);
  }
});

test('the settings a signature pre-fills exist on its method', () => {
  for (const [ID, Discovery] of Object.entries(MethodDiscovery)) {
    const Keys = byID.get(ID).Settings.map((Field) => Field.Key);
    const Presets = [
      ...Object.values(Discovery.PortSettings || {}),
      ...Object.values(Discovery.ServiceSettings || {}),
    ].flatMap((Preset) => Object.keys(Preset));
    for (const Key of [Discovery.PortSetting, Discovery.NameSetting, ...Presets].filter(Boolean)) {
      assert.ok(Keys.includes(Key), `${ID} pre-fills '${Key}', which it has no setting for`);
    }
    // A preset keyed by a port or service the signature never matches is dead.
    for (const Port of Object.keys(Discovery.PortSettings || {})) {
      assert.ok((Discovery.TcpPorts || []).includes(Number(Port)), `${ID}: preset for ${Port}`);
    }
    for (const Type of Object.keys(Discovery.ServiceSettings || {})) {
      assert.ok((Discovery.ServiceTypes || []).includes(Type), `${ID}: preset for ${Type}`);
    }
  }
});

test('every signature can actually match something', () => {
  for (const [ID, Discovery] of Object.entries(MethodDiscovery)) {
    const Signals =
      (Discovery.TcpPorts || []).length +
      (Discovery.ServiceTypes || []).length +
      +!!Discovery.PJLink;
    assert.ok(Signals > 0, `${ID} has a discovery signature with nothing to match`);
    for (const Type of Discovery.ServiceTypes || []) {
      assert.match(Type, /^_[a-z0-9-]+\._(tcp|udp)$/, `${ID}: '${Type}' is not _type._proto`);
    }
    for (const Port of Discovery.TcpPorts || []) {
      assert.ok(Number.isInteger(Port) && Port > 0 && Port <= 65535, `${ID}: bad port ${Port}`);
    }
  }
});

test('the catalogue publishes each signature, and null where there is none', () => {
  assert.deepEqual(byID.get('hyperdeck').Discovery, MethodDiscovery.hyperdeck);
  assert.equal(byID.get('ping').Discovery, null);
});

test('the scan probes every signature port once, in order', () => {
  const Ports = Manager.GetDiscoveryTcpPorts();
  assert.deepEqual(
    Ports,
    [...new Set(Ports)].sort((A, B) => A - B)
  );
  for (const Discovery of Object.values(MethodDiscovery)) {
    for (const Port of Discovery.TcpPorts || []) assert.ok(Ports.includes(Port), `missing ${Port}`);
  }
});
