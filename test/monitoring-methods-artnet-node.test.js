const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
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

function loadNode() {
  return loadWithMocks(methodPath('artnet-node.js'), { '../Logger': loggerStub() });
}

const ID = Buffer.from([0x41, 0x72, 0x74, 0x2d, 0x4e, 0x65, 0x74, 0x00]); // "Art-Net\0"

// Build an ArtPollReply at the Art-Net 4 offsets. `length` truncates it to model
// older nodes; every field defaults to a healthy 4-port output node.
function buildReply(opts = {}) {
  const {
    length = 239,
    ip = [10, 0, 0, 5],
    versH = 1,
    versL = 23,
    net = 0,
    sub = 0,
    oem = 0x1234,
    esta = 0x414c,
    status1 = 0xd2, // indicators normal, network-programmed, RDM capable
    shortName = 'Node A',
    longName = 'Stage Left Node',
    report = '#0001 [0042] Power On Tests successful',
    numPorts = 4,
    portTypes = [0x80, 0x80, 0x80, 0x80],
    goodInput = [0, 0, 0, 0],
    goodOutputA = [0x80, 0x80, 0x80, 0x80],
    swIn = [0, 1, 2, 3],
    swOut = [0, 1, 2, 3],
    style = 0,
    mac = [0x00, 0x50, 0xc2, 0x01, 0x02, 0x03],
    bindIp = [10, 0, 0, 5],
    bindIndex = 1,
    status2 = 0x0e,
    goodOutputB = [0, 0, 0, 0],
    status3 = 0,
    opcode = 0x2100,
  } = opts;
  const buf = Buffer.alloc(239);
  ID.copy(buf, 0);
  buf.writeUInt16LE(opcode, 8);
  Buffer.from(ip).copy(buf, 10);
  buf.writeUInt16LE(0x1936, 14);
  buf[16] = versH;
  buf[17] = versL;
  buf[18] = net;
  buf[19] = sub;
  buf[20] = oem >> 8;
  buf[21] = oem & 0xff;
  buf[23] = status1;
  buf[24] = esta & 0xff; // EstaManLo comes first in ArtPollReply
  buf[25] = esta >> 8;
  buf.write(shortName, 26, 17, 'latin1');
  buf.write(longName, 44, 63, 'latin1');
  buf.write(report, 108, 63, 'latin1');
  buf[172] = 0;
  buf[173] = numPorts;
  Buffer.from(portTypes).copy(buf, 174);
  Buffer.from(goodInput).copy(buf, 178);
  Buffer.from(goodOutputA).copy(buf, 182);
  Buffer.from(swIn).copy(buf, 186);
  Buffer.from(swOut).copy(buf, 190);
  buf[200] = style;
  Buffer.from(mac).copy(buf, 201);
  Buffer.from(bindIp).copy(buf, 207);
  buf[211] = bindIndex;
  buf[212] = status2;
  Buffer.from(goodOutputB).copy(buf, 213);
  buf[217] = status3;
  return buf.subarray(0, length);
}

// --- ArtPoll / ArtPollReply codecs --------------------------------------------

test('BuildArtPoll is a 22-byte Art-Net 4 ArtPoll with every flag clear', () => {
  const { BuildArtPoll } = loadNode()._internal;
  const poll = BuildArtPoll();
  assert.equal(poll.length, 22);
  assert.deepEqual(poll.subarray(0, 8), ID);
  assert.equal(poll.readUInt16LE(8), 0x2000, 'OpPoll, low byte first');
  assert.equal(poll[10], 0, 'ProtVerHi');
  assert.equal(poll[11], 14, 'ProtVerLo');
  assert.equal(poll[12], 0, 'Flags: no targeted mode, no diagnostics, no reply-on-change');
  assert.ok(poll.subarray(13).every((b) => b === 0));
});

