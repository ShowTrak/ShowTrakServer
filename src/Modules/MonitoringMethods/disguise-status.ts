// disguise (d3) machine/director status check.
//
// disguise's Designer "Service / Session" API is exposed over plain HTTP. Per the
// official developer docs (https://developer.disguise.one/api/session/status/ and
// /api/discovery/) there is a confirmed health endpoint:
//
//     GET http://<host>:80/api/session/status/health
//
// which returns JSON shaped roughly like:
//     {
//       "status":  { "code": 0, "message": "...", "details": [...] },
//       "result": [ {
//         "machine": { "uid": "...", "name": "...", "hostname": "..." },
//         "status":  { "averageFPS": 60, "videoDroppedFrames": 0, ... },
//         "states":  [ { "name": "...", "detail": "...", "category": "...", "severity": "..." } ]
//       } ]
//     }
//
// IMPORTANT / HONESTY NOTE on version-dependence and configurability:
//   * The health endpoint PATH and the port-80-over-HTTP default ARE confirmed by the
//     disguise developer docs, but the docs also state the API port is user-changeable
//     (d3Manager > Advanced Network Configuration) and the endpoint set varies by
//     Designer version. So Protocol / Port / Path are all user-configurable here.
//   * The docs did NOT enumerate a version string in the health payload, nor did they
//     document the exact `severity` enum values, so this check does NOT invent
//     auto-degraded semantics from those fields. Instead it mirrors http-json's
//     JsonPath + ExpectedValue assertion so an operator can assert a real, confirmed
//     health field (e.g. JsonPath "status.code" == "0", or "result.0.status.averageFPS").
//
// Online / Degraded / Offline mapping:
//   * No response / connection refused / status outside the expected range -> Offline
//     (Success:false, Error) — produced by PerformHttpRequest.
//   * Reachable + valid response, and either no assertion configured or the assertion
//     passes -> Online (LatencyMs + best-effort machine name / averageFPS for display).
//   * Reachable + valid response but a configured JsonPath assertion resolves to the
//     wrong value -> Degraded (reachable but not the expected/ready state).
//   * Reachable but the body is not valid JSON / the JsonPath is missing when an
//     assertion is configured -> Offline (cannot confirm this is the disguise API).
import { PerformHttpRequest, BuildHttpDebug } from './_http-shared';
import { Esc, Pill, Rows, TextRow, Row, JsonCodeBlock, JsonCodeBlockWithPath } from './debug';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'disguise-status';

const DEFAULT_PATH = '/api/session/status/health';

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Protocol',
    Label: 'Protocol',
    Type: 'select',
    Default: 'http',
    Options: [
      { value: 'http', label: 'HTTP' },
      { value: 'https', label: 'HTTPS' },
    ],
  },
  { Key: 'Port', Label: 'Port', Type: 'number', Default: 80, Min: 1, Max: 65535 },
  { Key: 'Path', Label: 'Path', Type: 'string', Default: DEFAULT_PATH },
  {
    Key: 'JsonPath',
    Label: 'Health JSON path (optional, e.g. status.code or result.0.status.averageFPS)',
    Type: 'string',
    Default: '',
  },
  {
    Key: 'ExpectedValue',
    Label: 'Expected value (with JSON path; mismatch = Degraded)',
    Type: 'string',
    Default: '',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: 6000,
    Min: 500,
    Max: 60000,
    Advanced: true,
  },
  {
    Key: 'IgnoreTlsErrors',
    Label: 'Ignore TLS Errors (HTTPS only)',
    Type: 'boolean',
    Default: false,
    Advanced: true,
  },
];

// Dotted JSON path lookup, e.g. "result.0.status.averageFPS". Mirrors http-json.
function ResolveJsonPath(Root: unknown, Path: unknown): unknown {
  if (!Path) return undefined;
  const Parts = String(Path).split('.').filter(Boolean);
  let Cur: unknown = Root;
  for (const Part of Parts) {
    if (Cur == null) return undefined;
    Cur = (Cur as Record<string, unknown>)[Part];
  }
  return Cur;
}

interface HealthEvaluation {
  Kind: 'online' | 'degraded' | 'offline';
  Error?: string;
  DegradedReason?: string;
  MatchedValue?: string;
}

// Pure result-mapping over a captured response body. Kept side-effect free so the
// online/degraded/offline decision can be unit tested directly.
function EvaluateHealth(Body: string, JsonPath: string, Expected: string): HealthEvaluation {
  // No assertion configured -> a healthy HTTP response is enough for Online.
  if (!JsonPath) return { Kind: 'online' };

  let Parsed: unknown;
  try {
    Parsed = JSON.parse(Body || '');
  } catch (Err) {
    return { Kind: 'offline', Error: `Response is not valid JSON: ${(Err as Error).message}` };
  }

  const Actual = ResolveJsonPath(Parsed, JsonPath);
  if (Actual === undefined) {
    return { Kind: 'offline', Error: `JSON path "${JsonPath}" not found` };
  }

  const ActualStr = String(Actual).slice(0, 256);
  if (Expected !== '' && String(Actual) !== Expected) {
    return {
      Kind: 'degraded',
      DegradedReason: `${JsonPath} = "${ActualStr.slice(0, 64)}" (expected "${Expected}")`,
      MatchedValue: ActualStr,
    };
  }
  return { Kind: 'online', MatchedValue: ActualStr };
}

