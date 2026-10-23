// Biamp Tesira health over the Tesira Text Protocol (TTP) on Telnet, TCP 23.
// Covers Tesira SERVER / SERVER-IO, TesiraFORTÉ and TesiraLUX: anything that
// runs a TTP server. One short-lived session per probe:
//
//   1. Telnet option negotiation. Tesira opens by offering options (IAC WILL /
//      IAC DO …) and, per Biamp's Telnet page, "if the Control System does not
//      respond to the Telnet session options negotiations, the session will not
//      go ahead". Every offer is refused, exactly as Biamp prescribes for a raw
//      client: WILL → DON'T, DO → WON'T, option byte returned as received.
//   2. Login, only if the device prompts for it. Biamp's TTP Security page says
//      a Telnet session "results in a login prompt"; an unprotected system
//      accepts default / default. The prompt TEXT is not documented: it is
//      recognised by its trailing "login:" / "username:" / "password:", the
//      same rule the Bitfocus Companion Tesira module uses (inferred, not
//      Biamp-documented). A second prompt of the same kind means the
//      credentials were refused.
//   3. The banner "Welcome to the Tesira Text Protocol Server" marks the
//      session as ready (documented).
//   4. Reads, one at a time, each answered by a single "+OK …" or "-ERR …" line:
//        DEVICE get deviceInfo        model, revision, serial, firmware
//          (falls back to DEVICE get serialNumber + DEVICE get version when a
//           firmware answers -ERR; deviceInfo's response shape is documented
//           only as a field list, so its "value" wrapper is inferred from the
//           other DEVICE gets)
//        DEVICE get networkStatus     hostname, per-interface link / IP / MAC
//        DEVICE get activeFaultList   the active fault list
//        DEVICE get networkPortInfo   only when port checks are enabled
//        <InstanceTag> get <attribute> [index …]   only when attribute
//          assertions are enabled
//
// TTP values are JSON-like but not JSON: members are separated by spaces, not
// commas, and enumerations are bare words (LINK_1_GB, INDICATOR_NONE_IN_DEVICE),
// so they go through a tolerant parser of their own (ParseTtpValue).
//
// Everything the check sends is a `get`; nothing in Run() changes the device.
// The operator actions (preset recall, mute) are separate presses, each on its
// own session; see Controllable actions below. SSH (TCP 22) is
// not supported: it would need an SSH client library, and this probe uses Node
// built-ins only. Telnet must be enabled on the device (it is off by default
// since 2016-era firmware).
import { StringDecoder } from 'string_decoder';
import { ReplyQueue, RunTcpSession, type TcpSession } from './_tcp-session';
import { Card, Esc, FormatLatency, Note, Pill, Row, Rows, TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type {
  MonitoringActionDef,
  MonitoringActionResult,
  MonitoringResult,
  MonitoringSettingField,
  MonitoringTargetLike,
} from './types';

const ID = 'biamp-tesira';
const DEFAULT_PORT = 23;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_USERNAME = 'default';
// A networkPortInfo or danteInfo answer runs to a few kilobytes; anything this
// large is not a TTP reply.
const MAX_BUFFERED_CHARS = 1_000_000;
const MAX_VALUE_DEPTH = 64;
const BANNER = 'Welcome to the Tesira Text Protocol Server';

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'Telnet port',
    Type: 'number',
    Default: DEFAULT_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
    Note: 'Tesira’s TTP server listens for Telnet on port 23. Telnet must be enabled in the device’s network settings.',
  },
  {
    Key: 'Username',
    Label: 'Username',
    Type: 'string',
    Default: DEFAULT_USERNAME,
    Note: 'Only sent when the device asks for a login. An unprotected system uses default. On a protected system an observer is enough for the check; the actions need a controller or higher.',
  },
  {
    Key: 'Password',
    Label: 'Password',
    Type: 'string',
    Default: 'default',
    Sensitive: true,
    Note: 'The password of the user above. Only sent when the device asks for one.',
  },
  {
    Key: 'CheckFaults',
    Label: 'Check active faults',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded while the device’s active fault list is not empty, quoting each fault. Faults on expanders that use this device as their proxy are included.',
  },
  {
    Key: 'FaultSeverity',
    Label: 'Faults that count',
    Type: 'select',
    Default: 'any',
    Options: [
      { value: 'any', label: 'Major and minor faults' },
      { value: 'major', label: 'Major faults only' },
    ],
    VisibleWhen: { Key: 'CheckFaults', Equals: true },
    Note: 'Minor faults include warnings such as a fan or temperature warning. Pick major faults only to ignore them.',
  },
  {
    Key: 'CheckPorts',
    Label: 'Check network port links',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when a listed network port has no link.',
  },
  {
    Key: 'RequiredPorts',
    Label: 'Ports that must have link',
    Type: 'list',
    ItemType: 'string',
    Default: [],
    VisibleWhen: { Key: 'CheckPorts', Equals: true },
    Note: 'Port names as the device reports them, e.g. control, P1 or P2. Matched without regard to case.',
  },
  {
    Key: 'CheckAttributes',
    Label: 'Check block attributes',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when a listed block attribute does not hold its expected value.',
  },
  {
    Key: 'AttributeAssertions',
    Label: 'Attribute assertions',
    Type: 'list',
    ItemType: 'string',
    Default: [],
    VisibleWhen: { Key: 'CheckAttributes', Equals: true },
    Note: 'One per entry: instance tag, attribute and any indexes, then =expected value. For example Level1 mute 1=false or Level1 level 1=-10. Instance tags are case sensitive. Numbers compare numerically and true/false match on/off.',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: DEFAULT_TIMEOUT_MS,
    Min: 500,
    Max: 30000,
    Advanced: true,
    Note: 'Budget for the whole session: connect, Telnet negotiation, login and every read.',
  },
];

// --- Options -----------------------------------------------------------------

export interface AttributeAssertion {
  // The entry as written, for messages.
  Label: string;
  InstanceTag: string;
  Attribute: string;
  Indexes: string[];
  Expected: string;
}

interface TesiraConfig {
  Address: string;
  Port: number;
  Username: string;
  Password: string;
  TimeoutMs: number;
}

interface HealthOptions {
  CheckFaults: boolean;
  MajorOnly: boolean;
  CheckPorts: boolean;
  RequiredPorts: string[];
  CheckAttributes: boolean;
  Assertions: AttributeAssertion[];
  // Entries that could not be read as an assertion; reported, never sent.
  InvalidAssertions: string[];
}

function ParseConfig(Target: MonitoringTargetLike): TesiraConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number(Cfg.Port);
  const Timeout = Number(Cfg.Timeout);
  const Username = Cfg.Username == null ? '' : String(Cfg.Username).trim();
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Port: Number.isFinite(Port) && Port > 0 ? Port | 0 : DEFAULT_PORT,
    Username: Username || DEFAULT_USERNAME,
    Password: Cfg.Password == null ? '' : String(Cfg.Password),
    TimeoutMs: Number.isFinite(Timeout) && Timeout > 0 ? Timeout : DEFAULT_TIMEOUT_MS,
  };
}

