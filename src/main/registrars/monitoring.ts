// IPC registrar: monitoring targets/methods + client & dummy history reads.
// Extracted verbatim from main.ts.

import { RPC } from '../rpc';
import { createTupleHandler } from '../ipc/create-handler';
import {
  getMonitoringCheckHistory,
  getDummyHistorySamples,
  getClientHistorySamples,
  getClientApplicationHistorySamples,
  getClientUSBHistorySamples,
  getClientDisplayHistorySamples,
} from '../monitoring-history';
import { Manager as MonitoringMethods } from '../../Modules/MonitoringMethods';
import { Manager as MonitoringTargetManager } from '../../Modules/MonitoringTargetManager';
import { Manager as MonitoringActionFavourites } from '../../Modules/MonitoringActionFavourites';
import { Manager as IPCValidation } from '../../Modules/IPCValidation';

function register(): void {
  RPC.handle('GetMonitoringMethods', async () => {
    return MonitoringMethods.GetAll();
  });

  RPC.handle('GetAllMonitoringTargets', async () => {
    const [Err, List] = await MonitoringTargetManager.GetAll();
    if (Err) return [];
    return List || [];
  });

  RPC.handle('GetMonitoringTarget', async (_Event: unknown, TargetID: unknown) => {
    try {
      TargetID = IPCValidation.MonitoringTargetID(TargetID);
    } catch {
      return null;
    }
    const [Err, Target] = await MonitoringTargetManager.Get(TargetID);
    if (Err) return null;
    return Target;
  });

  RPC.handle('GetMonitoringCheckHistory', async (_Event: unknown, CheckID: unknown) => {
    try {
      CheckID = IPCValidation.MonitoringTargetID(CheckID, 'CheckID');
    } catch {
      return [];
    }
    return getMonitoringCheckHistory(CheckID);
  });

  RPC.handle('GetMonitoringCheckDebug', async (_Event: unknown, CheckID: unknown) => {
    try {
      CheckID = IPCValidation.MonitoringTargetID(CheckID, 'CheckID');
    } catch {
      return null;
    }
    const [Err, Debug] = await MonitoringTargetManager.GetCheckDebug(CheckID);
    if (Err) return null;
    return Debug;
  });

  RPC.handle('RunMonitoringCheckNow', async (_Event: unknown, CheckID: unknown) => {
    try {
      CheckID = IPCValidation.MonitoringTargetID(CheckID, 'CheckID');
    } catch {
      return null;
    }
    const [Err, Debug] = await MonitoringTargetManager.RunCheckNow(CheckID);
    if (Err) return null;
    return Debug;
  });

  RPC.handle('RunAllMonitoringChecksNow', async (_Event: unknown, TargetID: unknown) => {
    try {
      TargetID = IPCValidation.MonitoringTargetID(TargetID);
    } catch {
      return null;
    }
    const [Err, Target] = await MonitoringTargetManager.RunAllChecksNow(TargetID);
    if (Err) return null;
    return Target;
  });

  // Check actions. One channel for every action of every method: the method +
  // action pair is resolved against the registry by the validators below, so a
  // channel each would add registry/bridge/shim entries without adding safety.
  // The selection fans out server-side, so the context menu makes one call and
  // gets one aggregate result.
  RPC.handle(
    'RunMonitoringAction',
    createTupleHandler<[number[], string, string, Record<string, unknown>], unknown>(
      (TargetIDs: unknown, Method: unknown, ActionID: unknown, Params: unknown) => [
        IPCValidation.MonitoringTargetIDList(TargetIDs),
        IPCValidation.MonitoringMethodID(Method),
        IPCValidation.MonitoringActionID(Method, ActionID),
        // Parameters are validated against the action that is actually being
        // run, so a value meant for one action cannot smuggle into another.
        IPCValidation.MonitoringActionParams(Method, ActionID, Params),
      ],
      (TargetIDs: number[], Method: string, ActionID: string, Params: Record<string, unknown>) =>
        MonitoringTargetManager.RunAction(TargetIDs, Method, ActionID, Params)
    )
  );

  RPC.handle('GetMonitoringActionFavourites', async () => {
    await MonitoringActionFavourites.Init();
    return MonitoringActionFavourites.GetAll();
  });

  RPC.handle(
    'SetMonitoringActionFavourite',
    createTupleHandler<[string, string, Record<string, unknown>, boolean], unknown>(
      (Method: unknown, ActionID: unknown, Params: unknown, Favourite: unknown) => [
        IPCValidation.MonitoringMethodID(Method),
        IPCValidation.MonitoringActionID(Method, ActionID),
        IPCValidation.MonitoringActionParams(Method, ActionID, Params),
        !!Favourite,
      ],
      (Method: string, ActionID: string, Params: Record<string, unknown>, Favourite: boolean) =>
        MonitoringActionFavourites.Set(Method, ActionID, Params, Favourite)
    )
  );

  RPC.handle('GetDummyClientHistory', async (_Event: unknown, UUID: unknown) => {
    try {
      UUID = IPCValidation.DummyClientUUID(UUID);
    } catch {
      return [];
    }
    return getDummyHistorySamples(UUID);
  });

  RPC.handle('GetClientHistory', async (_Event: unknown, UUID: unknown) => {
    try {
      UUID = IPCValidation.UUID(UUID);
    } catch {
      return [];
    }
    return getClientHistorySamples(UUID);
  });

  RPC.handle('GetClientApplicationHistory', async (_Event: unknown, UUID: unknown) => {
    try {
      UUID = IPCValidation.UUID(UUID);
    } catch {
      return [];
    }
    return getClientApplicationHistorySamples(UUID);
  });

  RPC.handle('GetClientUSBHistory', async (_Event: unknown, UUID: unknown) => {
    try {
      UUID = IPCValidation.UUID(UUID);
    } catch {
      return [];
    }
    return getClientUSBHistorySamples(UUID);
  });

  RPC.handle('GetClientDisplayHistory', async (_Event: unknown, UUID: unknown) => {
    try {
      UUID = IPCValidation.UUID(UUID);
    } catch {
      return [];
    }
    return getClientDisplayHistorySamples(UUID);
  });

  RPC.handle(
    'CreateMonitoringTarget',
    createTupleHandler<[Record<string, unknown>], unknown>(
      (Payload: unknown) => IPCValidation.MonitoringTargetCreatePayload(Payload),
      // The IPC validator has already normalized this into a valid create payload
      // (runtime-checked shape the type system can't see across the boundary).
      (Payload: Record<string, unknown>) =>
        MonitoringTargetManager.Create(
          Payload as unknown as Parameters<typeof MonitoringTargetManager.Create>[0]
        )
    )
  );

  RPC.handle(
    'UpdateMonitoringTarget',
    createTupleHandler<[number, Record<string, unknown>], unknown>(
      (TargetID: unknown, Payload: unknown) => [
        IPCValidation.MonitoringTargetID(TargetID),
        IPCValidation.MonitoringTargetUpdatePayload(Payload),
      ],
      (TargetID: number, Payload: Record<string, unknown>) =>
        MonitoringTargetManager.Update(TargetID, Payload)
    )
  );

  RPC.handle(
    'DeleteMonitoringTarget',
    createTupleHandler<[number], unknown>(
      (TargetID: unknown) => IPCValidation.MonitoringTargetID(TargetID),
      (TargetID: number) => MonitoringTargetManager.Delete(TargetID)
    )
  );
}

export { register };
