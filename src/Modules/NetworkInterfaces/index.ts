// Central authority for the host's network interfaces.
//
// The OS can gain or lose interfaces at any time — a VLAN NIC coming up, a USB
// Ethernet adapter being plugged in, Wi-Fi dropping, a VPN connecting. Node
// exposes no event for this, so this module polls os.networkInterfaces() on a
// modest interval, diffs against the previous snapshot, and emits a 'change'
// event describing what was added/removed. Every part of the app that cares
// about interfaces (the sACN multicast receiver, the LAN discovery scanner, the
// Web UI address list) reads from here so there is a single definition of "an
// external IPv4 interface" and a single place that reacts to churn.
//
// The module is lazy: List()/Addresses() always read live, so callers work even
// before Init() is called (or in tests where polling is never started). Only the
// change notifications require Init() to have started the poll loop.
import os from 'os';
import { EventEmitter } from 'events';
import { CreateLogger } from '../Logger';

const Logger = CreateLogger('NetworkInterfaces');

export interface IPv4Interface {
  Name: string;
  Address: string;
  Netmask: string;
  CIDR: string | null;
  MAC: string | null;
  Internal: boolean;
}

export interface InterfaceChange {
  Added: IPv4Interface[];
  Removed: IPv4Interface[];
  Current: IPv4Interface[];
}

// How often to poll for interface add/remove. A few seconds is responsive enough
// for NICs coming and going without meaningfully loading the process.
const DEFAULT_POLL_INTERVAL_MS = 5000;
const MIN_POLL_INTERVAL_MS = 1000;

const Emitter = new EventEmitter();
// One listener per interested subsystem (sACN receiver, main-process bridge, …)
// plus headroom; keep the default 10-listener warning from firing spuriously.
Emitter.setMaxListeners(64);

let PollTimer: NodeJS.Timeout | null = null;
let PollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
let LastFingerprint: string | null = null;
let LastList: IPv4Interface[] = [];

// Read the current IPv4 interfaces. Internal (loopback) interfaces are excluded
// unless explicitly requested. Sorted deterministically so the fingerprint is
// stable regardless of the order the OS returns them in.
function ReadIPv4(IncludeInternal = false): IPv4Interface[] {
  let Ifaces: ReturnType<typeof os.networkInterfaces>;
  try {
    Ifaces = os.networkInterfaces();
  } catch {
    return [];
  }
  const Out: IPv4Interface[] = [];
  for (const [Name, List] of Object.entries(Ifaces || {})) {
    for (const Info of List || []) {
      const Family = (Info as { family?: string | number }).family;
      const IsV4 = Family === 'IPv4' || Family === 4;
      if (!IsV4 || !Info.address) continue;
      if (Info.internal && !IncludeInternal) continue;
      Out.push({
        Name,
        Address: Info.address,
        Netmask: Info.netmask || '',
        CIDR: Info.cidr || null,
        MAC: Info.mac || null,
        Internal: !!Info.internal,
      });
    }
  }
  Out.sort((A, B) => (A.Name + A.Address).localeCompare(B.Name + B.Address));
  return Out;
}

// A stable string identity for a set of interfaces: address changes, CIDR
// changes and NICs appearing/disappearing all change the fingerprint.
function Fingerprint(List: IPv4Interface[]): string {
  return List.map((I) => `${I.Name}|${I.Address}|${I.CIDR || I.Netmask}`).join(',');
}

// Pure add/remove diff by address, exported for unit testing.
export function ComputeChange(
  Prev: IPv4Interface[],
  Current: IPv4Interface[]
): { Added: IPv4Interface[]; Removed: IPv4Interface[] } {
  const PrevByAddr = new Set(Prev.map((I) => I.Address));
  const CurByAddr = new Set(Current.map((I) => I.Address));
  return {
    Added: Current.filter((I) => !PrevByAddr.has(I.Address)),
    Removed: Prev.filter((I) => !CurByAddr.has(I.Address)),
  };
}

function EmitChange(Change: InterfaceChange): void {
  // Isolate listener faults so one bad subscriber can't stop the others (e.g.
  // the sACN receiver must still reconcile even if a UI push throws).
  for (const Listener of Emitter.listeners('change')) {
    try {
      (Listener as (C: InterfaceChange) => void)(Change);
    } catch (Err) {
      Logger.warn(
        `Interface change listener failed: ${Err && (Err as Error).message ? (Err as Error).message : Err}`
      );
    }
  }
}

function Poll(): void {
  const Current = ReadIPv4(false);
  const FP = Fingerprint(Current);
  if (FP === LastFingerprint) return;
  const Prev = LastList;
  LastList = Current;
  LastFingerprint = FP;
  const { Added, Removed } = ComputeChange(Prev, Current);
  Logger.log(
    `Interfaces changed (+${Added.length}/-${Removed.length}); ` +
      `now ${Current.length} external IPv4: ${Current.map((I) => I.Address).join(', ') || 'none'}`
  );
  EmitChange({ Added, Removed, Current });
}

const Manager = {
  // Start watching for interface add/remove. Idempotent; the first call also
  // establishes the baseline snapshot without emitting a spurious change.
  Init(Opts?: { PollIntervalMs?: number }): void {
    if (Opts && Number.isFinite(Opts.PollIntervalMs)) {
      PollIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, Opts.PollIntervalMs as number);
    }
    LastList = ReadIPv4(false);
    LastFingerprint = Fingerprint(LastList);
    if (PollTimer) return;
    PollTimer = setInterval(Poll, PollIntervalMs);
    // Never hold the process (or a test runner) open on our account.
    if (typeof PollTimer.unref === 'function') PollTimer.unref();
    Logger.log(
      `Watching network interfaces every ${PollIntervalMs}ms ` +
        `(${LastList.length} external IPv4 present)`
    );
  },

  // Stop watching (shutdown / test teardown).
  Stop(): void {
    if (PollTimer) {
      clearInterval(PollTimer);
      PollTimer = null;
    }
    LastFingerprint = null;
    LastList = [];
  },

  // Live snapshot of the host's IPv4 interfaces. Reads on demand so it is always
  // current even if Init() was never called.
  List(IncludeInternal = false): IPv4Interface[] {
    return ReadIPv4(IncludeInternal);
  },

  // Convenience: just the external IPv4 addresses (used for multicast joins).
  Addresses(): string[] {
    return ReadIPv4(false).map((I) => I.Address);
  },

  // Subscribe to interface add/remove. Returns an unsubscribe function. Only
  // fires while Init() polling is active.
  OnChange(Listener: (Change: InterfaceChange) => void): () => void {
    Emitter.on('change', Listener);
    return () => Emitter.off('change', Listener);
  },
};

export { Manager };

// Exported for unit tests.
export const _internal = { ReadIPv4, Fingerprint, ComputeChange, Poll, Emitter };
