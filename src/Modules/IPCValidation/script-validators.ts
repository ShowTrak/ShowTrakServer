// Script-catalog IPC validators. Normalizes the identifiers and payloads used
// by the Script Manager handlers (Scripts:*), replacing the ad-hoc inline
// `typeof`/`includes('..')` checks that were previously duplicated across the
// registrar. The on-disk path-containment guard shared by Scripts:OpenFile and
// Scripts:RunLocalFile lives in main/local-scripts (`resolveContainedScriptFile`)
// because it needs the resolved scripts directory; these validators cover the
// stateless string/shape checks.
import { fail, isPlainObject, normalizeNonEmptyString } from './primitives';
import type { IPCValidationManager } from './index';

// A script folder ID must be a single safe path segment: no separators and no
// "..", so it can never escape the scripts directory when joined to it.
function normalizeScriptFolderID(value: unknown, fieldName: string): string {
  const ID = normalizeNonEmptyString(value, fieldName, { minLength: 1, maxLength: 128 });
  if (ID.includes('..') || ID.includes('/') || ID.includes('\\')) {
    fail(`${fieldName} is not a valid script ID`);
  }
  return ID;
}

export = function registerScriptValidators(Manager: IPCValidationManager): void {
  Manager.ScriptFolderID = (value: unknown, fieldName = 'Script ID') =>
    normalizeScriptFolderID(value, fieldName);

  Manager.ScriptSampleID = (value: unknown, fieldName = 'Template ID') =>
    normalizeNonEmptyString(value, fieldName, { minLength: 1, maxLength: 128 });

  Manager.ScriptFieldsPayload = (value: unknown) => {
    if (!isPlainObject(value)) fail('Invalid script fields');
    return value;
  };

  Manager.ScriptOrderList = (value: unknown, fieldName = 'Order') => {
    if (!Array.isArray(value)) fail(`${fieldName} must be an array`);
    return value.map((entry, index) => normalizeScriptFolderID(entry, `${fieldName}[${index}]`));
  };
};