test('ParseArtPollReply reads identity, ports and status at the spec offsets', () => {
  const { ParseArtPollReply } = loadNode()._internal;
  const reply = ParseArtPollReply(
    buildReply({ net: 0x12, sub: 0x3, swOut: [5, 6, 7, 8], status3: 0x60, bindIndex: 2 }),
    '::ffff:10.0.0.5',
    1234
  );
  assert.equal(reply.Address, '10.0.0.5');
  assert.equal(reply.ReportedIp, '10.0.0.5');
  assert.equal(reply.ShortName, 'Node A');
  assert.equal(reply.LongName, 'Stage Left Node');
  assert.equal(reply.NodeReport, '#0001 [0042] Power On Tests successful');
  assert.equal(reply.VersInfoH, 1);
  assert.equal(reply.VersInfoL, 23);
  assert.equal(reply.Oem, 0x1234);
  assert.equal(reply.EstaMan, 0x414c);
  assert.equal(reply.Mac, '00:50:c2:01:02:03');
  assert.equal(reply.NumPorts, 4);
  assert.equal(reply.BindIndex, 2);
  assert.equal(reply.Status2, 0x0e);
  assert.equal(reply.Status3, 0x60);
  assert.equal(reply.ReceivedAt, 1234);
  assert.equal(reply.Ports.length, 4);
  // Port-Address = Net << 8 | Sub << 4 | SwOut nibble.
  assert.equal(reply.Ports[0].OutputUniverse, (0x12 << 8) | (0x3 << 4) | 5);
  assert.equal(reply.Ports[3].OutputUniverse, (0x12 << 8) | (0x3 << 4) | 8);
  assert.equal(reply.Ports[0].CanOutput, true);
  assert.equal(reply.Ports[0].CanInput, false);
  assert.equal(reply.Ports[0].Protocol, 'DMX512');
  assert.equal(reply.Ports[0].GoodOutputB, 0);
});

test('ParseArtPollReply skips port slots without a direction', () => {
  const { ParseArtPollReply } = loadNode()._internal;
  const reply = ParseArtPollReply(buildReply({ portTypes: [0x80, 0x40, 0, 0xc5] }), '10.0.0.5');
  assert.deepEqual(
    reply.Ports.map((p) => [p.Slot, p.CanInput, p.CanOutput, p.Protocol]),
    [
      [0, false, true, 'DMX512'],
      [1, true, false, 'DMX512'],
      [3, true, true, 'Art-Net'],
    ]
  );
});

test('ParseArtPollReply treats the fields of a 207-byte reply beyond its end as absent', () => {
  const { ParseArtPollReply } = loadNode()._internal;
  const reply = ParseArtPollReply(buildReply({ length: 207 }), '10.0.0.5');
  assert.equal(reply.Status2, null);
  assert.equal(reply.Status3, null);
  assert.equal(reply.BindIp, null);
  assert.equal(reply.BindIndex, 1, 'missing BindIndex = root');
  assert.equal(reply.Mac, '00:50:c2:01:02:03', 'MAC is within the 207-byte minimum');
  assert.equal(reply.Ports[0].GoodOutputB, null);
});

test('ParseArtPollReply survives a truncated reply from an old node', () => {
  const { ParseArtPollReply } = loadNode()._internal;
  const reply = ParseArtPollReply(buildReply({ length: 120 }), '10.0.0.5');
  assert.equal(reply.ShortName, 'Node A');
  assert.equal(reply.LongName, 'Stage Left Node');
  assert.equal(reply.NodeReport, '#0001 [0042]', 'node report clipped at the packet end');
  assert.deepEqual(reply.Ports, []);
  assert.equal(reply.Mac, null);
  assert.equal(reply.Style, null);
});

test('ParseArtPollReply reports a zeroed MAC as absent and strips control bytes from names', () => {
  const { ParseArtPollReply } = loadNode()._internal;
  const buf = buildReply({ mac: [0, 0, 0, 0, 0, 0], shortName: 'A\u0007B' });
  const reply = ParseArtPollReply(buf, '10.0.0.5');
  assert.equal(reply.Mac, null);
  assert.equal(reply.ShortName, 'AB');
});

test('ParseArtPollReply rejects junk, other opcodes and runts', () => {
  const { ParseArtPollReply } = loadNode()._internal;
  assert.equal(ParseArtPollReply(Buffer.from('hello world, not art-net'), '1.2.3.4'), null);
  assert.equal(ParseArtPollReply(buildReply({ opcode: 0x5000 }), '1.2.3.4'), null, 'ArtDmx');
  assert.equal(ParseArtPollReply(buildReply({ length: 15 }), '1.2.3.4'), null, 'runt');
  assert.equal(ParseArtPollReply(Buffer.alloc(0), '1.2.3.4'), null);
  assert.equal(ParseArtPollReply('not a buffer', '1.2.3.4'), null);
});

