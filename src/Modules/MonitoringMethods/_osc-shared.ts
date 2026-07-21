// Shared, dependency-free OSC (Open Sound Control) codec for the lighting-console
// monitoring family. Supports the two TCP framings the OSC 1.1 spec allows —
// SLIP (RFC 1055, double-ended) and int32 packet-length prefix (OSC 1.0) — plus
// unframed UDP packets, and encodes/decodes the handful of argument types a
// read-only status probe needs (string, int32, float32, booleans).
//
// ETC Eos speaks OSC natively (see ./_eos-shared). Eos defaults to the OSC 1.0
// length-prefix framing on TCP 3032, offers a SLIP-only port (3037), and both
// framings on the main port depending on the console's "OSC TCP Mode" setting —
// so the encode/decode here is framing-parameterised rather than hard-coded.
//
// The QLab check (via _qlab-shared) uses this same codec with SLIP framing; the
// console family additionally needs the OSC 1.0 length-prefix framing below.

// --- SLIP (RFC 1055) framing ------------------------------------------------

const SLIP_END = 0xc0;
const SLIP_ESC = 0xdb;
const SLIP_ESC_END = 0xdc;
const SLIP_ESC_ESC = 0xdd;

// The two TCP framings OSC allows. 'slip' = OSC 1.1 double-ended SLIP; 'length'
// = OSC 1.0 int32 big-endian packet-length prefix.
export type OscFraming = 'slip' | 'length';

function OscPad(Len: number): number {
  return (4 - (Len % 4)) % 4;
}

// --- Encoding ---------------------------------------------------------------

function EncodeOscString(Str: unknown): Buffer {
  const Body = Buffer.from(String(Str == null ? '' : Str), 'utf8');
  const WithNull = Buffer.concat([Body, Buffer.from([0])]);
  const Pad = OscPad(WithNull.length);
  return Pad ? Buffer.concat([WithNull, Buffer.alloc(Pad)]) : WithNull;
}

// An OSC argument to send. Numbers encode as int32 when integral, float32
// otherwise; booleans encode as the payload-free T/F tags; strings as OSC
// strings. Explicit { Int } / { Float } wrappers force a numeric encoding.
export type OscArg = string | number | boolean | { Int: number } | { Float: number };

function EncodeArg(Arg: OscArg): { Tag: string; Bytes: Buffer } {
  if (typeof Arg === 'string') return { Tag: 's', Bytes: EncodeOscString(Arg) };
  if (typeof Arg === 'boolean') return { Tag: Arg ? 'T' : 'F', Bytes: Buffer.alloc(0) };
  if (typeof Arg === 'number') {
    if (Number.isInteger(Arg)) {
      const Buf = Buffer.alloc(4);
      Buf.writeInt32BE(Arg | 0, 0);
      return { Tag: 'i', Bytes: Buf };
    }
    const Buf = Buffer.alloc(4);
    Buf.writeFloatBE(Arg, 0);
    return { Tag: 'f', Bytes: Buf };
  }
  if (Arg && typeof Arg === 'object' && 'Int' in Arg) {
    const Buf = Buffer.alloc(4);
    Buf.writeInt32BE(Number(Arg.Int) | 0, 0);
    return { Tag: 'i', Bytes: Buf };
  }
  const Buf = Buffer.alloc(4);
  Buf.writeFloatBE(Number((Arg as { Float: number }).Float), 0);
  return { Tag: 'f', Bytes: Buf };
}

// Encode a single OSC message (address + typed args) into a raw packet, with no
// transport framing applied.
export function EncodeOscMessage(Address: string, Args: OscArg[] = []): Buffer {
  let Tags = ',';
  const Payloads: Buffer[] = [];
  for (const Arg of Args) {
    const Encoded = EncodeArg(Arg);
    Tags += Encoded.Tag;
    if (Encoded.Bytes.length) Payloads.push(Encoded.Bytes);
  }
  return Buffer.concat([EncodeOscString(Address), EncodeOscString(Tags), ...Payloads]);
}

// Wrap a raw OSC packet in the chosen TCP framing.
export function FrameOscPacket(Packet: Buffer, Framing: OscFraming): Buffer {
  if (Framing === 'length') {
    const Header = Buffer.alloc(4);
    Header.writeUInt32BE(Packet.length, 0);
    return Buffer.concat([Header, Packet]);
  }
  // SLIP: END, escaped body, END.
  const Out: number[] = [SLIP_END];
  for (const Byte of Packet) {
    if (Byte === SLIP_END) Out.push(SLIP_ESC, SLIP_ESC_END);
    else if (Byte === SLIP_ESC) Out.push(SLIP_ESC, SLIP_ESC_ESC);
    else Out.push(Byte);
  }
  Out.push(SLIP_END);
  return Buffer.from(Out);
}

// Encode + frame an OSC message for TCP transport in one step.
export function EncodeOscTcp(Address: string, Args: OscArg[], Framing: OscFraming): Buffer {
  return FrameOscPacket(EncodeOscMessage(Address, Args), Framing);
}

// --- Decoding ---------------------------------------------------------------

export interface OscMessage {
  Address: string;
  Args: Array<string | number | boolean>;
}

function ReadOscString(Buf: Buffer, Offset: number): { Value: string; Next: number } {
  let End = Offset;
  while (End < Buf.length && Buf[End] !== 0) End++;
  const Value = Buf.toString('utf8', Offset, End);
  const LenWithNull = End - Offset + 1;
  const Next = Offset + LenWithNull + OscPad(LenWithNull);
  return { Value, Next };
}

