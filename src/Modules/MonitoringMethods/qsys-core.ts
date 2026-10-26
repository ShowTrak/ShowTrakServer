// Q-SYS Core health over QRC (Q-SYS Remote Control, the JSON-RPC 2.0 API on
// TCP 1710). One short-lived session per probe:
//
//   1. `Logon` { User, Password }: only when a user is supplied. Cores with
//      Access Control enabled refuse other methods without it (error 10,
//      "Logon required"); the password is the user's external-control PIN.
//   2. `StatusGet`: Platform, State (Active / Standby / Idle), DesignName,
//      DesignCode, IsRedundant, IsEmulator and Status { Code, String }.
//   3. `Control.Get` [names]: only when control assertions are enabled, and
//      only on an Active Core (QRC says commands sent to the inactive Core of a
//      redundant pair are ignored or refused with -32604, so asking would just
//      burn the timeout).
//   4. Design devices: only when Check design devices is on, and only on an
//      Active Core. `Component.GetComponents` lists the design's Named
//      Components (those whose Script Access is External or All; the default,
//      None, hides a component from QRC entirely), then each device is read with
//      `Component.Get` { Name, Controls: [status] }, or `Component.GetControls`
//      for an amplifier whose channel fault LEDs are wanted. Those reads are
//      sent together and matched by id, as Q-SYS's own QRWC library does.
//
// Framing: every message in both directions is one JSON object terminated by a
// NUL byte. Responses carry the request's numeric id; the Core also pushes an
// unsolicited `EngineStatus` notification (no id) as soon as a client connects
// and whenever its state changes. Replies are therefore matched by id, never by
// arrival order, and notifications are only ever used as a fallback snapshot.
//
// The check changes nothing on the Core: Logon / StatusGet / Control.Get /
// Component.GetComponents / Component.Get / Component.GetControls are all
// reads. The session closes as soon as the last answer arrives, well inside the
// Core's 60-second idle disconnect, so no NoOp keep-alive is needed.
//
// Actions (operator-pressed, separate session each): Snapshot.Load and
// Control.Set, exactly as QRC_Commands documents them. Both are sent only after
// StatusGet shows the Core is Active, since the inactive Core of a redundant
// pair refuses QRC commands (-32604).
//
// Status.Code: the QRC page only documents 0 = "OK". The Core's status uses the
// same 0–5 scale as every Q-SYS Status control (0 OK, 1 Compromised, 2 Fault,
// 3 Unknown / Not Present, 4 Missing, 5 Initializing), so a non-zero code is
// reported with that label AND the Core's own Status.String, which is the text
// an operator recognises from Core Manager.
//
// Design devices. Documented (help.qsys.com Schematic Library, Status topic):
// a device Status component's status pin uses the 0–5 scale above, where 3 is
// "Not Present" (a device whose Is Required property is No, or a dynamically
// paired one not yet paired), which Q-SYS itself does not treat as an error.
// Older device topics (CX-Q / DPA-Q / SPA-Q status and Amp Output, TSC status,
// I/O Frame status) still document 3 as "Unknown (red)" and 4 as "Updating",
// so code 3 only counts as Not Present when the status text says so.
//   - Component Type strings: QRC only says Type "identifies the component's
//     class". The exact strings come from QSC's developer-community reference
//     list (github.com/Q-SYS-Communities-for-Developers/reference-files,
//     Lua Modules/ComponentSelector), e.g. amplifier_cxq_status, cxq_amplifier,
//     lcqln_status, io_status, touch_screen_status, onvif_camera_operative,
//     io_usb_bridge; they are also the Schematic Library topic file names. Only
//     status components (and amplifier Amp Output components) are read, so a
//     design's DSP blocks and I/O cards cost nothing. A `*_status` Type not in
//     that list (newer hardware) is placed by keyword.
//   - The status control's script name `status`: the topics give display names
//     only ("Amplifier Status", "Touchscreen Status"). The Core's own Status
//     component is read as `status` by a published Q-SYS plugin
//     (github.com/llamafilm/qsys-plugin-prometheus-exporter); device Status
//     components are INFERRED to match, and it is a setting so an installer can
//     correct it from Designer's Tools → View Component Controls Info.
//   - Amplifier faults: the Amp Output topics document Protect, Over Current and
//     Short LEDs per channel (and a Status pin). Their script names are INFERRED
//     to contain those words; only boolean controls count. DAC Output Limit and
//     Limit light on a hard-driven signal, not a fault, so they never count.
import { StringDecoder } from 'string_decoder';
import type net from 'net';
import { RunTcpSession, type TcpSession } from './_tcp-session';
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

const ID = 'qsys-core';
const DEFAULT_PORT = 1710;
const DEFAULT_TIMEOUT_MS = 4000;
// The largest single reply expected is Component.GetComponents on a big design
// (every Named Component with its Properties). An unterminated frame past this
// is not a Core.
const MAX_BUFFERED_CHARS = 8_000_000;
// Design devices read per probe. Only status components count, but a large
// design can still expose hundreds; past this the rest are counted, not read.
const MAX_DEVICES = 128;
// Device reads in flight at once. Enough to finish a big design in a handful
// of round trips without dropping 128 requests on the Core in one burst.
const MAX_IN_FLIGHT = 8;
// Device problems quoted in DegradedReason before the rest are summarised.
const MAX_DEVICE_REASONS = 5;
const DEFAULT_STATUS_CONTROL = 'status';

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'QRC port',
    Type: 'number',
    Default: DEFAULT_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
  },
  {
    Key: 'User',
    Label: 'User',
    Type: 'string',
    Default: '',
    Note: 'A Q-SYS Administrator user with an external-control PIN. Leave blank when Access Control is off on the Core.',
  },
  {
    Key: 'Password',
    Label: 'PIN',
    Type: 'string',
    Default: '',
    Sensitive: true,
    Note: 'The PIN of the user above. Only sent when a user is set.',
  },
  {
    Key: 'CheckStatus',
    Label: 'Check Core status',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded while the Core reports anything other than OK (Compromised, Fault, Missing, Initializing...), quoting the Core’s own status text.',
  },
  {
    Key: 'RequireActive',
    Label: 'Require Active state',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded when the Core is Standby or Idle. For a redundant pair, turn this off on the check for the backup Core, which sits in Standby by design.',
  },
  {
    Key: 'CheckDesign',
    Label: 'Check running design',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when the running design is not the expected one.',
  },
  {
    Key: 'ExpectedDesign',
    Label: 'Expected design name',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'CheckDesign', Equals: true },
    Note: 'Matched without regard to case. Leave blank to confirm only that a design is running.',
  },
  {
    Key: 'CheckControls',
    Label: 'Check Named Controls',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when a listed Named Control does not hold its expected value. Controls are only read while the Core is Active.',
  },
  {
    Key: 'ControlAssertions',
    Label: 'Control assertions',
    Type: 'list',
    ItemType: 'string',
    Default: [],
    VisibleWhen: { Key: 'CheckControls', Equals: true },
    Note: 'One Name=Value per entry, e.g. MainMute=unmuted, MainMute=false or MainGain=-6. Compared with the control’s string (e.g. "unmuted", "-6.0dB"), then its value; case is ignored, numbers compare numerically and true/false match a 1/0 value.',
  },
  {
    Key: 'CheckDevices',
    Label: 'Check design devices',
    Type: 'boolean',
    Default: false,
    Note: 'Also reads the status of the amplifiers, I/O frames, cameras, bridges and touch panels in the running design, and is Degraded when any of them is not OK. Each device needs Script Access set to External or All in Q-SYS Designer. Devices are only read while the Core is Active.',
  },
  {
    Key: 'DeviceSource',
    Label: 'Devices to check',
    Type: 'select',
    Default: 'discover',
    Options: [
      { value: 'discover', label: 'Find them in the design' },
      { value: 'list', label: 'Only the devices listed' },
    ],
    VisibleWhen: { Key: 'CheckDevices', Equals: true },
    Note: 'Find them in the design checks every device the Core exposes in the categories below. Only the devices listed checks exactly the Code Names you enter, and reports any it cannot find.',
  },
  {
    Key: 'DeviceNames',
    Label: 'Device Code Names',
    Type: 'list',
    ItemType: 'string',
    Default: [],
    VisibleWhen: [
      { Key: 'CheckDevices', Equals: true },
      { Key: 'DeviceSource', Equals: 'list' },
    ],
    Note: 'The Code Name of each device’s Status component, as shown in its Properties in Q-SYS Designer, e.g. Amp-Stage-L.',
  },
  {
    Key: 'DeviceAmps',
    Label: 'Amplifiers',
    Type: 'boolean',
    Default: true,
    VisibleWhen: [
      { Key: 'CheckDevices', Equals: true },
      { Key: 'DeviceSource', Equals: 'discover' },
    ],
    Note: 'CX-Q, CXD-Q, DPA-Q, SPA-Q and MPA-Q amplifiers.',
  },
  {
    Key: 'DeviceIo',
    Label: 'I/O frames and peripherals',
    Type: 'boolean',
    Default: true,
    VisibleWhen: [
      { Key: 'CheckDevices', Equals: true },
      { Key: 'DeviceSource', Equals: 'discover' },
    ],
    Note: 'QIO and I/O-Frame expanders, DCIO, Core Flex I/O, and NL / NM peripherals that share the QIO Status component.',
  },
  {
    Key: 'DeviceCameras',
    Label: 'Cameras',
    Type: 'boolean',
    Default: true,
    VisibleWhen: [
      { Key: 'CheckDevices', Equals: true },
      { Key: 'DeviceSource', Equals: 'discover' },
    ],
    Note: 'NC Series PTZ cameras.',
  },
  {
    Key: 'DeviceBridges',
    Label: 'Bridges',
    Type: 'boolean',
    Default: true,
    VisibleWhen: [
      { Key: 'CheckDevices', Equals: true },
      { Key: 'DeviceSource', Equals: 'discover' },
    ],
    Note: 'I/O-USB bridges, USB video bridges and PTZ-IP bridges.',
  },
  {
    Key: 'DeviceTouchPanels',
    Label: 'Touch panels',
    Type: 'boolean',
    Default: true,
    VisibleWhen: [
      { Key: 'CheckDevices', Equals: true },
      { Key: 'DeviceSource', Equals: 'discover' },
    ],
    Note: 'TSC Series touch screen controllers.',
  },
  {
    Key: 'DeviceOther',
    Label: 'Other devices',
    Type: 'boolean',
    Default: false,
    VisibleWhen: [
      { Key: 'CheckDevices', Equals: true },
      { Key: 'DeviceSource', Equals: 'discover' },
    ],
    Note: 'Any other exposed status component, such as NV Series video endpoints, page stations or plugins.',
  },
  {
    Key: 'CheckAmpFaults',
    Label: 'Check amplifier channel faults',
    Type: 'boolean',
    Default: true,
    VisibleWhen: { Key: 'CheckDevices', Equals: true },
    Note: 'Degraded when an amplifier channel shows Protect, Over Current or Short. These are on the amplifier’s Amp Output component, which needs Script Access too. Limiter lights are not faults and are ignored.',
  },
  {
    Key: 'FlagNotPresent',
    Label: 'Flag Not Present devices',
    Type: 'boolean',
    Default: false,
    VisibleWhen: { Key: 'CheckDevices', Equals: true },
    Note: 'Q-SYS reports a device that is not required, or not yet paired, as Not Present and does not treat that as an error. Turn this on to report it anyway.',
  },
  {
    Key: 'StatusControlName',
    Label: 'Status control name',
    Type: 'string',
    Default: DEFAULT_STATUS_CONTROL,
    Advanced: true,
    VisibleWhen: { Key: 'CheckDevices', Equals: true },
    Note: 'The name of the status control inside each device component. Leave it as status unless Tools → View Component Controls Info in Q-SYS Designer shows a different name.',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: DEFAULT_TIMEOUT_MS,
    Min: 500,
    Max: 30000,
    Advanced: true,
    Note: 'Budget for the whole session: connect, logon, status, control and device reads.',
  },
];

