// Status changes for the audit log (pure).
//
// What is logged is deliberately narrow: each entity's top-level state
// (connected/online, offline, degraded, recovered), and the things an operator
// has chosen to monitor on it — monitored USB devices, displays, audio
// endpoints, network interfaces and applications, system checks, FreeKiosk
// metric alarms and a monitor's checks. Unmonitored hardware coming and going
// is not, and neither is a heartbeat.
//
// Every function here compares a fresh snapshot with what was seen last time
// and returns the entries to write plus the state to keep. Nothing reads the
// clock or the managers, so each transition is testable on its own.
import type { AuditRecordInput } from './index';
import { Device, Entity, Line, Value } from './message';
import type { SummaryPart } from './message';
import { DescribeUSBLocation } from '../ClientManager/usb';
import { SYSTEM_CHECK_WARNINGS } from '../ClientManager/system-checks';

// ---- Shared ------------------------------------------------------------------

type Entry = AuditRecordInput;

interface ItemState {
  Name: string;
  Connected: boolean;
  // Where or how it is attached: a USB port, a display mode, an address. A
  // change while it stays connected is news of its own.
  Position: string | null;
  // The monitored conditions it currently breaks, as operator-facing sentences.
  Issues: string[];
  // Extra context for a disconnect ("1 of 2 connected").
  Note: string | null;
}

type ItemMap = Map<string, ItemState>;

interface DomainWords {
  Up: string;
  Down: string;
  // Not there the first time it is seen (nothing to say it ever was).
  Absent: string;
  // A Position change while connected.
  Moved: (From: string | null, To: string | null) => { Parts: SummaryPart[]; Details: string[] };
}

function Text(Value: unknown): string {
  return Value === null || Value === undefined ? '' : String(Value).trim();
}

function Unique(Values: string[]): string[] {
  return [...new Set(Values.filter(Boolean))];
}

function IssueMessages(Issues: unknown): string[] {
  if (!Array.isArray(Issues)) return [];
  // Presence is the item's own Connected state, logged as a connect or a
  // disconnect, so a "missing" issue would only say it a second time.
  return Unique(
    Issues.filter((Issue) => Issue && Issue.Kind !== 'missing').map((Issue) => Text(Issue.Message))
  );
}

// Compare one domain's monitored items. `Previous` null means this domain has
// never been judged for this entity: only faults are reported then, since an
// item that is fine was not "connected" just now — it always was.
function DiffItems(
  Previous: ItemMap | null,
  Next: ItemMap,
  Words: DomainWords,
  Base: Omit<Entry, 'Summary' | 'Category'>
): Entry[] {
  const Entries: Entry[] = [];
  const Push = (Severity: Entry['Severity'], Parts: SummaryPart[], Details: string[] = []) =>
    Entries.push({ ...Base, Category: 'status', Severity, Summary: Line(...Parts), Details });

  for (const [Key, Item] of Next) {
    const Before = Previous ? Previous.get(Key) : undefined;
    const Name = Device(Item.Name);
    if (!Before) {
      // First sight of it: a first report, or newly monitored (the mark itself
      // is logged as an edit). Only a fault is news then.
      if (!Item.Connected)
        Push('warning', [Name, ` ${Words.Absent}`], Item.Note ? [Item.Note] : []);
      else if (Item.Issues.length) Push('warning', [Name, ' has an issue'], Item.Issues);
      continue;
    }
    const Added = Item.Issues.filter((Issue) => !Before.Issues.includes(Issue));
    const Cleared = Before.Issues.filter((Issue) => !Item.Issues.includes(Issue));
    const Context = [...Added, ...Cleared.map((Issue) => `Resolved: ${Issue}`)];

    if (Before.Connected && !Item.Connected) {
      Push('warning', [Name, ` ${Words.Down}`], Item.Note ? [Item.Note] : []);
      continue;
    }
    if (!Before.Connected && Item.Connected) {
      const Moved =
        Before.Position && Item.Position && Before.Position !== Item.Position
          ? [`Now at ${Item.Position} (was ${Before.Position})`]
          : [];
      Push(Added.length ? 'warning' : 'success', [Name, ` ${Words.Up}`], [...Moved, ...Context]);
      continue;
    }
    if (Item.Connected && Before.Position !== Item.Position && Before.Position && Item.Position) {
      const Moved = Words.Moved(Before.Position, Item.Position);
      Push(
        Added.length ? 'warning' : 'info',
        [Name, ...Moved.Parts],
        [...Moved.Details, ...Context]
      );
      continue;
    }
    for (const Issue of Added) Push('warning', [Name, ': ', Issue]);
    if (Cleared.length && !Item.Issues.length) {
      Push(
        'success',
        [Name, ' back to normal'],
        Cleared.map((Issue) => `Resolved: ${Issue}`)
      );
    } else {
      for (const Issue of Cleared) Push('success', [Name, ' resolved: ', Issue]);
    }
  }
  return Entries;
}