// Split a command line into words. A "double-quoted" word may hold spaces (TTP
// quotes values that way; quoting an instance tag that contains spaces is the
// same rule applied to the first word, which Biamp does not spell out).
function SplitWords(Text: string): string[] | null {
  const Words: string[] = [];
  const Re = /"([^"]*)"|(\S+)/g;
  let Match: RegExpExecArray | null;
  while ((Match = Re.exec(Text))) {
    const Word = Match[1] ?? Match[2] ?? '';
    if (Match[2] != null && Match[2].includes('"')) return null; // stray quote
    Words.push(Word);
  }
  return Words;
}

// Any control character (CR/LF above all) in an entry could smuggle a second
// command onto the line, so such entries are refused outright.
function HasControlChar(Text: string): boolean {
  for (let I = 0; I < Text.length; I++) {
    const Code = Text.charCodeAt(I);
    if (Code < 0x20 || Code === 0x7f) return true;
  }
  return false;
}

// The username and password are typed at the login prompt as a line each, so a
// line break in either would put a second line (a command) on the session.
function CheckCredentials(Config: TesiraConfig): string | null {
  return HasControlChar(Config.Username) || HasControlChar(Config.Password)
    ? 'The username or password contains a line break or other control character.'
    : null;
}

// `InstanceTag attribute [index …]=Expected`. The FIRST `=` separates them.
function ParseAttributeAssertions(Input: unknown): {
  Assertions: AttributeAssertion[];
  Invalid: string[];
} {
  const Assertions: AttributeAssertion[] = [];
  const Invalid: string[] = [];
  const List = Array.isArray(Input) ? Input : [];
  for (const Raw of List) {
    const Entry = String(Raw == null ? '' : Raw).trim();
    if (!Entry) continue;
    const Eq = Entry.indexOf('=');
    if (Eq <= 0 || HasControlChar(Entry)) {
      Invalid.push(Entry);
      continue;
    }
    const Words = SplitWords(Entry.slice(0, Eq).trim());
    if (!Words || Words.length < 2 || Words.some((W) => !W)) {
      Invalid.push(Entry);
      continue;
    }
    Assertions.push({
      Label: Entry.slice(0, Eq).trim(),
      InstanceTag: Words[0] as string,
      Attribute: Words[1] as string,
      Indexes: Words.slice(2),
      Expected: Entry.slice(Eq + 1).trim(),
    });
  }
  return { Assertions, Invalid };
}

function ParseHealthOptions(Target: MonitoringTargetLike): HealthOptions {
  const Cfg = (Target && Target.Settings) || {};
  const CheckPorts = Cfg.CheckPorts === true;
  const CheckAttributes = Cfg.CheckAttributes === true;
  const Parsed = CheckAttributes
    ? ParseAttributeAssertions(Cfg.AttributeAssertions)
    : { Assertions: [], Invalid: [] };
  const Ports = CheckPorts && Array.isArray(Cfg.RequiredPorts) ? Cfg.RequiredPorts : [];
  return {
    // Default ON: absent means enabled, so only an explicit false turns it off.
    CheckFaults: Cfg.CheckFaults !== false,
    MajorOnly: Cfg.FaultSeverity === 'major',
    CheckPorts,
    RequiredPorts: Array.from(
      new Set(Ports.map((P) => String(P == null ? '' : P).trim()).filter(Boolean))
    ),
    CheckAttributes,
    Assertions: Parsed.Assertions,
    InvalidAssertions: Parsed.Invalid,
  };
}

// Build the read for one assertion. Words with spaces are double-quoted.
function AttributeCommand(Assertion: AttributeAssertion): string {
  const Quote = (Word: string) => (/\s/.test(Word) ? `"${Word}"` : Word);
  return [Quote(Assertion.InstanceTag), 'get', Quote(Assertion.Attribute)]
    .concat(Assertion.Indexes.map(Quote))
    .join(' ');
}

// --- Telnet negotiation --------------------------------------------------------

const IAC = 0xff;
const SB = 0xfa;
const SE = 0xf0;
const WILL = 0xfb;
const WONT = 0xfc;
const DO = 0xfd;
const DONT = 0xfe;

/**
 * Separates Telnet commands from data and builds the refusals Biamp prescribes
 * (WILL → DON'T, DO → WON'T). Stateful, so a sequence split across TCP chunks
 * is still handled whole. IAC IAC is a literal 0xFF byte. Each offer is refused
 * once: a server that repeats an offer already refused gets no second answer,
 * so a confused peer cannot drive a negotiation loop.
 */
export class TelnetNegotiator {
  private State: 'data' | 'iac' | 'option' | 'sb' | 'sb-iac' = 'data';
  private Verb = 0;
  private readonly Refused = new Set<number>();

  Feed(Chunk: Buffer): { Data: Buffer; Reply: Buffer | null } {
    const Out: number[] = [];
    const Reply: number[] = [];
    for (const Byte of Chunk) {
      switch (this.State) {
        case 'data':
          if (Byte === IAC) this.State = 'iac';
          else Out.push(Byte);
          break;
        case 'iac':
          if (Byte === IAC) {
            Out.push(IAC);
            this.State = 'data';
          } else if (Byte >= WILL && Byte <= DONT) {
            this.Verb = Byte;
            this.State = 'option';
          } else if (Byte === SB) this.State = 'sb';
          else this.State = 'data'; // a two-byte command (NOP, GA, …)
          break;
        case 'option': {
          this.State = 'data';
          const Answer = this.Verb === WILL ? DONT : this.Verb === DO ? WONT : null;
          const Key = (this.Verb << 8) | Byte;
          if (Answer != null && !this.Refused.has(Key)) {
            this.Refused.add(Key);
            Reply.push(IAC, Answer, Byte);
          }
          break;
        }
        case 'sb':
          if (Byte === IAC) this.State = 'sb-iac';
          break;
        case 'sb-iac':
          this.State = Byte === SE ? 'data' : 'sb';
          break;
      }
    }
    return { Data: Buffer.from(Out), Reply: Reply.length ? Buffer.from(Reply) : null };
  }
}

// --- TTP value parsing -----------------------------------------------------------

export type TtpValue = string | number | boolean | null | TtpValue[] | { [Key: string]: TtpValue };

const NUMBER_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;
const BARE_STOP = new Set(['{', '}', '[', ']', '"', ':']);

class TtpReader {
  Pos = 0;
  constructor(private readonly Text: string) {}

  SkipSpace(): void {
    while (this.Pos < this.Text.length && /[\s,]/.test(this.Peek())) this.Pos++;
  }

  Peek(): string {
    return this.Text[this.Pos] || '';
  }

  Done(): boolean {
    this.SkipSpace();
    return this.Pos >= this.Text.length;
  }

  String(): string {
    // At an opening quote.
    this.Pos++;
    let Out = '';
    while (this.Pos < this.Text.length) {
      const Ch = this.Text[this.Pos++];
      if (Ch === '\\' && this.Pos < this.Text.length) Out += this.Text[this.Pos++];
      else if (Ch === '"') return Out;
      else Out += Ch;
    }
    return Out; // unterminated: keep what arrived
  }

  Bare(): string {
    const Start = this.Pos;
    while (this.Pos < this.Text.length && !/\s/.test(this.Peek()) && !BARE_STOP.has(this.Peek())) {
      this.Pos++;
    }
    return this.Text.slice(Start, this.Pos);
  }

