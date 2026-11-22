// Concatenates the per-surface CSS parts (src/UI/css/parts/*.css, in filename
// order) into src/UI/css/main.css, which copy-assets.js then copies to
// dist/UI/css/main.css and build-webui.js copies to the Web UI surface. Edit the
// parts, NOT main.css (it is regenerated on every build). The concatenation is
// shared/scripts/build-css.js, shared with ShowTrak Timers.
const path = require('node:path');

require('../shared/scripts/build-css').buildCss({ root: path.resolve(__dirname, '..') });
