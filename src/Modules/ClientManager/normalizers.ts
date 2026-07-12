// Shared field normalizers for the ClientManager (used by both the manager
// (index.ts) and the in-memory Client (client.ts)). These were previously
// duplicated — and, for application names, re-implemented inline — in both
// files; keeping one copy guarantees the manager index and the Client view
// normalize identical telemetry the same way.

export type UnknownRecord = Record<string, unknown>;

// Narrow an unknown value to a plain-object view for defensive field reads.
// Non-objects (including null) collapse to `{}`, mirroring the historical
// `Value && typeof Value === 'object' ? Value : {}` guards.
export function AsRecord(Value: unknown): UnknownRecord {
  return typeof Value === 'object' && Value !== null ? (Value as UnknownRecord) : {};
}

// USB serial numbers are matched case-insensitively and stored upper-cased.
export function normalizeSerialNumber(SerialNumber: unknown): string | null {
  if (typeof SerialNumber !== 'string') return null;
  const Value = SerialNumber.trim();
  if (!Value) return null;
  return Value.toUpperCase();
}

// The visible label for a USB device, mirroring how the renderer composes the
// card heading: manufacturer falls back to "Generic", product to "USB Device".
// Serial-less critical devices are identified by this label (see below).
export function buildUSBDeviceLabel(manufacturer: unknown, product: unknown): string {
  const M =
    typeof manufacturer === 'string' && manufacturer.trim() ? manufacturer.trim() : 'Generic';
  const P = typeof product === 'string' && product.trim() ? product.trim() : 'USB Device';
  return `${M} ${P}`;
}

// Lookup key for a serial-less critical USB device: the visible label, lower
// cased for case-insensitive matching against the critical-name index.
export function normalizeUSBNameKey(manufacturer: unknown, product: unknown): string {
  return buildUSBDeviceLabel(manufacturer, product).toLowerCase();
}

// Application display name: trimmed, case preserved (null when empty/non-string).
export function normalizeApplicationName(Name: unknown): string | null {
  if (typeof Name !== 'string') return null;
  const Value = Name.trim();
  if (!Value) return null;
  return Value;
}

// Application lookup key: the normalized name, lower-cased for case-insensitive
// matching against the critical-applications index.
export function normalizeApplicationKey(Name: unknown): string | null {
  const Value = normalizeApplicationName(Name);
  if (!Value) return null;
  return Value.toLowerCase();
}

// Display identifiers may arrive as numbers or strings; normalize to a trimmed
// string (null when empty/absent).
export function normalizeDisplayID(DisplayID: unknown): string | null {
  if (DisplayID === null || DisplayID === undefined) return null;
  const Value = String(DisplayID).trim();
  if (!Value) return null;
  return Value;
}
