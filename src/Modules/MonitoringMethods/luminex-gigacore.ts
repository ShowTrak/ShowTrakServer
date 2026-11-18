// Luminex GigaCore Generation 2 switch health over its REST API (GigaCore 10i,
// 16i, 30i, 10t, 16t, 18t, 20t, 10t-IP, 16tf, O26-I, S30-I). Generation 1
// switches (GigaCore 10, 12, 14R, 16Xt, 16RFO, 26i) speak a different API and
// are not supported.
//
// Sources. Luminex documents the Gen2 API on its support portal and serves the
// reference on the switch itself at http://<switch>/api/doc; that reference is
// not publicly downloadable, so every endpoint and field below is taken from two
// published clients that agree with each other:
//   - Luminex's own Q-SYS plugin (github.com/luminex-lce/gigacore-q-sys-plugin)
//   - the Bitfocus Companion module (github.com/bitfocus/companion-module-luminex-gigacore)
//
//   GET /api/device          -> { name, description, serial, mac_address, model, ... }
//   GET /api/ports/port      -> [{ port_number, legend, enabled, protected,
//                                  link_state, member_of: { type, id } }, ...]
//                               link_state is "down" (or "unknown") without a
//                               link; anything else is a link (the Q-SYS plugin's
//                               rule). The value is shown as the switch reports it.
//   GET /api/poe/capable     -> true | false
//   GET /api/poe/ports       -> [{ port_number, enabled, indication }, ...]
//                               indication is "sourcing", "enabled" or "disabled".
//   PUT /api/identify            {"duration": <seconds>}
//   PUT /api/poe/ports/<n>/enabled   true | false
//
// Auth: HTTP Basic as user "admin" when a password is set on the switch, none
// otherwise. Newer firmware may serve HTTPS (self-signed); like the Companion
// module, Automatic tries HTTP first and falls back to HTTPS, remembering which
// one answered for MONITORING_INTEREST_TTL_MS. A 200, 401 or 403 means the
// scheme is right; anything else (such as a 400 for plain HTTP to an HTTPS-only
// switch) moves on to the other.
//
// NOT AVAILABLE from these sources: negotiated port speed, PoE power draw and
// budget, temperatures, fans, power supplies, RLinkX state and IGMP querier
// state. The on-switch reference may describe them, but nothing published
// confirms their field names, so this check does not read them.
//
// Result semantics:
//   - No answer, or /api/device is not the GigaCore API      -> offline.
//   - Password missing or rejected (401 / 403)               -> degraded.
//   - A Monitored port disabled / without link               -> degraded.
//   - A Monitored PoE port off / not sourcing power          -> degraded.
//
// Actions: Identify (flash the switch's LEDs), and Power Cycle PoE on one port.
// The API has no power-cycle command, so the action switches the port's PoE off,
// waits five seconds and switches it back on. It refuses protected ports and
// ports whose PoE is off, so a press can never power a port that was off.
import {
  AddressHasScheme,
  BuildSwitchUrl,
  CardList,
  DescribePorts,
  IsObject,
  JoinReasons,
  ParseActionPort,
  ParsePortList,
  PortCard,
  RequestSwitchJson,
  Sleep,
  StrOrNull,
  TimeoutOf,
  WithPath,
  type SwitchRequest,
  type SwitchResponse,
} from './_switch-shared';
import { FormatLatency, Note, Pill, Row, Rows, TextRow } from './debug';
import { WithProbeAgents, type ProbeAgents } from './_probe-agents';
import { DEFAULT_MONITORING_INTERVAL_MS, MONITORING_INTEREST_TTL_MS } from '../Config/constants';
import type {
  MonitoringActionDef,
  MonitoringActionResult,
  MonitoringResult,
  MonitoringSettingField,
  MonitoringTargetLike,
} from './types';

const ID = 'luminex-gigacore';
const USERNAME = 'admin';
const DEFAULT_TIMEOUT_MS = 8000;
// How long Power Cycle PoE leaves the port off. Mutable only so tests need not
// wait out the real five seconds.
const Timing = { PoeCycleOffMs: 5000 };

