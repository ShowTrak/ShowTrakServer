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
import snmp from 'net-snmp';
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
import {
  V3CredentialFields,
  ParseV3Credentials,
  ValidateV3Credentials,
  BuildUser,
  V3IdentityLabel,
  type V3Credentials,
} from './_snmp-shared';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'snmp-ups-v3';

// The USM user fields, protocol tables, derived security level and USM user
// builder are shared with snmp-oid via ./_snmp-shared.

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
  ...V3CredentialFields(),
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

interface V3Config extends V3Credentials {
  Address: string;
  Port: number;
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
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Port: Num(Cfg.Port, DEFAULT_PORT) | 0,
    ...ParseV3Credentials(Cfg),
    OutputIndex: Math.max(1, Num(Cfg.OutputIndex, 1) | 0),
    TimeoutMs: Num(Cfg.Timeout, 4000),
    Retries: Math.max(0, Num(Cfg.Retries, 1) | 0),
  };
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Success: false, Error: `Invalid port: ${Config.Port}` };
  }
  const CredentialError = ValidateV3Credentials(Config);
  if (CredentialError) return { Success: false, Error: CredentialError };

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
  const Identity = V3IdentityLabel(Config);
  return UpsDebug(Result, Config.Address, Config.Port, [IdentityRow('SNMPv3', Identity)]);
}

export const Name = 'UPS Health (SNMP v3)';
export const Description =
  'Reads status, battery charge, load, temperature, input voltage and active alarms from a UPS network card over authenticated/encrypted SNMPv3 (username + auth/priv), using the standard UPS-MIB (RFC 1628). For cards still on a community string, use UPS Health (SNMP v1/v2c) instead.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = { ParseConfig, BuildUser, EvaluateHealth };
export { ID, Settings, Run, Debug };