const ATTACHED_WORDS = { Up: 'Reconnected', Down: 'Disconnected', Absent: 'Not Connected' };

const USB_WORDS: DomainWords = {
  ...ATTACHED_WORDS,
  Moved: (From, To) => ({ Parts: [' moved from ', Value(From), ' → ', Value(To)], Details: [] }),
};

const DISPLAY_WORDS: DomainWords = {
  ...ATTACHED_WORDS,
  Moved: (From, To) => ({ Parts: [' configuration changed'], Details: [`${From} → ${To}`] }),
};

const AUDIO_WORDS: DomainWords = {
  ...ATTACHED_WORDS,
  Moved: () => ({ Parts: [' changed'], Details: [] }),
};

const NETWORK_WORDS: DomainWords = {
  ...ATTACHED_WORDS,
  Moved: (From, To) => ({
    Parts: [' address changed from ', Value(From), ' → ', Value(To)],
    Details: [],
  }),
};

const APPLICATION_WORDS: DomainWords = {
  Up: 'Started',
  Down: 'Stopped',
  Absent: 'Not Running',
  Moved: () => ({ Parts: [' changed'], Details: [] }),
};

// ---- ShowTrak clients --------------------------------------------------------

// The slice of a Client this reads. It is handed the live instance, so every
// field is read once, synchronously, and never kept.
export interface ClientStatusLike {
  UUID?: unknown;
  Nickname?: unknown;
  Hostname?: unknown;
  Unassigned?: unknown;
  Online?: unknown;
  Degraded?: unknown;
  DegradedWarnings?: unknown;
  Initialising?: unknown;
  HasUSBTelemetry?: unknown;
  HasDisplayTelemetry?: unknown;
  HasAudioTelemetry?: unknown;
  HasNetworkTelemetry?: unknown;
  HasApplicationTelemetry?: unknown;
  USBDeviceList?: unknown;
  DisplayList?: unknown;
  AudioDevices?: { Endpoints?: unknown } | null;
  NetworkStatus?: { Interfaces?: unknown } | null;
  RunningApplications?: { Items?: unknown; Status?: { State?: unknown } | null } | null;
  ResourceAlarms?: unknown;
}

type ClientDomain = 'usb' | 'display' | 'audio' | 'network' | 'apps';

export interface ClientAuditState {
  Online: boolean;
  // Whether this server has seen it online before, so a return reads as a
  // reconnect rather than a first connection.
  EverOnline: boolean;
  Degraded: boolean;
  // Kept across a disconnect, so a device unplugged while the machine was down
  // is reported once it reconnects and reports again.
  Domains: Partial<Record<ClientDomain, ItemMap>>;
  Alarms: Map<string, string>;
}

type Row = Record<string, unknown>;

function Rows(List: unknown): Row[] {
  return Array.isArray(List)
    ? (List.filter((Item) => Item && typeof Item === 'object') as Row[])
    : [];
}

