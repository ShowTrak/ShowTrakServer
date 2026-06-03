const Manager = {};

function _fail(message) {
  throw new Error(message);
}

function _isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function _normalizeNonEmptyString(value, fieldName, options = {}) {
  const { minLength = 1, maxLength = 256 } = options;
  if (typeof value !== 'string') {
    _fail(`${fieldName} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length < minLength) {
    _fail(`${fieldName} must be at least ${minLength} characters`);
  }
  if (normalized.length > maxLength) {
    _fail(`${fieldName} must be at most ${maxLength} characters`);
  }
  return normalized;
}

Manager.UUID = (value, fieldName = 'UUID') => {
  return _normalizeNonEmptyString(value, fieldName, { minLength: 2, maxLength: 128 });
};

Manager.UUIDList = (value, fieldName = 'Targets') => {
  if (!Array.isArray(value)) {
    _fail(`${fieldName} must be an array`);
  }
  if (value.length === 0) {
    _fail(`${fieldName} cannot be empty`);
  }

  const normalized = [];
  for (const item of value) {
    normalized.push(Manager.UUID(item, `${fieldName} item`));
  }

  return Array.from(new Set(normalized));
};

Manager.GroupID = (value, fieldName = 'GroupID') => {
  if (value === null || value === undefined || value === 'null') return null;

  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) {
      _fail(`${fieldName} must be a positive integer`);
    }
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) {
      _fail(`${fieldName} must be numeric`);
    }
    return parseInt(normalized, 10);
  }

  _fail(`${fieldName} is invalid`);
};

Manager.GroupTitle = (value) => {
  return _normalizeNonEmptyString(value, 'Group title', { minLength: 3, maxLength: 50 });
};

Manager.ScriptID = (value) => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) _fail('Script ID is invalid');
    return String(value);
  }
  return _normalizeNonEmptyString(value, 'Script ID', { minLength: 1, maxLength: 128 });
};

Manager.Boolean = (value, fieldName) => {
  if (typeof value !== 'boolean') {
    _fail(`${fieldName} must be a boolean`);
  }
  return value;
};

Manager.ClientUpdatePayload = (value) => {
  if (!_isPlainObject(value)) {
    _fail('Client update payload must be an object');
  }

  const normalized = {};
  let hasAnyField = false;

  if (Object.prototype.hasOwnProperty.call(value, 'Nickname')) {
    hasAnyField = true;
    normalized.Nickname = _normalizeNonEmptyString(value.Nickname, 'Nickname', {
      minLength: 1,
      maxLength: 64,
    });
  }

  if (Object.prototype.hasOwnProperty.call(value, 'GroupID')) {
    hasAnyField = true;
    normalized.GroupID = Manager.GroupID(value.GroupID);
  }

  if (!hasAnyField) {
    _fail('Client update payload does not include supported fields');
  }

  return normalized;
};

Manager.SettingUpdatePayload = (key, value) => {
  const normalizedKey = _normalizeNonEmptyString(key, 'Setting key', { minLength: 2, maxLength: 128 });

  if (typeof value !== 'boolean' && typeof value !== 'string' && typeof value !== 'number') {
    _fail('Setting value must be a boolean, string, or number');
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    _fail('Setting value number is invalid');
  }

  return [normalizedKey, value];
};

module.exports = {
  Manager,
};
