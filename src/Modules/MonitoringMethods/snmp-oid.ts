// Generic SNMP GET (v1 / v2c / v3). Reads one or more operator-supplied OIDs
// and, optionally, asserts each against an expected value. For any device that
// speaks SNMP but has no dedicated ShowTrak method: switches, PDUs, media
// converters, amplifiers with an SNMP card, and so on.
//
// Each OID is one entry of a 'list' setting, written as
//   <oid> [<op> <value>]      e.g.  1.3.6.1.2.1.1.5.0 = Stage Left
// where <op> is =, !=, >, <, contains or present. A bare OID means "present".
// The list field was chosen over parallel per-OID fields (as snmp-projector's
// fixed Custom1/Custom2 slots do) because the settings schema has no repeating
// group: a list is the only field that holds any number of OIDs, and keeping
// each OID's assertion on the same entry means the two can never fall out of
// step. Q-SYS's Named Control assertions use the same one-entry-per-rule idiom.
//
// The same OID may appear on several entries, so a range is two entries
// (> 10 and < 50); it is fetched once.
//
// Offline = no SNMP response at all (timeout, unreachable, wrong community or
// v3 credentials — an agent silently drops a request it will not authenticate).
// Degraded = the agent answered but an OID is missing (noSuchObject,
// noSuchInstance, endOfMibView, or a v1 noSuchName) or an assertion failed.
import snmp from 'net-snmp';
import { Card, Esc, Pill, Rows, Row, TextRow, Note, FormatLatency } from './debug';
import { DEFAULT_PORT, type SnmpSession } from './_snmp-ups-shared';
import {
  V3CredentialFields,
  ParseV3Credentials,
  ValidateV3Credentials,
  BuildUser,
  V3IdentityLabel,
  type V3Credentials,
} from './_snmp-shared';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'snmp-oid';

const DEFAULT_TIMEOUT_MS = 4000;
const MAX_ENTRIES = 64;
// sysUpTime.0 (RFC 1213 MIB-II) — every SNMP agent implements it, so a new
// check is useful before the operator has typed anything.
const DEFAULT_OID = '1.3.6.1.2.1.1.3.0';

// SNMP value types by their BER tag (RFC 2578 / RFC 3416). Kept local rather
// than read from snmp.ObjectType so the decoding does not depend on how
// net-snmp spells its enum.
const TYPE_NAMES: Record<number, string> = {
  1: 'Boolean',
  2: 'Integer',
  3: 'BitString',
  4: 'OctetString',
  5: 'Null',
  6: 'OID',
  64: 'IpAddress',
  65: 'Counter32',
  66: 'Gauge32',
  67: 'TimeTicks',
  68: 'Opaque',
  70: 'Counter64',
};
const NUMERIC_TYPES = new Set([2, 65, 66, 67, 70]);
const EXCEPTION_NAMES: Record<number, string> = {
  128: 'noSuchObject',
  129: 'noSuchInstance',
  130: 'endOfMibView',
};
// PDU error-status names (RFC 3416). A v1 agent reports a missing OID as
// noSuchName for the whole request rather than as a per-varbind exception.
const ERROR_STATUS_NAMES: Record<number, string> = {
  1: 'tooBig',
  2: 'noSuchName',
  3: 'badValue',
  4: 'readOnly',
  5: 'genErr',
  6: 'noAccess',
  16: 'authorizationError',
};

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'Port',
    Type: 'number',
    Default: DEFAULT_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
  },
  {
    Key: 'Version',
    Label: 'SNMP version',
    Type: 'select',
    Default: '2c',
    Options: [
      { value: '2c', label: 'v2c' },
      { value: '1', label: 'v1' },
      { value: '3', label: 'v3' },
    ],
  },
  {
    Key: 'Community',
    Sensitive: true,
    Label: 'Community string',
    Type: 'string',
    Default: 'public',
    Required: true,
    VisibleWhen: { Key: 'Version', In: ['1', '2c'] },
  },
  ...V3CredentialFields({ Key: 'Version', Equals: '3' }),
  {
    Key: 'Oids',
    Label: 'OIDs',
    Type: 'list',
    ItemType: 'string',
    Default: [DEFAULT_OID],
    Required: true,
    Note: 'One OID per entry, optionally followed by a comparison, e.g. 1.3.6.1.2.1.1.5.0 = Stage Left or 1.3.6.1.2.1.2.2.1.8.1 != 2. The comparisons are =, !=, >, <, contains and present. A bare OID only has to exist. Text is compared without regard to case.',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: DEFAULT_TIMEOUT_MS,
    Min: 500,
    Max: 30000,
    Advanced: true,
    Note: 'Budget for the whole check, retries included.',
  },
  {
    Key: 'Retries',
    Label: 'Retries',
    Type: 'number',
    Default: 1,
    Min: 0,
    Max: 5,
    Advanced: true,
  },
];

