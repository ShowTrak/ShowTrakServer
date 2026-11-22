// IGMP querier presence, read from a switch or router over SNMP.
//
// A Node process cannot see IGMP queries without raw sockets, so this method
// asks the network gear itself which querier each interface (usually a VLAN)
// has. It walks the standard MIBs:
//
//   IGMP-STD-MIB (RFC 2933), igmpStdMIB = mib-2 85:
//     igmpInterfaceTable 1.3.6.1.2.1.85.1.1, entry .1, INDEX { ifIndex }
//       .3 igmpInterfaceStatus           RowStatus (1 = active)
//       .4 igmpInterfaceVersion          Unsigned32
//       .5 igmpInterfaceQuerier          IpAddress
//       .7 igmpInterfaceQuerierUpTime    TimeTicks, since the querier changed
//       .8 igmpInterfaceQuerierExpiryTime TimeTicks; "If the local system is
//          the querier, the value of this object is zero."
//
//   MGMD-STD-MIB (RFC 5519, which obsoletes RFC 2933), mgmdStdMIB = mib-2 185:
//     mgmdRouterInterfaceTable 1.3.6.1.2.1.185.1.2, entry .1,
//       INDEX { ifIndex, InetAddressType } (1 = ipv4, 2 = ipv6; only ipv4 is
//       read here, since IPv6 rows are MLD rather than IGMP)
//       .3 mgmdRouterInterfaceQuerier           InetAddress (4 octets for ipv4)
//       .5 mgmdRouterInterfaceStatus            RowStatus
//       .6 mgmdRouterInterfaceVersion           Unsigned32 (1..3)
//       .8 mgmdRouterInterfaceQuerierUpTime     TimeTicks
//       .9 mgmdRouterInterfaceQuerierExpiryTime TimeTicks (zero when local)
//
//   IF-MIB (RFC 2863) for interface names: ifName 1.3.6.1.2.1.31.1.1.1.1 and
//   ifDescr 1.3.6.1.2.1.2.2.1.2, read for the IGMP rows only.
//
// Caveat, stated in the editor too: igmpInterfaceQuerier is in the MIB's
// router and optional-host groups, not the base group, and many AV switches
// only report their IGMP snooping querier in a vendor MIB. The device must
// implement one of these standard tables for this check to see anything.
//
// Verdicts:
//   Offline  = no SNMP reply (timeout, unreachable, wrong credentials).
//   Missing querier (on a listed interface, or on every interface when none are
//   listed; a 0.0.0.0 querier, an inactive row, a listed interface absent from
//   the table, or no IGMP rows at all) = Degraded, or Offline when the operator
//   chooses.
//   Degraded = a querier other than the expected address.
import { Card, Esc, Pill, Rows, Row, TextRow, Note, FormatLatency } from './debug';
import { DEFAULT_PORT, type SnmpSession } from './_snmp-ups-shared';
import {
  SNMP_VERSION_FIELDS,
  SnmpBudgetFields,
  ParseSnmpCredentials,
  SnmpConnectionError,
  CreateSnmpSessionFactory,
  SnmpIdentityLabel,
  SnmpErrorStatusOf,
  SnmpErrorText,
  type SnmpConnection,
} from './_snmp-shared';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'igmp-querier';

const DEFAULT_TIMEOUT_MS = 6000;
// Rows beyond this are ignored; a switch has one row per IGMP-enabled VLAN.
const MAX_ROWS = 256;
const MAX_INTERFACES = 64;
// OIDs per GET when reading interface names, small enough to avoid tooBig.
const NAME_CHUNK = 20;
const MAX_REPETITIONS = 20;

export const IGMP_ENTRY = '1.3.6.1.2.1.85.1.1.1';
export const MGMD_ROUTER_ENTRY = '1.3.6.1.2.1.185.1.2.1';
export const IF_NAME = '1.3.6.1.2.1.31.1.1.1.1';
export const IF_DESCR = '1.3.6.1.2.1.2.2.1.2';