function USBItems(List: unknown): ItemMap {
  const Items: ItemMap = new Map();
  const Groups = new Map<string, { Name: string; Rows: Row[] }>();
  for (const Entry of Rows(List)) {
    if (!Entry.IsCritical) continue;
    const Name =
      Text(Entry.ProductName) ||
      Text(Entry.ManufacturerName) ||
      Text(Entry.SerialNumber) ||
      'USB Device';
    if (Entry.IsCriticalByName) {
      const Key = `name:${Text(Entry.NameKey) || Name.toLowerCase()}`;
      const Group = Groups.get(Key) || { Name, Rows: [] };
      Group.Rows.push(Entry);
      Groups.set(Key, Group);
      continue;
    }
    const Serial = Text(Entry.SerialNumber).toUpperCase();
    if (!Serial) continue;
    const Location = Text(Entry.Location);
    Items.set(`serial:${Serial}`, {
      Name,
      Connected: !!Entry.IsConnected,
      Position: Entry.IsConnected && Location ? DescribeUSBLocation(Location) : null,
      Issues: IssueMessages(Entry.Issues),
      Note: null,
    });
  }
  // A name group is one monitored item however many devices it counts: it is
  // connected while it has its full quantity.
  for (const [Key, Group] of Groups) {
    const First = Group.Rows[0]!;
    const Quantity = Math.max(1, Number(First.Quantity) || 1);
    const Count = Math.max(0, Number(First.ConnectedCount) || 0);
    const Locations = Group.Rows.filter((Entry) => Entry.IsConnected && Text(Entry.Location))
      .map((Entry) => DescribeUSBLocation(Text(Entry.Location)))
      .sort();
    Items.set(Key, {
      Name: Group.Name,
      Connected: Count >= Quantity,
      Position: Locations.length ? Locations.join(', ') : null,
      Issues: Unique(Group.Rows.flatMap((Entry) => IssueMessages(Entry.Issues))),
      Note: Quantity > 1 ? `${Count} of ${Quantity} connected` : null,
    });
  }
  return Items;
}

export function DescribeDisplayMode(Display: Row): string | null {
  const Width = Number(Display.Width);
  const Height = Number(Display.Height);
  if (!Number.isFinite(Width) || !Number.isFinite(Height) || Width <= 0 || Height <= 0) return null;
  const Parts = [`${Width}×${Height}`];
  const Refresh = Number(Display.RefreshRate);
  if (Display.RefreshRate !== null && Number.isFinite(Refresh) && Refresh > 0) {
    Parts[0] += ` @ ${Math.round(Refresh)} Hz`;
  }
  const Scale = Number(Display.ScaleFactor);
  if (Number.isFinite(Scale) && Scale > 0 && Scale !== 1) Parts.push(`${Scale}× scale`);
  const Rotation = Number(Display.Rotation);
  if (Number.isFinite(Rotation) && Rotation) Parts.push(`rotated ${Rotation}°`);
  if (Display.Primary) Parts.push('primary');
  const Bounds = Display.Bounds as Row | null | undefined;
  if (Bounds && Number.isFinite(Number(Bounds.x)) && Number.isFinite(Number(Bounds.y))) {
    Parts.push(`at ${Number(Bounds.x)},${Number(Bounds.y)}`);
  }
  return Parts.join(', ');
}

function DisplayItems(List: unknown): ItemMap {
  const Items: ItemMap = new Map();
  for (const Entry of Rows(List)) {
    if (!Entry.IsCritical) continue;
    const Critical = (Entry.Critical || null) as Row | null;
    const Key = Text(Critical && Critical.DisplayID) || Text(Entry.DisplayID);
    if (!Key) continue;
    const Screen = Number(Entry.ScreenNumber);
    Items.set(Key, {
      Name:
        Text(Entry.Label) ||
        Text(Critical && Critical.Label) ||
        (Number.isFinite(Screen) && Screen > 0 ? `Display ${Screen}` : 'Display'),
      Connected: !!Entry.IsConnected,
      Position: Entry.IsConnected ? DescribeDisplayMode(Entry) : null,
      Issues: IssueMessages(Entry.Issues),
      Note: null,
    });
  }
  return Items;
}

