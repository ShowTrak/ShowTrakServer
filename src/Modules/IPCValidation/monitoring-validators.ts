// Monitoring target identifier and payload validators.
//
// The action validators are the security boundary for check actions: a method +
// action pair is resolved against the MonitoringMethods registry and anything
// absent is rejected, so the set of things a monitored device can be told to do
// is exactly what the methods declare. Parameters are then normalized against
// the ACTION's own schema, which means a parameter meant for one action cannot
// ride along with another.
import { fail, isPlainObject, normalizeNonEmptyString } from './primitives';
import { Manager as MonitoringMethods } from '../MonitoringMethods';
import type { IPCValidationManager } from './index';

const MAX_TARGET_BATCH = 500;

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

  Manager.MonitoringTargetIDList = (value: unknown, fieldName = 'TargetIDs') => {
    const list = Array.isArray(value) ? (value as unknown[]) : [value];
    if (!list.length) fail(`${fieldName} must not be empty`);
    if (list.length > MAX_TARGET_BATCH) {
      fail(`${fieldName} must contain at most ${MAX_TARGET_BATCH} targets`);
    }
    // De-duplicated so a repeated id cannot make one device take an action twice.
    const seen = new Set<number>();
    for (const entry of list) {
      seen.add(Manager.MonitoringTargetID(entry, 'TargetID'));
    }
    return Array.from(seen);
  };

  Manager.MonitoringMethodID = (value: unknown, fieldName = 'Method') => {
    const id = normalizeNonEmptyString(value, fieldName, { minLength: 1, maxLength: 64 });
    if (!MonitoringMethods.Has(id)) fail(`Unknown monitoring method "${id}"`);
    return id;
  };

  Manager.MonitoringActionID = (method: unknown, value: unknown) => {
    const methodID = Manager.MonitoringMethodID(method);
    const id = normalizeNonEmptyString(value, 'ActionID', { minLength: 1, maxLength: 64 });
    // The method's declared action list IS the allowlist.
    if (!MonitoringMethods.GetAction(methodID, id)) {
      fail(`Unknown action "${id}" for monitoring method "${methodID}"`);
    }
    return id;
  };

  Manager.MonitoringActionParams = (method: unknown, action: unknown, value: unknown) => {
    const methodID = Manager.MonitoringMethodID(method);
    const actionID = Manager.MonitoringActionID(methodID, action);
    if (value != null && !isPlainObject(value)) fail('Action parameters must be an object');
    // Normalizing against the action's own schema drops anything it did not ask
    // for and clamps what it did, so the registrar hands the method a parameter
    // set it has already agreed to.
    return MonitoringMethods.NormalizeActionParams(methodID, actionID, value ?? {});
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
      out.Address = value.Address == null ? '' : String(value.Address).trim().slice(0, 253);
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
    if (Object.prototype.hasOwnProperty.call(value, 'Slug')) {
      out.Slug = Manager.Slug(value.Slug);
    }
    if (Object.prototype.hasOwnProperty.call(value, 'Checks')) {
      out.Checks = normalizeChecks(value.Checks, true);
    }
    return out;
  };
};