  Value(Depth: number): TtpValue {
    if (Depth > MAX_VALUE_DEPTH) throw new Error('TTP value nested too deeply');
    this.SkipSpace();
    const Ch = this.Peek();
    if (Ch === '{') {
      this.Pos++;
      return this.Members('}', Depth + 1);
    }
    if (Ch === '[') {
      this.Pos++;
      const List: TtpValue[] = [];
      for (;;) {
        this.SkipSpace();
        if (this.Pos >= this.Text.length) return List;
        if (this.Peek() === ']') {
          this.Pos++;
          return List;
        }
        const Before = this.Pos;
        List.push(this.Value(Depth + 1));
        if (this.Pos === Before) this.Pos++; // a stray '}' or ':': skip it
      }
    }
    if (Ch === '"') return this.String();
    const Word = this.Bare();
    if (Word === 'true') return true;
    if (Word === 'false') return false;
    if (NUMBER_RE.test(Word)) return Number(Word);
    return Word;
  }

  // Object members, up to Close ('}' or end of text for a reply body).
  Members(Close: string, Depth: number): { [Key: string]: TtpValue } {
    const Obj: { [Key: string]: TtpValue } = Object.create(null);
    let LastKey: string | null = null;
    for (;;) {
      this.SkipSpace();
      if (this.Pos >= this.Text.length) return Obj;
      const Ch = this.Peek();
      if (Ch === Close) {
        this.Pos++;
        return Obj;
      }
      if (Ch === '"') {
        // Keys are trimmed: Biamp's own networkStatus example has `" telnetDisabled"`.
        const Key = this.String().trim();
        this.SkipSpace();
        if (this.Peek() === ':') {
          this.Pos++;
          Obj[Key] = this.Value(Depth);
        } else {
          Obj[Key] = null;
        }
        LastKey = Key;
        continue;
      }
      const Before = this.Pos;
      const Word = this.Bare();
      if (this.Pos === Before) {
        this.Pos++; // stray punctuation
        continue;
      }
      // An enumeration printed as two words ("portRole":INVALID PortRoleType in
      // Biamp's own example): the second word belongs to the previous value.
      if (LastKey != null && typeof Obj[LastKey] === 'string') {
        Obj[LastKey] = `${Obj[LastKey] as string} ${Word}`;
      }
    }
  }
}

/** Parse one TTP value. Never throws for malformed text; deep nesting is refused. */
function ParseTtpValue(Text: string): TtpValue {
  return new TtpReader(Text).Value(0);
}

export type TtpReply =
  { Ok: true; Body: TtpValue; Raw: string } | { Ok: false; Error: string; Raw: string };

// One reply line: `+OK`, `+OK "value":…`, `+OK "networkPortInfo":[…]`, the
// non-verbose `+OK [[…]]`, or an error (`-ERR …`, or any other line starting
// with `-`).
function ParseReplyLine(Line: string): TtpReply {
  const Raw = Line.trim();
  if (!Raw.startsWith('+OK')) {
    return { Ok: false, Error: Raw.replace(/^-(?:ERR\b)?\s*/, '') || 'Error', Raw };
  }
  const Rest = Raw.slice(3).trim();
  if (!Rest) return { Ok: true, Body: null, Raw };
  const Reader = new TtpReader(Rest);
  const Body = Rest.startsWith('"') ? Reader.Members('\u0000', 0) : Reader.Value(0);
  return { Ok: true, Body, Raw };
}

// The payload of a verbose reply: its "value" member, else the named member,
// else its only member. A non-object body (non-verbose mode) is returned whole.
function ReplyValue(Body: TtpValue, Key?: string): TtpValue {
  if (!Body || typeof Body !== 'object' || Array.isArray(Body)) return Body;
  if ('value' in Body) return Body.value ?? null;
  if (Key && Key in Body) return Body[Key] ?? null;
  const Keys = Object.keys(Body);
  return Keys.length === 1 ? (Body[Keys[0] as string] ?? null) : Body;
}

function AsObject(Value: TtpValue): { [Key: string]: TtpValue } | null {
  return Value && typeof Value === 'object' && !Array.isArray(Value) ? Value : null;
}

function AsString(Value: TtpValue | undefined): string | null {
  if (typeof Value === 'string') return Value;
  if (typeof Value === 'number' || typeof Value === 'boolean') return String(Value);
  return null;
}

// --- Device data -----------------------------------------------------------------

export interface DeviceInfo {
  Model: string | null;
  Revision: string | null;
  SerialNumber: string | null;
  Firmware: string | null;
  IpAddress: string | null;
}

function ParseDeviceInfo(Value: TtpValue): DeviceInfo | null {
  const Obj = AsObject(Value);
  if (!Obj) return null;
  return {
    Model: AsString(Obj.deviceModel),
    Revision: AsString(Obj.deviceRevision),
    SerialNumber: AsString(Obj.serialNumber),
    Firmware: AsString(Obj.firmwareVersion),
    IpAddress: AsString(Obj.ipAddress),
  };
}

export interface InterfaceStatus {
  Name: string;
  Ip: string | null;
  Mac: string | null;
  Link: string | null;
}

function ParseNetworkStatus(Value: TtpValue): {
  Hostname: string | null;
  Interfaces: InterfaceStatus[];
} | null {
  const Obj = AsObject(Value);
  if (!Obj) return null;
  const Interfaces: InterfaceStatus[] = [];
  const List = Array.isArray(Obj.networkInterfaceStatusWithName)
    ? Obj.networkInterfaceStatusWithName
    : [];
  for (const Entry of List) {
    const E = AsObject(Entry);
    if (!E) continue;
    const S = AsObject(E.networkInterfaceStatus ?? null) || {};
    Interfaces.push({
      Name: AsString(E.interfaceId) || '?',
      Ip: AsString(S.ip),
      Mac: AsString(S.macAddress),
      Link: AsString(S.linkStatus),
    });
  }
  return { Hostname: AsString(Obj.hostname), Interfaces };
}

export type FaultSeverity = 'major' | 'minor';

export interface Fault {
  Severity: FaultSeverity;
  Id: string | null;
  Name: string;
  // The device the fault belongs to (this server, or an expander it proxies).
  SerialNumber: string | null;
}

// Non-verbose indicator numbers, from Biamp's TTP fault responses page.
const INDICATOR_NUMBERS: Record<number, string> = {
  1: 'INDICATOR_MAJOR_IN_DEVICE',
  2: 'INDICATOR_MINOR_IN_DEVICE',
  3: 'INDICATOR_MAJOR_IN_SYSTEM',
  4: 'INDICATOR_MINOR_IN_SYSTEM',
  5: 'INDICATOR_NONE_IN_DEVICE',
};

function IndicatorSeverity(Indicator: string): FaultSeverity | null {
  if (/MAJOR/i.test(Indicator)) return 'major';
  if (/MINOR/i.test(Indicator)) return 'minor';
  return null;
}

