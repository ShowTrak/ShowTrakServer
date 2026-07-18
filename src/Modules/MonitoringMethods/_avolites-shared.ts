// Shared Avolites (Titan OS) console client and helpers.
//
// Titan consoles (Sapphire Touch, Tiger Touch II, Quartz, Arena, Diamond 9, plus
// Titan Go / Simulator) expose a read-only HTTP+JSON "WebAPI" on TCP 4430. Every
// request is under /titan/. We only ever issue the two documented read-only GETs:
//   GET /titan/get/System/SoftwareVersion   → Titan software version
//   GET /titan/get/Show/ShowName            → current show file name
// (`set` and `script` calls change console state and are never sent.) There is no
// authentication once the WebAPI is enabled. The WebAPI is not guaranteed to be
// on, so a refused port is surfaced as "enable the WebAPI", not silently "down".
//
// The exact JSON envelope shifts across Titan versions, so value extraction is
// deliberately tolerant (bare string / quoted string / a value-bearing object).
// Any HTTP response at all means the console is reachable; only a refused/timed
// out connection is offline.
//
// The eos-* pattern is mirrored: one cached snapshot per console per tick, shared
// by the console-health and show-loaded checks.
import { Manager as CacheManager } from '../CacheManager';
import { PerformHttpRequest } from './_http-shared';
import { Pill, Rows, TextRow, Row, Note, FormatLatency, Esc } from './debug';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

export const DEFAULT_AVOLITES_PORT = 4430;

const VERSION_PATH = '/titan/get/System/SoftwareVersion';
const SHOWNAME_PATH = '/titan/get/Show/ShowName';

export const CommonAvolitesSettings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'Titan WebAPI port',
    Type: 'number',
    Default: DEFAULT_AVOLITES_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: 4000,
    Min: 500,
    Max: 30000,
    Advanced: true,
  },
];

// Pull a scalar value out of a Titan WebAPI response body, tolerating the
// envelope differences between Titan versions: a bare JSON string, a JSON scalar,
// or an object carrying the value under one of several common keys. Exported for
// unit tests.
export function ExtractTitanValue(Body: unknown): string | null {
  const Raw = String(Body == null ? '' : Body).trim();
  if (!Raw) return null;
  try {
    const Parsed = JSON.parse(Raw);
    if (typeof Parsed === 'string') return Parsed.trim() || null;
    if (typeof Parsed === 'number' || typeof Parsed === 'boolean') return String(Parsed);
    if (Parsed && typeof Parsed === 'object') {
      const Obj = Parsed as Record<string, unknown>;
      for (const Key of ['value', 'Value', 'result', 'Result', 'data', 'Data', 'name', 'Name']) {
        const V = Obj[Key];
        if (typeof V === 'string' && V.trim()) return V.trim();
        if (typeof V === 'number' || typeof V === 'boolean') return String(V);
      }
      return null;
    }
  } catch {
    // Not JSON — fall through to the raw text (stripping surrounding quotes).
  }
  return Raw.replace(/^"(.*)"$/, '$1') || null;
}

async function TitanGet(
  Address: string,
  Port: number,
  Path: string,
  TimeoutMs: number
): Promise<MonitoringResult> {
  // Drive the shared HTTP client with a fixed path and a wide accepted-status
  // range: any HTTP response (even 4xx) means the WebAPI is reachable; we judge
  // the status ourselves.
  return PerformHttpRequest(
    {
      Address,
      Settings: {
        Port,
        Path,
        Method: 'GET',
        Timeout: TimeoutMs,
        ExpectedStatusMin: 100,
        ExpectedStatusMax: 599,
      },
    },
    { Protocol: 'http', DefaultPort: Port, CaptureBody: true }
  );
}

export interface TitanSnapshot {
  Reachable: boolean;
  Error?: string;
  LatencyMs?: number;
  Status: number | null;
  Version: string | null;
  ShowName: string | null;
}

export async function QueryTitanStatus(
  Address: string,
  Port: number,
  TimeoutMs: number
): Promise<TitanSnapshot> {
  const VersionRes = await TitanGet(Address, Port, VERSION_PATH, TimeoutMs);
  if (!VersionRes.Success) {
    return {
      Reachable: false,
      Error: (VersionRes.Error as string) || 'No response from Titan WebAPI',
      Status: Number.isFinite(Number(VersionRes.Status)) ? Number(VersionRes.Status) : null,
      Version: null,
      ShowName: null,
    };
  }

  const Status = Number.isFinite(Number(VersionRes.Status)) ? Number(VersionRes.Status) : null;
  const Ok = Status != null && Status >= 200 && Status < 300;
  const Version = Ok ? ExtractTitanValue(VersionRes.Body) : null;

  // Show name is best-effort; a failure here does not make the console offline.
  let ShowName: string | null = null;
  const ShowRes = await TitanGet(Address, Port, SHOWNAME_PATH, TimeoutMs);
  if (ShowRes.Success) {
    const ShowStatus = Number(ShowRes.Status);
    if (ShowStatus >= 200 && ShowStatus < 300) ShowName = ExtractTitanValue(ShowRes.Body);
  }

  return {
    Reachable: true,
    LatencyMs: VersionRes.LatencyMs as number,
    Status,
    Version,
    ShowName,
  };
}

