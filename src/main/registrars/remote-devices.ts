// IPC registrar: paired ShowTrak Remote devices (list / revoke / revoke all) and
// the short-lived pairing codes the settings pane renders as a QR.
//
// This surface is DESKTOP ONLY, and deliberately absent from both remote channel
// allowlists. A phone must not be able to enumerate the other phones paired to a
// workspace, and — more to the point — must not be able to revoke them: a stolen
// device that can revoke every other device turns one compromised phone into a
// locked-out production. Revocation is a decision made at the desk.

import { RPC } from '../rpc';
import { CreateLogger } from '../../Modules/Logger';
import { Manager as BroadcastManager } from '../../Modules/Broadcast';
import { Manager as RemoteDeviceManager } from '../../Modules/RemoteDeviceManager';

const Logger = CreateLogger('Main');

function register(): void {
  RPC.handle('Remote:GetDevices', async () => {
    return RemoteDeviceManager.GetAll();
  });

  RPC.handle('Remote:RevokeDevice', async (_Event: unknown, DeviceID: unknown) => {
    const [Err, RevokedID] = await RemoteDeviceManager.Revoke(DeviceID);
    if (Err) return [Err, null];
    // Eject the live session too. The `/sdk` namespace listens for this; without
    // it a connected phone would keep its socket — and full control — until it
    // happened to reconnect, which is exactly the window revocation exists to
    // close.
    BroadcastManager.emit('RemoteDeviceRevoked', RevokedID);
    return [null, RevokedID];
  });

  RPC.handle('Remote:RevokeAllDevices', async () => {
    const [Err] = await RemoteDeviceManager.RevokeAll();
    if (Err) return [Err, null];
    // A null target means "every device session", not "one unnamed device".
    BroadcastManager.emit('RemoteDeviceRevoked', null);
    return [null, true];
  });

  // Issue a pairing code for display as a QR. Deliberately not a reader: each
  // call mints a fresh single-use code and discards the previous one, so the
  // renderer must ask for one only when it is actually about to show it.
  RPC.handle('Remote:IssuePairingCode', async () => {
    try {
      return [null, RemoteDeviceManager.IssuePairingCode()];
    } catch (e) {
      Logger.error('Failed to issue a pairing code:', e);
      return ['Failed to issue a pairing code', null];
    }
  });

  // Invalidate the displayed code — the pane closing, or the operator cancelling.
  // A code that is no longer on screen should not still be redeemable for the
  // remainder of its minute.
  RPC.handle('Remote:ClearPairingCode', async () => {
    RemoteDeviceManager.ClearPairingCodes();
    return [null, true];
  });
}

export { register };
