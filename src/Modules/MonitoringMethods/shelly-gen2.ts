// Shelly Gen2 / Gen3 / Gen4 device health via the documented RPC API over HTTP
// (shelly-api-docs.shelly.cloud/gen2/). Covers the Plus, Pro, Mini and Gen3/Gen4
// ranges: relays and plugs (switch:N), inputs (input:N), temperature and
// humidity sensors (temperature:N, humidity:N, including add-on probes), power
// meters (pm1:N, em:N, em1:N), battery state (devicepower:N) and Wi-Fi.
//
// Every poll makes two bodiless GETs (RPC Channels: "GET /rpc/<method>"; the
// device replies with the bare `result` object):
//   GET /rpc/Shelly.GetDeviceInfo  -> id, name, model, gen, app, ver, fw_id, auth_en
//   GET /rpc/Shelly.GetStatus      -> one status object per component, keyed
//                                     "<type>:<id>" ("switch:0") or "<type>" ("wifi")
//
// Component status fields read (each from that component's GetStatus page):
//   switch:N       output, apower (W), voltage (V), current (A),
//                  temperature.tC, errors[] (overtemp | overpower |
//                  overvoltage | undervoltage)
//   temperature:N  tC (null when unreadable), errors[] (out_of_range | read)
//   humidity:N     rh (null when unreadable), errors[] (out_of_range | read)
//   input:N        state (switch/button), percent (analog), errors[]
//   pm1:N          apower, voltage, current, errors[]
//   em1:N          act_power, voltage, current, errors[], flags[]
//   em:N           total_act_power, <a|b|c>_voltage, errors[], <a|b|c|n>_errors[],
//                  <a|b|c>_flags[]
//   devicepower:N  battery.percent, external.present
//   wifi           status, ssid, rssi (dBm), sta_ip
//   cloud          connected
// `errors` (and `<phase>_errors`) is "shown only if at least one error is
// present" on every component, so any non-empty one is a fault. The meters'
// `flags` carry alarm conditions (overpower, undervoltage, ...) beside one
// non-fault flag, `count_disabled`, which is ignored.
//
// Authentication (General / Authentication): when enabled, every request is
// challenged with HTTP 401 and `WWW-Authenticate: Digest qop="auth",
// realm="<device id>", nonce="...", algorithm=SHA-256`. The username is always
// `admin`; HA1 = SHA-256(admin:realm:password), HA2 = SHA-256(method:uri),
// response = SHA-256(HA1:nonce:nc:cnonce:auth:HA2). Every request here answers
// a fresh challenge, so nc is always 00000001 for that nonce. Repeated failures
// trip the device's brute-force protection, which answers HTTP 429.
//
// Battery-powered devices (Plus H&T, H&T Gen3) sleep between reports and do
// not answer HTTP most of the time; this check cannot monitor them. The
// mqtt-topic method can watch the status they publish when they wake.
//
// Actions: switch a listed relay on, off or toggle it (Switch.Set /
// Switch.Toggle), or power-cycle it: Switch.Set on=false with toggle_after, so
// the DEVICE turns it back on after the off time even if ShowTrak loses the
// connection mid-cycle. Off, toggle and power-cycle can cut power to show kit,
// so they are Destructive.
import http from 'http';
import crypto from 'crypto';
import { URL } from 'url';
import { ParseDigestChallenge } from './_brightsign-shared';
import { Card, Esc, Pill, Rows, Row, TextRow, Note, FormatLatency, HealthPill } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type {
  MonitoringActionDef,
  MonitoringActionOptions,
  MonitoringActionResult,
  MonitoringResult,
  MonitoringSettingField,
  MonitoringTargetLike,
} from './types';
import { CachedLookup, RequestHostname } from './_dns-cache';
import { AddressPortError } from './_target-checks';

const ID = 'shelly-gen2';

