// Critical network interfaces: the pure half.
//
// Everything here is a function of its arguments: parsing addresses, judging a
// critical interface against its conditions, building the view the renderer
// draws, and working out the entry a mark/update request produces. The Client
// entity (./client.ts) holds the state and calls these.
//
// Interfaces are keyed by name ("en0", "Ethernet 2"): it is what the client
// reports them by, and what the interface delta is keyed on.
//
// The principle the audio half follows holds here too: an unknown is never a
// fault. A router the client cannot read is skipped rather than failed, and an
// interface that is allowed to be absent (presence not required) has nothing
// else judged while it is gone: "when it is up, it must have this address".
import type {
  CriticalNetworkInterface,
  NetworkCapabilities,
  NetworkInterfaceAddress,
  NetworkInterfaceView,
  NetworkIssue,
  NetworkIssueKind,
  NetworkStatusView,
} from '@showtrak/protocol';
import { AsRecord } from './normalizers';
import type { CriticalKind } from './critical-kind';

/** DegradedWarnings entries, one per kind of fault (several kinds share one). */
export const NETWORK_WARNINGS: Record<NetworkIssueKind, string> = {
  missing: 'Missing Network Interface',
  address: 'Network Address Changed',
  range: 'Network Address Changed',
  netmask: 'Network Address Changed',
  gateway: 'Network Router Changed',
};

/** One reported interface, as the judging code reads it. */
export interface ObservedNetworkAddress {
  family?: unknown;
  address?: unknown;
  netmask?: unknown;
  mac?: unknown;
  internal?: boolean;
}

export interface ObservedNetworkInterface {
  name: string;
  addresses: ObservedNetworkAddress[];
  /** Undefined when the client did not say (unknown), null when it has none. */
  gateway?: string | null;
}

// --- Addresses -----------------------------------------------------------------

export interface ParsedIP {
  Family: 4 | 6;
  Value: bigint;
}

function ParseIPv4(Text: string): bigint | null {
  const Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(Text);
  if (!Match) return null;
  let Value = 0n;
  for (let Index = 1; Index <= 4; Index += 1) {
    const Octet = Number(Match[Index]);
    if (Octet > 255) return null;
    Value = (Value << 8n) | BigInt(Octet);
  }
  return Value;
}

function ParseIPv6(Text: string): bigint | null {
  let Body = Text;
  // A dotted IPv4 tail ("::ffff:10.0.0.1") stands for the last two groups.
  let Tail: number[] = [];
  const LastColon = Body.lastIndexOf(':');
  if (LastColon !== -1 && Body.slice(LastColon + 1).includes('.')) {
    const V4 = ParseIPv4(Body.slice(LastColon + 1));
    if (V4 === null) return null;
    Tail = [Number((V4 >> 16n) & 0xffffn), Number(V4 & 0xffffn)];
    Body = Body.slice(0, LastColon + 1);
    if (Body.endsWith(':') && !Body.endsWith('::')) Body = Body.slice(0, -1);
  }
  const Halves = Body.split('::');
  if (Halves.length > 2) return null;
  const Groups = (Part: string) => (Part === '' ? [] : Part.split(':'));
  const Head = Groups(Halves[0] ?? '');
  const Rest = Halves.length === 2 ? Groups(Halves[1] ?? '') : [];
  const Explicit = Head.length + Rest.length + Tail.length;
  if (Halves.length === 1 ? Explicit !== 8 : Explicit > 7) return null;
  const Words: number[] = [];
  for (const Group of [...Head, ...new Array(8 - Explicit).fill('0'), ...Rest]) {
    if (!/^[0-9a-f]{1,4}$/i.test(Group)) return null;
    Words.push(parseInt(Group, 16));
  }
  Words.push(...Tail);
  if (Words.length !== 8) return null;
  return Words.reduce((Value, Word) => (Value << 16n) | BigInt(Word), 0n);
}

/** Parse an IPv4 or IPv6 address (an IPv6 zone suffix is ignored); null when it is not one. */
export function ParseIP(Value: unknown): ParsedIP | null {
  if (typeof Value !== 'string') return null;
  const Text = Value.trim().replace(/%.*$/, '');
  if (!Text || Text.length > 64) return null;
  if (Text.includes(':')) {
    const V6 = ParseIPv6(Text);
    return V6 === null ? null : { Family: 6, Value: V6 };
  }
  const V4 = ParseIPv4(Text);
  return V4 === null ? null : { Family: 4, Value: V4 };
}