// --- Node report -------------------------------------------------------------

test('ParseNodeReport decodes code, counter and text', () => {
  const { ParseNodeReport } = loadNode()._internal;
  const r = ParseNodeReport('#000d [0123] DMX short on port 2');
  assert.equal(r.Code, 0x000d);
  assert.equal(r.CodeHex, '0x000d');
  assert.equal(r.Counter, 123);
  assert.equal(r.Text, 'DMX short on port 2');
  assert.equal(r.Mnemonic, 'RcDmxShort');
  assert.equal(r.Fault, true);
});

test('ParseNodeReport tolerates a missing counter, plain text and unknown codes', () => {
  const { ParseNodeReport } = loadNode()._internal;
  const noCounter = ParseNodeReport('#0001 Power On Tests successful');
  assert.equal(noCounter.Code, 1);
  assert.equal(noCounter.Counter, null);
  assert.equal(noCounter.Fault, false);

  const plain = ParseNodeReport('All good');
  assert.equal(plain.Code, null);
  assert.equal(plain.Text, 'All good');
  assert.equal(plain.Fault, false);

  const unknown = ParseNodeReport('#8001 [1] vendor thing');
  assert.equal(unknown.Code, 0x8001);
  assert.equal(unknown.Mnemonic, null);
  assert.equal(unknown.Fault, false, 'unknown codes never degrade');

  assert.equal(ParseNodeReport(null).Raw, '');
});

test('Node report fault classification follows the documented split', () => {
  const { NODE_REPORT_CODES } = loadNode()._internal;
  const faults = Object.entries(NODE_REPORT_CODES)
    .filter(([, v]) => v.Fault)
    .map(([k]) => Number(k));
  assert.deepEqual(faults, [0x02, 0x05, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e]);
});

// --- Snapshot + evaluation (pure) --------------------------------------------

function parse(lib, opts, from = '10.0.0.5') {
  return lib._internal.ParseArtPollReply(buildReply(opts), from);
}

function options(overrides = {}) {
  return {
    CheckPortErrors: true,
    CheckNodeReport: true,
    CheckName: false,
    ExpectedName: '',
    TimeoutMs: 4000,
    ...overrides,
  };
}

test('BuildNodeSnapshot merges BindIndex replies and numbers ports in bind order', () => {
  const lib = loadNode();
  const { BuildNodeSnapshot } = lib._internal;
  const root = parse(lib, { bindIndex: 1, portTypes: [0x80, 0, 0, 0], swOut: [1, 0, 0, 0] });
  const second = parse(lib, {
    bindIndex: 2,
    shortName: 'Bound',
    portTypes: [0x80, 0x80, 0, 0],
    swOut: [5, 6, 0, 0],
  });
  const snap = BuildNodeSnapshot([second, root]);
  assert.equal(snap.ShortName, 'Node A', 'identity from the root');
  assert.equal(snap.BindCount, 2);
  assert.deepEqual(
    snap.Ports.map((p) => [p.Index, p.BindIndex, p.OutputUniverse]),
    [
      [1, 1, 1],
      [2, 2, 5],
      [3, 2, 6],
    ]
  );
  assert.equal(snap.Firmware, '1.23');
  assert.equal(snap.Oem, '0x1234');
  assert.equal(snap.EstaMan, '0x414c');
  assert.equal(snap.Style, 'Node');
  assert.equal(BuildNodeSnapshot([]), null);
});

test('EvaluateNode names the port and universe for a DMX output short', () => {
  const lib = loadNode();
  const { BuildNodeSnapshot, EvaluateNode } = lib._internal;
  const snap = BuildNodeSnapshot([parse(lib, { goodOutputA: [0x80, 0x84, 0x80, 0x80] })]);
  assert.deepEqual(EvaluateNode(snap, options()), ['Port 2 (universe 1): DMX output short']);
  assert.deepEqual(EvaluateNode(snap, options({ CheckPortErrors: false })), []);
});