const DEFAULT_PORT = 80;
const DEFAULT_TIMEOUT_MS = 6000;
const MAX_BODY_BYTES = 512 * 1024;
// The only username Gen2+ devices accept, so it is not a setting.
const RPC_USERNAME = 'admin';
// Power-cycle off time bounds. Ours, not the device's: long enough for any
// piece of kit to drop out, short enough that a typo cannot leave a rack dark.
const MIN_CYCLE_SECONDS = 1;
const MAX_CYCLE_SECONDS = 3600;
// Flags on the meter components that are not alarms.
const NON_FAULT_FLAGS = new Set(['count_disabled']);

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'Port',
    Type: 'number',
    Default: DEFAULT_PORT,
    Min: 1,
    Max: 65535,
    Advanced: true,
  },
  {
    Key: 'Password',
    Sensitive: true,
    Label: 'Password',
    Type: 'string',
    Default: '',
    Note: "Only needed when authentication is enabled on the device. The username is always 'admin'.",
  },
  {
    Key: 'SwitchesOn',
    Label: 'Switches expected on',
    Type: 'list',
    ItemType: 'number',
    Default: [],
    Note: 'Switch numbers as the device counts them, from 0. Degraded when a listed switch is off or missing.',
  },
  {
    Key: 'SwitchesOff',
    Label: 'Switches expected off',
    Type: 'list',
    ItemType: 'number',
    Default: [],
    Note: 'Switch numbers, from 0. Degraded when a listed switch is on or missing.',
  },
  {
    Key: 'CheckPower',
    Label: 'Monitor switch power',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded when any switch draws more than the maximum. Only switches with a power meter report a reading.',
  },
  {
    Key: 'MaxPower',
    Label: 'Maximum power per switch (W)',
    Type: 'number',
    Default: 2000,
    Min: 0,
    Max: 100000,
    VisibleWhen: { Key: 'CheckPower', Equals: true },
  },
  {
    Key: 'CheckTemperature',
    Label: 'Monitor temperature sensors',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to threshold every temperature sensor the device reports (H&T, add-on probes). Switch internal temperature is covered by the overtemp error instead.',
  },
  {
    Key: 'MinTemperature',
    Label: 'Minimum temperature (°C)',
    Type: 'number',
    Default: 5,
    Min: -55,
    Max: 150,
    VisibleWhen: { Key: 'CheckTemperature', Equals: true },
  },
  {
    Key: 'MaxTemperature',
    Label: 'Maximum temperature (°C)',
    Type: 'number',
    Default: 35,
    Min: -55,
    Max: 150,
    VisibleWhen: { Key: 'CheckTemperature', Equals: true },
  },
  {
    Key: 'CheckHumidity',
    Label: 'Monitor humidity sensors',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to threshold every humidity sensor the device reports.',
  },
  {
    Key: 'MinHumidity',
    Label: 'Minimum humidity (%)',
    Type: 'number',
    Default: 20,
    Min: 0,
    Max: 100,
    VisibleWhen: { Key: 'CheckHumidity', Equals: true },
  },
  {
    Key: 'MaxHumidity',
    Label: 'Maximum humidity (%)',
    Type: 'number',
    Default: 70,
    Min: 0,
    Max: 100,
    VisibleWhen: { Key: 'CheckHumidity', Equals: true },
  },
  {
    Key: 'CheckRssi',
    Label: 'Monitor Wi-Fi signal',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded when the Wi-Fi signal is weaker than the floor. Skipped while the device is not on Wi-Fi (Ethernet on Pro models).',
  },
  {
    Key: 'MinRssi',
    Label: 'Minimum Wi-Fi signal (dBm)',
    Type: 'number',
    Default: -75,
    Min: -100,
    Max: 0,
    VisibleWhen: { Key: 'CheckRssi', Equals: true },
  },
  {
    Key: 'CheckErrors',
    Label: 'Monitor component errors',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded when any component reports an error (overtemp, overpower, sensor read failure, …) or a meter raises an alarm flag.',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: DEFAULT_TIMEOUT_MS,
    Min: 500,
    Max: 60000,
    Advanced: true,
    Note: 'Budget for the whole check, authentication included.',
  },
];

// --- Config -------------------------------------------------------------------

export interface ShellyConfig {
  Address: string;
  Port: number;
  Password: string;
  TimeoutMs: number;
}

function ParseConfig(Target: MonitoringTargetLike): ShellyConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number(Cfg.Port);
  const Timeout = Number(Cfg.Timeout);
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Port: Number.isFinite(Port) && Port !== 0 ? Port | 0 : DEFAULT_PORT,
    // Deliberately not trimmed; whitespace can be part of a password.
    Password: Cfg.Password == null ? '' : String(Cfg.Password),
    TimeoutMs: Number.isFinite(Timeout) ? Math.max(500, Timeout | 0) : DEFAULT_TIMEOUT_MS,
  };
}

// Build the URL for an RPC path. Accepts a bare host/IP or a pasted URL; any
// path or query on the address is discarded. An explicit (non-default) Port
// setting wins over a port pasted into the address.
export function BuildUrl(Config: ShellyConfig, PathAndQuery: string): URL | null {
  const Trimmed = String(Config.Address || '').trim();
  if (!Trimmed) return null;
  const Raw = /^https?:\/\//i.test(Trimmed) ? Trimmed : `http://${Trimmed}`;
  let Parsed: URL;
  try {
    Parsed = new URL(Raw);
  } catch {
    return null;
  }
  // The local RPC API is plain HTTP.
  if (Parsed.protocol !== 'http:') return null;
  const Q = PathAndQuery.indexOf('?');
  Parsed.pathname = Q >= 0 ? PathAndQuery.slice(0, Q) : PathAndQuery;
  Parsed.search = Q >= 0 ? PathAndQuery.slice(Q) : '';
  if (Config.Port !== DEFAULT_PORT || !Parsed.port) Parsed.port = String(Config.Port);
  return Parsed;
}

// --- Digest (SHA-256) -----------------------------------------------------------

function Sha256(Value: string): string {
  return crypto.createHash('sha256').update(Value, 'utf8').digest('hex');
}

