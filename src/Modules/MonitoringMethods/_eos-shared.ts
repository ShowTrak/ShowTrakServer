// Shared ETC Eos-family (Eos Ti, Gio, Ion Xe, Element, ETCnomad) OSC client and
// helpers.
//
// Eos speaks OSC over TCP (default port 3032) with no authentication. On connect
// the console does NOT push a handshake, so the probe drives the exchange:
//   /eos/user       0          — act as the "background" OSC user (id 0) so the
//                                probe never touches the live operator's command
//                                line. Non-intrusive and side-effect free.
//   /eos/ping       <token>    — Eos replies /eos/out/ping echoing the argument;
//                                the round trip is the liveness + latency signal.
//   /eos/get/version           — replies /eos/out/get/version with the software
//                                version string (a direct request/response — no
//                                subscription needed).
//   /eos/get/cuelist/count     — replies /eos/out/get/cuelist/count <int>.
//   /eos/get/patch/count       — replies /eos/out/get/patch/count <int>.
// Any /eos/out/... reply positively identifies an Eos console (not just an open
// port). All of the above are read-only; the probe never sends /eos/reset (which
// mutates OSC session state) or any command-line keyword.
//
// TCP framing is selectable on the console ("OSC TCP Mode"): OSC 1.0 uses an
// int32 packet-length prefix (Eos default on 3032), OSC 1.1 uses SLIP (and Eos
// exposes a SLIP-only port, 3037). The framing is therefore a per-check setting.
//
// Like PJLink, the whole eos-* family funnels through a single cached status
// snapshot per console per tick so the health and show checks share one
// connection.
import net from 'net';
import { Manager as CacheManager } from '../CacheManager';
import { EncodeOscTcp, DecodeOscStream, type OscFraming } from './_osc-shared';
import { Esc, Pill, Rows, TextRow, Row, Note, FormatLatency } from './debug';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

export const DEFAULT_EOS_PORT = 3032;

// The editor Settings every eos-* method shares (connection + framing).
export const CommonEosSettings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'OSC Port',
    Type: 'number',
    Default: DEFAULT_EOS_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
  },
  {
    Key: 'Framing',
    Label: 'OSC TCP framing (match the console’s OSC TCP Mode)',
    Type: 'select',
    Default: 'length',
    Options: [
      { value: 'length', label: 'OSC 1.0 (packet length) — Eos default' },
      { value: 'slip', label: 'OSC 1.1 (SLIP) — e.g. port 3037' },
    ],
    Advanced: true,
  },
  {
    Key: 'OscUser',
    Label: 'OSC user ID',
    Note: '0 is a background user that never touches the live command line. Change only if that user ID is already in use.',
    Type: 'number',
    Default: 0,
    Min: 0,
    Max: 99,
    Advanced: true,
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: 3000,
    Min: 300,
    Max: 30000,
    Advanced: true,
  },
];

// --- One-connection status snapshot -----------------------------------------

export interface EosSnapshot {
  Reachable: boolean;
  Error?: string;
  LatencyMs?: number;
  Version: string | null;
  CuelistCount: number | null;
  PatchCount: number | null;
  ShowName: string | null;
  ActiveCue: string | null;
}

const EMPTY_SNAPSHOT: Omit<EosSnapshot, 'Reachable' | 'Error'> = {
  Version: null,
  CuelistCount: null,
  PatchCount: null,
  ShowName: null,
  ActiveCue: null,
};

// A monotonically increasing token so each ping is distinguishable in logs; the
// reply is matched on the /eos/out/ping address (Eos echoes it back), so the
// exact token value is not load-bearing.
let PingCounter = 0;

// Match /eos/out/ping tolerating the trailing-slash rendering some Eos docs show.
function IsPingReply(Address: string): boolean {
  return Address === '/eos/out/ping' || Address.startsWith('/eos/out/ping/');
}

