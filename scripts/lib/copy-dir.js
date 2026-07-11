// Shared recursive directory copy used by the asset/Web UI build steps.
//
// TypeScript sources are NEVER shipped — esbuild owns the compiled renderer
// bundles (dist/UI/js/app/bundle.js, dist/WebUI/main.js), so any `.ts` file is
// skipped. Callers may additionally skip specific resolved directories/files.
const fs = require('node:fs');
const path = require('node:path');

/**
 * @param {string} srcDir
 * @param {string} destDir
 * @param {{ skipDirs?: Set<string>, skipFiles?: Set<string> }} [options]
 */
function copyDir(srcDir, destDir, options = {}) {
  const { skipDirs, skipFiles } = options;
  if (!fs.existsSync(srcDir)) return;
  if (skipDirs && skipDirs.has(path.resolve(srcDir))) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const source = path.join(srcDir, entry.name);
    const destination = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDir(source, destination, options);
    } else if (entry.isFile()) {
      if (entry.name.endsWith('.ts')) continue;
      if (skipFiles && skipFiles.has(path.resolve(source))) continue;
      fs.copyFileSync(source, destination);
    }
  }
}

module.exports = { copyDir };
