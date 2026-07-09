// Builds the served Web UI page + assets into dist/WebUI.
//
// The Web UI reuses the SAME markup and renderer as the Electron desktop app.
// Rather than maintain a second HTML file (which is exactly how the old Web UI
// drifted), we DERIVE dist/WebUI/index.html from src/UI/index.html by swapping
// the desktop bundle <script> for the Socket.IO client + the web bundle, and by
// injecting the mobile/PWA <head> tags. The shared UI vendor/css/img/audio
// assets are copied alongside so the relative asset paths resolve when Express
// serves dist/WebUI at `/`.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC_UI = path.join(ROOT, 'src', 'UI');
const SRC_WEBUI = path.join(ROOT, 'src', 'WebUI');
const DIST_WEBUI = path.join(ROOT, 'dist', 'WebUI');

// Copy a directory recursively, never shipping TypeScript sources.
function copyDir(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const source = path.join(srcDir, entry.name);
    const destination = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDir(source, destination);
    } else if (entry.isFile() && !entry.name.endsWith('.ts')) {
      fs.copyFileSync(source, destination);
    }
  }
}

// The desktop bundle <script> tag (single source of truth in src/UI/index.html).
const DESKTOP_BUNDLE_TAG = '<script src="./js/app/bundle.js" defer></script>';
// Socket.IO must load before the web bundle (web-main.ts uses the `io` global at
// module load); both are deferred so document order is preserved.
const WEB_BUNDLE_TAGS =
  '<script src="./vendors/socket.io/socket.io.min.js" defer></script>\n' +
  '    <script src="./main.js" defer></script>';

const DESKTOP_TITLE = '<title>ShowTrak Server</title>';
const WEB_HEAD =
  '<title>ShowTrak</title>\n' +
  '    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />\n' +
  '    <meta name="theme-color" content="#6d5bd0" />\n' +
  '    <link rel="manifest" href="/manifest.webmanifest" />\n' +
  '    <link rel="apple-touch-icon" href="/images/icon.png" />';

function buildIndexHtml() {
  const srcIndex = path.join(SRC_UI, 'index.html');
  let html = fs.readFileSync(srcIndex, 'utf8');

  if (!html.includes(DESKTOP_BUNDLE_TAG)) {
    throw new Error('[build-webui] Could not find the desktop bundle <script> tag to swap.');
  }
  html = html.replace(DESKTOP_BUNDLE_TAG, WEB_BUNDLE_TAGS);

  if (html.includes(DESKTOP_TITLE)) {
    html = html.replace(DESKTOP_TITLE, WEB_HEAD);
  }

  fs.mkdirSync(DIST_WEBUI, { recursive: true });
  fs.writeFileSync(path.join(DIST_WEBUI, 'index.html'), html);
}

function main() {
  // Shared renderer assets referenced by the (relative) markup.
  for (const dir of ['vendors', 'css', 'img', 'audio']) {
    copyDir(path.join(SRC_UI, dir), path.join(DIST_WEBUI, dir));
  }
  // Socket.IO client (web-only vendor).
  copyDir(
    path.join(SRC_WEBUI, 'vendors', 'socket.io'),
    path.join(DIST_WEBUI, 'vendors', 'socket.io')
  );

  buildIndexHtml();
  console.log('[build-webui] Wrote dist/WebUI/index.html + shared web assets');
}

main();
