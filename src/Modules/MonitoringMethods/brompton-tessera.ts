// Brompton Tessera LED processor check (SX40, S8, S4, M2, T1, T8) over the
// Tessera IP Control API.
//
// Protocol (Brompton "Tessera Processing IP Control API", software 3.1.0, as
// shipped in Bitfocus companion-module-brompton-tessera/docs, cross-checked
// against that module's poller and the community OpenAPI transcription of
// API 3.4.3 in point-source/dart_brompton):
//   - HTTP on port 80 under the /api path root. GET reads, PUT (or ?set=) writes.
//     The check (Run) only ever reads. IP control must be enabled in the Live
//     Control tile of the processor UI; the API has no authentication.
//   - A GET returns the endpoint keyed by its own name, so GET /api/ returns the
//     whole tree as {"api": {...}}. One request per probe reads everything (this
//     is exactly how the Companion module polls).
//
// Fields read (paths below /api):
//   system/processor-name, processor-type, serial-number, software-version, uptime
//   system/temperature/**, system/fan/**     (newer firmware; see INFERRED below)
//   panels/statistics/{online,error,associated}-count  (3.1 docs; renamed
//     devices/statistics/... in 3.4; both are read)
//   override/blackout/enabled, override/freeze/enabled, override/test-pattern/enabled
//   input/active/source/{port-type,port-number}, input/active/resolution,
//   input/active/refresh-rate (3.1) or input/ports/<type>/<n>/meta-data (3.4)
//   presets/active/{name,number}, presets/items/<n>/name  (the preset list
//     offered to Recall Preset)
//   output/network/failover/{settings/enabled,state/is-partner-present,settings/role}
//   output/network/cable-redundancy/loops/<n>/state
//
// INFERRED (not in Brompton's 3.1 PDF nor the 3.4.3 OpenAPI transcription):
// processor-name, serial-number and the system/temperature and system/fan
// subtrees come from the Companion module's key list only, which shows the
// paths but not the values. Their units and formats are undocumented. The
// temperature check ASSUMES every numeric leaf is degrees Celsius (the setting
// says so), so it is off by default; fan status is shown but never judged
// because its vocabulary is unknown. The API also has no documented "signal
// present" flag; the input check therefore asserts the expected input format,
// and a missing format counts as no signal.
//
// Actions (documented writes, Tessera 3.1 PDF section 4 "SET (ENDPOINT)"):
// each sets one endpoint with the GET form `GET /api/<path>?set=<value>`. The
// PDF documents it beside `PUT {"data": ...}` and the 3.4.3 OpenAPI lists `set`
// on every writable GET; it is the form the Companion module sends, so it is
// the one proven against real processors, and it sidesteps the preset number
// being typed string in 3.1 but integer in 3.4. A refusal is HTTP 400 with an
// "error-messages" list.
//   override/blackout/enabled      true / false   (blackout.on / blackout.off)
//   override/freeze/enabled        true / false   (freeze.on / freeze.off)
//   override/test-pattern/enabled  false          (testpattern.off only)
//   presets/active/number          <n>            (preset.recall; 1–128 in 3.4)
//
// Result semantics:
//   - No HTTP answer, a non-200, or a body without the Tessera tree -> offline.
//   - Any enabled assertion breached                                -> degraded.
import {
  BuildBaseUrl,
  WithPath,
  RequestJson,
  IsObject,
  Dig,
  StrOrNull,
  NumOrNull,
  BoolOrNull,
  TimeoutOf,
  DeviceErrorText,
} from './_videoproc-http-shared';
import { Card, Esc, FormatLatency, Note, Pill, Row, Rows, TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type {
  MonitoringActionDef,
  MonitoringActionOptions,
  MonitoringActionResult,
  MonitoringResult,
  MonitoringSettingField,
  MonitoringTargetLike,
} from './types';

const ID = 'brompton-tessera';
const DEFAULT_TIMEOUT_MS = 5000;
const API_ROOT = '/api/';
// Actions answer quickly; a short budget keeps a press from hanging the panel.
const ACTION_TIMEOUT_MS = 5000;
const MAX_PRESET = 128;

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'Port',
    Type: 'number',
    Default: 80,
    Min: 1,
    Max: 65535,
    Advanced: true,
    Note: 'Tessera serves its IP control API on port 80.',
  },
  {
    Key: 'CheckPanels',
    Label: 'Check panels online',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded when fewer panels are online than expected.',
  },
  {
    Key: 'ExpectedPanels',
    Label: 'Expected panels',
    Type: 'number',
    Default: 0,
    Min: 0,
    Max: 4096,
    VisibleWhen: { Key: 'CheckPanels', Equals: true },
    Note: 'Leave at 0 to expect every panel the processor controls to be online.',
  },
  {
    Key: 'CheckPanelErrors',
    Label: 'Check panel errors',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded when any online panel reports an error state.',
  },
  {
    Key: 'CheckBlackout',
    Label: 'Check blackout',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded while blackout is on.',
  },
  {
    Key: 'CheckFreeze',
    Label: 'Check freeze',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded while the output is frozen.',
  },
  {
    Key: 'CheckTestPattern',
    Label: 'Check test pattern',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded while a test pattern is shown instead of the input.',
  },
  {
    Key: 'CheckInput',
    Label: 'Check input format',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when the active input does not report the expected format. No format at all is treated as no signal.',
  },
  {
    Key: 'ExpectedResolution',
    Label: 'Expected resolution',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'CheckInput', Equals: true },
    Note: 'Width x height, e.g. 3840x2160. Leave blank to only require that a format is reported.',
  },
  {
    Key: 'ExpectedRefreshRate',
    Label: 'Expected refresh rate (Hz)',
    Type: 'number',
    Default: 0,
    Min: 0,
    Max: 250,
    VisibleWhen: { Key: 'CheckInput', Equals: true },
    Note: 'e.g. 50 or 59.94. Leave at 0 to accept any rate. Matched to within 0.1 Hz.',
  },
  {
    Key: 'CheckTemperature',
    Label: 'Check temperatures',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when any processor temperature sensor reads above the limit. Needs Tessera firmware that reports temperatures. Brompton does not document the unit, so readings are taken to be °C.',
  },
  {
    Key: 'MaxTemperature',
    Label: 'Maximum temperature (°C)',
    Type: 'number',
    Default: 70,
    Min: 0,
    Max: 150,
    VisibleWhen: { Key: 'CheckTemperature', Equals: true },
  },
  {
    Key: 'CheckFailover',
    Label: 'Check failover partner',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when failover is enabled but the partner processor is not detected.',
  },
  {
    Key: 'CheckCableRedundancy',
    Label: 'Check cable redundancy',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when any redundant cable loop reports a state other than loop found. Enable only when loops are wired.',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: DEFAULT_TIMEOUT_MS,
    Min: 500,
    Max: 30000,
    Advanced: true,
  },
];

