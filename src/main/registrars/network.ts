// IPC registrar: LAN network-discovery scans. Extracted verbatim from main.ts.

import { RPC } from '../rpc';
import { validationErrorTuple } from '../ipc/create-handler';
import { PushToRenderers } from '../renderer-bus';
import { hasMainWindow } from '../app-window';
import type { IPCValidationManager } from '../../Modules/IPCValidation';
const { Manager: NetworkDiscoveryManager } = require('../../Modules/NetworkDiscovery') as typeof import('../../Modules/NetworkDiscovery');
const { Manager: IPCValidation }: { Manager: IPCValidationManager } = require('../../Modules/IPCValidation');

function register(): void {
  RPC.handle('NetworkDiscovery:Start', async (_Event: unknown, Options: unknown) => {
    let ValidOptions;
    try {
      ValidOptions = IPCValidation.NetworkDiscoveryScanOptions(Options);
    } catch (error) {
      return validationErrorTuple(error);
    }
    const [Err, Result] = NetworkDiscoveryManager.Start(ValidOptions, (Payload: unknown) => {
      if (!hasMainWindow()) return;
      PushToRenderers('NetworkDeviceScanEvent', Payload);
    });
    if (Err) return [Err, null];
    return [null, Result];
  });

  RPC.handle('NetworkDiscovery:Stop', async (_Event: unknown, ScanID: unknown) => {
    try {
      ScanID = IPCValidation.NetworkDiscoveryScanID(ScanID);
    } catch (error) {
      return validationErrorTuple(error, false);
    }
    const [Err, Result] = NetworkDiscoveryManager.Stop(ScanID);
    if (Err) return [Err, null];
    return [null, Result];
  });
}

export { register };
