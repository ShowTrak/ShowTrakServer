// Test helper: intercept CommonJS `require` so main-process modules that pull in
// Electron or the sqlite-backed managers can be unit-tested in a plain Node
// process.
//
// The main/ layer (rpc.ts, the registrars) imports `electron/main` and the
// per-domain managers, which transitively drag in the native sqlite3 addon and
// the socket server — none of which exist under `node --test`. This installs a
// `Module._load` shim that returns caller-supplied stubs for matching request
// strings and defers everything else (create-handler, IPCValidation,
// handler-registry, rpc itself) to the real loader.
//
// Node's test runner executes each test file in its own child process, so the
// global shim installed here never leaks across files. Each test still restores
// the original loader in a `finally`/`after` for good measure.
const Module = require('node:module');

// mocks: Array<{ match: (request: string) => boolean, value: unknown }>.
// The first matching entry wins. Returns a restore() that undoes the patch.
function installModuleMocks(mocks) {
  const original = Module._load;
  Module._load = function patchedLoad(request) {
    for (const mock of mocks) {
      if (mock.match(request)) return mock.value;
    }
    return original.apply(this, arguments);
  };
  return function restore() {
    Module._load = original;
  };
}

// Convenience matcher: an exact request string, or a request that ends with the
// given suffix (so both `../rpc` style relative paths and bare specifiers work).
function matchesModule(suffix) {
  return (request) => request === suffix || request.endsWith(suffix);
}

// A recording stub whose every accessed property is a function that logs its
// call and returns a per-method canned value. `returns` maps method name ->
// value (or a function of the args). Unlisted methods return undefined.
function recordingManager(returns = {}) {
  const calls = [];
  const target = {
    __calls: calls,
    __callsTo(name) {
      return calls.filter((c) => c.method === name);
    },
  };
  return new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return obj[prop];
      if (typeof prop === 'symbol') return undefined;
      return (...args) => {
        calls.push({ method: prop, args });
        const canned = returns[prop];
        return typeof canned === 'function' ? canned(...args) : canned;
      };
    },
  });
}

module.exports = { installModuleMocks, matchesModule, recordingManager };