// --- Options -----------------------------------------------------------------

export interface ControlAssertion {
  Name: string;
  Expected: string;
}

interface QsysConfig {
  Address: string;
  Port: number;
  User: string;
  Password: string;
  TimeoutMs: number;
}

interface HealthOptions {
  CheckStatus: boolean;
  RequireActive: boolean;
  CheckDesign: boolean;
  ExpectedDesign: string;
  CheckControls: boolean;
  Assertions: ControlAssertion[];
  // Entries that could not be read as Name=Value; reported, never sent.
  InvalidAssertions: string[];
  CheckDevices: boolean;
  Devices: DevicePlan;
}

export type DeviceCategory = 'amp' | 'io' | 'camera' | 'bridge' | 'touch' | 'other';

// What to read for design devices. Pure data, so EvaluateHealth and Debug see
// the same choices QueryCore acted on.
export interface DevicePlan {
  Source: 'discover' | 'list';
  // Code Names to read, for the 'list' source.
  Names: string[];
  // Categories read by the 'discover' source.
  Categories: DeviceCategory[];
  AmpFaults: boolean;
  FlagNotPresent: boolean;
  StatusControl: string;
}

function ParseConfig(Target: MonitoringTargetLike): QsysConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number(Cfg.Port);
  const Timeout = Number(Cfg.Timeout);
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Port: Number.isFinite(Port) && Port > 0 ? Port | 0 : DEFAULT_PORT,
    User: Cfg.User == null ? '' : String(Cfg.User).trim(),
    Password: Cfg.Password == null ? '' : String(Cfg.Password),
    TimeoutMs: Number.isFinite(Timeout) && Timeout > 0 ? Timeout : DEFAULT_TIMEOUT_MS,
  };
}

// Split `Name=Value` entries. The FIRST `=` separates them: Named Control names
// are free text but an `=` in one is far less likely than in a string value.
function ParseControlAssertions(Input: unknown): {
  Assertions: ControlAssertion[];
  Invalid: string[];
} {
  const Assertions: ControlAssertion[] = [];
  const Invalid: string[] = [];
  const List = Array.isArray(Input) ? Input : [];
  for (const Raw of List) {
    const Entry = String(Raw == null ? '' : Raw).trim();
    if (!Entry) continue;
    const Eq = Entry.indexOf('=');
    const Name = Eq > 0 ? Entry.slice(0, Eq).trim() : '';
    if (!Name) {
      Invalid.push(Entry);
      continue;
    }
    Assertions.push({ Name, Expected: Entry.slice(Eq + 1).trim() });
  }
  return { Assertions, Invalid };
}

function ParseDeviceNames(Input: unknown): string[] {
  const List = Array.isArray(Input) ? Input : [];
  const Names: string[] = [];
  for (const Raw of List) {
    const Name = String(Raw == null ? '' : Raw).trim();
    if (Name && !Names.includes(Name)) Names.push(Name);
  }
  return Names;
}

function ParseDevicePlan(Cfg: Record<string, unknown>): DevicePlan {
  // Category toggles default ON except Other: absent means the default.
  const Categories: DeviceCategory[] = [];
  if (Cfg.DeviceAmps !== false) Categories.push('amp');
  if (Cfg.DeviceIo !== false) Categories.push('io');
  if (Cfg.DeviceCameras !== false) Categories.push('camera');
  if (Cfg.DeviceBridges !== false) Categories.push('bridge');
  if (Cfg.DeviceTouchPanels !== false) Categories.push('touch');
  if (Cfg.DeviceOther === true) Categories.push('other');
  const StatusControl =
    typeof Cfg.StatusControlName === 'string' && Cfg.StatusControlName.trim()
      ? Cfg.StatusControlName.trim()
      : DEFAULT_STATUS_CONTROL;
  return {
    Source: Cfg.DeviceSource === 'list' ? 'list' : 'discover',
    Names: ParseDeviceNames(Cfg.DeviceNames),
    Categories,
    AmpFaults: Cfg.CheckAmpFaults !== false,
    FlagNotPresent: Cfg.FlagNotPresent === true,
    StatusControl,
  };
}

function ParseHealthOptions(Target: MonitoringTargetLike): HealthOptions {
  const Cfg = (Target && Target.Settings) || {};
  const CheckControls = Cfg.CheckControls === true;
  const Parsed = CheckControls
    ? ParseControlAssertions(Cfg.ControlAssertions)
    : { Assertions: [], Invalid: [] };
  return {
    // Default ON: absent means enabled, so only an explicit false turns it off.
    CheckStatus: Cfg.CheckStatus !== false,
    RequireActive: Cfg.RequireActive !== false,
    CheckDesign: Cfg.CheckDesign === true,
    ExpectedDesign: String(Cfg.ExpectedDesign == null ? '' : Cfg.ExpectedDesign).trim(),
    CheckControls,
    Assertions: Parsed.Assertions,
    InvalidAssertions: Parsed.Invalid,
    CheckDevices: Cfg.CheckDevices === true,
    Devices: ParseDevicePlan(Cfg),
  };
}

// --- Pure protocol helpers ---------------------------------------------------

// Split NUL-terminated frames off the front of the receive buffer. Rest is the
// incomplete tail still arriving. Whitespace around a frame is tolerated.
function SplitFrames(Buffered: string): { Frames: string[]; Rest: string } {
  const Parts = Buffered.split('\0');
  const Rest = Parts.pop() ?? '';
  return { Frames: Parts.map((Part) => Part.trim()).filter(Boolean), Rest };
}

export interface QrcError {
  Code: number | null;
  Message: string;
}

// The QRC error table, used when a Core sends a code without a message.
const ERROR_MESSAGES: Record<number, string> = {
  [-32700]: 'Parse error',
  [-32600]: 'Invalid request',
  [-32601]: 'Method not found',
  [-32602]: 'Invalid params',
  [-32603]: 'Server error',
  [-32604]: 'Core is on Standby',
  2: 'Invalid Page Request ID',
  3: 'Bad Page Request',
  4: 'Missing file',
  5: 'Change Groups exhausted',
  6: 'Unknown change group',
  7: 'Unknown component name',
  8: 'Unknown control',
  9: 'Illegal mixer channel index',
  10: 'Logon required',
};

// QRC's documented codes this method acts on.
const ERR_UNKNOWN_COMPONENT = 7;
const ERR_UNKNOWN_CONTROL = 8;
const ERR_LOGON_REQUIRED = 10;
const ERR_STANDBY = -32604;

// Device JSON is untrusted: every conversion below reads primitives only, by
// typeof, so an object where a string or number belongs (or one with a hostile
// toString / valueOf) becomes null instead of throwing.
const NUMBER_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;

function PrimString(Value: unknown): string | null {
  if (typeof Value === 'string') return Value;
  if (typeof Value === 'number' || typeof Value === 'boolean') return String(Value);
  return null;
}

function PrimNumber(Value: unknown): number | null {
  if (typeof Value === 'number') return Number.isFinite(Value) ? Value : null;
  if (typeof Value === 'string' && NUMBER_RE.test(Value.trim())) return Number(Value.trim());
  return null;
}

