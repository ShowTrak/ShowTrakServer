// The `[Err, Data]` tuple convention returned by all ShowTrak manager methods.

/** A successful manager result: `[null, value]`. */
export type Ok<T> = [null, T];

/** A failed manager result: `[errorMessage, null]`. */
export type Failure = [string, null];

/**
 * The `[Err, Data]` tuple returned by ShowTrak manager public methods.
 * Produced via `Utils.Ok(value)` / `Utils.Fail(error)`.
 */
export type Result<T> = Ok<T> | Failure;
