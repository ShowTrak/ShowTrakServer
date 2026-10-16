// Blackmagic Design HyperDeck recorder check, over the HyperDeck Ethernet
// Protocol (TCP 9993). Built for the failure nobody notices until afterwards:
// "we didn't record the show" / "the card filled at the interval".
//
// One short-lived session per probe:
//   1. On connect the deck speaks first with an asynchronous banner,
//        500 connection info:
//        protocol version: 1.11
//        model: HyperDeck Studio HD Plus
//      (blank line). That banner fingerprints a HyperDeck — a bare open port
//      will not produce it. A deck already serving its maximum number of
//      clients sends `120 connection failed` instead and hangs up.
//   2. `device info`    -> 204: protocol version, model, slot count, software
//                          version, name (fields vary by model / firmware).
//   3. `transport info` -> 208: status (preview / stopped / play / forward /
//                          rewind / jog / shuttle / record), active slot id
//                          (`none` when there is no media), clip id, timecode.
//   4. `slot info` for each slot id 1..slot count -> 202: status (empty /
//                          mounting / error / mounted), volume name, recording
//                          time (seconds of record time left at the slot's
//                          format), video format.
//   5. `quit`, close.
// Every command is a query; nothing that changes deck state is ever sent. The
// parameterised `slot info` uses the multi-line form (`slot info:` / `slot id:
// 1` / blank line) because the manual lists `163 parameterized single line
// command not supported` as a reply some decks give to the one-line form.
//
// Replies are `NNN text:` + `key: value` lines + blank line, or a single
// `NNN text` line (`200 ok`, errors 100–199). 5xx messages are asynchronous and
// can arrive between a request and its reply; they are skipped, never taken as
// the answer. (This session never enables `notify`, so none are expected beyond
// the banner, but a deck is entitled to send them.)
//
// Assertions:
//   - RequireMedia (default ON): a recorder with no usable media is the fault
//     this check exists for, so it is on out of the box. Degraded when no slot
//     has media, the active slot is empty or in error, or any slot reports an
//     error. `mounting` is transitional and is not flagged on its own.
//   - CheckRecording (default OFF): many decks sit stopped between shows, so
//     "must be recording" is something the operator opts into for the show.
//   - CheckRecordTime (default OFF) + MinRecordMinutes (15): see
//     RemainingRecordTime below for why the default counts every mounted slot
//     rather than only the active one.
import { Manager as CacheManager } from '../CacheManager';
import { ReplyQueue, RunTcpSession, type TcpSession } from './_tcp-session';
import {
  BmdStatePill,
  IsRefusal,
  MonoRow,
  ParseBoolOrNull,
  ParseFields,
  ParseIntOrNull,
  ResolveSnapshotTtlMs,
  ResolveTimeoutMs,
  StringOrNull,
  StripCarriageReturns,
  TakeBlock,
  TimeoutSetting,
} from './_blackmagic-shared';
import { Card, Esc, FormatLatency, Note, Pill, Row, Rows, TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'hyperdeck';
const DEFAULT_PORT = 9993;
const DEFAULT_MIN_RECORD_MINUTES = 15;
// HyperDeck Extreme reports its CFast slots, the external USB-C drive and the
// cache; nothing ships with more than a handful. The cap only bounds a deck that
// reports a nonsense slot count — the Timeout budget bounds the rest.
const MAX_SLOTS = 8;
// A status conversation is a few hundred bytes; anything far beyond that is not
// a HyperDeck talking to us.
const MAX_BUFFER_CHARS = 256 * 1024;

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
    Key: 'RequireMedia',
    Label: 'Require media',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded when no slot has media, the active slot is empty, or any slot reports a media error.',
  },
  {
    Key: 'CheckRecording',
    Label: 'Check recording',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded unless the deck is recording. Enable it for the show, when the deck should be rolling.',
  },
  {
    Key: 'CheckRecordTime',
    Label: 'Check recording time left',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when the recording time left drops below the minimum.',
  },
  {
    Key: 'MinRecordMinutes',
    Label: 'Minimum recording time (minutes)',
    Type: 'number',
    Default: DEFAULT_MIN_RECORD_MINUTES,
    Min: 1,
    Max: 6000,
    VisibleWhen: { Key: 'CheckRecordTime', Equals: true },
  },
  {
    Key: 'RecordTimeScope',
    Label: 'Recording time counted from',
    Type: 'select',
    Default: 'all',
    Options: [
      { value: 'all', label: 'All mounted slots' },
      { value: 'active', label: 'Active slot only' },
    ],
    Advanced: true,
    VisibleWhen: { Key: 'CheckRecordTime', Equals: true },
    Note: 'HyperDeck continues recording on the next card when one fills, so the default adds up every mounted slot. Choose the active slot only to be warned before each card fills.',
  },
  TimeoutSetting(),
];

