// Monitored applications: the entry a client holds per application it must keep
// running, and its kind descriptor (see ./critical-kind).
//
// An entry is read from two shapes: a stored row (ApplicationKey,
// ApplicationName, and 0/1 condition columns) and a client-side record (Name,
// Key and boolean conditions). Both normalise to the same entry, so the
// manager's index and the Client always hold identical values.
import type { CriticalKind } from './critical-kind';
import { AsRecord, normalizeApplicationKey, normalizeApplicationName } from './normalizers';

export interface CriticalApplicationEntry {
  Name: string;
  Key: string;
  Timestamp: number | null;
  // Fault when another application holds the focused window.
  RequireForeground: boolean;
  // Fault when its windows stop answering the operating system.
  RequireResponding: boolean;
}

// A condition flag from either shape: a boolean, or a stored 0/1.
function Flag(Value: unknown, WhenAbsent: boolean): boolean {
  if (Value === undefined || Value === null) return WhenAbsent;
  if (typeof Value === 'boolean') return Value;
  return Number(Value) === 1;
}

export function normalizeCriticalApplicationEntry(Value: unknown): CriticalApplicationEntry | null {
  const E = AsRecord(Value);
  const Name = normalizeApplicationName(E.Name ?? E.ApplicationName);
  // A stored row carries the key it was written under; keep it as-is so a row
  // always finds itself again.
  const StoredKey = typeof E.ApplicationKey === 'string' ? E.ApplicationKey.trim() : '';
  const Key = StoredKey || normalizeApplicationKey(Name);
  if (!Name || !Key) return null;
  return {
    Name,
    Key,
    Timestamp: Number(E.Timestamp) > 0 ? Number(E.Timestamp) : null,
    RequireForeground: Flag(E.RequireForeground, false),
    // Rows from before migration 57 have no column: it was always judged.
    RequireResponding: Flag(E.RequireResponding, true),
  };
}

export const APPLICATION_KIND: CriticalKind<CriticalApplicationEntry> = {
  KeyOf: (Entry) => Entry.Key,
  NormalizeKey: normalizeApplicationKey,
  NormalizeEntry: normalizeCriticalApplicationEntry,
  Messages: {
    KeyRequired: 'Application name is required',
    SaveFailed: 'Failed to save monitored application',
    RemoveFailed: 'Failed to remove monitored application',
    LookupFailed: 'Failed to determine monitored application status',
  },
};
