// What a FreeKiosk terminal monitors, drawn on the section tabs (Content,
// Screen, Battery, Network, Misc) the way a ShowTrak client's monitored items
// are: one card per registry section with a Monitor toggle in its header over a
// table of its readings' current values (always shown), each row gaining the
// condition it alerts on and a tick once the section is monitored.
//
// Pure and DOM-free. The card is a function of the metric catalogue and the
// terminal; the settings a row or toggle saves are built here too, so the keys
// and value types match exactly what the server's alarm engine reads (the same
// shapes the old schema-driven form wrote: booleans for the switches, numbers
// for numeric thresholds, strings for everything off a <select> or text box).
import type {
  FreeKioskDisplayMode,
  FreeKioskMetricCatalog,
  FreeKioskMetricGroupView,
  FreeKioskMetricView,
  MonitoringSettingField,
} from '@showtrak/protocol';
import { FormatMetricValue } from './metric-format';

type Settings = Record<string, unknown>;

// Mirrors EDGE_OPERATORS / RANGE_OPERATORS in src/Modules/FreeKiosk/metrics.
const EDGE_OPERATORS = ['changes', 'decreases'];
const RANGE_OPERATORS = ['outside', 'inside'];

// Fallback wording, used only if the catalogue's operator field is missing.
// Mirrors OPERATOR_LABELS in src/Modules/FreeKiosk/metrics: each stored (breach)
// operator worded as the expectation it breaks, read after "Expected".
const OPERATOR_LABELS: Record<string, string> = {
  below: 'At least',
  above: 'At most',
  outside: 'Between',
  inside: 'Not between',
  is: 'Is not',
  isNot: 'Is',
  contains: 'Does not contain',
  notContains: 'Contains',
  changes: 'Stays the same',
  decreases: 'Never goes backwards',
};

/** Settings key for a section's monitoring switch. Mirrors GroupFieldKey. */
export function FreeKioskGroupFieldKey(Section: string): string {
  return `G_${Section}_On`;
}

/** The settings keys of one metric's alarm. Mirrors AlarmFieldKeys. */
export function FreeKioskAlarmKeys(MetricKey: string): {
  On: string;
  Op: string;
  V: string;
  V2: string;
} {
  return {
    On: `A_${MetricKey}_On`,
    Op: `A_${MetricKey}_Op`,
    V: `A_${MetricKey}_V`,
    V2: `A_${MetricKey}_V2`,
  };
}

function AsSettings(Value: unknown): Settings {
  return (Value && typeof Value === 'object' ? Value : {}) as Settings;
}

/**
 * Is this section being monitored? Absent reads as enabled, matching the
 * server: a show file written before groups existed has no `G_*` keys.
 */
export function IsGroupEnabled(
  Groups: readonly FreeKioskMetricGroupView[] | null | undefined,
  Settings: unknown,
  Section: string
): boolean {
  const Group = (Groups || []).find((Entry) => Entry.Key === Section);
  if (Group && Group.Fixed) return true;
  const Stored = AsSettings(Settings)[FreeKioskGroupFieldKey(Section)];
  if (Stored === undefined || Stored === null || Stored === '') return true;
  if (typeof Stored === 'boolean') return Stored;
  const Text = String(Stored).trim().toLowerCase();
  return !(Text === 'false' || Text === '0' || Text === 'no');
}

/** The declared display mode. Mirrors GetDisplayMode; absent reads as WebView. */
export function DisplayModeOf(Settings: unknown): FreeKioskDisplayMode {
  const Stored = String(AsSettings(Settings).DisplayMode ?? '').trim();
  return Stored === 'external_app' || Stored === 'media_player' || Stored === 'webview'
    ? Stored
    : 'webview';
}

/** Does this reading mean anything in the terminal's declared mode? */
export function MetricAppliesInMode(
  Settings: unknown,
  Metric: Pick<FreeKioskMetricView, 'RequiresMode'>
): boolean {
  if (!Metric.RequiresMode || !Metric.RequiresMode.length) return true;
  return Metric.RequiresMode.includes(DisplayModeOf(Settings));
}