function AudioItems(List: unknown): ItemMap {
  const Items: ItemMap = new Map();
  for (const Entry of Rows(List)) {
    if (!Entry.IsCritical) continue;
    const Critical = (Entry.Critical || null) as Row | null;
    const Key = Text(Critical && Critical.EndpointID) || Text(Entry.EndpointID);
    if (!Key) continue;
    Items.set(Key, {
      Name: Text(Entry.Name) || Text(Critical && Critical.Name) || 'Audio Device',
      Connected: !!Entry.IsConnected,
      Position: null,
      Issues: IssueMessages(Entry.Issues),
      Note: null,
    });
  }
  return Items;
}

function NetworkItems(List: unknown): ItemMap {
  const Items: ItemMap = new Map();
  for (const Entry of Rows(List)) {
    if (!Entry.IsCritical) continue;
    const Name = Text(Entry.Name);
    if (!Name) continue;
    const Addresses = Rows(Entry.Addresses)
      .filter((Address) => !Address.internal && String(Address.family).includes('4'))
      .map((Address) => Text(Address.address))
      .filter(Boolean)
      .sort();
    Items.set(Name, {
      Name,
      Connected: !!Entry.IsConnected,
      Position: Entry.IsConnected && Addresses.length ? Addresses.join(', ') : null,
      Issues: IssueMessages(Entry.Issues),
      Note: null,
    });
  }
  return Items;
}

function ApplicationItems(List: unknown): ItemMap {
  const Items: ItemMap = new Map();
  for (const Entry of Rows(List)) {
    if (!Entry.IsCritical) continue;
    const Name = Text(Entry.Name);
    const Key = Text(Entry.Key) || Name.toLowerCase();
    if (!Key) continue;
    const Running = !!Entry.IsRunning;
    const Issues: string[] = [];
    if (Running && Entry.RequireResponding && Entry.Responding === false)
      Issues.push('Not Responding');
    if (Running && Entry.RequireForeground && Entry.IsForeground === false) {
      Issues.push('Not in the foreground');
    }
    Items.set(Key, { Name: Name || Key, Connected: Running, Position: null, Issues, Note: null });
  }
  return Items;
}

const ALARM_UNITS: Record<string, string> = {
  cpu: '%',
  ram: '%',
  battery: '%',
  temperature: '°C',
  uptime: ' hours',
};

function FormatReading(Key: string, Reading: unknown): string | null {
  if (Reading === null || Reading === undefined || Reading === '') return null;
  const Number_ = Number(Reading);
  if (typeof Reading === 'number' || (typeof Reading === 'string' && Number.isFinite(Number_))) {
    const Rounded = Math.round(Number_ * 10) / 10;
    return `${Rounded}${ALARM_UNITS[Key] || ''}`;
  }
  return String(Reading);
}

function AlarmMap(List: unknown): Map<string, Row> {
  const Alarms = new Map<string, Row>();
  for (const Alarm of Rows(List)) {
    const Key = Text(Alarm.Key);
    if (Key) Alarms.set(Key, Alarm);
  }
  return Alarms;
}

export function ClientDisplayName(Client: {
  Nickname?: unknown;
  Hostname?: unknown;
  UUID?: unknown;
}) {
  return Text(Client.Nickname) || Text(Client.Hostname) || Text(Client.UUID);
}

export function NewClientAuditState(): ClientAuditState {
  return { Online: false, EverOnline: false, Degraded: false, Domains: {}, Alarms: new Map() };
}