/** Whether two address strings name the same address, whatever their spelling. */
export function SameIP(Left: unknown, Right: unknown): boolean {
  const A = ParseIP(Left);
  const B = ParseIP(Right);
  return !!A && !!B && A.Family === B.Family && A.Value === B.Value;
}

/** Whether `Value` is a subnet mask: an address whose set bits are all leading. */
export function IsNetmask(Value: unknown): boolean {
  const Parsed = ParseIP(Value);
  if (!Parsed) return false;
  const Bits = Parsed.Family === 4 ? 32n : 128n;
  const Inverted = ((1n << Bits) - 1n) ^ Parsed.Value;
  // The host part is all ones, so one more than it is a power of two.
  return (Inverted & (Inverted + 1n)) === 0n;
}

/** Node reports family as 'IPv4'/'IPv6' or, on some versions, 4/6. */
export function AddressFamily(Value: unknown): 4 | 6 | null {
  const Text = String(Value ?? '').toUpperCase();
  if (Text === '4' || Text === 'IPV4') return 4;
  if (Text === '6' || Text === 'IPV6') return 6;
  return null;
}

/** "IPv4" / "IPv6", for messages. */
function FamilyLabel(Family: 4 | 6): string {
  return Family === 4 ? 'IPv4' : 'IPv6';
}

/** A trimmed, lower-cased address when it parses; null otherwise. */
export function NormalizeIPText(Value: unknown): string | null {
  if (!ParseIP(Value)) return null;
  return String(Value).trim().toLowerCase();
}

export function normalizeInterfaceName(Value: unknown): string | null {
  if (typeof Value !== 'string') return null;
  const Trimmed = Value.trim();
  return Trimmed ? Trimmed.slice(0, 128) : null;
}

// --- Observed interfaces --------------------------------------------------------

function AddressesOf(Iface: ObservedNetworkInterface, Family: 4 | 6) {
  return (Array.isArray(Iface.addresses) ? Iface.addresses : []).filter(
    (Address) => AddressFamily(Address.family) === Family && !!ParseIP(Address.address)
  );
}

function IsLinkLocalV6(Address: unknown): boolean {
  const Parsed = ParseIP(Address);
  return !!Parsed && Parsed.Family === 6 && Parsed.Value >> 118n === 0x3fan;
}

/**
 * The address an operator would call "the interface's IP": its first IPv4
 * address, else its first routable IPv6 one, or, given a family, that family's.
 * What a first mark guards.
 */
export function PrimaryAddress(
  Iface: ObservedNetworkInterface,
  Family: NetworkFamily | null = null
): ObservedNetworkAddress | null {
  const V4 = Family === 'IPv6' ? undefined : AddressesOf(Iface, 4)[0];
  if (V4 || Family === 'IPv4') return V4 || null;
  return AddressesOf(Iface, 6).find((Address) => !IsLinkLocalV6(Address.address)) || null;
}

export type NetworkFamily = 'IPv4' | 'IPv6';

export function normalizeNetworkFamily(Value: unknown): NetworkFamily | null {
  return Value === 'IPv4' || Value === 'IPv6' ? Value : null;
}

/**
 * The family an interface is monitored under when nothing says so: the family
 * of the address it guards, else IPv4 when it has an IPv4 address, else IPv6
 * when it has any IPv6 one (a tunnel with only a link-local address).
 */
export function DefaultNetworkFamily(
  Live: ObservedNetworkInterface | null,
  Existing: CriticalNetworkInterface | null
): NetworkFamily {
  for (const Guarded of [Existing?.Address, Existing?.RangeStart, Existing?.Netmask]) {
    const Parsed = ParseIP(Guarded);
    if (Parsed) return Parsed.Family === 6 ? 'IPv6' : 'IPv4';
  }
  if (Live && AddressesOf(Live, 4).length) return 'IPv4';
  const HasV6 = (Live?.addresses || []).some((Address) => AddressFamily(Address.family) === 6);
  return HasV6 ? 'IPv6' : 'IPv4';
}

/** Internal (loopback) when every address it carries says so. */
export function IsInternalInterface(Iface: ObservedNetworkInterface): boolean {
  const Addresses = Array.isArray(Iface.addresses) ? Iface.addresses : [];
  return Addresses.length > 0 && Addresses.every((Address) => Address.internal === true);
}

