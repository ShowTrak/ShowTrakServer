// The FreeKiosk device protocol client.
//
// Protocol only: it knows how to talk to one terminal and nothing about how
// ShowTrak stores or broadcasts them. Built on node:http, matching the pattern
// in MonitoringMethods/_http-shared.ts — an explicit kill timer plus destroy(),
// which is what gives a hard cap on a stalled device and byte-capped body
// reading for free.
//
// Two traps in this API drive most of the code below:
//
//  1. A refused command still answers HTTP 200 with `success: true`. Privilege
//     failures — reboot without Device Owner, lock without admin — are reported
//     as `data.executed: false` plus a human-readable `data.error`. Anything
//     reading the status code or the success flag as the verdict passes every
//     test against a healthy device and silently no-ops in production.
//
//  2. HTTP 403 is not an auth failure. It is the device's global remote-control
//     kill switch, which leaves reads working. It is reported as its own failure
//     kind so the terminal can record it and the UI can explain it, rather than
//     every button press failing with an unexplained error.
import http from 'http';
import { Ok, Fail } from '../Utils';
import type { Result } from '../../types/result';
import type {
  FreeKioskCamera,
  FreeKioskCommandResult,
  FreeKioskConnection,
  FreeKioskEnvelope,
  FreeKioskFailureKind,
  FreeKioskImage,
  FreeKioskStatus,
} from './types';

export const DEFAULT_FREEKIOSK_PORT = 8080;
export const DEFAULT_FREEKIOSK_TIMEOUT_MS = 5000;

/**
 * Captures get their own, longer, budget. A camera capture on a cheap Android
 * tablet genuinely takes a second or two (sensor init plus auto-exposure), so
 * reusing the poll timeout would make a working feature look broken.
 */
export const FREEKIOSK_IMAGE_TIMEOUT_MS = 15000;

/** Hard ceiling on a capture. Enforced against the stream, not just the header. */
export const MAX_FREEKIOSK_IMAGE_BYTES = 4 * 1024 * 1024;

/** Ceiling on a JSON body, so a wrong-port device cannot stream into memory. */
const MAX_JSON_BYTES = 512 * 1024;

const USER_AGENT = 'ShowTrak-FreeKiosk/1.0';

interface RawResponse {
  Status: number;
  Headers: http.IncomingHttpHeaders;
  Body: Buffer;
  LatencyMs: number;
}

interface RequestOptions {
  Method: 'GET' | 'POST';
  Path: string;
  Body?: unknown;
  TimeoutMs: number;
  MaxBytes: number;
}

export interface FreeKioskRequestFailure {
  Kind: FreeKioskFailureKind;
  Message: string;
}

/** A failure carries a Kind so callers can react to control-disabled specifically. */
export class FreeKioskError extends Error {
  Kind: FreeKioskFailureKind;

  constructor(Kind: FreeKioskFailureKind, Message: string) {
    super(Message);
    this.name = 'FreeKioskError';
    this.Kind = Kind;
  }
}

export function IsFreeKioskError(Value: unknown): Value is FreeKioskError {
  return Value instanceof FreeKioskError;
}

function NormalizePort(Port: unknown): number {
  const Parsed = Number(Port);
  if (!Number.isFinite(Parsed)) return DEFAULT_FREEKIOSK_PORT;
  const Rounded = Math.trunc(Parsed);
  if (Rounded < 1 || Rounded > 65535) return DEFAULT_FREEKIOSK_PORT;
  return Rounded;
}

function NormalizeTimeout(TimeoutMs: unknown): number {
  const Parsed = Number(TimeoutMs);
  if (!Number.isFinite(Parsed)) return DEFAULT_FREEKIOSK_TIMEOUT_MS;
  return Math.min(30000, Math.max(1000, Math.trunc(Parsed)));
}

/**
 * The device closed the connection before answering.
 *
 * A fixed string rather than whatever Node happened to say, so SendCommand can
 * recognise it without pattern-matching an OS error message. Everywhere else it
 * is a genuine failure; only a command declaring ExpectDisconnect treats it as
 * the expected outcome.
 */
export const FREEKIOSK_DISCONNECTED = 'The device closed the connection';

