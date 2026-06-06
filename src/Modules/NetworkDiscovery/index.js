const os = require('os');
const net = require('net');
const { randomUUID } = require('crypto');
const bonjour = require('bonjour');
const { CreateLogger } = require('../Logger');

const Logger = CreateLogger('NetworkDiscovery');

const ACTIVE_SCANS = new Map();

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

function createScan(options, onEvent) {
  const scanID = randomUUID();
  const scan = {
    ScanID: scanID,
    Cancelled: false,
    Finished: false,
    EnableBonjour: !!options.EnableBonjour,
    EnableProbe: !!options.EnableProbe,
    TimeoutMs: clampInt(options.TimeoutMs, 3000, 60000, 12000),
    MaxHostsPerSubnet: clampInt(options.MaxHostsPerSubnet, 32, 2048, 512),
    ProbePorts: Array.isArray(options.ProbePorts) && options.ProbePorts.length
      ? options.ProbePorts.filter((p) => Number.isInteger(Number(p)) && Number(p) > 0 && Number(p) <= 65535).map(Number)
      : [80, 443, 22, 445, 3389, 8080],
    Concurrency: clampInt(options.Concurrency, 4, 96, 32),
    Seen: new Set(),
    Browsers: [],
    BonjourInstance: null,
    Timer: null,
    ProbePromise: null,
    onEvent,
  };
  return scan;
}

function emitEvent(scan, payload) {
  try {
    scan.onEvent({ ScanID: scan.ScanID, ...payload });
  } catch (error) {
    Logger.error('Failed to emit scan event:', error);
  }
}

function emitProgress(scan, current, total) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeCurrent = Math.max(0, Math.min(safeTotal, Number(current) || 0));
  const percent = safeTotal > 0 ? Math.round((safeCurrent / safeTotal) * 100) : 0;
  emitEvent(scan, {
    Type: 'status',
    Status: 'scanning',
    Progress: {
      Current: safeCurrent,
      Total: safeTotal,
      Percent: percent,
    },
  });
}

function pushResult(scan, result) {
  const key = String(result.Key || result.Address || '').trim().toLowerCase();
  if (!key || scan.Seen.has(key)) return;
  scan.Seen.add(key);
  emitEvent(scan, { Type: 'result', Result: result });
}

function stopBonjour(scan) {
  for (const browser of scan.Browsers) {
    try {
      browser.stop();
    } catch {}
  }
  scan.Browsers = [];
  if (scan.BonjourInstance) {
    try {
      scan.BonjourInstance.destroy();
    } catch {}
    scan.BonjourInstance = null;
  }
}

function finalizeScan(scan, status = 'completed') {
  if (!scan || scan.Finished) return;
  scan.Finished = true;
  if (scan.Timer) {
    try {
      clearTimeout(scan.Timer);
    } catch {}
    scan.Timer = null;
  }
  stopBonjour(scan);
  ACTIVE_SCANS.delete(scan.ScanID);
  emitEvent(scan, { Type: 'done', Status: status, Count: scan.Seen.size });
}

function startBonjourScan(scan) {
  if (!scan.EnableBonjour) return;
  try {
    scan.BonjourInstance = bonjour({ reuseAddr: true, loopback: false });
  } catch (error) {
    Logger.error('Failed to initialize bonjour instance:', error);
    return;
  }

  try {
    const browser = scan.BonjourInstance.find({});
    browser.on('error', (error) => {
      Logger.warn('Bonjour browser runtime error:', error && error.message ? error.message : error);
    });
    browser.on('up', (service) => {
      if (scan.Cancelled || scan.Finished || !service) return;
      const addresses = Array.isArray(service.addresses) ? service.addresses : [];
      const serviceType =
        service.type && service.protocol
          ? `_${service.type}._${service.protocol}`
          : service.type
            ? `_${service.type}`
            : 'unknown';
      const host = String(service.host || '').replace(/\.$/, '');
      for (const address of addresses) {
        if (!address || String(address).includes(':')) continue;
        const lowerType = String(service.type || '').toLowerCase();
        pushResult(scan, {
          Key: `bonjour:${String(address).toLowerCase()}:${String(serviceType).toLowerCase()}:${service.port || 0}`,
          Name: service.name || host || address,
          Hostname: host || null,
          Address: address,
          Source: 'bonjour',
          ServiceType: serviceType,
          Port: service.port || null,
          TXT: service.txt || null,
          MethodHint:
            lowerType === 'http' || lowerType === 'https' || lowerType === 'http-alt'
              ? 'http'
              : 'ping',
        });
      }
    });
    try {
      browser.start();
      setTimeout(() => {
        try {
          browser.update();
        } catch {}
      }, 100);
    } catch {}
    scan.Browsers.push(browser);
  } catch (error) {
    Logger.warn(
      'Bonjour browser setup failed:',
      error && error.message ? error.message : error
    );
  }
}

async function startProbeScan(scan) {
  if (!scan.EnableProbe) return;
  const targets = buildProbeTargets(scan.MaxHostsPerSubnet);
  if (!targets.length) return;

  let index = 0;
  let completed = 0;
  const workers = [];
  const workerCount = Math.min(scan.Concurrency, targets.length);

  emitProgress(scan, completed, targets.length);

  for (let worker = 0; worker < workerCount; worker++) {
    workers.push((async () => {
      while (!scan.Cancelled && !scan.Finished) {
        const current = index;
        index += 1;
        if (current >= targets.length) return;
        const ip = targets[current];
        const openPort = await probeHost(ip, scan.ProbePorts, 350, scan);
        if (scan.Cancelled || scan.Finished) return;
        if (openPort != null) {
          pushResult(scan, {
            Name: ip,
            Address: ip,
            Source: 'probe',
            Port: openPort,
            MethodHint: openPort === 80 || openPort === 443 || openPort === 8080 ? 'http' : 'ping',
          });
        }
        completed += 1;
        emitProgress(scan, completed, targets.length);
      }
    })());
  }

  await Promise.allSettled(workers);
  emitProgress(scan, targets.length, targets.length);
}

const Manager = {};

Manager.Start = (options = {}, onEvent) => {
  if (typeof onEvent !== 'function') return ['Callback is required', null];
  const scan = createScan(options || {}, onEvent);
  ACTIVE_SCANS.set(scan.ScanID, scan);

  emitEvent(scan, { Type: 'status', Status: 'starting' });

  startBonjourScan(scan);

  scan.ProbePromise = startProbeScan(scan)
    .catch((error) => {
      Logger.error('Probe scan failed:', error);
      emitEvent(scan, { Type: 'status', Status: 'error', Message: 'Probe scan failed' });
    })
    .finally(() => {
      if (!scan.EnableBonjour && !scan.Cancelled && !scan.Finished) {
        finalizeScan(scan, 'completed');
      }
    });

  scan.Timer = setTimeout(() => {
    if (scan.Cancelled || scan.Finished) return;
    finalizeScan(scan, 'completed');
  }, scan.TimeoutMs);

  emitEvent(scan, { Type: 'status', Status: 'scanning' });
  return [null, { ScanID: scan.ScanID }];
};

Manager.Stop = (scanID) => {
  const id = String(scanID || '').trim();
  if (!id) return ['ScanID is required', null];
  const scan = ACTIVE_SCANS.get(id);
  if (!scan) return [null, true];
  scan.Cancelled = true;
  finalizeScan(scan, 'cancelled');
  return [null, true];
};

module.exports = {
  Manager,
};
