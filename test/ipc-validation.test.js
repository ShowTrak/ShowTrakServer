const test = require('node:test');
const assert = require('node:assert/strict');

const { Manager: IPCValidation } = require('../src/Modules/IPCValidation');

test('IPCValidation.UUID trims and validates non-empty UUID strings', () => {
  assert.equal(IPCValidation.UUID('  abc-123  '), 'abc-123');
  assert.throws(() => IPCValidation.UUID('  '), /at least 2 characters/i);
  assert.throws(() => IPCValidation.UUID(null), /must be a string/i);
});

test('IPCValidation.UUIDList validates arrays, deduplicates, and rejects empty lists', () => {
  assert.deepEqual(IPCValidation.UUIDList(['a1', 'b2', 'a1']), ['a1', 'b2']);
  assert.throws(() => IPCValidation.UUIDList([]), /cannot be empty/i);
  assert.throws(() => IPCValidation.UUIDList('bad'), /must be an array/i);
});

test('IPCValidation.DummyClientCreatePayload validates ID, title, and interval', () => {
  const payload = IPCValidation.DummyClientCreatePayload({
    DummyID: '  DummyClient123456  ',
    Nickname: '  Stage Left  ',
    Interval: 15000,
    GroupID: '3',
  });
  assert.equal(payload.DummyID, 'DummyClient123456');
  assert.equal(payload.Nickname, 'Stage Left');
  assert.equal(payload.Interval, 15000);
  assert.equal(payload.GroupID, 3);

  // IDs with spaces or symbols are rejected at the IPC boundary.
  assert.throws(
    () => IPCValidation.DummyClientCreatePayload({ DummyID: 'has space' }),
    /alphanumeric/i
  );
  assert.throws(
    () => IPCValidation.DummyClientUpdatePayload({ Interval: 'soon' }),
    /must be a number/i
  );
});

test('IPCValidation.ClientUpdatePayload validates supported fields only', () => {
  const payload = IPCValidation.ClientUpdatePayload({
    Nickname: '  Arcade-PC 01  ',
    GroupID: '42',
    Ignored: true,
  });
  assert.equal(payload.Nickname, 'Arcade-PC 01');
  assert.equal(payload.GroupID, 42);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'Ignored'), false);

  assert.throws(() => IPCValidation.ClientUpdatePayload({}), /supported fields/i);
});

test('IPCValidation.CriticalUSBDevicePayload validates and normalizes serials', () => {
  const payload = IPCValidation.CriticalUSBDevicePayload({
    SerialNumber: '  abcd-1234  ',
    ManufacturerName: '  SanDisk  ',
    ProductName: '  Ultra  ',
  });
  assert.equal(payload.SerialNumber, 'ABCD-1234');
  assert.equal(payload.ManufacturerName, 'SanDisk');
  assert.equal(payload.ProductName, 'Ultra');

  assert.throws(() => IPCValidation.CriticalUSBDevicePayload({}), /SerialNumber/i);
  assert.throws(() => IPCValidation.CriticalUSBDevicePayload(null), /must be an object/i);
});

test('IPCValidation.CriticalApplicationPayload validates application names', () => {
  const payload = IPCValidation.CriticalApplicationPayload({
    Name: '  Spotify  ',
  });
  assert.equal(payload.Name, 'Spotify');

  assert.throws(() => IPCValidation.CriticalApplicationPayload({}), /Name/i);
  assert.throws(() => IPCValidation.CriticalApplicationPayload(null), /must be an object/i);
});

