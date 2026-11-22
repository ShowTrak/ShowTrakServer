// postinstall: copies the Bootstrap Icons font and CSS from node_modules into
// src/UI/vendors/bootstrap-icons for local serving, through
// shared/scripts/copy-bootstrap-icons.js (shared with ShowTrak Timers).
//
// The copied files are gitignored: package.json is the one place the version
// lives, so a Dependabot bump updates what ships. That makes this copy the ONLY
// source of the icons, so a failure fails the install rather than producing an
// app with blank icon glyphs. bootstrap-icons is a devDependency, so this needs
// a full install; it fails under `npm ci --omit=dev`.
const path = require('node:path');

require('../shared/scripts/copy-bootstrap-icons').main({ root: path.resolve(__dirname, '..') });
