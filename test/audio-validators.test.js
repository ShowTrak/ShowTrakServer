const test = require('node:test');
const assert = require('node:assert/strict');

const { Manager: IPCValidation } = require('../dist/Modules/IPCValidation');

// Covers the audio asset IPC validators (audio-validators.ts) exposed on the
// composed IPCValidation Manager: AudioAssetID, AudioImportPayload and
// AudioUpdatePayload.

test('AudioAssetID trims and enforces a non-empty bounded string', () => {
  assert.equal(IPCValidation.AudioAssetID('  asset-1  '), 'asset-1');
  assert.throws(() => IPCValidation.AudioAssetID('  '), /at least 1 character|required|empty/i);
  assert.throws(() => IPCValidation.AudioAssetID(null), /must be a string/i);
  assert.throws(() => IPCValidation.AudioAssetID('x'.repeat(129)), /at most 128/i);
});

test('AudioImportPayload requires an object with a source path', () => {
  assert.throws(() => IPCValidation.AudioImportPayload(null), /must be an object/i);
  assert.throws(() => IPCValidation.AudioImportPayload('nope'), /must be an object/i);
  assert.throws(() => IPCValidation.AudioImportPayload({}), /Source Path/i);

  const out = IPCValidation.AudioImportPayload({ SourcePath: '  /tmp/clip.wav  ' });
  assert.deepEqual(out, { SourcePath: '/tmp/clip.wav' });
});

test('AudioImportPayload keeps optional Label/Volume/Duration when valid', () => {
  const out = IPCValidation.AudioImportPayload({
    SourcePath: '/tmp/clip.wav',
    Label: 'My Clip',
    Volume: '0.5',
    Duration: 1200,
  });
  assert.equal(out.SourcePath, '/tmp/clip.wav');
  assert.equal(out.Label, 'My Clip');
  assert.equal(out.Volume, 0.5); // coerced to a number
  assert.equal(out.Duration, 1200);
});

test('AudioImportPayload omits null optionals and rejects bad types', () => {
  // Null optionals are simply not carried through.
  const out = IPCValidation.AudioImportPayload({
    SourcePath: '/tmp/clip.wav',
    Label: null,
    Volume: null,
    Duration: null,
  });
  assert.deepEqual(out, { SourcePath: '/tmp/clip.wav' });

  assert.throws(
    () => IPCValidation.AudioImportPayload({ SourcePath: '/x', Label: 5 }),
    /Label must be a string/i
  );
  assert.throws(
    () => IPCValidation.AudioImportPayload({ SourcePath: '/x', Volume: 'loud' }),
    /Volume must be a number/i
  );
  assert.throws(
    () => IPCValidation.AudioImportPayload({ SourcePath: '/x', Duration: 'long' }),
    /Duration must be a number/i
  );
});

test('AudioUpdatePayload requires an object and at least one updatable field', () => {
  assert.throws(() => IPCValidation.AudioUpdatePayload(null), /must be an object/i);
  assert.throws(() => IPCValidation.AudioUpdatePayload({}), /Nothing to update/i);
  // Providing only null-valued fields still counts as nothing to update.
  assert.throws(
    () => IPCValidation.AudioUpdatePayload({ Label: null, Volume: null }),
    /Nothing to update/i
  );
});

test('AudioUpdatePayload accepts partial Label/Volume updates', () => {
  assert.deepEqual(IPCValidation.AudioUpdatePayload({ Label: 'Renamed' }), { Label: 'Renamed' });
  assert.deepEqual(IPCValidation.AudioUpdatePayload({ Volume: '0.25' }), { Volume: 0.25 });
  assert.deepEqual(IPCValidation.AudioUpdatePayload({ Label: 'A', Volume: 1 }), {
    Label: 'A',
    Volume: 1,
  });

  assert.throws(() => IPCValidation.AudioUpdatePayload({ Label: 9 }), /Label must be a string/i);
  assert.throws(
    () => IPCValidation.AudioUpdatePayload({ Volume: 'quiet' }),
    /Volume must be a number/i
  );
});