/**
 * Flatten an activeFaultList value into its faults. Each entry is one device
 * (this one, then any expander it proxies) with an indicator and a fault list:
 * verbose `{"id":INDICATOR_… "name":… "faults":[{"id":… "name":…}] "serialNumber":…}`
 * or non-verbose `[2 "Minor Fault in Device" [[89 "…"]] "02196874"]`. An entry
 * whose indicator is a fault but whose list is empty still counts, under the
 * indicator's own name. Null when the value is not a list at all.
 */
function ParseFaultList(Value: TtpValue): Fault[] | null {
  if (!Array.isArray(Value)) return null;
  const Faults: Fault[] = [];
  for (const Entry of Value) {
    let Indicator = '';
    let Title = '';
    let Serial: string | null = null;
    let List: TtpValue[] = [];
    const Obj = AsObject(Entry);
    if (Obj) {
      Indicator = AsString(Obj.id) || '';
      Title = AsString(Obj.name) || '';
      Serial = AsString(Obj.serialNumber);
      List = Array.isArray(Obj.faults) ? Obj.faults : [];
    } else if (Array.isArray(Entry)) {
      const Num = typeof Entry[0] === 'number' ? Entry[0] : Number(Entry[0]);
      Indicator = INDICATOR_NUMBERS[Num] || AsString(Entry[0]) || '';
      Title = AsString(Entry[1]) || '';
      List = Array.isArray(Entry[2]) ? Entry[2] : [];
      Serial = AsString(Entry[3]);
    } else {
      continue;
    }
    const Severity = IndicatorSeverity(Indicator) || IndicatorSeverity(Title);
    if (!Severity) continue;
    let Added = 0;
    for (const Item of List) {
      const F = AsObject(Item);
      const Pair = Array.isArray(Item) ? Item : null;
      const Id = F ? AsString(F.id) : Pair ? AsString(Pair[0]) : null;
      const Name = (F ? AsString(F.name) : Pair ? AsString(Pair[1]) : AsString(Item)) || Id;
      if (!Name) continue;
      Faults.push({ Severity, Id, Name: Name.trim().replace(/\s+/g, ' '), SerialNumber: Serial });
      Added++;
    }
    if (!Added) {
      Faults.push({ Severity, Id: null, Name: Title || Indicator, SerialNumber: Serial });
    }
  }
  return Faults;
}

export interface PortStatus {
  Name: string;
  LinkUp: boolean | null;
  SpeedMbps: number | null;
}

function ParsePortInfo(Value: TtpValue): PortStatus[] | null {
  if (!Array.isArray(Value)) return null;
  const Ports: PortStatus[] = [];
  for (const Entry of Value) {
    const Obj = AsObject(Entry);
    if (!Obj) continue;
    const Name = AsString(Obj.name);
    if (!Name) continue;
    Ports.push({
      Name,
      LinkUp: typeof Obj.linkUp === 'boolean' ? Obj.linkUp : null,
      SpeedMbps: typeof Obj.speed === 'number' ? Obj.speed : null,
    });
  }
  return Ports;
}

export interface AttributeReading {
  Label: string;
  Found: boolean;
  Value?: TtpValue;
  // Why the attribute could not be read (the device's -ERR text).
  Error?: string;
}

// Expected values that mean a boolean state.
const TRUE_WORDS = new Set(['true', 'on', 'yes']);
const FALSE_WORDS = new Set(['false', 'off', 'no']);

function ExpectedBool(Want: string): boolean | null {
  const Lower = Want.toLowerCase();
  if (TRUE_WORDS.has(Lower)) return true;
  if (FALSE_WORDS.has(Lower)) return false;
  return null;
}

// Booleans compare by truth (1/0 and the words), numbers numerically (TTP
// prints levels as -10.000000), everything else as case-insensitive text.
function ValueMatches(Expected: string, Actual: TtpValue | undefined): boolean {
  if (Actual == null || typeof Actual === 'object') return false;
  const Want = Expected.trim();
  if (typeof Actual === 'boolean') {
    if (Want === '1') return Actual;
    if (Want === '0') return !Actual;
    const Bool = ExpectedBool(Want);
    return Bool != null && Bool === Actual;
  }
  const Got = String(Actual).trim();
  if (NUMBER_RE.test(Want) && NUMBER_RE.test(Got)) {
    const A = Number(Want);
    const B = Number(Got);
    return Math.abs(A - B) <= 1e-4 * Math.max(1, Math.abs(A), Math.abs(B));
  }
  return Want.toLowerCase() === Got.toLowerCase();
}

function DescribeValue(Value: TtpValue | undefined): string {
  if (Value === undefined || Value === null) return '—';
  if (Array.isArray(Value)) return `[${Value.map(DescribeValue).join(' ')}]`;
  if (typeof Value === 'object') return '{…}';
  return String(Value);
}

// --- One-connection probe ----------------------------------------------------------

export type LoginState = 'not-asked' | 'ok' | 'rejected';

export interface TesiraSnapshot {
  // The TTP banner arrived: this is a Tesira.
  IsTesira: boolean;
  LoginState: LoginState;
  Device: DeviceInfo | null;
  DeviceError: string | null;
  Hostname: string | null;
  Interfaces: InterfaceStatus[];
  NetworkError: string | null;
  Faults: Fault[] | null;
  FaultError: string | null;
  Ports: PortStatus[] | null;
  PortError: string | null;
  Attributes: AttributeReading[] | null;
  // A stage that did not finish inside the budget, as a human reason.
  Incomplete: string | null;
}

export type TesiraProbe =
  | { Reachable: false; Error: string; Refused: boolean }
  | { Reachable: true; LatencyMs: number; Snapshot: TesiraSnapshot };

class SessionEnded extends Error {}

// The trailing, unterminated line of the pre-banner text, as a login prompt.
function DetectLoginPrompt(Text: string): 'username' | 'password' | null {
  const Tail = (Text.split(/\r\n|\r|\n/).pop() || '').trim().toLowerCase();
  if (!Tail) return null;
  if (/(?:^|\s)(?:login|username|user name|user):$/.test(Tail)) return 'username';
  if (/(?:^|\s)password:$/.test(Tail)) return 'password';
  return null;
}

// How many leading characters of Buffered end with the first reply line
// (`+OK…` or `-…`) that answers Sent; anything before it (blank lines, a
// subscription push, the device's echo of Sent) is consumed with it. The echo
// is skipped by name so an instance tag that starts with "-" is not mistaken
// for an error. Null while no complete reply line has arrived.
function TakeReply(Buffered: string, Sent = ''): number | null {
  const Echo = Sent.trim();
  const Re = /\r\n|\r|\n/g;
  let Start = 0;
  let Match: RegExpExecArray | null;
  while ((Match = Re.exec(Buffered))) {
    const Line = Buffered.slice(Start, Match.index).trim();
    Start = Match.index + Match[0].length;
    if (Echo && Line === Echo) continue;
    if (Line.startsWith('+OK') || Line.startsWith('-')) return Start;
  }
  return null;
}

// The reply line out of what TakeReply consumed.
function LastReplyLine(Consumed: string, Sent = ''): string {
  const Echo = Sent.trim();
  const Lines = Consumed.split(/\r\n|\r|\n/).map((L) => L.trim());
  for (let I = Lines.length - 1; I >= 0; I--) {
    const Line = Lines[I] ?? '';
    if (Echo && Line === Echo) continue;
    if (Line.startsWith('+OK') || Line.startsWith('-')) return Line;
  }
  return '';
}