function PrimBool(Value: unknown): boolean | null {
  if (typeof Value === 'boolean') return Value;
  if (typeof Value === 'number') return Value !== 0;
  return null;
}

// A control Value as reported, or undefined when it is not a primitive.
function PrimValue(Value: unknown): string | number | boolean | undefined {
  return typeof Value === 'string' || typeof Value === 'number' || typeof Value === 'boolean'
    ? Value
    : undefined;
}

function ParseError(Value: unknown): QrcError {
  const Obj = Value && typeof Value === 'object' ? (Value as Record<string, unknown>) : {};
  const Code = PrimNumber(Obj.code);
  const HasCode = Code != null;
  const Message =
    typeof Obj.message === 'string' && Obj.message.trim()
      ? Obj.message.trim()
      : HasCode && ERROR_MESSAGES[Code]
        ? ERROR_MESSAGES[Code]
        : 'Error';
  return { Code, Message };
}

function DescribeError(Err: QrcError): string {
  return Err.Code == null ? Err.Message : `${Err.Message} (${Err.Code})`;
}

const STATUS_LABELS: Record<number, string> = {
  0: 'OK',
  1: 'Compromised',
  2: 'Fault',
  3: 'Unknown',
  4: 'Missing',
  5: 'Initializing',
};

function StatusLabel(Code: number | null): string {
  if (Code == null) return 'Unknown';
  return STATUS_LABELS[Code] || `Code ${Code}`;
}

export interface CoreStatus {
  Platform: string | null;
  State: string | null;
  DesignName: string | null;
  DesignCode: string | null;
  IsRedundant: boolean | null;
  IsEmulator: boolean | null;
  StatusCode: number | null;
  StatusString: string | null;
}

// Read a StatusGet result (or EngineStatus params, which carry the same fields
// minus Platform and Status). Null when it is not shaped like either.
function ParseCoreStatus(Value: unknown): CoreStatus | null {
  if (!Value || typeof Value !== 'object' || Array.isArray(Value)) return null;
  const Obj = Value as Record<string, unknown>;
  if (typeof Obj.State !== 'string' && typeof Obj.Platform !== 'string') return null;
  const Status =
    Obj.Status && typeof Obj.Status === 'object' ? (Obj.Status as Record<string, unknown>) : null;
  return {
    Platform: PrimString(Obj.Platform),
    State: PrimString(Obj.State),
    DesignName: PrimString(Obj.DesignName),
    DesignCode: PrimString(Obj.DesignCode),
    IsRedundant: PrimBool(Obj.IsRedundant),
    IsEmulator: PrimBool(Obj.IsEmulator),
    StatusCode: Status ? PrimNumber(Status.Code) : null,
    StatusString: Status ? PrimString(Status.String) : null,
  };
}

export interface ControlReading {
  Name: string;
  Found: boolean;
  Value?: string | number | boolean;
  String?: string | null;
  // Why the control could not be read (e.g. "Unknown control (8)").
  Error?: string;
}

// Map a Control.Get result array back onto the requested names. A requested
// name the Core left out of its answer is "not found" rather than silently
// passing.
function ParseControlResult(Names: string[], Result: unknown): ControlReading[] {
  const ByName = new Map<string, Record<string, unknown>>();
  if (Array.isArray(Result)) {
    for (const Entry of Result) {
      if (
        Entry &&
        typeof Entry === 'object' &&
        typeof (Entry as { Name?: unknown }).Name === 'string'
      ) {
        ByName.set((Entry as { Name: string }).Name, Entry as Record<string, unknown>);
      }
    }
  }
  return Names.map((Name) => {
    const Entry = ByName.get(Name);
    if (!Entry) return { Name, Found: false, Error: 'Not returned by the Core' };
    return {
      Name,
      Found: true,
      Value: PrimValue(Entry.Value),
      String: typeof Entry.String === 'string' ? Entry.String : null,
    };
  });
}

// Expected values that mean a boolean state. A toggle such as a mute reports
// its Value as JSON true/false in the QRC examples but as 0/1 from many Cores,
// with a String of "muted" / "unmuted", so `MainMute=false` must match all of
// false, 0 and 0.0.
const TRUE_WORDS = new Set(['true', 'on', 'yes']);
const FALSE_WORDS = new Set(['false', 'off', 'no']);

function ExpectedBool(Want: string): boolean | null {
  const Lower = Want.toLowerCase();
  if (TRUE_WORDS.has(Lower)) return true;
  if (FALSE_WORDS.has(Lower)) return false;
  return null;
}

// Does one reported representation equal the expectation? Booleans and the
// boolean words compare by truth (a number is true when non-zero), numbers
// compare numerically (Q-SYS reports gains as floats such as -5.9999995), and
// everything else as trimmed, case-insensitive text.
function OneMatches(
  Expected: string,
  Actual: string | number | boolean | null | undefined
): boolean {
  if (Actual == null) return false;
  const Want = Expected.trim();
  if (typeof Actual === 'boolean') {
    const Lower = Want.toLowerCase();
    if (Lower === '1') return Actual;
    if (Lower === '0') return !Actual;
    const Bool = ExpectedBool(Want);
    return Bool != null && Bool === Actual;
  }
  if (typeof Actual === 'number') {
    // Only the words get truth semantics; "1" / "0" stay numeric so a gain of
    // 0.5 never passes for MainGain=1.
    const Bool = ExpectedBool(Want);
    if (Bool != null) return Bool === (Actual !== 0);
  }
  const Got = String(Actual).trim();
  if (NUMBER_RE.test(Want) && NUMBER_RE.test(Got)) {
    const A = Number(Want);
    const B = Number(Got);
    return Math.abs(A - B) <= 1e-4 * Math.max(1, Math.abs(A), Math.abs(B));
  }
  return Want.toLowerCase() === Got.toLowerCase();
}

// The control's String is what an operator sees on the Core ("-6.0dB",
// "muted"); its Value is the raw number/boolean. Either matching passes, so
// MainMute=true and MainGain=-6 work as naturally as MainGain=-6.0dB.
function ControlMatches(Expected: string, Reading: ControlReading): boolean {
  if (!Reading.Found) return false;
  if (Reading.String != null && OneMatches(Expected, Reading.String)) return true;
  return OneMatches(Expected, Reading.Value);
}

function DescribeReading(Reading: ControlReading): string {
  if (Reading.String != null && Reading.String !== '') return Reading.String;
  if (Reading.Value === undefined) return '-';
  return String(Reading.Value);
}

// --- Design devices ------------------------------------------------------------

// Device status labels on the Status topic's 0–5 scale. Code 3 is "Not
// Present" there but "Unknown" on older device topics, and 4 is "Updating" on
// amplifiers, so the device's own status text is preferred wherever it is
// given (see DescribeDeviceStatus).
const DEVICE_STATUS_LABELS: Record<number, string> = {
  0: 'OK',
  1: 'Compromised',
  2: 'Fault',
  3: 'Unknown',
  4: 'Missing',
  5: 'Initializing',
};

const NOT_PRESENT_RE = /not\s*present/i;

// Code 3 reads as Not Present only when the device says so in its text.
function IsNotPresent(Code: number | null, Text: string | null): boolean {
  return Code === 3 && NOT_PRESENT_RE.test(Text || '');
}

function DeviceStatusLabel(Code: number | null, Text: string | null = null): string {
  if (Code == null) return 'Unknown';
  if (IsNotPresent(Code, Text)) return 'Not Present';
  return DEVICE_STATUS_LABELS[Code] || `Code ${Code}`;
}

const CATEGORY_LABELS: Record<DeviceCategory, string> = {
  amp: 'Amplifier',
  io: 'I/O',
  camera: 'Camera',
  bridge: 'Bridge',
  touch: 'Touch panel',
  other: 'Device',
};

// Device status component Types, from QSC's developer-community component
// reference list (see the header). Anything listed here is read in discovery.
const DEVICE_TYPES: Record<string, DeviceCategory> = {
  amplifier_cxq_status: 'amp',
  amplifier_dpa_status: 'amp',
  spaq_status: 'amp',
  io_status: 'io',
  io_22_status: 'io',
  io_510i_status: 'io',
  io_core_110f_status: 'io',
  io_core_8_flex_status: 'io',
  io_core_nano_status: 'io',
  io_dcio_status: 'io',
  lcqln_status: 'io',
  onvif_camera_operative: 'camera',
  io_usb_bridge: 'bridge',
  usb_uvc: 'bridge',
  touch_screen_status: 'touch',
  page_station_hardware_status: 'other',
  vstreamer_status: 'other',
  vstreamer_nv1smb_status: 'other',
};

// Amp Output components: they carry a Status pin AND the channel fault LEDs.
const AMP_OUTPUT_TYPES = new Set(['cxq_amplifier', 'spaq_amplifier', 'amplifier_dataport']);

// Status-named components that are not inventory devices: the Core itself
// (StatusGet already covers it), the status-combining logic block, and the
// POTS line controllers (a phone line, not a piece of hardware).
const NOT_DEVICE_RE = /^(core_status|status_combiner|pots_control_status)/;

// Keyword fallback for a `*_status` Type not in the list (newer hardware),
// first match wins: the specific words first so a USB video bridge is a
// bridge, not a camera.
const CATEGORY_PATTERNS: Array<[DeviceCategory, RegExp]> = [
  ['touch', /touch|tsc/],
  ['bridge', /usb|bridge|ptz[-_ ]?ip/],
  ['camera', /camera|onvif|(^|_)nc[-_ ]?\d/],
  ['amp', /amplifier|cxq|cxd|dpa|spa|mpa/],
  ['io', /qio|lcqln|dcio|(^|_)io(_|$)|flex/],
];

