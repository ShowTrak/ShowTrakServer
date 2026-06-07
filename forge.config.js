const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const path = require('node:path');
// const { Config } = require('./Modules/Config');

const appleSignIdentity = process.env.APPLE_SIGN_IDENTITY;
const shouldSignMac = Boolean(appleSignIdentity);
const shouldNotarizeMac =
  shouldSignMac &&
  Boolean(
    process.env.APPLE_API_KEY_PATH &&
      process.env.APPLE_API_KEY_ID &&
      process.env.APPLE_API_ISSUER_ID &&
      process.env.APPLE_TEAM_ID,
  );

module.exports = {
  packagerConfig: {
    asar: true,
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
            hardenedRuntime: true,
            entitlements: path.resolve(__dirname, 'build/entitlements.mac.plist'),
            entitlementsInherit: path.resolve(__dirname, 'build/entitlements.mac.plist'),
            gatekeeperAssess: false,
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
            teamId: process.env.APPLE_TEAM_ID,
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
};