// --- Parsing ----------------------------------------------------------------

export interface TesseraTemperature {
  Name: string;
  Celsius: number;
}

export interface TesseraFan {
  Name: string;
  Status: string | null;
  Speed: number | null;
}

export interface TesseraSnapshot {
  ProcessorName: string | null;
  ProcessorType: string | null;
  Serial: string | null;
  SoftwareVersion: string | null;
  Uptime: string | null;
  PanelsOnline: number | null;
  PanelsWithErrors: number | null;
  PanelsAssociated: number | null;
  Blackout: boolean | null;
  Freeze: boolean | null;
  TestPattern: boolean | null;
  InputPortType: string | null;
  InputPortNumber: number | null;
  InputWidth: number | null;
  InputHeight: number | null;
  InputRefreshRate: number | null;
  PresetName: string | null;
  PresetNumber: string | null;
  Presets: Array<{ Number: number; Name: string | null }>;
  FailoverEnabled: boolean | null;
  FailoverRole: string | null;
  FailoverPartnerPresent: boolean | null;
  CableLoops: Array<{ Loop: string; State: string }>;
  Temperatures: TesseraTemperature[];
  Fans: TesseraFan[];
}

// Turn a nested key path into a readable sensor name: ethernet/sfp/a -> "Ethernet SFP A".
function SensorName(Parts: string[]): string {
  return Parts.map((Part) =>
    /^(cpu|gpu|dsp|fpga|psu|sfp)$/i.test(Part) || Part.length === 1
      ? Part.toUpperCase()
      : Part.charAt(0).toUpperCase() + Part.slice(1).replace(/-/g, ' ')
  ).join(' ');
}

