// Network section of the client info modal — the decisions, without the DOM.
//
// What the section shows, which interfaces may be marked critical, and the
// conditions table of a critical one. The server judges the conditions; this
// only lays them out and turns the operator's edits into a request.
import type {
  ClientView,
  NetworkCapabilities,
  NetworkInterfaceAddress,
  NetworkInterfaceView,
} from '@showtrak/protocol';

export type NetworkFamily = 'IPv4' | 'IPv6';

/**
 * Which overall message the section shows:
 *  - `waiting`: online, but its interfaces have not been reported yet;
 *  - `offline`: nothing live, so the list is the last one seen;
 *  - `ok`: render the interfaces.
 */
export type NetworkSectionState = 'waiting' | 'offline' | 'ok';

export function GetNetworkSectionState(Client: ClientView): NetworkSectionState {
  if (!Client.Online) return 'offline';
  const View = Client.NetworkStatus;
  if (!View || View.SampledAt === null || View.SampledAt === undefined) return 'waiting';
  return 'ok';
}

export function NetworkSectionMessage(State: Exclude<NetworkSectionState, 'ok'>): {
  Title: string;
  Body: string;
} {
  if (State === 'waiting') {
    return {
      Title: 'Waiting for Network Interfaces',
      Body: 'This client has not reported its network interfaces yet.',
    };
  }
  return {
    Title: 'Client Offline',
    Body: 'Network interfaces are reported while the client is connected.',
  };
}

// --- Addresses ------------------------------------------------------------------
// A copy of the parsing in Modules/ClientManager/network.ts (the renderer is a
// separate bundle). The server re-validates everything it is sent.

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