// --- Entries -----------------------------------------------------------------

export type AssertOp = 'equals' | 'not-equals' | 'greater' | 'less' | 'contains' | 'present';

export interface OidEntry {
  // The entry as the operator wrote it, for messages.
  Source: string;
  Oid: string;
  Op: AssertOp;
  Expected: string;
}

const OP_SYMBOLS: Record<AssertOp, string> = {
  equals: '=',
  'not-equals': '!=',
  greater: '>',
  less: '<',
  contains: 'contains',
  present: 'present',
};

// Symbol operators, longest first so '!=' is not read as '!' + '='.
const SYMBOL_OPS: Array<[string, AssertOp]> = [
  ['==', 'equals'],
  ['!=', 'not-equals'],
  ['<>', 'not-equals'],
  ['=', 'equals'],
  ['>', 'greater'],
  ['<', 'less'],
];

// Validate an OID: dotted numeric only, a single leading dot is stripped, at
// least two arcs, each within an unsigned 32-bit sub-identifier. Returns the
// normalised OID or null.
export function NormaliseOid(Raw: string): string | null {
  const Oid = String(Raw || '')
    .trim()
    .replace(/^\./, '');
  if (!/^\d+(\.\d+)+$/.test(Oid)) return null;
  if (Oid.split('.').some((Arc) => Number(Arc) > 4294967295)) return null;
  return Oid;
}

// Strip one pair of surrounding double quotes, so leading/trailing spaces or an
// empty string can be asserted ("" or " A ").
function Unquote(Value: string): string {
  return Value.length >= 2 && Value.startsWith('"') && Value.endsWith('"')
    ? Value.slice(1, -1)
    : Value;
}

// Parse one entry. Throws an Error whose message is shown to the operator.
export function ParseEntry(Raw: string): OidEntry {
  const Source = String(Raw == null ? '' : Raw).trim();
  const Match = /^\.?\d+(?:\.\d+)*/.exec(Source);
  const Oid = Match ? NormaliseOid(Match[0]) : null;
  if (!Match || !Oid) {
    throw new Error(`"${Source}" does not start with a numeric OID such as 1.3.6.1.2.1.1.5.0`);
  }
  const Rest = Source.slice(Match[0].length).trim();
  if (!Rest) return { Source, Oid, Op: 'present', Expected: '' };

  // A symbol may directly follow the OID; a word must be separated from it.
  if (Match[0].length < Source.length && !/^[\s=!<>]/.test(Source.slice(Match[0].length))) {
    throw new Error(`"${Source}" has an invalid OID`);
  }

  let Op: AssertOp | null = null;
  let Value = '';
  for (const [Symbol, Name] of SYMBOL_OPS) {
    if (Rest.startsWith(Symbol)) {
      Op = Name;
      Value = Rest.slice(Symbol.length).trim();
      break;
    }
  }
  if (!Op) {
    const Word = /^(\S+)(?:\s+([\s\S]*))?$/.exec(Rest);
    const Name = Word && Word[1] ? Word[1].toLowerCase() : '';
    if (Name === 'contains' || Name === 'present') {
      Op = Name;
      Value = Word && Word[2] ? Word[2].trim() : '';
    }
  }
  if (!Op) {
    throw new Error(`"${Source}" has an unknown comparison. Use =, !=, >, <, contains or present.`);
  }
  if (Op === 'present') {
    if (Value) throw new Error(`"${Source}": present takes no value`);
    return { Source, Oid, Op, Expected: '' };
  }
  if ((Op === 'greater' || Op === 'less') && (!Value || !Number.isFinite(Number(Value)))) {
    throw new Error(`"${Source}": ${OP_SYMBOLS[Op]} needs a number`);
  }
  if (!Value) {
    throw new Error(`"${Source}": ${OP_SYMBOLS[Op]} needs a value (write "" for an empty one)`);
  }
  Value = Unquote(Value);
  if (Op === 'contains' && !Value) {
    throw new Error(`"${Source}": contains needs a value`);
  }
  return { Source, Oid, Op, Expected: Value };
}