export function DiffClientStatus(
  Previous: ClientAuditState | undefined,
  Client: ClientStatusLike
): { State: ClientAuditState; Entries: Entry[] } {
  const State: ClientAuditState = Previous
    ? { ...Previous, Domains: { ...Previous.Domains }, Alarms: new Map(Previous.Alarms) }
    : NewClientAuditState();
  const Entries: Entry[] = [];
  const UUID = Text(Client.UUID);
  if (!UUID || Client.Unassigned) return { State, Entries };
  const Name = ClientDisplayName(Client);
  const Base = { EntityType: 'client' as const, EntityID: UUID, EntityName: Name };
  const Say = (Severity: Entry['Severity'], Parts: SummaryPart[], Details: string[] = []) =>
    Entries.push({ ...Base, Category: 'status', Severity, Summary: Line(...Parts), Details });

  const Online = !!Client.Online;
  if (!Online) {
    if (State.Online) Say('warning', [Entity(Name), ' Disconnected']);
    // A disconnect stands every alarm down (the client re-proves them once it
    // is back) and ends any degraded state, so neither is "recovered" later.
    State.Online = false;
    State.Degraded = false;
    State.Alarms = new Map();
    return { State, Entries };
  }
  if (!State.Online) {
    Say('success', [Entity(Name), State.EverOnline ? ' Reconnected' : ' Connected']);
    State.Online = true;
    State.EverOnline = true;
  }

  // Inside the start-up window the client holds what it infers as faults, and
  // so does the log: a device still enumerating is not a disconnect. The diff
  // happens once the window publishes its verdict.
  if (Client.Initialising) return { State, Entries };

  const Domains: Array<[ClientDomain, boolean, () => ItemMap, DomainWords]> = [
    ['usb', !!Client.HasUSBTelemetry, () => USBItems(Client.USBDeviceList), USB_WORDS],
    [
      'display',
      !!Client.HasDisplayTelemetry,
      () => DisplayItems(Client.DisplayList),
      DISPLAY_WORDS,
    ],
    [
      'audio',
      !!Client.HasAudioTelemetry,
      () => AudioItems(Client.AudioDevices && Client.AudioDevices.Endpoints),
      AUDIO_WORDS,
    ],
    [
      'network',
      !!Client.HasNetworkTelemetry,
      () => NetworkItems(Client.NetworkStatus && Client.NetworkStatus.Interfaces),
      NETWORK_WORDS,
    ],
    [
      'apps',
      !!Client.HasApplicationTelemetry &&
        Text(Client.RunningApplications?.Status?.State).toLowerCase() === 'ok',
      () => ItemsOrEmpty(() => ApplicationItems(Client.RunningApplications?.Items)),
      APPLICATION_WORDS,
    ],
  ];
  for (const [Domain, Trusted, Read, Words] of Domains) {
    // Until the domain is reported on this connection its list says nothing.
    if (!Trusted) continue;
    const Next = Read();
    Entries.push(...DiffItems(State.Domains[Domain] || null, Next, Words, Base));
    State.Domains[Domain] = Next;
  }

  const Alarms = AlarmMap(Client.ResourceAlarms);
  for (const [Key, Alarm] of Alarms) {
    if (State.Alarms.has(Key)) continue;
    const Label = SYSTEM_CHECK_WARNINGS[Key as keyof typeof SYSTEM_CHECK_WARNINGS] || Key;
    const Reading = FormatReading(Key, Alarm.Value);
    const Limit = FormatReading(Key, Alarm.Threshold);
    Say(
      'warning',
      [Device(Label)],
      [Reading && Limit ? `${Reading} (limit ${Limit})` : Reading || ''].filter(Boolean)
    );
  }
  for (const [Key, Label] of State.Alarms) {
    if (!Alarms.has(Key)) Say('success', [Device(Label), ' cleared']);
  }
  State.Alarms = new Map(
    [...Alarms.keys()].map((Key) => [
      Key,
      SYSTEM_CHECK_WARNINGS[Key as keyof typeof SYSTEM_CHECK_WARNINGS] || Key,
    ])
  );

  const Degraded = !!Client.Degraded;
  if (Degraded && !State.Degraded) {
    Say('warning', [Entity(Name), ' Degraded'], Unique(StringList(Client.DegradedWarnings)));
  } else if (!Degraded && State.Degraded) {
    Say('success', [Entity(Name), ' Recovered']);
  }
  State.Degraded = Degraded;
  return { State, Entries };
}

function ItemsOrEmpty(Read: () => ItemMap): ItemMap {
  try {
    return Read();
  } catch {
    return new Map();
  }
}

function StringList(Value: unknown): string[] {
  return Array.isArray(Value) ? Value.map(Text).filter(Boolean) : [];
}

// ---- Dummy clients -------------------------------------------------------------

export interface DummyStatusLike {
  UUID?: unknown;
  Nickname?: unknown;
  DummyID?: unknown;
  State?: unknown;
  DegradedWarnings?: unknown;
}

