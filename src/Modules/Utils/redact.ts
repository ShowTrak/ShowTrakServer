// Schema-driven redaction of credential-bearing settings.
//
// A settings schema marks a field `Sensitive: true` (a device password, an SNMP
// community string, an API token) and any surface that must not hand those out
// runs the stored values through RedactSensitiveValues before serialising them.
// The flag lives on the field definition rather than in a list of key names so a
// new method that declares a password field is covered the moment it is flagged,
// with no second place to remember.
//
// Only non-empty values are replaced. An empty value is left as-is so a consumer
// can still tell "no password set" from "password set", which is the one thing
// about a credential worth knowing from outside.

export const REDACTED = '[redacted]';

export interface SensitivityFlaggedField {
  Key: string;
  Sensitive?: boolean;
}

export function IsSensitiveValuePresent(Value: unknown): boolean {
  return Value != null && String(Value) !== '';
}

export function RedactSensitiveValues(
  Fields: readonly SensitivityFlaggedField[] | null | undefined,
  Values: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const Out: Record<string, unknown> = { ...(Values || {}) };
  for (const Field of Fields || []) {
    if (!Field || !Field.Sensitive) continue;
    if (!Object.prototype.hasOwnProperty.call(Out, Field.Key)) continue;
    if (IsSensitiveValuePresent(Out[Field.Key])) Out[Field.Key] = REDACTED;
  }
  return Out;
}