// Column numbers per table.
const IGMP_COLUMNS = { Status: 3, Version: 4, Querier: 5, UpTime: 7, Expiry: 8 };
const MGMD_COLUMNS = { Querier: 3, Status: 5, Version: 6, UpTime: 8, Expiry: 9 };

const ROW_STATUS: Record<number, string> = {
  1: 'active',
  2: 'notInService',
  3: 'notReady',
  4: 'createAndGo',
  5: 'createAndWait',
  6: 'destroy',
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
  ...SNMP_VERSION_FIELDS,
  {
    Key: 'Interfaces',
    Label: 'Monitored interfaces',
    Type: 'list',
    ItemType: 'string',
    Default: [],
    Note: 'Interface names (e.g. vlan10) or ifIndex numbers that must have a querier. Leave empty to require one on every IGMP interface the device reports.',
  },
  {
    Key: 'ExpectedQuerier',
    Label: 'Expected querier address',
    Type: 'string',
    Default: '',
    Note: 'Degraded when a different device is the querier. Leave blank to accept any querier.',
  },
  {
    Key: 'MissingState',
    Label: 'No querier marks the check as',
    Type: 'select',
    Default: 'degraded',
    Options: [
      { value: 'degraded', label: 'Degraded' },
      { value: 'offline', label: 'Offline' },
    ],
  },
  {
    Key: 'Mib',
    Label: 'MIB',
    Type: 'select',
    Default: 'auto',
    Advanced: true,
    Options: [
      { value: 'auto', label: 'Automatic' },
      { value: 'igmp', label: 'IGMP-STD-MIB (RFC 2933)' },
      { value: 'mgmd', label: 'MGMD-STD-MIB (RFC 5519)' },
    ],
    Note: 'Automatic reads IGMP-STD-MIB and falls back to MGMD-STD-MIB when it has no rows.',
  },
  ...SnmpBudgetFields(DEFAULT_TIMEOUT_MS),
];

// --- Config ------------------------------------------------------------------

type MibChoice = 'auto' | 'igmp' | 'mgmd';

interface IgmpConfig extends SnmpConnection {
  Interfaces: string[];
  ExpectedQuerier: string;
  MissingOffline: boolean;
  Mib: MibChoice;
}

function ParseConfig(Target: MonitoringTargetLike): IgmpConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Num = (Value: unknown, Fallback: number): number => {
    const N = Number(Value);
    return Number.isFinite(N) ? N : Fallback;
  };
  const Mib = String(Cfg.Mib);
  const RawList = Array.isArray(Cfg.Interfaces)
    ? Cfg.Interfaces
    : typeof Cfg.Interfaces === 'string'
      ? Cfg.Interfaces.split(/[,\n]/)
      : [];
  const Seen = new Set<string>();
  const Interfaces: string[] = [];
  for (const Entry of RawList) {
    const Text = String(Entry == null ? '' : Entry).trim();
    if (!Text || Seen.has(Text.toLowerCase())) continue;
    Seen.add(Text.toLowerCase());
    Interfaces.push(Text);
  }
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Port: Num(Cfg.Port, DEFAULT_PORT) | 0,
    ...ParseSnmpCredentials(Cfg),
    Interfaces,
    ExpectedQuerier: Cfg.ExpectedQuerier == null ? '' : String(Cfg.ExpectedQuerier).trim(),
    MissingOffline: String(Cfg.MissingState) === 'offline',
    Mib: Mib === 'igmp' || Mib === 'mgmd' ? Mib : 'auto',
    TimeoutMs: Math.max(500, Num(Cfg.Timeout, DEFAULT_TIMEOUT_MS)),
    Retries: Math.max(0, Math.min(5, Num(Cfg.Retries, 1) | 0)),
  };
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function IsIpv4(Value: string): boolean {
  const M = IPV4.exec(Value);
  return !!M && M.slice(1).every((Part) => Number(Part) <= 255);
}

// --- Decoding ----------------------------------------------------------------

