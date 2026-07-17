import os from 'os';
import net from 'net';
import dgram from 'dgram';
import { CreateLogger } from '../Logger';
import type { Result } from '../../types/result';

const Logger = CreateLogger('WOLManager');

// The standard Wake-on-LAN discard port. WOL magic packets carry no payload the
// receiver reads, so the port is largely conventional (7 and 9 are both common).
const WOL_PORT = 9;

// A magic packet is 6 bytes of 0xFF ("synchronization stream") followed by the
// target MAC repeated 16 times — 6 + (6 * 16) = 102 bytes total.
const SYNC_STREAM = 'ff'.repeat(6);
const MAC_REPEAT = 16;

// The IPv4 "limited broadcast" address. We send here in addition to each
// interface's subnet-directed broadcast because some target NICs/firmware only
// wake on one or the other; hitting both maximises coverage across every segment.
const LIMITED_BROADCAST = '255.255.255.255';

/** Strip separators from a MAC and validate it, returning its 12 lowercase hex chars. */
function NormalizeMac(Mac: string): string {
  const Hex = String(Mac).replace(/[:-]/g, '').toLowerCase();
  if (Hex.length !== 12 || /[^0-9a-f]/.test(Hex)) {
    throw new Error(`Invalid MAC address: ${Mac}`);
  }
  return Hex;
}

/** Build the 102-byte magic packet for a MAC address. */
function BuildMagicPacket(Mac: string): Buffer {
  return Buffer.from(SYNC_STREAM + NormalizeMac(Mac).repeat(MAC_REPEAT), 'hex');
}

/**
 * Directed-broadcast address for an interface: the network address with every
 * host bit set to 1 (e.g. 192.168.1.42 / 255.255.255.0 -> 192.168.1.255).
 */
function BroadcastAddress(Address: string, Netmask: string): string {
  const Ip = Address.split('.').map((Octet) => parseInt(Octet, 10));
  const Mask = Netmask.split('.').map((Octet) => parseInt(Octet, 10));
  return Ip.map((Octet, Index) => (Octet & (Mask[Index] ?? 0)) | ((Mask[Index] ?? 0) ^ 255)).join(
    '.'
  );
}

/**
 * Every external IPv4 interface paired with the broadcast addresses to send from
 * it. Each interface contributes one entry per destination — its subnet-directed
 * broadcast and the limited broadcast — bound to that interface's own source
 * address so each datagram egresses the correct segment.
 */
function BroadcastTargets(): Array<{ From: string; Broadcast: string }> {
  const Targets: Array<{ From: string; Broadcast: string }> = [];
  const Interfaces = os.networkInterfaces();
  for (const Name of Object.keys(Interfaces)) {
    for (const Iface of Interfaces[Name] || []) {
      if (Iface.internal || !net.isIPv4(Iface.address)) continue;
      const Directed = BroadcastAddress(Iface.address, Iface.netmask);
      // Dedupe in case a /32-style mask makes the directed broadcast identical
      // to the limited broadcast.
      for (const Broadcast of new Set([Directed, LIMITED_BROADCAST])) {
        Targets.push({ From: Iface.address, Broadcast });
      }
    }
  }
  return Targets;
}

/**
 * Send the magic packet `Count` times at `Interval` ms from one interface. The
 * socket is unref'd so a pending send never keeps the process alive, and every
 * exit path clears the timer and closes the socket exactly once.
 */
function SendFromInterface(
  Packet: Buffer,
  From: string,
  Broadcast: string,
  Count: number,
  Interval: number
): Promise<void> {
  return new Promise((Resolve, Reject) => {
    const Socket = dgram.createSocket('udp4');
    Socket.unref();

    let Remaining = Count;
    let Timer: NodeJS.Timeout | null = null;
    let Settled = false;

    const Finish = (Err?: Error | null): void => {
      if (Settled) return;
      Settled = true;
      if (Timer) clearInterval(Timer);
      try {
        Socket.close();
      } catch {
        /* intentional: socket may already be closing; teardown is best-effort */
      }
      if (Err) Reject(Err);
      else Resolve();
    };

    const SendOne = (): void => {
      Socket.send(Packet, 0, Packet.length, WOL_PORT, Broadcast, (Err) => {
        if (Err) return Finish(Err);
        Remaining -= 1;
        if (Remaining <= 0) Finish();
      });
    };

    Socket.once('error', Finish);
    Socket.bind(0, From, () => {
      // Bind failures surface via the 'error' event handled above, not here.
      Socket.setBroadcast(true);
      SendOne();
      if (Remaining > 0) Timer = setInterval(SendOne, Interval);
    });
  });
}

export const Manager = {
  /**
   * Broadcast a Wake-on-LAN magic packet for `MAC` on every external IPv4
   * interface. Returns the `[Err, Data]` result tuple used across managers.
   */
  async Wake(MAC: string, Count = 20, Interval = 50): Promise<Result<string>> {
    if (!MAC) {
      Logger.error('WOL Wake called with no MAC address');
      return ['No MAC address provided', null];
    }

    let Packet: Buffer;
    try {
      Packet = BuildMagicPacket(MAC);
    } catch (Err) {
      const Message = Err instanceof Error ? Err.message : String(Err);
      Logger.error(`WOL Wake rejected an invalid MAC: ${Message}`);
      return [Message, null];
    }

    const Targets = BroadcastTargets();
    if (!Targets.length) {
      Logger.error('WOL Wake found no external IPv4 interfaces to broadcast on');
      return ['No external IPv4 network interfaces available', null];
    }

    const Interfaces = new Set(Targets.map((Target) => Target.From));
    Logger.log(
      `WOL waking ${MAC} across ${Interfaces.size} interface(s): ` +
        Targets.map((Target) => `${Target.From}->${Target.Broadcast}`).join(', ')
    );

    try {
      await Promise.all(
        Targets.map((Target) =>
          SendFromInterface(Packet, Target.From, Target.Broadcast, Count, Interval)
        )
      );
      return [null, 'Wake On LAN packet sent successfully'];
    } catch (Err) {
      const Message = Err instanceof Error ? Err.message : String(Err);
      Logger.error(`WOL Wake failed: ${Message}`);
      return [Message, null];
    }
  },
};

// Exported for unit tests: the pure packet/address helpers touch no network.
export const _internal = {
  NormalizeMac,
  BuildMagicPacket,
  BroadcastAddress,
  BroadcastTargets,
};