function IsAmpOutputType(Type: string | null): boolean {
  const Lower = (Type || '').toLowerCase();
  return AMP_OUTPUT_TYPES.has(Lower) || /^[a-z0-9]+_amplifier$/.test(Lower);
}

// Component Type → device category, or null when the component is not a
// device status component at all (a DSP block, an I/O card, a script...).
function CategorizeType(Type: string | null): DeviceCategory | null {
  const Lower = (Type || '').toLowerCase();
  if (!Lower) return null;
  if (DEVICE_TYPES[Lower]) return DEVICE_TYPES[Lower];
  if (IsAmpOutputType(Lower)) return 'amp';
  if (NOT_DEVICE_RE.test(Lower)) return null;
  // Plugins and extensions: QSC's list types them %PLUGIN%_<id> / %EXT%_<id>.
  if (/^%(plugin|ext)%/.test(Lower)) return 'other';
  if (!/_status$/.test(Lower)) return null;
  for (const [Category, Pattern] of CATEGORY_PATTERNS) {
    if (Pattern.test(Lower)) return Category;
  }
  return 'other';
}

export interface DesignComponent {
  Name: string;
  Type: string | null;
}

// Read a Component.GetComponents result: every entry with a string Name.
function ParseComponentList(Result: unknown): DesignComponent[] {
  if (!Array.isArray(Result)) return [];
  const Out: DesignComponent[] = [];
  for (const Entry of Result) {
    if (!Entry || typeof Entry !== 'object') continue;
    const Obj = Entry as Record<string, unknown>;
    const Name = typeof Obj.Name === 'string' && Obj.Name ? Obj.Name : PrimString(Obj.ID);
    if (!Name) continue;
    Out.push({ Name, Type: PrimString(Obj.Type) });
  }
  return Out;
}

export interface DeviceReading {
  Name: string;
  Type: string | null;
  Category: DeviceCategory;
  // false until its reply arrives; a probe that ran out of time leaves it false.
  Read: boolean;
  // The Core knows the component (false: error 7, wrong Code Name or Script
  // Access None).
  Found: boolean;
  HasStatus: boolean;
  StatusCode: number | null;
  StatusString: string | null;
  // Amplifier fault controls that are lit, by control name.
  Faults: string[];
  // Whether fault controls were looked for (GetControls was used).
  FaultsChecked: boolean;
  Error: string | null;
}

function NewDeviceReading(Component: DesignComponent, Category: DeviceCategory): DeviceReading {
  return {
    Name: Component.Name,
    Type: Component.Type,
    Category,
    Read: false,
    Found: false,
    HasStatus: false,
    StatusCode: null,
    StatusString: null,
    Faults: [],
    FaultsChecked: false,
    Error: null,
  };
}

// Channel fault indicators from the Amp Output topics: Protect, Over Current
// and Short. Matched on the control's script name, which is INFERRED to
// contain those words; settings next to them (suppress, reset, lockout,
// enable) never count. DAC Output Limit and Limit are deliberately absent:
// they light whenever the signal is driven into the limiter, which is a level
// matter during a loud show, not an amplifier fault.
const FAULT_NAME_RE = /protect|short|over[\s._-]?current/i;
const NOT_FAULT_NAME_RE = /suppress|reset|lock|enable|threshold|select/i;
const BOOLEAN_TYPES = new Set(['boolean', 'led', 'indicator', 'button']);

function IsLitFault(Control: Record<string, unknown>): boolean {
  const Name = typeof Control.Name === 'string' ? Control.Name : '';
  if (!FAULT_NAME_RE.test(Name) || NOT_FAULT_NAME_RE.test(Name)) return false;
  const Type = typeof Control.Type === 'string' ? Control.Type.toLowerCase() : '';
  const Value = Control.Value;
  // Only on/off controls: a float named "clip" (a meter) is not a fault LED.
  if (typeof Value === 'boolean') return Value;
  if (!BOOLEAN_TYPES.has(Type)) return false;
  const Num = PrimNumber(Value);
  return Num != null && Num !== 0;
}

// Fill a reading from a Component.Get / Component.GetControls result
// ({ Name, Controls: [...] }). The status control is matched without regard
// to case; faults are only looked for when every control was returned.
function ApplyDeviceResult(
  Reading: DeviceReading,
  Result: unknown,
  StatusControl: string,
  AllControls: boolean
): void {
  Reading.Read = true;
  Reading.Found = true;
  const Obj = Result && typeof Result === 'object' ? (Result as Record<string, unknown>) : {};
  const Controls = Array.isArray(Obj.Controls) ? Obj.Controls : [];
  const Want = StatusControl.toLowerCase();
  for (const Entry of Controls) {
    if (!Entry || typeof Entry !== 'object') continue;
    const Control = Entry as Record<string, unknown>;
    const Name = typeof Control.Name === 'string' ? Control.Name : '';
    if (Name.toLowerCase() === Want && !Reading.HasStatus) {
      Reading.HasStatus = true;
      Reading.StatusCode = PrimNumber(Control.Value);
      Reading.StatusString = typeof Control.String === 'string' ? Control.String : null;
    } else if (AllControls && IsLitFault(Control)) {
      Reading.Faults.push(Name);
    }
  }
  Reading.FaultsChecked = AllControls;
}

function ApplyDeviceError(Reading: DeviceReading, Err: QrcError): void {
  Reading.Read = true;
  if (Err.Code === ERR_UNKNOWN_COMPONENT) {
    Reading.Found = false;
    return;
  }
  Reading.Found = true;
  // Unknown control: the component exists but has no control by that name.
  if (Err.Code === ERR_UNKNOWN_CONTROL) return;
  Reading.Error = DescribeError(Err);
}

// Is this status a problem? Not Present is not an error in Q-SYS's own terms
// unless the user asked for it to be.
function DeviceStatusBad(Reading: DeviceReading, FlagNotPresent: boolean): boolean {
  const Code = Reading.StatusCode;
  if (Code == null || Code === 0) return false;
  if (IsNotPresent(Code, Reading.StatusString) && !FlagNotPresent) return false;
  return true;
}

// Words a Q-SYS status text starts with when it already names its state
// ("Fault - PSU over temperature", "Updating firmware").
const STATUS_WORD_RE =
  /^(ok|compromised|fault|unknown|not\s*present|missing|initializing|updating)\b/i;

// The device's own status text when it names the state; otherwise the label
// for its code, with the text after it.
function DescribeDeviceStatus(Reading: DeviceReading): string {
  const Text = (Reading.StatusString || '').trim();
  if (Text && STATUS_WORD_RE.test(Text)) return Text;
  const Label = DeviceStatusLabel(Reading.StatusCode, Reading.StatusString);
  return Text ? `${Label}: ${Text}` : Label;
}

// The reasons the design devices are unhealthy. Readings that never arrived
// are covered by the session's Incomplete reason, not repeated per device.
function EvaluateDevices(Snapshot: CoreSnapshot, Plan: DevicePlan): string[] {
  const Reasons: string[] = [];
  if (Snapshot.DevicesSkipped) return Reasons; // Standby / Idle: RequireActive speaks for it
  if (Snapshot.DiscoveryError) {
    Reasons.push(`Could not list design devices: ${Snapshot.DiscoveryError}`);
    return Reasons;
  }
  const Devices = Snapshot.Devices;
  if (!Devices) return Reasons;
  const Problems: string[] = [];
  for (const Reading of Devices) {
    if (!Reading.Read) continue;
    const Label = `${CATEGORY_LABELS[Reading.Category]} "${Reading.Name}"`;
    if (!Reading.Found) {
      Problems.push(
        `${Label} not found (check its Code Name and that Script Access is External or All)`
      );
      continue;
    }
    if (Reading.Error) {
      Problems.push(`${Label} could not be read (${Reading.Error})`);
      continue;
    }
    if (!Reading.HasStatus) {
      // A discovered component with no status control is quietly skipped; a
      // listed one was named on purpose. Lit faults count either way.
      if (Plan.Source === 'list') {
        Problems.push(`${Label} has no "${Plan.StatusControl}" control`);
      }
    } else if (DeviceStatusBad(Reading, Plan.FlagNotPresent)) {
      Problems.push(`${Label} ${DescribeDeviceStatus(Reading)}`);
    }
    if (Reading.Faults.length) {
      Problems.push(`${Label} channel fault: ${Reading.Faults.join(', ')}`);
    }
  }
  if (
    Plan.Source === 'discover' &&
    !Snapshot.Incomplete &&
    !Devices.some((Reading) => Reading.Read && (Reading.HasStatus || Reading.FaultsChecked))
  ) {
    Problems.push('No design devices found (set Script Access to External or All)');
  }
  Reasons.push(...Problems.slice(0, MAX_DEVICE_REASONS));
  if (Problems.length > MAX_DEVICE_REASONS) {
    Reasons.push(`${Problems.length - MAX_DEVICE_REASONS} more device problems`);
  }
  return Reasons;
}

// --- One-connection probe ------------------------------------------------------

export type LogonState = 'not-attempted' | 'ok' | 'rejected';