export async function QueryEosStatus(
  Address: string,
  Port: number,
  Framing: OscFraming,
  OscUser: number,
  TimeoutMs: number
): Promise<EosSnapshot> {
  return new Promise<EosSnapshot>((resolve) => {
    const Started = Date.now();
    const BudgetMs = Math.max(300, TimeoutMs | 0);
    const Socket = new net.Socket();
    let Stream = Buffer.alloc(0);
    let Settled = false;
    let SawAnyEosReply = false;
    let PingLatencyMs: number | null = null;
    const Snap: Omit<EosSnapshot, 'Reachable' | 'Error'> = { ...EMPTY_SNAPSHOT };
    let DeadlineTimer: ReturnType<typeof setTimeout> | null = null;

    const Finish = (Result: EosSnapshot) => {
      if (Settled) return;
      Settled = true;
      if (DeadlineTimer) {
        clearTimeout(DeadlineTimer);
        DeadlineTimer = null;
      }
      try {
        Socket.destroy();
      } catch {
        // ignore
      }
      resolve(Result);
    };

    const Fail = (Error0: string) => Finish({ Reachable: false, Error: Error0, ...EMPTY_SNAPSHOT });

    // We have what we need once the ping has echoed and the version is known.
    // Counts are best-effort within the window.
    const Done = (): boolean => PingLatencyMs != null && Snap.Version != null;

    const Succeed = () =>
      Finish({
        Reachable: true,
        LatencyMs: PingLatencyMs != null ? PingLatencyMs : Date.now() - Started,
        ...Snap,
      });

    Socket.setNoDelay(true);
    Socket.setTimeout(BudgetMs);

    DeadlineTimer = setTimeout(() => {
      // Any Eos reply at all means the console is reachable; only a total
      // silence is an offline/timeout.
      if (SawAnyEosReply) Succeed();
      else Fail(`No OSC reply from Eos after ${BudgetMs}ms`);
    }, BudgetMs);

    Socket.once('connect', () => {
      try {
        // Background OSC user so the probe never disturbs the live operator.
        Socket.write(EncodeOscTcp('/eos/user', [{ Int: OscUser }], Framing));
        Socket.write(EncodeOscTcp('/eos/ping', [`showtrak-${++PingCounter}`], Framing));
        Socket.write(EncodeOscTcp('/eos/get/version', [], Framing));
        Socket.write(EncodeOscTcp('/eos/get/cuelist/count', [], Framing));
        Socket.write(EncodeOscTcp('/eos/get/patch/count', [], Framing));
      } catch (Err) {
        Fail(Err instanceof Error ? Err.message : String(Err));
      }
    });

    Socket.on('data', (Chunk: Buffer) => {
      Stream = Buffer.concat([Stream, Chunk]);
      if (Stream.length > 2_000_000) {
        Fail('OSC reply too large');
        return;
      }
      const { Messages, Rest } = DecodeOscStream(Stream, Framing);
      Stream = Rest;
      for (const Msg of Messages) {
        if (!Msg.Address.startsWith('/eos/out')) continue;
        SawAnyEosReply = true;
        if (IsPingReply(Msg.Address)) {
          if (PingLatencyMs == null) PingLatencyMs = Date.now() - Started;
        } else if (Msg.Address === '/eos/out/get/version') {
          const V = Msg.Args.find((A) => typeof A === 'string');
          if (V != null) Snap.Version = String(V);
        } else if (Msg.Address === '/eos/out/get/cuelist/count') {
          const N = Msg.Args.find((A) => typeof A === 'number');
          if (N != null) Snap.CuelistCount = Number(N);
        } else if (Msg.Address === '/eos/out/get/patch/count') {
          const N = Msg.Args.find((A) => typeof A === 'number');
          if (N != null) Snap.PatchCount = Number(N);
        } else if (Msg.Address === '/eos/out/show/name') {
          const V = Msg.Args.find((A) => typeof A === 'string');
          if (V != null) Snap.ShowName = String(V);
        } else if (Msg.Address === '/eos/out/active/cue/text') {
          const V = Msg.Args.find((A) => typeof A === 'string');
          if (V != null) Snap.ActiveCue = String(V);
        }
      }
      if (Done()) Succeed();
    });

    Socket.once('timeout', () => {
      if (SawAnyEosReply) Succeed();
      else Fail(`No OSC reply from Eos after ${BudgetMs}ms`);
    });

    Socket.once('error', (Err: Error) => {
      Fail(Err && Err.message ? Err.message : String(Err));
    });

    Socket.once('close', () => {
      if (Settled) return;
      if (SawAnyEosReply) Succeed();
      else Fail('Connection closed before any Eos reply');
    });

    try {
      Socket.connect(Port, Address);
    } catch (Err) {
      Fail(Err instanceof Error ? Err.message : String(Err));
    }
  });
}

// --- Shared per-family snapshot cache ----------------------------------------

const EOS_QUERY_CACHE = CacheManager.GetBucket('MonitoringMethods:EosStatus', {
  defaultTtlMs: 1000,
  maxEntries: 1000,
});

export function BuildEosQueryCacheKey(
  Address: unknown,
  Port: number,
  Framing: OscFraming,
  OscUser: number,
  TimeoutMs: number
): string {
  return `${String(Address || '')
    .trim()
    .toLowerCase()}|${Port}|${Framing}|${OscUser}|${TimeoutMs}`;
}

export function ResolveEosQueryCacheTtlMs(TimeoutMs: number): number {
  const Base = Number.isFinite(TimeoutMs) ? TimeoutMs : 3000;
  return Math.max(300, Math.min(1500, (Base / 2) | 0));
}

