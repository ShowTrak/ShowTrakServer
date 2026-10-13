const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

// Audio transitions through the alert pipeline: which triggers one change
// satisfies, how the alert describes it, and that the rule editor accepts every
// audio trigger the evaluator understands.

const { TRIGGERS } = require('../dist/Modules/AlertsManager/triggers');
const Evaluation = require('../dist/Modules/AlertsManager/evaluation');

const AUDIO_TRIGGERS = [
  'AUDIO_DEVICE_CONNECTED',
  'AUDIO_DEVICE_DISCONNECTED',
  'CRITICAL_AUDIO_DEVICE_CONNECTED',
  'CRITICAL_AUDIO_DEVICE_DISCONNECTED',
  'NON_CRITICAL_AUDIO_DEVICE_CONNECTED',
  'NON_CRITICAL_AUDIO_DEVICE_DISCONNECTED',
  'AUDIO_DEFAULT_DEVICE_CHANGED',
  'AUDIO_DEVICE_MUTED',
  'AUDIO_FORMAT_CHANGED',
];

function loadAlerts() {
  const executed = [];
  const rules = AUDIO_TRIGGERS.map((Trigger, Index) => ({
    RuleID: Index + 1,
    Title: Trigger,
    Scope: JSON.stringify({ Workspace: true, Groups: [], Clients: [] }),
    TriggerType: Trigger,
    TriggerConfig: JSON.stringify({}),
    Actions: JSON.stringify([{ Type: 'http-api', Settings: {} }]),
    Enabled: 1,
    Timestamp: 1,
    UpdatedAt: 1,
  }));
  const { Manager } = loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'AlertsManager', 'index.js'),
    {
      '../Logger': { CreateLogger: () => ({ error: () => {} }) },
      '../DB': {
        Manager: {
          All: async () => [null, rules],
          Run: async () => [null, { changes: 1 }],
          RunWithoutDirtyTracking: async () => [null, { changes: 1 }],
        },
      },
      '../AlertActions': {
        Manager: {
          GetAll: () => [],
          Execute: async (_action, context) => {
            executed.push(context);
            return { Success: true };
          },
        },
      },
      '../Broadcast': { Manager: { emit: () => {} } },
      '../Utils': require('../dist/Modules/Utils'),
    }
  );
  return { Manager, executed };
}

const CLIENT = { UUID: 'c1', Nickname: 'FOH PC', GroupID: 2, IP: '10.0.0.5', Online: true };
const DVS = {
  EndpointID: 'coreaudio:output:audinate:dante-virtual-soundcard',
  Direction: 'output',
  Name: 'Dante Virtual Soundcard',
  Channels: 64,
  SampleRate: 48000,
  IsDefault: true,
  Volume: null,
  Muted: null,
};

test('every audio trigger is offered, and accepted by the rule validator', () => {
  const { Manager } = loadAlerts();
  const offered = Manager.GetTriggers().map((t) => t.ID);
  const { Manager: IPCValidation } = require('../dist/Modules/IPCValidation');
  for (const trigger of AUDIO_TRIGGERS) {
    assert.equal(TRIGGERS[trigger], trigger);
    assert.ok(offered.includes(trigger), `${trigger} is offered`);
    const payload = IPCValidation.AlertRuleCreatePayload({
      Title: 'Audio rule',
      Scope: { Workspace: true },
      TriggerTypes: [trigger],
      Actions: [],
    });
    assert.deepEqual(payload.TriggerTypes, [trigger]);
  }
});

test('the rule editor offers every audio trigger, each with its own phrase', () => {
  // The editor keeps its own allowlist and drops anything not on it, so a
  // trigger missing here would be offered by the server and silently discarded.
  const { ALERT_TRIGGER_ALLOWLIST } = require('../dist-test/UI/js/app/state/ui-drafts.js');
  for (const trigger of AUDIO_TRIGGERS) {
    assert.ok(ALERT_TRIGGER_ALLOWLIST.has(trigger), `${trigger} missing from the editor allowlist`);
  }
});

test('a critical disconnect fires the generic and the critical trigger, not the non-critical one', async () => {
  const { Manager, executed } = loadAlerts();
  await Manager.Init();
  await Manager.HandleAudioDeviceChange(CLIENT, {
    Kind: 'disconnected',
    Endpoint: DVS,
    Previous: DVS,
    IsCritical: true,
  });
  assert.deepEqual(
    executed.map((c) => c.TriggerType),
    ['AUDIO_DEVICE_DISCONNECTED', 'CRITICAL_AUDIO_DEVICE_DISCONNECTED']
  );
  assert.equal(executed[0].Severity, 'warning');
  assert.equal(executed[0].UUID, 'c1');
  assert.equal(executed[0].GroupID, 2);
  assert.equal(executed[0].AudioDevice.IsCritical, true);
  assert.equal(executed[0].AudioDevice.Previous, null, 'a disconnect is not a change from itself');
  assert.equal(
    executed[0].Description,
    'Dante Virtual Soundcard (output) disconnected from FOH PC'
  );
  assert.equal(
    executed[1].Description,
    'Dante Virtual Soundcard (output) (critical) disconnected from FOH PC'
  );
});