test('EvaluateNode reports input receive errors on input ports only', () => {
  const lib = loadNode();
  const { BuildNodeSnapshot, EvaluateNode } = lib._internal;
  const snap = BuildNodeSnapshot([
    parse(lib, {
      portTypes: [0x40, 0x80, 0, 0],
      swIn: [3, 0, 0, 0],
      // Port 2 is output-only: its GoodInput error bit must be ignored.
      goodInput: [0x84, 0x04, 0, 0],
      goodOutputA: [0, 0x80, 0, 0],
    }),
  ]);
  assert.deepEqual(EvaluateNode(snap, options()), [
    'Port 1 (universe 3): DMX input receive errors',
  ]);
});

test('EvaluateNode ignores informational port bits', () => {
  const lib = loadNode();
  const { BuildNodeSnapshot, EvaluateNode } = lib._internal;
  // Test/SIP/text packets, merging, LTP and sACN conversion are not errors.
  const snap = BuildNodeSnapshot([
    parse(lib, { goodOutputA: [0xfb, 0x7b, 0, 0x80], goodOutputB: [0xd0, 0, 0, 0] }),
  ]);
  assert.deepEqual(EvaluateNode(snap, options()), []);
  const flags = snap.Ports[0].Flags.map((f) => f.Label);
  assert.ok(flags.includes('Merging (LTP)'));
  assert.ok(flags.includes('RDM disabled'));
});

test('EvaluateNode degrades on a fault node report but not an advisory one', () => {
  const lib = loadNode();
  const { BuildNodeSnapshot, EvaluateNode } = lib._internal;
  const fault = BuildNodeSnapshot([parse(lib, { report: '#0002 [0001] Self test failed' })]);
  assert.deepEqual(EvaluateNode(fault, options()), ['Node report: Self test failed (RcPowerFail)']);
  assert.deepEqual(EvaluateNode(fault, options({ CheckNodeReport: false })), []);

  const advisory = BuildNodeSnapshot([parse(lib, { report: '#0004 [0007] Parse fail' })]);
  assert.deepEqual(EvaluateNode(advisory, options()), []);

  const bare = BuildNodeSnapshot([parse(lib, { report: '#0008' })]);
  assert.deepEqual(EvaluateNode(bare, options()), [
    'Node report: DMX512 receive errors detected (RcDmxError)',
  ]);
});

test('EvaluateNode name check matches short or long name ignoring case', () => {
  const lib = loadNode();
  const { BuildNodeSnapshot, EvaluateNode } = lib._internal;
  const snap = BuildNodeSnapshot([parse(lib)]);
  assert.deepEqual(EvaluateNode(snap, options({ CheckName: true, ExpectedName: 'node a' })), []);
  assert.deepEqual(
    EvaluateNode(snap, options({ CheckName: true, ExpectedName: 'STAGE LEFT NODE' })),
    []
  );
  assert.deepEqual(EvaluateNode(snap, options({ CheckName: true, ExpectedName: 'Node B' })), [
    'Name "Node A" / "Stage Left Node" (expected "Node B")',
  ]);
  // Off by default, and an empty expectation never degrades.
  assert.deepEqual(EvaluateNode(snap, options({ ExpectedName: 'Node B' })), []);
  assert.deepEqual(EvaluateNode(snap, options({ CheckName: true, ExpectedName: '' })), []);
});

test('DecodeStatus surfaces the operator-relevant status bits', () => {
  const { DecodeStatus } = loadNode()._internal;
  const labels = DecodeStatus(0x44, 0x26, 0x40).map((f) => f.Label);
  assert.deepEqual(labels, [
    'Locate / identify',
    'Booted from ROM',
    'DHCP address',
    'Squawking',
    'Failsafe: Outputs to zero',
  ]);
  assert.deepEqual(
    DecodeStatus(0, null, 0).map((f) => f.Label),
    [],
    'zeroed Status3 is not read as hold-last'
  );
});

// --- Settings ----------------------------------------------------------------

test('settings defaults: port errors and node report on, name check off', () => {
  const mod = loadNode();
  const byKey = Object.fromEntries(mod.Settings.map((s) => [s.Key, s]));
  assert.equal(byKey.CheckPortErrors.Default, true);
  assert.equal(byKey.CheckNodeReport.Default, true);
  assert.equal(byKey.CheckName.Default, false);
  assert.deepEqual(byKey.ExpectedName.VisibleWhen, { Key: 'CheckName', Equals: true });
  assert.equal(byKey.Timeout.Advanced, true);
  assert.equal(byKey.Timeout.Default, 4000);
  assert.equal(mod.SupportsLatencyThreshold, false);
  assert.equal(mod.ID, 'artnet-node');

  const { ParseOptions } = mod._internal;
  assert.deepEqual(ParseOptions({ Settings: {} }), options());
  assert.equal(ParseOptions({ Settings: { Timeout: 10 } }).TimeoutMs, 500);
  assert.equal(ParseOptions({ Settings: { Timeout: 1e9 } }).TimeoutMs, 30000);
});