// Parse a single OSC message packet into its address and decoded arguments.
// Non-scalar/unknown argument types are skipped over (their bytes are still
// consumed) so later scalar args remain reachable. Returns null for anything
// that is not a well-formed OSC message.
function ParseOscMessage(Packet: Buffer): OscMessage | null {
  try {
    const Addr = ReadOscString(Packet, 0);
    if (!Addr.Value.startsWith('/')) return null;
    const Tags = ReadOscString(Packet, Addr.Next);
    if (!Tags.Value.startsWith(',')) return null;
    const Args: Array<string | number | boolean> = [];
    let Pos = Tags.Next;
    for (let i = 1; i < Tags.Value.length; i++) {
      const Tag = Tags.Value[i];
      if (Tag === 's' || Tag === 'S') {
        const S = ReadOscString(Packet, Pos);
        Args.push(S.Value);
        Pos = S.Next;
      } else if (Tag === 'i' || Tag === 'r' || Tag === 'c' || Tag === 'm') {
        if (Pos + 4 > Packet.length) break;
        if (Tag === 'i') Args.push(Packet.readInt32BE(Pos));
        Pos += 4;
      } else if (Tag === 'f') {
        if (Pos + 4 > Packet.length) break;
        Args.push(Packet.readFloatBE(Pos));
        Pos += 4;
      } else if (Tag === 'h' || Tag === 't') {
        if (Pos + 8 > Packet.length) break;
        if (Tag === 'h') Args.push(Number(Packet.readBigInt64BE(Pos)));
        Pos += 8;
      } else if (Tag === 'd') {
        if (Pos + 8 > Packet.length) break;
        Args.push(Packet.readDoubleBE(Pos));
        Pos += 8;
      } else if (Tag === 'T') {
        Args.push(true);
      } else if (Tag === 'F') {
        Args.push(false);
      } else if (Tag === 'N' || Tag === 'I') {
        // Null / Impulse — no payload bytes, no meaningful value.
      } else if (Tag === 'b') {
        if (Pos + 4 > Packet.length) break;
        const Size = Packet.readUInt32BE(Pos);
        Pos += 4 + Size + OscPad(Size);
      } else {
        break;
      }
    }
    return { Address: Addr.Value, Args };
  } catch {
    return null;
  }
}

// Parse an OSC packet that may be a single message or a `#bundle`, flattening
// bundle elements (recursively) into a list of messages.
export function ParseOscPacket(Packet: Buffer): OscMessage[] {
  if (Packet.length >= 8 && Packet.toString('utf8', 0, 7) === '#bundle') {
    const Messages: OscMessage[] = [];
    // Skip the 8-byte '#bundle\0' tag and the 8-byte time tag.
    let Pos = 16;
    while (Pos + 4 <= Packet.length) {
      const Size = Packet.readUInt32BE(Pos);
      Pos += 4;
      if (Size <= 0 || Pos + Size > Packet.length) break;
      Messages.push(...ParseOscPacket(Packet.subarray(Pos, Pos + Size)));
      Pos += Size;
    }
    return Messages;
  }
  const Single = ParseOscMessage(Packet);
  return Single ? [Single] : [];
}

// Pull every complete framed packet out of an accumulated TCP stream buffer,
// decode each to OSC messages, and return the messages plus any trailing bytes
// that form an incomplete frame (to be prepended to the next chunk).
export function DecodeOscStream(
  Stream: Buffer,
  Framing: OscFraming
): { Messages: OscMessage[]; Rest: Buffer } {
  const Messages: OscMessage[] = [];
  if (Framing === 'length') {
    let Pos = 0;
    while (Pos + 4 <= Stream.length) {
      const Size = Stream.readUInt32BE(Pos);
      if (Size < 0 || Size > 10_000_000) {
        // Framing desync / bogus length — stop and let the caller time out.
        return { Messages, Rest: Buffer.alloc(0) };
      }
      if (Pos + 4 + Size > Stream.length) break; // incomplete packet
      Messages.push(...ParseOscPacket(Stream.subarray(Pos + 4, Pos + 4 + Size)));
      Pos += 4 + Size;
    }
    return { Messages, Rest: Stream.subarray(Pos) };
  }

  // SLIP: decode complete frames (delimited by END), keep the trailing partial.
  let Current: number[] = [];
  let Escaped = false;
  let LastEnd = -1; // index in Stream of the last END that closed a frame
  for (let i = 0; i < Stream.length; i++) {
    const Byte = Stream[i]!;
    if (Byte === SLIP_END) {
      if (Current.length) Messages.push(...ParseOscPacket(Buffer.from(Current)));
      Current = [];
      Escaped = false;
      LastEnd = i;
    } else if (Escaped) {
      Current.push(Byte === SLIP_ESC_END ? SLIP_END : Byte === SLIP_ESC_ESC ? SLIP_ESC : Byte);
      Escaped = false;
    } else if (Byte === SLIP_ESC) {
      Escaped = true;
    } else {
      Current.push(Byte);
    }
  }
  return { Messages, Rest: Stream.subarray(LastEnd + 1) };
}

export const _internal = {
  OscPad,
  EncodeOscString,
  EncodeOscMessage,
  FrameOscPacket,
  EncodeOscTcp,
  ParseOscPacket,
  DecodeOscStream,
};