// A dummy's state machine: IDLE (never heard from, or reset), ONLINE,
// DEGRADED (one heartbeat missed), OFFLINE. Idle is not news: it is either
// where it starts or the result of a reset, which is logged as the action.
export function DiffDummyStatus(
  Previous: string | undefined,
  Dummy: DummyStatusLike
): { State: string; Entries: Entry[] } {
  const State = Text(Dummy.State).toUpperCase() || 'IDLE';
  const Before = Previous || 'IDLE';
  const UUID = Text(Dummy.UUID);
  if (!UUID || State === Before || State === 'IDLE') return { State, Entries: [] };
  const Name = Text(Dummy.Nickname) || Text(Dummy.DummyID) || UUID;
  const Entry = (Severity: Entry['Severity'], Word: string, Details: string[] = []): Entry => ({
    EntityType: 'dummy',
    EntityID: UUID,
    EntityName: Name,
    Category: 'status',
    Severity,
    Summary: Line(Entity(Name), ` ${Word}`),
    Details,
  });
  if (State === 'ONLINE') {
    return { State, Entries: [Entry('success', Before === 'DEGRADED' ? 'Recovered' : 'Online')] };
  }
  if (State === 'DEGRADED') {
    return { State, Entries: [Entry('warning', 'Degraded', StringList(Dummy.DegradedWarnings))] };
  }
  if (State === 'OFFLINE') return { State, Entries: [Entry('error', 'Offline')] };
  return { State, Entries: [] };
}

// ---- FreeKiosk terminals ---------------------------------------------------------

export interface FreeKioskStatusLike {
  UUID?: unknown;
  Nickname?: unknown;
  Hostname?: unknown;
  State?: unknown;
  Online?: unknown;
  Degraded?: unknown;
  Alarms?: unknown;
  LastError?: unknown;
}

export interface FreeKioskAuditState {
  Online: boolean;
  Degraded: boolean;
  Alarms: Map<string, string>;
}

export function DiffFreeKioskStatus(
  Previous: FreeKioskAuditState | undefined,
  Terminal: FreeKioskStatusLike
): { State: FreeKioskAuditState | undefined; Entries: Entry[] } {
  const UUID = Text(Terminal.UUID);
  // IDLE: never polled yet, so nothing is known.
  if (!UUID || Text(Terminal.State).toUpperCase() === 'IDLE')
    return { State: Previous, Entries: [] };
  const Name = Text(Terminal.Nickname) || Text(Terminal.Hostname) || UUID;
  const Entries: Entry[] = [];
  const Say = (Severity: Entry['Severity'], Parts: SummaryPart[], Details: string[] = []) =>
    Entries.push({
      EntityType: 'freekiosk',
      EntityID: UUID,
      EntityName: Name,
      Category: 'status',
      Severity,
      Summary: Line(...Parts),
      Details,
    });
  const Online = !!Terminal.Online;
  const State: FreeKioskAuditState = Previous
    ? { ...Previous, Alarms: new Map(Previous.Alarms) }
    : { Online: !Online, Degraded: false, Alarms: new Map() };

  if (!Online) {
    if (State.Online || !Previous) {
      Say('error', [Entity(Name), ' Offline'], [Text(Terminal.LastError)].filter(Boolean));
    }
    // An unreachable terminal reports no metrics, so its alarms are frozen
    // until it answers again and are judged against that reading.
    State.Online = false;
    return { State, Entries };
  }
  if (!State.Online) Say('success', [Entity(Name), Previous ? ' Back Online' : ' Online']);
  State.Online = true;

  const Alarms = new Map<string, Row>();
  for (const Alarm of Rows(Terminal.Alarms)) {
    const Key = Text(Alarm.Key);
    if (Key) Alarms.set(Key, Alarm);
  }
  for (const [Key, Alarm] of Alarms) {
    if (State.Alarms.has(Key)) continue;
    Say('warning', [Device(Text(Alarm.Label) || Key)], [Text(Alarm.Reason)].filter(Boolean));
  }
  for (const [Key, Label] of State.Alarms) {
    if (!Alarms.has(Key)) Say('success', [Device(Label), ' back to normal']);
  }
  State.Alarms = new Map([...Alarms].map(([Key, Alarm]) => [Key, Text(Alarm.Label) || Key]));

  const Degraded = !!Terminal.Degraded;
  if (Degraded && !State.Degraded) Say('warning', [Entity(Name), ' Degraded']);
  else if (!Degraded && State.Degraded) Say('success', [Entity(Name), ' Recovered']);
  State.Degraded = Degraded;
  return { State, Entries };
}