export interface QuerierRow {
  IfIndex: number;
  // ifName, else ifDescr, else null when the device does not report either.
  IfName: string | null;
  // Dotted IPv4 querier, or null when none (0.0.0.0, empty or not reported).
  Querier: string | null;
  // RowStatus number, null when not reported.
  Status: number | null;
  IgmpVersion: number | null;
  // Hundredths of a second.
  UpTimeTicks: number | null;
  ExpiryTicks: number | null;
  // This device is the querier (expiry time zero with a querier present).
  IsLocal: boolean;
}

function NumberOf(Value: unknown): number | null {
  if (typeof Value === 'number' && Number.isFinite(Value)) return Value;
  if (typeof Value === 'bigint') return Number(Value);
  return null;
}

// A querier address from an IpAddress varbind (net-snmp decodes it to a dotted
// string) or an InetAddress OCTET STRING (4 raw bytes for ipv4). 0.0.0.0 and
// anything unreadable mean no querier.
export function DecodeQuerier(Value: unknown): string | null {
  let Text: string | null = null;
  if (typeof Value === 'string') Text = Value.trim();
  else if (Buffer.isBuffer(Value) && Value.length === 4) Text = Array.from(Value).join('.');
  if (!Text || !IsIpv4(Text) || Text === '0.0.0.0') return null;
  return Text;
}

interface Varbind {
  oid: string;
  type?: number;
  value?: unknown;
}

// Group walked varbinds into rows by index. Returns rows in ifIndex order.
// Rows whose index does not fit the table (or, for MGMD, IPv6 rows) are skipped.
export function BuildRows(Mib: 'igmp' | 'mgmd', Varbinds: Varbind[]): QuerierRow[] {
  const Entry = Mib === 'igmp' ? IGMP_ENTRY : MGMD_ROUTER_ENTRY;
  const Cols = Mib === 'igmp' ? IGMP_COLUMNS : MGMD_COLUMNS;
  const Prefix = `${Entry}.`;
  const Rows = new Map<number, QuerierRow>();
  for (const Vb of Varbinds) {
    if (!Vb || typeof Vb.oid !== 'string' || !Vb.oid.startsWith(Prefix)) continue;
    if (Vb.type != null && Vb.type >= 128 && Vb.type <= 130) continue;
    const Arcs = Vb.oid.slice(Prefix.length).split('.').map(Number);
    if (Arcs.some((A) => !Number.isInteger(A))) continue;
    const Column = Arcs[0] as number;
    const IfIndex = Arcs[1];
    if (IfIndex == null || IfIndex < 1) continue;
    if (Mib === 'igmp' ? Arcs.length !== 2 : Arcs.length !== 3 || Arcs[2] !== 1) continue;
    let Row = Rows.get(IfIndex);
    if (!Row) {
      Row = {
        IfIndex,
        IfName: null,
        Querier: null,
        Status: null,
        IgmpVersion: null,
        UpTimeTicks: null,
        ExpiryTicks: null,
        IsLocal: false,
      };
      Rows.set(IfIndex, Row);
    }
    if (Column === Cols.Querier) Row.Querier = DecodeQuerier(Vb.value);
    else if (Column === Cols.Status) Row.Status = NumberOf(Vb.value);
    else if (Column === Cols.Version) Row.IgmpVersion = NumberOf(Vb.value);
    else if (Column === Cols.UpTime) Row.UpTimeTicks = NumberOf(Vb.value);
    else if (Column === Cols.Expiry) Row.ExpiryTicks = NumberOf(Vb.value);
  }
  const List = Array.from(Rows.values()).sort((A, B) => A.IfIndex - B.IfIndex);
  for (const Row of List) Row.IsLocal = !!Row.Querier && Row.ExpiryTicks === 0;
  return List.slice(0, MAX_ROWS);
}

