// Resolume Arena / Avenue (7+) status check via its built-in REST API.
//
// Resolume exposes a REST API + webserver (enable it under Preferences ->
// Webserver). Arena and Avenue listen on HTTP port 8080 by default; the API is
// rooted at "http://<host>:8080/api/v1/". It is plain HTTP only by default
// (there is no built-in HTTPS listener), so this check does not offer a
// protocol toggle.
//
// Endpoints + exact JSON field paths (confirmed against the official Arena &
// Avenue REST API OpenAPI schema, resolume.com/docs/restapi/, mirrored as
// swagger.yaml in white-tie-live/resolume-js):
//   GET /api/v1/product      -> ProductInfo:
//        .name   (string, either "Arena" or "Avenue")
//        .major, .minor, .micro, .revision (integers) -> version "major.minor.micro"
//   GET /api/v1/composition  -> Composition:
//        .name  is a StringParameter object; the human-readable composition
//        name lives at  .name.value  (string).
//
// Mapping:
//   Online   -> GET /api/v1/product returns a valid ProductInfo JSON (reachable).
//               If ExpectedComposition is empty, that alone is Online (product
//               name + version + LatencyMs). If ExpectedComposition is set, we
//               also GET /api/v1/composition and its name matches -> Online.
//   Degraded -> reachable, but the current composition name does not match the
//               configured ExpectedComposition (Success:true, Degraded:true,
//               DegradedReason:'Wrong composition', actual name included).
//   Offline  -> no HTTP response / connection refused / timeout / non-2xx /
//               invalid JSON (Success:false, Error).
import { PerformHttpRequest, BuildHttpDebug } from './_http-shared';
import { Pill, Rows, TextRow, Row, JsonCodeBlock } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'resolume-status';

const PRODUCT_PATH = '/api/v1/product';
const COMPOSITION_PATH = '/api/v1/composition';

