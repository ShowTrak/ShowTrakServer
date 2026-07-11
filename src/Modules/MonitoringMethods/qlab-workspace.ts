// QLab workspace monitoring. Opens a TCP connection to QLab's OSC API (default
// port 53000), sends an OSC `/workspaces` query, and inspects the JSON reply to
// confirm that a specific workspace — identified by its unique ID or its
// name/filename — is currently open on that machine.
//
// QLab can have several workspaces open at once; a match against any one of the
// reported workspaces is treated as a success.
//
// Result semantics (consumed by MonitoringTarget.Tick):
//   - No TCP connection / no OSC reply       -> offline   (Success: false)
//   - Reply received but workspace not found -> degraded  ("Incorrect Workspace")
//   - Target workspace present               -> online    (Success: true)
import net from 'net';
import { Manager as CacheManager } from '../CacheManager';
import { Esc, Pill, Rows, TextRow, Row, Note, FormatLatency } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'qlab-workspace';
const WORKSPACE_QUERY_CACHE = CacheManager.GetBucket('MonitoringMethods:QLabWorkspaceList', {
  defaultTtlMs: 1000,
  maxEntries: 1000,
});

const Settings: MonitoringSettingField[] = [
  { Key: 'Port', Label: 'OSC Port', Type: 'number', Default: 53000, Min: 1, Max: 65535 },
  {
    Key: 'Workspace',
    Label: 'Workspace name / filename or unique ID',
    Type: 'string',
    Default: '',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: 3000,
    Min: 200,
    Max: 30000,
    Advanced: true,
  },
];

// --- Minimal OSC helpers (SLIP TCP framing) --------------------------------
// QLab frames OSC packets over TCP using the double-ended SLIP protocol
// (RFC 1055) as required by the OSC 1.1 spec. We only ever send an
// argument-less `/workspaces` message and read string replies, so the
// encoder/decoder below is intentionally small.

const SLIP_END = 0xc0;
const SLIP_ESC = 0xdb;
const SLIP_ESC_END = 0xdc;
const SLIP_ESC_ESC = 0xdd;

function OscPad(Len: number): number {
  return (4 - (Len % 4)) % 4;
}

function EncodeOscString(Str: unknown): Buffer {
  const Body = Buffer.from(String(Str == null ? '' : Str), 'utf8');
  const WithNull = Buffer.concat([Body, Buffer.from([0])]);
  const Pad = OscPad(WithNull.length);
  return Pad ? Buffer.concat([WithNull, Buffer.alloc(Pad)]) : WithNull;
}

// Wrap a raw OSC packet in double-ended SLIP framing.
function SlipEncode(Packet: Buffer): Buffer {
  const Out: number[] = [SLIP_END];
  for (const Byte of Packet) {
    if (Byte === SLIP_END) {
      Out.push(SLIP_ESC, SLIP_ESC_END);
    } else if (Byte === SLIP_ESC) {
      Out.push(SLIP_ESC, SLIP_ESC_ESC);
    } else {
      Out.push(Byte);
    }
  }
  Out.push(SLIP_END);
  return Buffer.from(Out);
}

// Decode every complete SLIP frame from an accumulated stream buffer.
function SlipDecodeFrames(Buffer0: Buffer): Buffer[] {
  const Frames: Buffer[] = [];
  let Current: number[] = [];
  let Escaped = false;
  for (const Byte of Buffer0) {
    if (Byte === SLIP_END) {
      if (Current.length) Frames.push(Buffer.from(Current));
      Current = [];
      Escaped = false;
    } else if (Escaped) {
      Current.push(Byte === SLIP_ESC_END ? SLIP_END : Byte === SLIP_ESC_ESC ? SLIP_ESC : Byte);
      Escaped = false;
    } else if (Byte === SLIP_ESC) {
      Escaped = true;
    } else {
      Current.push(Byte);
    }
  }
  return Frames;
}

// Encode an argument-less OSC message and SLIP-frame it for TCP transport.
function EncodeOscMessageTcp(Address: string): Buffer {
  const Packet = Buffer.concat([EncodeOscString(Address), EncodeOscString(',')]);
  return SlipEncode(Packet);
}