// --- Config ------------------------------------------------------------------

interface SnmpOidConfig extends V3Credentials {
  Address: string;
  Port: number;
  Version: '1' | '2c' | '3';
  Community: string;
  RawEntries: string[];
  TimeoutMs: number;
  Retries: number;
}

function ParseConfig(Target: MonitoringTargetLike): SnmpOidConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Num = (Value: unknown, Fallback: number): number => {
    const N = Number(Value);
    return Number.isFinite(N) ? N : Fallback;
  };
  const Version = String(Cfg.Version);
  const RawList = Array.isArray(Cfg.Oids)
    ? Cfg.Oids
    : Cfg.Oids == null || Cfg.Oids === ''
      ? []
      : [Cfg.Oids];
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Port: Num(Cfg.Port, DEFAULT_PORT) | 0,
    Version: Version === '1' || Version === '3' ? Version : '2c',
    Community: Cfg.Community == null || Cfg.Community === '' ? 'public' : String(Cfg.Community),
    ...ParseV3Credentials(Cfg),
    RawEntries: RawList.map((E) => String(E == null ? '' : E).trim()).filter(Boolean),
    TimeoutMs: Math.max(500, Num(Cfg.Timeout, DEFAULT_TIMEOUT_MS)),
    Retries: Math.max(0, Math.min(5, Num(Cfg.Retries, 1) | 0)),
  };
}

// --- Decoding ----------------------------------------------------------------

// One OID's reading as it is put on the result: plain JSON (no Buffers or
// bigints) so it survives persistence and IPC.
export interface OidReading {
  Oid: string;
  // SNMP type name (Integer, OctetString, ...), or null for an exception.
  Type: string | null;
  // Display value: decimal for numbers, text or hex for an OctetString.
  Value: string | null;
  // True when an OctetString was not printable and Value is hex.
  Hex?: boolean;
  // noSuchObject / noSuchInstance / endOfMibView / noSuchName (v1).
  Exception?: string;
}

// Decode an OctetString: printable UTF-8 text when it is (trailing NUL padding
// trimmed — many agents pad fixed-width strings), else spaced uppercase hex.
export function DecodeOctets(Buf: Buffer): { Text: string; Hex: boolean } {
  let End = Buf.length;
  while (End > 0 && Buf[End - 1] === 0) End--;
  const Trimmed = Buf.subarray(0, End);
  const Text = Trimmed.toString('utf8');
  const ValidUtf8 = Buffer.from(Text, 'utf8').equals(Trimmed);
  // eslint-disable-next-line no-control-regex
  if (ValidUtf8 && !/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(Text)) {
    return { Text, Hex: false };
  }
  return { Text: HexOf(Buf), Hex: true };
}

function HexOf(Buf: Buffer): string {
  return (Buf.toString('hex').toUpperCase().match(/../g) || []).join(' ');
}

// net-snmp hands Counter64 back as the raw big-endian bytes.
function Uint64Of(Value: unknown): bigint | null {
  if (typeof Value === 'bigint') return Value;
  if (typeof Value === 'number' && Number.isFinite(Value)) return BigInt(Math.trunc(Value));
  if (Buffer.isBuffer(Value)) return Value.length ? BigInt('0x' + Value.toString('hex')) : 0n;
  return null;
}

interface Decoded {
  Reading: OidReading;
  // The numeric value for comparisons (numeric types only).
  Number: bigint | null;
}