// One command on an open session, answered by one reply line.
type TtpCall = (Command: string) => Promise<TtpReply>;

// What to do once the banner has arrived. SetStage names the step under way,
// for the "did not finish … in time" reason if the budget runs out.
type TtpWork = (
  Call: TtpCall,
  Snapshot: TesiraSnapshot,
  SetStage: (Stage: string) => void
) => Promise<void>;

function EmptySnapshot(): TesiraSnapshot {
  return {
    IsTesira: false,
    LoginState: 'not-asked',
    Device: null,
    DeviceError: null,
    Hostname: null,
    Interfaces: [],
    NetworkError: null,
    Faults: null,
    FaultError: null,
    Ports: null,
    PortError: null,
    Attributes: null,
    Incomplete: null,
  };
}

// The probe's reads, in order. Every command is a `get`.
async function RunReads(
  Call: TtpCall,
  Snapshot: TesiraSnapshot,
  SetStage: (Stage: string) => void,
  Options: HealthOptions
): Promise<void> {
  SetStage('reading the device info');
  const Info = await Call('DEVICE get deviceInfo');
  Snapshot.Device = Info.Ok ? ParseDeviceInfo(ReplyValue(Info.Body)) : null;
  if (!Snapshot.Device || (!Snapshot.Device.SerialNumber && !Snapshot.Device.Firmware)) {
    // Older firmware: the two single-value reads documented since TTP began.
    const Serial = await Call('DEVICE get serialNumber');
    const Version = await Call('DEVICE get version');
    const Device = Snapshot.Device || {
      Model: null,
      Revision: null,
      SerialNumber: null,
      Firmware: null,
      IpAddress: null,
    };
    if (Serial.Ok) Device.SerialNumber = AsString(ReplyValue(Serial.Body));
    if (Version.Ok) Device.Firmware = AsString(ReplyValue(Version.Body));
    Snapshot.Device = Device;
    if (!Serial.Ok && !Version.Ok) Snapshot.DeviceError = Serial.Error;
  }

  SetStage('reading the network status');
  const Net = await Call('DEVICE get networkStatus');
  if (Net.Ok) {
    const Parsed = ParseNetworkStatus(ReplyValue(Net.Body));
    if (Parsed) {
      Snapshot.Hostname = Parsed.Hostname;
      Snapshot.Interfaces = Parsed.Interfaces;
    }
  } else {
    Snapshot.NetworkError = Net.Error;
  }

  SetStage('reading the fault list');
  const FaultReply = await Call('DEVICE get activeFaultList');
  if (FaultReply.Ok) {
    Snapshot.Faults = ParseFaultList(ReplyValue(FaultReply.Body));
    if (!Snapshot.Faults) Snapshot.FaultError = 'Unrecognised fault list';
  } else {
    Snapshot.FaultError = FaultReply.Error;
  }

  if (Options.CheckPorts && Options.RequiredPorts.length) {
    SetStage('reading the network ports');
    const Ports = await Call('DEVICE get networkPortInfo');
    if (Ports.Ok) {
      Snapshot.Ports = ParsePortInfo(ReplyValue(Ports.Body, 'networkPortInfo'));
      if (!Snapshot.Ports) Snapshot.PortError = 'Unrecognised port list';
    } else {
      Snapshot.PortError = Ports.Error;
    }
  }

  if (Options.CheckAttributes && Options.Assertions.length) {
    SetStage('reading the block attributes');
    const Readings: AttributeReading[] = [];
    for (const Assertion of Options.Assertions) {
      const Reply = await Call(AttributeCommand(Assertion));
      Readings.push(
        Reply.Ok
          ? { Label: Assertion.Label, Found: true, Value: ReplyValue(Reply.Body) }
          : { Label: Assertion.Label, Found: false, Error: Reply.Error }
      );
    }
    Snapshot.Attributes = Readings;
  }
}

/**
 * One short TTP session: Telnet negotiation, login if asked, the banner, then
 * Work. Shared by the probe (RunReads) and the actions (one command each), so
 * both obey the same credentials, port and whole-session budget.
 */
function OpenTtpSession(Config: TesiraConfig, Work: TtpWork): Promise<TesiraProbe> {
  const BudgetMs = Math.max(500, Config.TimeoutMs | 0);
  const Snapshot = EmptySnapshot();
  const Negotiator = new TelnetNegotiator();
  const Decoder = new StringDecoder('utf8');
  const Queue = new ReplyQueue(MAX_BUFFERED_CHARS);
  let PreBanner = '';
  let BytesSeen = 0;
  let Stage = 'the Telnet login';
  let Prompts = { username: 0, password: 0 };

  const Reached = (Session: TcpSession<TesiraProbe>): TesiraProbe => ({
    Reachable: true,
    LatencyMs: Date.now() - Session.StartedAt,
    Snapshot,
  });

  // Ending early (timeout / close): reachable if the device said anything at all.
  const Unfinished = (Session: TcpSession<TesiraProbe>, NoReplyError: string): TesiraProbe => {
    if (!BytesSeen) return { Reachable: false, Error: NoReplyError, Refused: false };
    if (Snapshot.IsTesira) Snapshot.Incomplete = `The device did not finish ${Stage} in time`;
    else if (Prompts.username || Prompts.password) {
      Snapshot.Incomplete = 'The device did not finish the login in time';
    }
    return Reached(Session);
  };

  const OnText = (Text: string, Session: TcpSession<TesiraProbe>): void => {
    if (Snapshot.IsTesira) {
      if (!Queue.Feed(Text)) Session.Finish(Reached(Session));
      return;
    }
    PreBanner += Text;
    if (PreBanner.length > MAX_BUFFERED_CHARS) {
      Session.Finish(Reached(Session));
      return;
    }
    const At = PreBanner.indexOf(BANNER);
    if (At >= 0) {
      Snapshot.IsTesira = true;
      if (Prompts.username || Prompts.password) Snapshot.LoginState = 'ok';
      // Whatever followed the banner line belongs to the command phase.
      const AfterBanner = PreBanner.slice(At + BANNER.length).replace(/^[^\r\n]*/, '');
      PreBanner = '';
      Queue.Feed(AfterBanner);
      const Call: TtpCall = async (Command) => {
        Session.Socket.write(`${Command}\n`);
        const Consumed = await Queue.Next((Buffered) => TakeReply(Buffered, Command));
        return ParseReplyLine(LastReplyLine(Consumed, Command));
      };
      void Work(Call, Snapshot, (Next) => {
        Stage = Next;
      })
        .then(() => Session.Finish(Reached(Session)))
        .catch((Err) => {
          if (Err instanceof SessionEnded) return; // already settled by timeout/close
          Session.Finish({
            Reachable: false,
            Error: Err instanceof Error ? Err.message : String(Err),
            Refused: false,
          });
        });
      return;
    }
    const Prompt = DetectLoginPrompt(PreBanner);
    if (!Prompt) return;
    Prompts = { ...Prompts, [Prompt]: Prompts[Prompt] + 1 };
    if (Prompts[Prompt] > 1) {
      // Asked again: the device refused what was sent.
      Snapshot.LoginState = 'rejected';
      Session.Finish(Reached(Session));
      return;
    }
    PreBanner = '';
    Session.Socket.write(`${Prompt === 'username' ? Config.Username : Config.Password}\n`);
  };

  return RunTcpSession<TesiraProbe>({
    Address: Config.Address,
    Port: Config.Port,
    IdleMs: BudgetMs,
    DeadlineMs: BudgetMs,
    NoDelay: true,
    OnSettle: () => Queue.FailPending(new SessionEnded('session ended')),
    OnData: (Chunk, Session) => {
      BytesSeen += Chunk.length;
      const { Data, Reply } = Negotiator.Feed(Chunk);
      if (Reply) Session.Socket.write(Reply);
      // Telnet ends lines with CR LF or CR NUL; NUL is never data in TTP.
      const Text = Decoder.write(Data).replace(/\0/g, '');
      if (Text) OnText(Text, Session);
    },
    OnTimeout: (Session) => Unfinished(Session, `No reply from the Tesira after ${BudgetMs}ms`),
    OnError: (Message) => ({
      Reachable: false,
      Error: Message,
      Refused: Message.includes('ECONNREFUSED') || Message.includes('ECONNRESET'),
    }),
    OnClose: (Session) => Unfinished(Session, 'Connection closed before any reply'),
  });
}

