const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function loadOsc() {
  return loadWithMocks(methodPath('_osc-shared.js'), {})._internal;
}

test('OSC codec round-trips an address with mixed args (length framing)', () => {
  const osc = loadOsc();
  const framed = osc.EncodeOscTcp('/eos/ping', ['hello', 42, true], 'length');
  const { Messages, Rest } = osc.DecodeOscStream(framed, 'length');
  assert.equal(Rest.length, 0);
  assert.equal(Messages.length, 1);
  assert.equal(Messages[0].Address, '/eos/ping');
  assert.deepEqual(Messages[0].Args, ['hello', 42, true]);
});

test('OSC codec round-trips with SLIP framing', () => {
  const osc = loadOsc();
  const framed = osc.EncodeOscTcp('/eos/out/get/version', ['3.2.1.4'], 'slip');
  const { Messages } = osc.DecodeOscStream(framed, 'slip');
  assert.equal(Messages.length, 1);
  assert.equal(Messages[0].Address, '/eos/out/get/version');
  assert.deepEqual(Messages[0].Args, ['3.2.1.4']);
});

test('OSC codec forces int vs float encoding via wrappers', () => {
  const osc = loadOsc();
  const framed = osc.EncodeOscTcp('/x', [{ Int: 7 }, { Float: 1.5 }], 'length');
  const { Messages } = osc.DecodeOscStream(framed, 'length');
  assert.equal(Messages[0].Args[0], 7);
  assert.ok(Math.abs(Number(Messages[0].Args[1]) - 1.5) < 1e-6);
});

test('OSC length-framed decode splits multiple packets and keeps a partial remainder', () => {
  const osc = loadOsc();
  const a = osc.EncodeOscTcp('/a', [1], 'length');
  const b = osc.EncodeOscTcp('/b', [2], 'length');
  const stream = Buffer.concat([a, b.subarray(0, b.length - 2)]); // b is incomplete
  const { Messages, Rest } = osc.DecodeOscStream(stream, 'length');
  assert.equal(Messages.length, 1);
  assert.equal(Messages[0].Address, '/a');
  assert.equal(Rest.length, b.length - 2);
});

test('OSC SLIP decode escapes/unescapes END and ESC bytes in the payload', () => {
  const osc = loadOsc();
  // A string arg containing the SLIP END (0xc0) and ESC (0xdb) bytes as UTF-8.
  const tricky = Buffer.from([0xc0, 0xdb, 0x41]).toString('latin1');
  const framed = osc.EncodeOscTcp('/t', [tricky], 'slip');
  const { Messages } = osc.DecodeOscStream(framed, 'slip');
  assert.equal(Messages.length, 1);
  assert.equal(Messages[0].Address, '/t');
});

test('OSC decode flattens a #bundle into its member messages', () => {
  const osc = loadOsc();
  const m1 = osc.EncodeOscMessage('/one', [1]);
  const m2 = osc.EncodeOscMessage('/two', ['x']);
  const size1 = Buffer.alloc(4);
  size1.writeUInt32BE(m1.length, 0);
  const size2 = Buffer.alloc(4);
  size2.writeUInt32BE(m2.length, 0);
  const bundle = Buffer.concat([
    Buffer.from('#bundle\0'),
    Buffer.alloc(8), // time tag
    size1,
    m1,
    size2,
    m2,
  ]);
  const msgs = osc.ParseOscPacket(bundle);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].Address, '/one');
  assert.equal(msgs[1].Address, '/two');
});
