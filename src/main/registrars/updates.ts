// IPC registrar: client software updates + app self-update. Extracted verbatim
// from main.ts. Also wires the AppUpdater module (which registers its own
// AppUpdate:* handlers and performs eager electron-updater init).

import { CreateLogger } from '../../Modules/Logger';
import { RPC } from '../rpc';
import { validationErrorTuple } from '../ipc/create-handler';
import { PushToRenderers } from '../renderer-bus';
import { getMainWindow, hasMainWindow } from '../app-window';
import { normalizeVersionToken } from '../local-scripts';
import { Manager as AppUpdater } from '../app-updater';
import { Manager as UpdateManager } from '../../Modules/UpdateManager';
import { Manager as ClientManager } from '../../Modules/ClientManager';
import { Manager as ServerManager } from '../../Modules/Server';
import { Manager as IPCValidation } from '../../Modules/IPCValidation';

const Logger = CreateLogger('Main');

function register(): void {
  // App self-update flows (dev simulation, Squirrel, electron-updater) are
  // encapsulated in the AppUpdater module.
  AppUpdater.Register(RPC, { getMainWindow });

  RPC.handle('CheckForUpdatesOnClient', async (_Event: unknown, UUID: unknown) => {
    let ValidUUID;
    try {
      ValidUUID = IPCValidation.UUID(UUID);
    } catch (error) {
      return validationErrorTuple(error);
    }
    Logger.warn('CheckForUpdatesOnClient called for UUID:', ValidUUID);
    await ServerManager.ExecuteBulkRequest(
      'UpdateSoftware',
      [ValidUUID],
      'Check For Software Updates'
    );
    return [null, true];
  });

  RPC.handle('UpdateManager:GetStatus', async () => {
    try {
      const Status = await UpdateManager.GetStatus();
      return [null, Status];
    } catch (error) {
      return validationErrorTuple(error);
    }
  });

  RPC.handle('UpdateManager:GetReleases', async () => {
    try {
      const Releases = await UpdateManager.ListReleases();
      return [null, Releases];
    } catch (error) {
      return validationErrorTuple(error);
    }
  });

  RPC.handle('UpdateManager:DownloadRelease', async (_Event: unknown, Tag: unknown) => {
    try {
      const Release = await UpdateManager.DownloadRelease(Tag, {
        onProgress: (Progress: unknown) => {
          try {
            if (hasMainWindow()) {
              PushToRenderers('UpdateManager:DownloadProgress', Progress);
            }
          } catch {
            /* intentional: progress push is best-effort and must not abort the download */
          }
        },
      });

      return [null, Release];
    } catch (error) {
      return validationErrorTuple(error);
    }
  });

  RPC.handle('UpdateManager:DeployRelease', async (_Event: unknown, Tag: unknown, Targets: unknown) => {
    try {
      const Status = await UpdateManager.GetStatus();
      if (!Status || !Status.Ready || !Status.ReleaseVersion) {
        return ['Download a release build before deploying', null];
      }

      const SelectedTag = String(Tag || '').trim();
      if (!SelectedTag) {
        return ['Select a release to deploy', null];
      }
      if (Status.ReleaseVersion !== SelectedTag) {
        return ['Selected release is not downloaded yet', null];
      }

      const RawTargets = Array.isArray(Targets) ? Targets : [];
      if (RawTargets.length === 0) {
        return ['Select at least one client for deployment', null];
      }

      let SelectedTargets = [];
      try {
        SelectedTargets = IPCValidation.UUIDList(RawTargets, 'Deployment targets');
      } catch (error) {
        return validationErrorTuple(error);
      }

      const [ClientsErr, Clients] = await ClientManager.GetAll();
      if (ClientsErr) return [ClientsErr, null];

      const AllClients = (Clients || []).filter((Client) => Client && Client.UUID);
      const SelectedSet = new Set(SelectedTargets);
      const SelectedClients = AllClients.filter((Client) => SelectedSet.has(Client.UUID));
      const SelectedVersionToken = normalizeVersionToken(SelectedTag);

      const EligibleClients = SelectedClients.filter((Client) => {
        if (!Client.Online) return false;
        const ClientVersionToken = normalizeVersionToken(Client.Version);
        return ClientVersionToken !== SelectedVersionToken;
      });

      const DeployTargets = EligibleClients.map((Client) => Client.UUID);
      if (DeployTargets.length === 0) {
        return ['No selected clients are eligible for deployment', null];
      }

      await ServerManager.ExecuteBulkRequest(
        'UpdateSoftwareFromLAN',
        DeployTargets,
        'Updating Client Software',
        {
          resetQueue: false,
          payload: {
            FeedPath: Status.FeedPath,
            ReleaseVersion: SelectedTag,
          },
        }
      );

      return [
        null,
        {
          ReleaseVersion: SelectedTag,
          TargetCount: DeployTargets.length,
          SelectedCount: SelectedTargets.length,
          TotalClientCount: AllClients.length,
          FeedPath: Status.FeedPath,
        },
      ];
    } catch (error) {
      return validationErrorTuple(error);
    }
  });
}

export { register };
