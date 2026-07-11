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
import type { IPCValidationManager } from '../../Modules/IPCValidation';
const { Manager: MonitoringMethods } = require('../../Modules/MonitoringMethods');
const { Manager: MonitoringTargetManager } = require('../../Modules/MonitoringTargetManager');
const { Manager: IPCValidation }: { Manager: IPCValidationManager } = require('../../Modules/IPCValidation');

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
      (Payload: Record<string, unknown>) => MonitoringTargetManager.Create(Payload)
    )
  );

  RPC.handle(
    'UpdateMonitoringTarget',
    createTupleHandler<[number, Record<string, unknown>], unknown>(
      (TargetID: unknown, Payload: unknown) => [
        IPCValidation.MonitoringTargetID(TargetID),
        IPCValidation.MonitoringTargetUpdatePayload(Payload),
      ],
      (TargetID: number, Payload: Record<string, unknown>) => MonitoringTargetManager.Update(TargetID, Payload)
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