// Text of an OctetString name, trailing NULs trimmed; null when empty.
function NameOf(Vb: Varbind | undefined): string | null {
  if (!Vb || (Vb.type != null && Vb.type >= 128 && Vb.type <= 130)) return null;
  const Value = Vb.value;
  let Text = '';
  if (Buffer.isBuffer(Value)) Text = Value.toString('utf8');
  else if (typeof Value === 'string') Text = Value;
  // Drop NUL padding and any other control characters some agents include.
  // eslint-disable-next-line no-control-regex
  const Controls = /[\x00-\x1F\x7F]/g;
  Text = Text.replace(Controls, '').trim();
  return Text || null;
}

// --- Evaluation --------------------------------------------------------------

export interface InterfaceVerdict {
  // The interface as the operator listed it, or its name/ifIndex when not listed.
  Label: string;
  Row: QuerierRow | null;
  // 'ok' | 'missing' | 'inactive' | 'absent' | 'unexpected'
  Verdict: 'ok' | 'missing' | 'inactive' | 'absent' | 'unexpected';
}

// The row a listed interface names: ifIndex number first, then ifName/ifDescr.
export function FindRow(Rows: QuerierRow[], Entry: string): QuerierRow | null {
  const Key = Entry.trim().toLowerCase();
  if (/^\d+$/.test(Key)) {
    const ByIndex = Rows.find((R) => R.IfIndex === Number(Key));
    if (ByIndex) return ByIndex;
  }
  return Rows.find((R) => R.IfName != null && R.IfName.toLowerCase() === Key) || null;
}

function RowLabel(Row: QuerierRow): string {
  return Row.IfName ? Row.IfName : `ifIndex ${Row.IfIndex}`;
}

function IsActive(Row: QuerierRow): boolean {
  return Row.Status == null || Row.Status === 1;
}

export function Evaluate(
  Rows: QuerierRow[],
  Config: Pick<IgmpConfig, 'Interfaces' | 'ExpectedQuerier'>
): { Verdicts: InterfaceVerdict[]; Missing: string[]; Unexpected: string[] } {
  const Judge = (Label: string, Row: QuerierRow | null): InterfaceVerdict => {
    if (!Row) return { Label, Row, Verdict: 'absent' };
    if (!IsActive(Row)) return { Label, Row, Verdict: 'inactive' };
    if (!Row.Querier) return { Label, Row, Verdict: 'missing' };
    if (Config.ExpectedQuerier && Row.Querier !== Config.ExpectedQuerier) {
      return { Label, Row, Verdict: 'unexpected' };
    }
    return { Label, Row, Verdict: 'ok' };
  };
  const Verdicts = Config.Interfaces.length
    ? Config.Interfaces.map((Entry) => Judge(Entry, FindRow(Rows, Entry)))
    : // Unlisted: every active row. Inactive rows are IGMP switched off there.
      Rows.filter(IsActive).map((Row) => Judge(RowLabel(Row), Row));

  const Missing: string[] = [];
  const Unexpected: string[] = [];
  if (!Config.Interfaces.length && !Verdicts.length) {
    Missing.push('No active IGMP interfaces reported');
  }
  for (const V of Verdicts) {
    if (V.Verdict === 'absent') Missing.push(`${V.Label}: not in the IGMP table`);
    else if (V.Verdict === 'inactive') Missing.push(`${V.Label}: IGMP not active`);
    else if (V.Verdict === 'missing') Missing.push(`${V.Label}: no querier`);
    else if (V.Verdict === 'unexpected') {
      Unexpected.push(
        `${V.Label}: querier ${V.Row && V.Row.Querier} (expected ${Config.ExpectedQuerier})`
      );
    }
  }
  return { Verdicts, Missing, Unexpected };
}

// --- Probe -------------------------------------------------------------------

export interface ProbeResult {
  Reachable: boolean;
  Error?: string;
  LatencyMs?: number;
  Mib?: 'igmp' | 'mgmd';
  Rows: QuerierRow[];
}

// An agent's error-status reply (RequestFailedError): it DID answer.
function IsAgentError(Err: unknown): boolean {
  return SnmpErrorStatusOf(Err) != null;
}

