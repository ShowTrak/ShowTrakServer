// HTTP/S API content monitoring. Issues a request like http/https methods, but
// additionally inspects the response body. Two modes are supported:
//   - JSON path: dotted path lookup (e.g. "data.status") matched against an
//     expected value.
//   - Text contains: raw substring search inside the response body.
// The body is capped at 1 MiB to prevent unbounded memory use.
const { PerformHttpRequest } = require('./_http-shared');

const ID = 'http-json';

const Settings = [
  {
    Key: 'Scheme',
    Label: 'Scheme (http or https)',
    Type: 'string',
    Default: 'https',
  },
  {
    Key: 'Port',
    Label: 'Port (0 = scheme default)',
    Type: 'number',
    Default: 0,
    Min: 0,
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
    Default: 299,
    Min: 100,
    Max: 599,
  },
  {
    Key: 'JsonPath',
    Label: 'JSON path (e.g. data.status, leave empty for text match)',
    Type: 'string',
    Default: '',
  },
  {
    Key: 'ExpectedValue',
    Label: 'Expected value / substring',
    Type: 'string',
    Default: '',
  },
  {
    Key: 'FollowRedirects',
    Label: 'Follow Redirects',
    Type: 'boolean',
    Default: false,
  },
  {
    Key: 'IgnoreTlsErrors',
    Label: 'Ignore TLS Errors (HTTPS only)',
    Type: 'boolean',
    Default: false,
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: 8000,
    Min: 500,
    Max: 60000,
  },
];

function ResolveJsonPath(Root, Path) {
  if (!Path) return undefined;
  const Parts = String(Path).split('.').filter(Boolean);
  let Cur = Root;
  for (const Part of Parts) {
    if (Cur == null) return undefined;
    // Allow simple [index] tokens combined with dot notation, e.g. items.0.id
    Cur = Cur[Part];
  }
  return Cur;
}

async function Run(Target) {
  const Cfg = (Target && Target.Settings) || {};
  const Scheme = String(Cfg.Scheme || 'https').toLowerCase() === 'http' ? 'http' : 'https';
  const DefaultPort = Scheme === 'http' ? 80 : 443;

  const Result = await PerformHttpRequest(Target, {
    Protocol: Scheme,
    DefaultPort,
    CaptureBody: true,
  });
  if (!Result.Success) return Result;

  const Body = Result.Body || '';
  const Expected = Cfg.ExpectedValue == null ? '' : String(Cfg.ExpectedValue);
  const JsonPath = Cfg.JsonPath == null ? '' : String(Cfg.JsonPath).trim();

  // No content assertion configured -> status check is enough.
  if (!Expected && !JsonPath) {
    return { Success: true, LatencyMs: Result.LatencyMs };
  }

  if (JsonPath) {
    let Parsed;
    try {
      Parsed = JSON.parse(Body);
    } catch (Err) {
      return { Success: false, Error: `Response is not valid JSON: ${Err.message}` };
    }
    const Actual = ResolveJsonPath(Parsed, JsonPath);
    if (Actual === undefined) {
      return { Success: false, Error: `JSON path "${JsonPath}" not found` };
    }
    if (Expected !== '' && String(Actual) !== Expected) {
      return {
        Success: false,
        Error: `JSON path "${JsonPath}" returned "${String(Actual).slice(0, 64)}", expected "${Expected}"`,
      };
    }
    return { Success: true, LatencyMs: Result.LatencyMs };
  }

  // Plain substring search against the body.
  if (Body.indexOf(Expected) === -1) {
    return { Success: false, Error: `Response body did not contain expected text` };
  }
  return { Success: true, LatencyMs: Result.LatencyMs };
}

module.exports = {
  ID,
  Name: 'HTTP/S JSON / Text',
  Description:
    'HTTP or HTTPS request that asserts a JSON path value or a substring in the response body.',
  DefaultInterval: 60000,
  Settings,
  Run,
};
