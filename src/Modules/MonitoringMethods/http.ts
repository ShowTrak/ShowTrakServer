// HTTP/HTTPS monitoring. Performs an HTTP or HTTPS request against Target.Address
// and validates that the response status falls within the configured range.
// The request body is drained but not parsed.
import { PerformHttpRequest, BuildHttpDebug } from './_http-shared';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'http';

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Protocol',
    Label: 'Protocol',
    Type: 'select',
    Default: 'https',
    Options: [
      { value: 'http', label: 'HTTP' },
      { value: 'https', label: 'HTTPS' },
    ],
  },
  { Key: 'Port', Label: 'Port', Type: 'number', Default: 0, Min: 0, Max: 65535 },
  { Key: 'Path', Label: 'Path', Type: 'string', Default: '/' },
  { Key: 'Method', Label: 'HTTP Method', Type: 'string', Default: 'GET' },
  {
    Key: 'ExpectedStatusMin',
    Label: 'Expected Status Min',
    Type: 'number',
    Default: 200,
    Min: 100,
    Max: 599,
    Advanced: true,
  },
  {
    Key: 'ExpectedStatusMax',
    Label: 'Expected Status Max',
    Type: 'number',
    Default: 399,
    Min: 100,
    Max: 599,
    Advanced: true,
  },
  {
    Key: 'FollowRedirects',
    Label: 'Follow Redirects',
    Type: 'boolean',
    Default: false,
    Advanced: true,
  },
  {
    Key: 'IgnoreTlsErrors',
    Label: 'Ignore TLS Errors',
    Type: 'boolean',
    Default: false,
    Advanced: true,
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: 5000,
    Min: 500,
    Max: 60000,
    Advanced: true,
  },
];

function NormalizeSettings(Input: unknown): Record<string, unknown> {
  // Migration: old http/https checks may have stored Protocol as undefined or 'http'/'https'
  // Ensure Protocol is always one of our select options
  const Cfg = (Input || {}) as Record<string, unknown>;
  const Protocol = String(Cfg.Protocol || 'https').toLowerCase();
  if (Protocol !== 'http' && Protocol !== 'https') {
    return { ...(Input as Record<string, unknown>), Protocol: 'https' };
  }
  return Input as Record<string, unknown>;
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Cfg = (Target && Target.Settings) || {};
  const Protocol = String(Cfg.Protocol || 'https').toLowerCase();
  const FinalProtocol = Protocol === 'http' ? 'http' : 'https';
  const DefaultPort = FinalProtocol === 'http' ? 80 : 443;

  return PerformHttpRequest(Target, { Protocol: FinalProtocol, DefaultPort });
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Cfg = (Target && Target.Settings) || {};
  const Protocol = String(Cfg.Protocol || 'https').toLowerCase();
  return BuildHttpDebug(Result, Target, { Protocol });
}

export const Name = 'HTTP / HTTPS';
export const Description =
  'Performs an HTTP or HTTPS request and validates the response status code.';
export const DefaultInterval = 60000;
export { ID, Settings, NormalizeSettings, Run, Debug };