export interface CoreSnapshot {
  // A JSON-RPC answer or notification proved this is a Q-SYS Core.
  IsQsys: boolean;
  Status: CoreStatus | null;
  // Where Status came from: the StatusGet reply, or (when that never arrived)
  // the unsolicited EngineStatus notification.
  StatusSource: 'StatusGet' | 'EngineStatus' | null;
  LogonState: LogonState;
  LogonError: string | null;
  StatusGetError: string | null;
  Controls: ControlReading[] | null;
  // Why the controls were not read (Standby/Idle Core), for the debug panel.
  ControlsSkipped: string | null;
  // Design devices, in the order they were asked for. Null when not checked.
  Devices: DeviceReading[] | null;
  // Why the devices were not read (Standby/Idle Core).
  DevicesSkipped: string | null;
  // Component.GetComponents failed.
  DiscoveryError: string | null;
  // Exposed components no enabled category matched, for the debug panel.
  DevicesUnmatched: DesignComponent[] | null;
  // Matching devices beyond MAX_DEVICES, counted but not read.
  DevicesOverLimit: number;
  // A stage that did not finish inside the budget, as a human reason.
  Incomplete: string | null;
}

export type CoreProbe =
  | { Reachable: false; Error: string; Refused: boolean }
  | { Reachable: true; LatencyMs: number; Snapshot: CoreSnapshot };

type RpcReply = { Result: unknown } | { Error: QrcError };

class SessionEnded extends Error {}

// One QRC connection's framing and request bookkeeping, shared by the probe
// and the actions. Replies are matched by id; anything without an id we are
// waiting for (EngineStatus) goes to OnNotification.
class QrcChannel {
  private readonly Decoder = new StringDecoder('utf8');
  private Buffered = '';
  private NextId = 1;
  private readonly Pending = new Map<number, (Reply: RpcReply) => void>();
  private readonly Failers = new Set<(Err: Error) => void>();
  BytesSeen = 0;

  constructor(private readonly OnNotification: (Msg: Record<string, unknown>) => void) {}

  // Take one chunk. False when the peer has sent more unterminated data than
  // any Core reply could be.
  Feed(Chunk: Buffer): boolean {
    this.BytesSeen += Chunk.length;
    // A StringDecoder keeps a UTF-8 character split across chunks intact.
    this.Buffered += this.Decoder.write(Chunk);
    if (this.Buffered.length > MAX_BUFFERED_CHARS) return false;
    // Only re-split when a terminator arrived: a big reply comes in many
    // chunks, and scanning the whole buffer for each would be quadratic.
    if (!Chunk.includes(0)) return true;
    const { Frames, Rest } = SplitFrames(this.Buffered);
    this.Buffered = Rest;
    for (const Frame of Frames) this.HandleFrame(Frame);
    return true;
  }

  private HandleFrame(Frame: string): void {
    let Msg: unknown;
    try {
      Msg = JSON.parse(Frame);
    } catch {
      return; // junk between frames; a non-Core answer stays unrecognised
    }
    if (!Msg || typeof Msg !== 'object' || Array.isArray(Msg)) return;
    const Obj = Msg as Record<string, unknown>;
    const Id = PrimNumber(Obj.id);
    const Resolve = Id != null ? this.Pending.get(Id) : undefined;
    if (Id == null || !Resolve) {
      this.OnNotification(Obj);
      return;
    }
    this.Pending.delete(Id);
    Resolve(
      'error' in Obj && Obj.error != null
        ? { Error: ParseError(Obj.error) }
        : { Result: Obj.result }
    );
  }

  Call(Socket: net.Socket, Method: string, Params: unknown): Promise<RpcReply> {
    return new Promise<RpcReply>((Resolve, Reject) => {
      const Id = this.NextId++;
      const Fail = (Err: Error) => Reject(Err);
      this.Failers.add(Fail);
      this.Pending.set(Id, (Reply) => {
        this.Failers.delete(Fail);
        Resolve(Reply);
      });
      try {
        Socket.write(
          JSON.stringify({ jsonrpc: '2.0', id: Id, method: Method, params: Params }) + '\0'
        );
      } catch (Err) {
        this.Failers.delete(Fail);
        this.Pending.delete(Id);
        Reject(Err instanceof Error ? Err : new Error(String(Err)));
      }
    });
  }

  // The session ended: every call still waiting rejects with SessionEnded.
  Close(): void {
    for (const Fail of this.Failers) Fail(new SessionEnded('session ended'));
    this.Failers.clear();
    this.Pending.clear();
  }
}

function QueryCore(
  Config: QsysConfig,
  ControlNames: string[],
  Devices: DevicePlan | null = null
): Promise<CoreProbe> {
  const BudgetMs = Math.max(500, Config.TimeoutMs | 0);
  const Snapshot: CoreSnapshot = {
    IsQsys: false,
    Status: null,
    StatusSource: null,
    LogonState: 'not-attempted',
    LogonError: null,
    StatusGetError: null,
    Controls: null,
    ControlsSkipped: null,
    Devices: null,
    DevicesSkipped: null,
    DiscoveryError: null,
    DevicesUnmatched: null,
    DevicesOverLimit: 0,
    Incomplete: null,
  };
  let Stage = 'connect';
  const Channel = new QrcChannel((Obj) => {
    if (Obj.method !== 'EngineStatus') return;
    const Parsed = ParseCoreStatus(Obj.params);
    if (!Parsed) return;
    Snapshot.IsQsys = true;
    // Keep it only as a fallback: StatusGet also carries Platform and Status.
    if (Snapshot.StatusSource !== 'StatusGet') {
      Snapshot.Status = Parsed;
      Snapshot.StatusSource = 'EngineStatus';
    }
  });

  const Reached = (Session: TcpSession<CoreProbe>): CoreProbe => ({
    Reachable: true,
    LatencyMs: Date.now() - Session.StartedAt,
    Snapshot,
  });

  // Ending early (timeout / close): reachable if the Core said anything at all.
  const Unfinished = (Session: TcpSession<CoreProbe>, NoReplyError: string): CoreProbe => {
    if (!Channel.BytesSeen) return { Reachable: false, Error: NoReplyError, Refused: false };
    if (Snapshot.IsQsys) Snapshot.Incomplete = `The Core did not finish ${Stage} in time`;
    return Reached(Session);
  };

  return RunTcpSession<CoreProbe>({
    Address: Config.Address,
    Port: Config.Port,
    IdleMs: BudgetMs,
    DeadlineMs: BudgetMs,
    NoDelay: true,
    OnSettle: () => Channel.Close(),
    OnData: (Chunk, Session) => {
      if (!Channel.Feed(Chunk)) Session.Finish(Reached(Session));
    },
    OnTimeout: (Session) => Unfinished(Session, `No reply from the Q-SYS Core after ${BudgetMs}ms`),
    OnError: (Message) => ({
      Reachable: false,
      Error: Message,
      Refused: Message.includes('ECONNREFUSED') || Message.includes('ECONNRESET'),
    }),
    OnClose: (Session) => Unfinished(Session, 'Connection closed before any reply'),
    OnConnect: (Session) => {
      const Call = (Method: string, Params: unknown): Promise<RpcReply> =>
        Channel.Call(Session.Socket, Method, Params);

      void (async () => {
        try {
          if (Config.User) {
            Stage = 'logon';
            const Reply = await Call('Logon', { User: Config.User, Password: Config.Password });
            Snapshot.IsQsys = true;
            if ('Error' in Reply) {
              Snapshot.LogonState = 'rejected';
              Snapshot.LogonError = DescribeError(Reply.Error);
            } else {
              Snapshot.LogonState = 'ok';
            }
          }

          Stage = 'StatusGet';
          const StatusReply = await Call('StatusGet', 0);
          if ('Error' in StatusReply) {
            // Logon required / Standby are Q-SYS's own codes; method-not-found
            // from some other JSON-RPC server is not a Core.
            const Code = StatusReply.Error.Code;
            if (Code === ERR_LOGON_REQUIRED || Code === ERR_STANDBY) Snapshot.IsQsys = true;
            Snapshot.StatusGetError = DescribeError(StatusReply.Error);
          } else {
            const Parsed = ParseCoreStatus(StatusReply.Result);
            if (Parsed) {
              Snapshot.IsQsys = true;
              Snapshot.Status = Parsed;
              Snapshot.StatusSource = 'StatusGet';
            }
          }

          if (ControlNames.length && Snapshot.IsQsys) {
            const State = Snapshot.Status ? Snapshot.Status.State : null;
            if (!Snapshot.Status) {
              Snapshot.ControlsSkipped = 'Core status unknown';
            } else if (State !== 'Active') {
              Snapshot.ControlsSkipped = `Core is ${State || 'not Active'}`;
            } else {
              Stage = 'Control.Get';
              const Batch = await Call('Control.Get', ControlNames);
              if (!('Error' in Batch)) {
                Snapshot.Controls = ParseControlResult(ControlNames, Batch.Result);
              } else {
                // One unknown name fails the whole batch, so ask one at a time
                // to say WHICH control is missing.
                const Readings: ControlReading[] = [];
                for (const Name of ControlNames) {
                  const One = await Call('Control.Get', [Name]);
                  if ('Error' in One) {
                    Readings.push({ Name, Found: false, Error: DescribeError(One.Error) });
                  } else {
                    Readings.push(...ParseControlResult([Name], One.Result));
                  }
                }
                Snapshot.Controls = Readings;
              }
            }
          }
          if (Devices && Snapshot.IsQsys) {
            const State = Snapshot.Status ? Snapshot.Status.State : null;
            if (!Snapshot.Status) {
              Snapshot.DevicesSkipped = 'Core status unknown';
            } else if (State !== 'Active') {
              Snapshot.DevicesSkipped = `Core is ${State || 'not Active'}`;
            } else {
              await ReadDevices(Call, Devices, Snapshot, (Next) => {
                Stage = Next;
              });
            }
          }
          Session.Finish(Reached(Session));
        } catch (Err) {
          if (Err instanceof SessionEnded) return; // already settled by timeout/close
          Session.Finish({
            Reachable: false,
            Error: Err instanceof Error ? Err.message : String(Err),
            Refused: false,
          });
        }
      })();
    },
  });
}

