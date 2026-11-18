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
  getClientAudioHistorySamples,
  getClientNetworkHistorySamples,
  getClientStorageHistorySamples,
  getClientSystemCheckHistorySamples,
} from '../monitoring-history';
import { getClientVitalsHistory } from '../client-vitals-history';
import { getStatusHistoryOverview } from '../status-history-overview';
import { Manager as MonitoringMethods } from '../../Modules/MonitoringMethods';
import {
  Manager as MonitoringTargetManager,
  type MonitoringTargetCreatePayload,
} from '../../Modules/MonitoringTargetManager';
import { Manager as MonitoringActionFavourites } from '../../Modules/MonitoringActionFavourites';
import { Manager as IPCValidation } from '../../Modules/IPCValidation';

// The per-entity status-history reads take an optional trailing `WindowMs`:
// only samples from that long ago on (by this process's clock, so a browser
// with a skewed clock still gets the right window). The view modal draws the
// last hour, and every series otherwise came back with the whole 12h retention,
// on each reload. Absent, non-numeric or non-positive means everything kept,
// which is exactly what an older caller (or one that wants it all) gets.
function HistoryCutoff(WindowMs: unknown): number | null {
  if (WindowMs == null || WindowMs === '') return null;
  const Ms = Number(WindowMs);
  if (!Number.isFinite(Ms) || Ms <= 0) return null;
  return Date.now() - Ms;
}

// The tail of a series from `Cutoff` on. Series are stored oldest first, so
// the start is found by bisection; anything malformed is passed through as is.
function SamplesSince<T>(Samples: T[], Cutoff: number | null): T[] {
  if (Cutoff == null || !Array.isArray(Samples) || !Samples.length) return Samples;
  const Ts = (Sample: T) => Number((Sample as { ts?: unknown } | null)?.ts);
  if (!Number.isFinite(Ts(Samples[0]!))) return Samples;
  let Low = 0;
  let High = Samples.length;
  while (Low < High) {
    const Mid = (Low + High) >> 1;
    if (Ts(Samples[Mid]!) < Cutoff) Low = Mid + 1;
    else High = Mid;
  }
  return Low === 0 ? Samples : Samples.slice(Low);
}

