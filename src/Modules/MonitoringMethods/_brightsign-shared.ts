// Shared BrightSign Local DWS (Diagnostic Web Server) client and helpers.
//
// BrightSign players expose a REST API on the player itself ("Local DWS"). All
// the brightsign* monitoring methods talk to it and differ only in which
// endpoint they read and how they judge the payload — so the HTTP transport,
// digest authentication, response unwrapping and the common editor Settings all
// live here.
//
// Three properties of this API drive the design:
//
//  1. Auth is HTTP Digest (RFC 2617), not Basic. The username is always "admin"
//     and the default password is the player's serial number. Auth can also be
//     disabled on the player, so credentials are optional here: we only
//     authenticate when challenged.
//  2. Everything is wrapped as {"data":{"result": ...}} — two levels, always.
//  3. Sub-objects inside a payload independently degrade to {"error": ...}
//     INSTEAD OF {"result": ...} while the endpoint still returns HTTP 200. So
//     every nested read must go through SubResult() rather than assuming
//     `.result` exists.
//
// Transport note: as of BrightSignOS 9.0.218 / 9.1.52 the DWS is HTTPS-only
// with a self-signed certificate and redirects plain HTTP. We follow redirects
// (re-running the auth handshake against the new URL) so a check configured for
// HTTP keeps working when a player is upgraded, and IgnoreTlsErrors defaults to
// true so the self-signed cert does not read as an outage.
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { URL } from 'url';
import { Esc, Pill, Rows, TextRow, Row, Note, FormatLatency } from './debug';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;

// The only username BrightSignOS accepts for the DWS, so it is not exposed as a
// setting.
const DWS_USERNAME = 'admin';

export const INFO_PATH = '/api/v1/info';

// The video endpoints are hdmi-only (any other connector is rejected with a 400
// by the player) and `device` is 0-indexed, so dual-output players are outputs
// 0 and 1.
export function VideoPath(Device: unknown): string {
  const N = Number(Device);
  return `/api/v1/video/hdmi/output/${Number.isFinite(N) && N > 0 ? N | 0 : 0}`;
}

// The editor Settings every BrightSign method shares (connection + auth).
// Individual methods spread this and append their own field(s).
export const CommonBrightSignSettings: MonitoringSettingField[] = [
  {
    Key: 'Protocol',
    Label: 'Protocol',
    Type: 'select',
    Default: 'http',
    Options: [
      { value: 'http', label: 'HTTP' },
      { value: 'https', label: 'HTTPS' },
    ],
  },
  {
    Key: 'Port',
    Label: 'Port',
    Type: 'number',
    Default: 0,
    Min: 0,
    Max: 65535,
    Advanced: true,
    Note: 'Leave at 0 to use the protocol default: 80 for HTTP, 443 for HTTPS.',
  },
  {
    Key: 'Password',
    Label: 'Password',
    Type: 'string',
    Default: '',
    Required: true,
    Note: "The Local DWS password — the player's serial number by default. The username is always 'admin'.",
  },
  {
    Key: 'IgnoreTlsErrors',
    Label: 'Ignore TLS Errors',
    Type: 'boolean',
    Default: true,
    Advanced: true,
    Note: 'Applies to HTTPS only. On by default so the self-signed DWS certificate is not treated as an outage.',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: 8000,
    Min: 500,
    Max: 60000,
    Advanced: true,
  },
];

// --- Config -----------------------------------------------------------------

export interface BrightSignConfig {
  Address: string;
  Protocol: 'http' | 'https';
  Port: number; // 0 = protocol default
  Username: string; // always DWS_USERNAME; not user-configurable
  Password: string;
  IgnoreTlsErrors: boolean;
  TimeoutMs: number;
}

// Parse the common connection settings off a target, defaulting anything the
// caller left unset. Never throws — used by both Run and the Debug renderer.
export function ParseBrightSignConfig(Target: MonitoringTargetLike): BrightSignConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Protocol = String(Cfg.Protocol || 'http').toLowerCase() === 'https' ? 'https' : 'http';
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Protocol,
    Port: Number.isFinite(Cfg.Port as number) ? (Cfg.Port as number) | 0 : 0,
    Username: DWS_USERNAME,
    // Deliberately not trimmed — trailing whitespace can be part of a password.
    Password: Cfg.Password == null ? '' : String(Cfg.Password),
    IgnoreTlsErrors: Cfg.IgnoreTlsErrors == null ? true : !!Cfg.IgnoreTlsErrors,
    TimeoutMs: Number.isFinite(Cfg.Timeout as number) ? (Cfg.Timeout as number) : 8000,
  };
}

