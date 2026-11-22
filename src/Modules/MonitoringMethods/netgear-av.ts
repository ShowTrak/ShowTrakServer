// Netgear AV Line switch health (M4250, M4300, M4350) over the switch's REST
// API: HTTPS on port 8443, rooted at /api/v1.
//
// Sources. Netgear sends its REST API reference on request only, so this is
// built from two public copies of it that agree:
//   - the Bitfocus Companion module (github.com/bitfocus/companion-module-netgear-avline),
//     maintained and run against M4250, M4300 and M4350 switches;
//   - the M4300 ConfigAgent OpenAPI spec 2.0.0.59 ("M4300 REST API") that the
//     Companion module was written from, mirrored in
//     github.com/ready-1/netgear_m4300_ansible (config/m4300_configagent_2_0_0_59.yaml).
//
//   POST /login            {"login":{"username","password"}} -> {resp, login:{token, expires}}
//                          Every later request sends "Authorization: Bearer <token>".
//   GET  /device_info      -> {resp, deviceInfo:{name, model, serialNumber, swVer,
//                             upTime, numOfPorts, numOfActivePorts, fanState,
//                             temperatureSensors:[{sensorNum, sensorDesc,
//                             sensorTemp, sensorState}], adminPoePower (mW)}}
//   GET  /sw_portstats?portid=ALL -> {resp, switchStatsPort:[{portId, status
//                             (0 = link up, 1 = link down), speed (enum), ...}]}
//   GET  /swcfg_poe?portid=ALL    -> {resp, poePortConfig:[{portid, enable,
//                             status (enum), currentPower (mW), powerLimit, ...}]}
//   GET  /poe_config       -> {resp, poe_config:{pseMainOperationStatus,
//                             totalPowerConsumedWatts, ...}}
//   GET  /snooping_queriers?family=igmp&vlanid=<n> -> {resp, snooping_queriers:
//                             {operState, lastQuerierAddress, adminMode, ...}}
//   POST /swcfg_poe?portid=<n>  {"poePortConfig":{...the port's config, reset:true}}
//                          Power cycles PoE on the port. The switch rejects a
//                          trimmed body, so the port's config is read first and
//                          sent back whole without its portid (Companion module).
//
// Every reply carries resp.status ("success" | "failure" | "fail"); firmware
// reports failures, including a dead token, as a 200 with a failure envelope,
// so the envelope is checked as well as the HTTP status. A 401, or a failure
// whose message speaks of the token / login / session, means log in again.
//
// The login token is cached per switch and account and reused across probes so
// the switch is not logged in to every poll. It is renewed shortly before the
// lifetime the switch reported, replaced after a rejection (one re-login and
// retry per request), and dropped once no check has used it for
// MONITORING_INTEREST_TTL_MS. There is no logout: an unused token simply
// expires on the switch.
//
// NOT AVAILABLE: power supply state is not in the API. Fan state is shown as the
// switch reports it but not judged, as its values are not documented.
//
// Result semantics:
//   - No answer, or the reply is not this API              -> offline.
//   - Login rejected                                        -> degraded.
//   - Any enabled check breached                            -> degraded.
import { createHash } from 'crypto';
import {
  BuildSwitchUrl,
  CardList,
  DescribePorts,
  JoinReasons,
  NumOrNull,
  ParseActionPort,
  ParsePortList,
  PortCard,
  RequestSwitchJson,
  StrOrNull,
  TimeoutOf,
  WithPath,
  type SwitchResponse,
} from './_switch-shared';
import { IsRecord } from '@showtrak/protocol/common';
import { FormatLatency, Note, Pill, Row, Rows, TextRow, HealthPill } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS, MONITORING_INTEREST_TTL_MS } from '../Config/constants';
import type {
  MonitoringActionDef,
  MonitoringActionResult,
  MonitoringResult,
  MonitoringSettingField,
  MonitoringTargetLike,
} from './types';
import { AddressPortError } from './_target-checks';

