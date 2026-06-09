// Pure network/IP helpers for the LAN discovery scanner: subnet enumeration,
// IPv4 <-> integer conversion, and low-level TCP port probing. These functions
// hold no scan state (any per-scan flags are passed in as arguments).
const os = require('os');
const net = require('net');

function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function ipv4ToInt(ip) {
  const parts = String(ip).split('.').map((part) => parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return (((parts[0] << 24) >>> 0) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function intToIPv4(intValue) {
  return `${(intValue >>> 24) & 255}.${(intValue >>> 16) & 255}.${(intValue >>> 8) & 255}.${intValue & 255}`;
}

function getLocalSubnets(maxHostsPerSubnet) {
  const interfaces = os.networkInterfaces() || {};
  const out = [];
  for (const [ifaceName, addresses] of Object.entries(interfaces)) {
    if (!Array.isArray(addresses)) continue;
    for (const addr of addresses) {
      if (!addr || addr.family !== 'IPv4' || addr.internal) continue;
      const ipInt = ipv4ToInt(addr.address);
      const cidr = String(addr.cidr || '').trim();
      const prefix = parseInt(cidr.split('/')[1], 10);
      if (ipInt == null || !Number.isInteger(prefix) || prefix < 8 || prefix > 30) continue;
      const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
      const base = (ipInt & mask) >>> 0;
      const broadcast = (base | (~mask >>> 0)) >>> 0;
      const hostCount = Math.max(0, broadcast - base - 1);
      const cappedHostCount = Math.min(hostCount, maxHostsPerSubnet);
      if (cappedHostCount <= 0) continue;
      out.push({
        Interface: ifaceName,
        CIDR: cidr,
        Base: base,
        FirstHost: base + 1,
        HostCount: cappedHostCount,
      });
    }
  }
  return out;
}

function buildProbeTargets(maxHostsPerSubnet) {
  const subnets = getLocalSubnets(maxHostsPerSubnet);
  const targets = [];
  const seen = new Set();
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

function probePort(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;

    const complete = (open) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {}
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

async function probeHost(ip, ports, timeoutMs, scan) {
  for (const port of ports) {
    if (scan.Cancelled) return null;
    const openPort = await probePort(ip, port, timeoutMs);
    if (openPort != null) return openPort;
  }
  return null;
}

module.exports = {
  clampInt,
  ipv4ToInt,
  intToIPv4,
  getLocalSubnets,
  buildProbeTargets,
  probePort,
  probeHost,
};
