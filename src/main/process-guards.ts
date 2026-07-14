// Process-wide last line of defence for network faults.
//
// Most of the app's sockets handle their own 'error' events (sACN, ArtNet,
// Millumin listeners; the WOL sender; the OSC server). But some errors originate
// several layers deep in third-party libraries or native code and surface as an
// uncaught exception or unhandled rejection before any of our try/catch or
// per-socket handlers can see them — the classic case being the mDNS multicast
// responder throwing `send EADDRNOTAVAIL 224.0.0.251:5353` the instant Ethernet
// is unplugged or Wi-Fi is switched off.
//
// This installs one `uncaughtException` / `unhandledRejection` pair that:
//   - Swallows transient network errors (interface loss is expected and
//     self-heals) with a warning, so a NIC flap never crashes a live show.
//   - Logs anything else loudly as a fatal-but-survived error. We deliberately do
//     NOT exit: for a show-control server, staying up and degraded beats dying
//     mid-show. Genuine bugs are still visible in the logs at error level.
import { CreateLogger } from '../Modules/Logger';
import { IsTransientNetworkError, DescribeError } from '../Modules/NetworkErrors';

const Logger = CreateLogger('ProcessGuard');

let Installed = false;

export function installProcessGuards(): void {
  if (Installed) return;
  Installed = true;

  process.on('uncaughtException', (Err: unknown) => {
    if (IsTransientNetworkError(Err)) {
      Logger.warn(`Ignored transient network error: ${DescribeError(Err)}`);
      return;
    }
    Logger.error('Uncaught exception (app kept alive):', Err);
  });

  process.on('unhandledRejection', (Reason: unknown) => {
    if (IsTransientNetworkError(Reason)) {
      Logger.warn(`Ignored transient network rejection: ${DescribeError(Reason)}`);
      return;
    }
    Logger.error('Unhandled promise rejection (app kept alive):', Reason);
  });

  Logger.log('Process-level network fault guards installed');
}
