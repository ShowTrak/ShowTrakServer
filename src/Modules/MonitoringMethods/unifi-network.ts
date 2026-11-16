// Ubiquiti UniFi Network health over the OFFICIAL UniFi Network API (the
// "Integration API"), read-only.
//
// Source: the official OpenAPI document published by Ubiquiti at
// developer.ui.com/network/v11.0.97/openapi.json (UniFi Network API 11.0.97).
// Its "Local Console" server is
//   https://{consoleIP}/proxy/network/integration
// and every path below is relative to that base:
//   GET /v1/info                       -> { applicationVersion }
//   GET /v1/sites?offset&limit         -> page of { id, internalReference, name }
//   GET /v1/sites/{siteId}/devices     -> page of adopted devices:
//        { id, name, model, macAddress, ipAddress, state, features[],
//          firmwareVersion, firmwareUpdatable, supported, interfaces[] }
//        state is one of ONLINE, OFFLINE, PENDING_ADOPTION, UPDATING,
//        GETTING_READY, ADOPTING, DELETING, CONNECTION_INTERRUPTED, ISOLATED,
//        U5G_INCORRECT_TOPOLOGY; features holds switching / accessPoint /
//        gateway.
//   GET /v1/sites/{siteId}/clients     -> page of connected clients
// Every list is a page: { offset, limit, count, totalCount, data[] }, limit at
// most 200. Errors are { statusCode, statusName, code, message, ... }.
//
// Authentication is an API key in the X-API-KEY header. The Network API
// document itself declares no security scheme; the header is the one the
// sibling official Site Manager API declares (X-API-Key, header names are case
// insensitive) and the one open-source clients of this local API send
// (unifi-cli on docs.rs). The key is created in the Network app's Integrations
// section ("Create New API Key"), per the official Getting Started page.
//
// Platform: the documented local server is a UniFi OS console (port 443, a
// self-signed certificate, so Ignore TLS errors defaults on like other LAN
// devices, BrightSign's precedent). The legacy self-hosted Network Application
// (port 8443) is not a documented server for this API and reportedly does not
// accept API keys at all, so it is not offered as a mode; the Advanced base path
// and port exist for a UniFi OS Server or a controller that serves the API
// elsewhere. The unofficial cookie-login API is deliberately not used.
//
// Verdicts:
//   Offline  = no HTTP answer, timeout, the key is refused, the API path is not
//              served, or a reply is not the documented JSON.
//   Degraded = reachable, but a Monitored device is not online or missing, any
//              adopted device is not online (when enabled), or fewer access
//              points / clients than the configured minimum.
import { BuildBaseUrl, WithPath, RequestJson, IsObject, TimeoutOf } from './_videoproc-http-shared';
import type { JsonResponse } from './_videoproc-http-shared';
import { Card, Esc, Pill, Rows, Row, TextRow, Note, FormatLatency } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type {
  MonitoringResult,
  MonitoringSettingField,
  MonitoringSettingOptions,
  MonitoringTargetLike,
} from './types';

const ID = 'unifi-network';

