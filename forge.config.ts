import type { ForgeConfig } from '@electron-forge/shared-types';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import path from 'node:path';
import fs from 'node:fs';
// const { Config } = require('./Modules/Config');

// shared/scripts/trim-electron-locales.js, a CommonJS build script the ShowTrak
// apps share (scripts stay JavaScript). It is required lazily, inside the hook
// that uses it, as before.
interface TrimElectronLocalesModule {
  trimElectronLocales(buildPath: string): number;
}

const appleSignIdentity = process.env.APPLE_SIGN_IDENTITY;
const appleSigningKeychain = process.env.APPLE_KEYCHAIN_PATH;
const appleApiKeyPath = process.env.APPLE_API_KEY_PATH;
const appleApiKeyId = process.env.APPLE_API_KEY_ID;
const appleApiIssuerId = process.env.APPLE_API_ISSUER_ID;
const shouldSignMac = Boolean(appleSignIdentity);
const shouldNotarizeMac =
  shouldSignMac && !!appleApiKeyPath && !!appleApiKeyId && !!appleApiIssuerId;

// macOS signing options. hardenedRuntime, entitlements, entitlementsInherit and
// gatekeeperAssess are options of @electron/osx-sign before 1.0; since then it
// reads per-file settings from optionsForFile() only. It ignores these four, so
// the app is signed with osx-sign's default entitlements (hardened runtime on),
// not build/entitlements.mac.plist. They are kept as they were: passing them
// through optionsForFile() instead would change how the app is signed.
const osxSignOptions = {
  identity: appleSignIdentity,
  ...(appleSigningKeychain ? { keychain: appleSigningKeychain } : {}),
  hardenedRuntime: true,
  entitlements: path.resolve(import.meta.dirname, 'build/entitlements.mac.plist'),
  entitlementsInherit: path.resolve(import.meta.dirname, 'build/entitlements.mac.plist'),
  gatekeeperAssess: false,
  strictVerify: true,
};

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    // Copy the *contents* of symlinks rather than the links themselves.
    //
    // node_modules/@showtrak/protocol is npm's link for the `file:./shared`
    // dependency. Left as a link, Electron Packager hands it to @electron/asar,
    // which stores a `link` entry -- and on Windows npm creates a *junction*
    // whose readlink is an absolute path, so the recorded target came out as the
    // nonsense `node_modules\@showtrak\D:\a\ShowTrakServer\ShowTrakServer\shared`
    // (3.16.2 shipped exactly that). Every
    // `require('@showtrak/protocol/runtime')` then threw MODULE_NOT_FOUND on
    // boot, while macOS and Linux worked because their relative symlinks
    // happened to resolve inside the archive.
    //
    // Dereferencing sidesteps the platform difference entirely: the package
    // lands in the asar as a real directory on all three targets.
    derefSymlinks: true,
    // Keep the asar lean: only `dist/`, production `node_modules`, and
    // package.json are needed at runtime. Without an ignore list, Electron
    // Packager bundles the entire project tree (src/, coverage/, test/, source
    // maps, dotfiles), roughly doubling the asar. Top-level dirs are anchored
    // with `^/` so we don't accidentally match paths inside node_modules.
    ignore: [
      // Source & build inputs: assets are served from dist/ (see
      // src/Modules/Server/index.ts resolving __dirname/../../WebUI); the app
      // icon is read from disk at package time, not from the asar.
      /^\/src($|\/)/,
      // shared/ is the @showtrak/protocol submodule. With derefSymlinks the
      // package ships as real files under node_modules/@showtrak/protocol, so
      // this second copy at the top level is dead weight; drop it wholesale.
      /^\/shared($|\/)/,
      // ...and inside the dereferenced copy, ship exactly what Node needs to
      // resolve `@showtrak/protocol/runtime`: package.json for the exports map
      // and the compiled dist/. The .d.ts sources, tsconfigs, LICENSE and
      // README are build-time only.
      /^\/node_modules\/@showtrak\/protocol\/(?!dist(\/|$)|package\.json$)/,
      /^\/scripts($|\/)/,
      /^\/build($|\/)/,
      // Tests & coverage reports. dist-test/ is the test-only per-file compile
      // of the renderer (tsconfig.renderer.test.json); the app runs the esbuild
      // bundle in dist/, so this must never ship.
      /^\/test($|\/)/,
      /^\/test-support($|\/)/,
      /^\/dist-test($|\/)/,
      /^\/coverage($|\/)/,
      // Forge's own output folder. Packager skips the folder Forge is writing
      // to, but with ELECTRON_FORGE_OUT_DIR pointed elsewhere a leftover out/
      // from an earlier build would otherwise be copied into the new app.
      /^\/out($|\/)/,
      // Repo/tooling directories.
      /^\/\.github($|\/)/,
      /^\/\.husky($|\/)/,
      /^\/\.vscode($|\/)/,
      /^\/\.claude($|\/)/,
      // Config & docs.
      /^\/tsconfig.*\.json$/,
      /^\/(eslint|forge)\.config\.ts$/,
      /^\/\.prettier/,
      /^\/\.gitignore$/,
      /^\/(README|TODO|DEVELOPMENT)\.md$/,
      /^\/package-lock\.json$/,
      // The main process ships as one bundle, dist/main.bundle.js, loaded by
      // dist/boot.js (scripts/build-main.js). The per-file tsc output it was
      // built from is for the test suite and is never loaded by the app.
      /^\/dist\/(Modules|main|types|common)($|\/)/,
      /^\/dist\/(entry|main)\.js$/,
      // Source maps are debug-only; strip from release builds.
      /\.map$/,
      // Cruft.
      /\.DS_Store$/,
    ],
    // Keep the runtime binary name stable across platforms so Linux makers
    // can reliably locate it when building deb/rpm packages.
    executableName: 'showtrak-server',
    // Use extensionless base path so Electron Packager can resolve
    // platform-specific icon formats (.icns on macOS, .ico on Windows).
    icon: './src/images/icon',
    // macOS Local Network privacy: Bonjour discovery is raw multicast on UDP
    // 5353, which macOS blocks for an app that has not been granted Local
    // Network access. This string is what the permission prompt shows.
    extendInfo: {
      NSLocalNetworkUsageDescription:
        'ShowTrak Server needs local network access to advertise itself to ShowTrak Clients and to monitor devices on your network.',
      // .ShowTrak show files open in ShowTrak Server from Finder (double-click,
      // Open With, dropping on the Dock icon). The type is exported here, as
      // ShowTrak Server owns the format; the app receives the file through
      // 'open-file' (src/main/file-associations.ts). Windows registers the same
      // association from the Squirrel install hooks in that file.
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: 'ShowTrak Show File',
          CFBundleTypeRole: 'Editor',
          LSHandlerRank: 'Owner',
          LSItemContentTypes: ['uk.co.showtrak.show'],
        },
      ],
      UTExportedTypeDeclarations: [
        {
          UTTypeIdentifier: 'uk.co.showtrak.show',
          UTTypeDescription: 'ShowTrak Show File',
          UTTypeConformsTo: ['public.data'],
          UTTypeTagSpecification: {
            'public.filename-extension': ['showtrak'],
          },
        },
      ],
    },
    ...(shouldSignMac ? { osxSign: osxSignOptions } : {}),
    ...(shouldNotarizeMac
      ? {
          // notarytool is the only tool @electron/notarize has (since v2), so
          // it no longer takes the `tool: 'notarytool'` this used to pass.
          osxNotarize: {
            appleApiKey: appleApiKeyPath,
            appleApiKeyId: appleApiKeyId,
            appleApiIssuer: appleApiIssuerId,
          },
        }
      : {}),
  },
  // On ARM64 Linux (the Raspberry Pi build) sqlite3 is compiled against
  // Electron's headers rather than downloaded: its prebuilt linux-arm64 binary
  // is linked against glibc 2.38, and Raspberry Pi OS 12 (Bookworm) has 2.36, so
  // the app would install there and then fail to open its database. The release
  // workflow builds ARM64 on ubuntu-22.04-arm (glibc 2.35), and
  // scripts/check-linux-packages.sh fails the release if any binary in the
  // package needs more than 2.36. Elsewhere the prebuilt binary is kept.
  rebuildConfig:
    process.platform === 'linux' && process.arch === 'arm64' ? { buildFromSource: true } : {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        // An URL to an ICO file to use as the application icon (displayed in Control Panel > Programs and Features).
        iconUrl: 'https://tkw.bz/img/ShowTrak.ico',
        // The ICO file to use as the icon for the generated Setup.exe
        setupIcon: './src/images/icon.ico',
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
      config: {},
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['linux'],
      config: {},
    },
    {
      name: '@electron-forge/maker-deb',
      platforms: ['linux'],
      config: {
        options: {
          bin: 'showtrak-server',
        },
      },
    },
    {
      name: '@electron-forge/maker-rpm',
      platforms: ['linux'],
      config: {
        options: {
          bin: 'showtrak-server',
        },
      },
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
  hooks: {
    // Drop Chromium's UI translations (~45 MB) before the app is copied in and
    // signed; the UI is English and Chromium falls back to en-US. See
    // shared/scripts/trim-electron-locales.js.
    packageAfterExtract: async (_forgeConfig, buildPath) => {
      const { trimElectronLocales } =
        require('./shared/scripts/trim-electron-locales') as TrimElectronLocalesModule;
      const removed = trimElectronLocales(buildPath);
      console.log(`[forge] Removed ${removed} unused Chromium locale pack(s)`);
    },
    // When sqlite3 is compiled (ARM64 Linux, see rebuildConfig), node-gyp leaves
    // its working files beside the addon: the SQLite source, object files and
    // two more copies of the binary, about 25 MB the app never reads. Keep only
    // build/Release/node_sqlite3.node, which is what sqlite3 loads and all that
    // a downloaded prebuilt binary brings. Runs after the rebuild, before the
    // asar is made.
    packageAfterPrune: async (_forgeConfig, buildPath) => {
      const sqlite3 = path.join(buildPath, 'node_modules', 'sqlite3');
      const release = path.join(sqlite3, 'build', 'Release');
      if (!fs.existsSync(path.join(release, 'node_sqlite3.node'))) return;
      const remove = (target: string) => fs.rmSync(target, { recursive: true, force: true });
      remove(path.join(sqlite3, 'bin'));
      for (const entry of fs.readdirSync(path.dirname(release))) {
        if (entry !== 'Release') remove(path.join(path.dirname(release), entry));
      }
      for (const entry of fs.readdirSync(release)) {
        if (entry !== 'node_sqlite3.node') remove(path.join(release, entry));
      }
    },
    // 3.16.2 shipped a Windows build whose @showtrak/protocol was an unusable
    // link (see derefSymlinks above) and nothing caught it until the app failed
    // to boot on a user's machine. The dependency resolves by bare specifier, so
    // a broken copy is invisible until runtime, so assert the real files are in
    // the staged tree, on every platform, before it gets sealed into the asar.
    packageAfterCopy: async (_forgeConfig, buildPath) => {
      const pkgDir = path.join(buildPath, 'node_modules', '@showtrak', 'protocol');
      // lstat, not stat: a surviving symlink is the failure we are guarding
      // against, and it would follow through to the real file on the build host.
      const linkStat = fs.lstatSync(pkgDir, { throwIfNoEntry: false });
      if (!linkStat?.isDirectory()) {
        throw new Error(
          `Packaging aborted: ${pkgDir} is ${linkStat ? 'a link, not a real directory' : 'missing'}. ` +
            'The @showtrak/protocol dependency must be dereferenced into the package.'
        );
      }
      for (const rel of [['package.json'], ['dist', 'runtime', 'index.js']]) {
        const file = path.join(pkgDir, ...rel);
        if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) {
          throw new Error(
            `Packaging aborted: ${file} is missing from the staged app. ` +
              'require("@showtrak/protocol/runtime") would throw at boot.'
          );
        }
      }
      // The app boots from the main-process bundle; the per-file output is left
      // out (see `ignore`), so a missing bundle would be an app with no main
      // process at all.
      for (const rel of [
        ['dist', 'boot.js'],
        ['dist', 'main.bundle.js'],
      ]) {
        const file = path.join(buildPath, ...rel);
        if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) {
          throw new Error(
            `Packaging aborted: ${file} is missing from the staged app. ` +
              'Run `npm run build` (it bundles the main process) before packaging.'
          );
        }
      }
    },
  },
};

export default config;
