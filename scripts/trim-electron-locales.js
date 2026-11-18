// Removes Chromium's UI translations that this app never shows.
//
// Electron ships one Chromium locale pack per language (~55 of them, plus
// gendered variants on macOS) — about 45 MB, a sixth of the installed app. They
// translate Chromium's own strings (context menus, dialogs, error pages); the
// app's UI is English and does not use them. Chromium falls back to en-US when
// the system language's pack is missing, so removing the others changes nothing
// a user sees.
//
// Called from forge.config.js (packageAfterExtract), i.e. on the freshly
// extracted Electron, before the app is copied in and before macOS signing.
//
//   Windows / Linux: <build>/locales/<lang>.pak
//   macOS:           <build>/<App>.app/Contents/Frameworks/Electron Framework.framework/
//                    Versions/A/Resources/<lang>.lproj/locale.pak
//
// The app bundle's own (empty) Contents/Resources/*.lproj directories are left
// alone: they only tell macOS which languages the app claims to support.
const fs = require('node:fs');
const path = require('node:path');

// Chromium's names for the packs kept. en-US is the fallback and must stay.
const KEEP_PAKS = new Set(['en-US.pak', 'en-GB.pak']);
const KEEP_LPROJ = /^en(_GB)?(_(FEMININE|MASCULINE|NEUTER))?\.lproj$/;

function trimPakDirectory(dir) {
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.pak') || KEEP_PAKS.has(name)) continue;
    fs.rmSync(path.join(dir, name), { force: true });
    removed += 1;
  }
  return removed;
}

function trimFrameworkResources(dir) {
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.lproj') || KEEP_LPROJ.test(name)) continue;
    const full = path.join(dir, name);
    // Only Chromium's locale packs: anything else in Resources is not ours to touch.
    if (!fs.existsSync(path.join(full, 'locale.pak'))) continue;
    fs.rmSync(full, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/** Trim every locale directory under `buildPath`. Returns how many were removed. */
function trimElectronLocales(buildPath) {
  let removed = 0;
  const pakDir = path.join(buildPath, 'locales');
  if (fs.existsSync(pakDir)) removed += trimPakDirectory(pakDir);

  for (const entry of fs.readdirSync(buildPath)) {
    if (!entry.endsWith('.app')) continue;
    const resources = path.join(
      buildPath,
      entry,
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Versions',
      'A',
      'Resources'
    );
    if (fs.existsSync(resources)) removed += trimFrameworkResources(resources);
  }

  // Never ship an Electron without its fallback pack: a mismatch here means the
  // layout changed under us, and an app that cannot load en-US shows blank
  // menus and dialogs.
  if (fs.existsSync(pakDir) && !fs.existsSync(path.join(pakDir, 'en-US.pak'))) {
    throw new Error(`trim-electron-locales: ${pakDir} has no en-US.pak`);
  }
  return removed;
}

module.exports = { trimElectronLocales, KEEP_PAKS, KEEP_LPROJ };
