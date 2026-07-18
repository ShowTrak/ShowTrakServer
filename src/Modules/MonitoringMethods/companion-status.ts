// Bitfocus Companion (3.x/4.x) reachability check.
//
// Companion exposes its web/admin UI on HTTP port 8000 by default. That web
// root ("/") always serves the admin GUI as an HTML 200 response and — unlike
// the REST endpoints under "/api/..." — does NOT require the operator to have
// enabled the HTTP API in Settings->HTTP. Companion 3.x has no clean JSON
// version/health endpoint (see bitfocus/companion discussion #4101: the REST
// API is button/variable control only, no system/version resource), so the
// most reliable "is it alive" signal is a plain GET of the web root returning
// a 2xx/3xx status. The Path is configurable so an operator who has enabled
// the HTTP API can instead point at a specific endpoint
// (e.g. /api/custom-variable/<name>/value).
//
// Mapping:
//   Online  -> HTTP response with a status inside [ExpectedStatusMin, ExpectedStatusMax].
//   Offline -> no response / connection refused / timeout, or a status outside that range.
//   Degraded is not used: reachability is the only health signal the web root gives us.
//     (A version string is extracted best-effort from the body when present and
//      surfaced for display only; it never changes the pass/fail decision.)
import { PerformHttpRequest, BuildHttpDebug } from './_http-shared';
import { TextRow, Rows } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'companion-status';

const Settings: MonitoringSettingField[] = [
  { Key: 'Port', Label: 'Port', Type: 'number', Default: 8000, Min: 1, Max: 65535, Required: true },
  // Path defaults to the web admin root, which is always served with no operator
  // configuration. Kept behind Advanced so the default editor experience is
  // Address-only; operators who have enabled Companion's HTTP API can still point
  // at a specific endpoint (e.g. /api/custom-variable/<name>/value).
  { Key: 'Path', Label: 'Path', Type: 'string', Default: '/', Advanced: true },
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
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: 6000,
    Min: 500,
    Max: 60000,
    Advanced: true,
  },
];

// Best-effort version sniff from the returned body. Companion has no version
// endpoint, but some responses/pages embed a "version": "x.y.z" or "Companion
// vX.Y.Z" token. Returns null when nothing recognisable is present — this is
// display-only and never affects the online/offline decision.
function ExtractVersion(Body: unknown): string | null {
  const Text = String(Body == null ? '' : Body);
  if (!Text) return null;
  const Patterns: RegExp[] = [
    /"appVersion"\s*:\s*"([^"]{1,32})"/i,
    /"version"\s*:\s*"([^"]{1,32})"/i,
    /companion[^0-9]{0,16}v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,24})?)/i,
  ];
  for (const Pattern of Patterns) {
    const Match = Pattern.exec(Text);
    if (Match && Match[1]) return Match[1];
  }
  return null;
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Address = Target && Target.Address;
  if (!Address) return { Success: false, Error: 'No address configured' };

  const Result = await PerformHttpRequest(Target, {
    Protocol: 'http',
    DefaultPort: 8000,
    CaptureBody: true,
  });

  // A failed request (no reply, refused, timeout, or status outside the
  // expected range) is already shaped as an Offline result by the shared
  // helper — pass it straight through without leaking the captured body.
  if (!Result.Success) {
    return { Success: false, Error: Result.Error || 'Companion not reachable', Status: Result.Status };
  }

  const Version = ExtractVersion(Result.Body);
  const Out: MonitoringResult = {
    Success: true,
    LatencyMs: Result.LatencyMs,
    Status: Result.Status,
  };
  if (Version) Out.Version = Version;
  return Out;
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  let Html = BuildHttpDebug(Result, Target, { Protocol: 'http' });
  const Extra: Array<string | null> = [];
  if (Result && Result.Success && Result.Version) {
    // TextRow escapes the network-derived version string for us.
    Extra.push(TextRow('Version', String(Result.Version)));
  }
  if (Extra.length) Html += Rows(Extra);
  return Html;
}

export const Name = 'Bitfocus Companion';
export const Description =
  'Checks that a Bitfocus Companion instance is reachable over its HTTP admin interface (default port 8000).';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = { ExtractVersion };
export { ID, Settings, Run, Debug };