const DEVICE_PATH = '/api/device';
const PORTS_PATH = '/api/ports/port';
const POE_CAPABLE_PATH = '/api/poe/capable';
const POE_PORTS_PATH = '/api/poe/ports';
const IDENTIFY_PATH = '/api/identify';

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Protocol',
    Label: 'Protocol',
    Type: 'select',
    Default: 'auto',
    Options: [
      { value: 'auto', label: 'Automatic' },
      { value: 'http', label: 'HTTP' },
      { value: 'https', label: 'HTTPS' },
    ],
    Note: 'Automatic tries HTTP first, then HTTPS, which newer GigaCore firmware may use instead.',
  },
  {
    Key: 'Password',
    Label: 'Password',
    Type: 'string',
    Default: '',
    Sensitive: true,
    Note: 'Only needed when a password is set on the switch. The username is always admin.',
  },
  {
    Key: 'CheckPorts',
    Label: 'Check port links',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when a Monitored port is disabled or has no link.',
  },
  {
    Key: 'MonitoredPorts',
    Label: 'Monitored ports',
    Type: 'list',
    ItemType: 'string',
    Default: [],
    VisibleWhen: { Key: 'CheckPorts', Equals: true },
    Note: 'Port numbers as printed on the switch. Ranges work too, e.g. 1-4.',
  },
  {
    Key: 'CheckPoe',
    Label: 'Check PoE',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when PoE is off on a Monitored PoE port, or the port is not sourcing power to a device.',
  },
  {
    Key: 'MonitoredPoePorts',
    Label: 'Monitored PoE ports',
    Type: 'list',
    ItemType: 'string',
    Default: [],
    VisibleWhen: { Key: 'CheckPoe', Equals: true },
    Note: 'Port numbers as printed on the switch. Ranges work too, e.g. 1-4.',
  },
  {
    Key: 'Port',
    Label: 'Port',
    Type: 'number',
    Default: 0,
    Min: 0,
    Max: 65535,
    Advanced: true,
    Note: 'Leave at 0 for the protocol default: 80 for HTTP, 443 for HTTPS.',
  },
  {
    Key: 'IgnoreTlsErrors',
    Label: 'Ignore TLS Errors',
    Type: 'boolean',
    Default: true,
    Advanced: true,
    Note: 'Applies to HTTPS only. On by default so the switch’s self-signed certificate is not treated as an outage.',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: DEFAULT_TIMEOUT_MS,
    Min: 500,
    Max: 60000,
    Advanced: true,
    Note: 'Budget for the whole check: every request it makes.',
  },
];

// --- Config ---------------------------------------------------------------------------

type Scheme = 'http' | 'https';

interface GigaCoreConfig {
  Address: string;
  Protocol: 'auto' | Scheme;
  Port: number;
  Password: string;
  IgnoreTlsErrors: boolean;
  TimeoutMs: number;
}

interface HealthOptions {
  CheckPorts: boolean;
  Ports: number[];
  CheckPoe: boolean;
  PoePorts: number[];
  Invalid: string[];
}

function ParseConfig(Target: MonitoringTargetLike): GigaCoreConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Raw = String(Cfg.Protocol || 'auto').toLowerCase();
  const Port = Number(Cfg.Port);
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Protocol: Raw === 'http' || Raw === 'https' ? Raw : 'auto',
    Port: Number.isFinite(Port) ? Port | 0 : 0,
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
  const Ports = CheckPorts ? ParsePortList(Cfg.MonitoredPorts) : { Ports: [], Invalid: [] };
  const PoePorts = CheckPoe ? ParsePortList(Cfg.MonitoredPoePorts) : { Ports: [], Invalid: [] };
  return {
    CheckPorts,
    Ports: Ports.Ports,
    CheckPoe,
    PoePorts: PoePorts.Ports,
    Invalid: [...Ports.Invalid, ...PoePorts.Invalid],
  };
}

function AuthHeaders(Config: GigaCoreConfig): Record<string, string> {
  if (!Config.Password) return {};
  const Token = Buffer.from(`${USERNAME}:${Config.Password}`, 'utf8').toString('base64');
  return { Authorization: `Basic ${Token}` };
}