const ID = 'netgear-av';
const DEFAULT_PORT = 8443;
const API_ROOT = '/api/v1';
// Bulk reads on larger switches have been seen to take 10 s (Companion module).
const DEFAULT_TIMEOUT_MS = 20000;
// Renew this long before the token's reported lifetime runs out (clamped to
// half the lifetime, so a short-lived token is not renewed before every probe).
const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;
const MAX_QUERIER_VLANS = 16;

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Username',
    Label: 'Username',
    Type: 'string',
    Default: 'admin',
    Required: true,
    Note: 'The REST API expects the admin account.',
  },
  {
    Key: 'Password',
    Label: 'Password',
    Type: 'string',
    Default: '',
    Required: true,
    Sensitive: true,
  },
  {
    Key: 'CheckPorts',
    Label: 'Check port links',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when a Monitored port has no link, or links below the minimum speed.',
  },
  {
    Key: 'MonitoredPorts',
    Label: 'Monitored ports',
    Type: 'list',
    ItemType: 'string',
    Default: [],
    VisibleWhen: { Key: 'CheckPorts', Equals: true },
    Note: 'Port numbers as the switch’s API numbers them (1, 2, 3 …). Ranges work too, e.g. 1-8.',
  },
  {
    Key: 'MinimumSpeed',
    Label: 'Minimum link speed',
    Type: 'select',
    Default: '',
    Options: [
      { value: '', label: 'Any speed' },
      { value: '100', label: '100 Mb/s' },
      { value: '1000', label: '1 Gb/s' },
      { value: '2500', label: '2.5 Gb/s' },
      { value: '10000', label: '10 Gb/s' },
      { value: '25000', label: '25 Gb/s' },
    ],
    VisibleWhen: { Key: 'CheckPorts', Equals: true },
    Note: 'Catches a link that has fallen back to a lower speed, often a damaged cable.',
  },
  {
    Key: 'CheckPoe',
    Label: 'Check PoE',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when a Monitored PoE port is not delivering power, or reports a fault or overload.',
  },
  {
    Key: 'MonitoredPoePorts',
    Label: 'Monitored PoE ports',
    Type: 'list',
    ItemType: 'string',
    Default: [],
    VisibleWhen: { Key: 'CheckPoe', Equals: true },
    Note: 'Port numbers as the switch’s API numbers them. Ranges work too, e.g. 1-8.',
  },
  {
    Key: 'CheckPoeBudget',
    Label: 'Check PoE budget',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when PoE is switched off for the whole switch, or the power drawn passes a share of the budget.',
  },
  {
    Key: 'PoeBudgetPercent',
    Label: 'PoE budget alert (%)',
    Type: 'number',
    Default: 90,
    Min: 1,
    Max: 100,
    VisibleWhen: { Key: 'CheckPoeBudget', Equals: true },
    Note: 'Degraded above this share of the PoE budget set on the switch.',
  },
  {
    Key: 'CheckTemperature',
    Label: 'Check temperature',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when a temperature sensor reports Warning, Critical, Shutdown or Not Operational.',
  },
  {
    Key: 'CheckQuerier',
    Label: 'Check IGMP querier',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when no IGMP querier is active on a listed VLAN. Without a querier, multicast such as Dante or AES67 can stop after a few minutes.',
  },
  {
    Key: 'QuerierVlans',
    Label: 'Querier VLANs',
    Type: 'list',
    ItemType: 'number',
    Default: [],
    VisibleWhen: { Key: 'CheckQuerier', Equals: true },
    Note: `VLAN IDs, e.g. 1 and 20. Up to ${MAX_QUERIER_VLANS}; each one is a request.`,
  },
  {
    Key: 'Port',
    Label: 'API port',
    Type: 'number',
    Default: DEFAULT_PORT,
    Min: 1,
    Max: 65535,
    Advanced: true,
    Note: 'The REST API listens on HTTPS port 8443.',
  },
  {
    Key: 'IgnoreTlsErrors',
    Label: 'Ignore TLS Errors',
    Type: 'boolean',
    Default: true,
    Advanced: true,
    Note: 'On by default so the switch’s self-signed certificate is not treated as an outage.',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: DEFAULT_TIMEOUT_MS,
    Min: 1000,
    Max: 60000,
    Advanced: true,
    Note: 'Budget for the whole check, login included. Larger switches can take several seconds to answer.',
  },
];

// --- Config -------------------------------------------------------------------------

interface NetgearConfig {
  Address: string;
  Port: number;
  Username: string;
  Password: string;
  IgnoreTlsErrors: boolean;
  TimeoutMs: number;
}

interface HealthOptions {
  CheckPorts: boolean;
  Ports: number[];
  MinimumSpeedMbps: number;
  CheckPoe: boolean;
  PoePorts: number[];
  CheckPoeBudget: boolean;
  PoeBudgetPercent: number;
  CheckTemperature: boolean;
  CheckQuerier: boolean;
  QuerierVlans: number[];
  Invalid: string[];
}

function ParseConfig(Target: MonitoringTargetLike): NetgearConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number(Cfg.Port);
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Port: Number.isFinite(Port) && Port > 0 ? Port | 0 : DEFAULT_PORT,
    Username:
      Cfg.Username == null || String(Cfg.Username).trim() === ''
        ? 'admin'
        : String(Cfg.Username).trim(),
    // Deliberately not trimmed; trailing whitespace can be part of a password.
    Password: Cfg.Password == null ? '' : String(Cfg.Password),
    IgnoreTlsErrors: Cfg.IgnoreTlsErrors == null ? true : !!Cfg.IgnoreTlsErrors,
    TimeoutMs: TimeoutOf(Cfg, DEFAULT_TIMEOUT_MS),
  };
}

function ParseHealthOptions(Target: MonitoringTargetLike): HealthOptions {
  const Cfg = (Target && Target.Settings) || {};
  const CheckPorts = Cfg.CheckPorts === true;
  const CheckPoe = Cfg.CheckPoe === true;
  const CheckQuerier = Cfg.CheckQuerier === true;
  const Ports = CheckPorts ? ParsePortList(Cfg.MonitoredPorts) : { Ports: [], Invalid: [] };
  const PoePorts = CheckPoe ? ParsePortList(Cfg.MonitoredPoePorts) : { Ports: [], Invalid: [] };
  const Invalid = [...Ports.Invalid, ...PoePorts.Invalid];

  const Vlans: number[] = [];
  if (CheckQuerier) {
    const Raw = Array.isArray(Cfg.QuerierVlans) ? Cfg.QuerierVlans : [];
    for (const Entry of Raw) {
      const Text = String(Entry == null ? '' : Entry).trim();
      if (!Text) continue;
      const Vlan = /^\d{1,4}$/.test(Text) ? Number(Text) : NaN;
      if (Vlan >= 1 && Vlan <= 4094) {
        if (!Vlans.includes(Vlan)) Vlans.push(Vlan);
      } else Invalid.push(`VLAN ${Text}`);
    }
  }
  if (Vlans.length > MAX_QUERIER_VLANS) {
    Invalid.push(`more than ${MAX_QUERIER_VLANS} querier VLANs`);
    Vlans.length = MAX_QUERIER_VLANS;
  }

  const Speed = Number(Cfg.MinimumSpeed);
  const Percent = Number(Cfg.PoeBudgetPercent);
  return {
    CheckPorts,
    Ports: Ports.Ports,
    MinimumSpeedMbps: Number.isFinite(Speed) && Speed > 0 ? Speed : 0,
    CheckPoe,
    PoePorts: PoePorts.Ports,
    CheckPoeBudget: Cfg.CheckPoeBudget === true,
    PoeBudgetPercent: Number.isFinite(Percent) && Percent > 0 ? Math.min(100, Percent) : 90,
    CheckTemperature: Cfg.CheckTemperature === true,
    CheckQuerier,
    QuerierVlans: Vlans,
    Invalid,
  };
}