function ClassifyTransportError(Err: unknown): FreeKioskRequestFailure {
  const Message = Err && (Err as Error).message ? (Err as Error).message : String(Err);
  const Code = (Err as NodeJS.ErrnoException | null)?.code || '';
  if (/timed out/i.test(Message) || Code === 'ETIMEDOUT') {
    return { Kind: 'timeout', Message: 'Timed out waiting for the device' };
  }
  if (Code === 'ECONNREFUSED') {
    return { Kind: 'transport', Message: 'Connection refused — is the REST API enabled?' };
  }
  if (Code === 'EHOSTUNREACH' || Code === 'ENETUNREACH') {
    return { Kind: 'transport', Message: 'Device unreachable' };
  }
  if (Code === 'ENOTFOUND' || Code === 'EAI_AGAIN') {
    return { Kind: 'transport', Message: 'Address could not be resolved' };
  }
  // The device accepted the request and then tore the socket down mid-response.
  // Given a reboot or a UI restart that is the command working, so it gets its
  // own stable message for SendCommand to recognise — see FREEKIOSK_DISCONNECTED.
  if (Code === 'ECONNRESET' || Code === 'EPIPE' || /socket hang ?up/i.test(Message)) {
    return { Kind: 'transport', Message: FREEKIOSK_DISCONNECTED };
  }
  return { Kind: 'transport', Message };
}

function PerformRequest(
  Connection: FreeKioskConnection,
  Options: RequestOptions
): Promise<Result<RawResponse>> {
  return new Promise<Result<RawResponse>>((resolve) => {
    const Address = String(Connection.Address || '').trim();
    if (!Address) return resolve(Fail('No address configured'));

    const Payload = Options.Body == null ? null : Buffer.from(JSON.stringify(Options.Body), 'utf8');

    const Headers: Record<string, string> = {
      Host: `${Address}:${NormalizePort(Connection.Port)}`,
      'User-Agent': USER_AGENT,
      Accept: '*/*',
      Connection: 'close',
    };
    const ApiKey = String(Connection.ApiKey || '').trim();
    if (ApiKey) Headers['X-Api-Key'] = ApiKey;
    if (Payload) {
      Headers['Content-Type'] = 'application/json';
      Headers['Content-Length'] = String(Payload.length);
    }

    const Started = Date.now();
    let Settled = false;
    const Finish = (Value: Result<RawResponse>) => {
      if (Settled) return;
      Settled = true;
      resolve(Value);
    };

    let Req: http.ClientRequest;
    try {
      Req = http.request({
        method: Options.Method,
        host: Address,
        port: NormalizePort(Connection.Port),
        path: Options.Path,
        headers: Headers,
      });
    } catch (Err) {
      const Failure = ClassifyTransportError(Err);
      return Finish(Fail(Failure.Message));
    }

    const KillTimer = setTimeout(() => {
      try {
        Req.destroy(new Error(`Request timed out after ${Options.TimeoutMs}ms`));
      } catch {
        // Already gone; the error handler resolves.
      }
    }, Options.TimeoutMs);

    Req.on('error', (Err: Error) => {
      clearTimeout(KillTimer);
      const Failure = ClassifyTransportError(Err);
      Finish(Fail(Failure.Message));
    });

    Req.on('response', (Res: http.IncomingMessage) => {
      // Reject an oversized capture before reading a byte of it where the device
      // is honest about the length...
      const Declared = Number(Res.headers['content-length'] || 0);
      if (Number.isFinite(Declared) && Declared > Options.MaxBytes) {
        clearTimeout(KillTimer);
        Res.destroy();
        return Finish(Fail(`Response too large (${Declared} bytes)`));
      }

      const Chunks: Buffer[] = [];
      let Total = 0;
      let Aborted = false;

      Res.on('data', (Chunk: Buffer) => {
        // ...and again against the stream itself, because content-length is a
        // claim, not a guarantee.
        Total += Chunk.length;
        if (Total > Options.MaxBytes) {
          Aborted = true;
          clearTimeout(KillTimer);
          Res.destroy();
          Finish(Fail(`Response too large (over ${Options.MaxBytes} bytes)`));
          return;
        }
        Chunks.push(Chunk);
      });

      Res.on('end', () => {
        if (Aborted) return;
        clearTimeout(KillTimer);
        Finish(
          Ok({
            Status: Res.statusCode || 0,
            Headers: Res.headers,
            Body: Buffer.concat(Chunks),
            LatencyMs: Date.now() - Started,
          })
        );
      });

      Res.on('error', (Err: Error) => {
        if (Aborted) return;
        clearTimeout(KillTimer);
        Finish(Fail(Err && Err.message ? Err.message : String(Err)));
      });
    });

    if (Payload) Req.write(Payload);
    Req.end();
  });
}

