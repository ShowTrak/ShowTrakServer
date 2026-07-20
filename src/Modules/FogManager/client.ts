// FOG Project HTTP client.
//
// Thin transport layer over the FOG REST API. Knows how to build an authenticated
// request and interpret FOG's responses; knows nothing about ShowTrak entities.
//
// Behaviours here that look odd but are deliberate, all verified against FOG
// 1.5.10.1903 source rather than the published docs (which are wrong on several
// of these points):
//
//   * Redirects are NOT followed. When the API is disabled server-side, FOG answers
//     every route with a 302 to the management login page instead of an error. If we
//     followed it we would get a 200 with an HTML body and report a false healthy.
//     Node's http/https do not follow redirects by default, so a 3xx surfaces as-is.
//
//   * The API token is sent verbatim. FOG base64-decodes the header before comparing
//     it to the stored token, and the web UI already displays it encoded. Encoding it
//     again here produces a 403.
//
//   * Two endpoints do not return JSON despite FOG sending an
//     `application/json` content-type unconditionally: /system/info returns the bare
//     text `success`, and the task-creation endpoint returns the literal string
//     `null` on success. Callers must not blind-parse; hence BodyText, not BodyJson.
//
//   * TLS certificate verification is disabled for FOG requests. FOG ships a
//     self-signed certificate by default and this was an explicit product decision.
//     The permissive agent is constructed here and used only for FOG traffic, so it
//     cannot leak into any other HTTP the app performs.
import http from 'http';
import https from 'https';
import { FOG_REQUEST_TIMEOUT_MS } from '../Config/fog';

export interface FogConfig {
  Protocol: 'http' | 'https';
  Host: string;
  Port: number; // 0 means "use the protocol default"
  ApiToken: string;
  UserToken: string;
}

export interface FogResponse {
  Success: boolean;
  StatusCode: number;
  BodyText: string;
  Error: string | null;
}

// Reused across requests so we are not rebuilding a TLS context per poll.
const InsecureAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });

export function ConfigIsComplete(Config: FogConfig): boolean {
  return !!(Config.Host && Config.ApiToken && Config.UserToken);
}

export function DescribeConfigGaps(Config: FogConfig): string | null {
  if (!Config.Host) return 'No FOG server address configured';
  if (!Config.ApiToken) return 'No FOG API token configured';
  if (!Config.UserToken) return 'No FOG user token configured';
  return null;
}

// Translate FOG's status codes into something a human can act on. The 302 case is
// the one people hit most and the one the raw status explains least.
function DescribeStatus(StatusCode: number, BodyText: string): string {
  if (StatusCode === 302 || StatusCode === 301) {
    return 'FOG redirected to its login page, which means the API is not enabled. Enable it under FOG Configuration → FOG Settings → API System.';
  }
  if (StatusCode === 403) {
    return 'FOG rejected the API token. Check it matches FOG Configuration → FOG Settings → API System, and that it was pasted without modification.';
  }
  if (StatusCode === 401) {
    return 'FOG rejected the user token. Check the token, and that the user has "User API Enable" ticked in FOG.';
  }
  if (StatusCode === 404) return 'FOG returned 404 — the host or task no longer exists.';
  if (StatusCode === 501) return 'FOG rejected the task type as invalid.';
  // FOG reports genuine server-side failures as {"error": "..."} with a 500.
  if (StatusCode >= 500) {
    try {
      const Parsed = JSON.parse(BodyText) as { error?: string };
      if (Parsed && typeof Parsed.error === 'string' && Parsed.error) {
        return `FOG error: ${Parsed.error}`;
      }
    } catch {
      // Non-JSON 500; fall through to the generic message.
    }
    return `FOG returned HTTP ${StatusCode}`;
  }
  return `FOG returned HTTP ${StatusCode}`;
}