// --- Session -------------------------------------------------------------------------

interface CachedToken {
  Token: string;
  // Epoch ms the switch said the token expires, or null when not reported.
  ExpiresAt: number | null;
  LifetimeMs: number;
  LastUsedAt: number;
}

const Tokens = new Map<string, CachedToken>();

// Keyed by switch, account and a hash of the password, so the plaintext is not
// kept as a map key and a changed password never reuses the old token.
function TokenKey(Base: URL, Config: NetgearConfig): string {
  const Hash = createHash('sha256').update(Config.Password).digest('hex');
  return `${Base.host}\u0000${Config.Username}\u0000${Hash}`;
}

function PruneTokens(Now: number): void {
  for (const [Key, Entry] of Tokens) {
    if (Now - Entry.LastUsedAt > MONITORING_INTEREST_TTL_MS) Tokens.delete(Key);
  }
}

function TokenIsStale(Entry: CachedToken, Now: number): boolean {
  if (Entry.ExpiresAt == null) return false;
  const Margin = Math.min(TOKEN_REFRESH_MARGIN_MS, Entry.LifetimeMs / 2);
  return Entry.ExpiresAt - Now < Margin;
}

// The resp envelope's verdict: null when it reports success (or is absent),
// else its message.
function EnvelopeFailure(Json: unknown): string | null {
  if (!IsRecord(Json) || !IsRecord(Json.resp)) return null;
  const Status = StrOrNull(Json.resp.status);
  if (!Status || Status.toLowerCase() === 'success') return null;
  return StrOrNull(Json.resp.respMsg) || 'Unknown error';
}

const AUTH_MESSAGE = /token|authentic|login|session|expire/i;

export type ApiReply =
  | { Ok: true; Json: Record<string, unknown>; LatencyMs: number }
  // AuthFailed: the switch rejected the credentials (login) or the account.
  | { Ok: false; Error: string; Answered: boolean; AuthFailed?: boolean };

// One switch's API calls against a deadline, logged in on demand with the
// cached token. A request rejected for its token logs in once and is retried.
class ApiSession {
  private readonly Key: string;
  private Token: string | null = null;
  private LoggedInThisProbe = false;

  constructor(
    private readonly Config: NetgearConfig,
    private readonly Base: URL,
    private readonly DeadlineAt: number
  ) {
    const Now = Date.now();
    PruneTokens(Now);
    this.Key = TokenKey(Base, Config);
    const Cached = Tokens.get(this.Key);
    if (Cached && !TokenIsStale(Cached, Now)) this.Token = Cached.Token;
  }

  private Url(Path: string): URL {
    return WithPath(this.Base, `${API_ROOT}/${Path}`);
  }

  private Drop(): void {
    Tokens.delete(this.Key);
    this.Token = null;
  }

  async Login(): Promise<ApiReply> {
    this.Drop();
    this.LoggedInThisProbe = true;
    const Res = await RequestSwitchJson(this.Url('login'), {
      Method: 'POST',
      Json: { login: { username: this.Config.Username, password: this.Config.Password } },
      DeadlineAt: this.DeadlineAt,
      IgnoreTlsErrors: this.Config.IgnoreTlsErrors,
    });
    if (!Res.Ok) return { Ok: false, Error: Res.Error, Answered: false };
    const Failure = EnvelopeFailure(Res.Json);
    if (Res.Status === 401 || Res.Status === 403 || Failure) {
      return {
        Ok: false,
        Error: `Login rejected${Failure ? `: ${Failure}` : ` (HTTP ${Res.Status})`}`,
        Answered: true,
        AuthFailed: true,
      };
    }
    const Login = IsRecord(Res.Json) && IsRecord(Res.Json.login) ? Res.Json.login : null;
    const Token = Login ? StrOrNull(Login.token) : null;
    if (Res.Status < 200 || Res.Status > 299 || !Token) {
      return {
        Ok: false,
        Error:
          Res.Status >= 200 && Res.Status <= 299
            ? 'The login reply had no token. Is this a Netgear AV Line REST API?'
            : `HTTP ${Res.Status} from login`,
        Answered: true,
      };
    }
    const Seconds = NumOrNull(Login ? Login.expires : null);
    const LifetimeMs = Seconds != null && Seconds > 0 ? Seconds * 1000 : 0;
    const Now = Date.now();
    this.Token = Token;
    Tokens.set(this.Key, {
      Token,
      ExpiresAt: LifetimeMs > 0 ? Now + LifetimeMs : null,
      LifetimeMs,
      LastUsedAt: Now,
    });
    return { Ok: true, Json: Res.Json as Record<string, unknown>, LatencyMs: Res.LatencyMs };
  }