// --- Run against a stubbed socket --------------------------------------------
//
// The receiver's WhenReady/Send are replaced so the poll never touches the
// network; replies are fed through the same Ingest() the socket handler uses.

function stubbedNode({ onSend } = {}) {
  const mod = loadNode();
  const rx = mod._internal.ArtnetReceiver;
  const sent = [];
  rx.WhenReady = async () => true;
  rx.Send = async (msg, address) => {
    sent.push({ msg, address });
    if (onSend) setImmediate(() => onSend(rx, address, msg));
  };
  return { mod, rx, sent };
}

test('Run polls the node and is online with the merged reply', async () => {
  const { mod, sent } = stubbedNode({
    onSend: (rx, address) => {
      rx.Ingest(buildReply({ bindIndex: 1 }), address);
      rx.Ingest(
        buildReply({ bindIndex: 2, portTypes: [0x80, 0, 0, 0], swOut: [9, 0, 0, 0] }),
        address
      );
    },
  });
  const res = await mod.Run({ Address: '10.0.0.5', Settings: {} });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].address, '10.0.0.5');
  assert.equal(sent[0].msg.readUInt16LE(8), 0x2000);
  assert.equal(res.Success, true);
  assert.equal(res.Degraded, undefined);
  assert.equal(typeof res.LatencyMs, 'number');
  assert.equal(res.ShortName, 'Node A');
  assert.equal(res.BindCount, 2);
  assert.equal(res.Ports.length, 5);
  assert.equal(res.Ports[4].OutputUniverse, 9);
});

test('Run degrades with port and node-report reasons', async () => {
  const { mod } = stubbedNode({
    onSend: (rx, address) =>
      rx.Ingest(
        buildReply({
          goodOutputA: [0x80, 0x80, 0x84, 0x80],
          swOut: [0, 1, 5, 3],
          report: '#000d [0009] DMX output short',
        }),
        address
      ),
  });
  const res = await mod.Run({ Address: '10.0.0.5', Settings: {} });
  assert.equal(res.Success, true);
  assert.equal(res.Degraded, true);
  assert.equal(
    res.DegradedReason,
    'Port 3 (universe 5): DMX output short; Node report: DMX output short (RcDmxShort)'
  );
});

test('Run is offline when only other IPs, other packet types or stale replies arrive', async () => {
  const { mod, rx } = stubbedNode({
    onSend: (rx2) => {
      rx2.Ingest(buildReply({ ip: [10, 0, 0, 99] }), '10.0.0.99'); // another node
      const dmx = Buffer.alloc(18);
      ID.copy(dmx, 0);
      dmx.writeUInt16LE(0x5000, 8);
      dmx.writeUInt16BE(14, 10);
      rx2.Ingest(dmx, '10.0.0.5'); // right IP, wrong packet
    },
  });
  // Heard before the poll (e.g. an Art-Net 3 broadcast): must not count.
  rx.Ingest(buildReply(), '10.0.0.5');
  await new Promise((r) => setTimeout(r, 5));
  const res = await mod.Run({ Address: '10.0.0.5', Settings: { Timeout: 500 } });
  assert.equal(res.Success, false);
  assert.match(res.Error, /No ArtPollReply from 10\.0\.0\.5 within 500 ms/);
  // The overheard reply is still cached for the node.
  assert.equal(rx.LatestReplies('10.0.0.5').length, 1);
});

test('Run accepts a reply whose reported IP matches when it arrives from another interface', async () => {
  const { mod } = stubbedNode({
    onSend: (rx) => rx.Ingest(buildReply({ ip: [10, 0, 0, 5] }), '2.0.0.5'),
  });
  const res = await mod.Run({ Address: '10.0.0.5', Settings: {} });
  assert.equal(res.Success, true);
});