function IsTrue(Value: unknown): boolean {
  return Value === true || Value === 'true';
}

// ---- The card ---------------------------------------------------------------

export interface FreeKioskConditionOption {
  Value: string;
  Label: string;
}

export interface FreeKioskConditionInput {
  Kind: 'number' | 'select' | 'text';
  Value: string;
  /** Used when the box is ticked with nothing typed. */
  Default: string;
  Options?: FreeKioskConditionOption[];
  Min?: number;
  Max?: number;
}

export interface FreeKioskConditionRow {
  Key: string;
  Label: string;
  Note?: string;
  /** The current reading, formatted. */
  ValueText: string;
  /** False for readings that are shown but cannot be alerted on. */
  Alarmable: boolean;
  Checked: boolean;
  /** A picker is drawn only when there is more than one to choose from. */
  Operators: FreeKioskConditionOption[];
  Operator: string;
  /**
   * The words before the value. "Expected" ahead of a picker; the whole
   * expectation ("Expected", "Expected at least") when there is nothing to pick.
   */
  OperatorText: string;
  Input: FreeKioskConditionInput | null;
  Input2: FreeKioskConditionInput | null;
  Unit: string;
  /** The value input is hidden for an edge operator (Changes, Goes backwards). */
  ShowInput: boolean;
  /** The upper bound shows only for a range operator. */
  ShowInput2: boolean;
  Breaching: boolean;
}

export interface FreeKioskCardBadge {
  State: 'plain' | 'healthy' | 'issue' | 'locked';
  Label: string;
  Icon: string;
  Title: string;
}

export interface FreeKioskMonitorCard {
  Section: string;
  Title: string;
  Note?: string;
  Fixed: boolean;
  Monitored: boolean;
  Badge: FreeKioskCardBadge;
  Summary: string;
  /** How many of the section's readings the display mode removed. */
  HiddenByMode: number;
  /**
   * Every applicable reading, monitored or not — the current values are always
   * visible. The condition and tick columns are drawn only while monitored.
   */
  Rows: FreeKioskConditionRow[];
}

export interface FreeKioskCardTerminal {
  Settings?: Settings | null;
  Metrics?: Record<string, string | number | boolean | null> | null;
  Alarms?: Array<{ Key?: string } | null> | null;
  Online?: boolean;
}

function FieldsByKey(Catalogue: FreeKioskMetricCatalog): Map<string, MonitoringSettingField> {
  return new Map((Catalogue.AlarmFields || []).map((Field) => [Field.Key, Field]));
}

function NormaliseOptions(
  Options: MonitoringSettingField['Options']
): FreeKioskConditionOption[] | undefined {
  if (!Array.isArray(Options)) return undefined;
  return Options.map((Option) =>
    typeof Option === 'string'
      ? { Value: Option, Label: Option }
      : { Value: String(Option.value), Label: String(Option.label ?? Option.value) }
  );
}

function Text(Value: unknown): string {
  if (Value === undefined || Value === null) return '';
  if (typeof Value === 'object') return '';
  return String(Value);
}

function InputFor(
  Field: MonitoringSettingField | undefined,
  Stored: unknown
): FreeKioskConditionInput | null {
  if (!Field) return null;
  const Kind = Field.Type === 'number' ? 'number' : Field.Type === 'select' ? 'select' : 'text';
  const Default = Text(Field.Default);
  const Has = Stored !== undefined && Stored !== null && Stored !== '';
  return {
    Kind,
    Value: Has ? Text(Stored) : Default,
    Default,
    Options: Kind === 'select' ? NormaliseOptions(Field.Options) : undefined,
    Min: Field.Min,
    Max: Field.Max,
  };
}

/** The operator a row is armed with: the stored one if valid, else its default. */
export function ResolveOperator(
  Metric: FreeKioskMetricView,
  OpField: MonitoringSettingField | undefined,
  Stored: unknown
): string {
  const Ops = Metric.Operators as string[];
  if (typeof Stored === 'string' && Ops.includes(Stored)) return Stored;
  const Default = OpField ? Text(OpField.Default) : '';
  if (Default && Ops.includes(Default)) return Default;
  return String(Metric.DefaultOperator || Ops[0] || '');
}

