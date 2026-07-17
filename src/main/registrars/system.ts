// IPC registrar: system-level surface — config, web addresses, application mode,
// settings read/write, initial-state hydration ('Loaded'), external links,
// folders, and project dependency listing. Extracted verbatim from main.ts.

import { CreateLogger } from '../../Modules/Logger';
import { RPC } from '../rpc';
import { validationErrorTuple } from '../ipc/create-handler';
import { PushInitialDesktopState } from '../initial-state';
import type { IPCValidationManager } from '../../Modules/IPCValidation';
const { app } = require('electron/main');
const { shell } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { Config } = require('../../Modules/Config') as typeof import('../../Modules/Config');
const { Manager: ModeManager } = require('../../Modules/ModeManager') as typeof import('../../Modules/ModeManager');
const { Manager: SettingsManager } = require('../../Modules/SettingsManager') as typeof import('../../Modules/SettingsManager');
const { Manager: AppDataManager } = require('../../Modules/AppData') as typeof import('../../Modules/AppData');
const { Manager: NetworkInterfaces } = require('../../Modules/NetworkInterfaces') as typeof import('../../Modules/NetworkInterfaces');
const { Manager: IPCValidation }: { Manager: IPCValidationManager } = require('../../Modules/IPCValidation');

const Logger = CreateLogger('Main');

function register(): void {
  RPC.handle('Config:Get', async () => {
    // Surface the packaged/dev distinction to the renderer so dev-only UI (the
    // Settings > Debug section) can reveal itself on uncompiled builds
    // (electron-forge start), where app.isPackaged is false.
    return {
      ...Config,
      Application: { ...Config.Application, IsPackaged: app.isPackaged },
    };
  });

  // Provide a list of Web UI addresses on the local network with port
  RPC.handle('WebUI:GetAddresses', async () => {
    try {
      const port = Config.Application.Port;
      const hostname = os.hostname();
      const hosts = new Set();
      const push = (h: unknown) => {
        if (!h) return;
        try {
          h = String(h).trim();
        } catch {
          /* intentional: skip any host value that can't be stringified */
        }
        if (!h) return;
        hosts.add(h);
      };
      push('localhost');
      push('127.0.0.1');
      push(hostname);
      // Live external IPv4 addresses from the central authority, so the list is
      // current even after interfaces have been added or removed since boot.
      for (const iface of NetworkInterfaces.List(false)) {
        push(iface.Address);
      }
      const urls = Array.from(hosts).map((host) => ({ host, url: `http://${host}:${port}/` }));
      return { port, hostname, urls };
    } catch (e) {
      const port = Config.Application.Port;
      return {
        port,
        hostname: os.hostname(),
        urls: [{ host: 'localhost', url: `http://localhost:${port}/` }],
      };
    }
  });

  // Application Mode IPC
  RPC.handle('Mode:Get', async () => {
    return ModeManager.Get();
  });

  RPC.handle('Mode:Set', async (_event: unknown, NewMode: unknown) => {
    const Updated = ModeManager.Set(NewMode);
    return Updated;
  });

  RPC.handle('Settings:Get', async () => {
    const Settings = await SettingsManager.GetAll();
    return Settings;
  });

  // Renderer signaled it (re)loaded: push the current authoritative state.
  RPC.handle('Loaded', async () => {
    Logger.log('Application Page Hot Reloaded');
    await PushInitialDesktopState();
    return;
  });

  RPC.handle('OpenLogsFolder', async (_event: unknown) => {
    const LogsPath = AppDataManager.GetLogsDirectory();
    Logger.log('Opening logs folder:', LogsPath);
    // Cross-platform and properly quoted
    await shell.openPath(LogsPath);
    return;
  });

  RPC.handle('OpenDiscordInviteLinkInBrowser', async (_event: unknown, _URL: unknown) => {
    const url = 'https://discord.gg/DACmwsbSGW';
    await shell.openExternal(url);
    return;
  });

  RPC.handle('OpenShowTrakWebsiteInBrowser', async (_event: unknown) => {
    const url = 'https://showtrak.co.uk';
    await shell.openExternal(url);
    return;
  });

  RPC.handle('OpenShowTrakGithubInBrowser', async (_event: unknown) => {
    const url = 'https://github.com/ShowTrak/ShowTrakServer';
    await shell.openExternal(url);
    return;
  });

  RPC.handle('OpenNpmPackageInBrowser', async (_event: unknown, PackageName: unknown) => {
    const Name = String(PackageName || '').trim();
    if (!Name) return;
    const url = `https://www.npmjs.com/package/${encodeURIComponent(Name)}`;
    await shell.openExternal(url);
    return;
  });

  RPC.handle('GetProjectDependencies', async (_event: unknown) => {
    try {
      const CandidatePaths = [
        path.join(app.getAppPath(), 'package.json'),
        path.resolve(app.getAppPath(), '..', 'package.json'),
      ];

      let PackageJsonPath = null;
      for (const CandidatePath of CandidatePaths) {
        if (fs.existsSync(CandidatePath)) {
          PackageJsonPath = CandidatePath;
          break;
        }
      }

      if (!PackageJsonPath) {
        return ['Could not locate package.json', null];
      }

      const PackageJsonRaw = fs.readFileSync(PackageJsonPath, 'utf8');
      const PackageJson = JSON.parse(PackageJsonRaw);

      const DefaultRuntimeDependencies = new Set(['electron-squirrel-startup']);

      const Dependencies = Object.entries(PackageJson.dependencies || {})
        .filter(([name]) => !DefaultRuntimeDependencies.has(name))
        .map(([name, version]) => ({ name, version }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return [
        null,
        {
          dependencies: Dependencies,
        },
      ];
    } catch (error) {
      Logger.error('GetProjectDependencies failed', error);
      return [String(error), null];
    }
  });

  RPC.handle('GetLicense', async (_event: unknown) => {
    try {
      const CandidatePaths = [
        path.join(app.getAppPath(), 'LICENSE'),
        path.resolve(app.getAppPath(), '..', 'LICENSE'),
      ];

      let LicensePath = null;
      for (const CandidatePath of CandidatePaths) {
        if (fs.existsSync(CandidatePath)) {
          LicensePath = CandidatePath;
          break;
        }
      }

      if (!LicensePath) {
        return ['Could not locate LICENSE file', null];
      }

      const License = fs.readFileSync(LicensePath, 'utf8');

      return [null, { license: License }];
    } catch (error) {
      Logger.error('GetLicense failed', error);
      return [String(error), null];
    }
  });

  RPC.handle('SetSetting', async (_event: unknown, Key: unknown, Value: unknown) => {
    let ValidKey, ValidValue;
    try {
      [ValidKey, ValidValue] = IPCValidation.SettingUpdatePayload(Key, Value);
    } catch (error) {
      return validationErrorTuple(error);
    }
    const [Err, Setting] = await SettingsManager.Set(ValidKey, ValidValue);
    if (Err) return [Err, null];
    return [null, Setting];
  });
}

export { register };
