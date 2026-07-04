// Monitoring target identifier and payload validators.
const { fail, isPlainObject, normalizeNonEmptyString } = require('./primitives');

// Method-specific Settings are validated against the registered schema by
// the MonitoringMethods module; here we only enforce the shape.
function normalizeMonitoringSettings(value) {
  if (value == null) return {};
  if (!isPlainObject(value)) fail('Monitoring Settings must be an object');
  return value;
}

module.exports = function registerMonitoringValidators(Manager) {
  Manager.MonitoringTargetID = (value, fieldName = 'TargetID') => {
    if (typeof value === 'number') {
      if (!Number.isInteger(value) || value <= 0) fail(`${fieldName} must be a positive integer`);
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim();
      if (!/^\d+$/.test(normalized)) fail(`${fieldName} must be numeric`);
      return parseInt(normalized, 10);
    }
    fail(`${fieldName} is invalid`);
  };

  // Normalize a single check within a monitoring target. `allowCheckID` permits
  // an existing CheckID (used on update to distinguish edits from inserts).
  function normalizeCheck(value, index, allowCheckID) {
    if (!isPlainObject(value)) fail(`Check ${index + 1} must be an object`);
    const out = {};
    if (
      allowCheckID &&
      Object.prototype.hasOwnProperty.call(value, 'CheckID') &&
      value.CheckID != null
    ) {
      out.CheckID = Manager.MonitoringTargetID(value.CheckID, 'CheckID');
    }
    if (
      Object.prototype.hasOwnProperty.call(value, 'Name') &&
      value.Name != null &&
      value.Name !== ''
    ) {
      out.Name = normalizeNonEmptyString(value.Name, `Check ${index + 1} name`, {
        minLength: 1,
        maxLength: 64,
      });
    } else {
      out.Name = '';
    }
    out.Address = normalizeNonEmptyString(value.Address, `Check ${index + 1} address`, {
      minLength: 1,
      maxLength: 253,
    });
    out.Method = normalizeNonEmptyString(value.Method, `Check ${index + 1} method`, {
      minLength: 1,
      maxLength: 64,
    });
    if (Object.prototype.hasOwnProperty.call(value, 'DegradedThresholdMs')) {
      const Threshold = Number(value.DegradedThresholdMs);
      if (!Number.isFinite(Threshold)) {
        fail(`Check ${index + 1} DegradedThresholdMs must be a number`);
      }
      out.DegradedThresholdMs = Threshold;
    }
    out.Settings = normalizeMonitoringSettings(value.Settings);
    return out;
  }

  function normalizeChecks(value, allowCheckID) {
    if (!Array.isArray(value)) fail('Checks must be an array');
    // A target is allowed to have zero checks (it renders as degraded).
    return value.map((Check, Index) => normalizeCheck(Check, Index, allowCheckID));
  }

  Manager.MonitoringTargetCreatePayload = (value) => {
    if (!isPlainObject(value)) fail('Monitoring target payload must be an object');
    const out = {};
    out.Nickname = normalizeNonEmptyString(value.Nickname, 'Nickname', {
      minLength: 1,
      maxLength: 64,
    });
    if (value.Interval === undefined || value.Interval === null) fail('Interval is required');
    const Interval = Number(value.Interval);
    if (!Number.isFinite(Interval)) fail('Interval must be a number');
    out.Interval = Interval;
    out.GroupID = Object.prototype.hasOwnProperty.call(value, 'GroupID')
      ? Manager.GroupID(value.GroupID)
      : null;
    out.Checks = normalizeChecks(value.Checks == null ? [] : value.Checks, false);
    return out;
  };

  Manager.MonitoringTargetUpdatePayload = (value) => {
    if (!isPlainObject(value)) fail('Monitoring target payload must be an object');
    const out = {};
    if (Object.prototype.hasOwnProperty.call(value, 'Nickname')) {
      out.Nickname = normalizeNonEmptyString(value.Nickname, 'Nickname', {
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
    if (Object.prototype.hasOwnProperty.call(value, 'Checks')) {
      out.Checks = normalizeChecks(value.Checks, true);
    }
    return out;
  };
};
