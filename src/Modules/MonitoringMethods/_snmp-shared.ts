// Shared SNMP plumbing.
//
// SNMPv3 (User-based Security Model, RFC 3414) credential handling for every
// method that can talk SNMPv3: snmp-ups-v3, snmp-oid, igmp-querier and
// opengear-frame. The editor fields, the protocol tables, the derived security
// level and the net-snmp USM user all live here so the methods cannot drift
// apart on what "authPriv with SHA-256 / AES-128" means.
//
// The connection itself for the methods that speak every version (snmp-oid,
// igmp-querier, opengear-frame): the version/community/v3 editor fields, the
// timeout budget fields, the parsed connection, its validation and the session
// factory.
import snmp, {
  type User,
  type AuthProtocols,
  type PrivProtocols,
  type SecurityLevel,
} from 'net-snmp';
import type { SnmpSession } from './_snmp-ups-shared';
import type { MonitoringSettingField, MonitoringSettingVisibleWhen } from './types';

// Editor value -> net-snmp AuthProtocol. 'none' means no message authentication
// (which, per SNMPv3, also forces no privacy), i.e. the noAuthNoPriv level.
export const AUTH_PROTOCOLS: Record<string, AuthProtocols> = {
  none: snmp.AuthProtocols.none,
  sha: snmp.AuthProtocols.sha,
  sha256: snmp.AuthProtocols.sha256,
  sha512: snmp.AuthProtocols.sha512,
  sha224: snmp.AuthProtocols.sha224,
  sha384: snmp.AuthProtocols.sha384,
  md5: snmp.AuthProtocols.md5,
};

// Editor value -> net-snmp PrivProtocol. 'none' means no encryption.
export const PRIV_PROTOCOLS: Record<string, PrivProtocols> = {
  none: snmp.PrivProtocols.none,
  aes: snmp.PrivProtocols.aes,
  aes256b: snmp.PrivProtocols.aes256b,
  aes256r: snmp.PrivProtocols.aes256r,
  des: snmp.PrivProtocols.des,
};

// The effective SNMPv3 security level is derived from the protocol choices
// (matching how devices present it): no auth -> noAuthNoPriv; auth but no priv
// -> authNoPriv; both -> authPriv. Privacy without authentication is not valid
// SNMPv3, so priv is only honoured when auth is enabled.
export function AuthEnabled(AuthProtocol: string): boolean {
  return AuthProtocol !== 'none';
}
export function PrivEnabled(AuthProtocol: string, PrivProtocol: string): boolean {
  return AuthEnabled(AuthProtocol) && PrivProtocol !== 'none';
}
export function EffectiveLevel(AuthProtocol: string, PrivProtocol: string): SecurityLevel {
  if (PrivEnabled(AuthProtocol, PrivProtocol)) return snmp.SecurityLevel.authPriv;
  if (AuthEnabled(AuthProtocol)) return snmp.SecurityLevel.authNoPriv;
  return snmp.SecurityLevel.noAuthNoPriv;
}
export function LevelLabel(AuthProtocol: string, PrivProtocol: string): string {
  if (PrivEnabled(AuthProtocol, PrivProtocol)) return 'authPriv';
  if (AuthEnabled(AuthProtocol)) return 'authNoPriv';
  return 'noAuthNoPriv';
}

// The editor fields for an SNMPv3 user: username, auth/priv protocols and
// passwords, and the (Advanced) context name. `When` gates every field behind a
// sibling setting; snmp-oid shows them only while its version select is v3.
export function V3CredentialFields(When?: MonitoringSettingVisibleWhen): MonitoringSettingField[] {
  const Gate = (Field: MonitoringSettingField): MonitoringSettingField =>
    When ? { ...Field, VisibleWhen: When } : Field;
  return [
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
    { Key: 'AuthPassword', Label: 'Auth password', Type: 'string', Default: '', Sensitive: true },
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
    { Key: 'PrivPassword', Label: 'Priv password', Type: 'string', Default: '', Sensitive: true },
    {
      Key: 'Context',
      Label: 'Context name',
      Type: 'string',
      Default: '',
      Advanced: true,
    },
  ].map(Gate);
}

export interface V3Credentials {
  Username: string;
  // Selected protocols ('none' when disabled). The effective security level is
  // derived from these, no separate level field.
  AuthProtocol: string;
  AuthPassword: string;
  PrivProtocol: string;
  PrivPassword: string;
  Context: string;
}

// Pull the v3 credentials off a settings object, defaulting unknown protocols.
export function ParseV3Credentials(Cfg: Record<string, unknown>): V3Credentials {
  const Str = (Value: unknown): string => (Value == null ? '' : String(Value));
  const AuthProtocol = AUTH_PROTOCOLS[Str(Cfg.AuthProtocol)] ? Str(Cfg.AuthProtocol) : 'sha';
  // Privacy is meaningless without authentication, so force it off when auth is
  // off; this keeps the derived level and the USM user self-consistent.
  const PrivProtocol = !AuthEnabled(AuthProtocol)
    ? 'none'
    : PRIV_PROTOCOLS[Str(Cfg.PrivProtocol)]
      ? Str(Cfg.PrivProtocol)
      : 'aes';
  return {
    Username: Str(Cfg.Username).trim(),
    AuthProtocol,
    AuthPassword: Str(Cfg.AuthPassword),
    PrivProtocol,
    PrivPassword: Str(Cfg.PrivPassword),
    Context: Str(Cfg.Context),
  };
}