// --- Scheme detection -------------------------------------------------------------

interface CachedScheme {
  Scheme: Scheme;
  LastUsedAt: number;
}

// Which scheme each switch answered on, so Automatic does not try HTTP first on
// every poll of an HTTPS-only switch. Dropped once no check has used it for
// MONITORING_INTEREST_TTL_MS, or when that scheme stops answering.
const Schemes = new Map<string, CachedScheme>();

function SchemeKey(Config: GigaCoreConfig): string {
  return `${Config.Address.toLowerCase()}\u0000${Config.Port}`;
}

function PruneSchemes(Now: number): void {
  for (const [Key, Entry] of Schemes) {
    if (Now - Entry.LastUsedAt > MONITORING_INTEREST_TTL_MS) Schemes.delete(Key);
  }
}

// A response that shows this scheme is the one the switch speaks.
function SchemeAnswered(Res: SwitchResponse): boolean {
  return Res.Ok && (Res.Status === 200 || Res.Status === 401 || Res.Status === 403);
}

interface OpenedSwitch {
  Base: URL;
  Scheme: Scheme;
  // The GET /api/device reply that settled the scheme.
  Device: SwitchResponse & { Ok: true };
  // This probe's keep-alive connections, when it has them.
  Agents?: ProbeAgents;
}

// GET /api/device on the right scheme. Explicit HTTP/HTTPS (or a URL address
// with its own scheme) makes one attempt; Automatic tries the remembered
// scheme, else HTTP then HTTPS, splitting the budget so a silent first scheme
// cannot use all of it.
async function OpenSwitch(
  Config: GigaCoreConfig,
  DeadlineAt: number,
  Agents?: ProbeAgents
): Promise<{ Ok: true; Switch: OpenedSwitch } | { Ok: false; Error: string; Status?: number }> {
  const Now = Date.now();
  PruneSchemes(Now);
  const Key = SchemeKey(Config);
  let Order: Scheme[];
  if (AddressHasScheme(Config.Address)) {
    Order = [/^https:/i.test(Config.Address) ? 'https' : 'http'];
  } else if (Config.Protocol !== 'auto') {
    Order = [Config.Protocol];
  } else {
    const Known = Schemes.get(Key)?.Scheme;
    Order = Known ? [Known, Known === 'http' ? 'https' : 'http'] : ['http', 'https'];
  }

  let LastError = 'No reply';
  let LastStatus: number | undefined;
  for (let I = 0; I < Order.length; I++) {
    const Scheme = Order[I] as Scheme;
    const Base = BuildSwitchUrl(Config.Address, Scheme, Config.Port);
    if (!Base) return { Ok: false, Error: 'Invalid address' };
    const Remaining = DeadlineAt - Date.now();
    const AttemptDeadline =
      I < Order.length - 1 ? Date.now() + Math.max(250, Math.floor(Remaining / 2)) : DeadlineAt;
    const Res = await RequestSwitchJson(WithPath(Base, DEVICE_PATH), {
      Method: 'GET',
      Headers: AuthHeaders(Config),
      DeadlineAt: Math.min(AttemptDeadline, DeadlineAt),
      IgnoreTlsErrors: Config.IgnoreTlsErrors,
      Agents,
    });
    if (SchemeAnswered(Res) && Res.Ok) {
      Schemes.set(Key, { Scheme, LastUsedAt: Date.now() });
      return { Ok: true, Switch: { Base, Scheme, Device: Res, Agents } };
    }
    if (Res.Ok) {
      LastStatus = Res.Status;
      LastError = `HTTP ${Res.Status} from ${DEVICE_PATH}`;
    } else {
      LastError = Res.Error;
    }
  }
  Schemes.delete(Key);
  return { Ok: false, Error: LastError, ...(LastStatus ? { Status: LastStatus } : {}) };
}