export function DecodeVarbind(Oid: string, Varbind: unknown): Decoded {
  // A reply carrying fewer varbinds than were asked for.
  if (Varbind == null) {
    return {
      Reading: { Oid, Type: null, Value: null, Exception: 'no value returned' },
      Number: null,
    };
  }
  const Vb = (Varbind || {}) as { type?: unknown; value?: unknown };
  const TypeTag = Number(Vb.type);
  if (snmp.isVarbindError(Vb as never) || EXCEPTION_NAMES[TypeTag]) {
    return {
      Reading: { Oid, Type: null, Value: null, Exception: EXCEPTION_NAMES[TypeTag] || 'error' },
      Number: null,
    };
  }
  const Value = Vb.value;

  // Infer the type when an agent (or a test double) leaves it off.
  const Tag =
    TYPE_NAMES[TypeTag] != null
      ? TypeTag
      : typeof Value === 'number' || typeof Value === 'bigint'
        ? 2
        : Buffer.isBuffer(Value)
          ? 4
          : -1;
  const Type = TYPE_NAMES[Tag] || 'Unknown';

  if (NUMERIC_TYPES.has(Tag)) {
    const N =
      Tag === 70
        ? Uint64Of(Value)
        : typeof Value === 'number' && Number.isFinite(Value)
          ? BigInt(Math.trunc(Value))
          : Uint64Of(Value);
    return {
      Reading: { Oid, Type, Value: N == null ? String(Value) : N.toString() },
      Number: N,
    };
  }
  if (Buffer.isBuffer(Value)) {
    if (Tag === 4 || Tag === -1) {
      const { Text, Hex } = DecodeOctets(Value);
      return { Reading: { Oid, Type, Value: Text, ...(Hex ? { Hex } : {}) }, Number: null };
    }
    // BitString / Opaque: always hex.
    return { Reading: { Oid, Type, Value: HexOf(Value), Hex: true }, Number: null };
  }
  return {
    Reading: { Oid, Type, Value: Value == null ? '' : String(Value) },
    Number: null,
  };
}

// --- Assertions --------------------------------------------------------------

// Compare a reading's number with an expected decimal: bigint when the
// expected value is an integer (Counter64 stays exact), float otherwise.
function CompareNumber(Got: bigint, Want: string): number {
  const W = Want.trim();
  if (/^[-+]?\d+$/.test(W)) {
    const B = BigInt(W);
    return Got === B ? 0 : Got > B ? 1 : -1;
  }
  const A = Number(Got);
  const N = Number(W);
  return A === N ? 0 : A > N ? 1 : -1;
}

// Hex readings compare against the expected value with separators removed, so
// a MAC address can be written 00:1a:2b:3c:4d:5e or 00 1A 2B 3C 4D 5E.
function HexKey(Value: string): string {
  return Value.replace(/^0x/i, '')
    .replace(/[\s:.-]/g, '')
    .toLowerCase();
}

function Shorten(Value: string): string {
  return Value.length > 64 ? `${Value.slice(0, 61)}...` : Value;
}