const DEFAULT_PORT = 443;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_BASE_PATH = '/proxy/network/integration';
// The API's maximum page size.
const PAGE_LIMIT = 200;
// A ceiling on pages per list so a misbehaving controller cannot loop us.
const MAX_PAGES = 25;
const MAX_MONITORED = 64;

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'Port',
    Type: 'number',
    Default: DEFAULT_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
    Note: '443 on a UniFi OS console (Cloud Gateway, Dream Machine, Cloud Key).',
  },
  {
    Key: 'ApiKey',
    Label: 'API key',
    Type: 'string',
    Default: '',
    Required: true,
    Sensitive: true,
    Note: 'Created in UniFi Network under Integrations with Create New API Key. It is shown only once.',
  },
  {
    Key: 'Site',
    Label: 'Site',
    Type: 'string',
    Default: '',
    Note: 'The site name as shown in UniFi Network. Leave blank when the controller has a single site, or to use the default site.',
  },
  {
    Key: 'MonitoredDevices',
    Label: 'Monitored devices',
    Type: 'list',
    ItemType: 'string',
    FromDevice: true,
    Default: [],
    Note: 'Tick the site’s devices that must be online, or type a name or MAC address. Degraded when one is not online or not adopted on the site. Names are matched without regard to case.',
  },
  {
    Key: 'CheckAllDevices',
    Label: 'Report any device that is not online',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded while any adopted device on the site is offline, updating, adopting or disconnected.',
  },
  {
    Key: 'MinAccessPoints',
    Label: 'Minimum online access points',
    Type: 'number',
    Default: 0,
    Min: 0,
    Max: 10000,
    Note: 'Degraded when fewer access points are online. 0 turns this off.',
  },
  {
    Key: 'MinClients',
    Label: 'Minimum connected clients',
    Type: 'number',
    Default: 0,
    Min: 0,
    Max: 100000,
    Note: 'Degraded when fewer clients are connected, wired, wireless and VPN together. 0 turns this off.',
  },
  {
    Key: 'IgnoreTlsErrors',
    Label: 'Ignore TLS Errors',
    Type: 'boolean',
    Default: true,
    Advanced: true,
    Note: 'On by default so the self-signed console certificate is not treated as an outage.',
  },
  {
    Key: 'BasePath',
    Label: 'API base path',
    Type: 'string',
    Default: DEFAULT_BASE_PATH,
    Advanced: true,
    Note: 'Where the controller serves the official Network API. Change only if yours serves it elsewhere.',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: DEFAULT_TIMEOUT_MS,
    Min: 500,
    Max: 60000,
    Advanced: true,
    Note: 'Budget for the whole check, every request included.',
  },
];

// --- Config ------------------------------------------------------------------

interface UnifiConfig {
  Address: string;
  Port: number;
  ApiKey: string;
  Site: string;
  Monitored: string[];
  CheckAllDevices: boolean;
  MinAccessPoints: number;
  MinClients: number;
  IgnoreTlsErrors: boolean;
  BasePath: string;
  TimeoutMs: number;
}

// Normalise the base path: leading slash, no trailing slash, no query.
export function NormaliseBasePath(Raw: unknown): string {
  let Path = String(Raw == null ? '' : Raw)
    .trim()
    .split('?')[0] as string;
  if (!Path) return DEFAULT_BASE_PATH;
  if (!Path.startsWith('/')) Path = `/${Path}`;
  Path = Path.replace(/\/+$/, '');
  return Path;
}

function ParseConfig(Target: MonitoringTargetLike): UnifiConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Num = (Value: unknown, Fallback: number): number => {
    const N = Number(Value);
    return Number.isFinite(N) ? N : Fallback;
  };
  const RawList = Array.isArray(Cfg.MonitoredDevices)
    ? Cfg.MonitoredDevices
    : typeof Cfg.MonitoredDevices === 'string'
      ? Cfg.MonitoredDevices.split(/[,\n]/)
      : [];
  const Seen = new Set<string>();
  const Monitored: string[] = [];
  for (const Entry of RawList) {
    const Text = String(Entry == null ? '' : Entry).trim();
    if (!Text || Seen.has(Text.toLowerCase())) continue;
    Seen.add(Text.toLowerCase());
    Monitored.push(Text);
  }
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Port: Num(Cfg.Port, DEFAULT_PORT) | 0,
    // An opaque token; only whitespace picked up when pasting is dropped.
    ApiKey: Cfg.ApiKey == null ? '' : String(Cfg.ApiKey).trim(),
    Site: Cfg.Site == null ? '' : String(Cfg.Site).trim(),
    Monitored,
    CheckAllDevices: Cfg.CheckAllDevices == null ? true : !!Cfg.CheckAllDevices,
    MinAccessPoints: Math.max(0, Num(Cfg.MinAccessPoints, 0) | 0),
    MinClients: Math.max(0, Num(Cfg.MinClients, 0) | 0),
    IgnoreTlsErrors: Cfg.IgnoreTlsErrors == null ? true : !!Cfg.IgnoreTlsErrors,
    BasePath: NormaliseBasePath(Cfg.BasePath),
    TimeoutMs: TimeoutOf(Cfg, DEFAULT_TIMEOUT_MS),
  };
}

// --- Parsing -----------------------------------------------------------------

export interface UnifiSite {
  Id: string;
  Name: string;
  InternalReference: string;
}