type RpcCall = (Method: string, Params: unknown) => Promise<RpcReply>;

// Choose and read the design devices. Readings are put on the Snapshot before
// any is sent, so a probe that runs out of time still reports the ones that
// answered.
async function ReadDevices(
  Call: RpcCall,
  Plan: DevicePlan,
  Snapshot: CoreSnapshot,
  SetStage: (Stage: string) => void
): Promise<void> {
  let Wanted: Array<{ Component: DesignComponent; Category: DeviceCategory }>;
  if (Plan.Source === 'list') {
    if (!Plan.Names.length) {
      Snapshot.Devices = [];
      return;
    }
    // The Type is unknown without GetComponents. It is only fetched when
    // amplifier faults are wanted, so a listed Amp Output still gets its fault
    // LEDs read; a failure here is not fatal.
    const Types = new Map<string, string | null>();
    if (Plan.AmpFaults) {
      SetStage('Component.GetComponents');
      const Listing = await Call('Component.GetComponents', 'test');
      if (!('Error' in Listing)) {
        for (const Component of ParseComponentList(Listing.Result)) {
          Types.set(Component.Name, Component.Type);
        }
      }
    }
    Wanted = Plan.Names.map((Name) => {
      const Type = Types.get(Name) ?? null;
      return { Component: { Name, Type }, Category: CategorizeType(Type) ?? 'other' };
    });
  } else {
    SetStage('Component.GetComponents');
    // The QRC page lists no parameters but its example sends "test"; Q-SYS's
    // own QRWC library sends the same, so this mirrors both.
    const Listing = await Call('Component.GetComponents', 'test');
    if ('Error' in Listing) {
      Snapshot.DiscoveryError = DescribeError(Listing.Error);
      return;
    }
    const Enabled = new Set(Plan.Categories);
    const Unmatched: DesignComponent[] = [];
    Wanted = [];
    for (const Component of ParseComponentList(Listing.Result)) {
      const Category = CategorizeType(Component.Type);
      if (Category == null) continue; // not a device status component
      if (Enabled.has(Category)) Wanted.push({ Component, Category });
      else if (Category === 'other') Unmatched.push(Component);
    }
    Snapshot.DevicesUnmatched = Unmatched;
  }

  if (Wanted.length > MAX_DEVICES) {
    Snapshot.DevicesOverLimit = Wanted.length - MAX_DEVICES;
    Wanted = Wanted.slice(0, MAX_DEVICES);
  }
  const Readings = Wanted.map((Entry) => NewDeviceReading(Entry.Component, Entry.Category));
  Snapshot.Devices = Readings;
  if (!Readings.length) return;

  SetStage('Component.Get');
  // A few at a time, matched by id: a big design is read in a handful of round
  // trips without one burst of a hundred requests at the Core.
  let Next = 0;
  const Worker = async (): Promise<void> => {
    for (let Reading = Readings[Next++]; Reading; Reading = Readings[Next++]) {
      // Only an Amp Output component carries the channel fault LEDs, so only
      // it is read whole; everything else asks for the status control alone.
      const AllControls = Plan.AmpFaults && IsAmpOutputType(Reading.Type);
      const Reply = AllControls
        ? await Call('Component.GetControls', { Name: Reading.Name })
        : await Call('Component.Get', {
            Name: Reading.Name,
            Controls: [{ Name: Plan.StatusControl }],
          });
      if ('Error' in Reply) ApplyDeviceError(Reading, Reply.Error);
      else ApplyDeviceResult(Reading, Reply.Result, Plan.StatusControl, AllControls);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, Readings.length) }, Worker));
}

// --- Evaluation ----------------------------------------------------------------

// The reasons a reachable Core is unhealthy, per the enabled options. Pure;
// exported via _internal for unit tests.
function EvaluateHealth(Snapshot: CoreSnapshot, Options: HealthOptions): string[] {
  if (!Snapshot.IsQsys) return ['Responded, but not as a Q-SYS Core (QRC)'];

  const Reasons: string[] = [];
  // A Core answers a bad PIN with error 10 "Logon required", the same code a
  // missing logon gets, so the two cases are told apart by whether one was sent.
  const LogonRejected = Snapshot.LogonState === 'rejected';
  if (LogonRejected) Reasons.push('Logon rejected (check the user and PIN)');
  if (Snapshot.StatusGetError) {
    const NeedsLogon = /logon required|\(10\)$/i.test(Snapshot.StatusGetError);
    if (!NeedsLogon) Reasons.push(`StatusGet failed: ${Snapshot.StatusGetError}`);
    else if (!LogonRejected) Reasons.push('Logon required: set a user and PIN');
  }
  if (Snapshot.Incomplete) Reasons.push(Snapshot.Incomplete);

  const Status = Snapshot.Status;
  if (Status) {
    // EngineStatus carries no Status object, so the code is only judged when
    // StatusGet itself answered.
    if (Options.CheckStatus && Status.StatusCode != null && Status.StatusCode !== 0) {
      const Label = StatusLabel(Status.StatusCode);
      const Text = (Status.StatusString || '').trim();
      Reasons.push(
        Text && Text.toLowerCase() !== Label.toLowerCase()
          ? `Core status ${Label}: ${Text}`
          : `Core status ${Label}`
      );
    }
    if (Options.RequireActive && Status.State != null && Status.State !== 'Active') {
      Reasons.push(
        Status.State === 'Idle'
          ? 'Core is Idle (no design running)'
          : `Core is ${Status.State} (not Active)`
      );
    }
    if (Options.CheckDesign) {
      const Design = (Status.DesignName || '').trim();
      if (!Design) {
        Reasons.push('No design running');
      } else if (
        Options.ExpectedDesign &&
        Design.toLowerCase() !== Options.ExpectedDesign.toLowerCase()
      ) {
        Reasons.push(`Design "${Design}" (expected "${Options.ExpectedDesign}")`);
      }
    }
  }

  if (Options.CheckControls) {
    for (const Entry of Options.InvalidAssertions) {
      Reasons.push(`Invalid control assertion "${Entry}" (use Name=Value)`);
    }
    for (const Reading of Snapshot.Controls || []) {
      const Assertion = Options.Assertions.find((A) => A.Name === Reading.Name);
      if (!Assertion) continue;
      if (!Reading.Found) {
        Reasons.push(
          `Control "${Reading.Name}" not found${Reading.Error ? ` (${Reading.Error})` : ''}`
        );
      } else if (!ControlMatches(Assertion.Expected, Reading)) {
        Reasons.push(
          `Control "${Reading.Name}" is ${DescribeReading(Reading)} (expected ${Assertion.Expected})`
        );
      }
    }
  }

  if (Options.CheckDevices) Reasons.push(...EvaluateDevices(Snapshot, Options.Devices));
  return Reasons;
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Success: false, Error: `Invalid port: ${Config.Port}` };
  }
  const Options = ParseHealthOptions(Target);
  const Names = Array.from(new Set(Options.Assertions.map((A) => A.Name)));

  const Probe = await QueryCore(Config, Names, Options.CheckDevices ? Options.Devices : null);
  if (!Probe.Reachable) {
    return { Success: false, ...(Probe.Refused ? { Degraded: true } : {}), Error: Probe.Error };
  }

  const { Snapshot } = Probe;
  const Reasons = EvaluateHealth(Snapshot, Options);
  const Status = Snapshot.Status;
  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs: Probe.LatencyMs,
    IsQsys: Snapshot.IsQsys,
    Platform: Status ? Status.Platform : null,
    State: Status ? Status.State : null,
    DesignName: Status ? Status.DesignName : null,
    DesignCode: Status ? Status.DesignCode : null,
    IsRedundant: Status ? Status.IsRedundant : null,
    IsEmulator: Status ? Status.IsEmulator : null,
    StatusCode: Status ? Status.StatusCode : null,
    StatusString: Status ? Status.StatusString : null,
    StatusSource: Snapshot.StatusSource,
    LogonState: Snapshot.LogonState,
    LogonError: Snapshot.LogonError,
    Controls: Snapshot.Controls,
    ControlsSkipped: Snapshot.ControlsSkipped,
    ...(Options.CheckDevices
      ? {
          Devices: Snapshot.Devices,
          DevicesSkipped: Snapshot.DevicesSkipped,
          DiscoveryError: Snapshot.DiscoveryError,
          DevicesUnmatched: Snapshot.DevicesUnmatched,
          DevicesOverLimit: Snapshot.DevicesOverLimit,
        }
      : {}),
  };
}

// --- Actions -----------------------------------------------------------------

