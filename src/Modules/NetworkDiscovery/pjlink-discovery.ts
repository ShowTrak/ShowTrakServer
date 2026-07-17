// PJLink Class 2 UDP discovery (JBMIA PJLink spec §UDP search). A controller
// broadcasts `%2SRCH\r` to UDP 4352; each Class 2 projector on the subnet
// replies from UDP 4352 with `%2ACKN=<MAC>\r` after a random 0–10s delay. The
// projector's IP is the source address of that datagram.
//
// Class 1-only projectors do not answer SRCH — those are still found by the
// TCP 4352 port probe in the main scanner. This strategy is purely additive.
import dgram from 'dgram';
import { CreateLogger } from '../Logger';
import { getBroadcastAddresses } from './network-utils';

const Logger = CreateLogger('NetworkDiscovery:PJLink');

export const PJLINK_UDP_PORT = 4352;

// The SRCH search datagram: '%2SRCH' + CR.
export function BuildSearchDatagram(): Buffer {
  return Buffer.from('%2SRCH\r', 'ascii');
}

// Parse an ACKN reply, returning the projector MAC (as sent) or null when the
// datagram is not a well-formed `%2ACKN=<MAC>` response. Case-insensitive and
// tolerant of trailing CR/LF/whitespace.
export function ParseAcknResponse(Msg: unknown): string | null {
  const Str = Buffer.isBuffer(Msg) ? Msg.toString('ascii') : String(Msg == null ? '' : Msg);
  const Match = Str.trim().match(/^%2ACKN=([0-9a-fA-F:.-]{1,64})\s*$/i);
  return Match && Match[1] ? Match[1].trim() : null;
}

export interface PJLinkDiscoveryHandle {
  Stop(): void;
}

export interface PJLinkDiscoveryOptions {
  DurationMs: number;
  OnProjector: (Projector: { Address: string; Mac: string }) => void;
  // Injectable for tests (default 4352).
  TargetPort?: number;
  // Injectable for tests; defaults to every local subnet broadcast plus the
  // limited broadcast address.
  BroadcastAddresses?: string[];
}

// Start a best-effort PJLink discovery. Datagram send/socket errors are logged,
// never thrown — a projector found this way is a bonus on top of the TCP probe.
export function StartPJLinkDiscovery(Options: PJLinkDiscoveryOptions): PJLinkDiscoveryHandle {
  const Port = Options.TargetPort || PJLINK_UDP_PORT;
  const Targets =
    Options.BroadcastAddresses && Options.BroadcastAddresses.length
      ? Options.BroadcastAddresses
      : ['255.255.255.255', ...getBroadcastAddresses()];

  let Closed = false;
  const Timers: Array<ReturnType<typeof setTimeout>> = [];
  const Socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  const Stop = () => {
    if (Closed) return;
    Closed = true;
    for (const Timer of Timers) {
      try {
        clearTimeout(Timer);
      } catch {
        /* intentional: clearing a fired timer is harmless */
      }
    }
    try {
      Socket.close();
    } catch {
      /* intentional: closing an already-closed socket is harmless */
    }
  };

  Socket.on('error', (Err: Error) => {
    Logger.warn('PJLink discovery socket error:', Err && Err.message ? Err.message : Err);
    Stop();
  });

  Socket.on('message', (Msg: Buffer, RInfo: dgram.RemoteInfo) => {
    if (Closed) return;
    const Mac = ParseAcknResponse(Msg);
    if (!Mac || !RInfo || !RInfo.address) return;
    try {
      Options.OnProjector({ Address: RInfo.address, Mac });
    } catch (Err) {
      Logger.error('PJLink discovery callback failed:', Err);
    }
  });

  const SendSearch = () => {
    if (Closed) return;
    const Datagram = BuildSearchDatagram();
    for (const Target of Targets) {
      try {
        Socket.send(Datagram, Port, Target);
      } catch (Err) {
        Logger.warn(`PJLink SRCH to ${Target} failed:`, Err instanceof Error ? Err.message : Err);
      }
    }
  };

  try {
    Socket.bind(() => {
      if (Closed) return;
      try {
        Socket.setBroadcast(true);
      } catch (Err) {
        Logger.warn('Failed to enable broadcast:', Err instanceof Error ? Err.message : Err);
      }
      // Projectors reply with a random 0–10s jitter, so re-send a few times
      // across the scan window to catch late responders.
      SendSearch();
      const Cap = Math.max(0, Options.DurationMs | 0);
      for (const Delay of [2000, 5000]) {
        if (Delay < Cap) Timers.push(setTimeout(SendSearch, Delay));
      }
    });
  } catch (Err) {
    Logger.warn('PJLink discovery bind failed:', Err instanceof Error ? Err.message : Err);
    Stop();
  }

  return { Stop };
}
