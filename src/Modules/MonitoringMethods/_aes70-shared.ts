// Minimal AES70 (OCA) controller over OCP.1, the binary TCP framing of AES70-3.
// Just enough to issue commands and match their responses: parameterless "Get"
// reads for the checks, and single-parameter "Set" commands for the operator's
// actions (only RunAction ever passes parameters). No object-tree walk, no
// subscriptions, no keep-alives (the session is closed long before any device
// would expect one).
//
// Wire format (AES70-3 OCP.1; cross-checked against DeutscheSoft AES70.js
// src/OCP1/encode_message.js, decode_message.js, command.js, response.js and
// ChristianAhrens/NanoOcp Source/Ocp1Message.cpp). Every integer is big-endian.
//
//   Message  = SyncVal 0x3B
//              | ProtocolVersion u16 | MessageSize u32 | PduType u8 | PduCount u16
//              | PDU[PduCount]
//     MessageSize counts every byte after the sync byte (the 9-byte header
//     included). PduType: 0 Command, 1 CommandResponseRequired, 2 Notification,
//     3 Response, 4 KeepAlive (5 is the AES70-2023 Notification2). All PDUs in
//     one message share the type.
//   Command (types 0 and 1)
//              = CommandSize u32 | Handle u32 | TargetONo u32
//              | MethodDefLevel u16 | MethodIndex u16 | ParamCount u8 | params
//     CommandSize counts the whole PDU (17 bytes + params).
//   Response   = ResponseSize u32 | Handle u32 | StatusCode u8 | ParamCount u8 | params
//     ResponseSize counts the whole PDU (10 bytes + params).
//   KeepAlive  = HeartBeatTime u16 (seconds) or u32 (ms)
//
// Version 1 (AES70-2015) is sent: it is what every d&b amplifier firmware
// predates or accepts, and Get commands are encoded identically in later
// versions. A response's version is not checked.
//
// Data types used by callers (AES70-3 §5): OcaString = u16 code-point count
// followed by that many UTF-8 code points (a COUNT OF CHARACTERS, not bytes);
// OcaBoolean = u8 (non-zero is true); enums are u8; OcaBitSet16 is u16.
import { RunTcpSession, type TcpSession } from './_tcp-session';

export const OCP1_SYNC = 0x3b;
export const OCP1_PROTOCOL_VERSION = 1;
export const PDU_COMMAND_RRQ = 1;
export const PDU_RESPONSE = 3;
const HEADER_BYTES = 10; // sync + 9-byte header
const MAX_PDU_TYPE = 5;

// Fixed object numbers every AES70 device carries (AES70-2 §"Managers").
export const ONO_DEVICE_MANAGER = 1;

// OcaStatus (AES70-2). Text used when a response carries a non-zero status.
const STATUS_NAMES: Record<number, string> = {
  0: 'OK',
  1: 'ProtocolVersionError',
  2: 'DeviceError',
  3: 'Locked',
  4: 'BadFormat',
  5: 'BadONo',
  6: 'ParameterError',
  7: 'ParameterOutOfRange',
  8: 'NotImplemented',
  9: 'InvalidRequest',
  10: 'ProcessingFailed',
  11: 'BadMethod',
  12: 'PartiallySucceeded',
  13: 'Timeout',
  14: 'BufferOverflow',
  15: 'PermissionDenied',
  16: 'OutOfMemory',
  17: 'Busy',
};

export function StatusName(Code: number): string {
  return STATUS_NAMES[Code] || `Status ${Code}`;
}

// OcaDeviceState bits (AES70-2, OcaDeviceManager.State).
export const DEVICE_STATE_BITS: Array<{ Bit: number; Name: string }> = [
  { Bit: 0x0001, Name: 'Operational' },
  { Bit: 0x0002, Name: 'Disabled' },
  { Bit: 0x0004, Name: 'Error' },
  { Bit: 0x0008, Name: 'Initializing' },
  { Bit: 0x0010, Name: 'Updating' },
];

export function DeviceStateFlags(State: number): string[] {
  return DEVICE_STATE_BITS.filter((Entry) => (State & Entry.Bit) !== 0).map((E) => E.Name);
}

// --- Encoding ------------------------------------------------------------------

/**
 * One CommandResponseRequired PDU, wrapped in its own message. Params are the
 * already-encoded parameter bytes and ParamCount how many parameters they hold
 * (both empty for a Get).
 */
export function EncodeCommand(
  Handle: number,
  TargetONo: number,
  DefLevel: number,
  MethodIndex: number,
  Params: Buffer = Buffer.alloc(0),
  ParamCount = 0
): Buffer {
  const PduBytes = 17 + Params.length;
  const Out = Buffer.alloc(HEADER_BYTES + PduBytes);
  let Pos = 0;
  Out.writeUInt8(OCP1_SYNC, Pos);
  Pos += 1;
  Out.writeUInt16BE(OCP1_PROTOCOL_VERSION, Pos);
  Pos += 2;
  Out.writeUInt32BE(Out.length - 1, Pos);
  Pos += 4;
  Out.writeUInt8(PDU_COMMAND_RRQ, Pos);
  Pos += 1;
  Out.writeUInt16BE(1, Pos);
  Pos += 2;
  Out.writeUInt32BE(PduBytes, Pos);
  Pos += 4;
  Out.writeUInt32BE(Handle >>> 0, Pos);
  Pos += 4;
  Out.writeUInt32BE(TargetONo >>> 0, Pos);
  Pos += 4;
  Out.writeUInt16BE(DefLevel, Pos);
  Pos += 2;
  Out.writeUInt16BE(MethodIndex, Pos);
  Pos += 2;
  Out.writeUInt8(ParamCount & 0xff, Pos);
  Pos += 1;
  Params.copy(Out, Pos);
  return Out;
}