test('Run shares one ArtPoll between concurrent checks of the same node', async () => {
  const { mod, sent } = stubbedNode({
    onSend: (rx, address) => rx.Ingest(buildReply(), address),
  });
  const target = { Address: '10.0.0.5', Settings: {} };
  const [a, b] = await Promise.all([mod.Run(target), mod.Run(target)]);
  assert.equal(sent.length, 1);
  assert.equal(a.Success, true);
  assert.equal(b.Success, true);
  // A poll straight after reuses the result rather than sending again.
  await mod.Run(target);
  assert.equal(sent.length, 1);
});

test('Run reports listener and send failures as offline', async () => {
  const mod = loadNode();
  const rx = mod._internal.ArtnetReceiver;
  rx.WhenReady = async () => false;
  const notReady = await mod.Run({ Address: '10.0.0.5', Settings: {} });
  assert.equal(notReady.Success, false);
  assert.match(notReady.Error, /listener starting/);

  const mod2 = loadNode();
  const rx2 = mod2._internal.ArtnetReceiver;
  rx2.WhenReady = async () => true;
  rx2.Send = async () => {
    throw new Error('EHOSTUNREACH');
  };
  const sendFail = await mod2.Run({ Address: '10.0.0.6', Settings: {} });
  assert.equal(sendFail.Success, false);
  assert.match(sendFail.Error, /Failed to send ArtPoll: EHOSTUNREACH/);
});

test('Run rejects a missing or non-IPv4 address without polling', async () => {
  const { mod, sent } = stubbedNode();
  assert.match((await mod.Run({ Address: '', Settings: {} })).Error, /No address/);
  assert.match((await mod.Run({ Address: 'node.local', Settings: {} })).Error, /IPv4/);
  assert.equal(sent.length, 0);
});

// --- Debug -------------------------------------------------------------------

test('Debug escapes device-supplied strings', async () => {
  const evil = '<script>alert(1)</script>';
  const { mod } = stubbedNode({
    onSend: (rx, address) =>
      rx.Ingest(
        buildReply({
          shortName: '<script>x',
          longName: evil,
          report: `#0002 [0001] ${evil}`,
          goodOutputA: [0x84, 0, 0, 0],
        }),
        address
      ),
  });
  const res = await mod.Run({ Address: '10.0.0.5', Settings: {} });
  const html = mod.Debug(res, { Address: '10.0.0.5' });
  assert.ok(!html.includes('<script>'), html);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.match(html, /Port 1 · Output · universe 0/);
  assert.match(html, /DMX output short/);
  assert.match(html, /RcPowerFail/);
});

test('Debug renders an offline result with the error', () => {
  const mod = loadNode();
  const html = mod.Debug(
    { Success: false, Error: 'No ArtPollReply from <b>' },
    { Address: '10.0.0.5' }
  );
  assert.match(html, /Offline/);
  assert.ok(html.includes('&lt;b&gt;'));
  assert.ok(!html.includes('<b>'));
});

// --- Real socket (best-effort; skips if udp/6454 is unavailable) ---------------

test('Run receives a real ArtPollReply over loopback on the shared socket', async (t) => {
  const mod = loadNode();
  const rx = mod._internal.ArtnetReceiver;
  const ready = await rx.WhenReady(1000);
  if (!ready) {
    rx.Stop();
    t.skip(`Art-Net socket not ready (${rx.ListenerError() || 'binding'}) — cannot bind udp/6454`);
    return;
  }

  // Our ArtPoll goes to 127.0.0.1:6454 — the receiver itself, which ignores
  // it — and the fake node answers from an ephemeral port, as a node replying
  // with a different source port would.
  const node = dgram.createSocket('udp4');
  const reply = buildReply({ ip: [127, 0, 0, 1], shortName: 'Loopback' });
  const timer = setTimeout(() => node.send(reply, 6454, '127.0.0.1'), 100);
  try {
    const res = await mod.Run({ Address: '127.0.0.1', Settings: { Timeout: 1500 } });
    if (!res.Success) {
      t.skip(`loopback delivery not available in this environment (${res.Error})`);
      return;
    }
    assert.equal(res.ShortName, 'Loopback');
    assert.ok(res.LatencyMs >= 50, `latency ${res.LatencyMs}`);
  } finally {
    clearTimeout(timer);
    node.close();
    rx.Stop();
  }
});
