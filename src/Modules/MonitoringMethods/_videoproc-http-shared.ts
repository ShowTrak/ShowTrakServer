// Shared HTTP/JSON transport for the video processor checks (Brompton Tessera,
// Barco Event Master, Analog Way LivePremier). All three expose a small
// HTTP API that answers JSON, and each probe makes one to a handful of
// requests, so the transport, the whole-probe deadline and the address
// parsing live here, while each method owns its own endpoints and verdicts.
// The operator actions use the same transport with their own short deadline.
//
// Nothing here logs. A request URL can carry a credential (LivePremier's
// documented login puts the password in the query string), so error strings
// are built from the socket error only, never from the URL.
//
// The configured Timeout is a budget for the WHOLE probe: callers compute one
// absolute deadline up front and pass it to every request, so a slow device
// answering each request just inside the limit still cannot stretch a
// multi-request probe past the budget.
import http from 'http';
import https from 'https';
import { URL } from 'url';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface JsonRequest {
  Method: 'GET' | 'POST';
  // Serialised as the JSON request body when present.
  Json?: unknown;
  // Extra request headers (e.g. a session cookie).
  Headers?: Record<string, string>;
  // Absolute epoch-ms deadline shared by every request of one probe.
  DeadlineAt: number;
  IgnoreTlsErrors?: boolean;
}

export type JsonResponse =
  | {
      Ok: true;
      Status: number;
      Body: string;
      // Parsed body, or undefined when the body is empty or not JSON.
      Json: unknown;
      Headers: http.IncomingHttpHeaders;
    }
  | { Ok: false; Error: string; TimedOut?: boolean };

// Build the base URL for a device. Accepts a bare host/IP or a pasted URL
// (whose scheme wins); any path or query on the address is discarded since the
// API paths are fixed per method. Port 0 keeps the scheme's default.
export function BuildBaseUrl(
  Address: unknown,
  Protocol: 'http' | 'https',
  Port: number
): URL | null {
  const Trimmed = String(Address == null ? '' : Address).trim();
  if (!Trimmed) return null;
  const HasScheme = /^https?:\/\//i.test(Trimmed);
  let Parsed: URL;
  try {
    Parsed = new URL(HasScheme ? Trimmed : `${Protocol}://${Trimmed}`);
  } catch {
    return null;
  }
  if (Parsed.protocol !== 'http:' && Parsed.protocol !== 'https:') return null;
  Parsed.pathname = '/';
  Parsed.search = '';
  Parsed.hash = '';
  if (Port > 0 && Port <= 65535) Parsed.port = String(Port);
  return Parsed;
}

// Resolve an API path against a base URL without losing the base's port.
export function WithPath(Base: URL, Path: string): URL {
  const Url = new URL(Base.toString());
  const Query = Path.indexOf('?');
  Url.pathname = Query >= 0 ? Path.slice(0, Query) : Path;
  Url.search = Query >= 0 ? Path.slice(Query) : '';
  return Url;
}

// One HTTP request against the shared deadline. Resolves (never rejects) with
// the raw status and parsed JSON so the caller decides what each status means.
export function RequestJson(Url: URL, Request: JsonRequest): Promise<JsonResponse> {
  return new Promise<JsonResponse>((resolve) => {
    const BudgetMs = Request.DeadlineAt - Date.now();
    if (BudgetMs <= 0) {
      resolve({ Ok: false, Error: 'Probe timed out', TimedOut: true });
      return;
    }
    const Lib = Url.protocol === 'https:' ? https : http;
    let Settled = false;
    const Finish = (Value: JsonResponse) => {
      if (Settled) return;
      Settled = true;
      clearTimeout(KillTimer);
      resolve(Value);
    };

    const Headers: Record<string, string> = {
      Host: Url.host,
      'User-Agent': 'ShowTrak-Monitoring/1.0',
      Accept: 'application/json',
      Connection: 'close',
      ...(Request.Headers || {}),
    };
    const Payload = Request.Json === undefined ? null : Buffer.from(JSON.stringify(Request.Json));
    if (Payload) {
      Headers['Content-Type'] = 'application/json';
      Headers['Content-Length'] = String(Payload.length);
    }

    const Options: https.RequestOptions = {
      method: Request.Method,
      hostname: Url.hostname,
      port: Url.port || (Url.protocol === 'https:' ? 443 : 80),
      path: `${Url.pathname}${Url.search || ''}`,
      headers: Headers,
    };
    if (Url.protocol === 'https:') Options.rejectUnauthorized = !Request.IgnoreTlsErrors;

    let Req: http.ClientRequest;
    const KillTimer = setTimeout(() => {
      Finish({ Ok: false, Error: `Request timed out after ${BudgetMs}ms`, TimedOut: true });
      try {
        Req.destroy();
      } catch {
        // ignore
      }
    }, BudgetMs);

    try {
      Req = Lib.request(Options);
    } catch (Err) {
      Finish({ Ok: false, Error: Err instanceof Error ? Err.message : String(Err) });
      return;
    }

    Req.on('error', (Err: Error) => {
      Finish({ Ok: false, Error: Err && Err.message ? Err.message : String(Err) });
    });

    Req.on('response', (Res: http.IncomingMessage) => {
      let Bytes = 0;
      const Chunks: Buffer[] = [];
      Res.on('data', (Chunk: Buffer) => {
        Bytes += Chunk.length;
        // Stop accumulating past the cap; a truncated body simply fails to parse.
        if (Bytes > MAX_BODY_BYTES) return;
        Chunks.push(Chunk);
      });
      Res.on('end', () => {
        const Body = Buffer.concat(Chunks).toString('utf8');
        let Json: unknown;
        try {
          Json = Body.trim() ? JSON.parse(Body) : undefined;
        } catch {
          Json = undefined;
        }
        Finish({ Ok: true, Status: Res.statusCode || 0, Body, Json, Headers: Res.headers });
      });
      Res.on('error', (Err: Error) => {
        Finish({ Ok: false, Error: Err && Err.message ? Err.message : String(Err) });
      });
    });

    try {
      if (Payload) Req.write(Payload);
      Req.end();
    } catch (Err) {
      Finish({ Ok: false, Error: Err instanceof Error ? Err.message : String(Err) });
    }
  });
}