function QueryTesira(Config: TesiraConfig, Options: HealthOptions): Promise<TesiraProbe> {
  return OpenTtpSession(Config, (Call, Snapshot, SetStage) =>
    RunReads(Call, Snapshot, SetStage, Options)
  );
}

// --- Evaluation --------------------------------------------------------------------

function DescribeFault(Fault: Fault): string {
  return Fault.SerialNumber ? `${Fault.Name} (${Fault.SerialNumber})` : Fault.Name;
}

// The faults that count under the chosen severity, deduplicated by text (a
// server can report an expander's fault both on its own entry and rolled up).
function CountedFaults(Faults: Fault[] | null, MajorOnly: boolean): Fault[] {
  const Seen = new Set<string>();
  const Out: Fault[] = [];
  for (const F of Faults || []) {
    if (MajorOnly && F.Severity !== 'major') continue;
    const Key = `${F.Severity}|${DescribeFault(F)}`;
    if (Seen.has(Key)) continue;
    Seen.add(Key);
    Out.push(F);
  }
  return Out;
}

// The reasons a reachable device is unhealthy, per the enabled options. Pure —
// exported via _internal for unit tests.
function EvaluateHealth(Snapshot: TesiraSnapshot, Options: HealthOptions): string[] {
  if (Snapshot.LoginState === 'rejected') {
    return ['Login rejected (check the username and password)'];
  }
  if (!Snapshot.IsTesira) {
    return [Snapshot.Incomplete || 'Responded, but not as a Tesira Text Protocol server'];
  }

  const Reasons: string[] = [];
  if (Snapshot.Incomplete) Reasons.push(Snapshot.Incomplete);

  if (Options.CheckFaults) {
    if (Snapshot.FaultError) {
      Reasons.push(`Fault list unavailable: ${Snapshot.FaultError}`);
    } else if (Snapshot.Faults) {
      const Counted = CountedFaults(Snapshot.Faults, Options.MajorOnly);
      if (Counted.length) {
        const Major = Counted.filter((F) => F.Severity === 'major').length;
        const Head =
          Counted.length === 1
            ? `${Major ? 'Major' : 'Minor'} fault`
            : `${Counted.length} active faults`;
        const Shown = Counted.slice(0, 3).map(DescribeFault).join('; ');
        const More = Counted.length > 3 ? `; +${Counted.length - 3} more` : '';
        Reasons.push(`${Head}: ${Shown}${More}`);
      }
    }
  }

  if (Options.CheckPorts && Options.RequiredPorts.length) {
    if (Snapshot.PortError) {
      Reasons.push(`Port status unavailable: ${Snapshot.PortError}`);
    } else if (Snapshot.Ports) {
      for (const Wanted of Options.RequiredPorts) {
        const Port = Snapshot.Ports.find((P) => P.Name.toLowerCase() === Wanted.toLowerCase());
        if (!Port) Reasons.push(`Port ${Wanted} not found`);
        else if (Port.LinkUp !== true) Reasons.push(`Port ${Port.Name} has no link`);
      }
    }
  }

  if (Options.CheckAttributes) {
    for (const Entry of Options.InvalidAssertions) {
      Reasons.push(
        `Invalid attribute assertion "${Entry}" (use InstanceTag attribute index=value)`
      );
    }
    for (const Reading of Snapshot.Attributes || []) {
      const Assertion = Options.Assertions.find((A) => A.Label === Reading.Label);
      if (!Assertion) continue;
      if (!Reading.Found) {
        Reasons.push(
          `Attribute "${Reading.Label}" not read${Reading.Error ? ` (${Reading.Error})` : ''}`
        );
      } else if (!ValueMatches(Assertion.Expected, Reading.Value)) {
        Reasons.push(
          `Attribute "${Reading.Label}" is ${DescribeValue(Reading.Value)} (expected ${Assertion.Expected})`
        );
      }
    }
  }
  return Reasons;
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Success: false, Error: `Invalid port: ${Config.Port}` };
  }
  const CredentialError = CheckCredentials(Config);
  if (CredentialError) return { Success: false, Error: CredentialError };
  const Options = ParseHealthOptions(Target);

  const Probe = await QueryTesira(Config, Options);
  if (!Probe.Reachable) {
    return { Success: false, ...(Probe.Refused ? { Degraded: true } : {}), Error: Probe.Error };
  }

  const { Snapshot } = Probe;
  const Reasons = EvaluateHealth(Snapshot, Options);
  const Device = Snapshot.Device;
  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs: Probe.LatencyMs,
    IsTesira: Snapshot.IsTesira,
    LoginState: Snapshot.LoginState,
    Model: Device ? Device.Model : null,
    Revision: Device ? Device.Revision : null,
    SerialNumber: Device ? Device.SerialNumber : null,
    Firmware: Device ? Device.Firmware : null,
    DeviceError: Snapshot.DeviceError,
    Hostname: Snapshot.Hostname,
    Interfaces: Snapshot.Interfaces,
    NetworkError: Snapshot.NetworkError,
    Faults: Snapshot.Faults,
    FaultError: Snapshot.FaultError,
    Ports: Snapshot.Ports,
    PortError: Snapshot.PortError,
    Attributes: Snapshot.Attributes,
  };
}

// --- Controllable actions --------------------------------------------------------------
//
// Each press opens its own short session (same port, credentials and budget as
// the check), sends ONE documented command and closes:
//   DEVICE recallPreset <id>             Device Services table, "Recall a Preset"
//   DEVICE recallPresetByName <name>     Device Services table, "Recall a preset by preset name"
//   <InstanceTag> set mute <index> true|false   TTP Overview's own example
//                                               ("Level3 set mute 3 true")
// Tesira answers a set or a service with "+OK" and a refusal with "-ERR …".
//
// A preset name with spaces is sent in double quotes, as the TTP Overview says a
// value with spaces may be. An instance tag with spaces is quoted the same way,
// which is the check's own rule for attribute assertions; Biamp does not spell
// that out for the instance tag (inferred). Anything that could put a second
// command on the line (a line break, any control character, a double quote, or
// whitespace other than a plain space) is refused before connecting.