// Escape a value for a quoted-string header parameter. Stripping CR/LF stops a
// configured value from injecting a header.
function EscapeQuoted(Value: unknown): string {
  return String(Value == null ? '' : Value)
    .replace(/[\r\n]/g, '')
    .replace(/(["\\])/g, '\\$1');
}

// The Authorization header answering a Shelly digest challenge, exactly as the
// Authentication page specifies: SHA-256 throughout, qop auth.
export function BuildShellyDigest(
  Challenge: Record<string, string>,
  Method: string,
  Uri: string,
  Password: string,
  Cnonce: string,
  Nc = '00000001'
): string {
  const Realm = Challenge.realm || '';
  const Nonce = Challenge.nonce || '';
  const HA1 = Sha256(`${RPC_USERNAME}:${Realm}:${Password}`);
  const HA2 = Sha256(`${Method}:${Uri}`);
  const Response = Sha256(`${HA1}:${Nonce}:${Nc}:${Cnonce}:auth:${HA2}`);
  return (
    'Digest ' +
    [
      `username="${RPC_USERNAME}"`,
      `realm="${EscapeQuoted(Realm)}"`,
      `nonce="${EscapeQuoted(Nonce)}"`,
      `uri="${EscapeQuoted(Uri)}"`,
      'algorithm=SHA-256',
      `response="${Response}"`,
      'qop=auth',
      `nc=${Nc}`,
      `cnonce="${EscapeQuoted(Cnonce)}"`,
    ].join(', ')
  );
}

// --- HTTP -------------------------------------------------------------------------

interface RawResponse {
  Status: number;
  Body: string;
  Headers: http.IncomingHttpHeaders;
}

// One GET with a hard kill timer. Rejects on transport error or timeout.
function SendOnce(Url: URL, AuthHeader: string | null, BudgetMs: number): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const TimeoutMs = Math.max(1, BudgetMs | 0);
    let Settled = false;
    const Fail = (Err: unknown) => {
      if (Settled) return;
      Settled = true;
      reject(Err instanceof Error ? Err : new Error(String(Err)));
    };
    const Headers: Record<string, string> = {
      Host: Url.host,
      'User-Agent': 'ShowTrak-Monitoring/1.0',
      Accept: 'application/json',
      Connection: 'close',
    };
    if (AuthHeader) Headers.Authorization = AuthHeader;

    let Req: http.ClientRequest;
    try {
      Req = http.request({
        method: 'GET',
        hostname: RequestHostname(Url),
        lookup: CachedLookup,
        port: Number(Url.port) || DEFAULT_PORT,
        path: `${Url.pathname}${Url.search || ''}`,
        headers: Headers,
      });
    } catch (Err) {
      Fail(Err);
      return;
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
      Fail(Err);
    });
    Req.on('response', (Res: http.IncomingMessage) => {
      let Bytes = 0;
      const Chunks: Buffer[] = [];
      Res.on('data', (Chunk: Buffer) => {
        Bytes += Chunk.length;
        // Past the cap the body is simply truncated and fails JSON.parse.
        if (Bytes <= MAX_BODY_BYTES) Chunks.push(Chunk);
      });
      Res.on('end', () => {
        clearTimeout(KillTimer);
        if (Settled) return;
        Settled = true;
        resolve({
          Status: Res.statusCode || 0,
          Body: Buffer.concat(Chunks).toString('utf8'),
          Headers: Res.headers || {},
        });
      });
      Res.on('error', (Err: Error) => {
        clearTimeout(KillTimer);
        Fail(Err);
      });
    });
    try {
      Req.end();
    } catch (Err) {
      clearTimeout(KillTimer);
      Fail(Err);
    }
  });
}

export interface RpcResponse {
  Ok: boolean;
  Result?: unknown;
  Error?: string;
  // The device answered (any HTTP reply at all), as opposed to a transport failure.
  Answered?: boolean;
  // The RPC error code, when the device returned an error object.
  Code?: number;
  LatencyMs?: number;
}

// The error object the device returns in place of a result: {code, message}.
function RpcErrorOf(Json: unknown): { Code: number; Message: string } | null {
  if (!Json || typeof Json !== 'object' || Array.isArray(Json)) return null;
  const Obj = Json as Record<string, unknown>;
  // A full frame wraps it as {error:{code,message}}; /rpc/<method> returns it bare.
  const Inner = (Obj.error && typeof Obj.error === 'object' ? Obj.error : Obj) as Record<
    string,
    unknown
  >;
  if (typeof Inner.code === 'number' && typeof Inner.message === 'string') {
    return { Code: Inner.code, Message: Inner.message };
  }
  return null;
}

// Encode RPC params as a GET query string. Numbers and booleans go bare, which
// the RPC Channels page reads as those types.
export function RpcPath(Method: string, Params: Record<string, number | boolean> = {}): string {
  const Query = Object.entries(Params)
    .map(([Key, Value]) => `${encodeURIComponent(Key)}=${encodeURIComponent(String(Value))}`)
    .join('&');
  return `/rpc/${Method}${Query ? `?${Query}` : ''}`;
}

