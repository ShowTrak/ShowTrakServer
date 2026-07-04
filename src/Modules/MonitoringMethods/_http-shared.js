// Shared HTTP/HTTPS request helper used by the http, https and http-json
// monitoring methods. Exposes a single PerformHttpRequest() that:
//   - Builds a request from Target.Address + Settings (Port/Path/Method/...)
//   - Enforces a hard timeout (no client can stall the monitoring loop)
//   - Optionally follows redirects up to a small fixed limit
//   - Optionally captures the response body (capped at 1 MiB)
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { Pill, Rows, TextRow, Row, FormatLatency } = require('./debug');

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']);

function ParseAddress(Address, DefaultProtocol, DefaultPort) {
  const Trimmed = String(Address || '').trim();
  if (!Trimmed) return null;

  // Allow bare hostnames or fully-qualified URLs. If the user pasted a URL we
  // honor its scheme; otherwise we wrap it with the requested DefaultProtocol.
  const HasScheme = /^https?:\/\//i.test(Trimmed);
  const Raw = HasScheme ? Trimmed : `${DefaultProtocol}://${Trimmed}`;

  let Parsed;
  try {
    Parsed = new URL(Raw);
  } catch (_e) {
    return null;
  }
  if (Parsed.protocol !== 'http:' && Parsed.protocol !== 'https:') return null;
  if (!Parsed.port) {
    Parsed.port = String(DefaultPort);
  }
  return Parsed;
}

function PerformHttpRequest(Target, Opts) {
  const Cfg = (Target && Target.Settings) || {};
  const Protocol = Opts && Opts.Protocol === 'https' ? 'https' : 'http';
  const ConfiguredPort = Number.isFinite(Cfg.Port) ? Cfg.Port | 0 : 0;
  const DefaultPort =
    ConfiguredPort > 0 ? ConfiguredPort : Opts.DefaultPort || (Protocol === 'https' ? 443 : 80);

  const Url = ParseAddress(Target && Target.Address, Protocol, DefaultPort);
  if (!Url) return Promise.resolve({ Success: false, Error: 'Invalid address' });

  const Path = Cfg.Path ? String(Cfg.Path) : '/';
  Url.pathname = Path.startsWith('/') ? Path.split('?')[0] : `/${Path.split('?')[0]}`;
  const QueryFromPath = Path.indexOf('?') >= 0 ? Path.slice(Path.indexOf('?')) : '';
  if (QueryFromPath) Url.search = QueryFromPath;

  const Method = String(Cfg.Method || 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(Method)) {
    return Promise.resolve({ Success: false, Error: `HTTP method not allowed: ${Method}` });
  }

  const StatusMin = Number.isFinite(Cfg.ExpectedStatusMin) ? Cfg.ExpectedStatusMin | 0 : 200;
  const StatusMax = Number.isFinite(Cfg.ExpectedStatusMax) ? Cfg.ExpectedStatusMax | 0 : 399;
  const FollowRedirects = !!Cfg.FollowRedirects;
  const IgnoreTlsErrors = !!Cfg.IgnoreTlsErrors;
  const TimeoutMs = Number.isFinite(Cfg.Timeout) ? Math.max(500, Cfg.Timeout | 0) : 5000;
  const CaptureBody = !!(Opts && Opts.CaptureBody);

  return DoRequest(Url, {
    Method,
    StatusMin,
    StatusMax,
    FollowRedirects,
    IgnoreTlsErrors,
    TimeoutMs,
    CaptureBody,
    RedirectsLeft: FollowRedirects ? MAX_REDIRECTS : 0,
    Started: Date.now(),
  });
}