// --- Pure protocol helpers --------------------------------------------------

export interface HyperDeckMessage {
  Code: number;
  Text: string;
  Fields: Record<string, string>;
}

/** Parse one framed reply. Null when the header is not `NNN text` — not a HyperDeck. */
function ParseMessage(Header: string, Lines: string[]): HyperDeckMessage | null {
  const Match = Header.match(/^(\d{3})\s+(.*?):?$/);
  if (!Match || !Match[1]) return null;
  return { Code: Number(Match[1]), Text: (Match[2] || '').trim(), Fields: ParseFields(Lines) };
}

/** ReplyQueue predicate: length of the first complete reply in the buffer. */
function FrameReply(Buffered: string): number | null {
  const Taken = TakeBlock(Buffered, true);
  return Taken ? Taken.Consumed : null;
}

/** Turn the framed text the ReplyQueue hands back into a message. */
function DecodeReply(Raw: string): HyperDeckMessage | null {
  const Taken = TakeBlock(Raw, true);
  return Taken ? ParseMessage(Taken.Block.Header, Taken.Block.Lines) : null;
}

const IsAsync = (Code: number): boolean => Code >= 500 && Code <= 599;

export interface HyperDeckTransport {
  Status: string | null;
  Speed: number | null;
  SlotId: number | null;
  ClipId: number | null;
  Timecode: string | null;
  DisplayTimecode: string | null;
  VideoFormat: string | null;
  InputVideoFormat: string | null;
}

export function ParseTransport(Fields: Record<string, string>): HyperDeckTransport {
  return {
    Status: StringOrNull(Fields['status'])?.toLowerCase() ?? null,
    Speed: ParseIntOrNull(Fields['speed']),
    SlotId: ParseIntOrNull(Fields['slot id']),
    ClipId: ParseIntOrNull(Fields['clip id']),
    Timecode: StringOrNull(Fields['timecode']),
    DisplayTimecode: StringOrNull(Fields['display timecode']),
    VideoFormat: StringOrNull(Fields['video format']),
    InputVideoFormat: StringOrNull(Fields['input video format']),
  };
}

export interface HyperDeckSlot {
  Id: number;
  /** empty / mounting / error / mounted, or null when the deck refused the query. */
  Status: string | null;
  VolumeName: string | null;
  RecordingTimeSec: number | null;
  VideoFormat: string | null;
  SlotName: string | null;
  Blocked: boolean | null;
  /** The deck's error reply to `slot info`, e.g. `102 invalid value`. */
  Error: string | null;
}

export function ParseSlot(Id: number, Fields: Record<string, string>): HyperDeckSlot {
  return {
    // Prefer the id the deck reports; fall back to the one we asked about.
    Id: ParseIntOrNull(Fields['slot id']) ?? Id,
    Status: StringOrNull(Fields['status'])?.toLowerCase() ?? null,
    VolumeName: StringOrNull(Fields['volume name']),
    RecordingTimeSec: ParseIntOrNull(Fields['recording time']),
    VideoFormat: StringOrNull(Fields['video format']),
    SlotName: StringOrNull(Fields['slot name']),
    Blocked: ParseBoolOrNull(Fields['blocked']),
    Error: null,
  };
}

// --- One-connection status snapshot -----------------------------------------

export interface HyperDeckSnapshot {
  Reachable: boolean;
  Error?: string;
  LatencyMs?: number;
  /** The banner (or a 120 rejection) proved this is a HyperDeck. */
  IsHyperDeck: boolean;
  /** The deck answered `120 connection failed`: too many clients connected. */
  Rejected: boolean;
  Model: string | null;
  ProtocolVersion: string | null;
  SoftwareVersion: string | null;
  DeviceName: string | null;
  SlotCount: number | null;
  Transport: HyperDeckTransport | null;
  Slots: HyperDeckSlot[];
  /** Which step the time budget ran out in, when it did; null when complete. */
  Incomplete: string | null;
  /** Error replies to queries other than slot info (e.g. `transport info: 103 unsupported`). */
  QueryErrors: string[];
}