function MacOf(Iface: ObservedNetworkInterface): string | null {
  for (const Address of Array.isArray(Iface.addresses) ? Iface.addresses : []) {
    const Mac = typeof Address.mac === 'string' ? Address.mac.trim().toUpperCase() : '';
    if (Mac && Mac !== '00:00:00:00:00:00') return Mac;
  }
  return null;
}

/** Whether the client reports routers at all: any interface carrying the field. */
export function networkCapabilities(Interfaces: ObservedNetworkInterface[]): NetworkCapabilities {
  return {
    Router: Interfaces.some((Iface) => Iface && Iface.gateway !== undefined),
  };
}

// --- Critical entries -------------------------------------------------------------

function OptionalIP(Value: unknown): string | null {
  return NormalizeIPText(Value);
}

/** Normalise a stored or requested critical entry; null when it cannot be one. */
export function normalizeCriticalNetworkEntry(Value: unknown): CriticalNetworkInterface | null {
  const E = AsRecord(Value);
  const Name = normalizeInterfaceName(E.Name);
  if (!Name) return null;
  let RangeStart = OptionalIP(E.RangeStart);
  let RangeEnd = OptionalIP(E.RangeEnd);
  const Start = ParseIP(RangeStart);
  const End = ParseIP(RangeEnd);
  // A half range, a mixed-family one or a backwards one guards nothing sensible.
  if (!Start || !End || Start.Family !== End.Family || Start.Value > End.Value) {
    RangeStart = null;
    RangeEnd = null;
  }
  const Netmask = IsNetmask(E.Netmask) ? OptionalIP(E.Netmask) : null;
  const Mac = typeof E.MAC === 'string' && E.MAC.trim() ? E.MAC.trim().slice(0, 64) : null;
  return {
    Name,
    MAC: Mac,
    Family: normalizeNetworkFamily(E.Family),
    // A monitored interface is always required to be present (without that,
    // monitoring it raises nothing when it goes), so presence is never read from
    // the row, which also brings back any row saved while it could be unticked.
    RequirePresent: true,
    Address: OptionalIP(E.Address),
    RangeStart,
    RangeEnd,
    Netmask,
    Gateway: OptionalIP(E.Gateway),
    Timestamp: Number.isFinite(Number(E.Timestamp)) && E.Timestamp ? Number(E.Timestamp) : null,
  };
}

/** "10.0.0.100–10.0.0.200". */
export function DescribeRange(Start: string, End: string): string {
  return `${Start}–${End}`;
}

function DescribeCurrent(Addresses: Array<{ address?: unknown }>): string {
  const List = Addresses.map((Address) => String(Address.address));
  return List.length === 1 ? `IP address is ${List[0]}` : `IP addresses are ${List.join(', ')}`;
}

/**
 * Judge one critical interface. `Iface` is null when the client did not report
 * it. A missing interface only faults when presence is required; its address
 * conditions describe it while it is up, so they are not judged while it is not.
 */