// Walk one table, then read the names of its interfaces, over one session and
// inside one absolute deadline. The session is always closed before resolving.
export function ProbeQuerier(
  CreateSession: () => SnmpSession,
  Mib: MibChoice,
  BudgetMs: number
): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    const Started = Date.now();
    let Settled = false;
    let Session: SnmpSession | null = null;
    let Deadline: ReturnType<typeof setTimeout> | null = null;
    let LatencyMs: number | null = null;

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
    const Offline = (Error: string) => Finish({ Reachable: false, Error, Rows: [] });

    try {
      Session = CreateSession();
    } catch (Err) {
      Offline(SnmpErrorText(Err));
      return;
    }
    Deadline = setTimeout(
      () => Offline(`No SNMP reply within ${BudgetMs} ms (timeout exceeded)`),
      BudgetMs
    );
    Session.on('error', (Err: Error) => Offline(SnmpErrorText(Err)));

    // Resolves the varbinds under Base; rejects only on a transport failure.
    // An agent error status ends the walk with what was read so far.
    const Walk = (Base: string): Promise<Varbind[]> =>
      new Promise<Varbind[]>((Resolve, Reject) => {
        const Out: Varbind[] = [];
        // Columns are walked in turn, so the cap allows every column a full set.
        const Cap = MAX_ROWS * 20;
        try {
          (Session as SnmpSession).subtree(
            Base,
            MAX_REPETITIONS,
            (Varbinds: unknown[]) => {
              if (LatencyMs == null) LatencyMs = Date.now() - Started;
              for (const Vb of Varbinds as Varbind[]) Out.push(Vb);
              return Out.length >= Cap;
            },
            (Err: Error | null) => {
              if (LatencyMs == null && (!Err || IsAgentError(Err))) {
                LatencyMs = Date.now() - Started;
              }
              if (Err && !IsAgentError(Err)) Reject(Err);
              else Resolve(Out);
            }
          );
        } catch (Err) {
          Reject(Err);
        }
      });

    const Get = (Oids: string[]): Promise<Varbind[]> =>
      new Promise<Varbind[]>((Resolve) => {
        try {
          (Session as SnmpSession).get(Oids, (Err: Error | null, Varbinds) => {
            // Names are optional: any failure leaves them unread.
            Resolve(Err ? [] : (Varbinds as Varbind[]) || []);
          });
        } catch {
          Resolve([]);
        }
      });

    const ReadNames = async (Rows: QuerierRow[]): Promise<void> => {
      const Wanted = Rows.slice(0, MAX_INTERFACES);
      const Oids: string[] = [];
      for (const Row of Wanted)
        Oids.push(`${IF_NAME}.${Row.IfIndex}`, `${IF_DESCR}.${Row.IfIndex}`);
      const Found = new Map<string, Varbind>();
      for (let I = 0; I < Oids.length && !Settled; I += NAME_CHUNK) {
        const Chunk = Oids.slice(I, I + NAME_CHUNK);
        const Reply = await Get(Chunk);
        Reply.forEach((Vb, Idx) => {
          if (Vb) Found.set(Chunk[Idx] as string, Vb);
        });
      }
      for (const Row of Wanted) {
        Row.IfName =
          NameOf(Found.get(`${IF_NAME}.${Row.IfIndex}`)) ||
          NameOf(Found.get(`${IF_DESCR}.${Row.IfIndex}`));
      }
    };

    (async () => {
      let Used: 'igmp' | 'mgmd' = Mib === 'mgmd' ? 'mgmd' : 'igmp';
      let Rows = BuildRows(Used, await Walk(Used === 'igmp' ? IGMP_ENTRY : MGMD_ROUTER_ENTRY));
      if (!Rows.length && Mib === 'auto' && !Settled) {
        Used = 'mgmd';
        Rows = BuildRows(Used, await Walk(MGMD_ROUTER_ENTRY));
      }
      if (Rows.length && !Settled) await ReadNames(Rows);
      Finish({
        Reachable: true,
        LatencyMs: LatencyMs == null ? Date.now() - Started : LatencyMs,
        Mib: Used,
        Rows,
      });
    })().catch((Err) => Offline(SnmpErrorText(Err)));
  });
}

