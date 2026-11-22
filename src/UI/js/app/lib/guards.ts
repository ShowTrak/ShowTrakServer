// Type guards for values of unknown type in the renderer: IPC and socket
// payloads, dataset values, JSON from storage.
//
// Array.isArray narrows `unknown` to `any[]`, after which nothing read from the
// array is checked at all. IsArray narrows to `unknown[]` instead, so every
// element still has to be narrowed before it is used. IsObject is the usual
// next step for an element: an object whose fields can be read one by one.
//
// The main process has the same pair in src/Modules/Utils/guards.ts; the
// renderer is compiled and bundled apart from it.

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

/**
 * The value when it is an array, else an empty one: `Array.isArray(List) ? List
 * : []` for a list typed `readonly T[] | null | undefined`. Array.isArray
 * cannot narrow a readonly array type and widens its elements to `any`; this
 * keeps them `T`. The array is returned as it is, not copied.
 */
export function ArrayOrEmpty<T>(value: readonly T[] | null | undefined): readonly T[] {
  return IsArray(value) ? value : [];
}
