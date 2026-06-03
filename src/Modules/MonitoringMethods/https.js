// HTTPS monitoring. Same flow as the HTTP method but over TLS. Certificate
// validation can be relaxed via IgnoreTlsErrors for self-signed appliances on
// internal networks.
const { PerformHttpRequest } = require('./_http-shared');

const ID = 'https';

const Settings = [
  {
    Key: 'Port',
    Label: 'Port',
    Type: 'number',
    Default: 443,
    Min: 1,
    Max: 65535,
  },
  {
    Key: 'Path',
    Label: 'Path',
    Type: 'string',
    Default: '/',
  },
  {
    Key: 'Method',
    Label: 'HTTP Method',
    Type: 'string',
    Default: 'GET',
  },
  {
    Key: 'ExpectedStatusMin',
    Label: 'Expected Status Min',
    Type: 'number',
    Default: 200,
    Min: 100,
    Max: 599,
  },
  {
    Key: 'ExpectedStatusMax',
    Label: 'Expected Status Max',
    Type: 'number',
    Default: 399,
    Min: 100,
    Max: 599,
  },
  {
    Key: 'FollowRedirects',
    Label: 'Follow Redirects',
    Type: 'boolean',
    Default: false,
  },
  {
    Key: 'IgnoreTlsErrors',
    Label: 'Ignore TLS Errors',
    Type: 'boolean',
    Default: false,
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: 5000,
    Min: 500,
    Max: 60000,
  },
];

async function Run(Target) {
  return PerformHttpRequest(Target, { Protocol: 'https', DefaultPort: 443 });
}

module.exports = {
  ID,
  Name: 'HTTPS',
  Description: 'Performs a TLS-wrapped HTTPS request and validates the response status code.',
  DefaultInterval: 60000,
  Settings,
  Run,
};
