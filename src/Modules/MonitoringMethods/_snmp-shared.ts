// Shared SNMPv3 (User-based Security Model, RFC 3414) credential handling for
// every method that can talk SNMPv3: snmp-ups-v3 and snmp-oid. The editor
// fields, the protocol tables, the derived security level and the net-snmp USM
// user all live here so the methods cannot drift apart on what "authPriv with
// SHA-256 / AES-128" means.
import snmp, {
  type User,
  type AuthProtocols,
  type PrivProtocols,
  type SecurityLevel,
} from 'net-snmp';
import type { MonitoringSettingField, MonitoringSettingVisibleWhen } from './types';

// Editor value -> net-snmp AuthProtocol. 'none' means no message authentication
// (which, per SNMPv3, also forces no privacy) — i.e. the noAuthNoPriv level.
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
// sibling setting — snmp-oid shows them only while its version select is v3.
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
  // derived from these — no separate level field.
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
  // off — this keeps the derived level and the USM user self-consistent.
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