function Request(
  Config: GigaCoreConfig,
  Opened: OpenedSwitch,
  Path: string,
  Request: Omit<SwitchRequest, 'Headers' | 'IgnoreTlsErrors'>
): Promise<SwitchResponse> {
  return RequestSwitchJson(WithPath(Opened.Base, Path), {
    ...Request,
    Headers: AuthHeaders(Config),
    IgnoreTlsErrors: Config.IgnoreTlsErrors,
    Agents: Opened.Agents,
  });
}

// A JSON body from a 2xx reply, or why there is none.
function ReadJson(
  Res: SwitchResponse,
  Path: string
): { Ok: true; Json: unknown } | { Ok: false; Error: string } {
  if (!Res.Ok) return { Ok: false, Error: Res.Error };
  if (Res.Status === 401 || Res.Status === 403) {
    return { Ok: false, Error: `The switch refused ${Path} (HTTP ${Res.Status})` };
  }
  if (Res.Status < 200 || Res.Status > 299) {
    return { Ok: false, Error: `HTTP ${Res.Status} from ${Path}` };
  }
  if (Res.Json === undefined) return { Ok: false, Error: `${Path} did not return JSON` };
  return { Ok: true, Json: Res.Json };
}

// --- Parsing ----------------------------------------------------------------------

export interface GigaCoreDevice {
  Name: string | null;
  Description: string | null;
  Model: string | null;
  Serial: string | null;
  Mac: string | null;
}

export interface GigaCorePort {
  Port: number;
  Legend: string | null;
  Enabled: boolean | null;
  Protected: boolean | null;
  LinkState: string | null;
  LinkUp: boolean;
}

export interface GigaCorePoePort {
  Port: number;
  Enabled: boolean | null;
  Indication: string | null;
}

// GET /api/device. Null unless it looks like the GigaCore Gen2 device object.
function ParseDevice(Json: unknown): GigaCoreDevice | null {
  if (!IsObject(Json)) return null;
  const Device: GigaCoreDevice = {
    Name: StrOrNull(Json.name),
    Description: StrOrNull(Json.description),
    Model: StrOrNull(Json.model),
    Serial: StrOrNull(Json.serial),
    Mac: StrOrNull(Json.mac_address),
  };
  if (!Device.Model && !Device.Serial && !Device.Mac) return null;
  return Device;
}

function Bool(Value: unknown): boolean | null {
  return typeof Value === 'boolean' ? Value : null;
}

// A link is anything other than down or unknown (the rule Luminex's own Q-SYS
// plugin applies).
function IsLinkUp(LinkState: string | null): boolean {
  if (!LinkState) return false;
  const S = LinkState.toLowerCase();
  return S !== 'down' && S !== 'unknown';
}

// GET /api/ports/port. Null when the reply is not a list of ports.
function ParsePorts(Json: unknown): GigaCorePort[] | null {
  if (!Array.isArray(Json)) return null;
  const Ports: GigaCorePort[] = [];
  for (const Row of Json) {
    if (!IsObject(Row)) continue;
    const Port = Number(Row.port_number);
    if (!Number.isInteger(Port) || Port < 1) continue;
    const LinkState = StrOrNull(Row.link_state);
    Ports.push({
      Port,
      Legend: StrOrNull(Row.legend),
      Enabled: Bool(Row.enabled),
      Protected: Bool(Row.protected),
      LinkState,
      LinkUp: IsLinkUp(LinkState),
    });
  }
  return Ports;
}

// GET /api/poe/ports. Null when the reply is not a list of ports.
function ParsePoePorts(Json: unknown): GigaCorePoePort[] | null {
  if (!Array.isArray(Json)) return null;
  const Ports: GigaCorePoePort[] = [];
  for (const Row of Json) {
    if (!IsObject(Row)) continue;
    const Port = Number(Row.port_number);
    if (!Number.isInteger(Port) || Port < 1) continue;
    Ports.push({ Port, Enabled: Bool(Row.enabled), Indication: StrOrNull(Row.indication) });
  }
  return Ports;
}

// --- Verdicts ---------------------------------------------------------------------

export interface PortState {
  Port: number;
  Found: boolean;
  Legend: string | null;
  Enabled: boolean | null;
  LinkState: string | null;
  LinkUp: boolean;
  Problem: string | null;
}

