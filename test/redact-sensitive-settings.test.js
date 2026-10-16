const test = require('node:test');
const assert = require('node:assert/strict');

const { RedactSensitiveValues, REDACTED } = require('../dist/Modules/Utils/redact');
const { Manager: Methods } = require('../dist/Modules/MonitoringMethods');

// Device credentials live in monitoring check settings. The anonymous HTTP API
// serves those settings, so every credential field is flagged `Sensitive` on its
// schema and masked on the way out. These tests pin the helper, the registry
// hook, and — most importantly — that no credential-looking field is left
// unflagged when a new method is added.

test('RedactSensitiveValues masks flagged non-empty values and nothing else', () => {
  const Fields = [
    { Key: 'Password', Sensitive: true },
    { Key: 'Token', Sensitive: true },
    { Key: 'Port' },
  ];
  const Out = RedactSensitiveValues(Fields, { Password: 'hunter2', Token: '', Port: 4352 });
  assert.deepEqual(Out, { Password: REDACTED, Token: '', Port: 4352 });
});

test('RedactSensitiveValues does not mutate its input or invent keys', () => {
  const Values = { Password: 'hunter2' };
  const Out = RedactSensitiveValues(
    [
      { Key: 'Password', Sensitive: true },
      { Key: 'Other', Sensitive: true },
    ],
    Values
  );
  assert.equal(Values.Password, 'hunter2');
  assert.equal(Object.prototype.hasOwnProperty.call(Out, 'Other'), false);
});

test('RedactSettings masks a real method credential and keeps the rest', () => {
  const Out = Methods.RedactSettings('pjlink', { Password: 'projector-pw', Port: 4352 });
  assert.equal(Out.Password, REDACTED);
  assert.equal(Out.Port, 4352);
});

test('RedactSettings releases nothing for an unknown method', () => {
  assert.deepEqual(Methods.RedactSettings('no-such-method', { Password: 'x' }), {});
});

test('every credential-looking setting on every method is flagged Sensitive', () => {
  const CredentialKey = /pass|community|secret|token|apikey/i;
  const Unflagged = [];
  for (const { ID } of Methods.GetAll()) {
    for (const Field of Methods.Get(ID).Settings || []) {
      if (CredentialKey.test(Field.Key) && !Field.Sensitive) Unflagged.push(`${ID}.${Field.Key}`);
    }
  }
  assert.deepEqual(Unflagged, [], 'flag these fields `Sensitive: true` in their method schema');
});