export interface UnifiDevice {
  Id: string;
  Name: string;
  Model: string;
  Mac: string;
  Ip: string;
  State: string;
  Features: string[];
  Firmware: string;
  FirmwareUpdatable: boolean;
}

const Str = (Value: unknown): string =>
  Value == null || typeof Value === 'object' ? '' : String(Value).trim();

// A page body: { data: [...], totalCount }. Null when it is not one.
export function ParsePage(Json: unknown): { Data: unknown[]; TotalCount: number | null } | null {
  if (!IsObject(Json) || !Array.isArray(Json.data)) return null;
  const Total = Number(Json.totalCount);
  return { Data: Json.data, TotalCount: Number.isFinite(Total) && Total >= 0 ? Total : null };
}

export function ParseSite(Raw: unknown): UnifiSite | null {
  if (!IsObject(Raw)) return null;
  const Id = Str(Raw.id);
  if (!Id) return null;
  return { Id, Name: Str(Raw.name), InternalReference: Str(Raw.internalReference) };
}

export function ParseDevice(Raw: unknown): UnifiDevice | null {
  if (!IsObject(Raw)) return null;
  const Id = Str(Raw.id);
  const Mac = Str(Raw.macAddress);
  if (!Id && !Mac) return null;
  return {
    Id,
    Name: Str(Raw.name),
    Model: Str(Raw.model),
    Mac,
    Ip: Str(Raw.ipAddress),
    State: Str(Raw.state).toUpperCase() || 'UNKNOWN',
    Features: Array.isArray(Raw.features) ? Raw.features.map((F) => Str(F)).filter(Boolean) : [],
    Firmware: Str(Raw.firmwareVersion),
    FirmwareUpdatable: Raw.firmwareUpdatable === true,
  };
}

// Pick the site to read. A configured name matches the site's name, its
// internal reference (the short name older APIs use, "default") or its id,
// without regard to case. Blank: the only site, else the "default" one.
export function SelectSite(
  Sites: UnifiSite[],
  Wanted: string
): { Site: UnifiSite } | { Error: string } {
  if (!Sites.length) return { Error: 'The controller reported no sites' };
  const Key = Wanted.trim().toLowerCase();
  if (Key) {
    const Hit = Sites.find(
      (S) =>
        S.Name.toLowerCase() === Key ||
        S.InternalReference.toLowerCase() === Key ||
        S.Id.toLowerCase() === Key
    );
    if (Hit) return { Site: Hit };
    return { Error: `No site named "${Wanted}". Sites: ${SiteList(Sites)}` };
  }
  if (Sites.length === 1) return { Site: Sites[0] as UnifiSite };
  const Default = Sites.find((S) => S.InternalReference.toLowerCase() === 'default');
  if (Default) return { Site: Default };
  return { Error: `Several sites; name one in the Site setting. Sites: ${SiteList(Sites)}` };
}

function SiteList(Sites: UnifiSite[]): string {
  const Names = Sites.slice(0, 10).map((S) => S.Name || S.InternalReference || S.Id);
  return Names.join(', ') + (Sites.length > 10 ? ', …' : '');
}

// Device states from the OpenAPI enum, in operator wording.
const STATE_LABELS: Record<string, string> = {
  ONLINE: 'Online',
  OFFLINE: 'Offline',
  PENDING_ADOPTION: 'Pending adoption',
  UPDATING: 'Updating',
  GETTING_READY: 'Getting ready',
  ADOPTING: 'Adopting',
  DELETING: 'Deleting',
  CONNECTION_INTERRUPTED: 'Connection interrupted',
  ISOLATED: 'Isolated',
  U5G_INCORRECT_TOPOLOGY: 'Incorrect topology',
};
// States that are a device on its way to (or back to) online rather than down.
const TRANSITIONAL_STATES = new Set(['PENDING_ADOPTION', 'UPDATING', 'GETTING_READY', 'ADOPTING']);

export function StateLabel(State: string): string {
  return STATE_LABELS[State] || State || 'Unknown';
}

// MAC with separators removed, lower case; '' when it is not 12 hex digits.
export function MacKey(Value: string): string {
  const Hex = String(Value || '')
    .replace(/[\s:.-]/g, '')
    .toLowerCase();
  return /^[0-9a-f]{12}$/.test(Hex) ? Hex : '';
}

