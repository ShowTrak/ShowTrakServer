// FOG IPC validators. Normalizes the identifiers used by the FOG Manager handlers
// (Fog:*).
//
// These validate shape only. Whether a task type is actually permitted, and whether
// the client is linked to a host, is re-checked inside FogManager.ScheduleTask — the
// renderer is never the authority on what may be scheduled.
import { fail } from './primitives';
import type { IPCValidationManager } from './index';

function toPositiveInt(value: unknown, fieldName: string): number {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0) fail(`${fieldName} must be a positive integer`);
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) fail(`${fieldName} must be numeric`);
    const Parsed = parseInt(normalized, 10);
    if (Parsed <= 0) fail(`${fieldName} must be a positive integer`);
    return Parsed;
  }
  fail(`${fieldName} is invalid`);
  // unreachable — fail throws
  return 0;
}

export = function registerFogValidators(Manager: IPCValidationManager): void {
  Manager.FogHostID = (value: unknown, fieldName = 'FogHostID') => toPositiveInt(value, fieldName);

  // Null/0/empty means "unlink", which is a legitimate value here rather than an
  // error — hence a separate validator from FogHostID.
  Manager.FogHostIDOrNull = (value: unknown, fieldName = 'FogHostID') => {
    if (value == null || value === '' || value === 0 || value === '0') return null;
    return toPositiveInt(value, fieldName);
  };

  Manager.FogTaskTypeID = (value: unknown, fieldName = 'TaskTypeID') =>
    toPositiveInt(value, fieldName);

  Manager.FogTaskRecordID = (value: unknown, fieldName = 'FogTaskRecordID') =>
    toPositiveInt(value, fieldName);

  // Only Single Snapin (type 13) supplies this; everything else omits it.
  Manager.FogSnapinID = (value: unknown, fieldName = 'SnapinID') => {
    if (value == null || value === '') return null;
    return toPositiveInt(value, fieldName);
  };
};