function ReadOscString(Buf: Buffer, Offset: number): { Value: string; Next: number } {
  let End = Offset;
  while (End < Buf.length && Buf[End] !== 0) End++;
  const Value = Buf.toString('utf8', Offset, End);
  const LenWithNull = End - Offset + 1;
  const Next = Offset + LenWithNull + OscPad(LenWithNull);
  return { Value, Next };
}

// Pull every OSC string argument out of a single OSC message packet. Non-string
// argument types are skipped over so we can still reach later string args.
function ReadOscMessageStrings(Packet: Buffer): string[] {
  const Strings: string[] = [];
  try {
    const Address = ReadOscString(Packet, 0);
    if (!Address.Value.startsWith('/')) return Strings;
    const Tags = ReadOscString(Packet, Address.Next);
    if (!Tags.Value.startsWith(',')) return Strings;
    let Pos = Tags.Next;
    for (let i = 1; i < Tags.Value.length; i++) {
      const Tag = Tags.Value[i];
      if (Tag === 's' || Tag === 'S') {
        const S = ReadOscString(Packet, Pos);
        Strings.push(S.Value);
        Pos = S.Next;
      } else if (Tag === 'i' || Tag === 'f' || Tag === 'r' || Tag === 'c' || Tag === 'm') {
        Pos += 4;
      } else if (Tag === 'h' || Tag === 'd' || Tag === 't') {
        Pos += 8;
      } else if (Tag === 'T' || Tag === 'F' || Tag === 'N' || Tag === 'I') {
        // No payload bytes for these tags.
      } else if (Tag === 'b') {
        if (Pos + 4 > Packet.length) break;
        const Size = Packet.readUInt32BE(Pos);
        Pos += 4 + Size + OscPad(Size);
      } else {
        break;
      }
    }
  } catch {
    // Malformed packet — return whatever we managed to read.
  }
  return Strings;
}

// Shape of a single workspace entry from QLab's `/workspaces` JSON reply. All
// fields are optional/dynamic since the payload originates from the network.
interface QLabWorkspaceInfo {
  uniqueID?: unknown;
  displayName?: unknown;
  hasPasscode?: unknown;
  hasPasscodeSet?: unknown;
}

function TryParseWorkspaceData(Str: string): unknown[] | null {
  if (!Str || Str.indexOf('{') === -1) return null;
  try {
    const Obj = JSON.parse(Str);
    if (Obj && Array.isArray(Obj.data)) return Obj.data;
  } catch {
    // Not the JSON reply we're after.
  }
  return null;
}

// Extract the `/workspaces` reply data array from an accumulated TCP buffer.
// Returns null when a complete reply is not yet available.
function ExtractWorkspaceData(Buffer0: Buffer): unknown[] | null {
  const Candidates: Buffer[] = [];

  // 1) SLIP-framed OSC packets (QLab's TCP framing per OSC 1.1).
  for (const Frame of SlipDecodeFrames(Buffer0)) {
    Candidates.push(Frame);
  }

  // 2) Fallback: treat the whole buffer as a single unframed OSC packet.
  Candidates.push(Buffer0);

  for (const Packet of Candidates) {
    for (const Str of ReadOscMessageStrings(Packet)) {
      const Data = TryParseWorkspaceData(Str);
      if (Data) return Data;
    }
  }

  // 3) Last-resort fallback: scan the raw bytes for the JSON reply object.
  const Raw = Buffer0.toString('utf8');
  const First = Raw.indexOf('{');
  const Last = Raw.lastIndexOf('}');
  if (First !== -1 && Last > First) {
    const Data = TryParseWorkspaceData(Raw.slice(First, Last + 1));
    if (Data) return Data;
  }

  return null;
}

function NormalizeWorkspace(Value: unknown): string {
  return String(Value == null ? '' : Value)
    .trim()
    .toLowerCase()
    .replace(/\.qlab[45]?$/, '');
}