  private Send(Path: string, Method: 'GET' | 'POST', Json?: unknown): Promise<SwitchResponse> {
    return RequestSwitchJson(this.Url(Path), {
      Method,
      ...(Json === undefined ? {} : { Json }),
      Headers: { Authorization: `Bearer ${this.Token}` },
      DeadlineAt: this.DeadlineAt,
      IgnoreTlsErrors: this.Config.IgnoreTlsErrors,
    });
  }

  // Classify one reply: Retry means the token was rejected.
  private Read(Res: SwitchResponse, Path: string): ApiReply | 'Retry' {
    if (!Res.Ok) return { Ok: false, Error: Res.Error, Answered: false };
    if (Res.Status === 401) return 'Retry';
    if (Res.Status === 403) {
      return {
        Ok: false,
        Error: `The switch refused ${Path} (HTTP 403). The account may not be allowed to do that.`,
        Answered: true,
        AuthFailed: true,
      };
    }
    const Failure = EnvelopeFailure(Res.Json);
    if (Failure) {
      // A refusal on grounds of privilege reads a lot like an authentication
      // failure, but logging in again would change nothing.
      if (/denied|permission|privilege|not allowed|read.?only|forbidden/i.test(Failure)) {
        return {
          Ok: false,
          Error: `The switch refused ${Path}: ${Failure}`,
          Answered: true,
          AuthFailed: true,
        };
      }
      if (AUTH_MESSAGE.test(Failure)) return 'Retry';
      return { Ok: false, Error: `${Path} failed: ${Failure}`, Answered: true };
    }
    if (Res.Status < 200 || Res.Status > 299) {
      return { Ok: false, Error: `HTTP ${Res.Status} from ${Path}`, Answered: true };
    }
    if (!IsRecord(Res.Json)) {
      return {
        Ok: false,
        Error: Res.Body.trim() ? `${Path} did not return JSON` : `${Path} returned an empty reply`,
        Answered: true,
      };
    }
    const Cached = Tokens.get(this.Key);
    if (Cached && Cached.Token === this.Token) Cached.LastUsedAt = Date.now();
    return { Ok: true, Json: Res.Json, LatencyMs: Res.LatencyMs };
  }

  async Request(Path: string, Method: 'GET' | 'POST' = 'GET', Json?: unknown): Promise<ApiReply> {
    if (!this.Token) {
      const Login = await this.Login();
      if (!Login.Ok) return Login;
    }
    const First = this.Read(await this.Send(Path, Method, Json), Path);
    if (First !== 'Retry') return First;
    if (this.LoggedInThisProbe) {
      // A token minted moments ago was refused: logging in again would loop.
      this.Drop();
      return {
        Ok: false,
        Error: `The switch rejected the login token for ${Path}`,
        Answered: true,
        AuthFailed: true,
      };
    }
    const Login = await this.Login();
    if (!Login.Ok) return Login;
    const Second = this.Read(await this.Send(Path, Method, Json), Path);
    if (Second === 'Retry') {
      this.Drop();
      return {
        Ok: false,
        Error: `The switch rejected the login token for ${Path}`,
        Answered: true,
        AuthFailed: true,
      };
    }
    return Second;
  }
}

// --- Parsing --------------------------------------------------------------------------

export interface NetgearTemperatureSensor {
  Number: number;
  Description: string | null;
  Celsius: number | null;
  State: number | null;
}

export interface NetgearDevice {
  Name: string | null;
  Model: string | null;
  Serial: string | null;
  Firmware: string | null;
  Uptime: string | null;
  PortCount: number | null;
  ActivePorts: number | null;
  FanState: string | null;
  PoeBudgetMw: number | null;
  Sensors: NetgearTemperatureSensor[];
}

// deviceInfo.temperatureSensorStates, from the spec.
const SENSOR_STATES: Record<number, string> = {
  0: 'None',
  1: 'Normal',
  2: 'Warning',
  3: 'Critical',
  4: 'Shutdown',
  5: 'Not Present',
  6: 'Not Operational',
};
const BAD_SENSOR_STATES = new Set([2, 3, 4, 6]);

// sw_portstats speed enum, from the spec, as Mb/s. Auto-negotiating (1), LAG
// (129), unknown (130) and ATM (14) have no speed and are never judged.
const SPEED_MBPS: Record<number, number> = {
  2: 100,
  3: 100,
  4: 10,
  5: 10,
  6: 100,
  7: 1000,
  8: 10000,
  9: 20000,
  10: 40000,
  11: 25000,
  12: 50000,
  13: 100000,
  15: 5000,
  128: 2500,
};

// swcfg_poe status enum, from the spec.
const POE_STATUS: Record<number, string> = {
  [-1]: 'Invalid',
  0: 'Disabled',
  1: 'Searching',
  2: 'Delivering Power',
  3: 'Test',
  4: 'Fault',
  5: 'Other Fault',
  6: 'Requesting Power',
  7: 'Overload',
};
const POE_DELIVERING = 2;

// fanState is documented as an array of objects of strings, but some firmware
// sends a bare string (Companion module); either way it is shown, not judged.
function DescribeFanState(Value: unknown): string | null {
  if (typeof Value === 'string') return StrOrNull(Value);
  if (!Array.isArray(Value)) return null;
  const Parts = Value.map((Fan) =>
    typeof Fan === 'string'
      ? Fan
      : IsRecord(Fan)
        ? Object.values(Fan)
            .map((V) => StrOrNull(V))
            .filter(Boolean)
            .join(' ')
        : ''
  ).filter(Boolean);
  return Parts.length ? Parts.join(', ') : null;
}

