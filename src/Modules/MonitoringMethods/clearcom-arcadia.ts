// Clear-Com Arcadia Central Station / FreeSpeak Edge base station check.
//
// Both run Clear-Com's CCM software, which serves a JSON REST API (the station
// also serves its own OpenAPI schema at /api/1/schemas/clearcom_api.json).
// Clear-Com publishes no third-party specification for it; the login flow,
// resources and fields below are the ones Bitfocus Companion's
// companion-module-clearcom-rest uses against real stations (src/main.ts,
// src/network.ts, src/types.ts):
//
//   POST /auth/local/login  { logemail: 'admin', logpassword }  -> { jwt }
//        every later request sends `Authorization: Bearer <jwt>`; a 401 means
//        the token lapsed and a fresh login is needed
//   GET  /api/1/devices/1           -> { device_label, deviceType_name,
//                                        versionSW | device_versionSW, uptime }
//   GET  /api/1/devices/endpoints   -> [{ id, label, type, isGateway,
//                                        liveStatus: { status: 'online' | ...,
//                                          batteryLevel, rssi, linkQuality,
//                                          longevity, association: { dpId } } }]
//        isGateway marks transceivers; everything else is a beltpack, wired
//        pack or panel. association.dpId is the role (roleset) in use.
//   GET  /api/2/rolesets            -> [{ id, name }]
//
// The login token is cached per station and password, so a healthy check logs
// in once rather than every interval; an entry unused for
// MONITORING_INTEREST_TTL_MS is dropped. Read-only: one login when needed and
// three GETs, never a write.
import crypto from 'crypto';
import {
  BeltpackConditionSettings,
  BeltpackResult,
  ClearComDebug,
  NormaliseEndpoints,
  ParseBeltpackOptions,
  RoleMap,
} from './_clearcom-shared';
import {
  BuildBaseUrl,
  NumOrNull,
  RequestJson,
  StrOrNull,
  TimeoutOf,
  WithPath,
} from './_videoproc-http-shared';
import { IsRecord } from '@showtrak/protocol/common';
import type { JsonResponse } from './_videoproc-http-shared';
import { DEFAULT_MONITORING_INTERVAL_MS, MONITORING_INTEREST_TTL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'clearcom-arcadia';

const DEFAULT_TIMEOUT_MS = 6000;
// CCM's only account is the admin account; the login takes it as `logemail`.
const USERNAME = 'admin';

const Settings: MonitoringSettingField[] = [
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
    Note: '0 uses the protocol’s standard port (80 or 443).',
  },
  {
    Key: 'Password',
    Label: 'Admin password',
    Type: 'string',
    Default: '',
    Required: true,
    Sensitive: true,
    Note: 'The password you sign in to the station’s web page (CCM) with. The username is always admin.',
  },
  ...BeltpackConditionSettings(),
  {
    Key: 'IgnoreTlsErrors',
    Label: 'Ignore TLS Errors',
    Type: 'boolean',
    Default: true,
    Advanced: true,
    VisibleWhen: { Key: 'Protocol', Equals: 'https' },
    Note: 'On by default so the station’s self-signed certificate is not treated as an outage.',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: DEFAULT_TIMEOUT_MS,
    Min: 500,
    Max: 30000,
    Advanced: true,
    Note: 'Budget for the whole probe: signing in and every request.',
  },
];

interface ArcadiaConfig {
  Address: string;
  Protocol: 'http' | 'https';
  Port: number;
  Password: string;
  IgnoreTlsErrors: boolean;
  TimeoutMs: number;
}

function ParseConfig(Target: MonitoringTargetLike): ArcadiaConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number(Cfg.Port);
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Protocol: String(Cfg.Protocol || 'http').toLowerCase() === 'https' ? 'https' : 'http',
    Port: Number.isFinite(Port) && Port > 0 ? Math.trunc(Port) : 0,
    // Deliberately not trimmed; trailing whitespace can be part of a password.
    Password: Cfg.Password == null ? '' : String(Cfg.Password),
    IgnoreTlsErrors: Cfg.IgnoreTlsErrors == null ? true : !!Cfg.IgnoreTlsErrors,
    TimeoutMs: TimeoutOf(Cfg, DEFAULT_TIMEOUT_MS),
  };
}

// --- Token cache -------------------------------------------------------------

interface CachedToken {
  Token: string;
  LastUsedAt: number;
}

const Tokens = new Map<string, CachedToken>();

// Keyed by station URL and a hash of the password, so changing the password
// in the editor never reuses a token issued for the old one.
function TokenKey(Base: URL, Password: string): string {
  const Hash = crypto.createHash('sha256').update(Password).digest('hex').slice(0, 16);
  return `${Base.origin}|${Hash}`;
}

function PruneTokens(Now: number): void {
  for (const [Key, Entry] of Tokens) {
    if (Now - Entry.LastUsedAt > MONITORING_INTEREST_TTL_MS) Tokens.delete(Key);
  }
}

type LoginOutcome = { Ok: true; Token: string } | { Ok: false; Result: MonitoringResult };