function EmptySnapshot(): HyperDeckSnapshot {
  return {
    Reachable: false,
    IsHyperDeck: false,
    Rejected: false,
    Model: null,
    ProtocolVersion: null,
    SoftwareVersion: null,
    DeviceName: null,
    SlotCount: null,
    Transport: null,
    Slots: [],
    Incomplete: null,
    QueryErrors: [],
  };
}

export async function QueryHyperDeck(
  Address: string,
  Port: number,
  TimeoutMs: number
): Promise<HyperDeckSnapshot> {
  const BudgetMs = Math.max(500, TimeoutMs | 0);
  const Snap = EmptySnapshot();
  const Queue = new ReplyQueue(MAX_BUFFER_CHARS);
  let ReceivedAny = false;
  let BannerAt: number | null = null;
  let Step = 'connection banner';

  const Failed = (Message: string): HyperDeckSnapshot => ({
    ...Snap,
    Reachable: false,
    Error: Message,
  });
  const Reached = (Session: TcpSession<HyperDeckSnapshot>): HyperDeckSnapshot => ({
    ...Snap,
    Reachable: true,
    LatencyMs: (BannerAt ?? Date.now()) - Session.StartedAt,
  });
  // The budget ran out (or the deck hung up) part-way. After a banner it is a
  // HyperDeck that did not finish answering; bytes without a banner are some
  // other service; silence is offline.
  const Unfinished = (
    Session: TcpSession<HyperDeckSnapshot>,
    SilentError: string
  ): HyperDeckSnapshot => {
    if (Snap.IsHyperDeck) return { ...Reached(Session), Incomplete: Step };
    if (ReceivedAny) return { ...Reached(Session), IsHyperDeck: false };
    return Failed(SilentError);
  };

  // Await the next synchronous reply, skipping asynchronous 5xx notifications.
  const NextReply = async (): Promise<HyperDeckMessage | null> => {
    for (;;) {
      const Message = DecodeReply(await Queue.Next(FrameReply));
      if (!Message) return null;
      if (!IsAsync(Message.Code)) return Message;
    }
  };

  const Converse = async (Session: TcpSession<HyperDeckSnapshot>): Promise<void> => {
    const Banner = DecodeReply(await Queue.Next(FrameReply));
    BannerAt = Date.now();
    if (Banner && Banner.Code === 120) {
      Snap.IsHyperDeck = true;
      Snap.Rejected = true;
      Session.Finish(Reached(Session));
      return;
    }
    if (!Banner || Banner.Code !== 500) {
      Session.Finish({ ...Reached(Session), IsHyperDeck: false });
      return;
    }
    Snap.IsHyperDeck = true;
    Snap.ProtocolVersion = StringOrNull(Banner.Fields['protocol version']);
    Snap.Model = StringOrNull(Banner.Fields['model']);

    // One query, one reply. A null reply (a line that is not a HyperDeck
    // message) leaves that part of the snapshot empty rather than guessing.
    const Ask = async (Name: string, Command: string): Promise<HyperDeckMessage | null> => {
      Step = Name;
      Session.Socket.write(Command);
      return NextReply();
    };

    const Device = await Ask('device info', 'device info\r\n');
    if (Device && Device.Code === 204) {
      Snap.ProtocolVersion =
        StringOrNull(Device.Fields['protocol version']) ?? Snap.ProtocolVersion;
      Snap.Model = StringOrNull(Device.Fields['model']) ?? Snap.Model;
      Snap.SoftwareVersion = StringOrNull(Device.Fields['software version']);
      Snap.DeviceName = StringOrNull(Device.Fields['name']);
      Snap.SlotCount = ParseIntOrNull(Device.Fields['slot count']);
    } else if (Device) {
      Snap.QueryErrors.push(`device info: ${Device.Code} ${Device.Text}`);
    }

    const Transport = await Ask('transport info', 'transport info\r\n');
    if (Transport && Transport.Code === 208) {
      Snap.Transport = ParseTransport(Transport.Fields);
    } else if (Transport) {
      Snap.QueryErrors.push(`transport info: ${Transport.Code} ${Transport.Text}`);
    }

    // Without a slot count (an older deck that refused `device info`), the
    // bare `slot info` still describes the active slot.
    const Count = Snap.SlotCount != null ? Math.max(0, Math.min(MAX_SLOTS, Snap.SlotCount)) : 0;
    const Ids = Count > 0 ? Array.from({ length: Count }, (_, I) => I + 1) : [null];
    for (const Id of Ids) {
      const Reply = await Ask(
        Id == null ? 'slot info' : `slot ${Id} info`,
        Id == null ? 'slot info\r\n' : `slot info:\r\nslot id: ${Id}\r\n\r\n`
      );
      if (!Reply) break;
      if (Reply.Code === 202) {
        Snap.Slots.push(ParseSlot(Id ?? 0, Reply.Fields));
      } else if (Id != null) {
        // 105 `no disk` is the deck's way of saying the slot is empty.
        const Empty = Reply.Code === 105;
        Snap.Slots.push({
          ...ParseSlot(Id, {}),
          Status: Empty ? 'empty' : null,
          Error: Empty ? null : `${Reply.Code} ${Reply.Text}`,
        });
      }
    }

    Step = 'quit';
    try {
      Session.Socket.write('quit\r\n');
    } catch {
      // Closing anyway.
    }
    Session.Finish(Reached(Session));
  };

  return RunTcpSession<HyperDeckSnapshot>({
    Address,
    Port,
    IdleMs: BudgetMs,
    DeadlineMs: BudgetMs,
    NoDelay: true,
    OnConnect: (Session) => {
      Converse(Session).catch(() => {
        // The queue was failed because the session settled (timeout, close,
        // error): that path already produced the result.
      });
    },
    OnData: (Chunk, Session) => {
      ReceivedAny = true;
      if (!Queue.Feed(StripCarriageReturns(Chunk.toString('utf8')))) {
        Session.Finish(
          Snap.IsHyperDeck
            ? { ...Reached(Session), Incomplete: Step }
            : { ...Reached(Session), IsHyperDeck: false }
        );
      }
    },
    OnSettle: () => Queue.FailPending(new Error('Session settled')),
    OnTimeout: (Session) => Unfinished(Session, `No reply from HyperDeck after ${BudgetMs}ms`),
    OnError: (Message) => Failed(Message),
    OnClose: (Session) => Unfinished(Session, 'Connection closed before the HyperDeck banner'),
  });
}

