const { FusesPlugin } = require("@electron-forge/plugin-fuses");
const { FuseV1Options, FuseVersion } = require("@electron/fuses");
// const { Config } = require('./Modules/Config');

module.exports = {
	packagerConfig: {
		asar: true,
		// TODO(macOS): Provide a macOS ICNS icon (e.g., ./src/images/icon.icns) and set a platform-conditional icon or base path without extension.
		// Note: Folder name case "Images" vs "images" can break on case-sensitive filesystems. Standardize to one.
		icon: "./src/Images/icon.ico",
	},
	rebuildConfig: {},
	makers: [
		// TODO(macOS): Add makers for macOS distribution.
		// - @electron-forge/maker-dmg for signed releases
		// - @electron-forge/maker-zip for unsigned testing builds
		// Example:
		// {
		//   name: "@electron-forge/maker-dmg",
		//   config: { format: "ULFO" }
		// },
		// { name: "@electron-forge/maker-zip", platforms: ["darwin"] }
		{
			name: "@electron-forge/maker-squirrel",
			// TODO(macOS): Restrict this maker to Windows only to avoid cross-platform noise.
			// Example: add `platforms: ["win32"]` once you add mac makers above.
			config: {
				// An URL to an ICO file to use as the application icon (displayed in Control Panel > Programs and Features).
				iconUrl: "https://tkw.bz/img/ShowTrak.ico",
				// The ICO file to use as the icon for the generated Setup.exe
				setupIcon: "./src/Images/icon.ico",
			},
		},
	],
	plugins: [
		{
			name: "@electron-forge/plugin-auto-unpack-natives",
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
