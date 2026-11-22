// Editor fields of the methods built on ./_http-shared's PerformHttpRequest,
// which reads them. Kept apart from the request itself so a method's Settings
// do not depend on the transport (its tests mock the transport out).
import type { MonitoringSettingField } from './types';

// The editor fields naming the request, shared by the http and http-json
// methods (the legacy https method keeps its own older set).
export const HTTP_TARGET_FIELDS: MonitoringSettingField[] = [
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
  {
    Key: 'Port',
    Label: 'Port',
    Type: 'number',
    Default: 0,
    Min: 0,
    Max: 65535,
    Note: 'Leave at 0 to use the protocol default: 80 for HTTP, 443 for HTTPS.',
  },
  { Key: 'Path', Label: 'Path', Type: 'string', Default: '/' },
  {
    Key: 'Method',
    Label: 'HTTP Method',
    Type: 'select',
    Default: 'GET',
    Options: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map((M) => ({
      value: M,
      label: M,
    })),
  },
];

// The range of response statuses that count as up (Max defaults differ by method).
export function ExpectedStatusFields(DefaultMax: number): MonitoringSettingField[] {
  return [
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
      Default: DefaultMax,
      Min: 100,
      Max: 599,
      Advanced: true,
    },
  ];
}

export const FOLLOW_REDIRECTS_FIELD: MonitoringSettingField = {
  Key: 'FollowRedirects',
  Label: 'Follow Redirects',
  Type: 'boolean',
  Default: false,
  Advanced: true,
  Note: 'When off, a 3xx redirect is checked against the expected status range as-is rather than followed.',
};
