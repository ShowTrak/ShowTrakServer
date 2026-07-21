// SNMP UPS health check (v3) — reads the standard UPS-MIB (RFC 1628) over
// user-authenticated SNMPv3, with optional message authentication (auth) and
// encryption (priv). Use this for UPS cards configured for SNMPv3 with a
// username + auth/priv passwords (e.g. a Riello NetMan 208 / Eaton NMC set to
// v3); for cards still using a community string, use the sibling snmp-ups method.
//
// The UPS-MIB read set, health evaluation and debug rendering are shared with
// snmp-ups via ./_snmp-ups-shared; this file only builds the v3 session (the
// USM user + security level) and its editor Settings.
//
// Security levels (RFC 3414):
//   - noAuthNoPriv : username only, no signing or encryption
//   - authNoPriv   : messages signed with the auth password
//   - authPriv     : messages signed AND encrypted (recommended)
import snmp, {
  type User,
  type AuthProtocols,
  type PrivProtocols,
  type SecurityLevel,
} from 'net-snmp';
import {
  DEFAULT_PORT,
  HEALTH_DEFAULTS,
  RunUpsHealth,
  ParseThresholds,
  UpsDebug,
  IdentityRow,
  EvaluateHealth,
  type SnmpSession,
} from './_snmp-ups-shared';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'snmp-ups-v3';

// Editor value -> net-snmp AuthProtocol. 'none' means no message authentication
// (which, per SNMPv3, also forces no privacy) — i.e. the noAuthNoPriv level.
const AUTH_PROTOCOLS: Record<string, AuthProtocols> = {
  none: snmp.AuthProtocols.none,
  sha: snmp.AuthProtocols.sha,
  sha256: snmp.AuthProtocols.sha256,
  sha512: snmp.AuthProtocols.sha512,
  sha224: snmp.AuthProtocols.sha224,
  sha384: snmp.AuthProtocols.sha384,
  md5: snmp.AuthProtocols.md5,
};

// Editor value -> net-snmp PrivProtocol. 'none' means no encryption.
const PRIV_PROTOCOLS: Record<string, PrivProtocols> = {
  none: snmp.PrivProtocols.none,
  aes: snmp.PrivProtocols.aes,
  aes256b: snmp.PrivProtocols.aes256b,
  aes256r: snmp.PrivProtocols.aes256r,
  des: snmp.PrivProtocols.des,
};