test('a non-critical connect fires the generic and the non-critical trigger', async () => {
  const { Manager, executed } = loadAlerts();
  await Manager.Init();
  await Manager.HandleAudioDeviceChange(CLIENT, {
    Kind: 'connected',
    Endpoint: { ...DVS, Direction: 'input', Name: 'Scarlett 2i2' },
    Previous: null,
    IsCritical: false,
  });
  assert.deepEqual(
    executed.map((c) => [c.TriggerType, c.Severity, c.Description]),
    [
      ['AUDIO_DEVICE_CONNECTED', 'info', 'Scarlett 2i2 (input) connected to FOH PC'],
      [
        'NON_CRITICAL_AUDIO_DEVICE_CONNECTED',
        'info',
        'Scarlett 2i2 (input) (non-critical) connected to FOH PC',
      ],
    ]
  );
});

test('default, mute and format changes fire their single trigger with a readable description', async () => {
  const { Manager, executed } = loadAlerts();
  await Manager.Init();
  await Manager.HandleAudioDeviceChange(CLIENT, {
    Kind: 'default_changed',
    Endpoint: { ...DVS, Name: 'MacBook Pro Speakers' },
    Previous: DVS,
    IsCritical: false,
  });
  await Manager.HandleAudioDeviceChange(CLIENT, {
    Kind: 'muted',
    Endpoint: { ...DVS, Muted: true },
    Previous: DVS,
    IsCritical: true,
  });
  await Manager.HandleAudioDeviceChange(CLIENT, {
    Kind: 'format_changed',
    Endpoint: { ...DVS, Channels: 2, SampleRate: 44100 },
    Previous: DVS,
    IsCritical: true,
  });
  assert.deepEqual(
    executed.map((c) => [c.TriggerType, c.Description]),
    [
      [
        'AUDIO_DEFAULT_DEVICE_CHANGED',
        'Default output on FOH PC changed to MacBook Pro Speakers (was Dante Virtual Soundcard)',
      ],
      ['AUDIO_DEVICE_MUTED', 'Dante Virtual Soundcard (output) was muted on FOH PC'],
      [
        'AUDIO_FORMAT_CHANGED',
        'Dante Virtual Soundcard (output) on FOH PC changed format from 64 ch / 48 kHz to 2 ch / 44.1 kHz',
      ],
    ]
  );
});

test('malformed or unknown audio changes are ignored', async () => {
  const { Manager, executed } = loadAlerts();
  await Manager.Init();
  await Manager.HandleAudioDeviceChange(null, { Kind: 'connected', Endpoint: DVS });
  await Manager.HandleAudioDeviceChange(
    { Nickname: 'no uuid' },
    { Kind: 'connected', Endpoint: DVS }
  );
  await Manager.HandleAudioDeviceChange(CLIENT, null);
  await Manager.HandleAudioDeviceChange(CLIENT, { Kind: 'exploded', Endpoint: DVS });
  await Manager.HandleAudioDeviceChange(CLIENT, { Kind: 'connected' });
  await Manager.HandleAudioDeviceChange(CLIENT, { Kind: 42, Endpoint: DVS });
  assert.deepEqual(executed, []);
});

test('audio descriptions fall back sensibly when names are missing', () => {
  const describe = (TriggerType, AudioDevice, EntityName) =>
    Evaluation.describeContext({ TriggerType, EntityType: 'client', EntityName, AudioDevice });
  assert.equal(
    describe('AUDIO_DEVICE_CONNECTED', {}, undefined),
    'Audio device connected to Client'
  );
  assert.equal(
    describe('AUDIO_DEFAULT_DEVICE_CHANGED', { Direction: 'input' }, 'Rack'),
    'Default input on Rack changed to another device'
  );
  assert.equal(
    describe('AUDIO_FORMAT_CHANGED', { Name: 'X', Direction: 'output' }, 'Rack'),
    'X (output) on Rack changed format to unknown format'
  );
  assert.equal(describe('AUDIO_DEVICE_MUTED', undefined, 'Rack'), 'Audio device was muted on Rack');
  assert.equal(
    Evaluation.describeAudioDevice({ Name: '  ', Direction: 'sideways' }),
    'Audio device'
  );
});

test('each audio trigger matches only its own context', () => {
  for (const ruleTrigger of AUDIO_TRIGGERS) {
    for (const contextTrigger of AUDIO_TRIGGERS) {
      const matched = Evaluation.triggerMatches(
        { TriggerTypes: [ruleTrigger] },
        { TriggerType: contextTrigger, EntityType: 'client' }
      );
      assert.equal(matched, ruleTrigger === contextTrigger, `${ruleTrigger} vs ${contextTrigger}`);
    }
  }
});
