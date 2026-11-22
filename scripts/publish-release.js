// `npm run publish`: cuts a release. Dispatches the Build workflow against the
// current branch, waits for it, and confirms the release that appeared is
// published with its assets, after checking for what silently produces a WRONG
// release (uncommitted or unpushed work, an unpushed submodule commit, a commit
// CI has not passed, a version already published).
//
// The script is shared/scripts/publish-release.js, shared with ShowTrak Client
// and ShowTrak Timers; its header has the usage and options. Everything it
// needs (owner/repo, branch, version, submodules) is read from this checkout.
const path = require('node:path');

require('../shared/scripts/publish-release').main({ root: path.resolve(__dirname, '..') });
