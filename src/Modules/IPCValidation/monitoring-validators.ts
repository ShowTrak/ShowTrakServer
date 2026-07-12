// Monitoring target identifier and payload validators.
import { fail, isPlainObject, normalizeNonEmptyString } from './primitives';
import { Manager as MonitoringMethods } from '../MonitoringMethods';
import type { IPCValidationManager } from './index';

// Method-specific Settings are validated against the registered schema by
// the MonitoringMethods module; here we only enforce the shape.
function normalizeMonitoringSettings(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (!isPlainObject(value)) fail('Monitoring Settings must be an object');
  return value;
}

export = function registerMonitoringValidators(Manager: IPCValidationManager): void {
  Manager.MonitoringTargetID = (value: unknown, fieldName = 'TargetID') => {
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
  function normalizeCheck(value: unknown, index: number, allowCheckID: boolean) {
    if (!isPlainObject(value)) fail(`Check ${index + 1} must be an object`);
    const out: Record<string, unknown> = {};
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
    out.Method = normalizeNonEmptyString(value.Method, `Check ${index + 1} method`, {
      minLength: 1,
      maxLength: 64,
    });
    // Methods that ignore the Address field (e.g. network-wide NDI discovery) may
    // be saved without one; every other method requires a non-empty address.
    const MethodDef = MonitoringMethods.Get(out.Method as string);
    if (MethodDef && MethodDef.UsesAddress === false) {
      out.Address =
        value.Address == null ? '' : String(value.Address).trim().slice(0, 253);
    } else {
      out.Address = normalizeNonEmptyString(value.Address, `Check ${index + 1} address`, {
        minLength: 1,
        maxLength: 253,
      });
    }
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

  function normalizeChecks(value: unknown, allowCheckID: boolean) {
    if (!Array.isArray(value)) fail('Checks must be an array');
    // A target is allowed to have zero checks (it renders as degraded).
    return value.map((Check: unknown, Index: number) => normalizeCheck(Check, Index, allowCheckID));
  }

  Manager.MonitoringTargetCreatePayload = (value: unknown) => {
    if (!isPlainObject(value)) fail('Monitoring target payload must be an object');
    const out: Record<string, unknown> = {};
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

  Manager.MonitoringTargetUpdatePayload = (value: unknown) => {
    if (!isPlainObject(value)) fail('Monitoring target payload must be an object');
    const out: Record<string, unknown> = {};
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