// Every numeric leaf under system/temperature, whatever its depth.
function CollectTemperatures(Node: unknown, Prefix: string[], Out: TesseraTemperature[]): void {
  if (IsObject(Node)) {
    for (const [Key, Value] of Object.entries(Node)) {
      CollectTemperatures(Value, [...Prefix, Key], Out);
    }
    return;
  }
  const N = NumOrNull(Node);
  if (N != null && Prefix.length) Out.push({ Name: SensorName(Prefix), Celsius: N });
}

// Fans are objects carrying a status and/or speed leaf (system/fan/case/one/...).
function CollectFans(Node: unknown, Prefix: string[], Out: TesseraFan[]): void {
  if (!IsObject(Node)) return;
  if ('status' in Node || 'speed' in Node) {
    Out.push({
      Name: SensorName(Prefix),
      Status: StrOrNull(Node.status),
      Speed: NumOrNull(Node.speed),
    });
    return;
  }
  for (const [Key, Value] of Object.entries(Node)) CollectFans(Value, [...Prefix, Key], Out);
}

// The tree below "api", or null when the body is not a Tessera API tree.
function ApiTree(Json: unknown): Record<string, unknown> | null {
  if (!IsObject(Json)) return null;
  const Tree = IsObject(Json.api) ? Json.api : Json;
  // The system branch is present on every documented version; without it this
  // is some other web server.
  return IsObject(Tree.system) ? Tree : null;
}

function ParseSnapshot(Tree: Record<string, unknown>): TesseraSnapshot {
  const System = Tree.system as Record<string, unknown>;
  const Panels = IsObject(Dig(Tree, ['panels', 'statistics']))
    ? Dig(Tree, ['panels', 'statistics'])
    : Dig(Tree, ['devices', 'statistics']);

  const PortType = StrOrNull(Dig(Tree, ['input', 'active', 'source', 'port-type']));
  const PortNumber = NumOrNull(Dig(Tree, ['input', 'active', 'source', 'port-number']));
  // 3.1 reports the active format directly; 3.4 moved it under the port itself.
  let Width = NumOrNull(Dig(Tree, ['input', 'active', 'resolution', 'width']));
  let Height = NumOrNull(Dig(Tree, ['input', 'active', 'resolution', 'height']));
  let Rate = NumOrNull(Dig(Tree, ['input', 'active', 'refresh-rate']));
  if (Width == null && PortType && PortNumber != null) {
    const Meta = Dig(Tree, [
      'input',
      'ports',
      PortType.toLowerCase(),
      String(PortNumber),
      'meta-data',
    ]);
    Width = NumOrNull(Dig(Meta, ['resolution', 'width']));
    Height = NumOrNull(Dig(Meta, ['resolution', 'height']));
    Rate = NumOrNull(Dig(Meta, ['refresh-rate']));
  }

  const Loops: Array<{ Loop: string; State: string }> = [];
  const LoopTree = Dig(Tree, ['output', 'network', 'cable-redundancy', 'loops']);
  if (IsObject(LoopTree)) {
    for (const [Loop, Value] of Object.entries(LoopTree)) {
      const State = StrOrNull(Dig(Value, ['state']));
      if (State) Loops.push({ Loop, State });
    }
  }

  // The project's presets, numbered by their key under presets/items.
  const Presets: Array<{ Number: number; Name: string | null }> = [];
  const PresetTree = Dig(Tree, ['presets', 'items']);
  if (IsObject(PresetTree)) {
    for (const [Key, Value] of Object.entries(PresetTree)) {
      const N = Number(Key);
      if (!Number.isInteger(N) || N < 1) continue;
      Presets.push({ Number: N, Name: StrOrNull(Dig(Value, ['name'])) });
    }
    Presets.sort((A, B) => A.Number - B.Number);
  }

  const Temperatures: TesseraTemperature[] = [];
  CollectTemperatures(System.temperature, [], Temperatures);
  const Fans: TesseraFan[] = [];
  CollectFans(System.fan, [], Fans);

  const Failover = ['output', 'network', 'failover'];
  return {
    ProcessorName: StrOrNull(System['processor-name']),
    ProcessorType: StrOrNull(System['processor-type']),
    Serial: StrOrNull(System['serial-number']),
    SoftwareVersion: StrOrNull(System['software-version']),
    Uptime: StrOrNull(System.uptime),
    PanelsOnline: NumOrNull(Dig(Panels, ['online-count'])),
    PanelsWithErrors: NumOrNull(Dig(Panels, ['error-count'])),
    PanelsAssociated: NumOrNull(Dig(Panels, ['associated-count'])),
    Blackout: BoolOrNull(Dig(Tree, ['override', 'blackout', 'enabled'])),
    Freeze: BoolOrNull(Dig(Tree, ['override', 'freeze', 'enabled'])),
    TestPattern: BoolOrNull(Dig(Tree, ['override', 'test-pattern', 'enabled'])),
    InputPortType: PortType,
    InputPortNumber: PortNumber,
    InputWidth: Width,
    InputHeight: Height,
    InputRefreshRate: Rate,
    PresetName: StrOrNull(Dig(Tree, ['presets', 'active', 'name'])),
    PresetNumber: StrOrNull(Dig(Tree, ['presets', 'active', 'number'])),
    Presets,
    FailoverEnabled: BoolOrNull(Dig(Tree, [...Failover, 'settings', 'enabled'])),
    FailoverRole: StrOrNull(Dig(Tree, [...Failover, 'settings', 'role'])),
    FailoverPartnerPresent: BoolOrNull(Dig(Tree, [...Failover, 'state', 'is-partner-present'])),
    CableLoops: Loops,
    Temperatures,
    Fans,
  };
}

