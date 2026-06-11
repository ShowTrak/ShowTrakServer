// Dummy client identifier and payload validators.
const { fail, isPlainObject, normalizeNonEmptyString } = require('./primitives');

// User-facing DummyID: alphanumeric, no spaces.
function normalizeDummyID(value, fieldName = 'Dummy ID') {
  const normalized = normalizeNonEmptyString(value, fieldName, { minLength: 1, maxLength: 64 });
  if (!/^[A-Za-z0-9]+$/.test(normalized)) {
    fail(`${fieldName} must be alphanumeric with no spaces`);
  }
  return normalized;
}

module.exports = function registerDummyValidators(Manager) {
  // Backend UUID for a dummy client (distinct from the user-facing DummyID).
  Manager.DummyClientUUID = (value, fieldName = 'UUID') => {
    return normalizeNonEmptyString(value, fieldName, { minLength: 2, maxLength: 128 });
  };

  Manager.DummyClientCreatePayload = (value) => {
    if (value === undefined || value === null) return {};
    if (!isPlainObject(value)) fail('Dummy client payload must be an object');
    const out = {};
    if (Object.prototype.hasOwnProperty.call(value, 'DummyID')) {
      out.DummyID = normalizeDummyID(value.DummyID);
    }
    if (Object.prototype.hasOwnProperty.call(value, 'Nickname')) {
      out.Nickname = normalizeNonEmptyString(value.Nickname, 'Title', {
        minLength: 1,
        maxLength: 64,
      });
    }
    if (Object.prototype.hasOwnProperty.call(value, 'Interval')) {
      const Interval = Number(value.Interval);
      if (!Number.isFinite(Interval)) fail('Interval must be a number');
      out.Interval = Interval;
    }
    if (Object.prototype.hasOwnProperty.call(value, 'GroupID')) {
      out.GroupID = Manager.GroupID(value.GroupID);
    }
    return out;
  };

  Manager.DummyClientUpdatePayload = (value) => {
    if (!isPlainObject(value)) fail('Dummy client payload must be an object');
    const out = {};
    if (Object.prototype.hasOwnProperty.call(value, 'DummyID')) {
      out.DummyID = normalizeDummyID(value.DummyID);
    }
    if (Object.prototype.hasOwnProperty.call(value, 'Nickname')) {
      out.Nickname = normalizeNonEmptyString(value.Nickname, 'Title', {
        minLength: 1,
        maxLength: 64,
      });
    }
    if (Object.prototype.hasOwnProperty.call(value, 'Interval')) {
      const Interval = Number(value.Interval);
      if (!Number.isFinite(Interval)) fail('Interval must be a number');
      out.Interval = Interval;
    }
    if (Object.prototype.hasOwnProperty.call(value, 'GroupID')) {
      out.GroupID = Manager.GroupID(value.GroupID);
    }
    return out;
  };
};