// The adopted device a Monitored entry names: by MAC first, then by name.
export function FindDevice(Devices: UnifiDevice[], Entry: string): UnifiDevice | null {
  const Mac = MacKey(Entry);
  if (Mac) {
    const ByMac = Devices.find((D) => MacKey(D.Mac) === Mac);
    if (ByMac) return ByMac;
  }
  const Key = Entry.trim().toLowerCase();
  return Devices.find((D) => D.Name.toLowerCase() === Key) || null;
}

// Most devices a result carries for the editor's checklist.
const MAX_SITE_DEVICES = 500;

const FEATURE_LABELS: Array<[string, string]> = [
  ['gateway', 'Gateway'],
  ['switching', 'Switch'],
  ['accessPoint', 'Access point'],
];

// The site's devices as checkboxes for Monitored devices. The value stored is
// the MAC address, which survives a rename; the device's name is an alias so a
// list typed by name before still shows those devices as ticked.
function GetSettingOptions(Result: MonitoringResult): MonitoringSettingOptions {
  const Raw = Result && Array.isArray(Result.SiteDevices) ? (Result.SiteDevices as unknown[]) : [];
  const Items: MonitoringSettingOptions[string] = [];
  for (const Entry of Raw) {
    if (!IsObject(Entry)) continue;
    const Name = Str(Entry.Name);
    const Mac = Str(Entry.Mac);
    const Value = Mac || Name;
    if (!Value) continue;
    const Features = Array.isArray(Entry.Features) ? Entry.Features.map((F) => Str(F)) : [];
    const Kind = FEATURE_LABELS.filter(([Key]) => Features.includes(Key)).map(([, Label]) => Label);
    const State = Str(Entry.State);
    const Detail = [
      Str(Entry.Model),
      Kind.join(', '),
      Mac && Name ? Mac : '',
      State && State !== 'ONLINE' ? StateLabel(State) : '',
    ]
      .filter(Boolean)
      .join(' · ');
    Items.push({
      value: Value,
      label: Name || Mac,
      ...(Detail ? { detail: Detail } : {}),
      ...(Mac && Name ? { aliases: [Name] } : {}),
    });
  }
  Items.sort((A, B) =>
    A.label.localeCompare(B.label, undefined, { numeric: true, sensitivity: 'base' })
  );
  return { MonitoredDevices: Items };
}

function DeviceLabel(D: UnifiDevice): string {
  return D.Name || D.Mac || D.Id;
}

export interface MonitoredStatus {
  Entry: string;
  Found: boolean;
  Name: string;
  State: string;
  Ok: boolean;
}

export interface UnifiCounts {
  Total: number;
  Online: number;
  Offline: number;
  Transitional: number;
  AccessPointsOnline: number;
  AccessPoints: number;
  Switches: number;
  Gateways: number;
}

export function CountDevices(Devices: UnifiDevice[]): UnifiCounts {
  const Counts: UnifiCounts = {
    Total: Devices.length,
    Online: 0,
    Offline: 0,
    Transitional: 0,
    AccessPointsOnline: 0,
    AccessPoints: 0,
    Switches: 0,
    Gateways: 0,
  };
  for (const D of Devices) {
    if (D.State === 'ONLINE') Counts.Online++;
    else if (TRANSITIONAL_STATES.has(D.State)) Counts.Transitional++;
    else Counts.Offline++;
    if (D.Features.includes('accessPoint')) {
      Counts.AccessPoints++;
      if (D.State === 'ONLINE') Counts.AccessPointsOnline++;
    }
    if (D.Features.includes('switching')) Counts.Switches++;
    if (D.Features.includes('gateway')) Counts.Gateways++;
  }
  return Counts;
}

export interface Evaluation {
  Reasons: string[];
  Monitored: MonitoredStatus[];
}