// deviceInfo, or null when the reply is not this API.
function ParseDeviceInfo(Json: unknown): NetgearDevice | null {
  if (!IsRecord(Json) || !IsRecord(Json.deviceInfo)) return null;
  const Info = Json.deviceInfo;
  // Documented as an array, but firmware has been seen to send a single object.
  const RawSensors = Array.isArray(Info.temperatureSensors)
    ? Info.temperatureSensors
    : IsRecord(Info.temperatureSensors)
      ? [Info.temperatureSensors]
      : [];
  const Sensors: NetgearTemperatureSensor[] = [];
  for (const S of RawSensors) {
    if (!IsRecord(S)) continue;
    const Num = NumOrNull(S.sensorNum);
    if (Num == null) continue;
    Sensors.push({
      Number: Num,
      Description: StrOrNull(S.sensorDesc),
      Celsius: NumOrNull(S.sensorTemp),
      State: NumOrNull(S.sensorState),
    });
  }
  return {
    Name: StrOrNull(Info.name),
    Model: StrOrNull(Info.model),
    Serial: StrOrNull(Info.serialNumber),
    Firmware: StrOrNull(Info.swVer),
    Uptime: StrOrNull(Info.upTime),
    PortCount: NumOrNull(Info.numOfPorts),
    ActivePorts: NumOrNull(Info.numOfActivePorts),
    FanState: DescribeFanState(Info.fanState),
    PoeBudgetMw: NumOrNull(Info.adminPoePower),
    Sensors,
  };
}

export interface PortStat {
  Port: number;
  LinkUp: boolean | null;
  SpeedCode: number | null;
  SpeedMbps: number | null;
}

function ParsePortStats(Json: Record<string, unknown>): PortStat[] | null {
  const List = Json.switchStatsPort;
  const Rows = Array.isArray(List) ? List : IsRecord(List) ? [List] : null;
  if (!Rows) return null;
  const Out: PortStat[] = [];
  for (const Row of Rows) {
    if (!IsRecord(Row)) continue;
    const Port = NumOrNull(Row.portId);
    if (Port == null) continue;
    const Status = NumOrNull(Row.status);
    const Speed = NumOrNull(Row.speed);
    Out.push({
      Port,
      LinkUp: Status === 0 ? true : Status === 1 ? false : null,
      SpeedCode: Speed,
      SpeedMbps: Speed == null ? null : (SPEED_MBPS[Speed] ?? null),
    });
  }
  return Out;
}

export interface PoePort {
  Port: number;
  Enabled: boolean | null;
  Status: number | null;
  PowerMw: number | null;
  // The whole entry as the switch sent it, for the power-cycle write.
  Raw: Record<string, unknown>;
}

function ParsePoePorts(Json: Record<string, unknown>): PoePort[] | null {
  const List = Json.poePortConfig;
  const Rows = Array.isArray(List) ? List : IsRecord(List) ? [List] : null;
  if (!Rows) return null;
  const Out: PoePort[] = [];
  for (const Row of Rows) {
    if (!IsRecord(Row)) continue;
    const Port = NumOrNull(Row.portid);
    if (Port == null) continue;
    Out.push({
      Port,
      Enabled: typeof Row.enable === 'boolean' ? Row.enable : null,
      Status: NumOrNull(Row.status),
      PowerMw: NumOrNull(Row.currentPower),
      Raw: Row,
    });
  }
  return Out;
}

export interface QuerierState {
  Vlan: number;
  OperState: string | null;
  LastQuerier: string | null;
  AdminMode: string | null;
  Active: boolean;
  Error: string | null;
}

// A querier is active on the VLAN when this switch is the querier, or one has
// been detected (lastQuerierAddress is "Last IP address detected for querier").
function ParseQuerier(Vlan: number, Json: Record<string, unknown>): QuerierState {
  const Q = IsRecord(Json.snooping_queriers) ? Json.snooping_queriers : null;
  if (!Q) {
    return {
      Vlan,
      OperState: null,
      LastQuerier: null,
      AdminMode: null,
      Active: false,
      Error: 'No querier details in the reply',
    };
  }
  const OperState = StrOrNull(Q.operState);
  const LastQuerier = StrOrNull(Q.lastQuerierAddress);
  const Detected = !!LastQuerier && LastQuerier !== '0.0.0.0' && LastQuerier !== '::';
  return {
    Vlan,
    OperState,
    LastQuerier,
    AdminMode: StrOrNull(Q.adminMode),
    Active: (OperState || '').toLowerCase() === 'querier' || Detected,
    Error: null,
  };
}

// --- Verdicts ---------------------------------------------------------------------------

export interface PortState {
  Port: number;
  Found: boolean;
  LinkUp: boolean | null;
  SpeedMbps: number | null;
  Problem: string | null;
}

export interface PoeState {
  Port: number;
  Found: boolean;
  Status: number | null;
  StatusText: string | null;
  PowerMw: number | null;
  Problem: string | null;
}

export function FormatSpeed(Mbps: number | null): string {
  if (Mbps == null) return 'Unknown speed';
  if (Mbps >= 1000) return `${Mbps / 1000} Gb/s`;
  return `${Mbps} Mb/s`;
}