// --- Verdict ----------------------------------------------------------------

function ParseResolution(Value: unknown): { W: number; H: number } | null {
  const Match = String(Value == null ? '' : Value)
    .trim()
    .match(/^(\d+)\s*[x×*]\s*(\d+)$/i);
  return Match ? { W: Number(Match[1]), H: Number(Match[2]) } : null;
}

// The reasons a reachable processor is unhealthy, per the enabled toggles.
// Unreported readings are skipped rather than failed, except where the reading
// is the thing being asserted (the input format). Pure; exported for tests.
function EvaluateHealth(Snap: TesseraSnapshot, Cfg: Record<string, unknown>): string[] {
  const Reasons: string[] = [];

  if (Cfg.CheckPanels !== false) {
    const Expected = Number(Cfg.ExpectedPanels) > 0 ? Number(Cfg.ExpectedPanels) | 0 : null;
    const Want = Expected != null ? Expected : Snap.PanelsAssociated;
    if (Snap.PanelsOnline == null) {
      if (Expected != null) Reasons.push('Processor did not report a panel count');
    } else if (Want != null && Snap.PanelsOnline < Want) {
      Reasons.push(`${Snap.PanelsOnline} of ${Want} panels online`);
    }
  }

  if (
    Cfg.CheckPanelErrors !== false &&
    Snap.PanelsWithErrors != null &&
    Snap.PanelsWithErrors > 0
  ) {
    Reasons.push(
      `${Snap.PanelsWithErrors} ${Snap.PanelsWithErrors === 1 ? 'panel' : 'panels'} reporting errors`
    );
  }

  if (Cfg.CheckBlackout && Snap.Blackout === true) Reasons.push('Blackout on');
  if (Cfg.CheckFreeze && Snap.Freeze === true) Reasons.push('Output frozen');
  if (Cfg.CheckTestPattern && Snap.TestPattern === true) Reasons.push('Test pattern on');

  if (Cfg.CheckInput) {
    if (Snap.InputWidth == null || Snap.InputHeight == null) {
      Reasons.push('No input signal');
    } else {
      const Want = ParseResolution(Cfg.ExpectedResolution);
      if (Want && (Want.W !== Snap.InputWidth || Want.H !== Snap.InputHeight)) {
        Reasons.push(`Input ${Snap.InputWidth}x${Snap.InputHeight} (expected ${Want.W}x${Want.H})`);
      }
      const WantRate = Number(Cfg.ExpectedRefreshRate);
      if (Number.isFinite(WantRate) && WantRate > 0) {
        if (Snap.InputRefreshRate == null) Reasons.push('Input refresh rate not reported');
        else if (Math.abs(Snap.InputRefreshRate - WantRate) > 0.1) {
          Reasons.push(`Input ${Snap.InputRefreshRate} Hz (expected ${WantRate} Hz)`);
        }
      }
    }
  }

  if (Cfg.CheckTemperature) {
    const Limit = Number.isFinite(Number(Cfg.MaxTemperature)) ? Number(Cfg.MaxTemperature) : 70;
    for (const T of Snap.Temperatures) {
      if (T.Celsius > Limit) Reasons.push(`${T.Name} ${T.Celsius} °C (limit ${Limit} °C)`);
    }
  }

  if (Cfg.CheckFailover && Snap.FailoverEnabled === true && Snap.FailoverPartnerPresent === false) {
    Reasons.push('Failover partner not detected');
  }

  if (Cfg.CheckCableRedundancy) {
    for (const L of Snap.CableLoops) {
      if (L.State.toLowerCase() !== 'loop-found') Reasons.push(`Cable loop ${L.Loop}: ${L.State}`);
    }
  }

  return Reasons;
}