export interface PoeState {
  Port: number;
  Found: boolean;
  Enabled: boolean | null;
  Indication: string | null;
  Problem: string | null;
}

function EvaluatePorts(Wanted: number[], Ports: GigaCorePort[]): PortState[] {
  return Wanted.map((Port) => {
    const Row = Ports.find((P) => P.Port === Port);
    if (!Row) {
      return {
        Port,
        Found: false,
        Legend: null,
        Enabled: null,
        LinkState: null,
        LinkUp: false,
        Problem: `Port ${Port} not found on the switch`,
      };
    }
    const Problem =
      Row.Enabled === false
        ? `Port ${Port} disabled`
        : !Row.LinkUp
          ? `Port ${Port} has no link`
          : null;
    return {
      Port,
      Found: true,
      Legend: Row.Legend,
      Enabled: Row.Enabled,
      LinkState: Row.LinkState,
      LinkUp: Row.LinkUp,
      Problem,
    };
  });
}

function EvaluatePoe(Wanted: number[], Ports: GigaCorePoePort[]): PoeState[] {
  return Wanted.map((Port) => {
    const Row = Ports.find((P) => P.Port === Port);
    if (!Row) {
      return {
        Port,
        Found: false,
        Enabled: null,
        Indication: null,
        Problem: `Port ${Port} has no PoE`,
      };
    }
    const Sourcing = (Row.Indication || '').toLowerCase() === 'sourcing';
    const Problem =
      Row.Enabled === false
        ? `PoE off on port ${Port}`
        : !Sourcing
          ? `Port ${Port} not sourcing PoE${Row.Indication ? ` (${Row.Indication})` : ''}`
          : null;
    return { Port, Found: true, Enabled: Row.Enabled, Indication: Row.Indication, Problem };
  });
}

// --- Run ----------------------------------------------------------------------------

// Several requests per probe (device, ports, PoE): one connection for all of them.
function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  return WithProbeAgents((Agents) => Probe(Target, Agents));
}

async function Probe(Target: MonitoringTargetLike, Agents: ProbeAgents): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (Config.Port < 0 || Config.Port > 65535) {
    return { Success: false, Error: `Invalid port: ${Config.Port}` };
  }
  const Options = ParseHealthOptions(Target);
  const DeadlineAt = Date.now() + Config.TimeoutMs;

  const Opened = await OpenSwitch(Config, DeadlineAt, Agents);
  if (!Opened.Ok) {
    return {
      Success: false,
      Error: Opened.Error,
      ...(Opened.Status ? { Status: Opened.Status } : {}),
    };
  }
  const Switch = Opened.Switch;
  const Base: MonitoringResult = {
    Success: true,
    LatencyMs: Switch.Device.LatencyMs,
    Scheme: Switch.Scheme,
    Status: Switch.Device.Status,
  };

  if (Switch.Device.Status === 401 || Switch.Device.Status === 403) {
    return {
      ...Base,
      Degraded: true,
      DegradedReason: Config.Password ? 'Password rejected' : 'The switch requires a password',
      AuthFailed: true,
    };
  }

  const Device = ParseDevice(Switch.Device.Json);
  if (!Device) {
    return {
      Success: false,
      Error: 'The device did not answer as a GigaCore Gen2 switch',
      Status: Switch.Device.Status,
    };
  }

  const Out: MonitoringResult = {
    ...Base,
    Name: Device.Name,
    Description: Device.Description,
    Model: Device.Model,
    Serial: Device.Serial,
    Mac: Device.Mac,
  };
  const Reasons: string[] = Options.Invalid.map(
    (Entry) => `Monitored ports: '${Entry}' is not a port or range`
  );

  // The port list is one request and gives the "links up" count, so it is read
  // even when no port is monitored; a failure only matters when one is.
  const PortsRes = ReadJson(
    await Request(Config, Switch, PORTS_PATH, { Method: 'GET', DeadlineAt }),
    PORTS_PATH
  );
  const Ports = PortsRes.Ok ? ParsePorts(PortsRes.Json) : null;
  if (Ports) {
    Out.PortCount = Ports.length;
    Out.LinksUp = Ports.filter((P) => P.LinkUp).length;
  } else {
    Out.PortsError = PortsRes.Ok ? 'The port list was not readable' : PortsRes.Error;
  }

  if (Options.CheckPorts && Options.Ports.length) {
    if (Ports) {
      const States = EvaluatePorts(Options.Ports, Ports);
      Out.PortStates = States;
      for (const S of States) if (S.Problem) Reasons.push(S.Problem);
    } else {
      Reasons.push(`Failed to read ports: ${String(Out.PortsError)}`);
    }
  }

  if (Options.CheckPoe && Options.PoePorts.length) {
    const CapableRes = ReadJson(
      await Request(Config, Switch, POE_CAPABLE_PATH, { Method: 'GET', DeadlineAt }),
      POE_CAPABLE_PATH
    );
    if (!CapableRes.Ok) {
      Out.PoeError = CapableRes.Error;
      Reasons.push(`Failed to read PoE: ${CapableRes.Error}`);
    } else if (CapableRes.Json === false) {
      Out.PoeCapable = false;
      Reasons.push('The switch is not PoE capable');
    } else {
      Out.PoeCapable = CapableRes.Json === true ? true : null;
      const PoeRes = ReadJson(
        await Request(Config, Switch, POE_PORTS_PATH, { Method: 'GET', DeadlineAt }),
        POE_PORTS_PATH
      );
      const PoePorts = PoeRes.Ok ? ParsePoePorts(PoeRes.Json) : null;
      if (!PoePorts) {
        Out.PoeError = PoeRes.Ok ? 'The PoE port list was not readable' : PoeRes.Error;
        Reasons.push(`Failed to read PoE: ${String(Out.PoeError)}`);
      } else {
        const States = EvaluatePoe(Options.PoePorts, PoePorts);
        Out.PoeStates = States;
        for (const S of States) if (S.Problem) Reasons.push(S.Problem);
      }
    }
  }

  if (Reasons.length) {
    Out.Degraded = true;
    Out.DegradedReason = JoinReasons(Reasons);
  }
  return Out;
}