async function Login(Base: URL, Config: ArcadiaConfig, DeadlineAt: number): Promise<LoginOutcome> {
  const Reply = await RequestJson(WithPath(Base, '/auth/local/login'), {
    Method: 'POST',
    Json: { logemail: USERNAME, logpassword: Config.Password },
    DeadlineAt,
    IgnoreTlsErrors: Config.IgnoreTlsErrors,
  });
  if (!Reply.Ok) return { Ok: false, Result: { Success: false, Error: Reply.Error } };
  if (Reply.Status === 401 || Reply.Status === 403) {
    return {
      Ok: false,
      Result: {
        Success: false,
        Degraded: true,
        Error: 'The station refused the admin password',
        Status: Reply.Status,
      },
    };
  }
  const Token = IsRecord(Reply.Json) ? StrOrNull(Reply.Json.jwt) : null;
  if (Reply.Status < 200 || Reply.Status > 299 || !Token) {
    return {
      Ok: false,
      Result: {
        Success: false,
        Degraded: true,
        Error:
          Reply.Status >= 200 && Reply.Status <= 299
            ? 'Failed to sign in: the reply carried no token. Is this an Arcadia or FreeSpeak Edge base?'
            : `Failed to sign in (HTTP ${Reply.Status})`,
        Status: Reply.Status,
      },
    };
  }
  return { Ok: true, Token };
}

// --- Run --------------------------------------------------------------------

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (!Config.Password) return { Success: false, Error: 'No admin password configured' };
  const Base = BuildBaseUrl(Config.Address, Config.Protocol, Config.Port);
  if (!Base) return { Success: false, Error: 'Invalid address' };

  const Now = Date.now();
  PruneTokens(Now);
  const DeadlineAt = Now + Config.TimeoutMs;
  const Key = TokenKey(Base, Config.Password);

  let Token = Tokens.get(Key)?.Token ?? null;
  let FreshLogin = false;
  const SignIn = async (): Promise<MonitoringResult | null> => {
    const Outcome = await Login(Base, Config, DeadlineAt);
    if (!Outcome.Ok) {
      Tokens.delete(Key);
      return Outcome.Result;
    }
    Token = Outcome.Token;
    FreshLogin = true;
    Tokens.set(Key, { Token, LastUsedAt: Date.now() });
    return null;
  };
  if (!Token) {
    const Failed = await SignIn();
    if (Failed) return Failed;
  }

  const Get = (Path: string): Promise<JsonResponse> =>
    RequestJson(WithPath(Base, Path), {
      Method: 'GET',
      DeadlineAt,
      IgnoreTlsErrors: Config.IgnoreTlsErrors,
      Headers: { Authorization: `Bearer ${Token}` },
    });

  // Device info first: the liveness signal and the reply time. A 401 on a
  // cached token means it lapsed: sign in once more and retry.
  let Started = Date.now();
  let Device = await Get('/api/1/devices/1');
  if (Device.Ok && Device.Status === 401 && !FreshLogin) {
    const Failed = await SignIn();
    if (Failed) return Failed;
    Started = Date.now();
    Device = await Get('/api/1/devices/1');
  }
  if (!Device.Ok) return { Success: false, Error: Device.Error };
  const LatencyMs = Date.now() - Started;
  if (Device.Status === 401 || Device.Status === 403) {
    Tokens.delete(Key);
    return {
      Success: false,
      Degraded: true,
      Error: 'The station refused the sign-in token',
      Status: Device.Status,
    };
  }
  if (Device.Status < 200 || Device.Status > 299 || !IsRecord(Device.Json)) {
    return {
      Success: false,
      Degraded: true,
      Error:
        Device.Status >= 200 && Device.Status <= 299
          ? 'The reply was not Clear-Com device JSON'
          : `The station answered HTTP ${Device.Status} for its device info`,
      Status: Device.Status,
    };
  }
  const Entry = Tokens.get(Key);
  if (Entry) Entry.LastUsedAt = Date.now();

  const Info = Device.Json;
  const Out: MonitoringResult = {
    Success: true,
    LatencyMs,
    Label: StrOrNull(Info.device_label),
    Model: StrOrNull(Info.deviceType_name),
    Firmware: StrOrNull(Info.versionSW) ?? StrOrNull(Info.device_versionSW),
    Uptime: NumOrNull(Info.uptime),
  };

  const [Endpoints, Rolesets] = await Promise.all([
    Get('/api/1/devices/endpoints'),
    Get('/api/2/rolesets'),
  ]);
  if (
    !Endpoints.Ok ||
    Endpoints.Status < 200 ||
    Endpoints.Status > 299 ||
    !Array.isArray(Endpoints.Json)
  ) {
    return {
      ...Out,
      Degraded: true,
      DegradedReason: 'The station answered, but its endpoint list could not be read',
    };
  }
  // A failed roles read only costs role names; packs still match by label or id.
  const RoleById = RoleMap(
    Rolesets.Ok && Rolesets.Status >= 200 && Rolesets.Status <= 299 ? Rolesets.Json : []
  );
  const List = NormaliseEndpoints(Endpoints.Json, {
    IsTransceiver: (Record) => Record.isGateway === true,
    RoleId: (_Record, Live) =>
      IsRecord(Live.association) ? NumOrNull(Live.association.dpId) : null,
    Roles: RoleById,
  });
  return { ...Out, ...BeltpackResult(List, RoleById, ParseBeltpackOptions(Target)) };
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseConfig(Target);
  const Port = Config.Port || (Config.Protocol === 'https' ? 443 : 80);
  return ClearComDebug(Result, {
    Host: `${Config.Protocol.toUpperCase()} ${Config.Address || '-'}:${Port}`,
    DeviceLabel: 'Station',
    OfflineText: 'Failed to reach the station',
  });
}

export const Name = 'Clear-Com Arcadia / FreeSpeak Edge';
export const Description =
  'Reads a Clear-Com Arcadia Central Station or FreeSpeak Edge base over its CCM REST API: station model and firmware, and every beltpack’s online state, role, battery and link quality. It reports Degraded when a listed beltpack or role is not online, or a beltpack’s battery is low. Read-only.';
export const Group = 'Sound';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseConfig,
  TokenKey,
  Tokens,
  ResetTokens: () => Tokens.clear(),
};
export { ID, Settings, Run, Debug };