function EvaluatePorts(Wanted: number[], Stats: PortStat[], MinimumMbps: number): PortState[] {
  return Wanted.map((Port) => {
    const Row = Stats.find((S) => S.Port === Port);
    if (!Row) {
      return {
        Port,
        Found: false,
        LinkUp: null,
        SpeedMbps: null,
        Problem: `Port ${Port} not found on the switch`,
      };
    }
    let Problem: string | null = null;
    if (Row.LinkUp !== true) Problem = `Port ${Port} has no link`;
    else if (MinimumMbps > 0 && Row.SpeedMbps != null && Row.SpeedMbps < MinimumMbps) {
      Problem = `Port ${Port} at ${FormatSpeed(Row.SpeedMbps)} (minimum ${FormatSpeed(MinimumMbps)})`;
    }
    return { Port, Found: true, LinkUp: Row.LinkUp, SpeedMbps: Row.SpeedMbps, Problem };
  });
}

function EvaluatePoe(Wanted: number[], Ports: PoePort[]): PoeState[] {
  return Wanted.map((Port) => {
    const Row = Ports.find((P) => P.Port === Port);
    if (!Row) {
      return {
        Port,
        Found: false,
        Status: null,
        StatusText: null,
        PowerMw: null,
        Problem: `Port ${Port} has no PoE`,
      };
    }
    const StatusText =
      Row.Status == null ? null : (POE_STATUS[Row.Status] ?? `Status ${Row.Status}`);
    let Problem: string | null = null;
    if (Row.Enabled === false) Problem = `PoE off on port ${Port}`;
    else if (Row.Status !== POE_DELIVERING) {
      Problem = `Port ${Port} PoE ${StatusText ? StatusText.toLowerCase() : 'status unknown'}`;
    }
    return { Port, Found: true, Status: Row.Status, StatusText, PowerMw: Row.PowerMw, Problem };
  });
}

function EvaluateTemperature(Sensors: NetgearTemperatureSensor[]): string[] {
  return Sensors.filter((S) => S.State != null && BAD_SENSOR_STATES.has(S.State)).map(
    (S) =>
      `${S.Description || `Sensor ${S.Number}`} ${(SENSOR_STATES[S.State as number] || '').toLowerCase()}` +
      (S.Celsius != null ? ` (${S.Celsius} °C)` : '')
  );
}

// --- Run ------------------------------------------------------------------------------

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  const AddressError = AddressPortError(Config);
  if (AddressError) return { Success: false, Error: AddressError };
  const Base = BuildSwitchUrl(Config.Address, 'https', Config.Port);
  if (!Base) return { Success: false, Error: 'Invalid address' };
  if (!Config.Password) {
    return { Success: false, Error: 'No password configured' };
  }
  const Options = ParseHealthOptions(Target);
  const Session = new ApiSession(Config, Base, Date.now() + Config.TimeoutMs);

  const InfoReply = await Session.Request('device_info');
  if (!InfoReply.Ok) {
    if (InfoReply.AuthFailed) {
      return { Success: true, Degraded: true, DegradedReason: InfoReply.Error, AuthFailed: true };
    }
    return { Success: false, Error: InfoReply.Error };
  }
  const Device = ParseDeviceInfo(InfoReply.Json);
  if (!Device) {
    return { Success: false, Error: 'The device did not answer as a Netgear AV Line switch' };
  }

  const Out: MonitoringResult = {
    Success: true,
    LatencyMs: InfoReply.LatencyMs,
    Name: Device.Name,
    Model: Device.Model,
    Serial: Device.Serial,
    Firmware: Device.Firmware,
    Uptime: Device.Uptime,
    PortCount: Device.PortCount,
    ActivePorts: Device.ActivePorts,
    FanState: Device.FanState,
    PoeBudgetMw: Device.PoeBudgetMw,
    Sensors: Device.Sensors,
  };
  const Reasons: string[] = Options.Invalid.map((Entry) => `'${Entry}' is not a valid entry`);

  if (Options.CheckPorts && Options.Ports.length) {
    const Reply = await Session.Request('sw_portstats?portid=ALL');
    const Stats = Reply.Ok ? ParsePortStats(Reply.Json) : null;
    if (Stats) {
      const States = EvaluatePorts(Options.Ports, Stats, Options.MinimumSpeedMbps);
      Out.PortStates = States;
      for (const S of States) if (S.Problem) Reasons.push(S.Problem);
    } else {
      Reasons.push(`Failed to read ports: ${Reply.Ok ? 'unreadable reply' : Reply.Error}`);
    }
  }

  if (Options.CheckPoe && Options.PoePorts.length) {
    const Reply = await Session.Request('swcfg_poe?portid=ALL');
    const Ports = Reply.Ok ? ParsePoePorts(Reply.Json) : null;
    if (Ports) {
      const States = EvaluatePoe(Options.PoePorts, Ports);
      Out.PoeStates = States;
      for (const S of States) if (S.Problem) Reasons.push(S.Problem);
    } else {
      Reasons.push(`Failed to read PoE: ${Reply.Ok ? 'unreadable reply' : Reply.Error}`);
    }
  }

  if (Options.CheckPoeBudget) {
    const Reply = await Session.Request('poe_config');
    const Poe = Reply.Ok && IsRecord(Reply.Json.poe_config) ? Reply.Json.poe_config : null;
    if (!Poe) {
      Reasons.push(`Failed to read the PoE budget: ${Reply.Ok ? 'unreadable reply' : Reply.Error}`);
    } else {
      const Main = StrOrNull(Poe.pseMainOperationStatus);
      const UsedW = NumOrNull(Poe.totalPowerConsumedWatts);
      Out.PoeMainStatus = Main;
      Out.PoeUsedWatts = UsedW;
      if (Main && Main.toUpperCase() === 'OFF') Reasons.push('PoE is off for the whole switch');
      const BudgetW =
        Device.PoeBudgetMw != null && Device.PoeBudgetMw > 0 ? Device.PoeBudgetMw / 1000 : null;
      if (UsedW == null || BudgetW == null) {
        Reasons.push('The switch did not report its PoE budget and draw');
      } else {
        const Percent = (UsedW / BudgetW) * 100;
        Out.PoeUsedPercent = Math.round(Percent * 10) / 10;
        if (Percent > Options.PoeBudgetPercent) {
          Reasons.push(
            `PoE draw ${UsedW} W is ${Math.round(Percent)}% of the ${BudgetW} W budget (alert above ${Options.PoeBudgetPercent}%)`
          );
        }
      }
    }
  }

  if (Options.CheckTemperature) {
    if (!Device.Sensors.length) Reasons.push('The switch reported no temperature sensors');
    else Reasons.push(...EvaluateTemperature(Device.Sensors));
  }

  if (Options.CheckQuerier && Options.QuerierVlans.length) {
    const Queriers: QuerierState[] = [];
    for (const Vlan of Options.QuerierVlans) {
      const Reply = await Session.Request(`snooping_queriers?family=igmp&vlanid=${Vlan}`);
      const State: QuerierState = Reply.Ok
        ? ParseQuerier(Vlan, Reply.Json)
        : {
            Vlan,
            OperState: null,
            LastQuerier: null,
            AdminMode: null,
            Active: false,
            Error: Reply.Error,
          };
      Queriers.push(State);
      if (State.Error) Reasons.push(`Failed to read the querier on VLAN ${Vlan}: ${State.Error}`);
      else if (!State.Active) Reasons.push(`No IGMP querier on VLAN ${Vlan}`);
      // A timed-out probe will not answer the remaining VLANs either.
      if (!Reply.Ok && !Reply.Answered) break;
    }
    Out.Queriers = Queriers;
  }

  if (Reasons.length) {
    Out.Degraded = true;
    Out.DegradedReason = JoinReasons(Reasons);
  }
  return Out;
}