// Best-effort extraction of human-friendly health info for the Debug panel. Never
// throws and tolerates the documented shape being absent (version-dependent payloads).
function ExtractHealthSummary(Body: unknown): { MachineName?: string; AverageFps?: number } {
  const Out: { MachineName?: string; AverageFps?: number } = {};
  try {
    const Parsed = JSON.parse(String(Body || '')) as Record<string, unknown>;
    const Results = Parsed && (Parsed.result as unknown);
    const First = Array.isArray(Results) ? (Results[0] as Record<string, unknown>) : undefined;
    if (First && typeof First === 'object') {
      const Machine = First.machine as Record<string, unknown> | undefined;
      if (Machine && Machine.name != null) Out.MachineName = String(Machine.name);
      const Status = First.status as Record<string, unknown> | undefined;
      if (Status && Number.isFinite(Number(Status.averageFPS))) {
        Out.AverageFps = Number(Status.averageFPS);
      }
    }
  } catch (_e) {
    // Non-JSON or unexpected shape: nothing to summarise.
  }
  return Out;
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Address = Target && Target.Address;
  if (!Address) return { Success: false, Error: 'No address configured' };

  const Cfg = (Target && Target.Settings) || {};
  const Protocol = String(Cfg.Protocol || 'http').toLowerCase() === 'https' ? 'https' : 'http';
  const DefaultPort = Protocol === 'https' ? 443 : 80;

  // Default the Path when unset so the confirmed disguise health endpoint is probed.
  const ProbeTarget: MonitoringTargetLike = {
    ...Target,
    Settings: { ...Cfg, Path: Cfg.Path ? Cfg.Path : DEFAULT_PATH },
  };

  const Result = await PerformHttpRequest(ProbeTarget, {
    Protocol,
    DefaultPort,
    CaptureBody: true,
  });
  if (!Result.Success) return Result;

  const Body = (Result.Body as string) || '';
  const JsonPath = Cfg.JsonPath == null ? '' : String(Cfg.JsonPath).trim();
  const Expected = Cfg.ExpectedValue == null ? '' : String(Cfg.ExpectedValue);
  const Summary = ExtractHealthSummary(Body);

  const Evaluation = EvaluateHealth(Body, JsonPath, Expected);

  const Base: MonitoringResult = {
    Success: true,
    LatencyMs: Result.LatencyMs,
    Status: Result.Status,
    JsonPath: JsonPath || undefined,
    MachineName: Summary.MachineName,
    AverageFps: Summary.AverageFps,
    JsonBody: Body,
  };
  if (Object.prototype.hasOwnProperty.call(Evaluation, 'MatchedValue')) {
    Base.MatchedValue = Evaluation.MatchedValue;
  }

  if (Evaluation.Kind === 'offline') {
    return {
      Success: false,
      Error: Evaluation.Error || 'Health check failed',
      Status: Result.Status,
      JsonPath: JsonPath || undefined,
      JsonBody: Body,
    };
  }

  if (Evaluation.Kind === 'degraded') {
    return {
      ...Base,
      Degraded: true,
      DegradedReason: Evaluation.DegradedReason || 'Health field indicates not ready',
    };
  }

  return Base;
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Cfg = (Target && Target.Settings) || {};
  const Protocol = String(Cfg.Protocol || 'http').toLowerCase() === 'https' ? 'https' : 'http';
  let Html = BuildHttpDebug(Result, Target, { Scheme: Protocol });

  const Extra: Array<string | null> = [];

  if (Result && Result.MachineName != null) {
    Extra.push(TextRow('Machine', String(Result.MachineName)));
  }
  if (Result && Result.AverageFps != null && Number.isFinite(Number(Result.AverageFps))) {
    Extra.push(
      Row('Average FPS', `<span class="font-monospace">${Esc(Number(Result.AverageFps))}</span>`)
    );
  }

  if (Result && Result.JsonPath) {
    Extra.push(TextRow('Health JSON path', String(Result.JsonPath)));
    if (Object.prototype.hasOwnProperty.call(Result, 'MatchedValue')) {
      Extra.push(
        Row('Resolved value', `<span class="font-monospace">${Esc(Result.MatchedValue)}</span>`)
      );
    }
  }

  if (Result && Result.Degraded) {
    Extra.push(Row('Health', Pill('warning', 'Not ready')));
    if (Result.DegradedReason) Extra.push(TextRow('Reason', String(Result.DegradedReason)));
  }

  if (Result && Result.JsonBody) {
    Extra.push(null); // Spacer
    Extra.push(`<div class="mt-2"><span class="text-muted small">Response Body:</span></div>`);
    if (Result.JsonPath) {
      Extra.push(JsonCodeBlockWithPath(Result.JsonBody, Result.JsonPath));
    } else {
      Extra.push(JsonCodeBlock(Result.JsonBody));
    }
  }

  if (Extra.length) Html += Rows(Extra);
  return Html;
}

export const Name = 'disguise (d3)';
export const Description =
  'HTTP health probe for a disguise (d3) machine via the Designer session status API; optional JSON health assertion.';
export const DefaultInterval = 60000;
export { ID, Settings, Run, Debug };
export const _internal = { ResolveJsonPath, EvaluateHealth, ExtractHealthSummary };