// Every condition that makes the site Degraded. Pure; exported for tests.
export function Evaluate(
  Devices: UnifiDevice[],
  Counts: UnifiCounts,
  ClientCount: number | null,
  Config: Pick<UnifiConfig, 'Monitored' | 'CheckAllDevices' | 'MinAccessPoints' | 'MinClients'>
): Evaluation {
  const Reasons: string[] = [];
  // Devices a Monitored entry already named, so the any-device sweep below does
  // not report them twice.
  const Named = new Set<UnifiDevice>();
  const Monitored: MonitoredStatus[] = Config.Monitored.map((Entry) => {
    const D = FindDevice(Devices, Entry);
    if (!D) return { Entry, Found: false, Name: Entry, State: '', Ok: false };
    Named.add(D);
    return { Entry, Found: true, Name: DeviceLabel(D), State: D.State, Ok: D.State === 'ONLINE' };
  });
  for (const M of Monitored) {
    if (M.Ok) continue;
    if (!M.Found) Reasons.push(`${M.Entry}: not adopted on this site`);
    else Reasons.push(`${M.Name}: ${StateLabel(M.State)}`);
  }

  if (Config.CheckAllDevices) {
    const Down = Devices.filter((D) => D.State !== 'ONLINE' && !Named.has(D));
    const Shown = Down.slice(0, 5).map((D) => `${DeviceLabel(D)}: ${StateLabel(D.State)}`);
    if (Down.length > 5) Shown.push(`${Down.length - 5} more not online`);
    Reasons.push(...Shown);
  }

  if (Config.MinAccessPoints > 0 && Counts.AccessPointsOnline < Config.MinAccessPoints) {
    Reasons.push(
      `${Counts.AccessPointsOnline} access point${Counts.AccessPointsOnline === 1 ? '' : 's'} online (expected at least ${Config.MinAccessPoints})`
    );
  }
  if (Config.MinClients > 0 && ClientCount != null && ClientCount < Config.MinClients) {
    Reasons.push(
      `${ClientCount} client${ClientCount === 1 ? '' : 's'} connected (expected at least ${Config.MinClients})`
    );
  }
  return { Reasons, Monitored };
}

// --- Probe -------------------------------------------------------------------

// The controller's own explanation from an Error Message body, if any.
function ApiErrorText(Res: JsonResponse): string {
  if (!Res.Ok) return Res.Error;
  const Json = Res.Json;
  if (IsObject(Json)) {
    const Message = Str(Json.message);
    const Code = Str(Json.code);
    if (Message && Code) return `${Message} (${Code})`;
    if (Message) return Message;
  }
  return '';
}

function StatusError(Res: JsonResponse, What: string): string {
  if (!Res.Ok) return Res.Error;
  const Detail = ApiErrorText(Res);
  const Suffix = Detail ? `: ${Detail}` : '';
  if (Res.Status === 401 || Res.Status === 403) {
    return `API key refused (HTTP ${Res.Status})${Suffix}`;
  }
  if (Res.Status === 404) {
    return `HTTP 404 for ${What}. The controller does not serve the official Network API at this path${Suffix}`;
  }
  return `HTTP ${Res.Status} for ${What}${Suffix}`;
}

interface Requester {
  Get(Path: string): Promise<JsonResponse>;
}

function MakeRequester(Config: UnifiConfig, Base: URL, DeadlineAt: number): Requester {
  return {
    Get: (Path: string) =>
      RequestJson(WithPath(Base, `${Config.BasePath}${Path}`), {
        Method: 'GET',
        DeadlineAt,
        IgnoreTlsErrors: Config.IgnoreTlsErrors,
        Headers: { 'X-API-KEY': Config.ApiKey },
      }),
  };
}