// Evaluate one entry against its OID's decoded reading. Returns null when it
// holds, or the reason (naming the OID and the value) when it does not. Pure —
// exported via _internal for unit tests.
export function EvaluateEntry(Entry: OidEntry, Read: Decoded): string | null {
  const R = Read.Reading;
  if (R.Exception) return `${Entry.Oid}: ${R.Exception}`;
  if (Entry.Op === 'present') return null;

  const Got = R.Value == null ? '' : R.Value;
  const Want = Entry.Expected;
  const Shown = R.Hex ? Got : `"${Shorten(Got)}"`;
  const ShownValue = Read.Number != null ? Got : Shown;
  const Fail = (Expectation: string) => `${Entry.Oid} = ${ShownValue} (expected ${Expectation})`;
  const WantNumeric = Want.trim() !== '' && Number.isFinite(Number(Want.trim()));

  if (Entry.Op === 'equals' || Entry.Op === 'not-equals') {
    let Same: boolean;
    if (Read.Number != null && WantNumeric) Same = CompareNumber(Read.Number, Want) === 0;
    else if (R.Hex) Same = HexKey(Got) === HexKey(Want);
    else Same = Got.trim().toLowerCase() === Want.trim().toLowerCase();
    if (Entry.Op === 'equals' && !Same) return Fail(`= ${Want}`);
    if (Entry.Op === 'not-equals' && Same) return Fail(`!= ${Want}`);
    return null;
  }

  if (Entry.Op === 'contains') {
    const Hay = R.Hex ? HexKey(Got) : Got.toLowerCase();
    const Needle = R.Hex ? HexKey(Want) : Want.toLowerCase();
    return Hay.includes(Needle) ? null : Fail(`to contain "${Want}"`);
  }

  // greater / less. A text value that reads as a number (some agents report
  // temperatures as "23.5") compares numerically; anything else cannot.
  let Order: number;
  if (Read.Number != null) {
    Order = CompareNumber(Read.Number, Want);
  } else {
    const N = R.Hex ? NaN : Number(Got.trim());
    if (Got.trim() === '' || !Number.isFinite(N)) {
      return `${Entry.Oid} = ${ShownValue} is not a number (expected ${OP_SYMBOLS[Entry.Op]} ${Want})`;
    }
    const W = Number(Want.trim());
    Order = N === W ? 0 : N > W ? 1 : -1;
  }
  if (Entry.Op === 'greater' && Order <= 0) return Fail(`> ${Want}`);
  if (Entry.Op === 'less' && Order >= 0) return Fail(`< ${Want}`);
  return null;
}

// --- Probe -------------------------------------------------------------------

interface ProbeResult {
  Reachable: boolean;
  Error?: string;
  LatencyMs?: number;
  Reads: Map<string, Decoded>;
}

// net-snmp reports an agent's error-status reply (the agent DID answer) as a
// RequestFailedError carrying the numeric status; everything else is transport.
function ErrorStatusOf(Err: unknown): number | null {
  if (!Err || typeof Err !== 'object') return null;
  const E = Err as { name?: unknown; status?: unknown };
  if (E.name === 'RequestFailedError' || typeof E.status === 'number') {
    const N = Number(E.status);
    return Number.isFinite(N) ? N : 5;
  }
  return null;
}

function ErrorText(Err: unknown): string {
  return Err instanceof Error ? Err.message || String(Err) : String(Err);
}

// GET every OID over one session, inside an absolute deadline covering the
// whole probe. One request carries all OIDs; if the agent answers it with an
// error status (v1 noSuchName for any missing OID, or tooBig / genErr), each
// OID is fetched on its own so the missing ones can be named and the rest still
// read. The session is always closed before resolving.
export function ProbeOids(
  CreateSession: () => SnmpSession,
  Oids: string[],
  BudgetMs: number
): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    const Started = Date.now();
    let Settled = false;
    let Session: SnmpSession | null = null;
    let Deadline: ReturnType<typeof setTimeout> | null = null;

    const Finish = (Result: ProbeResult) => {
      if (Settled) return;
      Settled = true;
      if (Deadline) clearTimeout(Deadline);
      try {
        if (Session) Session.close();
      } catch {
        // ignore
      }
      resolve(Result);
    };
    const Offline = (Error: string) => Finish({ Reachable: false, Error, Reads: new Map() });

    try {
      Session = CreateSession();
    } catch (Err) {
      Offline(ErrorText(Err));
      return;
    }
    Deadline = setTimeout(
      () => Offline(`No SNMP reply within ${BudgetMs} ms (timeout exceeded)`),
      BudgetMs
    );
    Session.on('error', (Err: Error) => Offline(ErrorText(Err)));

    const Get = (List: string[]): Promise<unknown[]> =>
      new Promise<unknown[]>((Resolve, Reject) => {
        try {
          (Session as SnmpSession).get(List, (Err: Error | null, Varbinds) => {
            if (Err) Reject(Err);
            else Resolve((Varbinds as unknown[]) || []);
          });
        } catch (Err) {
          Reject(Err);
        }
      });

    const Done = (Reads: Map<string, Decoded>) =>
      Finish({ Reachable: true, LatencyMs: Date.now() - Started, Reads });

    Get(Oids).then(
      (Varbinds) => {
        const Reads = new Map<string, Decoded>();
        Oids.forEach((Oid, Idx) => Reads.set(Oid, DecodeVarbind(Oid, Varbinds[Idx])));
        Done(Reads);
      },
      (Err) => {
        if (ErrorStatusOf(Err) == null) {
          Offline(ErrorText(Err));
          return;
        }
        // The agent answered with an error status: read each OID on its own.
        Promise.all(
          Oids.map((Oid) =>
            Get([Oid]).then(
              (Varbinds) => DecodeVarbind(Oid, Varbinds[0]),
              (OneErr) => {
                const Status = ErrorStatusOf(OneErr);
                if (Status == null) throw OneErr;
                const Name = ERROR_STATUS_NAMES[Status] || `error-status ${Status}`;
                return { Reading: { Oid, Type: null, Value: null, Exception: Name }, Number: null };
              }
            )
          )
        ).then(
          (List) => Done(new Map(List.map((D) => [D.Reading.Oid, D]))),
          (OneErr) => Offline(ErrorText(OneErr))
        );
      }
    );
  });
}

