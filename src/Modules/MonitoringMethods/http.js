// HTTP monitoring. Performs a single HTTP request against Target.Address and
// validates that the response status falls within the configured range. The
// request body is drained but not parsed.
const { PerformHttpRequest } = require('./_http-shared');

const ID = 'http';

const Settings = [
  {
    Key: 'Port',
    Label: 'Port',
    Type: 'number',
    Default: 80,
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
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: 5000,
    Min: 500,
    Max: 60000,
  },
];

async function Run(Target) {
  return PerformHttpRequest(Target, { Protocol: 'http', DefaultPort: 80 });
}

module.exports = {
  ID,
  Name: 'HTTP',
  Description: 'Performs a plain-text HTTP request and validates the response status code.',
  DefaultInterval: 60000,
  Settings,
  Run,
};
