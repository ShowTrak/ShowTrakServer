// SNMP UPS health check (v1 / v2c) — reads the standard UPS-MIB (RFC 1628) over
// community-authenticated SNMP. Works across the whole range of network-managed
// UPS cards that implement RFC 1628 (Eaton/MGE, Riello NetMan, APC, CyberPower,
// Tripp Lite, ...). For cards configured for SNMPv3 (user + auth/priv), use the
// sibling snmp-ups-v3 method instead.
//
// The UPS-MIB read set, health evaluation and debug rendering are shared with
// snmp-ups-v3 via ./_snmp-ups-shared; this file only handles the v1/v2c session
// (community string) and its editor Settings.
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
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'snmp-ups';

const Settings: MonitoringSettingField[] = [
  { Key: 'Port', Label: 'Port', Type: 'number', Default: DEFAULT_PORT, Min: 1, Max: 65535 },
  { Key: 'Community', Label: 'Community string', Type: 'string', Default: 'public' },
  {
    Key: 'Version',
    Label: 'SNMP version',
    Type: 'select',
    Default: '2c',
    Options: [
      { value: '2c', label: 'v2c' },
      { value: '1', label: 'v1' },
    ],
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
    Key: 'MinCharge',
    Label: 'Minimum charge (%)',
    Type: 'number',
    Default: HEALTH_DEFAULTS.MinCharge,
    Min: 0,
    Max: 100,
  },
  {
    Key: 'MaxLoad',
    Label: 'Maximum load (%)',
    Type: 'number',
    Default: HEALTH_DEFAULTS.MaxLoad,
    Min: 1,
    Max: 100,
  },
  {
    Key: 'MaxTemperature',
    Label: 'Maximum battery temperature (°C)',
    Type: 'number',
    Default: HEALTH_DEFAULTS.MaxTemperature,
    Min: 0,
    Max: 100,
    Advanced: true,
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

interface SnmpConfig {
  Address: string;
  Port: number;
  Community: string;
  Version: '1' | '2c';
  OutputIndex: number;
  TimeoutMs: number;
  Retries: number;
}

function ParseConfig(Target: MonitoringTargetLike): SnmpConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Num = (Value: unknown, Fallback: number): number => {
    const N = Number(Value);
    return Number.isFinite(N) ? N : Fallback;
  };
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Port: Num(Cfg.Port, DEFAULT_PORT) | 0,
    Community: Cfg.Community == null || Cfg.Community === '' ? 'public' : String(Cfg.Community),
    Version: String(Cfg.Version) === '1' ? '1' : '2c',
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

  const CreateSession = (): SnmpSession =>
    snmp.createSession(Config.Address, Config.Community, {
      port: Config.Port,
      version: Config.Version === '1' ? snmp.Version1 : snmp.Version2c,
      timeout: Math.max(500, Config.TimeoutMs),
      retries: Config.Retries,
    });

  return RunUpsHealth(CreateSession, Config.OutputIndex, ParseThresholds((Target && Target.Settings) || {}));
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseConfig(Target);
  return UpsDebug(Result, Config.Address, Config.Port, [
    IdentityRow('SNMP', `v${Config.Version} · ${Config.Community}`),
  ]);
}

export const Name = 'UPS Health (SNMP v1/v2c)';
export const Description =
  'Reads status, battery charge, load, temperature, input voltage and active alarms from any UPS network card that implements the standard UPS-MIB (RFC 1628) over community-authenticated SNMP (v1/v2c) — Eaton/MGE, Riello NetMan, APC, CyberPower and most others — and reports a single healthy / degraded verdict.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = { ParseConfig, EvaluateHealth };
export { ID, Settings, Run, Debug };