export function FogRequest(
  Config: FogConfig,
  Path: string,
  Method: string = 'GET',
  Body: unknown = null
): Promise<FogResponse> {
  return new Promise<FogResponse>((resolve) => {
    const IsHttps = Config.Protocol === 'https';
    const Transport = IsHttps ? https : http;
    const Port = Config.Port > 0 ? Config.Port : IsHttps ? 443 : 80;
    const Payload = Body == null ? '' : JSON.stringify(Body);

    let Req: http.ClientRequest;
    try {
      Req = Transport.request({
        hostname: Config.Host,
        port: Port,
        path: `/fog${Path}`,
        method: String(Method || 'GET').toUpperCase(),
        ...(IsHttps ? { agent: InsecureAgent } : {}),
        headers: {
          // Sent verbatim — see the note at the top of this file.
          'fog-api-token': Config.ApiToken,
          'fog-user-token': Config.UserToken,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(Payload),
          'User-Agent': 'ShowTrakServer',
        },
      });
    } catch (Err) {
      return resolve({
        Success: false,
        StatusCode: 0,
        BodyText: '',
        Error: Err instanceof Error ? Err.message : String(Err),
      });
    }

    Req.on('response', (Res: http.IncomingMessage) => {
      const Chunks: Buffer[] = [];
      Res.on('data', (Chunk: Buffer) => Chunks.push(Chunk));
      Res.on('end', () => {
        const BodyText = Buffer.concat(Chunks).toString('utf8');
        const StatusCode = Res.statusCode || 0;
        const Success = StatusCode >= 200 && StatusCode <= 299;
        resolve({
          Success,
          StatusCode,
          BodyText,
          Error: Success ? null : DescribeStatus(StatusCode, BodyText),
        });
      });
    });

    Req.setTimeout(FOG_REQUEST_TIMEOUT_MS, () => {
      Req.destroy(new Error(`FOG did not respond within ${FOG_REQUEST_TIMEOUT_MS}ms`));
    });

    Req.on('error', (Err: Error) => {
      resolve({
        Success: false,
        StatusCode: 0,
        BodyText: '',
        Error: Err && Err.message ? Err.message : String(Err),
      });
    });

    try {
      if (Payload) Req.write(Payload);
      Req.end();
    } catch (Err) {
      resolve({
        Success: false,
        StatusCode: 0,
        BodyText: '',
        Error: Err instanceof Error ? Err.message : String(Err),
      });
    }
  });
}

// Parse a JSON response body, tolerating FOG's habit of returning non-JSON.
export function ParseJson<T>(Response: FogResponse): T | null {
  if (!Response.BodyText) return null;
  try {
    return JSON.parse(Response.BodyText) as T;
  } catch {
    return null;
  }
}

// FOG serialises every scalar as a string — IDs, booleans ("0"/"1") and numbers
// alike. Coerce at the boundary so nothing downstream has to think about it.
export function ToNumber(Value: unknown, Fallback: number = 0): number {
  const N = Number(Value);
  return Number.isFinite(N) ? N : Fallback;
}

export function ToText(Value: unknown): string {
  return Value == null ? '' : String(Value);
}

// Health probe. Returns null when healthy, or a human-readable reason when not.
//
// /fog/system/info is the cheapest call that exercises reachability, the API-enabled
// flag and both tokens in one go. Note it DOES require auth — the docs claim
// otherwise, and they are wrong. The body is the bare text `success`, not JSON.
export async function CheckHealth(Config: FogConfig): Promise<string | null> {
  const Gap = DescribeConfigGaps(Config);
  if (Gap) return Gap;

  const Response = await FogRequest(Config, '/system/info', 'GET');
  if (!Response.Success) return Response.Error || 'FOG server unreachable';
  if (Response.BodyText.trim() !== 'success') {
    // A 200 whose body is not `success` means we were served something other than
    // the API — typically an HTML page from a reverse proxy sitting in front of FOG.
    return 'FOG responded, but not with the expected API reply. Check the address and port point at the FOG web interface.';
  }
  return null;
}