function WorkspaceMatches(Workspace: unknown, Wanted: unknown): boolean {
  if (!Workspace || typeof Workspace !== 'object') return false;
  const Ws = Workspace as QLabWorkspaceInfo;
  const WantedRaw = String(Wanted).trim().toLowerCase();
  const WantedNorm = NormalizeWorkspace(Wanted);
  if (!WantedNorm) return false;

  const UniqueID = Ws.uniqueID == null ? '' : String(Ws.uniqueID).trim().toLowerCase();
  if (UniqueID && (UniqueID === WantedRaw || UniqueID === WantedNorm)) return true;

  const DisplayName = Ws.displayName;
  if (DisplayName != null && NormalizeWorkspace(DisplayName) === WantedNorm) return true;

  return false;
}

function BuildWorkspaceQueryCacheKey(Address: unknown, Port: number, TimeoutMs: number): string {
  return `${String(Address || '')
    .trim()
    .toLowerCase()}|${Port}|${TimeoutMs}`;
}

function ResolveWorkspaceQueryCacheTtlMs(TimeoutMs: number): number {
  // Keep this cache short-lived: enough to dedupe bursts of checks without
  // masking rapid workspace changes for long.
  const Base = Number.isFinite(TimeoutMs) ? TimeoutMs : 3000;
  return Math.max(300, Math.min(1500, (Base / 2) | 0));
}

async function QueryWorkspaces(
  Address: string,
  Port: number,
  TimeoutMs: number
): Promise<MonitoringResult> {
  return new Promise<MonitoringResult>((resolve) => {
    const Started = Date.now();
    let Settled = false;
    let Chunks = Buffer.alloc(0);
    const Socket = new net.Socket();

    const Finish = (Result: MonitoringResult) => {
      if (Settled) return;
      Settled = true;
      try {
        Socket.destroy();
      } catch {
        // ignore
      }
      resolve(Result);
    };

    const Evaluate = (): boolean => {
      const Data = ExtractWorkspaceData(Chunks);
      if (!Data) return false;
      Finish({ Success: true, LatencyMs: Date.now() - Started, Workspaces: Data });
      return true;
    };

    Socket.setTimeout(Math.max(200, TimeoutMs | 0));

    Socket.once('connect', () => {
      try {
        Socket.write(EncodeOscMessageTcp('/workspaces'));
      } catch (Err) {
        Finish({ Success: false, Error: Err && (Err as Error).message ? (Err as Error).message : String(Err) });
      }
    });

    Socket.on('data', (Chunk: Buffer) => {
      Chunks = Buffer.concat([Chunks, Chunk]);
      if (Chunks.length > 1_000_000) {
        Finish({ Success: false, Error: 'Reply too large' });
        return;
      }
      Evaluate();
    });

    Socket.once('timeout', () => {
      Finish({ Success: false, Error: `No reply from QLab after ${TimeoutMs}ms` });
    });

    Socket.once('error', (Err: Error) => {
      Finish({ Success: false, Error: Err && Err.message ? Err.message : String(Err) });
    });

    Socket.once('close', () => {
      if (Settled) return;
      if (!Evaluate()) Finish({ Success: false, Error: 'No reply from QLab' });
    });

    try {
      Socket.connect(Port, Address);
    } catch (Err) {
      Finish({ Success: false, Error: Err && (Err as Error).message ? (Err as Error).message : String(Err) });
    }
  });
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  if (!Address) return { Success: false, Error: 'No address configured' };

  const Cfg = (Target && Target.Settings) || {};
  const Port = Number.isFinite(Cfg.Port) ? (Cfg.Port as number) | 0 : 53000;
  const TimeoutMs = Number.isFinite(Cfg.Timeout) ? (Cfg.Timeout as number) : 3000;
  const Wanted = Cfg.Workspace == null ? '' : String(Cfg.Workspace).trim();
  if (Port < 1 || Port > 65535) return { Success: false, Error: `Invalid port: ${Port}` };
  if (!Wanted) return { Success: false, Error: 'No workspace configured' };

  const QueryCacheKey = BuildWorkspaceQueryCacheKey(Address, Port, TimeoutMs);
  const QueryCacheTtlMs = ResolveWorkspaceQueryCacheTtlMs(TimeoutMs);
  const QueryResult = (await WORKSPACE_QUERY_CACHE.GetOrCreate(
    QueryCacheKey,
    () => QueryWorkspaces(Address, Port, TimeoutMs),
    { ttlMs: QueryCacheTtlMs }
  )) as MonitoringResult;

  if (!QueryResult || !QueryResult.Success) {
    return {
      Success: false,
      Error: (QueryResult && (QueryResult.Error as string)) || 'No reply from QLab',
    };
  }

  const Workspaces = Array.isArray(QueryResult.Workspaces) ? QueryResult.Workspaces : [];
  const Matched = Workspaces.some((Workspace) => WorkspaceMatches(Workspace, Wanted));
  if (Matched) {
    return { Success: true, LatencyMs: QueryResult.LatencyMs, Workspaces, Wanted, Matched: true };
  }

  return {
    Success: true,
    Degraded: true,
    DegradedReason: 'Incorrect Workspace',
    LatencyMs: QueryResult.LatencyMs,
    Workspaces,
    Wanted,
    Matched: false,
  };
}