test('IPCValidation.SettingUpdatePayload allows primitive setting values', () => {
  assert.deepEqual(IPCValidation.SettingUpdatePayload('SYSTEM_ALLOW_WOL', true), [
    'SYSTEM_ALLOW_WOL',
    true,
  ]);
  assert.deepEqual(IPCValidation.SettingUpdatePayload('AB', 'x'), ['AB', 'x']);
  assert.deepEqual(IPCValidation.SettingUpdatePayload('WEBUI_PASSWORD', '12ab34'), [
    'WEBUI_PASSWORD',
    '1234',
  ]);
  assert.deepEqual(IPCValidation.SettingUpdatePayload('WEBUI_PASSWORD', ''), [
    'WEBUI_PASSWORD',
    '',
  ]);
  assert.throws(
    () => IPCValidation.SettingUpdatePayload('SETTING_X', { bad: true }),
    /must be a boolean, string, or number/i
  );
});

test('IPCValidation.NetworkDiscoveryScanID validates scan identifiers', () => {
  assert.equal(
    IPCValidation.NetworkDiscoveryScanID('  12345678-1234-1234-1234-123456789abc  '),
    '12345678-1234-1234-1234-123456789abc'
  );
  assert.throws(() => IPCValidation.NetworkDiscoveryScanID('tiny'), /at least 8 characters/i);
});

test('IPCValidation.NetworkDiscoveryScanOptions validates and normalizes options', () => {
  const options = IPCValidation.NetworkDiscoveryScanOptions({
    EnableBonjour: 1,
    EnableProbe: 0,
    TimeoutMs: 15000,
    MaxHostsPerSubnet: 256,
    Concurrency: 24,
    ProbePorts: [80, 443, 443, 8080],
  });

  assert.deepEqual(options, {
    EnableBonjour: true,
    EnableProbe: false,
    TimeoutMs: 15000,
    MaxHostsPerSubnet: 256,
    Concurrency: 24,
    ProbePorts: [80, 443, 8080],
  });

  assert.throws(
    () => IPCValidation.NetworkDiscoveryScanOptions({ ProbePorts: ['abc'] }),
    /valid TCP port numbers/i
  );
  assert.throws(
    () => IPCValidation.NetworkDiscoveryScanOptions({ TimeoutMs: 10 }),
    /between 1000 and 120000/i
  );
});

test('IPCValidation.GroupID and GroupTitle normalize and validate', () => {
  assert.equal(IPCValidation.GroupID(null), null);
  assert.equal(IPCValidation.GroupID('null'), null);
  assert.equal(IPCValidation.GroupID('17'), 17);
  assert.equal(IPCValidation.GroupID(5), 5);
  assert.throws(() => IPCValidation.GroupID('abc'), /must be numeric/i);
  assert.throws(() => IPCValidation.GroupID(-1), /positive integer/i);
  assert.throws(() => IPCValidation.GroupID({}), /is invalid/i);

  assert.equal(IPCValidation.GroupTitle('  My Group  '), 'My Group');
  assert.throws(() => IPCValidation.GroupTitle('ab'), /at least 3 characters/i);
});

test('IPCValidation.ScriptID accepts strings and numbers', () => {
  assert.equal(IPCValidation.ScriptID('deploy'), 'deploy');
  assert.equal(IPCValidation.ScriptID(42), '42');
  assert.throws(() => IPCValidation.ScriptID(''), /at least 1 character/i);
});

test('IPCValidation.MonitoringTargetID validates numeric identifiers', () => {
  assert.equal(IPCValidation.MonitoringTargetID(3), 3);
  assert.equal(IPCValidation.MonitoringTargetID(' 12 '), 12);
  assert.throws(() => IPCValidation.MonitoringTargetID(0), /positive integer/i);
  assert.throws(() => IPCValidation.MonitoringTargetID('x'), /must be numeric/i);
  assert.throws(() => IPCValidation.MonitoringTargetID(null), /is invalid/i);
});

