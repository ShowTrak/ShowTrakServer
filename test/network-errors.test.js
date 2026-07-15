const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  IsTransientNetworkError,
  DescribeError,
  CreateBonjourErrorHandler,
  TRANSIENT_NETWORK_ERROR_CODES,
} = require(path.join(__dirname, '..', 'dist', 'Modules', 'NetworkErrors', 'index.js'));

test('classifies the reported mDNS interface-loss error as transient', () => {
  const Err = Object.assign(new Error('send EADDRNOTAVAIL 224.0.0.251:5353'), {
    code: 'EADDRNOTAVAIL',
  });
  assert.equal(IsTransientNetworkError(Err), true);
});

test('classifies by message text when no .code is present', () => {
  // Some layers rethrow only the message; the reported crash text still classifies.
  assert.equal(IsTransientNetworkError(new Error('send EADDRNOTAVAIL 224.0.0.251:5353')), true);
  assert.equal(IsTransientNetworkError('send EADDRNOTAVAIL 224.0.0.251:5353'), true);
});

test('covers the full interface-loss / teardown code set', () => {
  for (const Code of TRANSIENT_NETWORK_ERROR_CODES) {
    assert.equal(IsTransientNetworkError({ code: Code }), true, `expected ${Code} transient`);
  }
});

test('does NOT swallow unrelated programming errors', () => {
  assert.equal(IsTransientNetworkError(new TypeError('x is not a function')), false);
  assert.equal(IsTransientNetworkError({ code: 'ENOENT' }), false);
  assert.equal(IsTransientNetworkError(null), false);
  assert.equal(IsTransientNetworkError(undefined), false);
});

test('DescribeError prefers the message, falls back to String()', () => {
  assert.equal(DescribeError(new Error('boom')), 'boom');
  assert.equal(DescribeError('bare string'), 'bare string');
});

test('bonjour error handler never throws and routes by severity', () => {
  const warns = [];
  const errors = [];
  const Logger = { warn: (m) => warns.push(m), error: (m) => errors.push(m) };
  const Handler = CreateBonjourErrorHandler(Logger);

  // The exact failure that used to crash the app must be swallowed as a warning.
  assert.doesNotThrow(() =>
    Handler(
      Object.assign(new Error('send EADDRNOTAVAIL 224.0.0.251:5353'), { code: 'EADDRNOTAVAIL' })
    )
  );
  assert.equal(warns.length, 1);
  assert.equal(errors.length, 0);

  // An unexpected mDNS error is logged at error level but still does not throw.
  assert.doesNotThrow(() => Handler(new Error('totally unexpected')));
  assert.equal(errors.length, 1);
});