// ---- Monitors ----------------------------------------------------------------------

export interface MonitorStatusLike {
  TargetID?: unknown;
  Nickname?: unknown;
  Address?: unknown;
  Online?: unknown;
  Degraded?: unknown;
  LastChecked?: unknown;
  LastError?: unknown;
  Checks?: unknown;
}

interface Verdict {
  Online: boolean;
  Degraded: boolean;
}

export interface MonitorAuditState {
  Target: Verdict | null;
  Checks: Map<string, Verdict>;
}

function VerdictWord(Before: Verdict | null, After: Verdict): [Entry['Severity'], string] | null {
  if (!After.Online) return Before && !Before.Online ? null : ['error', 'Offline'];
  if (After.Degraded)
    return Before && Before.Online && Before.Degraded ? null : ['warning', 'Degraded'];
  if (!Before) return ['success', 'Online'];
  if (!Before.Online) return ['success', 'Back Online'];
  if (Before.Degraded) return ['success', 'Recovered'];
  return null;
}

export function MonitorDisplayName(Target: MonitorStatusLike): string {
  return Text(Target.Nickname) || Text(Target.Address) || `Monitor ${Text(Target.TargetID)}`;
}

export function DiffMonitorStatus(
  Previous: MonitorAuditState | undefined,
  Target: MonitorStatusLike
): { State: MonitorAuditState; Entries: Entry[] } {
  const State: MonitorAuditState = Previous
    ? { Target: Previous.Target, Checks: new Map(Previous.Checks) }
    : { Target: null, Checks: new Map() };
  const Entries: Entry[] = [];
  const TargetID = Text(Target.TargetID);
  if (!TargetID) return { State, Entries };
  const Name = MonitorDisplayName(Target);
  const Say = (Severity: Entry['Severity'], Parts: SummaryPart[], Details: string[] = []) =>
    Entries.push({
      EntityType: 'monitor',
      EntityID: TargetID,
      EntityName: Name,
      Category: 'status',
      Severity,
      Summary: Line(...Parts),
      Details,
    });

  // Checks first: a check going down is why its monitor turns degraded.
  const Live = new Set<string>();
  for (const Check of Rows(Target.Checks)) {
    const CheckID = Text(Check.CheckID);
    if (!CheckID) continue;
    Live.add(CheckID);
    if (Check.LastChecked === null || Check.LastChecked === undefined) continue;
    const After: Verdict = { Online: !!Check.Online, Degraded: !!Check.Degraded };
    const Before = State.Checks.get(CheckID) || null;
    State.Checks.set(CheckID, After);
    // A check's first verdict is only news when it is a fault; the monitor's
    // own first verdict below already says it is being watched.
    if (!Before && After.Online && !After.Degraded) continue;
    const Word = VerdictWord(Before, After);
    if (!Word) continue;
    const CheckName = Text(Check.Name) || Text(Check.Method) || `Check ${CheckID}`;
    const Error = Word[0] === 'success' ? '' : Text(Check.LastError);
    Say(Word[0], [Device(CheckName), ` ${Word[1]}`], Error ? [Error] : []);
  }
  for (const CheckID of [...State.Checks.keys()])
    if (!Live.has(CheckID)) State.Checks.delete(CheckID);

  if (Target.LastChecked !== null && Target.LastChecked !== undefined) {
    const After: Verdict = { Online: !!Target.Online, Degraded: !!Target.Degraded };
    const Word = VerdictWord(State.Target, After);
    State.Target = After;
    if (Word) {
      const Error = Word[0] === 'success' ? '' : Text(Target.LastError);
      Say(Word[0], [Entity(Name), ` ${Word[1]}`], Error ? [Error] : []);
    }
  }
  return { State, Entries };
}