// --- Actions ------------------------------------------------------------------------

const Actions: MonitoringActionDef[] = [
  {
    ID: 'identify',
    Label: 'Identify',
    Icon: 'lightbulb',
    Group: 'Switch',
    Params: [
      {
        Key: 'Duration',
        Label: 'Duration (seconds)',
        Type: 'number',
        Default: 10,
        Min: 1,
        Max: 600,
        Note: 'How long the switch flashes its LEDs.',
      },
    ],
    Note: 'Flashes the switch’s LEDs so it can be found in the rack.',
  },
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
        Note: 'The port number as printed on the switch.',
      },
    ],
    Note: 'Switches PoE off on one port for five seconds, then back on, restarting the device it powers. Refused on protected ports and on ports whose PoE is off.',
  },
];

async function RunAction(
  Target: MonitoringTargetLike,
  ActionID: string,
  Params: Record<string, unknown>
): Promise<MonitoringActionResult> {
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (Config.Port < 0 || Config.Port > 65535) {
    return { Success: false, Error: `Invalid port: ${Config.Port}` };
  }
  const P = Params || {};

  if (ActionID === 'identify') {
    const Raw = Number(P.Duration);
    const Duration = Number.isFinite(Raw) ? Math.min(600, Math.max(1, Math.round(Raw))) : 10;
    const Opened = await OpenForAction(Config);
    if (!Opened.Ok) return { Success: false, Error: Opened.Error };
    const Res = await Request(Config, Opened.Switch, IDENTIFY_PATH, {
      Method: 'PUT',
      Json: { duration: Duration },
      DeadlineAt: Date.now() + Config.TimeoutMs,
    });
    const Failed = WriteFailure(Res, 'identify');
    if (Failed) return { Success: false, Error: Failed };
    return { Success: true, Detail: `Identifying for ${Duration} seconds` };
  }

  if (ActionID === 'poe.cycle') {
    const Port = ParseActionPort(P.Port);
    if (Port == null) return { Success: false, Error: 'Enter a port number, e.g. 7.' };
    const Opened = await OpenForAction(Config);
    if (!Opened.Ok) return { Success: false, Error: Opened.Error };
    const Switch = Opened.Switch;
    const Deadline = () => Date.now() + Config.TimeoutMs;

    // Read the port first: a protected port must not be touched (the switch
    // and the Companion module both treat it as locked), and only a port whose
    // PoE is on is cycled, so a press can never power up a port that was off.
    const PortsRes = ReadJson(
      await Request(Config, Switch, PORTS_PATH, { Method: 'GET', DeadlineAt: Deadline() }),
      PORTS_PATH
    );
    const Ports = PortsRes.Ok ? ParsePorts(PortsRes.Json) : null;
    if (!Ports) {
      return {
        Success: false,
        Error: `Failed to read the ports: ${PortsRes.Ok ? 'unreadable reply' : PortsRes.Error}`,
      };
    }
    const Row = Ports.find((R) => R.Port === Port);
    if (!Row) return { Success: false, Error: `Port ${Port} does not exist on this switch.` };
    if (Row.Protected === true) {
      return { Success: false, Error: `Port ${Port} is protected on the switch.` };
    }
    const PoeRes = ReadJson(
      await Request(Config, Switch, POE_PORTS_PATH, { Method: 'GET', DeadlineAt: Deadline() }),
      POE_PORTS_PATH
    );
    const PoePorts = PoeRes.Ok ? ParsePoePorts(PoeRes.Json) : null;
    if (!PoePorts) {
      return {
        Success: false,
        Error: `Failed to read PoE: ${PoeRes.Ok ? 'unreadable reply' : PoeRes.Error}`,
      };
    }
    const PoeRow = PoePorts.find((R) => R.Port === Port);
    if (!PoeRow) return { Success: false, Error: `Port ${Port} has no PoE.` };
    if (PoeRow.Enabled !== true) {
      return { Success: false, Error: `PoE is off on port ${Port}, so there is nothing to cycle.` };
    }

    const Path = `${POE_PORTS_PATH}/${Port}/enabled`;
    const Off = await Request(Config, Switch, Path, {
      Method: 'PUT',
      Json: false,
      DeadlineAt: Deadline(),
    });
    const OffFailed = WriteFailure(Off, 'switch PoE off');
    if (OffFailed) return { Success: false, Error: OffFailed };

    await Sleep(Timing.PoeCycleOffMs);

    const On = await Request(Config, Switch, Path, {
      Method: 'PUT',
      Json: true,
      DeadlineAt: Deadline(),
    });
    const OnFailed = WriteFailure(On, 'switch PoE back on');
    if (OnFailed) {
      return {
        Success: false,
        Error: `PoE on port ${Port} was switched off but did not come back on: ${OnFailed} Switch it back on from the GigaCore web interface.`,
      };
    }
    return { Success: true, Detail: `PoE power cycled on port ${Port}` };
  }

  return { Success: false, Error: `Unknown GigaCore action "${ActionID}"` };
}