// --- Snapshot cache -----------------------------------------------------------
//
// HyperDecks accept only a few concurrent clients, so several checks on one deck
// (media, recording, record time) must share one session per tick rather than
// each opening their own.

const SNAPSHOT_CACHE = CacheManager.GetBucket('MonitoringMethods:HyperDeck', {
  defaultTtlMs: 1000,
  maxEntries: 500,
});

// --- Settings / evaluation ----------------------------------------------------

export interface HyperDeckConfig {
  Address: string;
  Port: number;
  TimeoutMs: number;
}

function ParseConfig(Target: MonitoringTargetLike): HyperDeckConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number(Cfg.Port);
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Port: Number.isFinite(Port) && Port > 0 ? Port | 0 : DEFAULT_PORT,
    TimeoutMs: ResolveTimeoutMs(Cfg.Timeout),
  };
}

export interface HyperDeckOptions {
  RequireMedia: boolean;
  CheckRecording: boolean;
  CheckRecordTime: boolean;
  MinRecordMinutes: number;
  RecordTimeScope: 'all' | 'active';
}

function ParseHealthOptions(Target: MonitoringTargetLike): HyperDeckOptions {
  const Cfg = (Target && Target.Settings) || {};
  const MinRecord = Number(Cfg.MinRecordMinutes);
  return {
    // Default ON: an absent key (a check saved before this field existed, or a
    // bare settings object) still requires media.
    RequireMedia: Cfg.RequireMedia !== false,
    CheckRecording: Cfg.CheckRecording === true,
    CheckRecordTime: Cfg.CheckRecordTime === true,
    MinRecordMinutes:
      Number.isFinite(MinRecord) && MinRecord > 0 ? MinRecord : DEFAULT_MIN_RECORD_MINUTES,
    RecordTimeScope: Cfg.RecordTimeScope === 'active' ? 'active' : 'all',
  };
}

