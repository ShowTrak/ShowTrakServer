// Shared plumbing for the Blackmagic ATEM monitoring method (atem).
//
// PROTOCOL. ATEM switchers speak a proprietary, reliable-datagram protocol on
// UDP 9910. There is no vendor spec; every wire detail here is taken from the
// open-source atem-connection library (github.com/Sofie-Automation/
// sofie-atem-connection, src/lib/atemSocketChild.ts and src/commands/**) and
// checked against the real switcher state dumps that library keeps as test
// fixtures (src/__tests__/connection/*.data — 27 dumps from Mini through
// Constellation 8K). The `atem-connection` package itself is deliberately NOT a
// dependency: it pulls in a worker-thread wrapper and the whole command set for
// the sake of reading seven commands, and distributable size matters.
//
// Packet = 12-byte header + optional payload:
//   bytes 0-1   flags (top 5 bits) | total packet length (low 11 bits)
//   bytes 2-3   session id
//   bytes 4-5   ack id            (meaningful with the AckReply flag)
//   bytes 6-7   retransmit-from   (meaningful with RetransmitRequest)
//   bytes 8-9   unused here
//   bytes 10-11 the sender's packet id (15 bits, wraps at 32768)
// Flags: 0x01 AckRequest (reliable), 0x02 NewSessionId (SYN/hello),
// 0x04 IsRetransmit, 0x08 RetransmitRequest, 0x10 AckReply.
//
// Handshake: the client sends a 20-byte hello (SYN flag); the switcher answers
// with a SYN packet whose first payload byte is a status — 0x02 accepted, 0x03
// "no free client slots" (PyATEMMax), 0x04 seen when the switcher is trying to
// recover a dropped session. The client acks the answer's packet id, after which
// the switcher switches to its own session id (taken from every later packet)
// and dumps its full state as a run of reliable packets ending in `InCm`. From
// then on it keeps sending reliable packets (state changes, and empty keepalives
// when nothing changes); each must be acked or the switcher resends it and
// eventually drops the session. atem-connection treats 5 s of silence as a lost
// session, so this does too.
//
// Payload = concatenated commands: uint16 length (including this 8-byte
// header), 2 pad bytes, 4-char ASCII name, body. Bodies are routinely padded with
// junk bytes (visible in the real dumps), so parsers read fixed offsets only.
//
// DESIGN. A full state dump runs to ~100 KB on a Constellation 8K and ATEMs
// accept only a handful of control clients, so reconnecting per probe would be
// wasteful and could lock real operators out. Instead — like _qlab-shared's
// connection manager — one persistent session is held per address:port, every
// reliable packet is acked, a cached snapshot is updated from incoming commands,
// and a sweep reaps any session no check has asked about for a few minutes.
// There is no framework teardown hook for monitoring methods, so that interest
// TTL is how a deleted or repointed check lets go of the switcher.
//
// The client is strictly read-only: it never sends a command, only the hello
// and acks. Importing this module has no side effects — nothing opens until the
// first Observe().
import dgram from 'dgram';
import net from 'net';
import { performance } from 'perf_hooks';
import { CreateLogger } from '../Logger';
import { MONITORING_INTEREST_TTL_MS } from '../Config/constants';

const Logger = CreateLogger('ATEM');

export const DEFAULT_ATEM_PORT = 9910;

const HEADER_LENGTH = 12;
const MAX_PACKET_ID = 1 << 15; // ATEM packet ids are 15 bits
const LENGTH_MASK = 0x07ff;
const MAX_INPUTS = 1024; // bound the input-name map against a misbehaving peer

export const PacketFlag = {
  AckRequest: 0x01,
  NewSessionId: 0x02,
  IsRetransmit: 0x04,
  RetransmitRequest: 0x08,
  AckReply: 0x10,
} as const;

// Hello-answer status bytes (first payload byte of the switcher's SYN reply).
const HELLO_STATUS_CLIENT = 0x01; // what a CLIENT sends — seen back only from an echo
const HELLO_STATUS_FULL = 0x03;