const Actions: MonitoringActionDef[] = [
  {
    ID: 'snapshot.load',
    Label: 'Load Snapshot',
    Icon: 'collection-play',
    Group: 'Snapshots',
    Destructive: true,
    Params: [
      {
        Key: 'Bank',
        Label: 'Snapshot bank',
        Type: 'string',
        Default: '',
        Required: true,
        Note: 'The name of the snapshot bank, as given to it in Q-SYS Designer.',
      },
      {
        Key: 'Snapshot',
        Label: 'Snapshot',
        Type: 'number',
        Required: true,
        Note: 'The snapshot number within the bank, starting at 1.',
      },
      {
        Key: 'Ramp',
        Label: 'Ramp (seconds)',
        Type: 'number',
        Default: 0,
        Note: 'How long the Core takes to move the controls to the snapshot. 0 loads it at once.',
      },
    ],
    Note: 'Recalls a saved snapshot, changing every control it holds. Sent only to the Active Core.',
  },
  {
    ID: 'control.set',
    Label: 'Set Named Control',
    Icon: 'sliders',
    Group: 'Named Controls',
    Destructive: true,
    Params: [
      {
        Key: 'Name',
        Label: 'Named Control',
        Type: 'string',
        Default: '',
        Required: true,
        Note: 'The control’s name in the Named Controls list in Q-SYS Designer.',
      },
      {
        Key: 'Value',
        Label: 'Value',
        Type: 'string',
        Default: '',
        Required: true,
        Note: 'A number (e.g. -6 for a gain), true or false (e.g. for a mute), or text. Sent only to the Active Core.',
      },
    ],
    Note: 'Sets one Named Control to a value, e.g. a mute or a gain.',
  },
];

// The Value a Control.Set carries. QRC takes a number, string or boolean: the
// words true / false become booleans (a mute or toggle), a number becomes a
// number (a gain), and anything else is sent as text (a combo box choice).
function ParseControlValue(Raw: unknown): string | number | boolean | null {
  if (Raw == null || typeof Raw === 'object') return null;
  if (typeof Raw === 'boolean') return Raw;
  if (typeof Raw === 'number') return Number.isFinite(Raw) ? Raw : null;
  const Text = String(Raw).trim();
  if (!Text) return null;
  const Lower = Text.toLowerCase();
  if (Lower === 'true') return true;
  if (Lower === 'false') return false;
  if (NUMBER_RE.test(Text)) return Number(Text);
  return Text;
}

function ParamText(Value: unknown): string {
  return Value == null || typeof Value === 'object' ? '' : String(Value).trim();
}

type CommandOutcome = { Ok: true; Result: unknown } | { Ok: false; Error: string };

// Words for a refusal every command can get.
function SessionRefusal(Err: QrcError): string | null {
  if (Err.Code === ERR_LOGON_REQUIRED) {
    return 'The Core needs a logon. Set the user and PIN on this check.';
  }
  if (Err.Code === ERR_STANDBY) {
    return 'The Core is on Standby. Commands are only sent to the Active Core.';
  }
  return null;
}

// One short session: Logon (when a user is set), StatusGet to confirm the Core
// is Active, then the one command. The configured Timeout covers all of it.
function SendCoreCommand(
  Config: QsysConfig,
  Method: string,
  Params: unknown,
  DescribeRefusal: (Err: QrcError) => string
): Promise<CommandOutcome> {
  const BudgetMs = Math.max(500, Config.TimeoutMs | 0);
  // A Core announces itself with EngineStatus on connect, so a silent Core and
  // a device that is not a Core at all can be told apart.
  let SawCore = false;
  const Channel = new QrcChannel((Obj) => {
    if (Obj.method === 'EngineStatus') SawCore = true;
  });
  let Answered = false;
  const Ended = (NoReply: string): CommandOutcome => ({
    Ok: false,
    Error: Answered
      ? `The Core did not confirm the command within ${BudgetMs}ms`
      : SawCore
        ? `The Core did not answer within ${BudgetMs}ms`
        : Channel.BytesSeen
          ? 'The device did not answer as a Q-SYS Core'
          : NoReply,
  });
  return RunTcpSession<CommandOutcome>({
    Address: Config.Address,
    Port: Config.Port,
    IdleMs: BudgetMs,
    DeadlineMs: BudgetMs,
    NoDelay: true,
    OnSettle: () => Channel.Close(),
    OnData: (Chunk, Session) => {
      if (!Channel.Feed(Chunk)) {
        Session.Finish({ Ok: false, Error: 'The device did not answer as a Q-SYS Core' });
      }
    },
    OnTimeout: () => Ended(`No reply from the Q-SYS Core after ${BudgetMs}ms`),
    OnError: (Message) => ({ Ok: false, Error: Message }),
    OnClose: () => Ended('Connection closed before any reply'),
    OnConnect: (Session) => {
      const Call = (M: string, P: unknown) => Channel.Call(Session.Socket, M, P);
      void (async () => {
        try {
          if (Config.User) {
            const Logon = await Call('Logon', { User: Config.User, Password: Config.Password });
            if ('Error' in Logon) {
              Session.Finish({
                Ok: false,
                Error: 'The Core refused the logon. Check the user and PIN on this check.',
              });
              return;
            }
          }
          const StatusReply = await Call('StatusGet', 0);
          if ('Error' in StatusReply) {
            Session.Finish({
              Ok: false,
              Error:
                SessionRefusal(StatusReply.Error) ||
                `The Core did not report its state: ${DescribeError(StatusReply.Error)}`,
            });
            return;
          }
          const Status = ParseCoreStatus(StatusReply.Result);
          if (!Status) {
            Session.Finish({ Ok: false, Error: 'The device did not answer as a Q-SYS Core' });
            return;
          }
          if (Status.State !== 'Active') {
            Session.Finish({
              Ok: false,
              Error: `The Core is ${Status.State || 'not Active'}, not Active. Commands are only sent to the Active Core.`,
            });
            return;
          }
          Answered = true;
          const Reply = await Call(Method, Params);
          if ('Error' in Reply) {
            Session.Finish({
              Ok: false,
              Error: SessionRefusal(Reply.Error) || DescribeRefusal(Reply.Error),
            });
            return;
          }
          Session.Finish({ Ok: true, Result: Reply.Result });
        } catch (Err) {
          if (Err instanceof SessionEnded) return;
          Session.Finish({ Ok: false, Error: Err instanceof Error ? Err.message : String(Err) });
        }
      })();
    },
  });
}

function FormatRamp(Ramp: number): string {
  return Ramp > 0 ? ` over ${Ramp} s` : '';
}

async function RunAction(
  Target: MonitoringTargetLike,
  ActionID: string,
  Params: Record<string, unknown>
): Promise<MonitoringActionResult> {
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Success: false, Error: `Invalid port: ${Config.Port}` };
  }
  const P = Params || {};

  if (ActionID === 'snapshot.load') {
    const Bank = ParamText(P.Bank);
    if (!Bank) return { Success: false, Error: 'Enter the snapshot bank name' };
    const SnapshotNo = PrimNumber(P.Snapshot);
    if (SnapshotNo == null || !Number.isInteger(SnapshotNo) || SnapshotNo < 1) {
      return { Success: false, Error: 'The snapshot number must be a whole number from 1 up' };
    }
    const RampRaw = P.Ramp == null || P.Ramp === '' ? 0 : PrimNumber(P.Ramp);
    if (RampRaw == null || RampRaw < 0 || RampRaw > 600) {
      return { Success: false, Error: 'The ramp must be between 0 and 600 seconds' };
    }
    // QRC_Commands: Name is the bank, Bank is the snapshot number within it,
    // Ramp is optional (seconds).
    const Wire: Record<string, unknown> = { Name: Bank, Bank: SnapshotNo };
    if (RampRaw > 0) Wire.Ramp = RampRaw;
    const Outcome = await SendCoreCommand(
      Config,
      'Snapshot.Load',
      Wire,
      (Err) => `The Core did not load snapshot ${SnapshotNo} from "${Bank}": ${DescribeError(Err)}`
    );
    if (!Outcome.Ok) return { Success: false, Error: Outcome.Error };
    return {
      Success: true,
      Detail: `Snapshot ${SnapshotNo} loaded from "${Bank}"${FormatRamp(RampRaw)}`,
    };
  }

  if (ActionID === 'control.set') {
    const Name = ParamText(P.Name);
    if (!Name) return { Success: false, Error: 'Enter the Named Control to set' };
    const Value = ParseControlValue(P.Value);
    if (Value == null) return { Success: false, Error: `Enter a value for "${Name}"` };
    const Outcome = await SendCoreCommand(Config, 'Control.Set', { Name, Value }, (Err) =>
      Err.Code === ERR_UNKNOWN_CONTROL
        ? `The Core has no Named Control called "${Name}"`
        : `The Core did not set "${Name}": ${DescribeError(Err)}`
    );
    if (!Outcome.Ok) return { Success: false, Error: Outcome.Error };
    return { Success: true, Detail: `${Name} set to ${String(Value)}` };
  }

  return { Success: false, Error: `Unknown Q-SYS action "${ActionID}"` };
}

// Offer the Named Controls this check already reads (its control assertions)
// as the choices for Set Named Control.
function GetActionOptions(Result: MonitoringResult): MonitoringActionOptions {
  const Readings = Result && Array.isArray(Result.Controls) ? Result.Controls : null;
  if (!Readings) return {};
  const Names: string[] = [];
  for (const Reading of Readings) {
    const Name =
      Reading && typeof Reading === 'object' ? (Reading as { Name?: unknown }).Name : null;
    if (typeof Name === 'string' && Name && !Names.includes(Name)) Names.push(Name);
  }
  if (!Names.length) return {};
  return { Name: Names.map((Name) => ({ value: Name, label: Name })) };
}

// Bind the parameters into a favourite's label.
function DescribeAction(ActionID: string, Params: Record<string, unknown>): string | null {
  const P = Params || {};
  if (ActionID === 'snapshot.load') {
    const Bank = ParamText(P.Bank);
    const SnapshotNo = PrimNumber(P.Snapshot);
    if (!Bank || SnapshotNo == null) return null;
    const Ramp = PrimNumber(P.Ramp) || 0;
    return `Load Snapshot - ${Bank} ${SnapshotNo}${FormatRamp(Ramp)}`;
  }
  if (ActionID === 'control.set') {
    const Name = ParamText(P.Name);
    const Value = ParseControlValue(P.Value);
    if (!Name || Value == null) return null;
    return `Set ${Name} - ${String(Value)}`;
  }
  return null;
}