// --- Run --------------------------------------------------------------------

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number.isFinite(Number(Cfg.Port)) ? Number(Cfg.Port) | 0 : 80;
  const Base = BuildBaseUrl(Target && Target.Address, 'http', Port > 0 ? Port : 80);
  if (!Base) return { Success: false, Error: 'No address configured' };

  const Started = Date.now();
  const DeadlineAt = Started + TimeoutOf(Cfg, DEFAULT_TIMEOUT_MS);
  const Res = await RequestJson(WithPath(Base, API_ROOT), { Method: 'GET', DeadlineAt });
  if (!Res.Ok) return { Success: false, Error: Res.Error };
  if (Res.Status !== 200) {
    return {
      Success: false,
      Error: `HTTP ${Res.Status} from /api/. Check IP control is enabled in the Live Control tile.`,
    };
  }
  const Tree = ApiTree(Res.Json);
  if (!Tree) return { Success: false, Error: 'Answered, but not with the Tessera IP control API' };

  const Snap = ParseSnapshot(Tree);
  const Reasons = EvaluateHealth(Snap, Cfg);
  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs: Date.now() - Started,
    ...Snap,
  };
}

// --- Actions ----------------------------------------------------------------

const PRESET_PARAM: MonitoringSettingField = {
  Key: 'Preset',
  Label: 'Preset',
  Type: 'number',
  Required: true,
  Note: 'The preset number as shown in Tessera. The check lists the presets this processor reports.',
};

const Actions: MonitoringActionDef[] = [
  {
    ID: 'blackout.on',
    Label: 'Blackout',
    Icon: 'circle',
    Group: 'Output',
    Destructive: true,
    Note: 'Fades the whole LED wall to black, using the blackout fade time set in Tessera.',
  },
  {
    ID: 'blackout.off',
    Label: 'Clear Blackout',
    Icon: 'circle',
    Group: 'Output',
    Note: 'Brings the picture back.',
  },
  {
    ID: 'freeze.on',
    Label: 'Freeze',
    Icon: 'pause-circle',
    Group: 'Output',
    Destructive: true,
    Note: 'Holds the current frame on the wall until freeze is cleared.',
  },
  {
    ID: 'freeze.off',
    Label: 'Unfreeze',
    Icon: 'play-circle',
    Group: 'Output',
    Note: 'Returns the wall to live video.',
  },
  {
    ID: 'testpattern.off',
    Label: 'Test Pattern Off',
    Icon: 'grid-3x3',
    Group: 'Output',
    Note: 'Turns off a test pattern left running, returning the wall to its input.',
  },
  {
    ID: 'preset.recall',
    Label: 'Recall Preset',
    Icon: 'collection-play',
    Group: 'Presets',
    Destructive: true,
    Params: [PRESET_PARAM],
    Note: 'Activates a processor preset. This can change the input, brightness and colour on the wall.',
  },
];

// Endpoint and value for each fixed action.
const ACTION_WRITES: Record<string, { Path: string; Value: string; Detail: string }> = {
  'blackout.on': { Path: 'override/blackout/enabled', Value: 'true', Detail: 'Blackout on' },
  'blackout.off': { Path: 'override/blackout/enabled', Value: 'false', Detail: 'Blackout off' },
  'freeze.on': { Path: 'override/freeze/enabled', Value: 'true', Detail: 'Output frozen' },
  'freeze.off': { Path: 'override/freeze/enabled', Value: 'false', Detail: 'Output unfrozen' },
  'testpattern.off': {
    Path: 'override/test-pattern/enabled',
    Value: 'false',
    Detail: 'Test pattern off',
  },
};