// The reason a set of v3 credentials cannot be used, or null when complete.
export function ValidateV3Credentials(Config: V3Credentials): string | null {
  if (!Config.Username) return 'No SNMPv3 username configured';
  if (AuthEnabled(Config.AuthProtocol) && !Config.AuthPassword) {
    return 'Auth password required when an auth protocol is set';
  }
  if (PrivEnabled(Config.AuthProtocol, Config.PrivProtocol) && !Config.PrivPassword) {
    return 'Priv password required when a priv protocol is set';
  }
  return null;
}

// Build the net-snmp USM user object for the effective security level. Only the
// fields the level requires are included, matching net-snmp's expectations.
export function BuildUser(Config: V3Credentials): User {
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

// "user · authPriv (sha/aes)" for the debug panel. Never includes a password.
export function V3IdentityLabel(Config: V3Credentials): string {
  const Level = LevelLabel(Config.AuthProtocol, Config.PrivProtocol);
  if (PrivEnabled(Config.AuthProtocol, Config.PrivProtocol)) {
    return `${Config.Username} · ${Level} (${Config.AuthProtocol}/${Config.PrivProtocol})`;
  }
  if (AuthEnabled(Config.AuthProtocol)) {
    return `${Config.Username} · ${Level} (${Config.AuthProtocol})`;
  }
  return `${Config.Username} · ${Level}`;
}

// --- Connection (methods that speak v1, v2c and v3) ----------------------------

export type SnmpVersion = '1' | '2c' | '3';

// The version select, the community string (v1/v2c) and the v3 user (v3), each
// shown only for the versions that use it.
export const SNMP_VERSION_FIELDS: MonitoringSettingField[] = [
  {
    Key: 'Version',
    Label: 'SNMP version',
    Type: 'select',
    Default: '2c',
    Options: [
      { value: '2c', label: 'v2c' },
      { value: '1', label: 'v1' },
      { value: '3', label: 'v3' },
    ],
  },
  {
    Key: 'Community',
    Sensitive: true,
    Label: 'Community string',
    Type: 'string',
    Default: 'public',
    Required: true,
    VisibleWhen: { Key: 'Version', In: ['1', '2c'] },
  },
  ...V3CredentialFields({ Key: 'Version', Equals: '3' }),
];

// The Timeout (one budget for the whole check) and Retries fields.
export function SnmpBudgetFields(DefaultTimeoutMs: number): MonitoringSettingField[] {
  return [
    {
      Key: 'Timeout',
      Label: 'Timeout (ms)',
      Type: 'number',
      Default: DefaultTimeoutMs,
      Min: 500,
      Max: 30000,
      Advanced: true,
      Note: 'Budget for the whole check, retries included.',
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
}

export interface SnmpConnection extends V3Credentials {
  Address: string;
  Port: number;
  Version: SnmpVersion;
  Community: string;
  TimeoutMs: number;
  Retries: number;
}

// The version and its credentials off a settings object: an unknown version
// reads as v2c, an empty community as "public".
export function ParseSnmpCredentials(
  Cfg: Record<string, unknown>
): Pick<SnmpConnection, 'Version' | 'Community'> & V3Credentials {
  const Version = String(Cfg.Version);
  return {
    Version: Version === '1' || Version === '3' ? Version : '2c',
    Community: Cfg.Community == null || Cfg.Community === '' ? 'public' : String(Cfg.Community),
    ...ParseV3Credentials(Cfg),
  };
}

// Why the connection cannot be attempted, or null when it can.
export function SnmpConnectionError(Config: SnmpConnection): string | null {
  if (!Config.Address) return 'No address configured';
  if (Config.Port < 1 || Config.Port > 65535) return `Invalid port: ${Config.Port}`;
  if (Config.Version === '3') return ValidateV3Credentials(Config);
  return null;
}

// A factory for sessions to the configured agent. Retries share the budget:
// each attempt gets an equal slice of it.
export function CreateSnmpSessionFactory(
  Config: SnmpConnection,
  BudgetMs: number = Config.TimeoutMs
): () => SnmpSession {
  const Options: Record<string, unknown> = {
    port: Config.Port,
    timeout: Math.max(100, Math.floor(BudgetMs / (Config.Retries + 1))),
    retries: Config.Retries,
  };
  if (Config.Version === '3') {
    Options.version = snmp.Version3;
    if (Config.Context) Options.context = Config.Context;
    return () => snmp.createV3Session(Config.Address, BuildUser(Config), Options);
  }
  Options.version = Config.Version === '1' ? snmp.Version1 : snmp.Version2c;
  return () => snmp.createSession(Config.Address, Config.Community, Options);
}

// "v2c", or "v3 · user · authPriv (sha/aes)" for the debug panel. The community
// string is a credential, so only the version is shown for v1/v2c.
export function SnmpIdentityLabel(Config: SnmpConnection): string {
  return Config.Version === '3' ? `v3 · ${V3IdentityLabel(Config)}` : `v${Config.Version}`;
}

// The PDU error-status of an agent's error reply (net-snmp's RequestFailedError):
// the agent DID answer. Null for a transport failure (timeout, unreachable).
export function SnmpErrorStatusOf(Err: unknown): number | null {
  if (!Err || typeof Err !== 'object') return null;
  const E = Err as { name?: unknown; status?: unknown };
  if (E.name === 'RequestFailedError' || typeof E.status === 'number') {
    const N = Number(E.status);
    return Number.isFinite(N) ? N : 5;
  }
  return null;
}

export function SnmpErrorText(Err: unknown): string {
  return Err instanceof Error ? Err.message || String(Err) : String(Err);
}