async function OpenForAction(
  Config: GigaCoreConfig
): Promise<{ Ok: true; Switch: OpenedSwitch } | { Ok: false; Error: string }> {
  const Opened = await OpenSwitch(Config, Date.now() + Config.TimeoutMs);
  if (!Opened.Ok) return { Ok: false, Error: `Failed to reach the switch: ${Opened.Error}` };
  const Status = Opened.Switch.Device.Status;
  if (Status === 401 || Status === 403) {
    return {
      Ok: false,
      Error: Config.Password
        ? 'The switch rejected the password.'
        : 'The switch requires a password.',
    };
  }
  if (!ParseDevice(Opened.Switch.Device.Json)) {
    return { Ok: false, Error: 'The device did not answer as a GigaCore Gen2 switch.' };
  }
  return { Ok: true, Switch: Opened.Switch };
}

// Why a write failed, or null when the switch accepted it (any 2xx).
function WriteFailure(Res: SwitchResponse, What: string): string | null {
  if (!Res.Ok) return `Failed to ${What}: ${Res.Error}.`;
  if (Res.Status === 401 || Res.Status === 403) {
    return `The switch refused to ${What} (HTTP ${Res.Status}).`;
  }
  if (Res.Status < 200 || Res.Status > 299) return `Failed to ${What} (HTTP ${Res.Status}).`;
  return null;
}

