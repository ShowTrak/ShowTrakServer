// IPC registrar: client lifecycle + per-client actions (get, update, critical
// entity marking, adopt/unadopt/replace, identify, wake-on-lan). Extracted
// verbatim from main.ts.

import { CreateLogger } from '../../Modules/Logger';
import { RPC } from '../rpc';
import { createTupleHandler, validationErrorTuple } from '../ipc/create-handler';
import { UpdateFullClientList } from '../broadcast-bridge';
import { TriggerScriptDeployment } from '../deployment';
import type {
  IPCValidationManager,
  CriticalUSBDevicePayloadResult,
  CriticalApplicationPayloadResult,
  CriticalDisplayPayloadResult,
} from '../../Modules/IPCValidation';
const { Manager: ClientManager } = require('../../Modules/ClientManager');
const { Manager: AdoptionManager } = require('../../Modules/AdoptionManager');
const { Manager: ServerManager } = require('../../Modules/Server');
const { Manager: AlertsManager } = require('../../Modules/AlertsManager');
const { Manager: IdentifyManager } = require('../../Modules/IdentifyManager');
const { Manager: WOLManager } = require('../../Modules/WOLManager');
const { Manager: ScriptExecutionManager } = require('../../Modules/ScriptExecutionManager');
const { Manager: IPCValidation }: { Manager: IPCValidationManager } = require('../../Modules/IPCValidation');

const Logger = CreateLogger('Main');

function register(): void {
  RPC.handle('GetClient', async (_Event: unknown, UUID: unknown) => {
    try {
      UUID = IPCValidation.UUID(UUID);
    } catch {
      return null;
    }
    const [Err, Client] = await ClientManager.Get(UUID);
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
  RPC.handle('IdentifyClient', async (_Event: unknown, UUID: unknown) => {
    try {
      UUID = IPCValidation.UUID(UUID);
    } catch (error) {
      return validationErrorTuple(error);
    }
    return IdentifyManager.Identify(UUID);
  });

  RPC.handle('StopIdentifyingClient', async (_Event: unknown, UUID: unknown) => {
    try {
      UUID = IPCValidation.UUID(UUID);
    } catch (error) {
      return validationErrorTuple(error);
    }
    return IdentifyManager.Stop(UUID);
  });

  RPC.handle('AdoptDevice', async (_event: unknown, UUID: unknown) => {
    try {
      UUID = IPCValidation.UUID(UUID);
    } catch (error) {
      return validationErrorTuple(error, false);
    }
    Logger.log('Adopting device:', UUID);
    const [CreateErr, _CreateResult] = await ClientManager.Create(UUID);
    if (CreateErr && CreateErr !== 'Client already exists') return [CreateErr, null];
    await AdoptionManager.SetState(UUID, 'Adopting');
    await ServerManager.SendMessageByGroup(UUID, 'Adopt');
    await TriggerScriptDeployment([UUID], 'client-adopted');
    return [null, true];
  });

  RPC.handle('UnadoptClient', async (_event: unknown, UUID: unknown) => {
    try {
      UUID = IPCValidation.UUID(UUID);
    } catch (error) {
      return validationErrorTuple(error, false);
    }
    Logger.log('Unadopting device:', UUID);
    await ServerManager.SendMessageByGroup(UUID, 'Unadopt');
    const [DeleteErr, _DeleteResult] = await ClientManager.Delete(UUID);
    if (DeleteErr) return [DeleteErr, null];
    await UpdateFullClientList();
    return [null, true];
  });

  RPC.handle('ReplaceClient', async (_event: unknown, CurrentUUID: unknown, ReplacementUUID: unknown) => {
    try {
      CurrentUUID = IPCValidation.UUID(CurrentUUID, 'CurrentUUID');
      ReplacementUUID = IPCValidation.UUID(ReplacementUUID, 'ReplacementUUID');
    } catch (error) {
      return validationErrorTuple(error, false);
    }

    if (CurrentUUID === ReplacementUUID) {
      return ['Replacement client must be different', null];
    }

    const Pending = AdoptionManager.GetClientsPendingAdoption();
    const ReplacementPending = Array.isArray(Pending)
      ? Pending.find((Device: { UUID?: unknown } | null) => String(Device && Device.UUID) === ReplacementUUID)
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
  });

  RPC.handle('WakeOnLan', async (_Event: unknown, List: unknown) => {
    let Targets: string[];
    try {
      Targets = IPCValidation.UUIDList(List || [], 'WakeOnLan targets');
    } catch (error) {
      return validationErrorTuple(error);
    }
    await ScriptExecutionManager.ClearQueue();
    const tasks = Targets.map(async (UUID: string) => {
      const RequestID = await ScriptExecutionManager.AddInternalTaskToQueue(UUID, 'Wake On LAN');
      const [ClientErr, Client] = await ClientManager.Get(UUID);
      if (ClientErr) {
        await ScriptExecutionManager.Complete(RequestID, ClientErr);
        return;
      }
      if (!Client) {
        await ScriptExecutionManager.Complete(RequestID, 'Client not found');
        return;
      }
      if (!Client.MacAddress) {
        await ScriptExecutionManager.Complete(
          RequestID,
          'Client does not have a valid MAC address in internal database.'
        );
        return;
      }
      if (Client.Online) {
        await ScriptExecutionManager.Complete(RequestID, 'Client is already online');
        return;
      }
      const [WOLErr, _Result] = await WOLManager.Wake(Client.MacAddress);
      await ScriptExecutionManager.Complete(RequestID, WOLErr);
    });
    await Promise.allSettled(tasks);
    return [null, true];
  });
}

export { register };