// --- Run ---------------------------------------------------------------------

function CreateSessionFor(Config: SnmpOidConfig): () => SnmpSession {
  // Retries share the budget: each attempt gets an equal slice of it.
  const Options: Record<string, unknown> = {
    port: Config.Port,
    timeout: Math.max(100, Math.floor(Config.TimeoutMs / (Config.Retries + 1))),
    retries: Config.Retries,
  };
  if (Config.Version === '3') {
    Options.version = snmp.Version3;
    if (Config.Context) Options.context = Config.Context;
    return () => snmp.createV3Session(Config.Address, BuildUser(Config), Options);
  }
  Options.version = Config.Version === '1' ? snmp.Version1 : snmp.Version2c;
  return () => snmp.createSession(Config.Address, Config.Community, Options);
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Success: false, Error: `Invalid port: ${Config.Port}` };
  }
  if (Config.Version === '3') {
    const CredentialError = ValidateV3Credentials(Config);
    if (CredentialError) return { Success: false, Error: CredentialError };
  }
  if (!Config.RawEntries.length) return { Success: false, Error: 'No OIDs configured' };
  if (Config.RawEntries.length > MAX_ENTRIES) {
    return { Success: false, Error: `Too many OID entries (at most ${MAX_ENTRIES})` };
  }

  let Entries: OidEntry[];
  try {
    Entries = Config.RawEntries.map(ParseEntry);
  } catch (Err) {
    return { Success: false, Error: `Invalid OID entry ${ErrorText(Err)}` };
  }
  const Oids = Array.from(new Set(Entries.map((E) => E.Oid)));

  const Probe = await ProbeOids(CreateSessionFor(Config), Oids, Config.TimeoutMs);
  if (!Probe.Reachable) return { Success: false, Error: Probe.Error || 'No SNMP reply' };

  const Reasons: string[] = [];
  // Name each missing OID once, however many entries reference it.
  for (const Oid of Oids) {
    const Read = Probe.Reads.get(Oid);
    if (Read && Read.Reading.Exception) Reasons.push(`${Oid}: ${Read.Reading.Exception}`);
  }
  const Assertions = Entries.map((Entry) => {
    const Read = Probe.Reads.get(Entry.Oid) as Decoded;
    const Reason = Read.Reading.Exception ? null : EvaluateEntry(Entry, Read);
    if (Reason) Reasons.push(Reason);
    return {
      Oid: Entry.Oid,
      Op: Entry.Op,
      Expected: Entry.Expected,
      Passed: !Read.Reading.Exception && !Reason,
    };
  });

  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs: Probe.LatencyMs,
    Version: Config.Version,
    Values: Oids.map((Oid) => (Probe.Reads.get(Oid) as Decoded).Reading),
    Assertions,
  };
}

// --- Debug -------------------------------------------------------------------

