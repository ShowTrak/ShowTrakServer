// Copies Bootstrap Icons font and CSS from node_modules into src/UI/vendors for local serving
const fs = require('fs');
const path = require('path');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyDir(srcDir, destDir) {
  ensureDir(destDir);
  for (const entry of fs.readdirSync(srcDir)) {
    const s = path.join(srcDir, entry);
    const d = path.join(destDir, entry);
    const stat = fs.statSync(s);
    if (stat.isDirectory()) copyDir(s, d);
    else copyFile(s, d);
  }
}

const SRC_ROOT = path.resolve(__dirname, '..');
const NODE_ROOT = path.join(SRC_ROOT, 'node_modules', 'bootstrap-icons');
const UI_VENDOR_ROOT = path.join(SRC_ROOT, 'src', 'UI', 'vendors', 'bootstrap-icons');

try {
  // Copy full font folder and the main CSS files
  copyDir(path.join(NODE_ROOT, 'font'), path.join(UI_VENDOR_ROOT, 'font'));
  // Copy unminified and minified CSS for flexibility
  copyFile(
    path.join(NODE_ROOT, 'font', 'bootstrap-icons.css'),
    path.join(UI_VENDOR_ROOT, 'font', 'bootstrap-icons.css')
  );
  copyFile(
    path.join(NODE_ROOT, 'font', 'bootstrap-icons.min.css'),
    path.join(UI_VENDOR_ROOT, 'font', 'bootstrap-icons.min.css')
  );
  console.log('[postinstall] Copied Bootstrap Icons to UI/vendors/bootstrap-icons');
} catch (e) {
  console.warn('[postinstall] Failed to copy Bootstrap Icons:', e.message);
}
