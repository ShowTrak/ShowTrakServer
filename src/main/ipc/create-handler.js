// IPC handler factory — standardizes the dominant main-process handler shape:
//
//   1. Validate/normalize raw renderer args (may throw -> validation error tuple)
//   2. Call a manager method that returns an [Err, Result] tuple
//   3. Normalize the response to [Err, null] on failure / [null, Result] on success
//
// This removes the repeated try/catch + tuple boilerplate that was copy-pasted
// across ~70 RPC.handle registrations in src/main.js. Behavior is identical to
// the original inline handlers; only the wrapping is shared.

// Convert a thrown validation error into the renderer's [message, fallback]
// contract. Mirrors the original main.js helper exactly.
function validationErrorTuple(error, fallback = null) {
  const message = error && error.message ? error.message : String(error || 'Invalid request');
  return [message, fallback];
}

// validate: optional (...rawArgs) => normalizedArg | normalizedArgs[]
//           Throwing rejects the request via validationErrorTuple.
// run:      (...normalizedArgs) => Promise<[Err, Result]>
// options.invalidFallback: value paired with the error message when validation
//           fails (defaults to null; some handlers used `false`).
function createTupleHandler(validate, run, { invalidFallback = null } = {}) {
  return async (_event, ...args) => {
    let normalized = args;
    if (typeof validate === 'function') {
      try {
        const result = validate(...args);
        normalized = Array.isArray(result) ? result : [result];
      } catch (error) {
        return validationErrorTuple(error, invalidFallback);
      }
    }
    const [Err, Result] = await run(...normalized);
    if (Err) return [Err, null];
    return [null, Result];
  };
}

module.exports = { createTupleHandler, validationErrorTuple };