// --- Shared per-family snapshot cache ----------------------------------------

const TITAN_QUERY_CACHE = CacheManager.GetBucket('MonitoringMethods:TitanStatus', {
  defaultTtlMs: 1000,
  maxEntries: 1000,
});

export function BuildTitanQueryCacheKey(Address: unknown, Port: number, TimeoutMs: number): string {
  return `${String(Address || '')
    .trim()
    .toLowerCase()}|${Port}|${TimeoutMs}`;
}

export function ResolveTitanQueryCacheTtlMs(TimeoutMs: number): number {
  const Base = Number.isFinite(TimeoutMs) ? TimeoutMs : 4000;
  return Math.max(300, Math.min(1500, (Base / 2) | 0));
}

// --- Shared Run/Debug scaffolding -------------------------------------------

export interface AvolitesConfig {
  Address: string;
  Port: number;
  TimeoutMs: number;
}

export function ParseAvolitesConfig(Target: MonitoringTargetLike): AvolitesConfig {
  const Cfg = (Target && Target.Settings) || {};
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Port: Number.isFinite(Cfg.Port as number) ? (Cfg.Port as number) | 0 : DEFAULT_AVOLITES_PORT,
    TimeoutMs: Number.isFinite(Cfg.Timeout as number) ? (Cfg.Timeout as number) : 4000,
  };
}

export interface AvolitesContext {
  Config: AvolitesConfig;
  Snapshot: TitanSnapshot;
}

export async function RunAvolitesProbe(
  Target: MonitoringTargetLike
): Promise<{ Result: MonitoringResult } | { Ctx: AvolitesContext }> {
  const Config = ParseAvolitesConfig(Target);
  if (!Config.Address) return { Result: { Success: false, Error: 'No address configured' } };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Result: { Success: false, Error: `Invalid port: ${Config.Port}` } };
  }

  const Snapshot = (await TITAN_QUERY_CACHE.GetOrCreate(
    BuildTitanQueryCacheKey(Config.Address, Config.Port, Config.TimeoutMs),
    () => QueryTitanStatus(Config.Address, Config.Port, Config.TimeoutMs),
    { ttlMs: ResolveTitanQueryCacheTtlMs(Config.TimeoutMs) }
  )) as TitanSnapshot;

  if (!Snapshot.Reachable) {
    const ErrMsg = Snapshot.Error || 'No response from Titan WebAPI';
    const Refused = ErrMsg.includes('ECONNREFUSED') || ErrMsg.includes('ECONNRESET');
    return {
      Result: {
        Success: false,
        ...(Refused ? { Degraded: true } : {}),
        // A refused WebAPI port on an otherwise-healthy console is common, so
        // point at the likely cause.
        Error: Refused ? `${ErrMsg} — is the Titan WebAPI enabled?` : ErrMsg,
      },
    };
  }

  return { Ctx: { Config, Snapshot } };
}

export function AvolitesSnapshotExtras(Snapshot: TitanSnapshot): Record<string, unknown> {
  return {
    TitanVersion: Snapshot.Version,
    ShowName: Snapshot.ShowName,
    Status: Snapshot.Status,
  };
}

export function AvolitesStatePill(Result: MonitoringResult, OnlineText: string): string {
  const Reachable = !!(Result && Result.Success === true);
  const Degraded = !!(Result && Result.Degraded);
  if (Reachable && !Degraded) return Pill('success', OnlineText || 'Online');
  if (Reachable) return Pill('warning', (Result && Result.DegradedReason) || 'Degraded');
  return Pill('danger', 'Offline');
}

export function AvolitesDebugHead(
  Config: AvolitesConfig,
  Result: MonitoringResult,
  StatusPill: string,
  ExtraRows: Array<string | false | null | undefined>
): string {
  const Reachable = !!(Result && Result.Success === true);
  const Head = Rows([
    TextRow('Host', `${Config.Address || '—'}:${Config.Port}`),
    Result && Result.TitanVersion ? TextRow('Titan', String(Result.TitanVersion)) : null,
    Row('Status', StatusPill),
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Could not reach the WebAPI'),
    ...ExtraRows,
  ]);
  if (!Reachable) {
    return Head + '<div class="mt-2">' + Note('Could not reach the Titan WebAPI (TCP 4430)') + '</div>';
  }
  return Head;
}

export function AvolitesMonoRow(Label: string, Value: unknown): string {
  return Row(Label, `<span class="font-monospace">${Esc(String(Value))}</span>`);
}

export const _internal = {
  ExtractTitanValue,
  QueryTitanStatus,
  ParseAvolitesConfig,
  BuildTitanQueryCacheKey,
  ResolveTitanQueryCacheTtlMs,
  RunAvolitesProbe,
};