function ActiveSlot(Snap: HyperDeckSnapshot): HyperDeckSlot | null {
  const Id = Snap.Transport ? Snap.Transport.SlotId : null;
  if (Id == null) return null;
  return Snap.Slots.find((Slot) => Slot.Id === Id) || null;
}

/**
 * Seconds of recording left, and which slots it was counted from.
 *
 * 'all' (the default) adds up every MOUNTED slot. HyperDeck Studio-family decks
 * continue recording on the next card when the active one fills, so the
 * active card alone under-states the headroom and would warn at every card
 * change during a long record — the warning operators learn to ignore. The sum
 * is the honest answer to "will the rest of the show fit?". 'active' is offered
 * for crews who swap cards by hand and want warning before each one fills.
 *
 * Null when there is nothing to count (no active slot in 'active' mode, or no
 * slot reported a recording time at all).
 */
export function RemainingRecordTime(
  Snap: HyperDeckSnapshot,
  Scope: 'all' | 'active'
): { Seconds: number; SlotIds: number[] } | null {
  if (Scope === 'active') {
    const Active = ActiveSlot(Snap);
    if (!Active || Active.RecordingTimeSec == null) return null;
    return { Seconds: Math.max(0, Active.RecordingTimeSec), SlotIds: [Active.Id] };
  }
  const Counted = Snap.Slots.filter(
    (Slot) => Slot.Status === 'mounted' && Slot.RecordingTimeSec != null
  );
  if (!Counted.length) {
    // No mounted media at all: zero headroom, not "unknown", as long as the
    // slots were actually read.
    return Snap.Slots.length ? { Seconds: 0, SlotIds: [] } : null;
  }
  return {
    Seconds: Counted.reduce((Sum, Slot) => Sum + Math.max(0, Slot.RecordingTimeSec ?? 0), 0),
    SlotIds: Counted.map((Slot) => Slot.Id),
  };
}

const WholeMinutes = (Seconds: number): number => Math.floor(Seconds / 60);

// The reasons a reachable deck is unhealthy, per the enabled assertions. Pure —
// exported via _internal for unit tests.
function EvaluateHealth(Snap: HyperDeckSnapshot, Options: HyperDeckOptions): string[] {
  if (!Snap.IsHyperDeck) return ['Responded, but does not look like a HyperDeck'];
  if (Snap.Rejected) return ['HyperDeck refused the connection (too many clients connected)'];

  const Reasons: string[] = [];
  if (Snap.Incomplete) Reasons.push(`Timed out reading ${Snap.Incomplete}`);

  if (Options.RequireMedia) {
    const Active = ActiveSlot(Snap);
    const HasMedia = Snap.Slots.some((S) => S.Status === 'mounted' || S.Status === 'mounting');
    if (!Snap.Slots.length) {
      if (!Snap.Incomplete) Reasons.push('Failed to read slot status');
    } else if (!HasMedia) {
      Reasons.push('No media mounted');
    } else if (Active && Active.Status === 'empty') {
      Reasons.push(`Active slot ${Active.Id}: no media`);
    }
    for (const Slot of Snap.Slots) {
      if (Slot.Status === 'error') Reasons.push(`Slot ${Slot.Id}: media error`);
    }
  }

  if (Options.CheckRecording) {
    const Status = Snap.Transport ? Snap.Transport.Status : null;
    if (!Status) {
      if (!Snap.Incomplete) Reasons.push('Failed to read transport status');
    } else if (Status !== 'record') {
      Reasons.push(`Not recording (transport ${Status})`);
    }
  }

  if (Options.CheckRecordTime) {
    const Left = RemainingRecordTime(Snap, Options.RecordTimeScope);
    const Minimum = Options.MinRecordMinutes;
    if (!Left) {
      if (!Snap.Incomplete) {
        Reasons.push(
          Options.RecordTimeScope === 'active'
            ? 'No active slot to read recording time from'
            : 'Failed to read recording time'
        );
      }
    } else if (Left.Seconds < Minimum * 60) {
      const Where =
        Left.SlotIds.length === 1
          ? `Slot ${Left.SlotIds[0]}: `
          : Left.SlotIds.length > 1
            ? `Slots ${Left.SlotIds.join(' + ')}: `
            : '';
      Reasons.push(
        `${Where}${WholeMinutes(Left.Seconds)} min recording time left (minimum ${Minimum})`
      );
    }
  }
  return Reasons;
}