// --- Small value readers shared by the three methods ------------------------

export function IsObject(Value: unknown): Value is Record<string, unknown> {
  return !!Value && typeof Value === 'object' && !Array.isArray(Value);
}

// Walk a nested object by keys; undefined when any step is missing.
export function Dig(Root: unknown, Keys: string[]): unknown {
  let Cur: unknown = Root;
  for (const Key of Keys) {
    if (!IsObject(Cur)) return undefined;
    Cur = Cur[Key];
  }
  return Cur;
}

export function StrOrNull(Value: unknown): string | null {
  if (Value == null) return null;
  if (typeof Value === 'object') return null;
  const S = String(Value).trim();
  return S ? S : null;
}

// A number from a number or a numeric string ("45", "45.5 C"); null otherwise.
export function NumOrNull(Value: unknown): number | null {
  if (typeof Value === 'number') return Number.isFinite(Value) ? Value : null;
  if (typeof Value === 'string') {
    const Match = Value.trim().match(/^-?\d+(?:\.\d+)?/);
    if (!Match) return null;
    const N = Number(Match[0]);
    return Number.isFinite(N) ? N : null;
  }
  return null;
}

// A boolean from true/false, 1/0 or "true"/"false"; null otherwise.
export function BoolOrNull(Value: unknown): boolean | null {
  if (typeof Value === 'boolean') return Value;
  if (Value === 1 || Value === 0) return Value === 1;
  if (typeof Value === 'string') {
    const S = Value.trim().toLowerCase();
    if (S === 'true' || S === '1') return true;
    if (S === 'false' || S === '0') return false;
  }
  return null;
}

// Settings list ('list' field) -> trimmed non-empty strings.
export function AsList(Value: unknown): string[] {
  const Raw = Array.isArray(Value) ? Value : typeof Value === 'string' ? Value.split(/[,\n]/) : [];
  return Raw.map((V) => String(V == null ? '' : V).trim()).filter(Boolean);
}

// The device's own explanation for a refused request, for an action's Error.
// Reads the error shapes the three APIs document (Tessera's "error-messages"
// list; a plain message/error/description field otherwise), falling back to a
// short slice of a non-JSON body. Null when there is nothing readable.
export function DeviceErrorText(Json: unknown, Body?: string): string | null {
  if (IsObject(Json)) {
    const List = Json['error-messages'];
    if (Array.isArray(List)) {
      const Text = List.map((M) => StrOrNull(M))
        .filter(Boolean)
        .join('; ');
      if (Text) return Text;
    }
    for (const Key of ['message', 'error', 'description', 'detail']) {
      const Value = Json[Key];
      const Text = IsObject(Value) ? StrOrNull(Value.message) : StrOrNull(Value);
      if (Text) return Text;
    }
    return null;
  }
  const Raw = StrOrNull(Body);
  if (!Raw || Raw.startsWith('<')) return null;
  return Raw.length > 160 ? `${Raw.slice(0, 160)}...` : Raw;
}

export function TimeoutOf(Cfg: Record<string, unknown>, Default: number): number {
  const N = Number(Cfg.Timeout);
  return Number.isFinite(N) && N > 0 ? Math.max(500, N | 0) : Default;
}