function ParsePresetNumber(Value: unknown): number | null {
  const N = Number(String(Value == null ? '' : Value).trim());
  return Number.isInteger(N) && N >= 1 && N <= MAX_PRESET ? N : null;
}

async function RunAction(
  Target: MonitoringTargetLike,
  ActionID: string,
  Params: Record<string, unknown> = {}
): Promise<MonitoringActionResult> {
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number.isFinite(Number(Cfg.Port)) ? Number(Cfg.Port) | 0 : 80;
  const Base = BuildBaseUrl(Target && Target.Address, 'http', Port > 0 ? Port : 80);
  if (!Base) return { Success: false, Error: 'No address configured' };

  let Path: string;
  let Value: string;
  let Detail: string;
  const Fixed = ACTION_WRITES[ActionID];
  if (Fixed) {
    ({ Path, Value, Detail } = Fixed);
  } else if (ActionID === 'preset.recall') {
    const Preset = ParsePresetNumber(Params.Preset);
    if (Preset == null) {
      return { Success: false, Error: `Preset must be a whole number from 1 to ${MAX_PRESET}` };
    }
    Path = 'presets/active/number';
    Value = String(Preset);
    Detail = `Preset ${Preset} recalled`;
  } else {
    return { Success: false, Error: `Unknown Brompton Tessera action "${ActionID}"` };
  }

  const DeadlineAt = Date.now() + Math.min(TimeoutOf(Cfg, DEFAULT_TIMEOUT_MS), ACTION_TIMEOUT_MS);
  const Res = await RequestJson(
    WithPath(Base, `${API_ROOT}${Path}?set=${encodeURIComponent(Value)}`),
    {
      Method: 'GET',
      DeadlineAt,
    }
  );
  if (!Res.Ok) return { Success: false, Error: Res.Error };
  if (Res.Status !== 200) {
    const Why = DeviceErrorText(Res.Json, Res.Body);
    return {
      Success: false,
      Error: `The processor refused the change (HTTP ${Res.Status})${Why ? `: ${Why}` : ''}`,
    };
  }
  return { Success: true, Detail };
}

// Offer the presets the processor listed under presets/items, by number and name.
function GetActionOptions(Result: MonitoringResult): MonitoringActionOptions {
  const Presets = Array.isArray(Result && Result.Presets)
    ? (Result.Presets as Array<{ Number: number; Name: string | null }>)
    : [];
  if (!Presets.length) return {};
  return {
    Preset: Presets.map((P) => ({
      value: String(P.Number),
      label: P.Name ? `${P.Number} · ${P.Name}` : `Preset ${P.Number}`,
    })),
  };
}

function DescribeAction(ActionID: string, Params: Record<string, unknown>): string | null {
  if (ActionID !== 'preset.recall') return null;
  const Preset = ParsePresetNumber(Params && Params.Preset);
  return Preset == null ? null : `Recall Preset ${Preset}`;
}

// --- Debug ------------------------------------------------------------------

function StatePill(Result: MonitoringResult): string {
  const Reachable = !!(Result && Result.Success === true);
  if (Reachable && !Result.Degraded) return Pill('success', 'Healthy');
  if (Reachable) return Pill('warning', Result.DegradedReason || 'Degraded');
  return Pill('danger', 'Offline');
}

function OnOffPill(Value: unknown, OnKind: string): string {
  if (Value === true) return Pill(OnKind, 'On');
  if (Value === false) return Pill('success', 'Off');
  return Pill('muted', 'Unknown');
}