// --- Actions ---------------------------------------------------------------------------

const Actions: MonitoringActionDef[] = [
  {
    ID: 'poe.cycle',
    Label: 'Power Cycle PoE',
    Icon: 'lightning-charge',
    Group: 'PoE',
    Destructive: true,
    Params: [
      {
        Key: 'Port',
        Label: 'Port',
        Type: 'string',
        Default: '',
        Required: true,
        Note: 'The port number as the switch’s API numbers it.',
      },
    ],
    Note: 'Power cycles PoE on one port, restarting the device it powers. Refused on ports whose PoE is off.',
  },
];

async function RunAction(
  Target: MonitoringTargetLike,
  ActionID: string,
  Params: Record<string, unknown>
): Promise<MonitoringActionResult> {
  if (ActionID !== 'poe.cycle') {
    return { Success: false, Error: `Unknown Netgear action "${ActionID}"` };
  }
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  const Base = BuildSwitchUrl(Config.Address, 'https', Config.Port);
  if (!Base) return { Success: false, Error: 'Invalid address' };
  if (!Config.Password) return { Success: false, Error: 'No password configured' };
  const Port = ParseActionPort(Params && Params.Port);
  if (Port == null) return { Success: false, Error: 'Enter a port number, e.g. 7.' };

  const Session = new ApiSession(Config, Base, Date.now() + Config.TimeoutMs);
  // Read through portid=ALL, as the Companion module does: the documented
  // single-port reply is not shown to carry the port id.
  const Read = await Session.Request('swcfg_poe?portid=ALL');
  if (!Read.Ok)
    return { Success: false, Error: `Failed to read PoE on port ${Port}: ${Read.Error}` };
  const Ports = ParsePoePorts(Read.Json);
  const Row = Ports ? Ports.find((P) => P.Port === Port) : undefined;
  if (!Row)
    return { Success: false, Error: `Port ${Port} has no PoE, or does not exist on this switch.` };
  if (Row.Enabled !== true) {
    return { Success: false, Error: `PoE is off on port ${Port}, so there is nothing to cycle.` };
  }

  // The switch wants the whole entry back, without its port id (Companion module).
  const Body: Record<string, unknown> = { ...Row.Raw, reset: true };
  delete Body.portid;
  const Write = await Session.Request(`swcfg_poe?portid=${Port}`, 'POST', { poePortConfig: Body });
  if (!Write.Ok)
    return { Success: false, Error: `Failed to power cycle port ${Port}: ${Write.Error}` };
  return { Success: true, Detail: `PoE power cycled on port ${Port}` };
}

function DescribeAction(ActionID: string, Params: Record<string, unknown>): string | null {
  if (ActionID === 'poe.cycle') {
    const Port = ParseActionPort(Params && Params.Port);
    return Port == null ? null : `Power Cycle PoE - Port ${Port}`;
  }
  return null;
}