// Call one RPC method over HTTP GET, answering a digest challenge if one comes.
// `Deadline` is the absolute end of the whole probe's budget. Never throws.
export async function CallRpc(
  Config: ShellyConfig,
  PathAndQuery: string,
  Deadline: number
): Promise<RpcResponse> {
  const Url = BuildUrl(Config, PathAndQuery);
  if (!Url) return { Ok: false, Error: 'Invalid address' };
  const Started = Date.now();
  const Remaining = () => Deadline - Date.now();
  const TimedOut = (): RpcResponse => ({ Ok: false, Error: 'Timed out waiting for the device' });

  let Res: RawResponse;
  try {
    if (Remaining() <= 0) return TimedOut();
    Res = await SendOnce(Url, null, Remaining());
    if (Res.Status === 401) {
      const Challenge = ParseDigestChallenge(Res.Headers['www-authenticate']);
      if (!Challenge) {
        return {
          Ok: false,
          Answered: true,
          Error: 'The device asked for authentication but did not offer digest auth',
        };
      }
      if (!Config.Password) {
        return {
          Ok: false,
          Answered: true,
          Error: 'Authentication is enabled on the device; set its password',
        };
      }
      const Algorithm = String(Challenge.algorithm || '').toUpperCase();
      if (Algorithm !== 'SHA-256') {
        return {
          Ok: false,
          Answered: true,
          Error: `Unsupported digest algorithm "${String(Challenge.algorithm || 'MD5').slice(0, 20)}"`,
        };
      }
      const Uri = `${Url.pathname}${Url.search || ''}`;
      const Auth = BuildShellyDigest(
        Challenge,
        'GET',
        Uri,
        Config.Password,
        crypto.randomBytes(8).toString('hex')
      );
      if (Remaining() <= 0) return TimedOut();
      Res = await SendOnce(Url, Auth, Remaining());
      if (Res.Status === 401) {
        return { Ok: false, Answered: true, Error: 'Authentication failed; check the password' };
      }
    }
  } catch (Err) {
    return { Ok: false, Error: Err instanceof Error ? Err.message : String(Err) };
  }

  if (Res.Status === 429) {
    return {
      Ok: false,
      Answered: true,
      Error: 'The device is refusing logins after too many failed attempts; wait before retrying',
    };
  }

  let Json: unknown;
  let Parsed = false;
  try {
    Json = JSON.parse(Res.Body);
    Parsed = true;
  } catch {
    // handled below
  }
  const RpcError = Parsed ? RpcErrorOf(Json) : null;
  if (RpcError) {
    return {
      Ok: false,
      Answered: true,
      Code: RpcError.Code,
      Error: `${RpcError.Message.slice(0, 200)} (error ${RpcError.Code})`,
    };
  }
  if (Res.Status === 404) {
    return {
      Ok: false,
      Answered: true,
      Error: 'No RPC API at this address (HTTP 404). Gen1 Shelly devices do not have it',
    };
  }
  if (Res.Status < 200 || Res.Status > 299) {
    return { Ok: false, Answered: true, Error: `HTTP ${Res.Status}` };
  }
  if (!Parsed || !Json || typeof Json !== 'object' || Array.isArray(Json)) {
    return { Ok: false, Answered: true, Error: 'The reply was not a JSON object' };
  }
  return { Ok: true, Answered: true, Result: Json, LatencyMs: Date.now() - Started };
}

// --- Readings ---------------------------------------------------------------------

export interface SwitchReading {
  Id: number;
  Output: boolean | null;
  Power: number | null;
  Voltage: number | null;
  Current: number | null;
  TempC: number | null;
}

export interface SensorReading {
  Id: number;
  Value: number | null;
}

export interface InputReading {
  Id: number;
  State: boolean | null;
  Percent: number | null;
}

export interface MeterReading {
  Key: string;
  Power: number | null;
  Voltage: number | null;
  Current: number | null;
}

export interface ComponentIssue {
  Key: string;
  Issues: string[];
}

export interface ShellyReadings {
  Switches: SwitchReading[];
  Temperatures: SensorReading[];
  Humidities: SensorReading[];
  Inputs: InputReading[];
  Meters: MeterReading[];
  Battery: number | null;
  ExternalPower: boolean | null;
  WifiStatus: string | null;
  WifiSsid: string | null;
  WifiRssi: number | null;
  WifiIp: string | null;
  CloudConnected: boolean | null;
  Issues: ComponentIssue[];
}

const Num = (Value: unknown): number | null =>
  typeof Value === 'number' && Number.isFinite(Value) ? Value : null;
const Bool = (Value: unknown): boolean | null => (typeof Value === 'boolean' ? Value : null);
const Str = (Value: unknown): string | null =>
  typeof Value === 'string' && Value !== '' ? Value.slice(0, 200) : null;
const StrList = (Value: unknown): string[] =>
  Array.isArray(Value) ? Value.filter((V) => typeof V === 'string').map((V) => V.slice(0, 60)) : [];

// Split "switch:0" into its type and numeric id; null for a key without an id.
function SplitKey(Key: string): { Type: string; Id: number } | null {
  const Match = /^([a-z0-9_]+):(\d{1,5})$/i.exec(Key);
  if (!Match) return null;
  return { Type: (Match[1] as string).toLowerCase(), Id: Number(Match[2]) };
}

// Every error and alarm flag a component reports: `errors`, the EM per-phase
// `<a|b|c|n>_errors`, and the meters' `flags` / `<phase>_flags` (alarm flags,
// bar count_disabled).
function IssuesOf(Status: Record<string, unknown>): string[] {
  const Out: string[] = [];
  for (const [Field, Value] of Object.entries(Status)) {
    if (Field === 'errors') Out.push(...StrList(Value));
    else if (/^[abcn]_errors$/.test(Field)) {
      Out.push(...StrList(Value).map((E) => `${Field.charAt(0).toUpperCase()}: ${E}`));
    } else if (Field === 'flags' || /^[abc]_flags$/.test(Field)) {
      const Prefix = Field === 'flags' ? '' : `${Field.charAt(0).toUpperCase()}: `;
      Out.push(
        ...StrList(Value)
          .filter((F) => !NON_FAULT_FLAGS.has(F))
          .map((F) => `${Prefix}${F}`)
      );
    }
  }
  return Out;
}