export function ParseIP(Value: unknown): { Family: 4 | 6; Value: bigint } | null {
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

function FormatIPv4(Value: bigint): string {
  return [24n, 16n, 8n, 0n].map((Shift) => String((Value >> Shift) & 0xffn)).join('.');
}

export function AddressFamily(Value: unknown): NetworkFamily | null {
  const Text = String(Value ?? '').toUpperCase();
  if (Text === '4' || Text === 'IPV4') return 'IPv4';
  if (Text === '6' || Text === 'IPV6') return 'IPv6';
  return null;
}

/** The addresses of one family, in the order the client reported them. */
export function AddressesFor(
  Iface: NetworkInterfaceView,
  Family: NetworkFamily
): NetworkInterfaceAddress[] {
  return (Iface.Addresses || []).filter((Address) => AddressFamily(Address.family) === Family);
}

/** "10.0.0.5/24" when the client gave a CIDR, else the bare address. */
export function FormatAddress(Address: NetworkInterfaceAddress): string {
  return String(Address.cidr || Address.address || '');
}

function IsLinkLocalV6(Address: unknown): boolean {
  const Parsed = ParseIP(Address);
  return !!Parsed && Parsed.Family === 6 && Parsed.Value >> 118n === 0x3fan;
}

/** The address a first mark guards: the first IPv4, else the first routable IPv6. */
export function PrimaryAddress(Iface: NetworkInterfaceView): NetworkInterfaceAddress | null {
  const V4 = AddressesFor(Iface, 'IPv4').find((Address) => ParseIP(Address.address));
  if (V4) return V4;
  return (
    AddressesFor(Iface, 'IPv6').find(
      (Address) => ParseIP(Address.address) && !IsLinkLocalV6(Address.address)
    ) || null
  );
}

/**
 * The usable host range of the subnet `Address` sits in — what ticking "IP
 * range" starts from. 10.0.0.5/255.255.255.0 gives 10.0.0.1–10.0.0.254. A /31,
 * a /32, or anything that is not IPv4 gives just the address itself.
 */
export function SubnetHostRange(
  Address: unknown,
  Netmask: unknown
): { Start: string; End: string } | null {
  const Parsed = ParseIP(Address);
  if (!Parsed) return null;
  const Self = String(Address).trim();
  const Mask = ParseIP(Netmask);
  if (Parsed.Family !== 4 || !Mask || Mask.Family !== 4) return { Start: Self, End: Self };
  const Network = Parsed.Value & Mask.Value;
  const Broadcast = Network | (0xffffffffn ^ Mask.Value);
  if (Broadcast - Network < 2n) return { Start: Self, End: Self };
  return { Start: FormatIPv4(Network + 1n), End: FormatIPv4(Broadcast - 1n) };
}

// --- Cards ------------------------------------------------------------------------

/** Which interfaces the list shows, in the order the server sent them. */
export function VisibleInterfaces(Client: ClientView): NetworkInterfaceView[] {
  return Client.NetworkStatus?.Interfaces || [];
}

/**
 * The card's title: the interface's first address of the shown family (other
 * addresses of that family follow as extra lines), or why there is none.
 */
export function NetworkInterfaceTitle(
  Iface: NetworkInterfaceView,
  Family: NetworkFamily
): { Title: string; Extra: string[] } {
  if (!Iface.IsConnected) {
    return { Title: Iface.Missing ? 'Not Connected' : 'Not Reported', Extra: [] };
  }
  const Addresses = AddressesFor(Iface, Family).map((Address) => String(Address.address || ''));
  const [First, ...Rest] = Addresses.filter(Boolean);
  return First ? { Title: First, Extra: Rest } : { Title: `No ${Family} Address`, Extra: [] };
}

/**
 * The card's subtitle: "en0 · 255.255.255.0 · Router 10.0.0.1 · AA:BB:CC:DD:EE:FF"
 * — the interface name first, then whatever else is known.
 */
export function NetworkInterfaceSummary(
  Iface: NetworkInterfaceView,
  Capabilities: NetworkCapabilities | null,
  Family: NetworkFamily = 'IPv4'
): string {
  const Parts: string[] = [Iface.Name];
  const Mask = AddressesFor(Iface, Family).find((Address) => Address.netmask)?.netmask;
  if (Iface.IsConnected && Mask) Parts.push(String(Mask));
  if (Iface.IsConnected && Capabilities?.Router) {
    Parts.push(Iface.Gateway ? `Router ${Iface.Gateway}` : 'No router');
  }
  if (Iface.MAC) Parts.push(Iface.MAC);
  return Parts.join(' · ');
}

export type NetworkInterfaceState =
  'internal' | 'healthy' | 'issue' | 'missing' | 'absent' | 'unreported' | 'plain';

/** The badge the critical toggle shows, and what clicking it will do. */
export function NetworkInterfaceBadge(Iface: NetworkInterfaceView): {
  State: NetworkInterfaceState;
  Label: string;
  Icon: string;
  Title: string;
} {
  if (Iface.Internal && !Iface.IsCritical) {
    return {
      State: 'internal',
      Label: 'Internal',
      Icon: 'bi-slash-circle',
      Title: 'Internal interfaces cannot be monitored',
    };
  }
  if (!Iface.IsCritical) {
    return {
      State: 'plain',
      Label: 'Critical',
      Icon: 'bi-check-circle',
      Title: 'Mark as critical',
    };
  }
  if (Iface.Missing) {
    return {
      State: 'missing',
      Label: 'Missing',
      Icon: 'bi-x-circle-fill',
      Title: 'Remove critical status (interface not connected)',
    };
  }
  if (!Iface.IsConnected) {
    // Not reported, and either not judged yet or allowed to be absent.
    const Absent = Iface.Critical && !Iface.Critical.RequirePresent;
    return {
      State: Absent ? 'absent' : 'unreported',
      Label: 'Critical',
      Icon: 'bi-question-circle',
      Title: Absent
        ? 'Remove critical status (not connected, which is allowed)'
        : 'Remove critical status (not reported yet)',
    };
  }
  if (Iface.Issues.length) {
    return {
      State: 'issue',
      Label: 'Changed',
      Icon: 'bi-exclamation-triangle-fill',
      Title: 'Remove critical status (conditions not met)',
    };
  }
  return {
    State: 'healthy',
    Label: 'Critical',
    Icon: 'bi-check-circle-fill',
    Title: 'Remove critical status',
  };
}

// --- Conditions -----------------------------------------------------------------

/** A condition a critical interface can be held to, as its form field is named. */
export type NetworkConditionField = 'RequirePresent' | 'Address' | 'Range' | 'Netmask' | 'Gateway';

/** One row of a critical interface's conditions table. */
export interface NetworkConditionRow {
  Field: NetworkConditionField;
  Label: string;
  /** Whether the row takes typed values (all but presence do). */
  Editable: boolean;
  /** What the interface reports now ("Yes", "10.0.0.5", "—"), or "Unsupported". */
  Value: string;
  /** The guarded value(s): one for most rows, start and end for the range. */
  Expected: string[];
  /** What ticking an empty row fills in: the interface's current value(s). */
  Defaults: string[];
  /** Whether this interface can be held to it. A condition already set always is, so it can be cleared. */
  Supported: boolean;
  /** Whether the condition is being monitored. */
  Checked: boolean;
  /** The issue this condition currently raises, when it is not met. */
  Failing: string | null;
}

/**
 * The conditions table of a critical interface, one row per condition. Values
 * describe the interface's primary address (its first IPv4, else IPv6), which is
 * what a first mark captured.
 */
export function NetworkConditionRows(
  Iface: NetworkInterfaceView,
  Capabilities: NetworkCapabilities | null
): NetworkConditionRow[] {
  const Critical = Iface.Critical;
  if (!Critical) return [];
  const Issue = (Kind: string) =>
    Iface.Issues.find((Candidate) => Candidate.Kind === Kind)?.Message ?? null;
  const Primary = Iface.IsConnected ? PrimaryAddress(Iface) : null;
  const Address = Primary ? String(Primary.address) : '';
  const Netmask = Primary && Primary.netmask ? String(Primary.netmask) : '';
  const Range = Primary ? SubnetHostRange(Primary.address, Primary.netmask) : null;
  const Gateway = Iface.IsConnected && Iface.Gateway ? Iface.Gateway : '';
  const RouterSupported = !!Capabilities?.Router || Critical.Gateway !== null;
  const Dash = (Value: string) => Value || '—';
  return [
    {
      Field: 'RequirePresent',
      Label: 'Present',
      Editable: false,
      Value: Iface.IsConnected ? 'Yes' : 'No',
      Expected: [],
      Defaults: [],
      Supported: true,
      Checked: Critical.RequirePresent,
      Failing: Issue('missing'),
    },
    {
      Field: 'Address',
      Label: 'IP address',
      Editable: true,
      Value: Dash(Address),
      Expected: Critical.Address ? [Critical.Address] : [],
      Defaults: [Address],
      Supported: true,
      Checked: Critical.Address !== null,
      Failing: Issue('address'),
    },
    {
      Field: 'Range',
      Label: 'IP range',
      Editable: true,
      Value: Dash(Address),
      Expected:
        Critical.RangeStart && Critical.RangeEnd ? [Critical.RangeStart, Critical.RangeEnd] : [],
      Defaults: Range ? [Range.Start, Range.End] : ['', ''],
      Supported: true,
      Checked: Critical.RangeStart !== null && Critical.RangeEnd !== null,
      Failing: Issue('range'),
    },
    {
      Field: 'Netmask',
      Label: 'Subnet mask',
      Editable: true,
      Value: Dash(Netmask),
      Expected: Critical.Netmask ? [Critical.Netmask] : [],
      Defaults: [Netmask],
      Supported: true,
      Checked: Critical.Netmask !== null,
      Failing: Issue('netmask'),
    },
    {
      Field: 'Gateway',
      Label: 'Router',
      Editable: true,
      Value: RouterSupported ? Dash(Gateway) : 'Unsupported',
      Expected: Critical.Gateway ? [Critical.Gateway] : [],
      Defaults: [Gateway],
      Supported: RouterSupported,
      Checked: Critical.Gateway !== null,
      Failing: Issue('gateway'),
    },
  ];
}

/**
 * Rebuild the list only when what it shows changes. The conditions hold typed
 * values, so the modal also holds a rebuild while one of them has focus.
 */
export function NetworkRenderKey(
  Client: ClientView,
  State: NetworkSectionState,
  Family: NetworkFamily
): string {
  const View = Client.NetworkStatus;
  const Interfaces = VisibleInterfaces(Client).map((Iface) =>
    [
      Iface.Name,
      Iface.MAC ?? '',
      Iface.Internal ? 1 : 0,
      Iface.IsConnected ? 1 : 0,
      Iface.Missing ? 1 : 0,
      Iface.Gateway ?? '',
      AddressesFor(Iface, Family)
        .map((Address) => `${FormatAddress(Address)}/${Address.netmask ?? ''}`)
        .join(','),
      // The primary address feeds the conditions' current values, whatever the filter.
      PrimaryAddress(Iface)?.address ?? '',
      Iface.Issues.map((Issue) => Issue.Message).join(','),
      JSON.stringify(Iface.Critical),
    ].join('|')
  );
  return `${Client.UUID}::${State}::${Family}::${JSON.stringify(View?.Capabilities ?? null)}::${Interfaces.join(';;')}`;
}

/** The fields of a critical interface's conditions form, as read from the DOM. */
export interface NetworkRuleFields {
  RequirePresent: boolean;
  /** Empty strings for an unticked row. */
  Address: string;
  RangeStart: string;
  RangeEnd: string;
  Netmask: string;
  Gateway: string;
}

export interface NetworkRulePayload {
  Name: string;
  RequirePresent: boolean;
  Address: string | null;
  RangeStart: string | null;
  RangeEnd: string | null;
  Netmask: string | null;
  Gateway: string | null;
}

/** Turn the conditions form into a request, or say what is wrong with it. */
export function ParseNetworkRuleFields(
  Name: string,
  Fields: NetworkRuleFields
): { Payload: NetworkRulePayload } | { Error: string } {
  const Address = (Raw: string, What: string): string | null | { Error: string } => {
    const Trimmed = String(Raw ?? '').trim();
    if (!Trimmed) return null;
    if (!ParseIP(Trimmed)) return { Error: `${What} "${Trimmed}" is not an IP address` };
    return Trimmed;
  };
  const Values: Record<string, string | null> = {};
  for (const [Key, What] of [
    ['Address', 'IP address'],
    ['RangeStart', 'Range start'],
    ['RangeEnd', 'Range end'],
    ['Netmask', 'Subnet mask'],
    ['Gateway', 'Router'],
  ] as const) {
    const Parsed = Address(Fields[Key], What);
    if (Parsed && typeof Parsed === 'object') return Parsed;
    Values[Key] = Parsed;
  }
  if (!!Values.RangeStart !== !!Values.RangeEnd) {
    return { Error: 'An IP range needs both a start and an end' };
  }
  if (Values.RangeStart && Values.RangeEnd) {
    const Start = ParseIP(Values.RangeStart)!;
    const End = ParseIP(Values.RangeEnd)!;
    if (Start.Family !== End.Family) {
      return { Error: 'Both ends of an IP range must be the same kind of address' };
    }
    if (Start.Value > End.Value)
      return { Error: 'The start of an IP range cannot be after its end' };
  }
  return {
    Payload: {
      Name,
      RequirePresent: !!Fields.RequirePresent,
      Address: Values.Address ?? null,
      RangeStart: Values.RangeStart ?? null,
      RangeEnd: Values.RangeEnd ?? null,
      Netmask: Values.Netmask ?? null,
      Gateway: Values.Gateway ?? null,
    },
  };
}

/**
 * The live state of a critical interface's history row: green while connected
 * and meeting its conditions, orange while connected but not, red while missing.
 * Idle while the client is offline, the interface has not been judged yet, or it
 * is absent and allowed to be.
 */
export function NetworkTimelineLiveState(
  Iface: NetworkInterfaceView,
  Online: boolean
): { State: 'IDLE' | 'ONLINE' | 'DEGRADED' | 'OFFLINE'; Label: string } {
  if (!Online) return { State: 'IDLE', Label: 'Idle' };
  if (Iface.Missing) return { State: 'OFFLINE', Label: 'Missing' };
  if (!Iface.IsConnected) return { State: 'IDLE', Label: 'Not Connected' };
  if (Iface.Issues.length) {
    return { State: 'DEGRADED', Label: Iface.Issues.map((Issue) => Issue.Message).join('; ') };
  }
  return { State: 'ONLINE', Label: 'Connected' };
}