test('IPCValidation.MonitoringTargetCreatePayload enforces required fields', () => {
  const payload = IPCValidation.MonitoringTargetCreatePayload({
    Nickname: '  Switch  ',
    Address: '10.0.0.1',
    Method: 'ping',
    Interval: 30000,
    StoreHistory: 1,
    GroupID: '4',
    DegradedThresholdMs: 250,
    Settings: { Timeout: 2000 },
  });
  assert.equal(payload.Nickname, 'Switch');
  assert.equal(payload.Interval, 30000);
  assert.equal(payload.StoreHistory, true);
  assert.equal(payload.GroupID, 4);
  assert.equal(payload.DegradedThresholdMs, 250);
  assert.deepEqual(payload.Settings, { Timeout: 2000 });

  assert.throws(() => IPCValidation.MonitoringTargetCreatePayload({}), /Nickname/i);
  assert.throws(
    () =>
      IPCValidation.MonitoringTargetCreatePayload({ Nickname: 'a', Address: 'b', Method: 'ping' }),
    /Interval is required/i
  );
  assert.throws(
    () =>
      IPCValidation.MonitoringTargetCreatePayload({
        Nickname: 'a',
        Address: 'b',
        Method: 'ping',
        Interval: 'fast',
      }),
    /Interval must be a number/i
  );
  assert.throws(
    () =>
      IPCValidation.MonitoringTargetCreatePayload({
        Nickname: 'a',
        Address: 'b',
        Method: 'ping',
        Interval: 1,
        Settings: 5,
      }),
    /Settings must be an object/i
  );
});

test('IPCValidation.MonitoringTargetUpdatePayload validates partial updates', () => {
  const payload = IPCValidation.MonitoringTargetUpdatePayload({
    Address: 'host.local',
    Interval: 5000,
    StoreHistory: 0,
    GroupID: null,
  });
  assert.equal(payload.Address, 'host.local');
  assert.equal(payload.Interval, 5000);
  assert.equal(payload.StoreHistory, false);
  assert.equal(payload.GroupID, null);

  assert.throws(
    () => IPCValidation.MonitoringTargetUpdatePayload({ Interval: 'slow' }),
    /Interval must be a number/i
  );
  assert.throws(
    () => IPCValidation.MonitoringTargetUpdatePayload({ DegradedThresholdMs: 'x' }),
    /DegradedThresholdMs must be a number/i
  );
});

test('IPCValidation.AlertRuleID validates numeric rule identifiers', () => {
  assert.equal(IPCValidation.AlertRuleID(8), 8);
  assert.equal(IPCValidation.AlertRuleID(' 9 '), 9);
  assert.throws(() => IPCValidation.AlertRuleID(-2), /positive integer/i);
  assert.throws(() => IPCValidation.AlertRuleID('zz'), /must be numeric/i);
  assert.throws(() => IPCValidation.AlertRuleID(null), /is invalid/i);
});

test('IPCValidation.AlertRuleCreatePayload normalizes scope, trigger, and actions', () => {
  const payload = IPCValidation.AlertRuleCreatePayload({
    Title: 'Offline alert',
    Scope: {
      Workspace: true,
      Groups: ['1', 2, 2],
      Clients: ['abc', 'monitor:5', '  '],
    },
    TriggerType: 'CLIENT_OFFLINE',
    TriggerConfig: { Threshold: 3 },
    Actions: [{ Type: 'discord-webhook', Title: 'Notify', Settings: { WebhookURL: 'x' } }],
    Enabled: 0,
  });
  assert.equal(payload.Title, 'Offline alert');
  assert.equal(payload.Scope.Workspace, true);
  assert.deepEqual(payload.Scope.Groups, [1, 2]);
  assert.deepEqual(payload.Scope.Clients, ['abc', 'monitor:5']);
  assert.equal(payload.TriggerType, 'CLIENT_OFFLINE');
  assert.deepEqual(payload.TriggerConfig, { Threshold: 3 });
  assert.equal(payload.Actions.length, 1);
  assert.equal(payload.Actions[0].Type, 'discord-webhook');
  assert.equal(payload.Enabled, false);

  assert.throws(
    () =>
      IPCValidation.AlertRuleCreatePayload({
        Title: 'x',
        Scope: {},
        TriggerType: 'NOPE',
        Actions: [],
      }),
    /at least 2 characters|Unsupported TriggerType/i
  );
  assert.throws(
    () =>
      IPCValidation.AlertRuleCreatePayload({
        Title: 'Valid title',
        Scope: {},
        TriggerType: 'UNKNOWN_TRIGGER',
        Actions: [],
      }),
    /Unsupported TriggerType/i
  );
  assert.throws(
    () =>
      IPCValidation.AlertRuleCreatePayload({
        Title: 'Valid title',
        Scope: { Clients: ['monitor:abc'] },
        TriggerType: 'CLIENT_ONLINE',
        Actions: [],
      }),
    /monitor:<TargetID>/i
  );
  assert.throws(
    () =>
      IPCValidation.AlertRuleCreatePayload({
        Title: 'Valid title',
        Scope: {},
        TriggerType: 'CLIENT_ONLINE',
        Actions: 'not-an-array',
      }),
    /Actions must be an array/i
  );
});