// Timings. Mutable only through ConfigureTimings (tests).
const DEFAULT_TIMINGS = {
  LostAfterMs: 5000, // no packet for this long → session lost (atem-connection's figure)
  HelloTimeoutMs: 1000, // no answer to a hello by now → try again
  DumpTimeoutMs: 15000, // handshake done but no InCm by now → start over
  RetryBaseMs: 1000,
  RetryMaxMs: 10000,
  // Close a session no check has asked about for this long. It must outlast the
  // longest check interval, or a slow check would reap its own session (and its
  // power-supply memory) between runs.
  InterestTtlMs: MONITORING_INTEREST_TTL_MS,
  SweepIntervalMs: 30000,
  WatchdogIntervalMs: 500,
};
type Timings = typeof DEFAULT_TIMINGS;
let T: Timings = { ...DEFAULT_TIMINGS };

// --- Packet codec (pure) ----------------------------------------------------

export interface AtemPacket {
  Flags: number;
  Length: number;
  SessionId: number;
  AckId: number;
  RemotePacketId: number;
  Payload: Buffer;
}

// Decode one datagram. Null for anything shorter than a header or whose length
// field disagrees with the datagram size — atem-connection drops those too.
export function ParsePacket(Packet: Buffer): AtemPacket | null {
  if (!Buffer.isBuffer(Packet) || Packet.length < HEADER_LENGTH) return null;
  const Word = Packet.readUInt16BE(0);
  const Length = Word & LENGTH_MASK;
  if (Length !== Packet.length) return null;
  return {
    Flags: Word >> 11,
    Length,
    SessionId: Packet.readUInt16BE(2),
    AckId: Packet.readUInt16BE(4),
    RemotePacketId: Packet.readUInt16BE(10),
    Payload: Packet.subarray(HEADER_LENGTH),
  };
}