// --- Run ------------------------------------------------------------------------

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Success: false, Error: `Invalid port: ${Config.Port}` };
  }

  const Snap = (await SNAPSHOT_CACHE.GetOrCreate(
    `${Config.Address.toLowerCase()}|${Config.Port}|${Config.TimeoutMs}`,
    () => QueryHyperDeck(Config.Address, Config.Port, Config.TimeoutMs),
    { ttlMs: ResolveSnapshotTtlMs(Config.TimeoutMs) }
  )) as HyperDeckSnapshot;

  if (!Snap.Reachable) {
    const Message = Snap.Error || 'No reply from HyperDeck';
    return { Success: false, ...(IsRefusal(Message) ? { Degraded: true } : {}), Error: Message };
  }

  const Options = ParseHealthOptions(Target);
  const Reasons = EvaluateHealth(Snap, Options);
  const Left = RemainingRecordTime(Snap, Options.RecordTimeScope);
  const Transport = Snap.Transport;

  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs: Snap.LatencyMs ?? null,
    IsHyperDeck: Snap.IsHyperDeck,
    Rejected: Snap.Rejected,
    Model: Snap.Model,
    ProtocolVersion: Snap.ProtocolVersion,
    SoftwareVersion: Snap.SoftwareVersion,
    DeviceName: Snap.DeviceName,
    TransportStatus: Transport ? Transport.Status : null,
    ActiveSlot: Transport ? Transport.SlotId : null,
    ClipId: Transport ? Transport.ClipId : null,
    Timecode: Transport ? (Transport.DisplayTimecode ?? Transport.Timecode) : null,
    VideoFormat: Transport ? Transport.VideoFormat : null,
    InputVideoFormat: Transport ? Transport.InputVideoFormat : null,
    Slots: Snap.Slots,
    RecordTimeLeftSec: Left ? Left.Seconds : null,
    Incomplete: Snap.Incomplete,
    QueryErrors: Snap.QueryErrors,
  };
}

// --- Debug ----------------------------------------------------------------------

const TRANSPORT_LABELS: Record<string, string> = {
  preview: 'Preview',
  stopped: 'Stopped',
  play: 'Playing',
  forward: 'Forward',
  rewind: 'Rewind',
  jog: 'Jog',
  shuttle: 'Shuttle',
  record: 'Recording',
};

function TransportPill(Status: unknown): string {
  const Key = String(Status || '');
  if (!Key) return Pill('muted', 'Unknown');
  const Label = TRANSPORT_LABELS[Key] || Key;
  if (Key === 'record') return Pill('danger', Label);
  if (Key === 'play' || Key === 'forward') return Pill('success', Label);
  return Pill('muted', Label);
}

function SlotPill(Slot: HyperDeckSlot): string {
  if (Slot.Error) return Pill('warning', 'No reply');
  switch (Slot.Status) {
    case 'mounted':
      return Pill('success', 'Mounted');
    case 'mounting':
      return Pill('warning', 'Mounting');
    case 'error':
      return Pill('danger', 'Error');
    case 'empty':
      return Pill('muted', 'Empty');
    default:
      return Pill('muted', Slot.Status || 'Unknown');
  }
}