function Mono(Value: unknown): string {
  return `<span class="font-monospace">${Esc(Value)}</span>`;
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  const Reachable = !!(Result && Result.Success === true);
  const R = (Result || {}) as Partial<TesseraSnapshot> & MonitoringResult;

  const Model = [R.ProcessorType ? String(R.ProcessorType).toUpperCase() : null, R.Serial]
    .filter(Boolean)
    .join(' · ');
  const Format =
    R.InputWidth != null && R.InputHeight != null
      ? `${R.InputWidth}x${R.InputHeight}${R.InputRefreshRate != null ? ` @ ${R.InputRefreshRate} Hz` : ''}`
      : 'No signal';
  const Port = R.InputPortType
    ? `${String(R.InputPortType).toUpperCase()}${R.InputPortNumber != null ? ` ${R.InputPortNumber}` : ''}`
    : null;

  const Head = Rows([
    TextRow('Processor', `${Address || '-'}${R.ProcessorName ? ` (${R.ProcessorName})` : ''}`),
    Row('Status', StatePill(Result)),
    Reachable
      ? Row('Reply time', Mono(FormatLatency(R.LatencyMs)))
      : TextRow('Error', (Result && Result.Error) || 'Failed to reach the processor'),
    Reachable && Model ? TextRow('Model', Model) : null,
    Reachable && R.SoftwareVersion ? Row('Software', Mono(R.SoftwareVersion)) : null,
    Reachable && R.Uptime ? TextRow('Uptime', R.Uptime) : null,
    Reachable ? TextRow('Input', Port ? `${Port}: ${Format}` : Format) : null,
    Reachable && R.PanelsOnline != null
      ? TextRow(
          'Panels',
          `${R.PanelsOnline} online${R.PanelsAssociated != null ? ` of ${R.PanelsAssociated}` : ''}` +
            (R.PanelsWithErrors ? `, ${R.PanelsWithErrors} with errors` : '')
        )
      : null,
    Reachable ? Row('Blackout', OnOffPill(R.Blackout, 'warning')) : null,
    Reachable ? Row('Freeze', OnOffPill(R.Freeze, 'warning')) : null,
    Reachable && R.TestPattern != null
      ? Row('Test pattern', OnOffPill(R.TestPattern, 'warning'))
      : null,
    Reachable && (R.PresetName || R.PresetNumber)
      ? TextRow('Active preset', [R.PresetNumber, R.PresetName].filter(Boolean).join(' · '))
      : null,
    Reachable && R.FailoverEnabled
      ? Row(
          'Failover partner',
          R.FailoverPartnerPresent
            ? Pill('success', 'Present')
            : R.FailoverPartnerPresent === false
              ? Pill('warning', 'Absent')
              : Pill('muted', 'Unknown')
        )
      : null,
  ]);
  if (!Reachable) {
    return (
      Head +
      '<div class="mt-2">' +
      Note(
        'Failed to read the Tessera IP control API. Check it is enabled in the Live Control tile.'
      ) +
      '</div>'
    );
  }

  const Cards: string[] = [];
  for (const L of Array.isArray(R.CableLoops) ? R.CableLoops : []) {
    const Good = String(L.State).toLowerCase() === 'loop-found';
    Cards.push(
      Card({
        Title: `Cable loop ${L.Loop}`,
        Badge: Pill(Good ? 'success' : 'warning', L.State),
      })
    );
  }
  for (const T of Array.isArray(R.Temperatures) ? R.Temperatures : []) {
    Cards.push(Card({ Title: T.Name, Badge: Pill('muted', `${T.Celsius} °C`) }));
  }
  for (const F of Array.isArray(R.Fans) ? R.Fans : []) {
    const Text = [F.Status, F.Speed != null ? `${F.Speed}` : null].filter(Boolean).join(' · ');
    Cards.push(Card({ Title: `${F.Name} fan`, Badge: Pill('muted', Text || 'Unknown') }));
  }
  return Cards.length ? Head + `<div class="d-grid gap-1 mt-2">${Cards.join('')}</div>` : Head;
}

export const Name = 'Brompton Tessera';
export const Description =
  'Reads a Brompton Tessera LED processor over its HTTP IP control API: model, software, input format, panel counts, blackout, freeze and test pattern, active preset, failover and temperatures. Optionally flags missing or erroring panels, overrides, an unexpected input format and hot sensors. The check only reads; blackout, freeze, test pattern off and preset recall are offered as actions.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ApiTree,
  ParseSnapshot,
  EvaluateHealth,
  ParseResolution,
  SensorName,
  ParsePresetNumber,
};
export { ID, Settings, Actions, Run, RunAction, GetActionOptions, DescribeAction, Debug };