function DescribeAction(ActionID: string, Params: Record<string, unknown>): string | null {
  if (ActionID === 'poe.cycle') {
    const Port = ParseActionPort(Params && Params.Port);
    return Port == null ? null : `Power Cycle PoE - Port ${Port}`;
  }
  return null;
}

// --- Debug panel ----------------------------------------------------------------------

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseConfig(Target);
  const Options = ParseHealthOptions(Target);
  const Reachable = !!(Result && Result.Success === true);
  const Degraded = !!(Result && Result.Degraded);
  const State = !Reachable
    ? Pill('danger', 'Offline')
    : Degraded
      ? Pill('warning', Result.DegradedReason || 'Degraded')
      : Pill('success', 'Healthy');
  const Scheme = Result && Result.Scheme ? String(Result.Scheme).toUpperCase() : null;

  const Head = [
    TextRow('Host', `${Config.Address || '-'}${Config.Port > 0 ? `:${Config.Port}` : ''}`),
    Row('Status', State),
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Failed to reach the switch'),
  ];
  if (!Reachable) {
    return (
      Rows(Head) +
      '<div class="mt-2">' +
      Note('Failed to reach the GigaCore API. Gen1 GigaCore switches are not supported.') +
      '</div>'
    );
  }
  if (Result.AuthFailed) {
    return Rows([...Head, Scheme ? TextRow('Protocol', Scheme) : null]);
  }

  const Body = [
    ...Head,
    Scheme ? TextRow('Protocol', Scheme) : null,
    Result.Model ? TextRow('Model', String(Result.Model)) : null,
    Result.Name ? TextRow('Name', String(Result.Name)) : null,
    Result.Description ? TextRow('Description', String(Result.Description)) : null,
    Result.Serial ? TextRow('Serial', String(Result.Serial)) : null,
    Result.Mac ? TextRow('MAC address', String(Result.Mac)) : null,
    Number.isFinite(Number(Result.PortCount))
      ? TextRow('Links up', `${Number(Result.LinksUp)} of ${Number(Result.PortCount)} ports`)
      : Result.PortsError
        ? TextRow('Ports', `Not read (${String(Result.PortsError)})`)
        : null,
  ];

  const PortCards = Array.isArray(Result.PortStates)
    ? (Result.PortStates as PortState[]).map((S) =>
        PortCard(
          `Port ${S.Port}${S.Legend ? ` · ${S.Legend}` : ''}`,
          S.Problem ? (S.Found ? 'warning' : 'danger') : 'ok',
          !S.Found ? 'Not found' : S.Enabled === false ? 'Disabled' : S.LinkUp ? 'Link' : 'No link',
          S.Found && S.LinkState ? `Link state: ${S.LinkState}` : null
        )
      )
    : [];
  const PoeCards = Array.isArray(Result.PoeStates)
    ? (Result.PoeStates as PoeState[]).map((S) =>
        PortCard(
          `Port ${S.Port}`,
          S.Problem ? (S.Found ? 'warning' : 'danger') : 'ok',
          !S.Found ? 'No PoE' : S.Enabled === false ? 'PoE off' : S.Indication || 'Unknown',
          null
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
    Extra
  );
}

export const Name = 'Luminex GigaCore';
export const Description =
  'Reads a Luminex GigaCore Gen2 switch’s identity, port links and PoE state over its REST API (read-only), reporting Degraded when a Monitored port loses its link or a Monitored PoE port stops sourcing power. Includes Identify and a per-port PoE power cycle.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseConfig,
  ParseHealthOptions,
  ParseDevice,
  ParsePorts,
  ParsePoePorts,
  IsLinkUp,
  EvaluatePorts,
  EvaluatePoe,
  Schemes,
  Timing,
};
export { ID, Settings, Actions, Run, RunAction, DescribeAction, Debug };
