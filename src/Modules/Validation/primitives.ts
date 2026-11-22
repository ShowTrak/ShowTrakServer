// Shared low-level validation primitives used by the IPCValidation domains
// (renderer -> main) and the SocketValidation domain (client agents -> server).
// Moved here from IPCValidation/primitives.ts so socket validators can reuse
// them without importing renderer-IPC concerns.

export function fail(message: string): never {
  throw new Error(message);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface NormalizeStringOptions {
  minLength?: number;
  maxLength?: number;
}

export function normalizeNonEmptyString(
  value: unknown,
  fieldName: string,
  options: NormalizeStringOptions = {}
): string {
  const { minLength = 1, maxLength = 256 } = options;
  if (typeof value !== 'string') {
    fail(`${fieldName} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length < minLength) {
    fail(`${fieldName} must be at least ${minLength} characters`);
  }
  if (normalized.length > maxLength) {
    fail(`${fieldName} must be at most ${maxLength} characters`);
  }
  return normalized;
}

// A database row ID: a positive integer, or a string of digits. A string is only
// checked to be digits, so "0" reads as 0 (which simply matches no row).
export function normalizeNumericID(value: unknown, fieldName: string): number {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0) fail(`${fieldName} must be a positive integer`);
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) fail(`${fieldName} must be numeric`);
    return parseInt(normalized, 10);
  }
  return fail(`${fieldName} is invalid`);
}

// A string that may legitimately be absent; null/undefined normalize to null,
// anything else must be a string (trimmed, length-capped; over-long input is
// truncated rather than rejected since telemetry strings are display-only).
export function normalizeOptionalString(
  value: unknown,
  fieldName: string,
  { maxLength = 256 }: { maxLength?: number } = {}
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') fail(`${fieldName} must be a string when present`);
  const normalized = value.trim();
  if (!normalized.length) return null;
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

export function normalizeFiniteNumber(value: unknown, fieldName: string): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) fail(`${fieldName} must be a finite number`);
  return n;
}

export function normalizeOptionalFiniteNumber(value: unknown, fieldName: string): number | null {
  if (value === null || value === undefined) return null;
  return normalizeFiniteNumber(value, fieldName);
}

// An array with a hard element cap (defence against memory abuse from a
// misbehaving or hostile remote client).
export function normalizeBoundedArray(
  value: unknown,
  fieldName: string,
  { maxItems }: { maxItems: number }
): unknown[] {
  if (!Array.isArray(value)) fail(`${fieldName} must be an array`);
  if (value.length > maxItems) fail(`${fieldName} exceeds the maximum of ${maxItems} items`);
  return value;
}

// Identifier safe to use in Socket.IO room names, DOM ids/attributes and CSS
// selectors: letters, digits, dash, underscore, dot and colon only.
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export function normalizeIdentifier(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') fail(`${fieldName} must be a string`);
  const normalized = value.trim();
  if (!IDENTIFIER_PATTERN.test(normalized)) {
    fail(`${fieldName} must be 1-64 characters of [A-Za-z0-9._:-]`);
  }
  return normalized;
}