const TAG_PARAM: MonitoringSettingField = {
  Key: 'InstanceTag',
  Label: 'Instance tag',
  Type: 'string',
  Default: '',
  Required: true,
  Note: 'The mute or level block’s instance tag exactly as in the Tesira file, e.g. Level1. Instance tags are case sensitive.',
};

const CHANNEL_PARAM: MonitoringSettingField = {
  Key: 'Channel',
  Label: 'Channel',
  Type: 'string',
  Default: '1',
  Required: true,
  Note: 'The channel in the block, starting at 1. A ganged block uses 0.',
};

const Actions: MonitoringActionDef[] = [
  {
    ID: 'preset.recall',
    Label: 'Recall Preset',
    Icon: 'collection-play',
    Group: 'Presets',
    Destructive: true,
    Params: [
      {
        Key: 'Preset',
        Label: 'Preset',
        Type: 'string',
        Default: '',
        Required: true,
        Note: 'The preset ID, such as 1001, or the preset name exactly as in the Tesira file. An entry made only of digits is sent as an ID.',
      },
    ],
    Note: 'Recalls a preset saved in the running Tesira file. What changes depends on what the preset holds.',
  },
  {
    ID: 'mute.on',
    Label: 'Mute',
    Icon: 'volume-mute',
    Group: 'Mute',
    Destructive: true,
    Params: [TAG_PARAM, CHANNEL_PARAM],
    Note: 'Mutes one channel of a level or mute block.',
  },
  {
    ID: 'mute.off',
    Label: 'Unmute',
    Icon: 'volume-up',
    Group: 'Mute',
    Params: [TAG_PARAM, CHANNEL_PARAM],
    Note: 'Unmutes one channel of a level or mute block.',
  },
];

// Text that is safe to place on a TTP command line: no control characters, no
// double quote, and no whitespace other than a plain space.
function UnsafeWord(Text: string): boolean {
  return HasControlChar(Text) || Text.includes('"') || /[^\S ]/.test(Text);
}

function QuoteWord(Word: string): string {
  return /\s/.test(Word) ? `"${Word}"` : Word;
}

interface BuiltCommand {
  Command: string;
  // Confirmation on +OK.
  Detail: string;
  // The operator's request in words, to prefix a refusal.
  What: string;
  InstanceTag: string | null;
}

// Validate an action's parameters and build its one command line. Pure —
// exported via _internal for unit tests.
function BuildActionCommand(
  ActionID: string,
  Params: Record<string, unknown>
): { Ok: true; Built: BuiltCommand } | { Ok: false; Error: string } {
  const Text = (Value: unknown) => String(Value == null ? '' : Value).trim();
  if (ActionID === 'preset.recall') {
    const Preset = Text(Params.Preset);
    if (!Preset) return { Ok: false, Error: 'Enter a preset ID or a preset name.' };
    if (UnsafeWord(Preset)) {
      return {
        Ok: false,
        Error: 'A preset name cannot contain double quotes, line breaks or tabs.',
      };
    }
    if (/^\d+$/.test(Preset)) {
      const Id = Number(Preset);
      if (!Number.isSafeInteger(Id) || Id > 2_147_483_647) {
        return { Ok: false, Error: `Preset ID ${Preset} is out of range.` };
      }
      return {
        Ok: true,
        Built: {
          Command: `DEVICE recallPreset ${Id}`,
          Detail: `Preset ${Id} recalled`,
          What: `recall preset ${Id}`,
          InstanceTag: null,
        },
      };
    }
    return {
      Ok: true,
      Built: {
        Command: `DEVICE recallPresetByName ${QuoteWord(Preset)}`,
        Detail: `Preset "${Preset}" recalled`,
        What: `recall preset "${Preset}"`,
        InstanceTag: null,
      },
    };
  }
  if (ActionID === 'mute.on' || ActionID === 'mute.off') {
    const Tag = Text(Params.InstanceTag);
    if (!Tag) return { Ok: false, Error: 'Enter the block’s instance tag.' };
    if (UnsafeWord(Tag)) {
      return {
        Ok: false,
        Error: 'An instance tag cannot contain double quotes, line breaks or tabs.',
      };
    }
    const Channel = Text(Params.Channel);
    if (!/^\d{1,4}$/.test(Channel)) {
      return {
        Ok: false,
        Error: 'Channel must be a whole number: 1 or more, or 0 for a ganged block.',
      };
    }
    const Index = Number(Channel);
    const On = ActionID === 'mute.on';
    return {
      Ok: true,
      Built: {
        Command: `${QuoteWord(Tag)} set mute ${Index} ${On ? 'true' : 'false'}`,
        Detail: `${Tag} channel ${Index} ${On ? 'muted' : 'unmuted'}`,
        What: `${On ? 'mute' : 'unmute'} ${Tag} channel ${Index}`,
        InstanceTag: Tag,
      },
    };
  }
  return { Ok: false, Error: `Unknown Tesira action "${ActionID}"` };
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
  const CredentialError = CheckCredentials(Config);
  if (CredentialError) return { Success: false, Error: CredentialError };

  const Built = BuildActionCommand(ActionID, Params || {});
  if (!Built.Ok) return { Success: false, Error: Built.Error };
  const { Command, Detail, What, InstanceTag } = Built.Built;

  let Reply: TtpReply | null = null;
  const Probe = await OpenTtpSession(Config, async (Call, _Snapshot, SetStage) => {
    SetStage('answering the command');
    Reply = await Call(Command);
  });
  if (!Probe.Reachable) return { Success: false, Error: Probe.Error };
  const { Snapshot } = Probe;
  if (Snapshot.LoginState === 'rejected') {
    return { Success: false, Error: 'Login rejected (check the username and password)' };
  }
  if (!Snapshot.IsTesira) {
    return {
      Success: false,
      Error: Snapshot.Incomplete || 'The device answered, but not as a Tesira Text Protocol server',
    };
  }
  const Answer = Reply as TtpReply | null;
  if (!Answer) {
    // Sent, but the budget ran out before the reply: it may have landed.
    return {
      Success: false,
      Error: `The Tesira did not answer in time. The command to ${What} may or may not have been applied.`,
    };
  }
  if (Answer.Ok) return { Success: true, Detail };
  if (InstanceTag && /address not found/i.test(Answer.Error)) {
    return {
      Success: false,
      Error: `The Tesira has no block with instance tag "${InstanceTag}". Instance tags are case sensitive.`,
    };
  }
  return { Success: false, Error: `The Tesira refused to ${What}: ${Answer.Error}` };
}

// Bind the parameters into a favourite's label so a starred Mute says which
// block and channel it mutes.
function DescribeAction(ActionID: string, Params: Record<string, unknown>): string | null {
  const Text = (Value: unknown) => String(Value == null ? '' : Value).trim();
  if (ActionID === 'preset.recall') {
    const Preset = Text(Params.Preset);
    return Preset ? `Recall Preset — ${Preset}` : null;
  }
  if (ActionID === 'mute.on' || ActionID === 'mute.off') {
    const Tag = Text(Params.InstanceTag);
    if (!Tag) return null;
    const Channel = Text(Params.Channel) || '1';
    return `${ActionID === 'mute.on' ? 'Mute' : 'Unmute'} — ${Tag} channel ${Channel}`;
  }
  return null;
}