const Settings: MonitoringSettingField[] = [
  { Key: 'Port', Label: 'Port', Type: 'number', Default: 8080, Min: 1, Max: 65535, Required: true },
  {
    Key: 'ExpectedComposition',
    Label: 'Expected Composition',
    Type: 'string',
    Default: '',
    Note: 'Degraded when a different composition is open. Leave blank to confirm only that Resolume is reachable.',
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

// Build a derived target that points the shared HTTP helper at one of the
// fixed Resolume endpoints while carrying over the user's Port/Timeout. We pin
// the accepted status window to 2xx so any non-2xx reply is shaped as Offline.
function BuildRequestTarget(Target: MonitoringTargetLike, Path: string): MonitoringTargetLike {
  const Cfg = (Target && Target.Settings) || {};
  return {
    Address: Target && Target.Address,
    Settings: {
      ...Cfg,
      Path,
      Method: 'GET',
      ExpectedStatusMin: 200,
      ExpectedStatusMax: 299,
    },
  };
}

// Parse GET /api/v1/product. Returns { Name, Version } for a valid ProductInfo
// body (a "name" string is the validity signal), or null for anything that is
// not a recognisable product response.
function ParseProduct(Body: unknown): { Name: string; Version: string } | null {
  let Parsed: unknown;
  try {
    Parsed = JSON.parse(String(Body == null ? '' : Body));
  } catch (_e) {
    return null;
  }
  if (!Parsed || typeof Parsed !== 'object') return null;
  const Obj = Parsed as Record<string, unknown>;
  const Name = typeof Obj.name === 'string' ? Obj.name : '';
  if (!Name) return null;
  const Parts = [Obj.major, Obj.minor, Obj.micro].filter((N) => Number.isFinite(N));
  const Version = Parts.length ? Parts.join('.') : '';
  return { Name, Version };
}

// Parse GET /api/v1/composition and extract the composition name from the
// StringParameter at .name.value. Returns null when the body is not valid JSON
// or has no name.value.
function ParseCompositionName(Body: unknown): string | null {
  let Parsed: unknown;
  try {
    Parsed = JSON.parse(String(Body == null ? '' : Body));
  } catch (_e) {
    return null;
  }
  if (!Parsed || typeof Parsed !== 'object') return null;
  const NameParam = (Parsed as Record<string, unknown>).name;
  if (NameParam && typeof NameParam === 'object') {
    const Value = (NameParam as Record<string, unknown>).value;
    if (typeof Value === 'string') return Value;
  }
  return null;
}

// Trimmed exact comparison of the running composition name against the operator
// expectation.
function CompositionMatches(Actual: unknown, Expected: unknown): boolean {
  const A = String(Actual == null ? '' : Actual).trim();
  const E = String(Expected == null ? '' : Expected).trim();
  return A === E;
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Address = Target && Target.Address;
  if (!Address) return { Success: false, Error: 'No address configured' };

  const Cfg = (Target && Target.Settings) || {};
  const ExpectedComposition =
    Cfg.ExpectedComposition == null ? '' : String(Cfg.ExpectedComposition).trim();

  // 1) Product probe -> reachability.
  const ProductResult = await PerformHttpRequest(BuildRequestTarget(Target, PRODUCT_PATH), {
    Protocol: 'http',
    DefaultPort: 8080,
    CaptureBody: true,
  });
  if (!ProductResult.Success) {
    return {
      Success: false,
      Error: ProductResult.Error || 'Resolume not reachable',
      Status: ProductResult.Status,
    };
  }

  const Product = ParseProduct(ProductResult.Body);
  if (!Product) {
    return {
      Success: false,
      Error: 'Resolume product response was not valid JSON',
      Status: ProductResult.Status,
    };
  }

  const Out: MonitoringResult = {
    Success: true,
    LatencyMs: ProductResult.LatencyMs,
    Status: ProductResult.Status,
    ProductName: Product.Name,
    Version: Product.Version,
    ProductBody: ProductResult.Body,
  };

  // No composition assertion configured -> reachable is Online.
  if (!ExpectedComposition) return Out;

  // 2) Composition probe -> assert the running composition name.
  const CompResult = await PerformHttpRequest(BuildRequestTarget(Target, COMPOSITION_PATH), {
    Protocol: 'http',
    DefaultPort: 8080,
    CaptureBody: true,
  });
  if (!CompResult.Success) {
    return {
      Success: false,
      Error: CompResult.Error || 'Resolume composition not reachable',
      Status: CompResult.Status,
    };
  }

  const CurrentComposition = ParseCompositionName(CompResult.Body);
  if (CurrentComposition === null) {
    return {
      Success: false,
      Error: 'Resolume composition response was not valid JSON',
      Status: CompResult.Status,
    };
  }

  Out.ExpectedComposition = ExpectedComposition;
  Out.CurrentComposition = CurrentComposition;
  Out.CompositionBody = CompResult.Body;

  if (!CompositionMatches(CurrentComposition, ExpectedComposition)) {
    Out.Degraded = true;
    Out.DegradedReason = 'Wrong composition';
  }
  return Out;
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  // Reuse the shared HTTP summary, pinned to the product endpoint for the
  // request line.
  let Html = BuildHttpDebug(Result, BuildRequestTarget(Target, PRODUCT_PATH), { Protocol: 'http' });

  if (!Result || !Result.Success) return Html;

  const Extra: Array<string | null> = [];
  // All of these values are network-derived; TextRow escapes them for us.
  if (Result.ProductName) Extra.push(TextRow('Product', String(Result.ProductName)));
  if (Result.Version) Extra.push(TextRow('Version', String(Result.Version)));

  if (Object.prototype.hasOwnProperty.call(Result, 'ExpectedComposition')) {
    Extra.push(TextRow('Current composition', String(Result.CurrentComposition ?? '—')));
    Extra.push(TextRow('Expected composition', String(Result.ExpectedComposition ?? '—')));
    const Matched = !Result.Degraded;
    Extra.push(
      Row(
        'Composition',
        Pill(Matched ? 'success' : 'warning', Matched ? 'Match' : 'Wrong composition')
      )
    );
  }

  // Show the captured composition JSON if we fetched it, otherwise the product.
  const Body = Result.CompositionBody || Result.ProductBody;
  if (Body) {
    Extra.push(`<div class="mt-2"><span class="text-muted small">Response Body:</span></div>`);
    Extra.push(JsonCodeBlock(Body));
  }

  if (Extra.length) Html += Rows(Extra);
  return Html;
}

export const Name = 'Resolume';
export const Description =
  'Checks that a Resolume Arena/Avenue instance is reachable over its REST API (default port 8080), optionally asserting the open composition name.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = { ParseProduct, ParseCompositionName, CompositionMatches };
export { ID, Settings, Run, Debug };