export function evaluateNetworkIssues(
  Iface: ObservedNetworkInterface | null,
  Critical: CriticalNetworkInterface
): NetworkIssue[] {
  if (!Iface) {
    return Critical.RequirePresent
      ? [{ Kind: 'missing', Message: `${Critical.Name} is not connected` }]
      : [];
  }
  const Issues: NetworkIssue[] = [];

  const Expected = ParseIP(Critical.Address);
  if (Expected && Critical.Address) {
    const Same = AddressesOf(Iface, Expected.Family);
    if (!Same.some((Address) => SameIP(Address.address, Critical.Address))) {
      Issues.push({
        Kind: 'address',
        Message: Same.length
          ? `${DescribeCurrent(Same)} (expected ${Critical.Address})`
          : `No ${FamilyLabel(Expected.Family)} address (expected ${Critical.Address})`,
      });
    }
  }

  const Start = ParseIP(Critical.RangeStart);
  const End = ParseIP(Critical.RangeEnd);
  if (Start && End && Critical.RangeStart && Critical.RangeEnd) {
    const Range = DescribeRange(Critical.RangeStart, Critical.RangeEnd);
    const Same = AddressesOf(Iface, Start.Family);
    const Inside = Same.some((Address) => {
      const Parsed = ParseIP(Address.address);
      return !!Parsed && Parsed.Value >= Start.Value && Parsed.Value <= End.Value;
    });
    if (!Inside) {
      Issues.push({
        Kind: 'range',
        Message: Same.length
          ? Same.length === 1
            ? `IP address ${String(Same[0]!.address)} is outside ${Range}`
            : `No IP address inside ${Range}`
          : `No ${FamilyLabel(Start.Family)} address (expected one inside ${Range})`,
      });
    }
  }

  const Mask = ParseIP(Critical.Netmask);
  if (Mask && Critical.Netmask) {
    // The guarded address's own mask when that address is present; otherwise
    // any address of the family will do. No address of the family at all is the
    // address condition's fault to report, not this one's.
    const Same = AddressesOf(Iface, Mask.Family);
    const Pinned = Same.filter((Address) => SameIP(Address.address, Critical.Address));
    const Judged = Pinned.length ? Pinned : Same;
    if (Judged.length && !Judged.some((Address) => SameIP(Address.netmask, Critical.Netmask))) {
      const Current = Judged.map((Address) => String(Address.netmask ?? '-'));
      Issues.push({
        Kind: 'netmask',
        Message: `Subnet mask is ${Current.join(', ')} (expected ${Critical.Netmask})`,
      });
    }
  }

  if (Critical.Gateway && Iface.gateway !== undefined && !SameIP(Iface.gateway, Critical.Gateway)) {
    Issues.push({
      Kind: 'gateway',
      Message: Iface.gateway
        ? `Router is ${Iface.gateway} (expected ${Critical.Gateway})`
        : `No router (expected ${Critical.Gateway})`,
    });
  }
  return Issues;
}

export function EmptyNetworkStatusView(): NetworkStatusView {
  return { SampledAt: null, Capabilities: null, Interfaces: [] };
}

export interface NetworkViewResult {
  View: NetworkStatusView;
  /** Critical interfaces the client did not report (only populated when trusted). */
  Missing: NetworkInterfaceView[];
  /** De-duplicated DegradedWarnings entries, in a stable order. */
  Warnings: string[];
}

/**
 * Merge the reported interfaces with the critical baselines into the renderer's
 * view. `Trusted` is whether the stored list was reported on this connection:
 * until then nothing is judged, and a critical interface the client has not
 * reported reads as "not reported" rather than as missing.
 */
export function buildNetworkView(
  Interfaces: ObservedNetworkInterface[],
  Criticals: CriticalNetworkInterface[],
  Trusted: boolean,
  SampledAt: number | null
): NetworkViewResult {
  const CriticalByName = new Map<string, CriticalNetworkInterface>();
  for (const Entry of Criticals) {
    if (Entry && Entry.Name && !CriticalByName.has(Entry.Name)) {
      CriticalByName.set(Entry.Name, Entry);
    }
  }
  const Reported = Array.isArray(Interfaces) ? Interfaces : [];
  const Connected: NetworkInterfaceView[] = Reported.map((Iface) => {
    const Critical = CriticalByName.get(Iface.name) || null;
    return {
      Name: Iface.name,
      MAC: MacOf(Iface),
      Internal: IsInternalInterface(Iface),
      Addresses: (Array.isArray(Iface.addresses)
        ? Iface.addresses
        : []) as NetworkInterfaceAddress[],
      Gateway: typeof Iface.gateway === 'string' ? Iface.gateway : null,
      IsConnected: true,
      IsCritical: !!Critical,
      Missing: false,
      Issues: Critical && Trusted ? evaluateNetworkIssues(Iface, Critical) : [],
      Critical,
    };
  });
  const ConnectedNames = new Set(Reported.map((Iface) => Iface.name));
  const Absent: NetworkInterfaceView[] = [];
  for (const Critical of CriticalByName.values()) {
    if (ConnectedNames.has(Critical.Name)) continue;
    const Issues = Trusted ? evaluateNetworkIssues(null, Critical) : [];
    Absent.push({
      Name: Critical.Name,
      MAC: Critical.MAC,
      Internal: false,
      Addresses: [],
      Gateway: null,
      IsConnected: false,
      IsCritical: true,
      // Absent but allowed to be: shown as not connected, never as missing.
      Missing: Trusted && Critical.RequirePresent,
      Issues,
      Critical,
    });
  }

  const All = Connected.concat(Absent);
  const Warnings: string[] = [];
  if (Trusted) {
    for (const Iface of All) {
      for (const Issue of Iface.Issues) {
        const Warning = NETWORK_WARNINGS[Issue.Kind];
        if (!Warnings.includes(Warning)) Warnings.push(Warning);
      }
    }
  }
  return {
    View: {
      SampledAt: Trusted ? SampledAt : null,
      Capabilities: Trusted ? networkCapabilities(Reported) : null,
      Interfaces: All,
    },
    Missing: Trusted ? Absent.filter((Iface) => Iface.Missing) : [],
    Warnings,
  };
}