// --- Debug panel -----------------------------------------------------------------------

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseConfig(Target);
  const Options = ParseHealthOptions(Target);
  const Reachable = !!(Result && Result.Success === true);
  const State = HealthPill(Result, 'Healthy');

  const Head = [
    TextRow('Host', `${Config.Address || '-'}:${Config.Port}`),
    Row('Status', State),
    Reachable && Result.LatencyMs != null
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : !Reachable
        ? TextRow('Error', (Result && Result.Error) || 'Failed to reach the switch')
        : null,
  ];
  if (!Reachable) {
    return (
      Rows(Head) +
      '<div class="mt-2">' +
      Note(
        `Failed to reach the REST API on HTTPS port ${Config.Port}. It must be enabled on the switch.`
      ) +
      '</div>'
    );
  }
  if (Result.AuthFailed) return Rows(Head);

  const Sensors = Array.isArray(Result.Sensors)
    ? (Result.Sensors as NetgearTemperatureSensor[])
    : [];
  const Body = [
    ...Head,
    Result.Model ? TextRow('Model', String(Result.Model)) : null,
    Result.Name ? TextRow('Name', String(Result.Name)) : null,
    Result.Serial ? TextRow('Serial', String(Result.Serial)) : null,
    Result.Firmware ? TextRow('Firmware', String(Result.Firmware)) : null,
    Result.Uptime ? TextRow('Uptime', String(Result.Uptime)) : null,
    Result.PortCount != null
      ? TextRow('Active ports', `${Number(Result.ActivePorts ?? 0)} of ${Number(Result.PortCount)}`)
      : null,
    Result.FanState ? TextRow('Fans', String(Result.FanState)) : null,
    ...Sensors.map((S) => {
      const StateText = S.State == null ? 'Unknown' : SENSOR_STATES[S.State] || `State ${S.State}`;
      const Bad = S.State != null && BAD_SENSOR_STATES.has(S.State);
      return Row(
        S.Description || `Sensor ${S.Number}`,
        Pill(
          Bad ? 'warning' : 'success',
          `${S.Celsius != null ? `${S.Celsius} °C · ` : ''}${StateText}`
        )
      );
    }),
    Result.PoeUsedWatts != null
      ? TextRow(
          'PoE draw',
          `${Number(Result.PoeUsedWatts)} W` +
            (Result.PoeBudgetMw != null ? ` of ${Number(Result.PoeBudgetMw) / 1000} W` : '') +
            (Result.PoeUsedPercent != null ? ` (${Number(Result.PoeUsedPercent)}%)` : '')
        )
      : null,
    Result.PoeMainStatus ? TextRow('PoE', String(Result.PoeMainStatus)) : null,
  ];

  const PortCards = Array.isArray(Result.PortStates)
    ? (Result.PortStates as PortState[]).map((S) =>
        PortCard(
          `Port ${S.Port}`,
          S.Problem ? (S.Found ? 'warning' : 'danger') : 'ok',
          !S.Found ? 'Not found' : S.LinkUp ? FormatSpeed(S.SpeedMbps) : 'No link',
          null
        )
      )
    : [];
  const PoeCards = Array.isArray(Result.PoeStates)
    ? (Result.PoeStates as PoeState[]).map((S) =>
        PortCard(
          `Port ${S.Port}`,
          S.Problem ? (S.Found ? 'warning' : 'danger') : 'ok',
          !S.Found ? 'No PoE' : S.StatusText || 'Unknown',
          S.PowerMw != null ? `Drawing ${Math.round(S.PowerMw / 100) / 10} W` : null
        )
      )
    : [];
  const QuerierCards = Array.isArray(Result.Queriers)
    ? (Result.Queriers as QuerierState[]).map((Q) =>
        PortCard(
          `VLAN ${Q.Vlan}`,
          Q.Error ? 'danger' : Q.Active ? 'ok' : 'warning',
          Q.Error ? 'Not read' : Q.Active ? 'Querier active' : 'No querier',
          Q.Error
            ? Q.Error
            : [
                Q.OperState ? `State: ${Q.OperState}` : null,
                Q.LastQuerier ? `Last querier: ${Q.LastQuerier}` : null,
              ]
                .filter(Boolean)
                .join(' · ') || null
        )
      )
    : [];

  let Extra = '';
  if (Options.CheckPorts && !Options.Ports.length) {
    Extra += `<div class="mt-2">${Note('Check port links is on, but no Monitored ports are listed.')}</div>`;
  }
  if (Options.CheckPoe && !Options.PoePorts.length) {
    Extra += `<div class="mt-2">${Note('Check PoE is on, but no Monitored PoE ports are listed.')}</div>`;
  }
  if (Options.CheckQuerier && !Options.QuerierVlans.length) {
    Extra += `<div class="mt-2">${Note('Check IGMP querier is on, but no VLANs are listed.')}</div>`;
  }

  return (
    Rows(Body) +
    CardList(
      Options.Ports.length
        ? `Monitored ports (${DescribePorts(Options.Ports)})`
        : 'Monitored ports',
      PortCards
    ) +
    CardList(
      Options.PoePorts.length
        ? `Monitored PoE ports (${DescribePorts(Options.PoePorts)})`
        : 'Monitored PoE ports',
      PoeCards
    ) +
    CardList('IGMP queriers', QuerierCards) +
    Extra
  );
}

export const Name = 'Netgear AV Line Switch';
export const Description =
  'Reads a Netgear AV Line switch (M4250, M4300, M4350) over its REST API on HTTPS port 8443 (read-only): model, firmware, port links and speed, PoE per port and budget, temperatures and IGMP querier state, reporting Degraded when an enabled check fails. Includes a per-port PoE power cycle.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseConfig,
  ParseHealthOptions,
  ParseDeviceInfo,
  ParsePortStats,
  ParsePoePorts,
  ParseQuerier,
  EvaluatePorts,
  EvaluatePoe,
  EvaluateTemperature,
  EnvelopeFailure,
  TokenIsStale,
  Tokens,
};
export { ID, Settings, Actions, Run, RunAction, DescribeAction, Debug };
