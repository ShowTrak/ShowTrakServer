import http from 'http';
import https from 'https';

// Connections are kept open between requests, so a burst of alerts to one
// webhook (Discord, Slack, ...) pays the TCP and TLS handshake once rather
// than per alert. An idle socket is closed after a few seconds, well inside the
// keep-alive timeout of common servers, so a reused one is rarely stale.
// Created on first use.
const KEEP_ALIVE = { keepAlive: true, timeout: 4000 };
let HttpAgent: http.Agent | null = null;
let HttpsAgent: https.Agent | null = null;

function AgentFor(IsHttps: boolean): http.Agent {
  if (IsHttps) return (HttpsAgent ??= new https.Agent(KEEP_ALIVE));
  return (HttpAgent ??= new http.Agent(KEEP_ALIVE));
}

interface RequestJsonOpts {
  Url: unknown;
  Method?: string;
  Headers?: Record<string, string | number>;
  Timeout?: number;
  Body?: unknown;
}

interface RequestJsonResult {
  Success: boolean;
  StatusCode: number;
  BodyText?: string;
  Error?: string | null;
}

function requestJson({
  Url,
  Method = 'POST',
  Headers = {},
  Timeout = 5000,
  Body = null,
}: RequestJsonOpts): Promise<RequestJsonResult> {
  return new Promise<RequestJsonResult>((resolve) => {
    let Parsed: URL;
    try {
      Parsed = new URL(String(Url || '').trim());
    } catch {
      return resolve({ Success: false, StatusCode: 0, Error: 'Invalid URL' });
    }

    const IsHttps = Parsed.protocol === 'https:';
    if (!IsHttps && Parsed.protocol !== 'http:') {
      return resolve({
        Success: false,
        StatusCode: 0,
        Error: 'Only http/https URLs are supported',
      });
    }

    const Transport = IsHttps ? https : http;
    const TimeoutMs = Number.isFinite(Number(Timeout)) ? Math.max(250, Number(Timeout)) : 5000;
    const MethodUpper = String(Method || 'POST').toUpperCase();

    const Payload = Body == null ? '' : JSON.stringify(Body);

    const Req = Transport.request(
      {
        // Without the brackets of an IPv6 literal, which would otherwise be
        // looked up as a name.
        hostname: Parsed.hostname.replace(/^\[|\]$/g, ''),
        port: Parsed.port || (IsHttps ? 443 : 80),
        path: `${Parsed.pathname || '/'}${Parsed.search || ''}`,
        method: MethodUpper,
        agent: AgentFor(IsHttps),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(Payload),
          ...Headers,
        },
      },
      (Res: http.IncomingMessage) => {
        const Chunks: Buffer[] = [];
        Res.on('data', (Chunk: Buffer) => Chunks.push(Chunk));
        Res.on('end', () => {
          const Text = Buffer.concat(Chunks).toString('utf8');
          const StatusCode = Res.statusCode || 0;
          resolve({
            Success: StatusCode >= 200 && StatusCode <= 299,
            StatusCode,
            BodyText: Text,
            Error: StatusCode >= 200 && StatusCode <= 299 ? null : `HTTP ${StatusCode}`,
          });
        });
      }
    );

    Req.setTimeout(TimeoutMs, () => {
      Req.destroy(new Error(`Request timed out after ${TimeoutMs}ms`));
    });

    Req.on('error', (Err: Error) => {
      resolve({
        Success: false,
        StatusCode: 0,
        Error: Err && Err.message ? Err.message : String(Err),
      });
    });

    try {
      Req.write(Payload);
      Req.end();
    } catch (Err) {
      resolve({
        Success: false,
        StatusCode: 0,
        Error: Err && (Err as Error).message ? (Err as Error).message : String(Err),
      });
    }
  });
}

export { requestJson };