// Build the absolute URL for a DWS path. Accepts a bare host/IP or a pasted URL
// (whose scheme wins over the Protocol setting); any path or query on the
// address is discarded since the DWS path is fixed per method.
export function BuildUrl(Config: BrightSignConfig, Path: string): URL | null {
  const Trimmed = String(Config.Address || '').trim();
  if (!Trimmed) return null;

  const HasScheme = /^https?:\/\//i.test(Trimmed);
  const Raw = HasScheme ? Trimmed : `${Config.Protocol}://${Trimmed}`;

  let Parsed: URL;
  try {
    Parsed = new URL(Raw);
  } catch {
    return null;
  }
  if (Parsed.protocol !== 'http:' && Parsed.protocol !== 'https:') return null;

  Parsed.pathname = Path;
  Parsed.search = '';
  // An explicit Port setting overrides a port pasted into the address.
  if (Config.Port > 0) Parsed.port = String(Config.Port);
  else if (!Parsed.port) Parsed.port = Parsed.protocol === 'https:' ? '443' : '80';
  return Parsed;
}

// --- Digest authentication --------------------------------------------------

function Md5(Value: string): string {
  return crypto.createHash('md5').update(Value, 'utf8').digest('hex');
}

// Escape a value for inclusion in a quoted-string header parameter. Stripping
// CR/LF matters: Username and Password come from user config and would
// otherwise allow header injection.
function EscapeQuoted(Value: unknown): string {
  return String(Value == null ? '' : Value)
    .replace(/[\r\n]/g, '')
    .replace(/(["\\])/g, '\\$1');
}

// Parse a `WWW-Authenticate: Digest realm="...", nonce="...", ...` header into
// its parameters. Returns null when the header is absent or is not a Digest
// challenge (e.g. Basic).
export function ParseDigestChallenge(Header: unknown): Record<string, string> | null {
  const Str = String(Header == null ? '' : Header);
  const Match = Str.match(/^\s*Digest\s+(.*)$/is);
  if (!Match) return null;

  const Params: Record<string, string> = {};
  const Re = /([a-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/gi;
  let Found: RegExpExecArray | null;
  while ((Found = Re.exec(Match[1] ?? '')) !== null) {
    const Value = Found[2] !== undefined ? Found[2].replace(/\\(.)/g, '$1') : (Found[3] ?? '');
    Params[Found[1]!.toLowerCase()] = Value; // group 1 is required, always present when Re matches
  }
  return Params;
}

// Compute the `Authorization: Digest ...` header for a challenge. Supports the
// MD5 and MD5-sess algorithms and the `auth` qop (BrightSignOS uses MD5+auth);
// falls back to RFC 2069 style when the server offers no qop.
export function BuildDigestHeader(
  Challenge: Record<string, string>,
  Method: string,
  Uri: string,
  Username: string,
  Password: string,
  Cnonce: string,
  Nc = '00000001'
): string {
  const Realm = Challenge.realm || '';
  const Nonce = Challenge.nonce || '';
  const Algorithm = Challenge.algorithm || 'MD5';
  const Qop = String(Challenge.qop || '')
    .split(',')
    .map((Part) => Part.trim().toLowerCase())
    .includes('auth')
    ? 'auth'
    : '';

  let HA1 = Md5(`${Username}:${Realm}:${Password}`);
  if (Algorithm.toLowerCase() === 'md5-sess') {
    HA1 = Md5(`${HA1}:${Nonce}:${Cnonce}`);
  }
  const HA2 = Md5(`${Method}:${Uri}`);
  const Response = Qop
    ? Md5(`${HA1}:${Nonce}:${Nc}:${Cnonce}:${Qop}:${HA2}`)
    : Md5(`${HA1}:${Nonce}:${HA2}`);

  const Parts = [
    `username="${EscapeQuoted(Username)}"`,
    `realm="${EscapeQuoted(Realm)}"`,
    `nonce="${EscapeQuoted(Nonce)}"`,
    `uri="${EscapeQuoted(Uri)}"`,
    `response="${Response}"`,
  ];
  if (Algorithm) Parts.push(`algorithm=${EscapeQuoted(Algorithm)}`);
  if (Qop) {
    Parts.push(`qop=${Qop}`);
    Parts.push(`nc=${Nc}`);
    Parts.push(`cnonce="${EscapeQuoted(Cnonce)}"`);
  }
  if (Challenge.opaque !== undefined) Parts.push(`opaque="${EscapeQuoted(Challenge.opaque)}"`);
  return `Digest ${Parts.join(', ')}`;
}

// --- HTTP transport ---------------------------------------------------------

interface RawResponse {
  Status: number;
  Body: string;
  Headers: http.IncomingHttpHeaders;
}

// One request, no auth handling, no redirect following. Rejects on transport
// error / timeout. A hard kill timer guarantees no probe can stall the
// monitoring loop. `BudgetMs` is the time this individual request may take; the
// caller passes the REMAINING share of the whole-probe budget so the redirect +
// auth handshake as a whole cannot exceed the configured Timeout.
function SendOnce(
  Url: URL,
  Config: BrightSignConfig,
  AuthHeader: string | null,
  BudgetMs?: number
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const Lib = Url.protocol === 'https:' ? https : http;
    const TimeoutMs =
      BudgetMs != null ? Math.max(1, BudgetMs | 0) : Math.max(500, Config.TimeoutMs | 0);
    let Settled = false;

    const Fail = (Err: Error) => {
      if (Settled) return;
      Settled = true;
      reject(Err);
    };
    const Done = (Value: RawResponse) => {
      if (Settled) return;
      Settled = true;
      resolve(Value);
    };

    const Headers: Record<string, string> = {
      Host: Url.host,
      'User-Agent': 'ShowTrak-Monitoring/1.0',
      Accept: 'application/json',
      Connection: 'close',
    };
    if (AuthHeader) Headers.Authorization = AuthHeader;

    const ReqOpts: https.RequestOptions = {
      method: 'GET',
      hostname: Url.hostname,
      port: Url.port || (Url.protocol === 'https:' ? 443 : 80),
      path: `${Url.pathname}${Url.search || ''}`,
      headers: Headers,
    };
    if (Url.protocol === 'https:') {
      ReqOpts.rejectUnauthorized = !Config.IgnoreTlsErrors;
    }

    let Req: http.ClientRequest;
    try {
      Req = Lib.request(ReqOpts);
    } catch (Err) {
      return Fail(Err instanceof Error ? Err : new Error(String(Err)));
    }

    const KillTimer = setTimeout(() => {
      try {
        Req.destroy(new Error(`Request timed out after ${TimeoutMs}ms`));
      } catch {
        // ignore
      }
    }, TimeoutMs);

    Req.on('error', (Err: Error) => {
      clearTimeout(KillTimer);
      Fail(Err instanceof Error ? Err : new Error(String(Err)));
    });

    Req.on('response', (Res: http.IncomingMessage) => {
      let Bytes = 0;
      const Chunks: Buffer[] = [];
      Res.on('data', (Chunk: Buffer) => {
        Bytes += Chunk.length;
        // Stop accumulating past the cap; destroying here would race the
        // parse, and a truncated body simply fails JSON.parse below.
        if (Bytes > MAX_BODY_BYTES) return;
        Chunks.push(Chunk);
      });
      Res.on('end', () => {
        clearTimeout(KillTimer);
        Done({
          Status: Res.statusCode || 0,
          Body: Buffer.concat(Chunks).toString('utf8'),
          Headers: Res.headers || {},
        });
      });
      Res.on('error', (Err: Error) => {
        clearTimeout(KillTimer);
        Fail(Err instanceof Error ? Err : new Error(String(Err)));
      });
    });

    try {
      Req.end();
    } catch (Err) {
      clearTimeout(KillTimer);
      Fail(Err instanceof Error ? Err : new Error(String(Err)));
    }
  });
}

export interface DwsResponse {
  Ok: boolean;
  Status?: number;
  // The unwrapped data.result payload.
  Payload?: unknown;
  Body?: string;
  LatencyMs?: number;
  Error?: string;
  // True when the player answered 404 — for the video endpoints this means the
  // player has no video API (audio-only), not that it is unhealthy.
  NotFound?: boolean;
  AuthFailed?: boolean;
}

// Unwrap the {"data":{"result": ...}} envelope. Returns undefined when the body
// is not shaped like a DWS response.
export function UnwrapResult(Json: unknown): unknown {
  const Data = (Json as Record<string, unknown> | null)?.data as
    Record<string, unknown> | undefined;
  if (!Data || typeof Data !== 'object') return undefined;
  if (!('result' in Data)) return undefined;
  return Data.result;
}

// Read a nested sub-object that follows the {result}|{error} convention. Returns
// { Value } on success or { Error } when the player reported a failure for that
// sub-object (or omitted it entirely).
export function SubResult(Parent: unknown, Key: string): { Value?: unknown; Error?: string } {
  const Node = (Parent as Record<string, unknown> | null)?.[Key];
  if (Node == null || typeof Node !== 'object') return { Error: 'Not reported' };
  const Obj = Node as Record<string, unknown>;
  if ('result' in Obj) return { Value: Obj.result };
  if ('error' in Obj) return { Error: String(Obj.error ?? 'Unknown error') };
  return { Error: 'Not reported' };
}

// Perform a GET against a DWS path, handling the digest challenge and any
// HTTP->HTTPS redirect. Never throws.
export async function FetchDws(Config: BrightSignConfig, Path: string): Promise<DwsResponse> {
  const Url = BuildUrl(Config, Path);
  if (!Url) return { Ok: false, Error: 'Invalid address' };

  const Started = Date.now();
  // The configured Timeout is a budget for the WHOLE probe, not per request.
  // Without this, the redirect (×MAX_REDIRECTS) and auth-retry round trips each
  // armed their own full TimeoutMs, so a hung player could stall a probe for up
  // to 8×TimeoutMs. Each SendOnce instead gets only the time left on this budget.
  const BudgetMs = Math.max(500, Config.TimeoutMs | 0);
  const Deadline = Started + BudgetMs;
  const RemainingMs = () => Deadline - Date.now();
  const TimedOut = (): DwsResponse => ({
    Ok: false,
    Error: `Probe timed out after ${BudgetMs}ms`,
  });
  let Current = Url;
  let RedirectsLeft = MAX_REDIRECTS;

  for (;;) {
    let Res: RawResponse;
    try {
      if (RemainingMs() <= 0) return TimedOut();
      Res = await SendOnce(Current, Config, null, RemainingMs());

      if (Res.Status === 401) {
        const Challenge = ParseDigestChallenge(Res.Headers['www-authenticate']);
        if (!Challenge) {
          return {
            Ok: false,
            Status: 401,
            AuthFailed: true,
            Error: 'Player requires authentication but did not offer digest auth',
          };
        }
        if (!Config.Password) {
          return {
            Ok: false,
            Status: 401,
            AuthFailed: true,
            Error: 'Authentication required — set the DWS password (default: player serial number)',
          };
        }
        const Cnonce = crypto.randomBytes(8).toString('hex');
        const Auth = BuildDigestHeader(
          Challenge,
          'GET',
          `${Current.pathname}${Current.search || ''}`,
          Config.Username,
          Config.Password,
          Cnonce
        );
        if (RemainingMs() <= 0) return TimedOut();
        Res = await SendOnce(Current, Config, Auth, RemainingMs());
        if (Res.Status === 401) {
          return {
            Ok: false,
            Status: 401,
            AuthFailed: true,
            Error: 'Authentication failed — check the password',
          };
        }
      }
    } catch (Err) {
      return { Ok: false, Error: Err instanceof Error ? Err.message : String(Err) };
    }

    // Follow a redirect (BrightSignOS 9.0.218+ redirects HTTP to HTTPS). The
    // auth handshake re-runs against the new URL on the next iteration.
    if (Res.Status >= 300 && Res.Status < 400 && Res.Headers.location && RedirectsLeft > 0) {
      let Next: URL;
      try {
        Next = new URL(String(Res.Headers.location), Current);
      } catch {
        return { Ok: false, Error: `Invalid redirect target: ${Res.Headers.location}` };
      }
      if (Next.protocol !== 'http:' && Next.protocol !== 'https:') {
        return { Ok: false, Error: `Refusing redirect to ${Next.protocol}` };
      }
      Current = Next;
      RedirectsLeft -= 1;
      continue;
    }

    if (Res.Status === 404) {
      return { Ok: false, Status: 404, NotFound: true, Error: `Not found (HTTP 404): ${Path}` };
    }
    if (Res.Status < 200 || Res.Status > 299) {
      return { Ok: false, Status: Res.Status, Error: `HTTP ${Res.Status}` };
    }

    let Json: unknown;
    try {
      Json = JSON.parse(Res.Body);
    } catch (Err) {
      return {
        Ok: false,
        Status: Res.Status,
        Body: Res.Body,
        Error: `Response is not valid JSON: ${Err instanceof Error ? Err.message : String(Err)}`,
      };
    }

    const Payload = UnwrapResult(Json);
    if (Payload === undefined) {
      return {
        Ok: false,
        Status: Res.Status,
        Body: Res.Body,
        Error: 'Unexpected response shape (no data.result) — is this a BrightSign player?',
      };
    }

    return {
      Ok: true,
      Status: Res.Status,
      Payload,
      Body: Res.Body,
      LatencyMs: Date.now() - Started,
    };
  }
}

// --- Shared Run scaffolding -------------------------------------------------

export interface BrightSignContext {
  Config: BrightSignConfig;
  Payload: unknown;
  LatencyMs: number;
  Body?: string;
}

export interface RunProbeOpts {
  // Result to return when the player answers 404. The video methods pass a
  // degraded result here ("player has no video API"); for /info a 404 is a real
  // fault and the shared default (offline) applies.
  NotFoundResult?: MonitoringResult;
}

// Validate config, fetch a DWS path, and apply the checks every BrightSign
// method shares (bad config / unreachable / auth / bad payload). Returns an
// early { Result } for those cases, or { Ctx } with the payload so the calling
// method can judge its specific field(s).
export async function RunBrightSignProbe(
  Target: MonitoringTargetLike,
  Path: string,
  Opts: RunProbeOpts = {}
): Promise<{ Result: MonitoringResult } | { Ctx: BrightSignContext }> {
  const Config = ParseBrightSignConfig(Target);
  if (!Config.Address) return { Result: { Success: false, Error: 'No address configured' } };
  if (Config.Port < 0 || Config.Port > 65535) {
    return { Result: { Success: false, Error: `Invalid port: ${Config.Port}` } };
  }

  const Res = await FetchDws(Config, Path);
  if (!Res.Ok) {
    if (Res.NotFound && Opts.NotFoundResult) return { Result: Opts.NotFoundResult };
    return { Result: { Success: false, Error: Res.Error || 'No reply from player' } };
  }

  return {
    Ctx: {
      Config,
      Payload: Res.Payload,
      LatencyMs: Res.LatencyMs || 0,
      Body: Res.Body,
    },
  };
}

// --- Field readers ----------------------------------------------------------

// Whether the player exposes the /api/v1/video/* endpoints. Audio-only players
// answer 404 there, and /info advertises the capability via api_features.video.
export function HasVideoApi(Payload: unknown): boolean {
  const Features = (Payload as Record<string, unknown> | null)?.api_features as
    Record<string, unknown> | undefined;
  return !!(Features && Features.video === true);
}

export interface PowerState {
  Source: string | null;
  Battery: string | null;
  SwitchMode: string | null;
  Error?: string;
}

export function ReadPower(Payload: unknown): PowerState {
  const Node = SubResult(Payload, 'power');
  if (Node.Error) return { Source: null, Battery: null, SwitchMode: null, Error: Node.Error };
  const Value = (Node.Value || {}) as Record<string, unknown>;
  const Str = (Key: string): string | null => (Value[Key] == null ? null : String(Value[Key]));
  return { Source: Str('source'), Battery: Str('battery'), SwitchMode: Str('switch_mode') };
}

// Judge a power reading. The exact vocabulary is undocumented beyond "AC" and
// "absent", so we match conservatively on substrings and stay silent on
// anything we do not recognise rather than alarming on it.
export function ClassifyPower(
  Source: unknown,
  Battery: unknown
): { Degraded: boolean; Reason?: string } {
  const S = String(Source ?? '')
    .trim()
    .toLowerCase();
  const B = String(Battery ?? '')
    .trim()
    .toLowerCase();

  if (B.includes('discharg')) return { Degraded: true, Reason: 'Battery discharging' };
  if (B.includes('low')) return { Degraded: true, Reason: 'Battery low' };
  if (S.includes('batt')) return { Degraded: true, Reason: 'Running on battery' };
  return { Degraded: false };
}

export interface VideoState {
  ActiveMode: string | null;
  OutputPresent: boolean | null;
  Unstable: boolean | null;
  PowerSave: boolean | null;
  Errors: string[];
}

export function ReadVideoState(Payload: unknown): VideoState {
  const Active = SubResult(Payload, 'activeMode');
  const Status = SubResult(Payload, 'status');
  const PowerSave = SubResult(Payload, 'powerSaveStatus');

  const ActiveVal = (Active.Value || {}) as Record<string, unknown>;
  const StatusVal = (Status.Value || {}) as Record<string, unknown>;
  const Bool = (Value: unknown): boolean | null => (typeof Value === 'boolean' ? Value : null);

  return {
    ActiveMode: ActiveVal.modeName == null ? null : String(ActiveVal.modeName) || null,
    // Deliberately outputPresent, not `attached`: a firmware comment reveals
    // `attached` means "the EDID could be read", not "a display is connected".
    OutputPresent: Bool(StatusVal.outputPresent),
    Unstable: Bool(StatusVal.unstable),
    PowerSave: Bool(PowerSave.Value),
    Errors: [Active.Error, Status.Error, PowerSave.Error].filter(Boolean) as string[],
  };
}

// Evaluate a video reading against the expected mode, returning the list of
// failing reasons (empty when healthy). Fields the player did not report are
// skipped rather than failed.
export function EvaluateVideo(State: VideoState, ExpectedMode: unknown): string[] {
  const Reasons: string[] = [];
  if (State.OutputPresent === false) Reasons.push('No display detected');
  if (State.Unstable === true) Reasons.push('Video signal unstable');
  if (State.PowerSave === true) Reasons.push('Output in power save');

  const Want = String(ExpectedMode ?? '').trim();
  if (Want && State.ActiveMode && State.ActiveMode.toLowerCase() !== Want.toLowerCase()) {
    Reasons.push(`Mode ${State.ActiveMode} (expected ${Want})`);
  }
  return Reasons;
}

// Format the player's uptime for display. `upTimeSeconds` is authoritative; the
// sibling `upTime` string is human-formatted and not worth parsing.
export function FormatUptime(Seconds: unknown): string {
  const N = Number(Seconds);
  if (!Number.isFinite(N) || N < 0) return '—';
  const Days = Math.floor(N / 86400);
  const Hours = Math.floor((N % 86400) / 3600);
  const Mins = Math.floor((N % 3600) / 60);
  if (Days > 0) return `${Days}d ${Hours}h ${Mins}m`;
  if (Hours > 0) return `${Hours}h ${Mins}m`;
  return `${Mins}m`;
}

// --- Shared Debug scaffolding -----------------------------------------------

// A status pill coloured from a result: green (online), amber (degraded,
// showing the reason), or red (offline).
export function StatePill(Result: MonitoringResult, OnlineText: string): string {
  const Reachable = !!(Result && Result.Success === true);
  const Degraded = !!(Result && Result.Degraded);
  if (Reachable && !Degraded) return Pill('success', OnlineText || 'Online');
  if (Reachable) return Pill('warning', (Result && Result.DegradedReason) || 'Degraded');
  return Pill('danger', 'Offline');
}

// Render the debug panel head (Player / Status / reply time or error) shared by
// every BrightSign method, with method-specific rows appended.
export function BrightSignDebug(
  Config: BrightSignConfig,
  Result: MonitoringResult,
  StatusPill: string,
  ExtraRows: Array<string | false | null | undefined>
): string {
  const Reachable = !!(Result && Result.Success === true);
  const PortSuffix = Config.Port > 0 ? `:${Config.Port}` : '';
  const Head = Rows([
    TextRow('Player', `${Config.Protocol}://${Config.Address || '—'}${PortSuffix}`),
    Row('Status', StatusPill),
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Could not reach the player'),
    ...ExtraRows,
  ]);
  if (!Reachable) {
    return (
      Head +
      '<div class="mt-2">' +
      Note('Could not reach the BrightSign Local DWS — check it is enabled on the player') +
      '</div>'
    );
  }
  return Head;
}

// Convenience for a monospace value row (e.g. "1920x1080x60p", "8.5.33").
export function MonoRow(Label: string, Value: unknown): string {
  return Row(Label, `<span class="font-monospace">${Esc(String(Value))}</span>`);
}

export const _internal = {
  ParseBrightSignConfig,
  BuildUrl,
  ParseDigestChallenge,
  BuildDigestHeader,
  UnwrapResult,
  SubResult,
  HasVideoApi,
  ReadPower,
  ClassifyPower,
  ReadVideoState,
  EvaluateVideo,
  FormatUptime,
  FetchDws,
  RunBrightSignProbe,
  VideoPath,
};