// The effective SNMPv3 security level is derived from the protocol choices
// (matching how UPS cards present it): no auth -> noAuthNoPriv; auth but no priv
// -> authNoPriv; both -> authPriv. Privacy without authentication is not valid
// SNMPv3, so priv is only honoured when auth is enabled.
function AuthEnabled(AuthProtocol: string): boolean {
  return AuthProtocol !== 'none';
}
function PrivEnabled(AuthProtocol: string, PrivProtocol: string): boolean {
  return AuthEnabled(AuthProtocol) && PrivProtocol !== 'none';
}
function EffectiveLevel(AuthProtocol: string, PrivProtocol: string): SecurityLevel {
  if (PrivEnabled(AuthProtocol, PrivProtocol)) return snmp.SecurityLevel.authPriv;
  if (AuthEnabled(AuthProtocol)) return snmp.SecurityLevel.authNoPriv;
  return snmp.SecurityLevel.noAuthNoPriv;
}
function LevelLabel(AuthProtocol: string, PrivProtocol: string): string {
  if (PrivEnabled(AuthProtocol, PrivProtocol)) return 'authPriv';
  if (AuthEnabled(AuthProtocol)) return 'authNoPriv';
  return 'noAuthNoPriv';
}

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'Port',
    Type: 'number',
    Default: DEFAULT_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
  },
  { Key: 'Username', Label: 'Username', Type: 'string', Default: '', Required: true },
  {
    Key: 'AuthProtocol',
    Label: 'Auth protocol',
    Type: 'select',
    Default: 'sha',
    Options: [
      { value: 'none', label: 'None (noAuthNoPriv)' },
      { value: 'sha', label: 'SHA-1' },
      { value: 'sha256', label: 'SHA-256' },
      { value: 'sha512', label: 'SHA-512' },
      { value: 'sha224', label: 'SHA-224' },
      { value: 'sha384', label: 'SHA-384' },
      { value: 'md5', label: 'MD5' },
    ],
  },
  { Key: 'AuthPassword', Label: 'Auth password', Type: 'string', Default: '' },
  {
    Key: 'PrivProtocol',
    Label: 'Priv protocol',
    Type: 'select',
    Default: 'aes',
    Options: [
      { value: 'none', label: 'None' },
      { value: 'aes', label: 'AES-128' },
      { value: 'aes256b', label: 'AES-256 (Blumenthal)' },
      { value: 'aes256r', label: 'AES-256 (Reeder)' },
      { value: 'des', label: 'DES' },
    ],
  },
  { Key: 'PrivPassword', Label: 'Priv password', Type: 'string', Default: '' },
  {
    Key: 'Context',
    Label: 'Context name',
    Type: 'string',
    Default: '',
    Advanced: true,
  },
  {
    Key: 'OutputIndex',
    Label: 'Output/input line index',
    Type: 'number',
    Default: 1,
    Min: 1,
    Max: 64,
    Advanced: true,
  },
  {
    Key: 'CheckCharge',
    Label: 'Check battery charge',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded when the card reports a charge below the minimum.',
  },
  {
    Key: 'MinCharge',
    Label: 'Minimum charge (%)',
    Type: 'number',
    Default: HEALTH_DEFAULTS.MinCharge,
    Min: 0,
    Max: 100,
    VisibleWhen: { Key: 'CheckCharge', Equals: true },
  },
  {
    Key: 'CheckLoad',
    Label: 'Check load',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded when output load exceeds the maximum percentage of rated capacity.',
  },
  {
    Key: 'MaxLoad',
    Label: 'Maximum load (%)',
    Type: 'number',
    Default: HEALTH_DEFAULTS.MaxLoad,
    Min: 1,
    Max: 100,
    VisibleWhen: { Key: 'CheckLoad', Equals: true },
  },
  {
    Key: 'CheckTemperature',
    Label: 'Check battery temperature',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to threshold battery temperature; skipped when the card does not report one.',
  },
  {
    Key: 'MaxTemperature',
    Label: 'Maximum battery temperature (°C)',
    Type: 'number',
    Default: HEALTH_DEFAULTS.MaxTemperature,
    Min: 0,
    Max: 100,
    VisibleWhen: { Key: 'CheckTemperature', Equals: true },
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: 4000,
    Min: 500,
    Max: 30000,
    Advanced: true,
  },
  {
    Key: 'Retries',
    Label: 'Retries',
    Type: 'number',
    Default: 1,
    Min: 0,
    Max: 5,
    Advanced: true,
  },
];

interface V3Config {
  Address: string;
  Port: number;
  Username: string;
  // Selected protocols ('none' when disabled). The effective security level is
  // derived from these — no separate level field.
  AuthProtocol: string;
  AuthPassword: string;
  PrivProtocol: string;
  PrivPassword: string;
  Context: string;
  OutputIndex: number;
  TimeoutMs: number;
  Retries: number;
}

