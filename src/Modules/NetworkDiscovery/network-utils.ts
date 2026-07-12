// Pure network/IP helpers for the LAN discovery scanner: subnet enumeration,
// IPv4 <-> integer conversion, and low-level TCP port probing. These functions
// hold no scan state (any per-scan flags are passed in as arguments).
import net from 'net';
import { Manager as NetworkInterfaces } from '../NetworkInterfaces';

export interface Subnet {
  Interface: string;
  CIDR: string;
  Base: number;
  FirstHost: number;
  HostCount: number;
}

export interface ScanState {
  Cancelled?: boolean;
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function ipv4ToInt(ip: unknown): number | null {
  const parts = String(ip)
    .split('.')
    .map((part) => parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null;
  }
  return (((parts[0] << 24) >>> 0) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function intToIPv4(intValue: number): string {
  return `${(intValue >>> 24) & 255}.${(intValue >>> 16) & 255}.${(intValue >>> 8) & 255}.${intValue & 255}`;
}

export function getLocalSubnets(maxHostsPerSubnet: number): Subnet[] {
  // Read the current external IPv4 interfaces from the central authority so a
  // scan always reflects the live interface set (NICs added/removed since boot).
  const out: Subnet[] = [];
  for (const iface of NetworkInterfaces.List(false)) {
    const ipInt = ipv4ToInt(iface.Address);
    const cidr = String(iface.CIDR || '').trim();
    const prefix = parseInt(cidr.split('/')[1], 10);
    if (ipInt == null || !Number.isInteger(prefix) || prefix < 8 || prefix > 30) continue;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const base = (ipInt & mask) >>> 0;
    const broadcast = (base | (~mask >>> 0)) >>> 0;
    const hostCount = Math.max(0, broadcast - base - 1);
    const cappedHostCount = Math.min(hostCount, maxHostsPerSubnet);
    if (cappedHostCount <= 0) continue;
    out.push({
      Interface: iface.Name,
      CIDR: cidr,
      Base: base,
      FirstHost: base + 1,
      HostCount: cappedHostCount,
    });
  }
  return out;
}

export function buildProbeTargets(maxHostsPerSubnet: number): string[] {
  const subnets = getLocalSubnets(maxHostsPerSubnet);
  const targets: string[] = [];
  const seen = new Set<string>();
  for (const subnet of subnets) {
    for (let offset = 0; offset < subnet.HostCount; offset++) {
      const ip = intToIPv4(subnet.FirstHost + offset);
      if (seen.has(ip)) continue;
      seen.add(ip);
      targets.push(ip);
    }
  }
  return targets;
}

export function probePort(ip: string, port: number, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;

    const complete = (open: boolean) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        /* intentional: destroying an already-closed probe socket is harmless */
      }
      resolve(open ? port : null);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => complete(true));
    socket.once('timeout', () => complete(false));
    socket.once('error', () => complete(false));

    try {
      socket.connect(port, ip);
    } catch {
      complete(false);
    }
  });
}

export async function probeHost(
  ip: string,
  ports: number[],
  timeoutMs: number,
  scan: ScanState
): Promise<number | null> {
  for (const port of ports) {
    if (scan.Cancelled) return null;
    const openPort = await probePort(ip, port, timeoutMs);
    if (openPort != null) return openPort;
  }
  return null;
}