export function BuildConditionRow(
  Catalogue: FreeKioskMetricCatalog,
  Terminal: FreeKioskCardTerminal,
  Metric: FreeKioskMetricView,
  Fields: Map<string, MonitoringSettingField> = FieldsByKey(Catalogue)
): FreeKioskConditionRow {
  const Settings = AsSettings(Terminal.Settings);
  const Keys = FreeKioskAlarmKeys(Metric.Key);
  const Value = (Terminal.Metrics || {})[Metric.Key] ?? null;
  const Alarmable = Metric.Operators.length > 0;
  const OpField = Fields.get(Keys.Op);
  const Operator = ResolveOperator(Metric, OpField, Settings[Keys.Op]);
  const Operators =
    Metric.Operators.length > 1
      ? NormaliseOptions(OpField?.Options) ||
        Metric.Operators.map((Op) => ({ Value: Op, Label: OPERATOR_LABELS[Op] || Op }))
      : [];
  // Every condition is read as an expectation, so every row opens with
  // "Expected". A lone "is not" needs nothing more — its value IS the expected
  // state ("Expected Yes"); any other lone operator is named after it
  // ("Expected at least").
  const LoneLabel = OPERATOR_LABELS[Operator] || Operator;
  const OperatorText = !Alarmable
    ? ''
    : Operators.length || Operator === 'isNot'
      ? 'Expected'
      : `Expected ${LoneLabel.toLowerCase()}`;
  const Input = InputFor(Fields.get(Keys.V), Settings[Keys.V]);
  const Input2 = InputFor(Fields.get(Keys.V2), Settings[Keys.V2]);
  const Breaching =
    !!Terminal.Online && (Terminal.Alarms || []).some((Entry) => Entry?.Key === Metric.Key);
  return {
    Key: Metric.Key,
    Label: Metric.Label,
    Note: Metric.Note,
    ValueText: FormatMetricValue(Metric, Value),
    Alarmable,
    Checked: Alarmable && IsTrue(Settings[Keys.On]),
    Operators,
    Operator,
    OperatorText,
    Input,
    Input2,
    // Thresholds are entered in their own unit where one is declared (uptime in
    // days), otherwise the reading's raw unit (storage in MB), whatever the
    // reading's display format.
    Unit: Metric.ThresholdUnit || Metric.Unit || '',
    ShowInput: !!Input && !EDGE_OPERATORS.includes(Operator),
    ShowInput2: !!Input2 && RANGE_OPERATORS.includes(Operator),
    Breaching,
  };
}

function CardBadge(Fixed: boolean, Monitored: boolean, HasIssue: boolean, Title: string) {
  if (Fixed) {
    return {
      State: 'locked' as const,
      Label: 'Monitored',
      Icon: 'bi-check-circle',
      Title: `${Title} is always monitored`,
    };
  }
  if (!Monitored) {
    return {
      State: 'plain' as const,
      Label: 'Monitor',
      Icon: 'bi-check-circle',
      Title: `Monitor ${Title}`,
    };
  }
  if (HasIssue) {
    return {
      State: 'issue' as const,
      Label: 'Alarm',
      Icon: 'bi-exclamation-triangle',
      Title: 'Stop monitoring (conditions not met)',
    };
  }
  return {
    State: 'healthy' as const,
    Label: 'Monitored',
    Icon: 'bi-check-circle',
    Title: 'Stop monitoring',
  };
}