function StatePill(Result: MonitoringResult): string {
  const Reachable = !!(Result && Result.Success === true);
  const Degraded = !!(Result && Result.Degraded);
  if (Reachable && !Degraded) return Pill('success', 'Online');
  if (Reachable) return Pill('warning', 'Degraded');
  return Pill('danger', 'Offline');
}

function FormatTicks(Value: string | null): string {
  const N = Number(Value);
  if (!Number.isFinite(N)) return '';
  const Seconds = Math.floor(N / 100);
  const Days = Math.floor(Seconds / 86400);
  const Hours = Math.floor((Seconds % 86400) / 3600);
  const Minutes = Math.floor((Seconds % 3600) / 60);
  return ` (${Days}d ${Hours}h ${Minutes}m)`;
}

interface AssertionSummary {
  Oid: string;
  Op: AssertOp;
  Expected: string;
  Passed: boolean;
}

function DescribeAssertion(A: AssertionSummary): string {
  if (A.Op === 'present') return 'Expected present';
  if (A.Op === 'contains') return `Expected to contain "${A.Expected}"`;
  return `Expected ${OP_SYMBOLS[A.Op]} ${A.Expected}`;
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseConfig(Target);
  const Reachable = !!(Result && Result.Success === true);

  // The community string is a credential, so only the version is shown.
  const Identity =
    Config.Version === '3' ? `v3 · ${V3IdentityLabel(Config)}` : `v${Config.Version}`;

  const Head = Rows([
    TextRow('Host', `${Config.Address || '—'}:${Config.Port}`),
    Row('SNMP', `<span class="font-monospace">${Esc(Identity)}</span>`),
    Row('Status', StatePill(Result)),
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'No SNMP reply'),
    Reachable && Result.DegradedReason ? TextRow('Reason', String(Result.DegradedReason)) : null,
  ]);
  if (!Reachable) {
    return Head + '<div class="mt-2">' + Note('Failed to read the OIDs over SNMP.') + '</div>';
  }

  const Values = Array.isArray(Result.Values) ? (Result.Values as OidReading[]) : [];
  const Assertions = Array.isArray(Result.Assertions)
    ? (Result.Assertions as AssertionSummary[])
    : [];
  if (!Values.length) return Head;

  const CardsHtml = Values.map((Reading) => {
    const Mine = Assertions.filter((A) => A.Oid === Reading.Oid);
    const Failed = Mine.some((A) => !A.Passed);
    const Badge = Reading.Exception
      ? Pill('danger', Reading.Exception)
      : Failed
        ? Pill('warning', Reading.Type || 'Value')
        : Pill('success', Reading.Type || 'Value');
    const ValueText = Reading.Exception
      ? 'Not present on this device'
      : Reading.Value === ''
        ? '(empty)'
        : (Reading.Hex ? `Hex: ${Reading.Value}` : String(Reading.Value)) +
          (Reading.Type === 'TimeTicks' ? FormatTicks(Reading.Value) : '');
    const Lines = [
      `<div class="text-light small font-monospace text-break">${Esc(ValueText)}</div>`,
      ...Mine.filter((A) => A.Op !== 'present' || !A.Passed).map(
        (A) =>
          `<div class="text-muted small text-break">${Esc(DescribeAssertion(A))} · ${
            A.Passed ? 'passed' : 'failed'
          }</div>`
      ),
    ];
    return Card({
      Title: Reading.Oid,
      TitleClass: 'font-monospace',
      Badge,
      Highlight: !Reading.Exception && !Failed && Mine.some((A) => A.Op !== 'present'),
      BodyHtml: Lines.join(''),
    });
  }).join('');

  return Head + `<div class="mt-2 d-grid gap-1">${CardsHtml}</div>`;
}

export const Name = 'SNMP OID';
export const Description =
  'Reads one or more OIDs from any SNMP agent (v1, v2c or v3) and optionally checks each value: equals, not equals, greater than, less than, contains or present. Offline when the agent does not answer; Degraded when an OID is missing or a check fails.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseConfig,
  ParseEntry,
  NormaliseOid,
  DecodeOctets,
  DecodeVarbind,
  EvaluateEntry,
  ProbeOids,
};
export { ID, Settings, Run, Debug };