function DoRequest(Url, State) {
  return new Promise((resolve) => {
    const Lib = Url.protocol === 'https:' ? https : http;
    let Settled = false;

    const Finish = (Result) => {
      if (Settled) return;
      Settled = true;
      resolve(Result);
    };

    const ReqOpts = {
      method: State.Method,
      hostname: Url.hostname,
      port: Url.port || (Url.protocol === 'https:' ? 443 : 80),
      path: `${Url.pathname || '/'}${Url.search || ''}`,
      headers: {
        Host: Url.host,
        'User-Agent': 'ShowTrak-Monitoring/1.0',
        Accept: '*/*',
        Connection: 'close',
      },
    };
    if (Url.protocol === 'https:') {
      ReqOpts.rejectUnauthorized = !State.IgnoreTlsErrors;
    }

    let Req;
    try {
      Req = Lib.request(ReqOpts);
    } catch (Err) {
      return Finish({ Success: false, Error: Err && Err.message ? Err.message : String(Err) });
    }

    const KillTimer = setTimeout(() => {
      try {
        Req.destroy(new Error(`Request timed out after ${State.TimeoutMs}ms`));
      } catch (_e) {
        // ignore
      }
    }, State.TimeoutMs);

    Req.on('error', (Err) => {
      clearTimeout(KillTimer);
      Finish({ Success: false, Error: Err && Err.message ? Err.message : String(Err) });
    });

    Req.on('response', (Res) => {
      const Status = Res.statusCode || 0;

      // Handle redirect transparently when enabled.
      if (
        State.RedirectsLeft > 0 &&
        Status >= 300 &&
        Status < 400 &&
        Res.headers &&
        Res.headers.location
      ) {
        clearTimeout(KillTimer);
        Res.resume();
        let Next;
        try {
          Next = new URL(Res.headers.location, Url);
        } catch (_e) {
          return Finish({
            Success: false,
            Error: `Invalid redirect target: ${Res.headers.location}`,
          });
        }
        if (Next.protocol !== 'http:' && Next.protocol !== 'https:') {
          return Finish({ Success: false, Error: `Refusing redirect to ${Next.protocol}` });
        }
        return resolve(
          DoRequest(Next, {
            ...State,
            RedirectsLeft: State.RedirectsLeft - 1,
            // Per RFC, methods other than GET/HEAD should become GET on 301/302/303.
            Method: Status === 307 || Status === 308 ? State.Method : 'GET',
          })
        );
      }

      if (Status < State.StatusMin || Status > State.StatusMax) {
        clearTimeout(KillTimer);
        Res.resume();
        return Finish({
          Success: false,
          Degraded: true,
          Error: `HTTP ${Status} (expected ${State.StatusMin}-${State.StatusMax})`,
          Status,
        });
      }

      if (!State.CaptureBody) {
        Res.resume();
        Res.on('end', () => {
          clearTimeout(KillTimer);
          Finish({ Success: true, LatencyMs: Date.now() - State.Started, Status });
        });
        Res.on('error', (Err) => {
          clearTimeout(KillTimer);
          Finish({ Success: false, Error: Err && Err.message ? Err.message : String(Err) });
        });
        return;
      }

      let Bytes = 0;
      const Chunks = [];
      Res.on('data', (Chunk) => {
        Bytes += Chunk.length;
        if (Bytes > MAX_BODY_BYTES) {
          // Stop reading; truncated body is acceptable for substring/JSON checks
          // up to the cap. Destroying here would race the assertion logic, so
          // we just stop accumulating.
          return;
        }
        Chunks.push(Chunk);
      });
      Res.on('end', () => {
        clearTimeout(KillTimer);
        const Body = Buffer.concat(Chunks).toString('utf8');
        Finish({ Success: true, LatencyMs: Date.now() - State.Started, Body, Status });
      });
      Res.on('error', (Err) => {
        clearTimeout(KillTimer);
        Finish({ Success: false, Error: Err && Err.message ? Err.message : String(Err) });
      });
    });

    try {
      Req.end();
    } catch (Err) {
      clearTimeout(KillTimer);
      Finish({ Success: false, Error: Err && Err.message ? Err.message : String(Err) });
    }
  });
}

// Classify an HTTP status code into a status pill colour.
function StatusKind(Status) {
  const N = Number(Status);
  if (!Number.isFinite(N) || N <= 0) return 'muted';
  if (N >= 200 && N < 400) return 'success';
  if (N >= 400) return 'danger';
  return 'warning';
}

// Shared "last response" panel for the http/https methods. `Opts.Protocol`
// controls the label; `Opts.Scheme` overrides it (used by http-json).
function BuildHttpDebug(Result, Target, Opts) {
  const Cfg = (Target && Target.Settings) || {};
  const Scheme = (Opts && Opts.Scheme) || (Opts && Opts.Protocol) || 'http';
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  const Path = Cfg.Path ? String(Cfg.Path) : '/';
  const Method = String(Cfg.Method || 'GET').toUpperCase();
  const Success = !!(Result && Result.Success);
  const Status = Result && Result.Status;
  const HasStatus = Number.isFinite(Number(Status)) && Number(Status) > 0;

  return Rows([
    TextRow('Request', `${Method} ${Scheme.toUpperCase()} ${Address || '—'}${Path}`),
    HasStatus
      ? Row('Status', Pill(StatusKind(Status), `HTTP ${Number(Status)}`))
      : Row('Reachable', Pill(Success ? 'success' : 'danger', Success ? 'Yes' : 'No')),
    Success
      ? Row('Response time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Request failed'),
  ]);
}

module.exports = { PerformHttpRequest, BuildHttpDebug };