/** One section's card, or null when the registry has nothing in that section. */
export function BuildFreeKioskMonitorCard(
  Catalogue: FreeKioskMetricCatalog,
  Terminal: FreeKioskCardTerminal,
  Section: string
): FreeKioskMonitorCard | null {
  const Metrics = Catalogue.Metrics.filter((Metric) => Metric.Section === Section);
  if (!Metrics.length) return null;
  const Group = (Catalogue.Groups || []).find((Entry) => Entry.Key === Section);
  const Title = Group?.Label || Section;
  const Fixed = !!Group?.Fixed;
  const Monitored = IsGroupEnabled(Catalogue.Groups, Terminal.Settings, Section);
  // Readings from a display mode the terminal is not in are dropped outright:
  // FreeKiosk never clears webview.currentUrl, so a terminal locked to an app
  // reports a page nobody is looking at.
  const Applicable = Metrics.filter((Metric) => MetricAppliesInMode(Terminal.Settings, Metric));
  const Fields = FieldsByKey(Catalogue);
  // Every reading shows whether or not the section is monitored. While it is
  // not, nothing is judged (the server force-disables its alarms), so no row is
  // ticked or failing and the table is the readings alone.
  const Rows = Applicable.map((Metric) => {
    const Row = BuildConditionRow(Catalogue, Terminal, Metric, Fields);
    return Monitored ? Row : { ...Row, Checked: false, Breaching: false };
  });
  const Alarmable = Rows.filter((Row) => Row.Alarmable);
  const Ticked = Alarmable.filter((Row) => Row.Checked).length;
  const Summary = !Monitored
    ? 'Not monitored'
    : !Alarmable.length
      ? 'Readings only'
      : Ticked
        ? `${Ticked} of ${Alarmable.length} conditions monitored`
        : 'No conditions ticked';
  return {
    Section,
    Title,
    Note: Group?.Note,
    Fixed,
    Monitored,
    Badge: CardBadge(
      Fixed,
      Monitored,
      Rows.some((Row) => Row.Breaching),
      Title
    ),
    Summary,
    HiddenByMode: Metrics.length - Applicable.length,
    Rows,
  };
}

// ---- Saving ---------------------------------------------------------------

export interface FreeKioskRowEntry {
  On: boolean;
  Op?: string;
  V?: string;
  V2?: string;
}

function ParseNumber(Raw: string | undefined, Field: MonitoringSettingField): number | null {
  const Source = String(Raw ?? '').trim();
  const Fallback = Number(Field.Default);
  let Parsed = Source === '' ? NaN : Number(Source);
  if (!Number.isFinite(Parsed)) Parsed = Number.isFinite(Fallback) ? Fallback : NaN;
  if (!Number.isFinite(Parsed)) return null;
  if (Field.Min !== undefined && Parsed < Field.Min) Parsed = Field.Min;
  if (Field.Max !== undefined && Parsed > Field.Max) Parsed = Field.Max;
  return Parsed;
}

/**
 * The settings one conditions row saves. Only keys the catalogue declares are
 * written (the server drops any others), and a blank threshold falls back to
 * the metric's default rather than arming an alarm with nothing to compare.
 */
export function BuildRowSettings(
  Catalogue: FreeKioskMetricCatalog,
  Metric: FreeKioskMetricView,
  Entry: FreeKioskRowEntry
): Settings {
  const Fields = FieldsByKey(Catalogue);
  const Keys = FreeKioskAlarmKeys(Metric.Key);
  const Out: Settings = {};
  if (Fields.has(Keys.On)) Out[Keys.On] = !!Entry.On;
  const OpField = Fields.get(Keys.Op);
  if (OpField) Out[Keys.Op] = ResolveOperator(Metric, OpField, Entry.Op);
  for (const [Key, Raw] of [
    [Keys.V, Entry.V],
    [Keys.V2, Entry.V2],
  ] as const) {
    const Field = Fields.get(Key);
    if (!Field || Raw === undefined) continue;
    Out[Key] = Field.Type === 'number' ? ParseNumber(Raw, Field) : String(Raw);
  }
  return Out;
}

/** The settings a section's Monitor toggle saves. Fixed sections have none. */
export function BuildGroupSettings(
  Catalogue: FreeKioskMetricCatalog,
  Section: string,
  Monitored: boolean
): Settings {
  const Group = (Catalogue.Groups || []).find((Entry) => Entry.Key === Section);
  if (Group && Group.Fixed) return {};
  return { [FreeKioskGroupFieldKey(Section)]: Monitored };
}
