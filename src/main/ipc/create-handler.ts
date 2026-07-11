// IPC handler factory — standardizes the dominant main-process handler shape.
//
// There are two handler contracts in the registrars; keep new handlers on the
// matching one instead of inventing a third:
//
//   1. MUTATION handlers return the `[Err, Result]` tuple. Use `createTupleHandler`:
//        - validate/normalize raw renderer args (may throw -> validation tuple)
//        - call a manager method that returns `[Err, Result]`
//        - normalize to `[Err, null]` on failure / `[null, Result]` on success
//      On invalid input the handler resolves to `[message, invalidFallback]`
//      (`invalidFallback` defaults to `null`; pass `false` when the renderer
//      treats the payload slot as a boolean success flag — e.g. the Delete/*
//      and Adopt/Replace handlers).
//
//   2. READER handlers return a RAW value (an object, list, or `null`) rather
//      than a tuple, because the renderer consumes the value directly. These
//      stay hand-rolled: validate in a `try`, and on invalid input OR a manager
//      error resolve to the type's empty fallback — `null` for a single object,
//      `[]` for a list. Do NOT route them through `createTupleHandler` (it would
//      wrap the value in a tuple and break the renderer contract).
//
// This removes the repeated try/catch + tuple boilerplate that was copy-pasted
// across the RPC.handle registrations in src/main.ts. Behavior is identical to
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
