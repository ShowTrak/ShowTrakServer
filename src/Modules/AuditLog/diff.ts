// Field-by-field diffs for audit log edit entries (pure).
//
// Managers snapshot an entity before an edit and hand both snapshots here with
// the fields worth reporting; what comes back is already formatted for
// reading, so the renderer never needs to know what a field means.
import type { AuditChange } from '@showtrak/protocol';

export interface FieldSpec<T> {
  Key: keyof T & string;
  Label: string;
  // Formats a raw value for display. Returning null reads as "none".
  Format?: (Value: unknown, Entity: T) => string | null;
  // A secret is reported as changed without either value.
  Secret?: boolean;
}

export function FormatValue(Value: unknown): string | null {
  if (Value === null || Value === undefined) return null;
  if (typeof Value === 'boolean') return Value ? 'On' : 'Off';
  if (typeof Value === 'number') return Number.isFinite(Value) ? String(Value) : null;
  if (typeof Value === 'string') {
    const Trimmed = Value.trim();
    return Trimmed ? Trimmed : null;
  }
  if (Array.isArray(Value)) {
    const Items = Value.map(FormatValue).filter((Item): Item is string => !!Item);
    return Items.length ? Items.join(', ') : null;
  }
  try {
    return JSON.stringify(Value);
  } catch {
    return String(Value);
  }
}

export function DiffFields<T>(
  Before: T | null | undefined,
  After: T | null | undefined,
  Specs: readonly FieldSpec<T>[]
): AuditChange[] {
  if (!Before || !After) return [];
  const Changes: AuditChange[] = [];
  for (const Spec of Specs) {
    const Format = Spec.Format || ((Value: unknown) => FormatValue(Value));
    const From = Format(Before[Spec.Key], Before);
    const To = Format(After[Spec.Key], After);
    if (From === To) continue;
    Changes.push(
      Spec.Secret
        ? { Field: Spec.Label, From: null, To: 'Changed' }
        : { Field: Spec.Label, From, To }
    );
  }
  return Changes;
}

// A shallow copy of the named fields, taken before an in-place edit so the
// diff has something to compare against. Arrays and plain objects are copied
// one level deep, which is enough for every field the managers report.
export function Snapshot<T extends object>(Entity: T, Keys: readonly (keyof T)[]): T {
  const Copy = {} as T;
  for (const Key of Keys) {
    const Value = Entity[Key];
    Copy[Key] = (
      Array.isArray(Value)
        ? [...Value]
        : Value && typeof Value === 'object'
          ? { ...(Value as object) }
          : Value
    ) as T[keyof T];
  }
  return Copy;
}