// --- Debug panel -----------------------------------------------------------------

const LOGON_LABELS: Record<LogonState, string> = {
  'not-attempted': 'Not attempted',
  ok: 'Logged on',
  rejected: 'Rejected',
};

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseConfig(Target);
  const Options = ParseHealthOptions(Target);
  const Reachable = !!(Result && Result.Success === true);
  const Degraded = !!(Result && Result.Degraded);
  const StatePill = !Reachable
    ? Pill('danger', 'Offline')
    : Degraded
      ? Pill('warning', Result.DegradedReason || 'Degraded')
      : Pill('success', 'Healthy');

  const Head = [
    TextRow('Host', `${Config.Address || '-'}:${Config.Port}`),
    Row('Status', StatePill),
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Failed to reach the Core'),
  ];
  if (!Reachable) {
    return (
      Rows(Head) +
      '<div class="mt-2">' +
      Note(`Failed to reach Q-SYS Remote Control on TCP ${Config.Port}`) +
      '</div>'
    );
  }
  if (Result.IsQsys === false) {
    return (
      Rows(Head) +
      '<div class="mt-2">' +
      Note('The device answered, but not as a Q-SYS Core') +
      '</div>'
    );
  }

  const Code = Result.StatusCode == null ? null : Number(Result.StatusCode);
  const StatusText =
    Code == null
      ? null
      : `${StatusLabel(Code)}${
          Result.StatusString &&
          String(Result.StatusString).trim().toLowerCase() !== StatusLabel(Code).toLowerCase()
            ? ` - ${String(Result.StatusString)}`
            : ''
        }`;
  const Flags: string[] = [];
  if (Result.IsRedundant === true) Flags.push('Redundant');
  if (Result.IsEmulator === true) Flags.push('Emulator');

  const Body = [
    ...Head,
    Result.Platform != null && Result.Platform !== ''
      ? TextRow('Platform', String(Result.Platform))
      : null,
    Result.State != null
      ? Row('State', Pill(Result.State === 'Active' ? 'success' : 'warning', String(Result.State)))
      : null,
    StatusText != null
      ? Row('Core status', Pill(Code === 0 ? 'success' : 'warning', StatusText))
      : null,
    Result.DesignName != null
      ? TextRow(
          'Design',
          (String(Result.DesignName) || '(none)') +
            (Options.CheckDesign && Options.ExpectedDesign
              ? ` (expected "${Options.ExpectedDesign}")`
              : '')
        )
      : null,
    Result.DesignCode ? TextRow('Design code', String(Result.DesignCode)) : null,
    Flags.length ? TextRow('Mode', Flags.join(' · ')) : null,
    Result.LogonState && Result.LogonState !== 'not-attempted'
      ? TextRow(
          'Logon',
          (LOGON_LABELS[Result.LogonState as LogonState] || String(Result.LogonState)) +
            (Result.LogonError ? ` - ${String(Result.LogonError)}` : '')
        )
      : null,
    Result.StatusSource === 'EngineStatus'
      ? TextRow('Source', 'EngineStatus notification (StatusGet not answered)')
      : null,
  ];

  let ControlsHtml = '';
  if (Options.CheckControls && Options.Assertions.length) {
    const Readings = Array.isArray(Result.Controls) ? (Result.Controls as ControlReading[]) : null;
    if (!Readings) {
      ControlsHtml = Note(
        Result.ControlsSkipped
          ? `Named Controls not read: ${String(Result.ControlsSkipped)}`
          : 'Named Controls not read'
      );
    } else {
      ControlsHtml = Readings.map((Reading) => {
        const Assertion = Options.Assertions.find((A) => A.Name === Reading.Name);
        const Ok = !!Assertion && ControlMatches(Assertion.Expected, Reading);
        const Badge = !Reading.Found
          ? Pill('danger', 'Not found')
          : Ok
            ? Pill('success', DescribeReading(Reading))
            : Pill('warning', DescribeReading(Reading));
        const Detail = Reading.Found
          ? `Expected ${Assertion ? Assertion.Expected : '-'} · value ${Reading.Value === undefined ? '-' : String(Reading.Value)}`
          : Reading.Error || 'Not found';
        return Card({
          Title: Reading.Name,
          TitleClass: 'font-monospace',
          Badge,
          Highlight: Ok,
          BodyHtml: `<div class="text-muted small text-break">${Esc(Detail)}</div>`,
        });
      }).join('');
    }
    ControlsHtml = `<div class="mt-2 d-grid gap-1">${ControlsHtml}</div>`;
  }

  return Rows(Body) + ControlsHtml + DevicesDebug(Result, Options);
}

// One card per design device: its status as the Core reports it, plus any lit
// amplifier fault, then notes for what was skipped or not matched.
function DevicesDebug(Result: MonitoringResult, Options: HealthOptions): string {
  if (!Options.CheckDevices) return '';
  const Plan = Options.Devices;
  const Parts: string[] = ['<div class="text-muted small mt-2">Design devices</div>'];
  if (Result.DevicesSkipped) {
    Parts.push(Note(`Devices not read: ${String(Result.DevicesSkipped)}`));
  } else if (Result.DiscoveryError) {
    Parts.push(Note(`Could not list design devices: ${String(Result.DiscoveryError)}`));
  } else if (!Array.isArray(Result.Devices)) {
    Parts.push(Note('Devices not read'));
  } else {
    const Readings = Result.Devices as DeviceReading[];
    if (!Readings.length) {
      Parts.push(
        Note(
          Plan.Source === 'list'
            ? 'No devices listed'
            : 'No devices found in the enabled categories. Each needs Script Access set to External or All.'
        )
      );
    }
    for (const Reading of Readings) {
      // Discovery reads every component in a category; ones with no status
      // control are not devices and are left out of the table.
      if (
        Plan.Source === 'discover' &&
        Reading.Read &&
        Reading.Found &&
        !Reading.HasStatus &&
        !Reading.Faults.length &&
        !Reading.Error
      ) {
        continue;
      }
      const Bad = DeviceStatusBad(Reading, Plan.FlagNotPresent) || Reading.Faults.length > 0;
      let Badge: string;
      if (!Reading.Read) Badge = Pill('muted', 'Not read in time');
      else if (!Reading.Found) Badge = Pill('danger', 'Not found');
      else if (Reading.Error) Badge = Pill('danger', 'Error');
      else if (!Reading.HasStatus)
        Badge = Pill('warning', Reading.Faults.length ? 'Channel fault' : 'No status control');
      else if (Reading.StatusCode == null) Badge = Pill('muted', Reading.StatusString || 'Unknown');
      else Badge = Pill(Bad ? 'warning' : 'success', DescribeDeviceStatus(Reading));
      const Detail = [
        CATEGORY_LABELS[Reading.Category] || 'Device',
        Reading.Type ? `type ${Reading.Type}` : null,
        Reading.Faults.length ? `faults: ${Reading.Faults.join(', ')}` : null,
        Reading.FaultsChecked && !Reading.Faults.length ? 'no channel faults' : null,
        Reading.Error,
      ]
        .filter(Boolean)
        .join(' · ');
      Parts.push(
        Card({
          Title: Reading.Name,
          TitleClass: 'font-monospace',
          Badge,
          Highlight: Reading.Read && Reading.HasStatus && !Bad,
          BodyHtml: `<div class="text-muted small text-break">${Esc(Detail)}</div>`,
        })
      );
    }
    const OverLimit = Number(Result.DevicesOverLimit) || 0;
    if (OverLimit > 0) {
      Parts.push(Note(`${OverLimit} more devices not read (limit ${MAX_DEVICES} per check)`));
    }
  }
  const Unmatched = Array.isArray(Result.DevicesUnmatched)
    ? (Result.DevicesUnmatched as DesignComponent[])
    : [];
  if (Unmatched.length) {
    const Shown = Unmatched.slice(0, 12)
      .map((Component) =>
        Component.Type ? `${Component.Name} (${Component.Type})` : Component.Name
      )
      .join(', ');
    const More = Unmatched.length > 12 ? ` and ${Unmatched.length - 12} more` : '';
    Parts.push(
      Note(
        `Not in a device category: ${Shown}${More}. Turn on Other devices, or list a device by its Code Name, to check it.`
      )
    );
  }
  return `<div class="mt-2 d-grid gap-1">${Parts.join('')}</div>`;
}

export const Name = 'Q-SYS Core';
export const Description =
  'Connects to a Q-SYS Core over Q-SYS Remote Control (QRC, TCP 1710) and reads its status, state, running design and redundancy flags without changing anything. Reports Degraded when the Core status is not OK or the Core is not Active, and optionally when the design or listed Named Controls are not as expected, or when an amplifier, I/O frame, camera, bridge or touch panel in the design is not OK. Its actions load a snapshot or set a Named Control on the Active Core.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseConfig,
  ParseHealthOptions,
  ParseControlAssertions,
  SplitFrames,
  ParseError,
  ParseCoreStatus,
  ParseControlResult,
  OneMatches,
  ControlMatches,
  StatusLabel,
  EvaluateHealth,
  QueryCore,
  ParseDevicePlan,
  CategorizeType,
  ParseComponentList,
  ApplyDeviceResult,
  IsLitFault,
  EvaluateDevices,
  DeviceStatusLabel,
  ParseControlValue,
};
export { ID, Settings, Actions, Run, RunAction, GetActionOptions, DescribeAction, Debug };
