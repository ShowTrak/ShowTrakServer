// Shared low-level validation primitives used by every IPCValidation domain.
function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeNonEmptyString(value, fieldName, options = {}) {
  const { minLength = 1, maxLength = 256 } = options;
  if (typeof value !== 'string') {
    fail(`${fieldName} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length < minLength) {
    fail(`${fieldName} must be at least ${minLength} characters`);
  }
  if (normalized.length > maxLength) {
    fail(`${fieldName} must be at most ${maxLength} characters`);
  }
  return normalized;
}

module.exports = {
  fail,
  isPlainObject,
  normalizeNonEmptyString,
};