// The 20-byte hello. Byte-for-byte atem-connection's COMMAND_CONNECT_HELLO
// (including the unexplained 0x3a at byte 9 and the 0x01 payload marker), except
// that the client session id is random, as openswitcher's protocol notes advise.
export function BuildHello(ClientSessionId: number): Buffer {
  const Buf = Buffer.from([
    0x10, 0x14, 0x53, 0xab, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3a, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
  Buf.writeUInt16BE(ClientSessionId & 0xffff, 2);
  return Buf;
}

// A 12-byte ack: AckReply flag, the current session id, and the id being acked.
export function BuildAck(SessionId: number, AckId: number): Buffer {
  const Buf = Buffer.alloc(HEADER_LENGTH, 0);
  Buf.writeUInt16BE((PacketFlag.AckReply << 11) | HEADER_LENGTH, 0);
  Buf.writeUInt16BE(SessionId & 0xffff, 2);
  Buf.writeUInt16BE(AckId & 0xffff, 4);
  return Buf;
}

export interface AtemCommand {
  Name: string;
  Body: Buffer;
}

// Split a payload into commands. Stops at a length below the 8-byte header or
// running past the end (a truncated command is dropped rather than parsed short).
export function SplitCommands(Payload: Buffer): AtemCommand[] {
  const Out: AtemCommand[] = [];
  let Offset = 0;
  while (Payload.length - Offset >= 8) {
    const Length = Payload.readUInt16BE(Offset);
    if (Length < 8 || Offset + Length > Payload.length) break;
    Out.push({
      Name: Payload.toString('latin1', Offset + 4, Offset + 8),
      Body: Payload.subarray(Offset + 8, Offset + Length),
    });
    Offset += Length;
  }
  return Out;
}

// --- Command parsers (pure) -------------------------------------------------

function NullTerminated(Buf: Buffer, Start: number, Length: number): string {
  const Slice = Buf.subarray(Start, Start + Length);
  const Nul = Slice.indexOf(0);
  return Slice.toString('utf8', 0, Nul < 0 ? Slice.length : Nul);
}

// `_ver`: uint32 at 0 = major << 16 | minor (e.g. 0x0002001e = 2.30).
export function ParseVersion(Body: Buffer): { Major: number; Minor: number } | null {
  if (Body.length < 4) return null;
  const Raw = Body.readUInt32BE(0);
  return { Major: Raw >>> 16, Minor: Raw & 0xffff };
}

// `_pin`: product name, NUL-terminated in 40 bytes, then a model id byte at 40.
export function ParseProductIdentifier(
  Body: Buffer
): { Name: string; Model: number | null } | null {
  if (Body.length < 1) return null;
  return {
    Name: NullTerminated(Body, 0, 40),
    Model: Body.length > 40 ? Body.readUInt8(40) : null,
  };
}

// `Powr`: byte 0 is a bitmask, bit n set = power supply n+1 OK. The protocol
// does not say how many supplies a model has; see PsuCountFor.
export function ParsePower(Body: Buffer): [boolean, boolean] | null {
  if (Body.length < 1) return null;
  const Bits = Body.readUInt8(0);
  return [(Bits & 0x01) !== 0, (Bits & 0x02) !== 0];
}

// `PrgI` / `PrvI`: ME index (0 = ME 1) at byte 0, source id uint16 at byte 2.
export function ParseMeSource(Body: Buffer): { MixEffect: number; Source: number } | null {
  if (Body.length < 4) return null;
  return { MixEffect: Body.readUInt8(0), Source: Body.readUInt16BE(2) };
}

// `InPr`: source id uint16 at 0, long name in 20 bytes at 2, short name in 4
// bytes at 22. (The port-type and availability fields that follow are unused.)
export function ParseInputProperties(
  Body: Buffer
): { Id: number; LongName: string; ShortName: string } | null {
  if (Body.length < 26) return null;
  return {
    Id: Body.readUInt16BE(0),
    LongName: NullTerminated(Body, 2, 20),
    ShortName: NullTerminated(Body, 22, 4),
  };
}

export type StreamingState = 'Idle' | 'Connecting' | 'Streaming' | 'Stopping';
export type StreamingError = 'None' | 'InvalidState' | 'Unknown';

// `StRS` (protocol 2.30+, streaming models): uint16 bitmask at 0. Decoded exactly
// as atem-connection's StreamingStatusUpdateCommand: status bits Idle 0x01,
// Connecting 0x02, Streaming 0x04, Stopping 0x20 (only ever alongside
// Streaming), first match wins except Streaming yields to Stopping; error bits
// InvalidState 0x10, Unknown 0x8000.
export function ParseStreamingStatus(
  Body: Buffer
): { State: StreamingState; Error: StreamingError; Raw: number } | null {
  if (Body.length < 2) return null;
  const Raw = Body.readUInt16BE(0);
  let Error: StreamingError = 'None';
  if ((Raw & 0x10) === 0x10) Error = 'InvalidState';
  else if ((Raw & 0x8000) === 0x8000) Error = 'Unknown';
  let State: StreamingState = 'Idle';
  if (Raw & 0x01) State = 'Idle';
  else if (Raw & 0x02) State = 'Connecting';
  else if (Raw & 0x04) State = Raw & 0x20 ? 'Stopping' : 'Streaming';
  else if (Raw & 0x20) State = 'Stopping';
  return { State, Error, Raw };
}

export type RecordingState = 'Idle' | 'Recording' | 'Stopping';
export type RecordingError =
  | 'None'
  | 'NoMedia'
  | 'MediaFull'
  | 'MediaError'
  | 'MediaUnformatted'
  | 'DroppingFrames'
  | 'Unknown';

const RECORDING_ERROR_BITS: Array<[number, RecordingError]> = [
  [0x04, 'MediaFull'],
  [0x08, 'MediaError'],
  [0x10, 'MediaUnformatted'],
  [0x20, 'DroppingFrames'],
  [0x8000, 'Unknown'],
];

// `RTMS` (protocol 2.30+, recording models): uint16 bitmask at 0. Decoded as
// atem-connection's RecordingStatusUpdateCommand: Recording 0x01, else
// Stopping 0x80, else Idle. Bit 0x02 means "no error"; with neither it nor an
// error bit set the switcher has no media (the real dumps show 0x0002 with a
// disk in, 0x0000 without). A specific error bit wins over 0x02.
export function ParseRecordingStatus(
  Body: Buffer
): { State: RecordingState; Error: RecordingError; Raw: number } | null {
  if (Body.length < 2) return null;
  const Raw = Body.readUInt16BE(0);
  let Error: RecordingError = Raw & 0x02 ? 'None' : 'NoMedia';
  for (const [Bit, Name] of RECORDING_ERROR_BITS) {
    if ((Raw & Bit) === Bit) {
      Error = Name;
      break;
    }
  }
  const State: RecordingState = Raw & 0x01 ? 'Recording' : Raw & 0x80 ? 'Stopping' : 'Idle';
  return { State, Error, Raw };
}

// Models atem-connection treats as having two power supplies
// (productIdentifierCommand.ts): 2 M/E, 2 M/E 4K, 2 M/E Broadcast 4K,
// Constellation, Constellation 8K, Constellation HD 4 M/E, Constellation 4K 4 M/E.
const DUAL_PSU_MODELS = new Set([0x03, 0x06, 0x07, 0x0b, 0x0c, 0x14, 0x1e]);

export function PsuCountFor(Model: number | null, SecondEverSeen: boolean): number {
  // The model list is atem-connection's and is not exhaustive (the real dump of
  // a Television Studio HD8 reports a second supply), so a model that has ever
  // reported supply 2 OK is treated as dual from then on.
  return (Model != null && DUAL_PSU_MODELS.has(Model)) || SecondEverSeen ? 2 : 1;
}

// --- State ------------------------------------------------------------------

export interface AtemInputName {
  LongName: string;
  ShortName: string;
}

export interface AtemState {
  ProtocolVersion: { Major: number; Minor: number } | null;
  ProductName: string | null;
  Model: number | null;
  PowerBits: [boolean, boolean] | null;
  Program: number | null; // ME 1 source id
  Preview: number | null;
  Inputs: Map<number, AtemInputName>;
  Streaming: { State: StreamingState; Error: StreamingError } | null;
  Recording: { State: RecordingState; Error: RecordingError } | null;
  DumpComplete: boolean;
}

export function EmptyState(): AtemState {
  return {
    ProtocolVersion: null,
    ProductName: null,
    Model: null,
    PowerBits: null,
    Program: null,
    Preview: null,
    Inputs: new Map(),
    Streaming: null,
    Recording: null,
    DumpComplete: false,
  };
}

// Fold one command into the state. Unknown commands and short bodies are ignored.
export function ApplyCommand(State: AtemState, Cmd: AtemCommand): void {
  switch (Cmd.Name) {
    case '_ver': {
      const V = ParseVersion(Cmd.Body);
      if (V) State.ProtocolVersion = V;
      return;
    }
    case '_pin': {
      const P = ParseProductIdentifier(Cmd.Body);
      if (P) {
        State.ProductName = P.Name;
        State.Model = P.Model;
      }
      return;
    }
    case 'Powr': {
      const P = ParsePower(Cmd.Body);
      if (P) State.PowerBits = P;
      return;
    }
    case 'PrgI':
    case 'PrvI': {
      const S = ParseMeSource(Cmd.Body);
      if (!S || S.MixEffect !== 0) return; // only ME 1 is reported
      if (Cmd.Name === 'PrgI') State.Program = S.Source;
      else State.Preview = S.Source;
      return;
    }
    case 'InPr': {
      const I = ParseInputProperties(Cmd.Body);
      if (!I) return;
      if (!State.Inputs.has(I.Id) && State.Inputs.size >= MAX_INPUTS) return;
      State.Inputs.set(I.Id, { LongName: I.LongName, ShortName: I.ShortName });
      return;
    }
    case 'StRS': {
      const S = ParseStreamingStatus(Cmd.Body);
      if (S) State.Streaming = { State: S.State, Error: S.Error };
      return;
    }
    case 'RTMS': {
      const R = ParseRecordingStatus(Cmd.Body);
      if (R) State.Recording = { State: R.State, Error: R.Error };
      return;
    }
    case 'InCm':
      State.DumpComplete = true;
      return;
    default:
      return;
  }
}

// --- Snapshot ---------------------------------------------------------------

export interface AtemSource {
  Id: number;
  Name: string | null;
  ShortName: string | null;
}

export interface AtemPsu {
  Index: number; // 1-based
  Ok: boolean; // reporting OK right now
  // Has reported OK at some point while this address has been watched. A
  // supply that is down and never was up is simply not connected — common on
  // dual-supply models run from one supply — and is not a failure.
  SeenOk: boolean;
}

export interface AtemSnapshot {
  Connected: boolean; // session established and heard from recently
  Ready: boolean; // Connected and the initial state dump finished
  Full: boolean; // the switcher refused the session: no free client slots
  NotAtem: boolean; // something answered, but not with the ATEM protocol
  Refused: boolean; // ICMP port unreachable (ECONNREFUSED)
  Error: string | null;
  HandshakeMs: number | null;
  ProductName: string | null;
  Model: number | null;
  ProtocolVersion: string | null;
  PowerSupplies: AtemPsu[] | null; // null until Powr arrives
  Program: AtemSource | null;
  Preview: AtemSource | null;
  Streaming: { State: StreamingState; Error: StreamingError } | null;
  Recording: { State: RecordingState; Error: RecordingError } | null;
}

function SourceOf(State: AtemState, Id: number | null): AtemSource | null {
  if (Id == null) return null;
  const Name = State.Inputs.get(Id);
  return {
    Id,
    Name: Name && Name.LongName ? Name.LongName : null,
    ShortName: Name && Name.ShortName ? Name.ShortName : null,
  };
}

export function BuildSnapshotFields(
  State: AtemState,
  PsuEverOk: readonly [boolean, boolean]
): Pick<
  AtemSnapshot,
  | 'ProductName'
  | 'Model'
  | 'ProtocolVersion'
  | 'PowerSupplies'
  | 'Program'
  | 'Preview'
  | 'Streaming'
  | 'Recording'
> {
  const Count = PsuCountFor(State.Model, PsuEverOk[1]);
  return {
    ProductName: State.ProductName,
    Model: State.Model,
    ProtocolVersion: State.ProtocolVersion
      ? `${State.ProtocolVersion.Major}.${State.ProtocolVersion.Minor}`
      : null,
    PowerSupplies: State.PowerBits
      ? State.PowerBits.slice(0, Count).map((Ok, I) => ({
          Index: I + 1,
          Ok,
          SeenOk: Ok || !!PsuEverOk[I],
        }))
      : null,
    Program: SourceOf(State, State.Program),
    Preview: SourceOf(State, State.Preview),
    Streaming: State.Streaming ? { ...State.Streaming } : null,
    Recording: State.Recording ? { ...State.Recording } : null,
  };
}

// --- Session manager --------------------------------------------------------

export interface SessionParams {
  Address: string;
  Port: number;
}

type Phase = 'idle' | 'handshake' | 'established' | 'waiting';

interface Session {
  Key: string;
  Params: SessionParams;
  Socket: dgram.Socket | null;
  Phase: Phase;
  ClientSessionId: number;
  SessionId: number;
  LastRemoteId: number;
  HelloAnswerId: number;
  HelloSentAt: number;
  EstablishedAt: number;
  LastReceivedAt: number;
  HandshakeMs: number | null;
  State: AtemState;
  // Per supply: ever reported OK. Lives on the per-address session record, so
  // it survives reconnects and switcher-initiated new sessions, and is only
  // forgotten when the address is reaped.
  PsuEverOk: [boolean, boolean];
  Full: boolean;
  NotAtem: boolean;
  Refused: boolean;
  JunkSinceHello: number;
  Error: string | null;
  LastInterestAt: number;
  RetryAttempts: number;
  RetryTimer: NodeJS.Timeout | null;
  Waiters: Array<() => void>;
}

function BuildKey(P: SessionParams): string {
  return `${P.Address.toLowerCase()}|${P.Port}`;
}

function RandomClientSessionId(): number {
  // Below 0x8000: the switcher's own session ids have the high bit set.
  return 1 + Math.floor(Math.random() * 0x7ffe);
}

class AtemSessionManagerImpl {
  private Sessions = new Map<string, Session>();
  private SweepTimer: NodeJS.Timeout | null = null;
  private WatchdogTimer: NodeJS.Timeout | null = null;

  // Register interest in a switcher, opening the session if needed.
  Observe(Params: SessionParams): string {
    const Key = BuildKey(Params);
    let S = this.Sessions.get(Key);
    if (!S) {
      S = {
        Key,
        Params: { ...Params },
        Socket: null,
        Phase: 'idle',
        ClientSessionId: 0,
        SessionId: 0,
        LastRemoteId: 0,
        HelloAnswerId: -1,
        HelloSentAt: 0,
        EstablishedAt: 0,
        LastReceivedAt: 0,
        HandshakeMs: null,
        State: EmptyState(),
        PsuEverOk: [false, false],
        Full: false,
        NotAtem: false,
        Refused: false,
        JunkSinceHello: 0,
        Error: null,
        LastInterestAt: Date.now(),
        RetryAttempts: 0,
        RetryTimer: null,
        Waiters: [],
      };
      this.Sessions.set(Key, S);
    }
    S.LastInterestAt = Date.now();
    if (S.Phase === 'idle') this.Start(S);
    this.EnsureTimers();
    return Key;
  }

  Snapshot(Key: string): AtemSnapshot {
    const S = this.Sessions.get(Key);
    const State = S ? S.State : EmptyState();
    const Connected = !!S && S.Phase === 'established';
    return {
      Connected,
      Ready: Connected && State.DumpComplete,
      Full: !!S && S.Full,
      NotAtem: !!S && (S.NotAtem || (S.Phase !== 'established' && S.JunkSinceHello > 0)),
      Refused: !!S && S.Refused,
      Error: S ? S.Error : null,
      HandshakeMs: S ? S.HandshakeMs : null,
      ...BuildSnapshotFields(State, S ? S.PsuEverOk : [false, false]),
    };
  }

  // Resolve once the session is usable (or has a definite answer: full, refused,
  // not an ATEM), or after TimeoutMs, whichever is first.
  WaitReady(Key: string, TimeoutMs: number): Promise<AtemSnapshot> {
    const Settled = (): boolean => {
      const Snap = this.Snapshot(Key);
      return Snap.Ready || Snap.Full || Snap.Refused || (this.Sessions.get(Key)?.NotAtem ?? false);
    };
    if (Settled()) return Promise.resolve(this.Snapshot(Key));
    const S = this.Sessions.get(Key);
    if (!S) return Promise.resolve(this.Snapshot(Key));
    return new Promise((resolve) => {
      let Done = false;
      const Finish = (): void => {
        if (Done) return;
        Done = true;
        clearTimeout(Timer);
        const Index = S.Waiters.indexOf(Check);
        if (Index !== -1) S.Waiters.splice(Index, 1);
        resolve(this.Snapshot(Key));
      };
      const Check = (): void => {
        if (Settled()) Finish();
      };
      const Timer = setTimeout(Finish, Math.max(0, TimeoutMs));
      if (typeof Timer.unref === 'function') Timer.unref();
      S.Waiters.push(Check);
    });
  }

  private Notify(S: Session): void {
    for (const Waiter of S.Waiters.slice()) Waiter();
  }

  // Open a fresh socket and send a hello. A new socket per attempt means a new
  // local port, so the switcher never mistakes a retry for the old session.
  private Start(S: Session): void {
    this.CloseSocket(S);
    S.Phase = 'handshake';
    S.ClientSessionId = RandomClientSessionId();
    S.SessionId = S.ClientSessionId;
    S.JunkSinceHello = 0;
    S.NotAtem = false;
    S.Refused = false;
    // A switcher that was full may since have gone away; it re-asserts Full
    // within a round trip if it is still turning us away.
    S.Full = false;
    S.HelloSentAt = performance.now();

    const Family = net.isIPv6(S.Params.Address) ? 'udp6' : 'udp4';
    const Socket = dgram.createSocket(Family);
    S.Socket = Socket;
    Socket.unref(); // a forgotten session must never hold the process open
    Socket.on('message', (Msg: Buffer) => {
      if (S.Socket === Socket) this.OnPacket(S, Msg);
    });
    Socket.on('error', (Err: Error) => {
      if (S.Socket !== Socket) return;
      const Code = (Err as NodeJS.ErrnoException).code;
      if (Code === 'ECONNREFUSED') S.Refused = true;
      this.Lost(S, Err && Err.message ? Err.message : String(Err));
    });
    try {
      // connect() resolves a hostname and filters datagrams to that peer.
      // With a callback, Node hands a lookup failure to it rather than 'error'.
      const OnConnect = (Err?: Error | null): void => {
        if (S.Socket !== Socket) return;
        if (Err) {
          this.Lost(S, Err.message || String(Err));
          return;
        }
        S.HelloSentAt = performance.now();
        this.Send(S, BuildHello(S.ClientSessionId));
      };
      Socket.connect(S.Params.Port, S.Params.Address, OnConnect as () => void);
    } catch (Err) {
      this.Lost(S, Err && (Err as Error).message ? (Err as Error).message : String(Err));
    }
  }

  private Send(S: Session, Buf: Buffer): void {
    const Socket = S.Socket;
    if (!Socket) return;
    try {
      Socket.send(Buf);
    } catch {
      // A failed send surfaces through the socket's 'error' handler.
    }
  }

  private OnPacket(S: Session, Raw: Buffer): void {
    const Packet = ParsePacket(Raw);
    if (!Packet) {
      // Junk only says "not an ATEM" while we wait for a hello answer; inside a
      // live session a stray datagram is just dropped.
      if (S.Phase === 'handshake') S.JunkSinceHello += 1;
      return;
    }
    S.LastReceivedAt = performance.now();

    if (Packet.Flags & PacketFlag.NewSessionId) {
      this.OnHelloAnswer(S, Packet);
      return;
    }
    if (S.Phase !== 'established') {
      // Traffic before any hello answer: not something an ATEM does.
      S.JunkSinceHello += 1;
      return;
    }

    // The switcher moves to its own session id after the handshake; ack with
    // whichever it is using now (atem-connection does the same).
    S.SessionId = Packet.SessionId;

    if (Packet.Flags & PacketFlag.AckRequest && Packet.RemotePacketId < MAX_PACKET_ID) {
      const Distance = (Packet.RemotePacketId - S.LastRemoteId + MAX_PACKET_ID) % MAX_PACKET_ID;
      if (Distance === 1) {
        S.LastRemoteId = Packet.RemotePacketId;
        this.Send(S, BuildAck(S.SessionId, S.LastRemoteId));
        this.ApplyPayload(S, Packet.Payload);
      } else if (Distance === 0 || Distance > MAX_PACKET_ID / 2) {
        // A resend of something already taken: re-ack so the switcher stops.
        this.Send(S, BuildAck(S.SessionId, S.LastRemoteId));
      }
      // Ahead of sequence: drop it. Our ack still names the last in-order id,
      // so the switcher resends the gap and everything after it.
    }
    // RetransmitRequest asks US to resend; we never send reliable packets, so
    // there is nothing to resend and it is ignored.
  }

  private OnHelloAnswer(S: Session, Packet: AtemPacket): void {
    const Status = Packet.Payload.length ? Packet.Payload.readUInt8(0) : -1;
    if (Status === HELLO_STATUS_CLIENT) {
      // Our own hello came straight back: an echo service, not a switcher.
      S.NotAtem = true;
      S.Error = 'The device answered but is not an ATEM switcher';
      this.Notify(S);
      return;
    }
    if (Status === HELLO_STATUS_FULL) {
      S.Full = true;
      this.Lost(S, 'The switcher has no free connections (too many control clients)');
      return;
    }
    // Any other status — 0x02 accepted, or a 0x04 recovery answer — starts a
    // fresh session: ack it and expect a new full dump. A hello answer arriving
    // mid-session (the switcher restarted or reset our session) lands here too.
    const WasEstablished = S.Phase === 'established';
    if (
      WasEstablished &&
      Packet.SessionId === S.ClientSessionId &&
      Packet.RemotePacketId === S.HelloAnswerId
    ) {
      // A duplicate of the answer we already took (our ack crossed it on the
      // wire): re-ack it rather than throwing away a dump in progress.
      this.Send(S, BuildAck(Packet.SessionId, Packet.RemotePacketId));
      return;
    }
    if (S.Phase === 'handshake') S.HandshakeMs = Math.max(0, performance.now() - S.HelloSentAt);
    S.Phase = 'established';
    S.EstablishedAt = performance.now();
    S.SessionId = Packet.SessionId;
    S.LastRemoteId = Packet.RemotePacketId;
    S.HelloAnswerId = Packet.RemotePacketId;
    S.State = EmptyState();
    S.Full = false;
    S.NotAtem = false;
    S.JunkSinceHello = 0;
    S.Error = null;
    this.Send(S, BuildAck(S.SessionId, Packet.RemotePacketId));
    if (WasEstablished) Logger.warn(`ATEM ${S.Key} started a new session`);
    this.Notify(S);
  }

  private ApplyPayload(S: Session, Payload: Buffer): void {
    if (!Payload.length) return; // keepalive
    const WasComplete = S.State.DumpComplete;
    for (const Cmd of SplitCommands(Payload)) ApplyCommand(S.State, Cmd);
    const Bits = S.State.PowerBits;
    if (Bits) S.PsuEverOk = [S.PsuEverOk[0] || Bits[0], S.PsuEverOk[1] || Bits[1]];
    if (!WasComplete && S.State.DumpComplete) {
      S.RetryAttempts = 0;
      this.Notify(S);
    }
  }

  // Tear the session down and schedule a fresh hello (with backoff) while a
  // check still cares about this switcher.
  private Lost(S: Session, Reason: string): void {
    const WasReady = S.Phase === 'established' && S.State.DumpComplete;
    this.CloseSocket(S);
    S.Phase = 'waiting';
    S.Error = Reason;
    if (WasReady) Logger.warn(`ATEM ${S.Params.Address}:${S.Params.Port} lost: ${Reason}`);
    this.Notify(S);
    if (S.RetryTimer) return;
    const Delay = Math.min(T.RetryMaxMs, T.RetryBaseMs * 2 ** Math.min(4, S.RetryAttempts));
    S.RetryAttempts += 1;
    S.RetryTimer = setTimeout(() => {
      S.RetryTimer = null;
      if (Date.now() - S.LastInterestAt > T.InterestTtlMs) {
        S.Phase = 'idle';
        return;
      }
      this.Start(S);
    }, Delay);
    if (typeof S.RetryTimer.unref === 'function') S.RetryTimer.unref();
  }

  private CloseSocket(S: Session): void {
    const Socket = S.Socket;
    S.Socket = null;
    if (!Socket) return;
    try {
      Socket.close();
    } catch {
      // already closed
    }
  }

  // Liveness: silence after the handshake, an unanswered hello, or a dump that
  // never finishes all mean start again.
  private Watchdog(): void {
    const Now = performance.now();
    for (const S of this.Sessions.values()) {
      if (S.Phase === 'handshake' && Now - S.HelloSentAt > T.HelloTimeoutMs) {
        this.Lost(S, 'No reply from the switcher');
      } else if (S.Phase === 'established') {
        if (Now - S.LastReceivedAt > T.LostAfterMs) {
          this.Lost(S, `No traffic from the switcher for ${Math.round(T.LostAfterMs / 1000)}s`);
        } else if (!S.State.DumpComplete && Now - S.EstablishedAt > T.DumpTimeoutMs) {
          this.Lost(S, 'The switcher did not finish sending its state');
        }
      }
    }
  }

  private Sweep(): void {
    const Now = Date.now();
    for (const [Key, S] of this.Sessions) {
      if (Now - S.LastInterestAt <= T.InterestTtlMs) continue;
      this.Dispose(S);
      this.Sessions.delete(Key);
    }
    if (!this.Sessions.size) this.ClearManagerTimers();
  }

  private Dispose(S: Session): void {
    if (S.RetryTimer) {
      clearTimeout(S.RetryTimer);
      S.RetryTimer = null;
    }
    this.CloseSocket(S);
    S.Phase = 'idle';
    this.Notify(S);
  }

  private EnsureTimers(): void {
    if (!this.SweepTimer) {
      this.SweepTimer = setInterval(() => this.Sweep(), T.SweepIntervalMs);
      if (typeof this.SweepTimer.unref === 'function') this.SweepTimer.unref();
    }
    if (!this.WatchdogTimer) {
      this.WatchdogTimer = setInterval(() => this.Watchdog(), T.WatchdogIntervalMs);
      if (typeof this.WatchdogTimer.unref === 'function') this.WatchdogTimer.unref();
    }
  }

  private ClearManagerTimers(): void {
    if (this.SweepTimer) {
      clearInterval(this.SweepTimer);
      this.SweepTimer = null;
    }
    if (this.WatchdogTimer) {
      clearInterval(this.WatchdogTimer);
      this.WatchdogTimer = null;
    }
  }

  // Number of live sessions (tests).
  Count(): number {
    return this.Sessions.size;
  }

  // Test-only teardown so a suite can connect/disconnect deterministically.
  Stop(): void {
    this.ClearManagerTimers();
    for (const S of this.Sessions.values()) this.Dispose(S);
    this.Sessions.clear();
  }
}

export const AtemSessionManager = new AtemSessionManagerImpl();

// Test hook: shrink the timings so loss, retry and reaping run in milliseconds.
// Call AtemSessionManager.Stop() first so the manager timers pick up new values.
export function ConfigureTimings(Overrides: Partial<Timings> | null): void {
  T = { ...DEFAULT_TIMINGS, ...(Overrides || {}) };
}

export function IsValidPort(Port: number): boolean {
  return Number.isInteger(Port) && Port >= 1 && Port <= 65535;
}

export const _internal = {
  ParsePacket,
  BuildHello,
  BuildAck,
  SplitCommands,
  ParseVersion,
  ParseProductIdentifier,
  ParsePower,
  ParseMeSource,
  ParseInputProperties,
  ParseStreamingStatus,
  ParseRecordingStatus,
  PsuCountFor,
  ApplyCommand,
  EmptyState,
  BuildSnapshotFields,
  AtemSessionManager,
  ConfigureTimings,
  DEFAULT_TIMINGS,
  PacketFlag,
};