// --- Run ---------------------------------------------------------------------

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  const ConnectionError = SnmpConnectionError(Config);
  if (ConnectionError) return { Success: false, Error: ConnectionError };
  if (Config.Interfaces.length > MAX_INTERFACES) {
    return { Success: false, Error: `Too many interfaces (at most ${MAX_INTERFACES})` };
  }
  if (Config.ExpectedQuerier && !IsIpv4(Config.ExpectedQuerier)) {
    return {
      Success: false,
      Error: `Expected querier "${Config.ExpectedQuerier}" is not an IPv4 address`,
    };
  }

  const Probe = await ProbeQuerier(CreateSnmpSessionFactory(Config), Config.Mib, Config.TimeoutMs);
  if (!Probe.Reachable) return { Success: false, Error: Probe.Error || 'No SNMP reply' };

  const { Verdicts, Missing, Unexpected } = Evaluate(Probe.Rows, Config);
  const Details = {
    LatencyMs: Probe.LatencyMs,
    Version: Config.Version,
    Mib: Probe.Mib,
    Rows: Probe.Rows,
    Verdicts: Verdicts.map((V) => ({
      Label: V.Label,
      IfIndex: V.Row ? V.Row.IfIndex : null,
      Verdict: V.Verdict,
    })),
  };
  if (Missing.length && Config.MissingOffline) {
    return {
      Success: false,
      Error: [...Missing, ...Unexpected].join('; '),
      AgentAnswered: true,
      ...Details,
    };
  }
  const Reasons = [...Missing, ...Unexpected];
  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    ...Details,
  };
}

// --- Debug -------------------------------------------------------------------

function StatePill(Result: MonitoringResult): string {
  const Reachable = !!(Result && Result.Success === true);
  if (Reachable && !Result.Degraded) return Pill('success', 'Online');
  if (Reachable) return Pill('warning', 'Degraded');
  return Pill('danger', 'Offline');
}

function FormatTicks(Ticks: number | null): string {
  if (Ticks == null || !Number.isFinite(Ticks)) return '-';
  const Seconds = Math.floor(Ticks / 100);
  const Days = Math.floor(Seconds / 86400);
  const Hours = Math.floor((Seconds % 86400) / 3600);
  const Minutes = Math.floor((Seconds % 3600) / 60);
  return `${Days}d ${Hours}h ${Minutes}m`;
}