function ParseConfig(Target: MonitoringTargetLike): V3Config {
  const Cfg = (Target && Target.Settings) || {};
  const Num = (Value: unknown, Fallback: number): number => {
    const N = Number(Value);
    return Number.isFinite(N) ? N : Fallback;
  };
  const Str = (Value: unknown): string => (Value == null ? '' : String(Value));
  const AuthProtocol = AUTH_PROTOCOLS[Str(Cfg.AuthProtocol)] ? Str(Cfg.AuthProtocol) : 'sha';
  // Privacy is meaningless without authentication, so force it off when auth is
  // off — this keeps the derived level and the USM user self-consistent.
  const PrivProtocol = !AuthEnabled(AuthProtocol)
    ? 'none'
    : PRIV_PROTOCOLS[Str(Cfg.PrivProtocol)]
      ? Str(Cfg.PrivProtocol)
      : 'aes';
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Port: Num(Cfg.Port, DEFAULT_PORT) | 0,
    Username: Str(Cfg.Username).trim(),
    AuthProtocol,
    AuthPassword: Str(Cfg.AuthPassword),
    PrivProtocol,
    PrivPassword: Str(Cfg.PrivPassword),
    Context: Str(Cfg.Context),
    OutputIndex: Math.max(1, Num(Cfg.OutputIndex, 1) | 0),
    TimeoutMs: Num(Cfg.Timeout, 4000),
    Retries: Math.max(0, Num(Cfg.Retries, 1) | 0),
  };
}

// Build the net-snmp USM user object for the effective security level. Only the
// fields the level requires are included, matching net-snmp's expectations.
function BuildUser(Config: V3Config): User {
  const Usm: User = {
    name: Config.Username,
    level: EffectiveLevel(Config.AuthProtocol, Config.PrivProtocol),
  };
  if (AuthEnabled(Config.AuthProtocol)) {
    Usm.authProtocol = AUTH_PROTOCOLS[Config.AuthProtocol];
    Usm.authKey = Config.AuthPassword;
  }
  if (PrivEnabled(Config.AuthProtocol, Config.PrivProtocol)) {
    Usm.privProtocol = PRIV_PROTOCOLS[Config.PrivProtocol];
    Usm.privKey = Config.PrivPassword;
  }
  return Usm;
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Success: false, Error: `Invalid port: ${Config.Port}` };
  }
  if (!Config.Username) return { Success: false, Error: 'No SNMPv3 username configured' };
  if (AuthEnabled(Config.AuthProtocol) && !Config.AuthPassword) {
    return { Success: false, Error: 'Auth password required when an auth protocol is set' };
  }
  if (PrivEnabled(Config.AuthProtocol, Config.PrivProtocol) && !Config.PrivPassword) {
    return { Success: false, Error: 'Priv password required when a priv protocol is set' };
  }

  const Options: Record<string, unknown> = {
    port: Config.Port,
    version: snmp.Version3,
    timeout: Math.max(500, Config.TimeoutMs),
    retries: Config.Retries,
  };
  if (Config.Context) Options.context = Config.Context;

  const CreateSession = (): SnmpSession =>
    snmp.createV3Session(Config.Address, BuildUser(Config), Options);

  return RunUpsHealth(
    CreateSession,
    Config.OutputIndex,
    ParseThresholds((Target && Target.Settings) || {})
  );
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseConfig(Target);
  const Level = LevelLabel(Config.AuthProtocol, Config.PrivProtocol);
  const Identity = PrivEnabled(Config.AuthProtocol, Config.PrivProtocol)
    ? `${Config.Username} · ${Level} (${Config.AuthProtocol}/${Config.PrivProtocol})`
    : AuthEnabled(Config.AuthProtocol)
      ? `${Config.Username} · ${Level} (${Config.AuthProtocol})`
      : `${Config.Username} · ${Level}`;
  return UpsDebug(Result, Config.Address, Config.Port, [IdentityRow('SNMPv3', Identity)]);
}

export const Name = 'UPS Health (SNMP v3)';
export const Description =
  'Reads status, battery charge, load, temperature, input voltage and active alarms from a UPS network card over authenticated/encrypted SNMPv3 (username + auth/priv), using the standard UPS-MIB (RFC 1628). For cards still on a community string, use UPS Health (SNMP v1/v2c) instead.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = { ParseConfig, BuildUser, EvaluateHealth };
export { ID, Settings, Run, Debug };