/** Options a mark/update request may carry; absent ones keep their current value. */
export interface CriticalNetworkOptions {
  Family?: NetworkFamily;
  /** Ignored: a monitored interface is always required to be present. */
  RequirePresent?: boolean;
  Address?: string | null;
  RangeStart?: string | null;
  RangeEnd?: string | null;
  Netmask?: string | null;
  Gateway?: string | null;
}

/**
 * Work out the critical entry a mark/update request produces.
 *
 * A FIRST mark guards what the operator is looking at: the interface must stay
 * up, keep the address it has now with the mask it has now, and keep its router
 * (when the client reports one). An interface that is currently missing can
 * still have its conditions edited; a first mark on one the client has never
 * reported is refused, and so is any mark on an internal interface; loopback
 * is not something that can go wrong on a show network.
 */
export function resolveCriticalNetworkEntry(
  Name: string,
  Options: CriticalNetworkOptions,
  Live: ObservedNetworkInterface | null,
  Existing: CriticalNetworkInterface | null,
  Capabilities: NetworkCapabilities | null,
  Now: number
): [string | null, CriticalNetworkInterface | null] {
  if (Live && IsInternalInterface(Live)) {
    return ['Internal network interfaces cannot be monitored', null];
  }
  if (!Live && !Existing) return ['That network interface is not connected to this client', null];
  const Has = (Key: keyof CriticalNetworkOptions) =>
    Object.prototype.hasOwnProperty.call(Options, Key) && Options[Key] !== undefined;
  const Pick = (
    Key: Exclude<keyof CriticalNetworkOptions, 'RequirePresent' | 'Family'>,
    First: unknown
  ) =>
    Has(Key) ? NormalizeIPText(Options[Key]) : Existing ? Existing[Key] : NormalizeIPText(First);

  // Recorded on every save, so an entry from before it was stored gains it.
  const Family =
    (Has('Family') ? normalizeNetworkFamily(Options.Family) : null) ??
    Existing?.Family ??
    DefaultNetworkFamily(Live, Existing);
  const Primary = Live ? PrimaryAddress(Live, Family) : null;
  const RequirePresent = true;
  const Address = Pick('Address', Primary?.address);
  const Netmask = Pick('Netmask', Primary?.netmask);
  const Gateway = Pick('Gateway', Capabilities?.Router ? Live?.gateway : null);
  const RangeStart = Pick('RangeStart', null);
  const RangeEnd = Pick('RangeEnd', null);

  if (Netmask && !IsNetmask(Netmask)) return ['That is not a valid subnet mask', null];
  if (!!RangeStart !== !!RangeEnd) return ['An IP range needs both a start and an end', null];
  if (RangeStart && RangeEnd) {
    const Start = ParseIP(RangeStart)!;
    const End = ParseIP(RangeEnd)!;
    if (Start.Family !== End.Family) {
      return ['Both ends of an IP range must be the same kind of address', null];
    }
    if (Start.Value > End.Value) return ['The start of an IP range cannot be after its end', null];
  }

  return [
    null,
    {
      Name,
      MAC: (Live ? MacOf(Live) : null) ?? Existing?.MAC ?? null,
      Family,
      RequirePresent,
      Address,
      RangeStart,
      RangeEnd,
      Netmask,
      Gateway,
      Timestamp: Existing?.Timestamp ?? Now,
    },
  ];
}

/** Network interfaces monitored by interface name (see ./critical-kind). */
export const NETWORK_KIND: CriticalKind<CriticalNetworkInterface> = {
  KeyOf: (Entry) => Entry.Name,
  NormalizeKey: normalizeInterfaceName,
  NormalizeEntry: normalizeCriticalNetworkEntry,
  Messages: {
    KeyRequired: 'Network interface name is required',
    SaveFailed: 'Failed to save monitored network interface',
    RemoveFailed: 'Failed to remove monitored network interface',
    LookupFailed: 'Failed to determine monitored network interface status',
  },
};
