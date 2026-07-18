// IPC registrar: client lifecycle + per-client actions (get, update, critical
// entity marking, adopt/unadopt/replace, identify, wake-on-lan). Extracted
// verbatim from main.ts.

import { CreateLogger } from '../../Modules/Logger';
import { RPC } from '../rpc';
import { createTupleHandler, validationErrorTuple } from '../ipc/create-handler';
import { UpdateFullClientList } from '../broadcast-bridge';
import { TriggerScriptDeployment } from '../deployment';
import type {
  CriticalUSBDevicePayloadResult,
  CriticalUSBNamePayloadResult,
  CriticalApplicationPayloadResult,
  CriticalDisplayPayloadResult,
} from '../../Modules/IPCValidation';
import { Manager as ClientManager } from '../../Modules/ClientManager';
import { Manager as AdoptionManager } from '../../Modules/AdoptionManager';
import { Manager as ServerManager } from '../../Modules/Server';
import { Manager as AlertsManager } from '../../Modules/AlertsManager';
import { Manager as IdentifyManager } from '../../Modules/IdentifyManager';
import { Manager as WOLManager } from '../../Modules/WOLManager';
import { Manager as ScriptExecutionManager } from '../../Modules/ScriptExecutionManager';
import { Manager as SettingsManager } from '../../Modules/SettingsManager';
import { Manager as IPCValidation } from '../../Modules/IPCValidation';

const Logger = CreateLogger('Main');