/** A parameterless Get. */
export function EncodeGetCommand(
  Handle: number,
  TargetONo: number,
  DefLevel: number,
  MethodIndex: number
): Buffer {
  return EncodeCommand(Handle, TargetONo, DefLevel, MethodIndex);
}

// --- Decoding ------------------------------------------------------------------

export interface Ocp1Response {
  Handle: number;
  StatusCode: number;
  ParamCount: number;
  Params: Buffer;
}

export class Ocp1FramingError extends Error {}

/**
 * Splits a byte stream into OCP.1 messages. Feed returns every Response PDU
 * completed by the new bytes; other PDU types (notifications, keep-alives) are
 * skipped. Throws Ocp1FramingError on bytes that cannot be OCP.1 at all.
 */
export class Ocp1Decoder {
  private Pending: Buffer = Buffer.alloc(0);
  /** At least one well-formed message has been decoded. */
  public SawMessage = false;

  constructor(private readonly MaxBytes: number) {}

  Feed(Chunk: Buffer): Ocp1Response[] {
    this.Pending = this.Pending.length ? Buffer.concat([this.Pending, Chunk]) : Chunk;
    const Out: Ocp1Response[] = [];
    for (;;) {
      if (this.Pending.length < 1) break;
      if (this.Pending[0] !== OCP1_SYNC) throw new Ocp1FramingError('Bad OCP.1 sync byte');
      if (this.Pending.length < HEADER_BYTES) break;
      const MessageSize = this.Pending.readUInt32BE(3);
      const PduType = this.Pending.readUInt8(7);
      const PduCount = this.Pending.readUInt16BE(8);
      if (MessageSize < HEADER_BYTES - 1) throw new Ocp1FramingError('Bad OCP.1 message size');
      if (PduType > MAX_PDU_TYPE) throw new Ocp1FramingError('Bad OCP.1 PDU type');
      const Total = MessageSize + 1;
      if (Total > this.MaxBytes) throw new Ocp1FramingError('OCP.1 message too large');
      if (this.Pending.length < Total) break;
      const Message = this.Pending.subarray(0, Total);
      this.Pending = this.Pending.subarray(Total);
      this.SawMessage = true;
      if (PduType !== PDU_RESPONSE) continue;
      let Pos = HEADER_BYTES;
      for (let I = 0; I < PduCount; I++) {
        if (Pos + 10 > Message.length) throw new Ocp1FramingError('Truncated OCP.1 response');
        const Size = Message.readUInt32BE(Pos);
        if (Size < 10 || Pos + Size > Message.length) {
          throw new Ocp1FramingError('Bad OCP.1 response size');
        }
        Out.push({
          Handle: Message.readUInt32BE(Pos + 4),
          StatusCode: Message.readUInt8(Pos + 8),
          ParamCount: Message.readUInt8(Pos + 9),
          Params: Message.subarray(Pos + 10, Pos + Size),
        });
        Pos += Size;
      }
    }
    return Out;
  }
}

// Parameter readers. Each returns null instead of throwing when the bytes run
// out, so a short or hostile reply reads as "unknown" rather than an exception.

export function ReadUint8(Params: Buffer, Pos = 0): number | null {
  return Pos + 1 <= Params.length ? Params.readUInt8(Pos) : null;
}

export function ReadUint16(Params: Buffer, Pos = 0): number | null {
  return Pos + 2 <= Params.length ? Params.readUInt16BE(Pos) : null;
}

export function ReadBoolean(Params: Buffer, Pos = 0): boolean | null {
  const Value = ReadUint8(Params, Pos);
  return Value == null ? null : Value !== 0;
}

/** An OcaString at Pos: { Value, Next } or null when truncated / malformed. */
export function ReadOcaString(Params: Buffer, Pos = 0): { Value: string; Next: number } | null {
  const Count = ReadUint16(Params, Pos);
  if (Count == null) return null;
  let End = Pos + 2;
  for (let I = 0; I < Count; I++) {
    const Lead = Params[End];
    if (Lead === undefined) return null;
    const Width = Lead < 0x80 ? 1 : Lead >= 0xf0 ? 4 : Lead >= 0xe0 ? 3 : Lead >= 0xc0 ? 2 : 0;
    if (!Width) return null; // a continuation byte where a character should start
    End += Width;
  }
  if (End > Params.length) return null;
  return { Value: Params.toString('utf8', Pos + 2, End), Next: End };
}