const VERDICT_PILLS: Record<InterfaceVerdict['Verdict'], [string, string]> = {
  ok: ['success', 'Querier'],
  missing: ['danger', 'No querier'],
  inactive: ['danger', 'IGMP not active'],
  absent: ['danger', 'Not found'],
  unexpected: ['warning', 'Unexpected querier'],
};

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseConfig(Target);
  const Reachable = !!(Result && Result.Success === true);
  const Answered = Reachable || !!(Result && Result.AgentAnswered);

  const Identity = SnmpIdentityLabel(Config);
  const MibLabel =
    Result && Result.Mib === 'mgmd'
      ? 'MGMD-STD-MIB (RFC 5519)'
      : Result && Result.Mib === 'igmp'
        ? 'IGMP-STD-MIB (RFC 2933)'
        : null;

  const Head = Rows([
    TextRow('Host', `${Config.Address || '-'}:${Config.Port}`),
    Row('SNMP', `<span class="font-monospace">${Esc(Identity)}</span>`),
    Row('Status', StatePill(Result)),
    MibLabel ? TextRow('MIB', MibLabel) : null,
    Answered
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : null,
    !Reachable ? TextRow('Error', (Result && Result.Error) || 'No SNMP reply') : null,
    Reachable && Result.DegradedReason ? TextRow('Reason', String(Result.DegradedReason)) : null,
    Config.ExpectedQuerier ? TextRow('Expected querier', Config.ExpectedQuerier) : null,
  ]);
  if (!Answered) {
    return (
      Head + '<div class="mt-2">' + Note('Failed to read the IGMP table over SNMP.') + '</div>'
    );
  }

  const RowList = Array.isArray(Result.Rows) ? (Result.Rows as QuerierRow[]) : [];
  const Verdicts = Array.isArray(Result.Verdicts)
    ? (Result.Verdicts as Array<{ Label: string; IfIndex: number | null; Verdict: string }>)
    : [];
  if (!RowList.length && !Verdicts.length) {
    return (
      Head +
      '<div class="mt-2">' +
      Note(
        'The device reported no rows in the standard IGMP tables. It may report its querier only in a vendor MIB, or IGMP may be off.'
      ) +
      '</div>'
    );
  }

  const Judged = new Map<number, string>();
  for (const V of Verdicts) if (V.IfIndex != null) Judged.set(V.IfIndex, V.Verdict);

  const CardFor = (Row: QuerierRow | null, Label: string, Verdict: string | undefined): string => {
    const Known = Verdict && VERDICT_PILLS[Verdict as InterfaceVerdict['Verdict']];
    const Badge = Known
      ? Pill(Known[0], Known[1])
      : Row && Row.Querier
        ? Pill('muted', 'Querier')
        : Pill('muted', 'No querier');
    const Lines: string[] = [];
    if (Row) {
      const Who = Row.Querier
        ? `${Row.Querier}${Row.IsLocal ? ' (this device)' : ''}`
        : 'No querier';
      Lines.push(`<div class="text-light small font-monospace text-break">${Esc(Who)}</div>`);
      const Facts = [
        Row.IfName && Row.IfName !== Label ? Row.IfName : null,
        `ifIndex ${Row.IfIndex}`,
        Row.IgmpVersion != null ? `IGMPv${Row.IgmpVersion}` : null,
        Row.Status != null && Row.Status !== 1
          ? `Row ${ROW_STATUS[Row.Status] || Row.Status}`
          : null,
        Row.Querier && Row.UpTimeTicks != null
          ? `Querier for ${FormatTicks(Row.UpTimeTicks)}`
          : null,
      ].filter(Boolean);
      Lines.push(`<div class="text-muted small text-break">${Esc(Facts.join(' · '))}</div>`);
    } else {
      Lines.push(`<div class="text-muted small">${Esc('Not in the IGMP table')}</div>`);
    }
    return Card({
      Title: Label,
      Badge,
      Highlight: Verdict === 'ok',
      BodyHtml: Lines.join(''),
    });
  };

  // Listed interfaces first (including any not found), then the other rows.
  const Cards: string[] = [];
  const Shown = new Set<number>();
  if (Config.Interfaces.length) {
    for (const V of Verdicts) {
      const Row = V.IfIndex != null ? RowList.find((R) => R.IfIndex === V.IfIndex) || null : null;
      if (Row) Shown.add(Row.IfIndex);
      Cards.push(CardFor(Row, V.Label, V.Verdict));
    }
  }
  for (const Row of RowList) {
    if (Shown.has(Row.IfIndex)) continue;
    Cards.push(CardFor(Row, RowLabel(Row), Judged.get(Row.IfIndex)));
  }
  return Head + `<div class="mt-2 d-grid gap-1">${Cards.join('')}</div>`;
}

export const Name = 'IGMP Querier';
export const Description =
  'Reads which device is the IGMP querier on each interface or VLAN of a switch or router over SNMP (v1, v2c or v3), from the standard IGMP-STD-MIB or MGMD-STD-MIB. Degraded (or Offline, if chosen) when an interface has no querier; Degraded when the querier is not the expected address.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseConfig,
  IsIpv4,
  DecodeQuerier,
  BuildRows,
  FindRow,
  Evaluate,
  ProbeQuerier,
};
export { ID, Settings, Run, Debug };
