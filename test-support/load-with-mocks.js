const Module = require('node:module');
const path = require('node:path');

function loadWithMocks(modulePath, mocks) {
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