test('IPCValidation.AlertRuleUpdatePayload validates partial alert updates', () => {
  const payload = IPCValidation.AlertRuleUpdatePayload({
    Title: 'Renamed rule',
    Enabled: true,
    TriggerType: 'CLIENT_DEGRADED',
  });
  assert.equal(payload.Title, 'Renamed rule');
  assert.equal(payload.Enabled, true);
  assert.equal(payload.TriggerType, 'CLIENT_DEGRADED');

  assert.throws(
    () => IPCValidation.AlertRuleUpdatePayload({ TriggerType: 'BOGUS' }),
    /Unsupported TriggerType/i
  );
  assert.throws(() => IPCValidation.AlertRuleUpdatePayload('nope'), /must be an object/i);
});

test('IPCValidation alert payloads accept critical USB trigger types', () => {
  const created = IPCValidation.AlertRuleCreatePayload({
    Title: 'Critical USB connected',
    Scope: {},
    TriggerType: 'CRITICAL_USB_DEVICE_CONNECTED',
    Actions: [{ Type: 'http-api', Settings: {} }],
    Enabled: true,
  });
  assert.equal(created.TriggerType, 'CRITICAL_USB_DEVICE_CONNECTED');

  const updated = IPCValidation.AlertRuleUpdatePayload({
    TriggerType: 'CRITICAL_USB_DEVICE_DISCONNECTED',
  });
  assert.equal(updated.TriggerType, 'CRITICAL_USB_DEVICE_DISCONNECTED');
});

test('IPCValidation alert payloads accept non-critical USB trigger types', () => {
  const created = IPCValidation.AlertRuleCreatePayload({
    Title: 'Non-critical USB connected',
    Scope: {},
    TriggerType: 'NON_CRITICAL_USB_DEVICE_CONNECTED',
    Actions: [{ Type: 'http-api', Settings: {} }],
    Enabled: true,
  });
  assert.equal(created.TriggerType, 'NON_CRITICAL_USB_DEVICE_CONNECTED');

  const updated = IPCValidation.AlertRuleUpdatePayload({
    TriggerType: 'NON_CRITICAL_USB_DEVICE_DISCONNECTED',
  });
  assert.equal(updated.TriggerType, 'NON_CRITICAL_USB_DEVICE_DISCONNECTED');
});

test('IPCValidation alert payloads accept application trigger types', () => {
  const created = IPCValidation.AlertRuleCreatePayload({
    Title: 'Application started',
    Scope: {},
    TriggerType: 'APPLICATION_STARTED',
    Actions: [{ Type: 'http-api', Settings: {} }],
    Enabled: true,
  });
  assert.equal(created.TriggerType, 'APPLICATION_STARTED');

  const updated = IPCValidation.AlertRuleUpdatePayload({
    TriggerType: 'CRITICAL_APPLICATION_STOPPED',
  });
  assert.equal(updated.TriggerType, 'CRITICAL_APPLICATION_STOPPED');
});
