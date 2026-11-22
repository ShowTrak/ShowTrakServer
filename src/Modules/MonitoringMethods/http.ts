// HTTP/HTTPS monitoring. Performs an HTTP or HTTPS request against Target.Address
// and validates that the response status falls within the configured range.
// The request body is drained but not parsed.
import { PerformHttpRequest, BuildHttpDebug } from './_http-shared';
import { HTTP_TARGET_FIELDS, FOLLOW_REDIRECTS_FIELD, ExpectedStatusFields } from './_http-fields';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'http';

const Settings: MonitoringSettingField[] = [
  ...HTTP_TARGET_FIELDS,
  ...ExpectedStatusFields(399),
  FOLLOW_REDIRECTS_FIELD,
  {
    Key: 'IgnoreTlsErrors',
    Label: 'Ignore TLS Errors',
    Type: 'boolean',
    Default: false,
    Advanced: true,
    Note: 'Accept self-signed or expired certificates on HTTPS. Applies to HTTPS only.',
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
