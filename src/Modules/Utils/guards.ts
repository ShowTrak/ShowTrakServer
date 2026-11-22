// Type guards for values of unknown type: JSON just parsed, a socket or IPC
// payload, a caller's loosely shaped argument.
//
// Array.isArray narrows `unknown` to `any[]`, after which nothing read from the
// array is checked at all. IsArray narrows to `unknown[]` instead, so every
// element still has to be narrowed before it is used. IsObject is the usual
// next step for an element: an object whose fields can be read one by one.
//
// The renderer has the same pair in src/UI/js/app/lib/guards.ts, as it is
// compiled and bundled apart from the main process.

/** `Array.isArray`, narrowing to `unknown[]` rather than `any[]`. */
export function IsArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Whether fields can be read from a value: any object (arrays included), but not
 * null or a primitive. Narrows to a record of unknown values.
 */
export function IsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
