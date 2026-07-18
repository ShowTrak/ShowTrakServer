// HTTP/S API content monitoring. Issues a request like http/https methods, but
// additionally inspects the response body. Two modes are supported:
//   - JSON path: dotted path lookup (e.g. "data.status") matched against an
//     expected value.
//   - Text contains: raw substring search inside the response body.
// The body is capped at 1 MiB to prevent unbounded memory use.
import { PerformHttpRequest, BuildHttpDebug } from './_http-shared';
import { Esc, Pill, Rows, TextRow, Row, JsonCodeBlock, JsonCodeBlockWithPath } from './debug';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'http-json';

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
    Default: 299,
    Min: 100,
    Max: 599,
    Advanced: true,
  },
  {
    Key: 'JsonPath',
    Label: 'JSON path',
    Type: 'string',
    Default: '',
    Note: 'Dotted path into the JSON body, e.g. data.status. Leave empty to match against the raw response text instead.',
  },
  {
    Key: 'ExpectedValue',
    Label: 'Expected value / substring',
    Type: 'string',
    Default: '',
    Note: 'Compared as text. Degraded when the value at the JSON path (or the body) does not match.',
  },
  {
    Key: 'FollowRedirects',
    Label: 'Follow Redirects',
    Type: 'boolean',
    Default: false,
    Advanced: true,
    Note: 'When off, a 3xx redirect is checked against the expected status range as-is rather than followed.',
  },
  {
    Key: 'IgnoreTlsErrors',
    Label: 'Ignore TLS Errors',
    Type: 'boolean',
    Default: false,
    Advanced: true,
    Note: 'Accept self-signed or expired certificates. Applies to HTTPS only.',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: 8000,
    Min: 500,
    Max: 60000,
    Advanced: true,
  },
];

function ResolveJsonPath(Root: unknown, Path: unknown): unknown {
  if (!Path) return undefined;
  const Parts = String(Path).split('.').filter(Boolean);
  let Cur: unknown = Root;
  for (const Part of Parts) {
    if (Cur == null) return undefined;
    // Allow simple [index] tokens combined with dot notation, e.g. items.0.id
    Cur = (Cur as Record<string, unknown>)[Part];
  }
  return Cur;
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Cfg = (Target && Target.Settings) || {};
  // Support both old 'Scheme' and new 'Protocol' field names for migration
  const Protocol = String(Cfg.Protocol || Cfg.Scheme || 'https').toLowerCase();
  const FinalProtocol = Protocol === 'http' ? 'http' : 'https';
  const DefaultPort = FinalProtocol === 'http' ? 80 : 443;

  const Result = await PerformHttpRequest(Target, {
    Protocol: FinalProtocol,
    DefaultPort,
    CaptureBody: true,
  });
  if (!Result.Success) return Result;

  const Body = (Result.Body as string) || '';
  const Expected = Cfg.ExpectedValue == null ? '' : String(Cfg.ExpectedValue);
  const JsonPath = Cfg.JsonPath == null ? '' : String(Cfg.JsonPath).trim();

  // No content assertion configured -> status check is enough.
  if (!Expected && !JsonPath) {
    return {
      Success: true,
      LatencyMs: Result.LatencyMs,
      Status: Result.Status,
      Mode: 'status',
      JsonBody: Body,
    };
  }

  if (JsonPath) {
    let Parsed: unknown;
    try {
      Parsed = JSON.parse(Body);
    } catch (Err) {
      return {
        Success: false,
        Error: `Response is not valid JSON: ${(Err as Error).message}`,
        Status: Result.Status,
        Mode: 'json',
        JsonPath,
        JsonBody: Body,
      };
    }
    const Actual = ResolveJsonPath(Parsed, JsonPath);
    if (Actual === undefined) {
      return {
        Success: false,
        Error: `JSON path "${JsonPath}" not found`,
        Status: Result.Status,
        Mode: 'json',
        JsonPath,
        JsonBody: Body,
      };
    }
    if (Expected !== '' && String(Actual) !== Expected) {
      return {
        Success: false,
        Error: `JSON path "${JsonPath}" returned "${String(Actual).slice(0, 64)}", expected "${Expected}"`,
        Status: Result.Status,
        Mode: 'json',
        JsonPath,
        MatchedValue: String(Actual).slice(0, 256),
        JsonBody: Body,
      };
    }
    return {
      Success: true,
      LatencyMs: Result.LatencyMs,
      Status: Result.Status,
      Mode: 'json',
      JsonPath,
      MatchedValue: String(Actual).slice(0, 256),
      JsonBody: Body,
    };
  }

  // Plain substring search against the body.
  if (Body.indexOf(Expected) === -1) {
    return {
      Success: false,
      Error: `Response body did not contain expected text`,
      Status: Result.Status,
      Mode: 'text',
      Expected: Expected.slice(0, 256),
      JsonBody: Body,
    };
  }
  return {
    Success: true,
    LatencyMs: Result.LatencyMs,
    Status: Result.Status,
    Mode: 'text',
    Expected: Expected.slice(0, 256),
    JsonBody: Body,
  };
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Cfg = (Target && Target.Settings) || {};
  const Scheme = String(Cfg.Scheme || 'https').toLowerCase() === 'http' ? 'http' : 'https';
  let Html = BuildHttpDebug(Result, Target, { Scheme });

  const Mode = Result && Result.Mode;
  const Extra: Array<string | null> = [];

  if (Mode === 'json') {
    Extra.push(TextRow('JSON path', (Result && (Result.JsonPath as string)) || '—'));
    if (Result && Object.prototype.hasOwnProperty.call(Result, 'MatchedValue')) {
      Extra.push(
        Row('Resolved value', `<span class="font-monospace">${Esc(Result.MatchedValue)}</span>`)
      );
    }
  } else if (Mode === 'text') {
    const Found = !!(Result && Result.Success);
    Extra.push(TextRow('Expected substring', (Result && (Result.Expected as string)) || '—'));
    Extra.push(
      Row('Body match', Pill(Found ? 'success' : 'danger', Found ? 'Found' : 'Not found'))
    );
  }

  // Always display the JSON response if available
  if (Result && Result.JsonBody) {
    Extra.push(null); // Spacer
    Extra.push(`<div class="mt-2"><span class="text-muted small">Response Body:</span></div>`);

    // If a JSON path was defined and this was successful JSON mode, highlight the path
    if (Mode === 'json' && Result.JsonPath) {
      Extra.push(JsonCodeBlockWithPath(Result.JsonBody, Result.JsonPath));
    } else {
      Extra.push(JsonCodeBlock(Result.JsonBody));
    }
  }

  if (Extra.length) Html += Rows(Extra);
  return Html;
}

export const Name = 'HTTP/S JSON / Text';
export const Description =
  'HTTP or HTTPS request that asserts a JSON path value or a substring in the response body.';
export const DefaultInterval = 60000;
export { ID, Settings, Run, Debug };