export interface ModelDescription {
  Manufacturer: string;
  Name: string;
  Version: string;
}

/** OcaModelDescription: three OcaStrings (Manufacturer, Name, Version). */
export function ReadModelDescription(Params: Buffer): ModelDescription | null {
  const Manufacturer = ReadOcaString(Params, 0);
  if (!Manufacturer) return null;
  const Name = ReadOcaString(Params, Manufacturer.Next);
  if (!Name) return null;
  const Version = ReadOcaString(Params, Name.Next);
  if (!Version) return null;
  return { Manufacturer: Manufacturer.Value, Name: Name.Value, Version: Version.Value };
}

// --- One-connection session ------------------------------------------------------

/** A command's outcome: the response, or why there is none. */
export type GetReply = { Ok: true; Params: Buffer } | { Ok: false; Error: string };

/** Issue one command. Params / ParamCount are omitted for a Get. */
export type Ocp1Call = (
  TargetONo: number,
  DefLevel: number,
  MethodIndex: number,
  Params?: Buffer,
  ParamCount?: number
) => Promise<GetReply>;

export type Ocp1Probe =
  | { Reachable: false; Error: string; Refused: boolean }
  | {
      Reachable: true;
      LatencyMs: number;
      // A well-formed OCP.1 message came back.
      IsAes70: boolean;
      // Set when the script did not finish inside the budget.
      Incomplete: boolean;
    };

class SessionEnded extends Error {}

/**
 * Connect, run Script (which issues commands through Call and records what it
 * reads in its own state), then close. Commands may be issued concurrently;
 * responses are matched by handle. BudgetMs caps the whole session.
 */
export function RunOcp1Session(
  Address: string,
  Port: number,
  BudgetMs: number,
  Script: (Call: Ocp1Call) => Promise<void>,
  MaxBytes = 1_000_000
): Promise<Ocp1Probe> {
  const Budget = Math.max(200, BudgetMs | 0);
  const Decoder = new Ocp1Decoder(MaxBytes);
  const Pending = new Map<number, (Reply: GetReply) => void>();
  const Failers = new Set<(Err: Error) => void>();
  let NextHandle = 1;
  let BytesSeen = 0;

  const Reached = (Session: TcpSession<Ocp1Probe>, Incomplete: boolean): Ocp1Probe => ({
    Reachable: true,
    LatencyMs: Date.now() - Session.StartedAt,
    IsAes70: Decoder.SawMessage,
    Incomplete,
  });

  const Unfinished = (Session: TcpSession<Ocp1Probe>, NoReplyError: string): Ocp1Probe =>
    BytesSeen ? Reached(Session, true) : { Reachable: false, Error: NoReplyError, Refused: false };

  return RunTcpSession<Ocp1Probe>({
    Address,
    Port,
    IdleMs: Budget,
    DeadlineMs: Budget,
    NoDelay: true,
    OnSettle: () => {
      for (const Fail of Failers) Fail(new SessionEnded('session ended'));
      Failers.clear();
      Pending.clear();
    },
    OnData: (Chunk, Session) => {
      BytesSeen += Chunk.length;
      let Responses: Ocp1Response[];
      try {
        Responses = Decoder.Feed(Chunk);
      } catch {
        // Not OCP.1: whatever answered is reachable but is not an AES70 device
        // (or, after good messages, has started talking nonsense, which leaves
        // the reads unfinished).
        Session.Finish(Reached(Session, Decoder.SawMessage));
        return;
      }
      for (const Response of Responses) {
        const Resolve = Pending.get(Response.Handle);
        if (!Resolve) continue;
        Pending.delete(Response.Handle);
        Resolve(
          Response.StatusCode === 0
            ? { Ok: true, Params: Response.ParamCount ? Response.Params : Buffer.alloc(0) }
            : { Ok: false, Error: StatusName(Response.StatusCode) }
        );
      }
    },
    OnTimeout: (Session) => Unfinished(Session, `No reply after ${Budget}ms`),
    OnError: (Message) => ({
      Reachable: false,
      Error: Message,
      Refused: Message.includes('ECONNREFUSED') || Message.includes('ECONNRESET'),
    }),
    OnClose: (Session) => Unfinished(Session, 'Connection closed before any reply'),
    OnConnect: (Session) => {
      const Call: Ocp1Call = (TargetONo, DefLevel, MethodIndex, Params, ParamCount) =>
        new Promise<GetReply>((Resolve, Reject) => {
          const Handle = NextHandle++;
          const Fail = (Err: Error) => Reject(Err);
          Failers.add(Fail);
          Pending.set(Handle, (Reply) => {
            Failers.delete(Fail);
            Resolve(Reply);
          });
          try {
            Session.Socket.write(
              EncodeCommand(Handle, TargetONo, DefLevel, MethodIndex, Params, ParamCount)
            );
          } catch (Err) {
            Failers.delete(Fail);
            Pending.delete(Handle);
            Reject(Err instanceof Error ? Err : new Error(String(Err)));
          }
        });

      void (async () => {
        try {
          await Script(Call);
          Session.Finish(Reached(Session, false));
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

export const _internal = { SessionEnded };