// Render one row per reported QLab workspace (display name, unique ID and
// whether it is passcode-protected), highlighting the one we are matching on.
function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number.isFinite(Cfg.Port) ? (Cfg.Port as number) | 0 : 53000;
  const Wanted =
    (Result && Result.Wanted) || (Cfg.Workspace == null ? '' : String(Cfg.Workspace).trim());
  const Reachable = !!(
    Result &&
    (Result.Success || Result.Degraded) &&
    Array.isArray(Result.Workspaces)
  );

  let StatusPill: string;
  if (!Reachable) {
    StatusPill = Pill('danger', 'No reply');
  } else if (Result && Result.Matched) {
    StatusPill = Pill('success', 'Workspace open');
  } else {
    StatusPill = Pill('warning', 'Not found');
  }

  const Head = Rows([
    TextRow('Host', `${Address || '—'}:${Port}`),
    Row('Status', StatusPill),
    Wanted ? TextRow('Looking for', Wanted) : null,
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'No reply from QLab'),
  ]);

  const Workspaces: unknown[] = Array.isArray(Result && Result.Workspaces)
    ? (Result.Workspaces as unknown[])
    : [];
  if (!Reachable || !Workspaces.length) {
    return (
      Head +
      '<div class="mt-2">' +
      Note(Reachable ? 'QLab reported no open workspaces' : 'Could not reach QLab') +
      '</div>'
    );
  }

  const List = Workspaces.map((Workspace) => {
    const Ws = Workspace as QLabWorkspaceInfo;
    const Name = Workspace && Ws.displayName != null ? String(Ws.displayName) : '(unnamed)';
    const UniqueID = Workspace && Ws.uniqueID != null ? String(Ws.uniqueID) : '';
    const HasPasscode = !!(Workspace && (Ws.hasPasscode || Ws.hasPasscodeSet));
    const IsMatch = WorkspaceMatches(Workspace, Wanted);
    const RowCls = IsMatch ? 'border border-success' : 'border border-transparent';
    const PasscodePill = HasPasscode ? Pill('warning', 'Passcode') : Pill('muted', 'No passcode');
    return (
      `<div class="bg-ghost rounded p-2 ${RowCls}">` +
      '<div class="d-flex justify-content-between align-items-center gap-2">' +
      `<span class="text-light small text-break">${Esc(Name)}</span>` +
      PasscodePill +
      '</div>' +
      (UniqueID
        ? `<div class="text-muted font-monospace" style="font-size: 0.7rem;">${Esc(UniqueID)}</div>`
        : '') +
      '</div>'
    );
  }).join('');

  return (
    Head +
    `<div class="text-muted small mt-2 mb-1">Open workspaces (${Workspaces.length})</div>` +
    `<div class="d-grid gap-1">${List}</div>`
  );
}

export const Name = 'QLab Workspace';
export const Description =
  'Connects to QLab over TCP (OSC) and confirms a specific workspace is open by name/filename or unique ID.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
// Exported for unit tests.
export const _internal = {
  EncodeOscMessageTcp,
  ExtractWorkspaceData,
  WorkspaceMatches,
  NormalizeWorkspace,
  BuildWorkspaceQueryCacheKey,
  ResolveWorkspaceQueryCacheTtlMs,
  QueryWorkspaces,
};
export { ID, Settings, Run, Debug };
