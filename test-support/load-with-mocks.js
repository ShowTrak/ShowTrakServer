const Module = require('node:module');
const path = require('node:path');

/**
 * Load a module with its `require` calls intercepted by `mocks` (keyed on the
 * literal request string).
 *
 * `alsoEvict` names modules OUTSIDE the target's own folder that must be
 * re-loaded too. It matters whenever the target delegates to a shared module
 * that reads the same mocked dependencies: that module captures the FIRST
 * test's mocks at require time and, being cached, serves them to every
 * subsequent load. The symptom is a suite where the early tests pass and the
 * later ones assert against stale settings — which is exactly how it presented
 * when the capability model moved out of webui-namespace into RemoteAccess.
 */
function loadWithMocks(modulePath, mocks, { alsoEvict = [] } = {}) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];

  // A module may be split across sibling helper files in the same folder
  // (e.g. index.js requiring ./client). Clear those from the cache too so each
  // load picks up the freshly supplied mocks instead of a stale capture.
  const moduleDir = path.dirname(resolved);
  for (const cachedPath of Object.keys(require.cache)) {
    if (cachedPath !== resolved && cachedPath.startsWith(moduleDir + path.sep)) {
      delete require.cache[cachedPath];
    }
  }

  for (const extra of alsoEvict) {
    try {
      delete require.cache[require.resolve(extra)];
    } catch {
      /* intentional: a module that cannot be resolved was never cached either */
    }
  }

  const originalLoad = Module._load;
  Module._load = function patchedLoader(request, _parent, _isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

module.exports = {
  loadWithMocks,
};