// Pull the readings this check uses out of a Shelly.GetStatus result. Pure;
// never throws; unknown components are ignored except for their errors.
export function ReadStatus(Status: unknown): ShellyReadings {
  const Out: ShellyReadings = {
    Switches: [],
    Temperatures: [],
    Humidities: [],
    Inputs: [],
    Meters: [],
    Battery: null,
    ExternalPower: null,
    WifiStatus: null,
    WifiSsid: null,
    WifiRssi: null,
    WifiIp: null,
    CloudConnected: null,
    Issues: [],
  };
  if (!Status || typeof Status !== 'object' || Array.isArray(Status)) return Out;

  for (const [Key, Raw] of Object.entries(Status as Record<string, unknown>)) {
    if (!Raw || typeof Raw !== 'object' || Array.isArray(Raw)) continue;
    const C = Raw as Record<string, unknown>;
    const Issues = IssuesOf(C);
    if (Issues.length) Out.Issues.push({ Key: Key.slice(0, 40), Issues });

    if (Key === 'wifi') {
      Out.WifiStatus = Str(C.status);
      Out.WifiSsid = Str(C.ssid);
      Out.WifiRssi = Num(C.rssi);
      Out.WifiIp = Str(C.sta_ip);
      continue;
    }
    if (Key === 'cloud') {
      Out.CloudConnected = Bool(C.connected);
      continue;
    }
    const Split = SplitKey(Key);
    if (!Split) continue;
    const { Type, Id } = Split;
    if (Type === 'switch') {
      const Temp = (C.temperature || {}) as Record<string, unknown>;
      Out.Switches.push({
        Id,
        Output: Bool(C.output),
        Power: Num(C.apower),
        Voltage: Num(C.voltage),
        Current: Num(C.current),
        TempC: Num(Temp.tC),
      });
    } else if (Type === 'temperature') {
      Out.Temperatures.push({ Id, Value: Num(C.tC) });
    } else if (Type === 'humidity') {
      Out.Humidities.push({ Id, Value: Num(C.rh) });
    } else if (Type === 'input') {
      Out.Inputs.push({ Id, State: Bool(C.state), Percent: Num(C.percent) });
    } else if (Type === 'pm1') {
      Out.Meters.push({
        Key,
        Power: Num(C.apower),
        Voltage: Num(C.voltage),
        Current: Num(C.current),
      });
    } else if (Type === 'em1') {
      Out.Meters.push({
        Key,
        Power: Num(C.act_power),
        Voltage: Num(C.voltage),
        Current: Num(C.current),
      });
    } else if (Type === 'em') {
      Out.Meters.push({
        Key,
        Power: Num(C.total_act_power),
        Voltage: Num(C.a_voltage),
        Current: Num(C.total_current),
      });
    } else if (Type === 'devicepower' && Out.Battery == null) {
      const Battery = (C.battery || {}) as Record<string, unknown>;
      const External = (C.external || {}) as Record<string, unknown>;
      Out.Battery = Num(Battery.percent);
      Out.ExternalPower = Bool(External.present);
    }
  }
  const ById = (A: { Id: number }, B: { Id: number }) => A.Id - B.Id;
  Out.Switches.sort(ById);
  Out.Temperatures.sort(ById);
  Out.Humidities.sort(ById);
  Out.Inputs.sort(ById);
  Out.Meters.sort((A, B) => A.Key.localeCompare(B.Key));
  Out.Issues.sort((A, B) => A.Key.localeCompare(B.Key));
  return Out;
}

// --- Conditions -------------------------------------------------------------------

export interface ShellyConditions {
  SwitchesOn: number[];
  SwitchesOff: number[];
  CheckPower: boolean;
  MaxPower: number;
  CheckTemperature: boolean;
  MinTemperature: number;
  MaxTemperature: number;
  CheckHumidity: boolean;
  MinHumidity: number;
  MaxHumidity: number;
  CheckRssi: boolean;
  MinRssi: number;
  CheckErrors: boolean;
}

// A 'list' of switch numbers: integers 0..999, deduplicated, in order given.
function IdList(Value: unknown): number[] {
  const List = Array.isArray(Value) ? Value : Value == null || Value === '' ? [] : [Value];
  const Out: number[] = [];
  for (const Item of List) {
    const Text = String(Item).trim();
    if (!/^\d{1,3}$/.test(Text)) continue;
    const N = Number(Text);
    if (!Out.includes(N)) Out.push(N);
  }
  return Out;
}

export function ParseConditions(Cfg: Record<string, unknown>): ShellyConditions {
  const N = (Value: unknown, Fallback: number): number => {
    const V = Number(Value);
    return Value === '' || Value == null || !Number.isFinite(V) ? Fallback : V;
  };
  return {
    SwitchesOn: IdList(Cfg.SwitchesOn),
    SwitchesOff: IdList(Cfg.SwitchesOff),
    CheckPower: Cfg.CheckPower === true,
    MaxPower: N(Cfg.MaxPower, 2000),
    CheckTemperature: Cfg.CheckTemperature === true,
    MinTemperature: N(Cfg.MinTemperature, 5),
    MaxTemperature: N(Cfg.MaxTemperature, 35),
    CheckHumidity: Cfg.CheckHumidity === true,
    MinHumidity: N(Cfg.MinHumidity, 20),
    MaxHumidity: N(Cfg.MaxHumidity, 70),
    CheckRssi: Cfg.CheckRssi === true,
    MinRssi: N(Cfg.MinRssi, -75),
    // On unless explicitly turned off.
    CheckErrors: Cfg.CheckErrors !== false,
  };
}

const Round = (Value: number, Places = 1): number => {
  const F = 10 ** Places;
  return Math.round(Value * F) / F;
};

