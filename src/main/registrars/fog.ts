// IPC registrar: FOG Project integration (Fog:*).
//
// Readers return raw values (status object, lists) so the renderer can consume them
// directly; mutations return the [Err, Result] tuple. See create-handler.ts for the
// two contracts.
//
// Note that FOG being unreachable is not modelled as an error for the readers: the
// client editor and the tasks panel must still render when the FOG server is down,
// showing the last known state plus a status message, rather than failing to open.

import { RPC } from '../rpc';
import { createTupleHandler } from '../ipc/create-handler';
import { Manager as FogManager } from '../../Modules/FogManager';
import { Manager as IPCValidation } from '../../Modules/IPCValidation';

function register(): void {
  // Reader: current enabled/healthy state of the integration.
  RPC.handle('Fog:GetStatus', async (_Event: unknown) => {
    return FogManager.GetStatus();
  });

  // Reader: force an immediate re-probe and return the resulting status. Used by
  // the settings UI so editing a token gives instant feedback.
  RPC.handle('Fog:TestConnection', async (_Event: unknown) => {
    return FogManager.TestConnection();
  });

  // Reader: FOG host list for the client editor dropdown. Falls back to the last
  // known list when FOG is unreachable.
  RPC.handle('Fog:GetHosts', async (_Event: unknown) => {
    return FogManager.GetHosts();
  });

  // Reader: task types the operator has permitted in settings. Empty list is a
  // valid answer and means "nothing may be scheduled".
  RPC.handle('Fog:GetTaskTypes', async (_Event: unknown) => {
    return FogManager.GetPermittedTaskTypes();
  });

  RPC.handle('Fog:GetTasks', async (_Event: unknown) => {
    return FogManager.GetTasks();
  });

  RPC.handle(
    'Fog:GetHostLink',
    createTupleHandler<[string], { FogHostID: number; FogHostName: string | null } | null>(
      (UUID: unknown) => IPCValidation.UUID(UUID),
      (UUID: string) => FogManager.GetHostLink(UUID)
    )
  );

  RPC.handle(
    'Fog:SetHostLink',
    createTupleHandler<[string, number | null], void>(
      (UUID: unknown, FogHostID: unknown) => [
        IPCValidation.UUID(UUID),
        IPCValidation.FogHostIDOrNull(FogHostID),
      ],
      (UUID: string, FogHostID: number | null) => FogManager.SetHostLink(UUID, FogHostID),
      { invalidFallback: false }
    )
  );

  // Scheduling re-validates permission and health inside the manager; the
  // validation here is shape-only.
  RPC.handle(
    'Fog:ScheduleTask',
    createTupleHandler<[string, number, number | null], void>(
      (UUID: unknown, TaskTypeID: unknown, SnapinID: unknown) => [
        IPCValidation.UUID(UUID),
        IPCValidation.FogTaskTypeID(TaskTypeID),
        IPCValidation.FogSnapinID(SnapinID),
      ],
      (UUID: string, TaskTypeID: number, SnapinID: number | null) =>
        FogManager.ScheduleTask(UUID, TaskTypeID, SnapinID),
      { invalidFallback: false }
    )
  );
}

export { register };
