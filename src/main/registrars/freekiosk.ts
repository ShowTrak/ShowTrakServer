// IPC registrar: FreeKiosk terminals.
//
// Follows the two handler contracts used throughout the registrars: readers
// return a raw value (with an empty fallback on bad input), mutations return the
// [Err, Result] tuple via createTupleHandler.
//
// Commands go through a single channel rather than one per action. Twenty
// channels would each need an entry in the registry, the preload bridge, the
// Web UI shim and the Web UI allowlist for no added safety — the command name is
// validated against the fixed FREEKIOSK_COMMANDS allowlist either way — and the
// single channel fans a bulk selection out server-side, so the context menu
// makes one call and gets one aggregate result.
import { RPC } from '../rpc';
import { createTupleHandler } from '../ipc/create-handler';
import { Manager as FreeKioskManager } from '../../Modules/FreeKioskManager';
import { Manager as IPCValidation } from '../../Modules/IPCValidation';
import {
  FREEKIOSK_METRICS,
  FREEKIOSK_METRIC_GROUPS,
  FREEKIOSK_SECTIONS,
  BuildFreeKioskAlarmFields,
} from '../../Modules/FreeKiosk/metrics';
import { FREEKIOSK_COMMANDS } from '../../Modules/FreeKiosk/commands';
import { getFreeKioskMetricHistory } from '../freekiosk-history';