// Judge the readings against the enabled conditions; returns the failing
// reasons (empty when healthy). Readings the device did not report are skipped.
export function EvaluateConditions(R: ShellyReadings, C: ShellyConditions): string[] {
  const Reasons: string[] = [];
  const SwitchById = new Map(R.Switches.map((S) => [S.Id, S]));

  for (const Id of C.SwitchesOn) {
    const S = SwitchById.get(Id);
    if (!S) Reasons.push(`Switch ${Id} not found`);
    else if (S.Output === false) Reasons.push(`Switch ${Id} is off (expected on)`);
  }
  for (const Id of C.SwitchesOff) {
    const S = SwitchById.get(Id);
    if (!S) Reasons.push(`Switch ${Id} not found`);
    else if (S.Output === true) Reasons.push(`Switch ${Id} is on (expected off)`);
  }

  if (C.CheckPower) {
    for (const S of R.Switches) {
      if (S.Power != null && S.Power > C.MaxPower) {
        Reasons.push(`Switch ${S.Id} drawing ${Round(S.Power)} W (max ${C.MaxPower} W)`);
      }
    }
  }

  if (C.CheckTemperature) {
    for (const T of R.Temperatures) {
      if (T.Value == null) continue;
      if (T.Value < C.MinTemperature) {
        Reasons.push(`Temperature ${T.Id} ${Round(T.Value)}°C (min ${C.MinTemperature}°C)`);
      } else if (T.Value > C.MaxTemperature) {
        Reasons.push(`Temperature ${T.Id} ${Round(T.Value)}°C (max ${C.MaxTemperature}°C)`);
      }
    }
  }

  if (C.CheckHumidity) {
    for (const H of R.Humidities) {
      if (H.Value == null) continue;
      if (H.Value < C.MinHumidity) {
        Reasons.push(`Humidity ${H.Id} ${Round(H.Value)}% (min ${C.MinHumidity}%)`);
      } else if (H.Value > C.MaxHumidity) {
        Reasons.push(`Humidity ${H.Id} ${Round(H.Value)}% (max ${C.MaxHumidity}%)`);
      }
    }
  }

  // RSSI only means something while associated; a Pro on Ethernet reports
  // Wi-Fi as disconnected.
  const OnWifi = R.WifiStatus === 'connected' || R.WifiStatus === 'got ip';
  if (C.CheckRssi && OnWifi && R.WifiRssi != null && R.WifiRssi < C.MinRssi) {
    Reasons.push(`Wi-Fi signal ${R.WifiRssi} dBm (min ${C.MinRssi} dBm)`);
  }

  if (C.CheckErrors) {
    for (const I of R.Issues) Reasons.push(`${I.Key}: ${I.Issues.join(', ')}`);
  }
  return Reasons;
}

// --- Run --------------------------------------------------------------------------

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  const AddressError = AddressPortError(Config);
  if (AddressError) return { Success: false, Error: AddressError };
  const Started = Date.now();
  const Deadline = Started + Config.TimeoutMs;

  const Info = await CallRpc(Config, RpcPath('Shelly.GetDeviceInfo'), Deadline);
  if (!Info.Ok) return { Success: false, Error: Info.Error || 'No reply from the device' };
  const Device = Info.Result as Record<string, unknown>;
  // Every Gen2+ device reports its id and generation; anything else is not one.
  if (typeof Device.id !== 'string' || !Number.isFinite(Number(Device.gen))) {
    return { Success: false, Error: 'The reply is not from a Gen2 or newer Shelly device' };
  }

  const Status = await CallRpc(Config, RpcPath('Shelly.GetStatus'), Deadline);
  if (!Status.Ok) return { Success: false, Error: Status.Error || 'No status from the device' };

  const Readings = ReadStatus(Status.Result);
  const Reasons = EvaluateConditions(Readings, ParseConditions((Target && Target.Settings) || {}));

  const Base: MonitoringResult = {
    Success: true,
    LatencyMs: Date.now() - Started,
    DeviceId: Str(Device.id),
    DeviceName: Str(Device.name),
    Model: Str(Device.model),
    App: Str(Device.app),
    Generation: Num(Device.gen),
    Firmware: Str(Device.ver),
    FirmwareId: Str(Device.fw_id),
    AuthEnabled: Bool(Device.auth_en),
    ...Readings,
  };
  if (Reasons.length) return { ...Base, Degraded: true, DegradedReason: Reasons.join('; ') };
  return Base;
}

// --- Actions ----------------------------------------------------------------------

const SwitchParam: MonitoringSettingField = {
  Key: 'Switch',
  Label: 'Switch',
  Type: 'string',
  Default: '',
  Required: true,
  Note: 'The switch number, from 0. The check lists the switches this device reports.',
};

const Actions: MonitoringActionDef[] = [
  {
    ID: 'switch.on',
    Label: 'Switch On',
    Icon: 'toggle-on',
    Group: 'Switches',
    Params: [SwitchParam],
    Note: 'Turns the switch on.',
  },
  {
    ID: 'switch.off',
    Label: 'Switch Off',
    Icon: 'toggle-off',
    Group: 'Switches',
    Destructive: true,
    Params: [SwitchParam],
    Note: 'Turns the switch off, cutting power to whatever it feeds.',
  },
  {
    ID: 'switch.toggle',
    Label: 'Toggle Switch',
    Icon: 'toggles',
    Group: 'Switches',
    Destructive: true,
    Params: [SwitchParam],
    Note: 'Flips the switch. If it is on, this cuts power to whatever it feeds.',
  },
  {
    ID: 'switch.cycle',
    Label: 'Power Cycle',
    Icon: 'arrow-repeat',
    Group: 'Switches',
    Destructive: true,
    Params: [
      SwitchParam,
      {
        Key: 'OffSeconds',
        Label: 'Off time (s)',
        Type: 'string',
        Default: '',
        Required: true,
        Note: `How long to stay off, from ${MIN_CYCLE_SECONDS} to ${MAX_CYCLE_SECONDS} seconds.`,
      },
    ],
    Note: 'Turns a switch that is on off, and the device turns it back on after the off time. Refused when the switch is already off.',
  },
];