// Read every page of a list endpoint. Resolves the items or an error string.
async function GetAll(
  Req: Requester,
  Path: string,
  What: string
): Promise<{ Items: unknown[] } | { Error: string }> {
  const Items: unknown[] = [];
  for (let Page = 0; Page < MAX_PAGES; Page++) {
    const Sep = Path.includes('?') ? '&' : '?';
    const Res = await Req.Get(`${Path}${Sep}offset=${Items.length}&limit=${PAGE_LIMIT}`);
    if (!Res.Ok || Res.Status !== 200) return { Error: StatusError(Res, What) };
    const Parsed = ParsePage(Res.Json);
    if (!Parsed) return { Error: `The ${What} reply was not the documented JSON page` };
    Items.push(...Parsed.Data);
    if (!Parsed.Data.length) break;
    if (Parsed.TotalCount != null) {
      if (Items.length >= Parsed.TotalCount) break;
    } else if (Parsed.Data.length < PAGE_LIMIT) {
      break;
    }
  }
  return { Items };
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Success: false, Error: `Invalid port: ${Config.Port}` };
  }
  if (!Config.ApiKey) return { Success: false, Error: 'No API key configured' };
  if (Config.Monitored.length > MAX_MONITORED) {
    return { Success: false, Error: `Too many monitored devices (at most ${MAX_MONITORED})` };
  }
  const Base = BuildBaseUrl(Config.Address, 'https', Config.Port);
  if (!Base) return { Success: false, Error: 'Invalid address' };

  const Started = Date.now();
  const Req = MakeRequester(Config, Base, Started + Config.TimeoutMs);

  // 1) Application info: reachability, the key and the version.
  const Info = await Req.Get('/v1/info');
  if (!Info.Ok || Info.Status !== 200) {
    return { Success: false, Error: StatusError(Info, 'application info') };
  }
  const LatencyMs = Date.now() - Started;
  if (!IsObject(Info.Json) || !Str(Info.Json.applicationVersion)) {
    return {
      Success: false,
      Error: 'Answered, but not with the UniFi Network API application info',
    };
  }
  const Version = Str(Info.Json.applicationVersion);

  // 2) Sites.
  const SitesRes = await GetAll(Req, '/v1/sites', 'site list');
  if ('Error' in SitesRes) return { Success: false, Error: SitesRes.Error, Version };
  const Sites = SitesRes.Items.map(ParseSite).filter((S): S is UnifiSite => !!S);
  const Picked = SelectSite(Sites, Config.Site);
  if ('Error' in Picked) return { Success: false, Error: Picked.Error, Version };
  const Site = Picked.Site;
  const SitePath = `/v1/sites/${encodeURIComponent(Site.Id)}`;

  // 3) Adopted devices.
  const DevicesRes = await GetAll(Req, `${SitePath}/devices`, 'device list');
  if ('Error' in DevicesRes) return { Success: false, Error: DevicesRes.Error, Version };
  const Devices = DevicesRes.Items.map(ParseDevice).filter((D): D is UnifiDevice => !!D);
  const Counts = CountDevices(Devices);

  // 4) Connected clients, only when a minimum is set: totalCount of a 1-item page.
  let ClientCount: number | null = null;
  if (Config.MinClients > 0) {
    const ClientsRes = await Req.Get(`${SitePath}/clients?offset=0&limit=1`);
    if (!ClientsRes.Ok || ClientsRes.Status !== 200) {
      return { Success: false, Error: StatusError(ClientsRes, 'client list'), Version };
    }
    const Page = ParsePage(ClientsRes.Json);
    if (!Page || Page.TotalCount == null) {
      return {
        Success: false,
        Error: 'The client list reply was not the documented JSON page',
        Version,
      };
    }
    ClientCount = Page.TotalCount;
  }

  const Result = Evaluate(Devices, Counts, ClientCount, Config);
  return {
    Success: true,
    ...(Result.Reasons.length ? { Degraded: true, DegradedReason: Result.Reasons.join('; ') } : {}),
    LatencyMs,
    Version,
    SiteName: Site.Name || Site.InternalReference,
    Counts,
    ClientCount,
    Monitored: Result.Monitored,
    // Every adopted device, trimmed to what the editor's device checklist shows
    // (see GetSettingOptions), capped so the stored result stays small.
    SiteDevices: Devices.slice(0, MAX_SITE_DEVICES).map((D) => ({
      Name: D.Name,
      Mac: D.Mac,
      Model: D.Model,
      Features: D.Features,
      State: D.State,
    })),
    // Not-online devices only, capped, so the stored result stays small.
    NotOnline: Devices.filter((D) => D.State !== 'ONLINE')
      .slice(0, 50)
      .map((D) => ({ Name: DeviceLabel(D), Model: D.Model, Ip: D.Ip, State: D.State })),
  };
}

// --- Debug -------------------------------------------------------------------

