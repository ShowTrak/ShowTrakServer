const test = require('node:test');
const assert = require('node:assert/strict');

// What a FreeKiosk save does to the stored API key. The Web UI is never given
// the key, so its field starts blank — and that blank used to be sent as
// "clear", wiping the key on every Web UI save.

const { ApiKeyPayload } = require('../dist-test/UI/js/app/lib/freekiosk-api-key.js');

test('a typed key is sent, trimmed, whether or not one was withheld', () => {
  for (const Withheld of [false, true]) {
    assert.deepEqual(ApiKeyPayload({ Typed: '  abc ', Withheld, ClearRequested: false }), {
      ApiKey: 'abc',
    });
  }
  assert.deepEqual(ApiKeyPayload({ Typed: 'abc', Withheld: true, ClearRequested: true }), {
    ApiKey: 'abc',
  });
});

test('a blank field keeps a key the form was never given', () => {
  assert.deepEqual(ApiKeyPayload({ Typed: '', Withheld: true, ClearRequested: false }), {});
  assert.deepEqual(ApiKeyPayload({ Typed: '   ', Withheld: true, ClearRequested: false }), {});
});

test('a withheld key is removed only when asked', () => {
  assert.deepEqual(ApiKeyPayload({ Typed: '', Withheld: true, ClearRequested: true }), {
    ClearApiKey: true,
  });
});

test('where the form holds the key, emptying the field clears it', () => {
  // The desktop is given the stored key, so its field is the whole truth.
  assert.deepEqual(ApiKeyPayload({ Typed: '', Withheld: false, ClearRequested: false }), {
    ClearApiKey: true,
  });
});