function ParseSwitchId(Value: unknown): number | null {
  const Text = String(Value == null ? '' : Value).trim();
  return /^\d{1,3}$/.test(Text) ? Number(Text) : null;
}

function ParseOffSeconds(Value: unknown): number | null {
  const Text = String(Value == null ? '' : Value).trim();
  if (!/^\d{1,4}$/.test(Text)) return null;
  const N = Number(Text);
  return N >= MIN_CYCLE_SECONDS && N <= MAX_CYCLE_SECONDS ? N : null;
}

// The reason a Switch.Set / Switch.Toggle failed, worded for the operator.
function ActionError(Res: RpcResponse, Id: number): string {
  // -105 NOT FOUND is the documented "Bad id" error.
  if (Res.Code === -105) return `This device has no switch ${Id}`;
  return Res.Error || 'The device did not accept the command';
}

async function RunAction(
  Target: MonitoringTargetLike,
  ActionID: string,
  Params: Record<string, unknown>
): Promise<MonitoringActionResult> {
  const Config = ParseConfig(Target);
  const AddressError = AddressPortError(Config);
  if (AddressError) return { Success: false, Error: AddressError };
  if (!Actions.some((A) => A.ID === ActionID)) {
    return { Success: false, Error: `Unknown Shelly action "${ActionID}"` };
  }
  const Id = ParseSwitchId(Params && Params.Switch);
  if (Id == null) return { Success: false, Error: 'Switch must be a number from 0 to 999.' };
  const Deadline = Date.now() + Config.TimeoutMs;

  if (ActionID === 'switch.on' || ActionID === 'switch.off') {
    const On = ActionID === 'switch.on';
    const Res = await CallRpc(Config, RpcPath('Switch.Set', { id: Id, on: On }), Deadline);
    if (!Res.Ok) return { Success: false, Error: ActionError(Res, Id) };
    return { Success: true, Detail: `Switch ${Id} turned ${On ? 'on' : 'off'}` };
  }

  if (ActionID === 'switch.toggle') {
    const Res = await CallRpc(Config, RpcPath('Switch.Toggle', { id: Id }), Deadline);
    if (!Res.Ok) return { Success: false, Error: ActionError(Res, Id) };
    const WasOn = Bool((Res.Result as Record<string, unknown>).was_on);
    if (WasOn == null) return { Success: true, Detail: `Switch ${Id} toggled` };
    return { Success: true, Detail: `Switch ${Id} turned ${WasOn ? 'off' : 'on'}` };
  }

  // switch.cycle
  const OffSeconds = ParseOffSeconds(Params && Params.OffSeconds);
  if (OffSeconds == null) {
    return {
      Success: false,
      Error: `Off time must be a whole number of seconds from ${MIN_CYCLE_SECONDS} to ${MAX_CYCLE_SECONDS}.`,
    };
  }
  // Read first: toggle_after flips back whatever the starting state, so a
  // switch that is already off would be turned ON after the off time.
  const Now = await CallRpc(Config, RpcPath('Switch.GetStatus', { id: Id }), Deadline);
  if (!Now.Ok) return { Success: false, Error: ActionError(Now, Id) };
  const Output = Bool((Now.Result as Record<string, unknown>).output);
  if (Output !== true) {
    return {
      Success: false,
      Error: `Switch ${Id} is already off, so there is nothing to power-cycle.`,
    };
  }
  const Res = await CallRpc(
    Config,
    RpcPath('Switch.Set', { id: Id, on: false, toggle_after: OffSeconds }),
    Deadline
  );
  if (!Res.Ok) return { Success: false, Error: ActionError(Res, Id) };
  return {
    Success: true,
    Detail: `Switch ${Id} turned off; the device turns it back on in ${OffSeconds} s`,
  };
}

// Offer the switches this device reported, so the operator picks rather than types.
function GetActionOptions(Result: MonitoringResult): MonitoringActionOptions {
  const Switches = Array.isArray(Result && Result.Switches)
    ? (Result.Switches as SwitchReading[])
    : [];
  if (!Switches.length) return {};
  return {
    Switch: Switches.filter((S) => S && Number.isFinite(S.Id)).map((S) => ({
      value: String(S.Id),
      label: `Switch ${S.Id}`,
    })),
  };
}

function DescribeAction(ActionID: string, Params: Record<string, unknown>): string | null {
  const Id = ParseSwitchId(Params && Params.Switch);
  if (Id == null) return null;
  if (ActionID === 'switch.on') return `Switch ${Id} On`;
  if (ActionID === 'switch.off') return `Switch ${Id} Off`;
  if (ActionID === 'switch.toggle') return `Toggle Switch ${Id}`;
  if (ActionID === 'switch.cycle') {
    const Seconds = ParseOffSeconds(Params && Params.OffSeconds);
    return Seconds == null ? `Power Cycle Switch ${Id}` : `Power Cycle Switch ${Id} (${Seconds} s)`;
  }
  return null;
}

// --- Debug ------------------------------------------------------------------------

function Mono(Value: unknown): string {
  return `<span class="font-monospace">${Esc(String(Value))}</span>`;
}