function StatePill(Result: MonitoringResult): string {
  const Reachable = !!(Result && Result.Success === true);
  if (Reachable && !Result.Degraded) return Pill('success', 'Online');
  if (Reachable) return Pill('warning', 'Degraded');
  return Pill('danger', 'Offline');
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseConfig(Target);
  const Reachable = !!(Result && Result.Success === true);
  // The API key is a credential and is never shown.
  const Head = Rows([
    TextRow('Controller', `${Config.Address || '-'}:${Config.Port}${Config.BasePath}`),
    Row('Status', StatePill(Result)),
    Result && Result.Version ? TextRow('Network version', String(Result.Version)) : null,
    Reachable && Result.SiteName ? TextRow('Site', String(Result.SiteName)) : null,
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'No reply'),
    Reachable && Result.DegradedReason ? TextRow('Reason', String(Result.DegradedReason)) : null,
  ]);
  if (!Reachable) {
    return (
      Head + '<div class="mt-2">' + Note('Failed to read the site from UniFi Network.') + '</div>'
    );
  }

  const C = (IsObject(Result.Counts) ? Result.Counts : {}) as Partial<UnifiCounts>;
  const N = (V: unknown) => (Number.isFinite(Number(V)) ? String(Number(V)) : '-');
  const CountRows = Rows([
    TextRow('Devices online', `${N(C.Online)} of ${N(C.Total)}`),
    Number(C.Transitional) > 0 ? TextRow('Updating or adopting', N(C.Transitional)) : null,
    Number(C.Offline) > 0 ? TextRow('Not online', N(C.Offline)) : null,
    TextRow('Access points online', `${N(C.AccessPointsOnline)} of ${N(C.AccessPoints)}`),
    TextRow('Switches', N(C.Switches)),
    TextRow('Gateways', N(C.Gateways)),
    Result.ClientCount != null ? TextRow('Connected clients', N(Result.ClientCount)) : null,
  ]);

  const Monitored = Array.isArray(Result.Monitored) ? (Result.Monitored as MonitoredStatus[]) : [];
  const MonitoredHtml = Monitored.map((M) =>
    Card({
      Title: M.Name || M.Entry,
      Badge: !M.Found
        ? Pill('danger', 'Not found')
        : Pill(M.Ok ? 'success' : 'danger', StateLabel(M.State)),
      Highlight: M.Ok,
      BodyHtml:
        M.Name !== M.Entry
          ? `<div class="text-muted small text-break">Monitored as ${Esc(M.Entry)}</div>`
          : '',
    })
  ).join('');

  const NotOnline = Array.isArray(Result.NotOnline)
    ? (Result.NotOnline as Array<{ Name: string; Model: string; Ip: string; State: string }>)
    : [];
  const NotOnlineHtml = NotOnline.map((D) =>
    Card({
      Title: D.Name,
      Badge: Pill(TRANSITIONAL_STATES.has(D.State) ? 'warning' : 'danger', StateLabel(D.State)),
      BodyHtml:
        D.Model || D.Ip
          ? `<div class="text-muted small text-break">${Esc([D.Model, D.Ip].filter(Boolean).join(' · '))}</div>`
          : '',
    })
  ).join('');

  return (
    Head +
    `<div class="mt-2">${CountRows}</div>` +
    (MonitoredHtml
      ? '<div class="mt-2 text-muted small">Monitored devices</div>' +
        `<div class="mt-1 d-grid gap-1">${MonitoredHtml}</div>`
      : '') +
    (NotOnlineHtml
      ? '<div class="mt-2 text-muted small">Devices not online</div>' +
        `<div class="mt-1 d-grid gap-1">${NotOnlineHtml}</div>`
      : '')
  );
}

export const Name = 'UniFi Network';
export const Description =
  'Reads a UniFi Network site over the official Network API with an API key: controller version, adopted switches, access points and gateways, and connected clients. Offline when the controller does not answer or refuses the key; Degraded when a Monitored device is not online, any device is down, or access points or clients fall below a minimum.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseConfig,
  NormaliseBasePath,
  ParsePage,
  ParseSite,
  ParseDevice,
  SelectSite,
  MacKey,
  FindDevice,
  CountDevices,
  Evaluate,
  StateLabel,
};
export { ID, Settings, Run, Debug, GetSettingOptions };
