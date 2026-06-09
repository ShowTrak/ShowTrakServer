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

  Manager.MonitoringTargetCreatePayload = (value) => {
    if (!isPlainObject(value)) fail('Monitoring target payload must be an object');
    const out = {};
    out.Nickname = normalizeNonEmptyString(value.Nickname, 'Nickname', { minLength: 1, maxLength: 64 });
    out.Address = normalizeNonEmptyString(value.Address, 'Address', { minLength: 1, maxLength: 253 });
    out.Method = normalizeNonEmptyString(value.Method, 'Method', { minLength: 1, maxLength: 64 });
    if (value.Interval === undefined || value.Interval === null) fail('Interval is required');
    const Interval = Number(value.Interval);
    if (!Number.isFinite(Interval)) fail('Interval must be a number');
    out.Interval = Interval;
    out.StoreHistory =
      Object.prototype.hasOwnProperty.call(value, 'StoreHistory') ? !!value.StoreHistory : false;
    if (Object.prototype.hasOwnProperty.call(value, 'DegradedThresholdMs')) {
      const Threshold = Number(value.DegradedThresholdMs);
      if (!Number.isFinite(Threshold)) fail('DegradedThresholdMs must be a number');
      out.DegradedThresholdMs = Threshold;
    }
    out.GroupID =
      Object.prototype.hasOwnProperty.call(value, 'GroupID') ? Manager.GroupID(value.GroupID) : null;
    out.Settings = normalizeMonitoringSettings(value.Settings);
    return out;
  };

  Manager.MonitoringTargetUpdatePayload = (value) => {
    if (!isPlainObject(value)) fail('Monitoring target payload must be an object');
    const out = {};
    if (Object.prototype.hasOwnProperty.call(value, 'Nickname')) {
      out.Nickname = normalizeNonEmptyString(value.Nickname, 'Nickname', { minLength: 1, maxLength: 64 });
    }
    if (Object.prototype.hasOwnProperty.call(value, 'Address')) {
      out.Address = normalizeNonEmptyString(value.Address, 'Address', { minLength: 1, maxLength: 253 });
    }
    if (Object.prototype.hasOwnProperty.call(value, 'Method')) {
      out.Method = normalizeNonEmptyString(value.Method, 'Method', { minLength: 1, maxLength: 64 });
    }
    if (Object.prototype.hasOwnProperty.call(value, 'Interval')) {
      const Interval = Number(value.Interval);
      if (!Number.isFinite(Interval)) fail('Interval must be a number');
      out.Interval = Interval;
    }
    if (Object.prototype.hasOwnProperty.call(value, 'StoreHistory')) {
      out.StoreHistory = !!value.StoreHistory;
    }
    if (Object.prototype.hasOwnProperty.call(value, 'DegradedThresholdMs')) {
      const Threshold = Number(value.DegradedThresholdMs);
      if (!Number.isFinite(Threshold)) fail('DegradedThresholdMs must be a number');
      out.DegradedThresholdMs = Threshold;
    }
    if (Object.prototype.hasOwnProperty.call(value, 'GroupID')) {
      out.GroupID = Manager.GroupID(value.GroupID);
    }
    if (Object.prototype.hasOwnProperty.call(value, 'Settings')) {
      out.Settings = normalizeMonitoringSettings(value.Settings);
    }
    return out;
  };
};