// --- Shared Run/Debug scaffolding -------------------------------------------

export interface EosConfig {
  Address: string;
  Port: number;
  Framing: OscFraming;
  OscUser: number;
  TimeoutMs: number;
}

export function ParseEosConfig(Target: MonitoringTargetLike): EosConfig {
  const Cfg = (Target && Target.Settings) || {};
  const OscUser = Number(Cfg.OscUser);
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Port: Number.isFinite(Cfg.Port as number) ? (Cfg.Port as number) | 0 : DEFAULT_EOS_PORT,
    Framing: String(Cfg.Framing) === 'slip' ? 'slip' : 'length',
    OscUser: Number.isFinite(OscUser) ? Math.max(0, OscUser | 0) : 0,
    TimeoutMs: Number.isFinite(Cfg.Timeout as number) ? (Cfg.Timeout as number) : 3000,
  };
}

export interface EosContext {
  Config: EosConfig;
  Snapshot: EosSnapshot;
}

// Validate config, fetch (or reuse) the cached snapshot, and apply the shared
// bad-config / unreachable checks. Returns an early { Result } for those cases,
// or { Ctx } with the live snapshot for the calling method to judge.
export async function RunEosProbe(
  Target: MonitoringTargetLike
): Promise<{ Result: MonitoringResult } | { Ctx: EosContext }> {
  const Config = ParseEosConfig(Target);
  if (!Config.Address) return { Result: { Success: false, Error: 'No address configured' } };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Result: { Success: false, Error: `Invalid port: ${Config.Port}` } };
  }

  const Snapshot = (await EOS_QUERY_CACHE.GetOrCreate(
    BuildEosQueryCacheKey(
      Config.Address,
      Config.Port,
      Config.Framing,
      Config.OscUser,
      Config.TimeoutMs
    ),
    () =>
      QueryEosStatus(Config.Address, Config.Port, Config.Framing, Config.OscUser, Config.TimeoutMs),
    { ttlMs: ResolveEosQueryCacheTtlMs(Config.TimeoutMs) }
  )) as EosSnapshot;

  if (!Snapshot.Reachable) {
    const ErrMsg = Snapshot.Error || 'No OSC reply from Eos';
    const IsResponseError = ErrMsg.includes('ECONNREFUSED') || ErrMsg.includes('ECONNRESET');
    return {
      Result: {
        Success: false,
        ...(IsResponseError ? { Degraded: true } : {}),
        Error: ErrMsg,
      },
    };
  }

  return { Ctx: { Config, Snapshot } };
}

// Extras every method attaches to a reachable result.
export function EosSnapshotExtras(Snapshot: EosSnapshot): Record<string, unknown> {
  return {
    EosVersion: Snapshot.Version,
    ShowName: Snapshot.ShowName,
    ActiveCue: Snapshot.ActiveCue,
    CuelistCount: Snapshot.CuelistCount,
    PatchCount: Snapshot.PatchCount,
  };
}

export function EosStatePill(Result: MonitoringResult, OnlineText: string): string {
  const Reachable = !!(Result && Result.Success === true);
  const Degraded = !!(Result && Result.Degraded);
  if (Reachable && !Degraded) return Pill('success', OnlineText || 'Online');
  if (Reachable) return Pill('warning', (Result && Result.DegradedReason) || 'Degraded');
  return Pill('danger', 'Offline');
}

// Render the shared debug-panel head (Host / identity / Status / reply time or
// error), with method-specific rows appended.
export function EosDebugHead(
  Config: EosConfig,
  Result: MonitoringResult,
  StatusPill: string,
  ExtraRows: Array<string | false | null | undefined>
): string {
  const Reachable = !!(Result && Result.Success === true);
  const Identity = [Result && Result.ShowName, Result && Result.EosVersion]
    .filter((Part) => Part != null && String(Part).trim() !== '')
    .join(' · ');
  const Head = Rows([
    TextRow('Host', `${Config.Address || '—'}:${Config.Port}`),
    Identity ? TextRow('Console', Identity) : null,
    Row('Status', StatusPill),
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Could not reach the console'),
    ...ExtraRows,
  ]);
  if (!Reachable) {
    return Head + '<div class="mt-2">' + Note('Could not reach the console over OSC') + '</div>';
  }
  return Head;
}

// Convenience for a monospace value row (e.g. a version string or count).
export function MonoRow(Label: string, Value: unknown): string {
  return Row(Label, `<span class="font-monospace">${Esc(String(Value))}</span>`);
}

export const _internal = {
  QueryEosStatus,
  ParseEosConfig,
  BuildEosQueryCacheKey,
  ResolveEosQueryCacheTtlMs,
  RunEosProbe,
  IsPingReply,
};