function Fmt(Value: unknown, Unit: string, Places = 1): string | null {
  return typeof Value === 'number' && Number.isFinite(Value)
    ? `${Round(Value, Places)}${Unit}`
    : null;
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseConfig(Target);
  const Reachable = !!(Result && Result.Success === true);
  const StatePill = HealthPill(Result, 'Healthy', false);

  const Head = Rows([
    TextRow('Device', `http://${Config.Address || '-'}:${Config.Port}`),
    Row('Status', StatePill),
    Reachable
      ? Row('Reply time', Mono(FormatLatency(Result.LatencyMs)))
      : TextRow('Error', (Result && Result.Error) || 'Failed to reach the device'),
    Reachable && Result.DegradedReason ? TextRow('Reason', String(Result.DegradedReason)) : null,
    Reachable && Result.DeviceName ? TextRow('Name', String(Result.DeviceName)) : null,
    Reachable && (Result.App || Result.Model)
      ? Row(
          'Model',
          Mono([Result.App, Result.Model ? `(${Result.Model})` : null].filter(Boolean).join(' '))
        )
      : null,
    Reachable && Result.Generation != null
      ? Row('Generation', Mono(`Gen${Result.Generation}`))
      : null,
    Reachable && Result.Firmware ? Row('Firmware', Mono(Result.Firmware)) : null,
    Reachable && Result.WifiStatus
      ? Row(
          'Wi-Fi',
          Mono(
            [
              Result.WifiStatus,
              Result.WifiSsid,
              Result.WifiRssi != null ? `${Result.WifiRssi} dBm` : null,
            ]
              .filter((V) => V != null && V !== '')
              .join(' · ')
          )
        )
      : null,
    Reachable && Result.CloudConnected != null
      ? Row('Cloud', Mono(Result.CloudConnected ? 'Connected' : 'Not connected'))
      : null,
    Reachable && Result.Battery != null ? Row('Battery', Mono(`${Result.Battery}%`)) : null,
  ]);
  if (!Reachable) {
    return (
      Head +
      '<div class="mt-2">' +
      Note(
        'Failed to reach the Shelly RPC API. Battery-powered devices sleep between reports and cannot be polled.'
      ) +
      '</div>'
    );
  }

  const Cards: string[] = [];
  const Switches = Array.isArray(Result.Switches) ? (Result.Switches as SwitchReading[]) : [];
  for (const S of Switches) {
    const Details = [
      Fmt(S.Power, ' W'),
      Fmt(S.Voltage, ' V'),
      Fmt(S.Current, ' A', 2),
      Fmt(S.TempC, '°C'),
    ].filter(Boolean);
    Cards.push(
      Card({
        Title: `Switch ${S.Id}`,
        Badge:
          S.Output == null
            ? Pill('muted', 'Unknown')
            : Pill(S.Output ? 'success' : 'muted', S.Output ? 'On' : 'Off'),
        BodyHtml: Details.length
          ? `<div class="text-muted small font-monospace">${Esc(Details.join(' · '))}</div>`
          : '',
      })
    );
  }
  const Sensor = (Title: string, Value: string | null) =>
    Card({ Title, Badge: Pill('muted', Value == null ? 'No reading' : Value) });
  for (const T of Array.isArray(Result.Temperatures)
    ? (Result.Temperatures as SensorReading[])
    : []) {
    Cards.push(Sensor(`Temperature ${T.Id}`, Fmt(T.Value, '°C')));
  }
  for (const H of Array.isArray(Result.Humidities) ? (Result.Humidities as SensorReading[]) : []) {
    Cards.push(Sensor(`Humidity ${H.Id}`, Fmt(H.Value, '%')));
  }
  for (const I of Array.isArray(Result.Inputs) ? (Result.Inputs as InputReading[]) : []) {
    const Value =
      I.State != null
        ? I.State
          ? 'On'
          : 'Off'
        : I.Percent != null
          ? `${Round(I.Percent)}%`
          : null;
    Cards.push(Sensor(`Input ${I.Id}`, Value));
  }
  for (const M of Array.isArray(Result.Meters) ? (Result.Meters as MeterReading[]) : []) {
    const Details = [Fmt(M.Power, ' W'), Fmt(M.Voltage, ' V'), Fmt(M.Current, ' A', 2)].filter(
      Boolean
    );
    Cards.push(Sensor(String(M.Key), Details.length ? Details.join(' · ') : null));
  }
  for (const I of Array.isArray(Result.Issues) ? (Result.Issues as ComponentIssue[]) : []) {
    Cards.push(
      Card({
        Title: String(I.Key),
        TitleClass: 'font-monospace',
        Badge: Pill('warning', 'Error'),
        BodyHtml: `<div class="text-muted small font-monospace">${Esc(
          (Array.isArray(I.Issues) ? I.Issues : []).join(', ')
        )}</div>`,
      })
    );
  }
  return Cards.length ? `${Head}<div class="d-grid gap-1 mt-2">${Cards.join('')}</div>` : Head;
}

export const Name = 'Shelly (Gen2+)';
export const Description =
  'Reads a Shelly Gen2, Gen3 or Gen4 device over its local RPC API: switch states and power, temperature and humidity sensors, inputs, power meters, Wi-Fi signal and component errors. Can switch, toggle and power-cycle its relays.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseConfig,
  BuildUrl,
  BuildShellyDigest,
  RpcPath,
  ReadStatus,
  ParseConditions,
  EvaluateConditions,
};
export { ID, Settings, Actions, Run, RunAction, GetActionOptions, DescribeAction, Debug };
