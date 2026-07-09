// IPC handler factory — standardizes the dominant main-process handler shape:
//
//   1. Validate/normalize raw renderer args (may throw -> validation error tuple)
//   2. Call a manager method that returns an [Err, Result] tuple
//   3. Normalize the response to [Err, null] on failure / [null, Result] on success
//
// This removes the repeated try/catch + tuple boilerplate that was copy-pasted
// across ~70 RPC.handle registrations in src/main.ts. Behavior is identical to
// the original inline handlers; only the wrapping is shared.
import type { Result } from '../../types/result';

// Convert a thrown validation error into the renderer's [message, fallback]
// contract.
function validationErrorTuple(error: unknown, fallback: unknown = null): [string, unknown] {
  const message =
    error && typeof error === 'object' && 'message' in error && (error as Error).message
      ? (error as Error).message
      : String(error || 'Invalid request');
  return [message, fallback];
}

// validate: optional (...rawArgs) => normalizedArg | normalizedArgs[]
//           Throwing rejects the request via validationErrorTuple.
// run:      (...normalizedArgs) => Promise<[Err, Result]>
// options.invalidFallback: value paired with the error message when validation
//           fails (defaults to null; some handlers used `false`).
function createTupleHandler<A extends unknown[], R>(
  validate: ((...rawArgs: unknown[]) => A | A[number]) | null | undefined,
  run: (...args: A) => Promise<Result<R>> | Result<R>,
  { invalidFallback = null }: { invalidFallback?: unknown } = {}
) {
  return async (_event: unknown, ...args: unknown[]): Promise<[string | null, R | null]> => {
    let normalized = args as A;
    if (typeof validate === 'function') {
      try {
        const result = validate(...args);
        normalized = (Array.isArray(result) ? result : [result]) as A;
      } catch (error) {
        return validationErrorTuple(error, invalidFallback) as [string, R | null];
      }
    }
    const [Err, Value] = await run(...normalized);
    if (Err) return [Err, null];
    return [null, Value];
  };
}

export { createTupleHandler, validationErrorTuple };
