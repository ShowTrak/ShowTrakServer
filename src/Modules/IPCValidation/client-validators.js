// Client / group / script identifier validators.
const { fail, isPlainObject, normalizeNonEmptyString } = require('./primitives');

module.exports = function registerClientValidators(Manager) {
  Manager.UUID = (value, fieldName = 'UUID') => {
    return normalizeNonEmptyString(value, fieldName, { minLength: 2, maxLength: 128 });
  };

  Manager.UUIDList = (value, fieldName = 'Targets') => {
    if (!Array.isArray(value)) {
      fail(`${fieldName} must be an array`);
    }
    if (value.length === 0) {
      fail(`${fieldName} cannot be empty`);
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
        fail(`${fieldName} must be a positive integer`);
      }
      return value;
    }

    if (typeof value === 'string') {
      const normalized = value.trim();
      if (!/^\d+$/.test(normalized)) {
        fail(`${fieldName} must be numeric`);
      }
      return parseInt(normalized, 10);
    }

    fail(`${fieldName} is invalid`);
  };

  Manager.GroupTitle = (value) => {
    return normalizeNonEmptyString(value, 'Group title', { minLength: 3, maxLength: 50 });
  };

  Manager.ScriptID = (value) => {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('Script ID is invalid');
      return String(value);
    }
    return normalizeNonEmptyString(value, 'Script ID', { minLength: 1, maxLength: 128 });
  };

  Manager.Boolean = (value, fieldName) => {
    if (typeof value !== 'boolean') {
      fail(`${fieldName} must be a boolean`);
    }
    return value;
  };

  Manager.USBSerialNumber = (value, fieldName = 'SerialNumber') => {
    return normalizeNonEmptyString(value, fieldName, { minLength: 1, maxLength: 256 }).toUpperCase();
  };

  Manager.CriticalUSBDevicePayload = (value) => {
    if (!isPlainObject(value)) {
      fail('Critical USB payload must be an object');
    }
    return {
      SerialNumber: Manager.USBSerialNumber(value.SerialNumber),
      ManufacturerName: Object.prototype.hasOwnProperty.call(value, 'ManufacturerName')
        ? normalizeNonEmptyString(value.ManufacturerName, 'ManufacturerName', {
            minLength: 1,
            maxLength: 256,
          })
        : null,
      ProductName: Object.prototype.hasOwnProperty.call(value, 'ProductName')
        ? normalizeNonEmptyString(value.ProductName, 'ProductName', {
            minLength: 1,
            maxLength: 256,
          })
        : null,
    };
  };

  Manager.ClientUpdatePayload = (value) => {
    if (!isPlainObject(value)) {
      fail('Client update payload must be an object');
    }

    const normalized = {};
    let hasAnyField = false;

    if (Object.prototype.hasOwnProperty.call(value, 'Nickname')) {
      hasAnyField = true;
      normalized.Nickname = normalizeNonEmptyString(value.Nickname, 'Nickname', {
        minLength: 1,
        maxLength: 64,
      });
    }

    if (Object.prototype.hasOwnProperty.call(value, 'GroupID')) {
      hasAnyField = true;
      normalized.GroupID = Manager.GroupID(value.GroupID);
    }

    if (!hasAnyField) {
      fail('Client update payload does not include supported fields');
    }

    return normalized;
  };
};