function register(): void {
  // The metric registry, delivered rather than mirrored: the renderer cannot
  // import from src/Modules, and a hand-kept copy of ~60 metrics would drift.
  RPC.handle('FreeKiosk:GetMetrics', async () => {
    return {
      Metrics: FREEKIOSK_METRICS.map((Metric) => ({
        Key: Metric.Key,
        Label: Metric.Label,
        Type: Metric.Type,
        Section: Metric.Section,
        Chart: Metric.Chart,
        RequiresMode: Metric.RequiresMode ? Metric.RequiresMode.slice() : undefined,
        Unit: Metric.Unit,
        Decimals: Metric.Decimals,
        Min: Metric.Min,
        Max: Metric.Max,
        Options: Metric.Options ? Metric.Options.slice() : undefined,
        Operators: Metric.Operators.slice(),
        DefaultOperator: Metric.DefaultOperator,
        Format: Metric.Format,
        Advanced: Metric.Advanced,
        Note: Metric.Note,
      })),
      AlarmFields: BuildFreeKioskAlarmFields(),
      Sections: FREEKIOSK_SECTIONS.slice(),
      Groups: FREEKIOSK_METRIC_GROUPS.map((Group) => ({
        Key: Group.Key,
        Label: Group.Label,
        DefaultOn: Group.DefaultOn,
        Fixed: Group.Fixed,
        Note: Group.Note,
      })),
    };
  });

  RPC.handle('FreeKiosk:GetCommands', async () => FREEKIOSK_COMMANDS.slice());

  RPC.handle('GetAllFreeKioskTerminals', async () => {
    const [Err, List] = await FreeKioskManager.GetAll();
    if (Err) return [];
    return List || [];
  });

  RPC.handle('GetFreeKioskTerminal', async (_Event: unknown, UUID: unknown) => {
    let ValidUUID;
    try {
      ValidUUID = IPCValidation.FreeKioskUUID(UUID);
    } catch {
      return null;
    }
    // GetForEditor rather than Get: this reader answers the editor, which has to
    // show the stored API key it is about to let you change.
    const [Err, Terminal] = await FreeKioskManager.GetForEditor(ValidUUID);
    if (Err) return null;
    return Terminal;
  });

  // Every series in one call. A terminal has ~60 metrics and the view modal
  // reloads on each push while it is open, so a per-metric channel would mean
  // sixty round-trips every poll.
  RPC.handle(
    'FreeKiosk:GetHistory',
    async (_Event: unknown, UUID: unknown, MetricKeys: unknown) => {
      let ValidUUID;
      let ValidKeys;
      try {
        ValidUUID = IPCValidation.FreeKioskUUID(UUID);
        ValidKeys = IPCValidation.FreeKioskMetricKeys(MetricKeys);
      } catch {
        return [];
      }
      return getFreeKioskMetricHistory(ValidUUID, ValidKeys);
    }
  );

  RPC.handle('GenerateFreeKioskTerminalDefaults', async () => {
    return await FreeKioskManager.GenerateDefaults();
  });

  RPC.handle('FreeKiosk:GetCameraList', async (_Event: unknown, UUID: unknown) => {
    let ValidUUID;
    try {
      ValidUUID = IPCValidation.FreeKioskUUID(UUID);
    } catch {
      return [];
    }
    const [Err, Cameras] = await FreeKioskManager.GetCameraList(ValidUUID);
    if (Err) return [];
    return Cameras || [];
  });

  RPC.handle(
    'CreateFreeKioskTerminal',
    createTupleHandler<[Record<string, unknown>], unknown>(
      (Payload: unknown) => IPCValidation.FreeKioskCreatePayload(Payload),
      (Payload: Record<string, unknown>) => FreeKioskManager.Create(Payload)
    )
  );

  RPC.handle(
    'UpdateFreeKioskTerminal',
    createTupleHandler<[string, Record<string, unknown>], unknown>(
      (UUID: unknown, Payload: unknown) => [
        IPCValidation.FreeKioskUUID(UUID),
        IPCValidation.FreeKioskUpdatePayload(Payload),
      ],
      (UUID: string, Payload: Record<string, unknown>) => FreeKioskManager.Update(UUID, Payload)
    )
  );

  RPC.handle(
    'DeleteFreeKioskTerminal',
    createTupleHandler<[string], unknown>(
      (UUID: unknown) => IPCValidation.FreeKioskUUID(UUID),
      (UUID: string) => FreeKioskManager.Delete(UUID),
      // Matches the other Delete/* handlers: the renderer reads the payload slot
      // as a boolean success flag.
      { invalidFallback: false }
    )
  );

  RPC.handle(
    'FreeKiosk:RunNow',
    createTupleHandler<[string[]], unknown>(
      // Wrapped in an outer array on purpose: createTupleHandler spreads an
      // array return across the run() parameters, so returning the UUID list
      // bare would call RunNow('uuid-1') instead of RunNow(['uuid-1']).
      (UUIDs: unknown) => [IPCValidation.FreeKioskUUIDList(UUIDs)],
      (UUIDs: string[]) => FreeKioskManager.RunNow(UUIDs)
    )
  );

  RPC.handle(
    'FreeKiosk:Command',
    createTupleHandler<[string[], string, Record<string, unknown>], unknown>(
      (UUIDs: unknown, Command: unknown, Params: unknown) => [
        IPCValidation.FreeKioskUUIDList(UUIDs),
        IPCValidation.FreeKioskCommand(Command),
        // Parameters are validated against the command that is actually being
        // sent, so a URL for one command cannot smuggle a payload into another.
        IPCValidation.FreeKioskCommandParams(Command, Params),
      ],
      (UUIDs: string[], Command: string, Params: Record<string, unknown>) =>
        FreeKioskManager.SendCommand(UUIDs, Command, Params)
    )
  );

  RPC.handle(
    'FreeKiosk:CaptureScreenshot',
    createTupleHandler<[string], unknown>(
      (UUID: unknown) => IPCValidation.FreeKioskUUID(UUID),
      (UUID: string) => FreeKioskManager.Capture(UUID, 'screenshot')
    )
  );

  RPC.handle(
    'FreeKiosk:CaptureCamera',
    createTupleHandler<[string, { Camera: 'front' | 'back'; Quality: number }], unknown>(
      (UUID: unknown, Options: unknown) => [
        IPCValidation.FreeKioskUUID(UUID),
        IPCValidation.FreeKioskCapturePayload(Options),
      ],
      (UUID: string, Options: { Camera: 'front' | 'back'; Quality: number }) =>
        FreeKioskManager.Capture(UUID, 'camera', Options)
    )
  );
}

export { register };