function ParseEnvelope(Body: Buffer): FreeKioskEnvelope | null {
  const Text = Body.toString('utf8').trim();
  if (!Text) return null;
  try {
    const Parsed = JSON.parse(Text);
    return Parsed && typeof Parsed === 'object' ? (Parsed as FreeKioskEnvelope) : null;
  } catch {
    return null;
  }
}

/** Map a status code plus envelope onto a failure, or null when the call is good. */
function ClassifyHttpFailure(
  Response: RawResponse,
  Envelope: FreeKioskEnvelope | null
): FreeKioskRequestFailure | null {
  const DeviceError = Envelope && Envelope.error != null ? String(Envelope.error).trim() : '';

  if (Response.Status === 401) {
    return { Kind: 'unauthorized', Message: DeviceError || 'Unauthorized — check the API key' };
  }
  if (Response.Status === 403) {
    return {
      Kind: 'control-disabled',
      Message: 'Remote control is disabled on this device',
    };
  }
  if (Response.Status === 404) {
    return {
      Kind: 'not-found',
      Message: 'Endpoint not found — the device may be running an older FreeKiosk build',
    };
  }
  if (Response.Status === 503) {
    return {
      Kind: 'unavailable',
      Message: DeviceError || 'The device could not fulfil the request',
    };
  }
  if (Response.Status < 200 || Response.Status >= 300) {
    return {
      Kind: Response.Status >= 500 ? 'device-error' : 'bad-response',
      Message: DeviceError || `Device returned HTTP ${Response.Status}`,
    };
  }
  if (!Envelope) {
    return {
      Kind: 'bad-response',
      Message: 'Unexpected response from device — is this a FreeKiosk terminal?',
    };
  }
  if (Envelope.success === false) {
    return { Kind: 'device-error', Message: DeviceError || 'The device reported a failure' };
  }
  return null;
}

export interface FreeKioskStatusReading {
  Status: FreeKioskStatus;
  LatencyMs: number;
}

/**
 * Poll a terminal.
 *
 * One request per poll: /api/status is a superset of every individual read
 * endpoint, so /api/battery, /api/screen and friends would only multiply load
 * for the same data. It doubles as the reachability probe, which is why
 * /api/health is never called.
 */
export async function GetStatus(
  Connection: FreeKioskConnection
): Promise<Result<FreeKioskStatusReading>> {
  const [Err, Response] = await PerformRequest(Connection, {
    Method: 'GET',
    Path: '/api/status',
    TimeoutMs: NormalizeTimeout(Connection.TimeoutMs),
    MaxBytes: MAX_JSON_BYTES,
  });
  if (Err || !Response) return Fail(Err || 'No response from device');

  const Envelope = ParseEnvelope(Response.Body);
  const Failure = ClassifyHttpFailure(Response, Envelope);
  if (Failure) return Fail(Failure.Message);

  const Data = Envelope && Envelope.data;
  if (!Data || typeof Data !== 'object') {
    return Fail('Device returned no status data');
  }

  return Ok({ Status: Data as FreeKioskStatus, LatencyMs: Response.LatencyMs });
}

export interface FreeKioskCommandOutcome {
  Result: FreeKioskCommandResult;
  LatencyMs: number;
  /** The device took the command and dropped the connection carrying it out. */
  Disconnected?: boolean;
}

/**
 * Send a control command.
 *
 * Callers get a FreeKioskError on failure so they can tell a refusal from a
 * control-disabled device; use IsFreeKioskError to read the Kind.
 */
export async function SendCommand(
  Connection: FreeKioskConnection,
  Method: 'GET' | 'POST',
  Path: string,
  Body?: Record<string, unknown> | null,
  ExpectDisconnect = false
): Promise<Result<FreeKioskCommandOutcome>> {
  const [Err, Response] = await PerformRequest(Connection, {
    Method,
    Path,
    Body: Method === 'POST' ? (Body ?? {}) : undefined,
    TimeoutMs: NormalizeTimeout(Connection.TimeoutMs),
    MaxBytes: MAX_JSON_BYTES,
  });

  // A reboot or UI restart kills the HTTP server mid-response, so the socket
  // dies before an answer arrives. For those commands that IS the success case.
  //
  // Note how narrow this is. Only a dropped connection counts — a timeout, a
  // refusal, a 403 or a 401 still fail, because each of those means the device
  // was alive enough to say no. Widening it to any error would make Reboot
  // incapable of reporting a genuine failure.
  if (Err && ExpectDisconnect && Err === FREEKIOSK_DISCONNECTED) {
    return Ok({ Result: { executed: true }, LatencyMs: 0, Disconnected: true });
  }

  if (Err || !Response) return Fail(Err || 'No response from device');

  const Envelope = ParseEnvelope(Response.Body);
  const Failure = ClassifyHttpFailure(Response, Envelope);
  if (Failure) return Fail(Failure.Message);

  const Data = (Envelope && Envelope.data) as FreeKioskCommandResult | undefined;

  // THE TRAP. A device without Device Owner answers 200 / success:true and
  // reports the refusal here. Treating the envelope as the verdict would report
  // a reboot that never happened.
  if (Data && typeof Data === 'object' && Data.executed === false) {
    const Message = Data.error != null ? String(Data.error) : '';
    return Fail(Message || 'The device refused the command');
  }

  return Ok({ Result: Data || {}, LatencyMs: Response.LatencyMs });
}

