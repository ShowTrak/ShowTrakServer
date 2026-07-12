import { randomUUID } from 'crypto';
import type { Result } from '../../types/result';
import { CreateLogger } from '../Logger';

import { clampInt, buildProbeTargets, probeHost } from './network-utils';

// Minimal structural types for the `bonjour-service` mDNS library, describing only
// the surface this module touches so the factory-style call sites stay unchanged.
interface BonjourService {
  addresses?: string[];
  type?: string;
  protocol?: string;
  host?: string;
  name?: string;
  port?: number;
  txt?: Record<string, unknown> | null;
}

interface BonjourBrowser {
  on(event: 'up', listener: (service: BonjourService) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  start(): void;
  update(): void;
  stop(): void;
}

interface BonjourInstance {
  find(options: Record<string, unknown>): BonjourBrowser;
  destroy(): void;
}

type BonjourFactory = (options?: Record<string, unknown>) => BonjourInstance;

// bonjour-service exports a class; wrap it so the `bonjour({...})` call below stays factory-style.
const { Bonjour } = require('bonjour-service') as {
  Bonjour: new (options?: Record<string, unknown>) => BonjourInstance;
};
const bonjour: BonjourFactory = (options) => new Bonjour(options);

const Logger = CreateLogger('NetworkDiscovery');

/** Raw options accepted by `Manager.Start`; every field is validated/coerced at runtime. */
interface ScanOptions {
  EnableBonjour?: unknown;
  EnableProbe?: unknown;
  TimeoutMs?: unknown;
  MaxHostsPerSubnet?: unknown;
  ProbePorts?: unknown;
  Concurrency?: unknown;
}

/** A single discovered host/service surfaced to the UI. */
interface DiscoveryResult {
  Key?: string;
  Name?: string | null;
  Hostname?: string | null;
  Address?: string;
  Source?: string;
  ServiceType?: string;
  Port?: number | null;
  TXT?: Record<string, unknown> | null;
  MethodHint?: string;
}

/** Payload passed to `emitEvent`, before the `ScanID` is attached. */
interface ScanEventPayload {
  Type: 'status' | 'result' | 'done';
  Status?: string;
  Message?: string;
  Progress?: { Current: number; Total: number; Percent: number };
  Result?: DiscoveryResult;
  Count?: number;
}

/** The event object delivered to the scan's `onEvent` callback. */
interface ScanEvent extends ScanEventPayload {
  ScanID: string;
}

interface Scan {
  ScanID: string;
  Cancelled: boolean;
  Finished: boolean;
  EnableBonjour: boolean;
  EnableProbe: boolean;
  TimeoutMs: number;
  MaxHostsPerSubnet: number;
  ProbePorts: number[];
  Concurrency: number;
  Seen: Set<string>;
  Browsers: BonjourBrowser[];
  BonjourInstance: BonjourInstance | null;
  Timer: ReturnType<typeof setTimeout> | null;
  ProbePromise: Promise<void> | null;
  onEvent: (payload: ScanEvent) => void;
}

const ACTIVE_SCANS = new Map<string, Scan>();

function createScan(options: ScanOptions, onEvent: (payload: ScanEvent) => void): Scan {
  const scanID = randomUUID();
  const scan: Scan = {
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
            (p: unknown) => Number.isInteger(Number(p)) && Number(p) > 0 && Number(p) <= 65535
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

function emitEvent(scan: Scan, payload: ScanEventPayload) {
  try {
    scan.onEvent({ ScanID: scan.ScanID, ...payload });
  } catch (error) {
    Logger.error('Failed to emit scan event:', error);
  }
}

function emitProgress(scan: Scan, current: number, total: number) {
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

function pushResult(scan: Scan, result: DiscoveryResult) {
  const key = String(result.Key || result.Address || '')
    .trim()
    .toLowerCase();
  if (!key || scan.Seen.has(key)) return;
  scan.Seen.add(key);
  emitEvent(scan, { Type: 'result', Result: result });
}

function stopBonjour(scan: Scan) {
  for (const browser of scan.Browsers) {
    try {
      browser.stop();
    } catch {
      /* intentional: browser teardown is best-effort during scan cleanup */
    }
  }
  scan.Browsers = [];
  if (scan.BonjourInstance) {
    try {
      scan.BonjourInstance.destroy();
    } catch {
      /* intentional: bonjour instance teardown is best-effort during scan cleanup */
    }
    scan.BonjourInstance = null;
  }
}

function finalizeScan(scan: Scan, status = 'completed') {
  if (!scan || scan.Finished) return;
  scan.Finished = true;
  if (scan.Timer) {
    try {
      clearTimeout(scan.Timer);
    } catch {
      /* intentional: clearing an already-fired timer is harmless */
    }
    scan.Timer = null;
  }
  stopBonjour(scan);
  ACTIVE_SCANS.delete(scan.ScanID);
  emitEvent(scan, { Type: 'done', Status: status, Count: scan.Seen.size });
}

function startBonjourScan(scan: Scan) {
  if (!scan.EnableBonjour) return;
  try {
    scan.BonjourInstance = bonjour({ reuseAddr: true, loopback: false });
  } catch (error) {
    Logger.error('Failed to initialize bonjour instance:', error);
    return;
  }

  try {
    const browser = scan.BonjourInstance.find({});
    browser.on('error', (error: Error) => {
      Logger.warn('Bonjour browser runtime error:', error && error.message ? error.message : error);
    });
    browser.on('up', (service: BonjourService) => {
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
        } catch {
          /* intentional: re-querying the mDNS browser is best-effort */
        }
      }, 100);
    } catch {
      /* intentional: some bonjour builds auto-start on find(); a redundant start() throwing is harmless */
    }
    scan.Browsers.push(browser);
  } catch (error) {
    Logger.warn(
      'Bonjour browser setup failed:',
      error instanceof Error ? error.message : error
    );
  }
}

async function startProbeScan(scan: Scan) {
  if (!scan.EnableProbe) return;
  const targets = buildProbeTargets(scan.MaxHostsPerSubnet);
  if (!targets.length) return;

  let index = 0;
  let completed = 0;
  const workers: Promise<void>[] = [];
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

const Manager = {
  Start: (options: ScanOptions = {}, onEvent: (payload: ScanEvent) => void): Result<{ ScanID: string }> => {
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
  },

  Stop: (scanID: unknown): Result<boolean> => {
    const id = String(scanID || '').trim();
    if (!id) return ['ScanID is required', null];
    const scan = ACTIVE_SCANS.get(id);
    if (!scan) return [null, true];
    scan.Cancelled = true;
    finalizeScan(scan, 'cancelled');
    return [null, true];
  },
};

export { Manager };
