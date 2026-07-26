const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const path = require('node:path');
const fs = require('node:fs');
// const { Config } = require('./Modules/Config');

const appleSignIdentity = process.env.APPLE_SIGN_IDENTITY;
const appleSigningKeychain = process.env.APPLE_KEYCHAIN_PATH;
const shouldSignMac = Boolean(appleSignIdentity);
const shouldNotarizeMac =
  shouldSignMac &&
  Boolean(
    process.env.APPLE_API_KEY_PATH &&
    process.env.APPLE_API_KEY_ID &&
    process.env.APPLE_API_ISSUER_ID
  );

module.exports = {
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
      // Source & build inputs — assets are served from dist/ (see
      // src/Modules/Server/index.ts resolving __dirname/../../WebUI); the app
      // icon is read from disk at package time, not from the asar.
      /^\/src($|\/)/,
      // shared/ is the @showtrak/protocol submodule. With derefSymlinks the
      // package ships as real files under node_modules/@showtrak/protocol, so
      // this second copy at the top level is dead weight — drop it wholesale.
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
      // Repo/tooling directories.
      /^\/\.github($|\/)/,
      /^\/\.husky($|\/)/,
      /^\/\.vscode($|\/)/,
      /^\/\.claude($|\/)/,
      // Config & docs.
      /^\/tsconfig.*\.json$/,
      /^\/eslint\.config\.mjs$/,
      /^\/\.prettier/,
      /^\/\.gitignore$/,
      /^\/(README|TODO)\.md$/,
      /^\/package-lock\.json$/,
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
    ...(shouldSignMac
      ? {
          osxSign: {
            identity: appleSignIdentity,
            ...(appleSigningKeychain ? { keychain: appleSigningKeychain } : {}),
            hardenedRuntime: true,
            entitlements: path.resolve(__dirname, 'build/entitlements.mac.plist'),
            entitlementsInherit: path.resolve(__dirname, 'build/entitlements.mac.plist'),
            gatekeeperAssess: false,
            strictVerify: true,
          },
        }
      : {}),
    ...(shouldNotarizeMac
      ? {
          osxNotarize: {
            tool: 'notarytool',
            appleApiKey: process.env.APPLE_API_KEY_PATH,
            appleApiKeyId: process.env.APPLE_API_KEY_ID,
            appleApiIssuer: process.env.APPLE_API_ISSUER_ID,
          },
        }
      : {}),
  },
  rebuildConfig: {},
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
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['linux'],
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
    // 3.16.2 shipped a Windows build whose @showtrak/protocol was an unusable
    // link (see derefSymlinks above) and nothing caught it until the app failed
    // to boot on a user's machine. The dependency resolves by bare specifier, so
    // a broken copy is invisible until runtime — assert the real files are in
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
    },
  },
};