function register(): void {
  RPC.handle('GetClient', async (_Event: unknown, UUID: unknown) => {
    let ValidUUID: string;
    try {
      ValidUUID = IPCValidation.UUID(UUID);
    } catch {
      return null;
    }
    const [Err, Client] = await ClientManager.Get(ValidUUID);
    if (Err) return null;
    if (!Client) return null;
    return Client;
  });

  RPC.handle(
    'UpdateClient',
    createTupleHandler<[string, Record<string, unknown>], unknown>(
      (UUID: unknown, Data: unknown) => [IPCValidation.UUID(UUID), IPCValidation.ClientUpdatePayload(Data)],
      (UUID: string, Data: Record<string, unknown>) => ClientManager.Update(UUID, Data)
    )
  );

  RPC.handle(
    'MarkClientUSBDeviceCritical',
    createTupleHandler<[string, CriticalUSBDevicePayloadResult], unknown>(
      (UUID: unknown, Device: unknown) => [IPCValidation.UUID(UUID), IPCValidation.CriticalUSBDevicePayload(Device)],
      (UUID: string, Device: CriticalUSBDevicePayloadResult) => ClientManager.MarkUSBDeviceCritical(UUID, Device)
    )
  );

  RPC.handle(
    'RemoveClientUSBDeviceCritical',
    createTupleHandler<[string, string], unknown>(
      (UUID: unknown, SerialNumber: unknown) => [
        IPCValidation.UUID(UUID),
        IPCValidation.USBSerialNumber(SerialNumber),
      ],
      (UUID: string, SerialNumber: string) => ClientManager.RemoveUSBDeviceCritical(UUID, SerialNumber)
    )
  );

  RPC.handle(
    'MarkClientUSBNameCritical',
    createTupleHandler<[string, CriticalUSBNamePayloadResult], unknown>(
      (UUID: unknown, Device: unknown) => [IPCValidation.UUID(UUID), IPCValidation.CriticalUSBNamePayload(Device)],
      (UUID: string, Device: CriticalUSBNamePayloadResult) => ClientManager.MarkUSBNameCritical(UUID, Device)
    )
  );

  RPC.handle(
    'RemoveClientUSBNameCritical',
    createTupleHandler<[string, CriticalUSBNamePayloadResult], unknown>(
      (UUID: unknown, Device: unknown) => [IPCValidation.UUID(UUID), IPCValidation.CriticalUSBNamePayload(Device)],
      (UUID: string, Device: CriticalUSBNamePayloadResult) => ClientManager.RemoveUSBNameCritical(UUID, Device)
    )
  );

  RPC.handle(
    'MarkClientApplicationCritical',
    createTupleHandler<[string, CriticalApplicationPayloadResult], unknown>(
      (UUID: unknown, Application: unknown) => [
        IPCValidation.UUID(UUID),
        IPCValidation.CriticalApplicationPayload(Application),
      ],
      (UUID: string, Application: CriticalApplicationPayloadResult) => ClientManager.MarkApplicationCritical(UUID, Application)
    )
  );

  RPC.handle(
    'RemoveClientApplicationCritical',
    createTupleHandler<[string, string], unknown>(
      (UUID: unknown, ApplicationName: unknown) => [
        IPCValidation.UUID(UUID),
        IPCValidation.CriticalApplicationPayload({ Name: ApplicationName }).Name,
      ],
      (UUID: string, ApplicationName: string) => ClientManager.RemoveApplicationCritical(UUID, ApplicationName)
    )
  );

  RPC.handle(
    'MarkClientDisplayCritical',
    createTupleHandler<[string, CriticalDisplayPayloadResult], unknown>(
      (UUID: unknown, Display: unknown) => [IPCValidation.UUID(UUID), IPCValidation.CriticalDisplayPayload(Display)],
      (UUID: string, Display: CriticalDisplayPayloadResult) => ClientManager.MarkDisplayCritical(UUID, Display)
    )
  );

  RPC.handle(
    'RemoveClientDisplayCritical',
    createTupleHandler<[string, string], unknown>(
      (UUID: unknown, DisplayID: unknown) => [IPCValidation.UUID(UUID), IPCValidation.DisplayID(DisplayID)],
      (UUID: string, DisplayID: string) => ClientManager.RemoveDisplayCritical(UUID, DisplayID)
    )
  );

  // Start identify mode on a single client (adopted or pending adoption).
  // Rejected for integrated (SDK) clients which cannot render the overlay.
  RPC.handle(
    'IdentifyClient',
    createTupleHandler<[string], boolean>(
      (UUID: unknown) => IPCValidation.UUID(UUID),
      (UUID: string) => IdentifyManager.Identify(UUID)
    )
  );

  RPC.handle(
    'StopIdentifyingClient',
    createTupleHandler<[string], boolean>(
      (UUID: unknown) => IPCValidation.UUID(UUID),
      (UUID: string) => IdentifyManager.Stop(UUID)
    )
  );

  RPC.handle(
    'AdoptDevice',
    createTupleHandler<[string], boolean>(
      (UUID: unknown) => IPCValidation.UUID(UUID),
      async (UUID: string) => {
        Logger.log('Adopting device:', UUID);
        const [CreateErr] = await ClientManager.Create(UUID);
        if (CreateErr && CreateErr !== 'Client already exists') return [CreateErr, null];
        await AdoptionManager.SetState(UUID, 'Adopting');
        await ServerManager.SendMessageByGroup(UUID, 'Adopt');
        await TriggerScriptDeployment([UUID], 'client-adopted');
        return [null, true];
      },
      { invalidFallback: false }
    )
  );

  RPC.handle(
    'UnadoptClient',
    createTupleHandler<[string], boolean>(
      (UUID: unknown) => IPCValidation.UUID(UUID),
      async (UUID: string) => {
        Logger.log('Unadopting device:', UUID);
        await ServerManager.SendMessageByGroup(UUID, 'Unadopt');
        const [DeleteErr] = await ClientManager.Delete(UUID);
        if (DeleteErr) return [DeleteErr, null];
        await UpdateFullClientList();
        return [null, true];
      },
      { invalidFallback: false }
    )
  );

  RPC.handle(
    'CreateUnassignedClients',
    createTupleHandler<[{ Name: string; Count: number }], unknown>(
      (Payload: unknown) => IPCValidation.UnassignedClientCreatePayload(Payload),
      async (Payload: { Name: string; Count: number }) => {
        // The renderer hides the entry point when the feature is off, but the
        // setting is re-read here because that is the only authoritative gate —
        // a stale or bypassed renderer must not be able to create slots. Fails
        // closed if the read throws.
        let Allowed = false;
        try {
          Allowed = !!(await SettingsManager.GetValue('SYSTEM_ALLOW_UNASSIGNED_CLIENTS'));
        } catch (error) {
          Logger.error('Failed to read unassigned client setting', error);
          return ['Unable to verify that unassigned clients are enabled', null];
        }
        if (!Allowed) return ['Unassigned clients are disabled', null];

        const [CreateErr, Created] = await ClientManager.CreateUnassigned(
          Payload.Name,
          Payload.Count
        );
        if (CreateErr) return [CreateErr, null];
        if (!Created) return ['Failed to create unassigned clients', null];

        await UpdateFullClientList();
        return [null, Created.length];
      },
      { invalidFallback: null }
    )
  );

  RPC.handle(
    'ReplaceClient',
    createTupleHandler<[string, string], boolean>(
      (CurrentUUID: unknown, ReplacementUUID: unknown) => [
        IPCValidation.UUID(CurrentUUID, 'CurrentUUID'),
        IPCValidation.UUID(ReplacementUUID, 'ReplacementUUID'),
      ],
      async (CurrentUUID: string, ReplacementUUID: string) => {
        if (CurrentUUID === ReplacementUUID) {
          return ['Replacement client must be different', null];
        }

        const Pending = AdoptionManager.GetClientsPendingAdoption();
        const ReplacementPending = Array.isArray(Pending)
          ? Pending.find(
              (Device: { UUID?: unknown } | null) => String(Device && Device.UUID) === ReplacementUUID
            )
          : null;
        if (!ReplacementPending) {
          return ['Replacement device is no longer pending adoption', null];
        }

        const [ReplaceErr] = await ClientManager.ReplaceClient(CurrentUUID, ReplacementUUID);
        if (ReplaceErr) return [ReplaceErr, null];

        await AlertsManager.Reload();

        await AdoptionManager.SetState(ReplacementUUID, 'Adopting');
        await ServerManager.SendMessageByGroup(ReplacementUUID, 'Adopt');
        await TriggerScriptDeployment([ReplacementUUID], 'client-replaced');

        return [null, true];
      },
      { invalidFallback: false }
    )
  );

  RPC.handle('WakeOnLan', async (_Event: unknown, List: unknown) => {
    let Targets: string[];
    try {
      Targets = IPCValidation.UUIDList(List || [], 'WakeOnLan targets');
    } catch (error) {
      return validationErrorTuple(error);
    }
    await ScriptExecutionManager.ClearQueue();
    const tasks = Targets.map(async (UUID: string) => {
      // Resolve the client and its eligibility BEFORE queueing anything so the
      // no-op cases below never create a task (and therefore never surface a UI
      // notification). Only clients we will actually wake get an entry.
      const [ClientErr, Client] = await ClientManager.Get(UUID);
      // The client vanished between validation and now — nothing to wake, and no
      // task was queued, so stay silent.
      if (ClientErr || !Client) return;
      // WOL isn't possible/needed here: no MAC on record (unsupported) or the
      // client is already online. Silently skip — don't spam with notifications.
      if (!Client.MacAddress || Client.Online) return;

      const RequestID = await ScriptExecutionManager.AddInternalTaskToQueue(UUID, 'Wake On LAN');
      // No RequestID means the task was never queued (the client vanished between
      // the check above and enqueue) — there is nothing to complete.
      if (!RequestID) return;
      const [WOLErr, _Result] = await WOLManager.Wake(Client.MacAddress);
      await ScriptExecutionManager.Complete(RequestID, WOLErr);
    });
    await Promise.allSettled(tasks);
    return [null, true];
  });
}

export { register };
