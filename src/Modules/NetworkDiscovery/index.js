const { randomUUID } = require('crypto');
const bonjour = require('bonjour');
const { CreateLogger } = require('../Logger');

const { clampInt, buildProbeTargets, probeHost } = require('./network-utils');

const Logger = CreateLogger('NetworkDiscovery');

const ACTIVE_SCANS = new Map();

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
    ProbePorts:
      Array.isArray(options.ProbePorts) && options.ProbePorts.length
        ? options.ProbePorts.filter(
            (p) => Number.isInteger(Number(p)) && Number(p) > 0 && Number(p) <= 65535
          ).map(Number)
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
  const key = String(result.Key || result.Address || '')
    .trim()
    .toLowerCase();
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
    Logger.warn('Bonjour browser setup failed:', error && error.message ? error.message : error);
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
    workers.push(
      (async () => {
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
              MethodHint:
                openPort === 80 || openPort === 443 || openPort === 8080 ? 'http' : 'ping',
            });
          }
          completed += 1;
          emitProgress(scan, completed, targets.length);
        }
      })()
    );
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