// The same, for the readers that answer one series per critical entity.
function SeriesSince<T extends { samples?: unknown }>(List: T[], Cutoff: number | null): T[] {
  if (Cutoff == null || !Array.isArray(List)) return List;
  return List.map((Series) =>
    Series && Array.isArray(Series.samples)
      ? { ...Series, samples: SamplesSince(Series.samples, Cutoff) }
      : Series
  );
}

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

  RPC.handle(
    'GetMonitoringCheckHistory',
    async (_Event: unknown, CheckID: unknown, WindowMs?: unknown) => {
      try {
        CheckID = IPCValidation.MonitoringTargetID(CheckID, 'CheckID');
      } catch {
        return [];
      }
      return SamplesSince(getMonitoringCheckHistory(CheckID), HistoryCutoff(WindowMs));
    }
  );

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
    createTupleHandler<
      [number[], string, string, Record<string, unknown>, number[] | null],
      unknown
    >(
      (
        TargetIDs: unknown,
        Method: unknown,
        ActionID: unknown,
        Params: unknown,
        CheckIDs: unknown
      ) => [
        IPCValidation.MonitoringTargetIDList(TargetIDs),
        IPCValidation.MonitoringMethodID(Method),
        IPCValidation.MonitoringActionID(Method, ActionID),
        // Parameters are validated against the action that is actually being
        // run, so a value meant for one action cannot smuggle into another.
        IPCValidation.MonitoringActionParams(Method, ActionID, Params),
        // Optional: narrows the action to these checks (the list view's check
        // rows). Absent means every check of the method, as before.
        CheckIDs == null ? null : IPCValidation.MonitoringTargetIDList(CheckIDs, 'CheckIDs'),
      ],
      (
        TargetIDs: number[],
        Method: string,
        ActionID: string,
        Params: Record<string, unknown>,
        CheckIDs: number[] | null
      ) => MonitoringTargetManager.RunAction(TargetIDs, Method, ActionID, Params, CheckIDs)
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

  RPC.handle(
    'GetDummyClientHistory',
    async (_Event: unknown, UUID: unknown, WindowMs?: unknown) => {
      try {
        UUID = IPCValidation.DummyClientUUID(UUID);
      } catch {
        return [];
      }
      return SamplesSince(getDummyHistorySamples(UUID), HistoryCutoff(WindowMs));
    }
  );

  RPC.handle('GetClientHistory', async (_Event: unknown, UUID: unknown, WindowMs?: unknown) => {
    try {
      UUID = IPCValidation.UUID(UUID);
    } catch {
      return [];
    }
    return SamplesSince(getClientHistorySamples(UUID), HistoryCutoff(WindowMs));
  });

  // Takes no input: the list view's history column, every row in one read.
  RPC.handle('GetStatusHistoryOverview', async () => {
    return getStatusHistoryOverview();
  });

  RPC.handle(
    'GetClientApplicationHistory',
    async (_Event: unknown, UUID: unknown, WindowMs?: unknown) => {
      try {
        UUID = IPCValidation.UUID(UUID);
      } catch {
        return [];
      }
      return SeriesSince(getClientApplicationHistorySamples(UUID), HistoryCutoff(WindowMs));
    }
  );

  RPC.handle('GetClientUSBHistory', async (_Event: unknown, UUID: unknown, WindowMs?: unknown) => {
    try {
      UUID = IPCValidation.UUID(UUID);
    } catch {
      return [];
    }
    return SeriesSince(getClientUSBHistorySamples(UUID), HistoryCutoff(WindowMs));
  });

  RPC.handle(
    'GetClientDisplayHistory',
    async (_Event: unknown, UUID: unknown, WindowMs?: unknown) => {
      try {
        UUID = IPCValidation.UUID(UUID);
      } catch {
        return [];
      }
      return SeriesSince(getClientDisplayHistorySamples(UUID), HistoryCutoff(WindowMs));
    }
  );

  RPC.handle(
    'GetClientAudioHistory',
    async (_Event: unknown, UUID: unknown, WindowMs?: unknown) => {
      try {
        UUID = IPCValidation.UUID(UUID);
      } catch {
        return [];
      }
      return SeriesSince(getClientAudioHistorySamples(UUID), HistoryCutoff(WindowMs));
    }
  );

  RPC.handle(
    'GetClientNetworkHistory',
    async (_Event: unknown, UUID: unknown, WindowMs?: unknown) => {
      try {
        UUID = IPCValidation.UUID(UUID);
      } catch {
        return [];
      }
      return SeriesSince(getClientNetworkHistorySamples(UUID), HistoryCutoff(WindowMs));
    }
  );

  RPC.handle(
    'GetClientStorageHistory',
    async (_Event: unknown, UUID: unknown, WindowMs?: unknown) => {
      try {
        UUID = IPCValidation.UUID(UUID);
      } catch {
        return [];
      }
      return SeriesSince(getClientStorageHistorySamples(UUID), HistoryCutoff(WindowMs));
    }
  );

  RPC.handle(
    'GetClientSystemCheckHistory',
    async (_Event: unknown, UUID: unknown, WindowMs?: unknown) => {
      try {
        UUID = IPCValidation.UUID(UUID);
      } catch {
        return [];
      }
      return SeriesSince(getClientSystemCheckHistorySamples(UUID), HistoryCutoff(WindowMs));
    }
  );

  RPC.handle('GetClientVitalsHistory', async (_Event: unknown, UUID: unknown) => {
    try {
      UUID = IPCValidation.UUID(UUID);
    } catch {
      return { Cpu: [], Ram: [] };
    }
    return getClientVitalsHistory(UUID);
  });

  RPC.handle(
    'CreateMonitoringTarget',
    createTupleHandler<[MonitoringTargetCreatePayload], unknown>(
      (Payload: unknown) => IPCValidation.MonitoringTargetCreatePayload(Payload),
      (Payload) => MonitoringTargetManager.Create(Payload)
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

  RPC.handle(
    'MoveMonitoringCheck',
    createTupleHandler<[number, number], unknown>(
      (CheckID: unknown, ToTargetID: unknown) => [
        IPCValidation.MonitoringTargetID(CheckID, 'CheckID'),
        IPCValidation.MonitoringTargetID(ToTargetID),
      ],
      (CheckID: number, ToTargetID: number) =>
        MonitoringTargetManager.MoveCheck(CheckID, ToTargetID)
    )
  );
}

export { register };