export function FormatDuration(Seconds: number): string {
  const Total = Math.max(0, Math.floor(Seconds));
  const H = Math.floor(Total / 3600);
  const M = Math.floor((Total % 3600) / 60);
  return H > 0 ? `${H} h ${M} min` : `${M} min`;
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseConfig(Target);
  const Options = ParseHealthOptions(Target);
  const Reachable = !!(Result && Result.Success === true);

  const Head = Rows([
    TextRow('Host', `${Config.Address || '—'}:${Config.Port}`),
    Reachable && Result.Model ? TextRow('Model', String(Result.Model)) : null,
    Reachable && Result.DeviceName ? TextRow('Name', String(Result.DeviceName)) : null,
    Reachable && (Result.SoftwareVersion || Result.ProtocolVersion)
      ? TextRow(
          'Software',
          [
            Result.SoftwareVersion ? String(Result.SoftwareVersion) : '',
            Result.ProtocolVersion ? `protocol ${String(Result.ProtocolVersion)}` : '',
          ]
            .filter(Boolean)
            .join(' · ')
        )
      : null,
    Row('Status', BmdStatePill(Result, 'Healthy')),
    Reachable && Result.DegradedReason ? TextRow('Reason', String(Result.DegradedReason)) : null,
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Failed to reach the HyperDeck'),
  ]);

  if (!Reachable) {
    return (
      Head +
      '<div class="mt-2">' +
      Note(
        `Failed to reach the HyperDeck Ethernet Protocol (TCP ${Config.Port}). Check the address and that the deck is on the network.`
      ) +
      '</div>'
    );
  }
  if (Result.IsHyperDeck === false || Result.Rejected === true) return Head;

  const Transport = Rows([
    Row('Transport', TransportPill(Result.TransportStatus)),
    TextRow('Active slot', Result.ActiveSlot == null ? 'None' : String(Result.ActiveSlot)),
    Result.ClipId != null ? MonoRow('Clip', String(Result.ClipId)) : null,
    Result.Timecode ? MonoRow('Timecode', String(Result.Timecode)) : null,
    Result.VideoFormat ? MonoRow('Video format', String(Result.VideoFormat)) : null,
    Result.InputVideoFormat ? MonoRow('Input format', String(Result.InputVideoFormat)) : null,
    Options.CheckRecordTime && typeof Result.RecordTimeLeftSec === 'number'
      ? MonoRow(
          Options.RecordTimeScope === 'active' ? 'Time left (active)' : 'Time left (all slots)',
          `${FormatDuration(Result.RecordTimeLeftSec)} (minimum ${Options.MinRecordMinutes} min)`
        )
      : null,
  ]);

  const Slots: HyperDeckSlot[] = Array.isArray(Result.Slots)
    ? (Result.Slots as HyperDeckSlot[])
    : [];
  const SlotCards = Slots.map((Slot) => {
    const Body: string[] = [];
    if (Slot.VolumeName) Body.push(`Volume ${Esc(Slot.VolumeName)}`);
    if (Slot.RecordingTimeSec != null && Slot.Status === 'mounted') {
      Body.push(`${Esc(FormatDuration(Slot.RecordingTimeSec))} recording time left`);
    }
    if (Slot.VideoFormat) Body.push(Esc(Slot.VideoFormat));
    if (Slot.Blocked) Body.push('Blocked');
    if (Slot.Error) Body.push(Esc(Slot.Error));
    const IsActive = Result.ActiveSlot != null && Slot.Id === Result.ActiveSlot;
    return Card({
      Title: `Slot ${Slot.Id}${Slot.SlotName ? ` · ${Slot.SlotName}` : ''}${IsActive ? ' (active)' : ''}`,
      Badge: SlotPill(Slot),
      Highlight: IsActive && Slot.Status === 'mounted',
      BodyHtml: Body.length
        ? `<div class="text-muted small text-break">${Body.join(' · ')}</div>`
        : '',
    });
  }).join('');

  return (
    Head +
    `<div class="mt-2">${Transport}</div>` +
    (Slots.length
      ? `<div class="text-muted small mt-2 mb-1">Slots (${Slots.length})</div>` +
        `<div class="d-grid gap-1">${SlotCards}</div>`
      : '<div class="mt-2">' + Note('No slot information reported') + '</div>')
  );
}

export const Name = 'Blackmagic HyperDeck';
export const Description =
  'Connects to a Blackmagic HyperDeck recorder over the HyperDeck Ethernet Protocol (TCP 9993) and reads its transport state and every media slot in one short session, sending queries only. Degraded when no usable media is mounted; optionally also when the deck is not recording or the recording time left drops below a minimum.';
export const Group = 'Video';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseMessage,
  FrameReply,
  DecodeReply,
  ParseTransport,
  ParseSlot,
  ParseHealthOptions,
  ParseConfig,
  RemainingRecordTime,
  EvaluateHealth,
  FormatDuration,
  QueryHyperDeck,
};
export { ID, Settings, Run, Debug };
