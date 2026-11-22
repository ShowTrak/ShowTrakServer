// HTTPS monitoring. Same flow as the HTTP method but over TLS. Certificate
// validation can be relaxed via IgnoreTlsErrors for self-signed appliances on
// internal networks.
import { PerformHttpRequest, BuildHttpDebug } from './_http-shared';
import { ExpectedStatusFields } from './_http-fields';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'https';

const Settings: MonitoringSettingField[] = [
  { Key: 'Port', Label: 'Port', Type: 'number', Default: 443, Min: 1, Max: 65535, Required: true },
  { Key: 'Path', Label: 'Path', Type: 'string', Default: '/' },
  { Key: 'Method', Label: 'HTTP Method', Type: 'string', Default: 'GET' },
  ...ExpectedStatusFields(399),
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

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  return PerformHttpRequest(Target, { Protocol: 'https', DefaultPort: 443 });
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  return BuildHttpDebug(Result, Target, { Protocol: 'https' });
}

export const Name = 'HTTPS';
export const Description =
  'Performs a TLS-wrapped HTTPS request and validates the response status code.';
export const DefaultInterval = 60000;
export { ID, Settings, Run, Debug };
