// Show Variable IPC validators. Normalizes the identifiers/payloads used by the
// Variable Manager handlers (Variables:*) and by the client editor's override
// map.
//
// Deliberately thin: key normalization (upper snake case, prefix rejection,
// de-collision) and value sanitization belong to VariableManager, which owns the
// canonical rules and is also reached from the socket layer. Duplicating them
// here would give two definitions of a legal key that could drift. These
// validators only enforce the wire SHAPE — that an ID is an ID and a string is a
// string — so a malformed renderer payload is refused before it reaches a
// manager that assumes well-formed input.
import { fail, isPlainObject } from './primitives';
import type { IPCValidationManager } from './index';

// Generous relative to VariableManager's own 4096-char cap: this is the "is this
// obviously junk" gate, and the manager truncates to the real limit afterwards.
// Refusing here at exactly the manager's limit would turn a paste one character
// too long into an error instead of a silent, documented truncation.
const MAX_WIRE_VALUE_LENGTH = 8192;

export = function registerVariableValidators(Manager: IPCValidationManager): void {
  Manager.VariableID = (value: unknown, fieldName = 'VariableID') => {
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
    // unreachable — fail throws
    return 0;
  };

  Manager.VariableText = (value: unknown, fieldName = 'Value') => {
    if (typeof value !== 'string') fail(`${fieldName} must be a string`);
    const text = value as string;
    if (text.length > MAX_WIRE_VALUE_LENGTH) {
      fail(`${fieldName} must be ${MAX_WIRE_VALUE_LENGTH} characters or fewer`);
    }
    return text;
  };

  // The client editor's override map: VariableID -> value, where null means
  // "clear the override and inherit the default again". null and '' are
  // different states and both are preserved — '' pins the value to empty.
  Manager.ClientVariableMap = (value: unknown) => {
    if (value == null) return {};
    if (!isPlainObject(value)) fail('Variables must be an object');

    const Source = value as Record<string, unknown>;
    const Result: Record<string, string | null> = {};
    for (const [RawID, RawValue] of Object.entries(Source)) {
      const VariableID = Manager.VariableID(RawID, 'Variables key');
      if (RawValue === null) {
        Result[String(VariableID)] = null;
        continue;
      }
      Result[String(VariableID)] = Manager.VariableText(RawValue, `Variables[${VariableID}]`);
    }
    return Result;
  };
};