/** Which of the two capture endpoints to hit. */
export interface FreeKioskCaptureOptions {
  Camera?: 'front' | 'back';
  Quality?: number;
}

function CapturePath(Kind: 'screenshot' | 'camera', Options: FreeKioskCaptureOptions): string {
  if (Kind === 'screenshot') return '/api/screenshot';
  const Camera = Options.Camera === 'front' ? 'front' : 'back';
  const Quality = Math.min(100, Math.max(1, Math.trunc(Number(Options.Quality) || 80)));
  return `/api/camera/photo?camera=${Camera}&quality=${Quality}`;
}

/**
 * Fetch a screenshot or camera photo as a data URL.
 *
 * The buffer is encoded and dropped immediately: captures are never written to
 * disk, never persisted and never broadcast — the data URL is returned only to
 * the renderer that asked for it.
 */
export async function FetchImage(
  Connection: FreeKioskConnection,
  Kind: 'screenshot' | 'camera',
  Options: FreeKioskCaptureOptions = {}
): Promise<Result<FreeKioskImage>> {
  const [Err, Response] = await PerformRequest(Connection, {
    Method: 'GET',
    Path: CapturePath(Kind, Options),
    TimeoutMs: FREEKIOSK_IMAGE_TIMEOUT_MS,
    MaxBytes: MAX_FREEKIOSK_IMAGE_BYTES,
  });
  if (Err || !Response) return Fail(Err || 'No response from device');

  const ContentType = String(Response.Headers['content-type'] || '')
    .split(';')[0]!
    .trim()
    .toLowerCase();

  // A failed capture answers 503 with the JSON envelope rather than an image, so
  // the device's own explanation ("camera in use by another app") survives.
  if (!ContentType.startsWith('image/')) {
    const Envelope = ParseEnvelope(Response.Body);
    const Failure = ClassifyHttpFailure(Response, Envelope);
    if (Failure) return Fail(Failure.Message);
    return Fail(
      Kind === 'camera'
        ? 'Camera unavailable — check the camera permission and hardware'
        : 'Screenshot unavailable'
    );
  }

  if (!Response.Body.length) return Fail('Device returned an empty image');

  return Ok({
    DataUrl: `data:${ContentType};base64,${Response.Body.toString('base64')}`,
    Bytes: Response.Body.length,
    Mime: ContentType,
    CapturedAt: Date.now(),
  });
}

/** List the device's cameras, so the UI only offers ones that exist. */
export async function GetCameraList(
  Connection: FreeKioskConnection
): Promise<Result<FreeKioskCamera[]>> {
  const [Err, Response] = await PerformRequest(Connection, {
    Method: 'GET',
    Path: '/api/camera/list',
    TimeoutMs: NormalizeTimeout(Connection.TimeoutMs),
    MaxBytes: MAX_JSON_BYTES,
  });
  if (Err || !Response) return Fail(Err || 'No response from device');

  const Envelope = ParseEnvelope(Response.Body);
  const Failure = ClassifyHttpFailure(Response, Envelope);
  if (Failure) return Fail(Failure.Message);

  const Data = (Envelope && Envelope.data) as { cameras?: unknown } | undefined;
  const Raw = Data && Array.isArray(Data.cameras) ? Data.cameras : [];
  const Cameras: FreeKioskCamera[] = [];
  for (const Entry of Raw) {
    if (!Entry || typeof Entry !== 'object') continue;
    const Record_ = Entry as Record<string, unknown>;
    Cameras.push({
      id: String(Record_.id ?? ''),
      facing: String(Record_.facing ?? ''),
      maxWidth: Number(Record_.maxWidth) || 0,
      maxHeight: Number(Record_.maxHeight) || 0,
    });
  }
  return Ok(Cameras);
}

export const _internal = {
  ClassifyHttpFailure,
  ClassifyTransportError,
  ParseEnvelope,
  CapturePath,
};