// --- Debug panel ---------------------------------------------------------------------

const LOGIN_LABELS: Record<LoginState, string> = {
  'not-asked': 'Not asked',
  ok: 'Logged in',
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
    TextRow('Host', `${Config.Address || '—'}:${Config.Port}`),
    Row('Status', StatePill),
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Failed to reach the Tesira'),
  ];
  if (!Reachable) {
    return (
      Rows(Head) +
      '<div class="mt-2">' +
      Note(
        `Failed to reach the Tesira Text Protocol server on TCP ${Config.Port}. Check that Telnet is enabled on the device.`
      ) +
      '</div>'
    );
  }
  if (Result.IsTesira === false) {
    return (
      Rows(Head) +
      '<div class="mt-2">' +
      Note(
        Result.LoginState === 'rejected'
          ? 'The device refused the username and password'
          : 'The device answered, but not as a Tesira Text Protocol server'
      ) +
      '</div>'
    );
  }

  const Interfaces = Array.isArray(Result.Interfaces)
    ? (Result.Interfaces as InterfaceStatus[])
    : [];
  const Body = [
    ...Head,
    Result.Model ? TextRow('Model', String(Result.Model)) : null,
    Result.SerialNumber ? TextRow('Serial number', String(Result.SerialNumber)) : null,
    Result.Firmware ? TextRow('Firmware', String(Result.Firmware)) : null,
    Result.Hostname ? TextRow('Hostname', String(Result.Hostname)) : null,
    ...Interfaces.map((I) =>
      TextRow(
        `Interface ${I.Name}`,
        [I.Ip, I.Link, I.Mac].filter((Part) => Part != null && Part !== '').join(' · ') || '—'
      )
    ),
    Result.LoginState && Result.LoginState !== 'not-asked'
      ? TextRow('Login', LOGIN_LABELS[Result.LoginState as LoginState] || String(Result.LoginState))
      : null,
    Result.DeviceError ? TextRow('Device info', String(Result.DeviceError)) : null,
    Result.NetworkError ? TextRow('Network status', String(Result.NetworkError)) : null,
  ];

  // Faults are always shown, whether or not they count towards the status.
  let FaultsHtml = '';
  const Faults = Array.isArray(Result.Faults) ? (Result.Faults as Fault[]) : null;
  if (Result.FaultError) {
    FaultsHtml = Note(`Fault list not read: ${String(Result.FaultError)}`);
  } else if (Faults && !Faults.length) {
    FaultsHtml = Rows([Row('Active faults', Pill('success', 'None'))]);
  } else if (Faults) {
    // A minor fault that does not count (major-only mode) is shown muted.
    FaultsHtml =
      `<div class="text-muted small mt-2 mb-1">Active faults (${Faults.length})</div>` +
      Faults.map((F) =>
        Card({
          Title: F.Name,
          Badge: Pill(
            F.Severity === 'major' ? 'danger' : Options.MajorOnly ? 'muted' : 'warning',
            F.Severity === 'major' ? 'Major' : 'Minor'
          ),
          BodyHtml:
            F.Id || F.SerialNumber
              ? `<div class="text-muted small text-break">${Esc(
                  [F.Id, F.SerialNumber ? `Serial ${F.SerialNumber}` : null]
                    .filter(Boolean)
                    .join(' · ')
                )}</div>`
              : '',
        })
      ).join('');
  }
  if (FaultsHtml) FaultsHtml = `<div class="mt-2 d-grid gap-1">${FaultsHtml}</div>`;

  let PortsHtml = '';
  if (Options.CheckPorts && Options.RequiredPorts.length) {
    const Ports = Array.isArray(Result.Ports) ? (Result.Ports as PortStatus[]) : null;
    if (!Ports) {
      PortsHtml = Note(
        Result.PortError ? `Ports not read: ${String(Result.PortError)}` : 'Ports not read'
      );
    } else {
      PortsHtml = Options.RequiredPorts.map((Wanted) => {
        const Port = Ports.find((P) => P.Name.toLowerCase() === Wanted.toLowerCase());
        const Up = !!Port && Port.LinkUp === true;
        return Card({
          Title: Port ? Port.Name : Wanted,
          TitleClass: 'font-monospace',
          Badge: !Port
            ? Pill('danger', 'Not found')
            : Up
              ? Pill('success', Port.SpeedMbps ? `Link ${Port.SpeedMbps} Mb/s` : 'Link')
              : Pill('warning', 'No link'),
          Highlight: Up,
        });
      }).join('');
    }
    PortsHtml = `<div class="mt-2 d-grid gap-1">${PortsHtml}</div>`;
  }

  let AttributesHtml = '';
  if (Options.CheckAttributes && Options.Assertions.length) {
    const Readings = Array.isArray(Result.Attributes)
      ? (Result.Attributes as AttributeReading[])
      : null;
    if (!Readings) {
      AttributesHtml = Note('Attributes not read');
    } else {
      AttributesHtml = Readings.map((Reading) => {
        const Assertion = Options.Assertions.find((A) => A.Label === Reading.Label);
        const Ok = !!Assertion && Reading.Found && ValueMatches(Assertion.Expected, Reading.Value);
        const Badge = !Reading.Found
          ? Pill('danger', 'Not read')
          : Pill(Ok ? 'success' : 'warning', DescribeValue(Reading.Value));
        const Detail = Reading.Found
          ? `Expected ${Assertion ? Assertion.Expected : '—'}`
          : Reading.Error || 'Not read';
        return Card({
          Title: Reading.Label,
          TitleClass: 'font-monospace',
          Badge,
          Highlight: Ok,
          BodyHtml: `<div class="text-muted small text-break">${Esc(Detail)}</div>`,
        });
      }).join('');
    }
    AttributesHtml = `<div class="mt-2 d-grid gap-1">${AttributesHtml}</div>`;
  }

  return Rows(Body) + FaultsHtml + PortsHtml + AttributesHtml;
}

export const Name = 'Biamp Tesira';
export const Description =
  'Connects to a Biamp Tesira server, TesiraFORTÉ or TesiraLUX over the Tesira Text Protocol on Telnet (TCP 23) and reads its model, serial number, firmware, hostname, network status and active fault list — read-only. Reports Degraded while the device has an active fault, and optionally when a listed network port has no link or a listed block attribute is not as expected.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseConfig,
  ParseHealthOptions,
  ParseAttributeAssertions,
  AttributeCommand,
  ParseTtpValue,
  ParseReplyLine,
  ReplyValue,
  ParseDeviceInfo,
  ParseNetworkStatus,
  ParseFaultList,
  ParsePortInfo,
  ValueMatches,
  DetectLoginPrompt,
  TakeReply,
  CountedFaults,
  EvaluateHealth,
  QueryTesira,
  BuildActionCommand,
};
export { ID, Settings, Actions, Run, RunAction, DescribeAction, Debug };
