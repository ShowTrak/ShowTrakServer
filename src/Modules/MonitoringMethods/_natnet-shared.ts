// NatNet wire codec (OptiTrack Motive's streaming / remote-command protocol).
//
// Source of truth: the official NatNet SDK direct-depacketization samples,
// which OptiTrack's NatNet 4.5 page names as the reference for the bitstream
// syntax: PacketClient.cpp and the PythonClient NatNetClient.py (SDK 4.5),
// plus NatNetTypes.h from the same SDK. Every layout below is copied from them;
// nothing is inferred from captures.
//
//   - Every datagram: uint16 LE message id, uint16 LE payload byte count, payload.
//   - Message ids: NAT_CONNECT 0, NAT_SERVERINFO 1, NAT_REQUEST 2, NAT_RESPONSE 3,
//     NAT_REQUEST_MODELDEF 4, NAT_MODELDEF 5, NAT_REQUEST_FRAMEOFDATA 6,
//     NAT_FRAMEOFDATA 7, NAT_MESSAGESTRING 8, NAT_DISCONNECT 9, NAT_KEEPALIVE 10,
//     NAT_UNRECOGNIZED_REQUEST 100.
//   - NAT_CONNECT payload (PacketClient): sSender (char[256] name, u8[4] app
//     version, u8[4] NatNet version, all zero from a client) + sConnectionOptions
//     (bool subscribedDataOnly, u8[4] BitstreamVersion) + 4 spare bytes = 273
//     bytes. A zero BitstreamVersion means "send your current version", so the
//     probe never asks Motive to change what it streams.
//   - NAT_SERVERINFO payload: sSender (264 bytes), then on NatNet 3.0+ servers
//     sSender_Server's tail (packed): u64 HighResClockFrequency, u16 DataPort,
//     bool IsMulticast, u8[4] MulticastGroupAddress: 279 bytes in all.
//   - NAT_REQUEST payload: NUL-terminated command string. The NAT_RESPONSE
//     carries no echo of the command: 4 bytes is a number (int or float
//     depending on the command), anything else a NUL-terminated string.
//   - NAT_MODELDEF: int32 dataset count, then per dataset int32 type and (on
//     NatNet 4.1+ only) an int32 byte size, then the description.
//   - NAT_FRAMEOFDATA: int32 frame number, marker sets, legacy "other" markers,
//     rigid bodies, etc. Each section starts with an int32 count; on NatNet 4.1+ an
//     int32 byte count of the section's data follows the count. A NatNet 3.0+
//     rigid body is int32 id, 3 floats position, 4 floats orientation, float mean
//     error, int16 params (bit 0 = tracking valid) = 38 bytes.
//
// Every parser here is bounds-checked and returns null rather than throwing on
// a short, truncated or garbage datagram: a stray packet must never take the
// probe down.

export const NAT_CONNECT = 0;
export const NAT_SERVERINFO = 1;
export const NAT_REQUEST = 2;
export const NAT_RESPONSE = 3;
export const NAT_REQUEST_MODELDEF = 4;
export const NAT_MODELDEF = 5;
export const NAT_FRAMEOFDATA = 7;
export const NAT_MESSAGESTRING = 8;
export const NAT_DISCONNECT = 9;
export const NAT_KEEPALIVE = 10;
export const NAT_UNRECOGNIZED_REQUEST = 100;

export const DEFAULT_COMMAND_PORT = 1510;
export const DEFAULT_DATA_PORT = 1511;
export const DEFAULT_MULTICAST_GROUP = '239.255.42.99';

const MAX_NAMELENGTH = 256;
const SENDER_BYTES = MAX_NAMELENGTH + 4 + 4; // sSender
const SERVER_INFO_FULL_BYTES = SENDER_BYTES + 8 + 2 + 1 + 4; // sSender_Server
const CONNECT_PAYLOAD_BYTES = SENDER_BYTES + 5 + 4; // as PacketClient sends it
// A NatNet 3.0+ rigid body in frame data.
export const RIGID_BODY_FRAME_BYTES = 4 + 12 + 16 + 4 + 2;
// Sanity cap on any element count read off the wire, so a garbage count can't
// make a parser spin before the bounds check catches it.
const MAX_COUNT = 100000;

// --- Encoding ---------------------------------------------------------------

function Packet(MessageId: number, Payload: Buffer): Buffer {
  const Head = Buffer.alloc(4);
  Head.writeUInt16LE(MessageId, 0);
  Head.writeUInt16LE(Payload.length, 2);
  return Buffer.concat([Head, Payload]);
}

// Header-only message (NAT_REQUEST_MODELDEF, NAT_KEEPALIVE, NAT_DISCONNECT).
export function EncodeSimple(MessageId: number): Buffer {
  return Packet(MessageId, Buffer.alloc(0));
}

// NAT_CONNECT exactly as PacketClient builds it, all zero: an anonymous sender,
// subscribedDataOnly = false and BitstreamVersion 0.0.0.0 (server's current).
export function EncodeConnect(): Buffer {
  return Packet(NAT_CONNECT, Buffer.alloc(CONNECT_PAYLOAD_BYTES));
}

export function EncodeRequest(Command: string): Buffer {
  return Packet(NAT_REQUEST, Buffer.concat([Buffer.from(Command, 'utf8'), Buffer.from([0])]));
}

// --- Bounds-checked reader --------------------------------------------------

class OutOfBounds extends Error {}

class Reader {
  Pos: number;
  constructor(
    private readonly Buf: Buffer,
    Start = 0,
    private readonly End = Buf.length
  ) {
    this.Pos = Start;
  }

  private Need(N: number): void {
    if (N < 0 || this.Pos + N > this.End) throw new OutOfBounds();
  }

  I32(): number {
    this.Need(4);
    const V = this.Buf.readInt32LE(this.Pos);
    this.Pos += 4;
    return V;
  }

  I16(): number {
    this.Need(2);
    const V = this.Buf.readInt16LE(this.Pos);
    this.Pos += 2;
    return V;
  }

  F32(): number {
    this.Need(4);
    const V = this.Buf.readFloatLE(this.Pos);
    this.Pos += 4;
    return V;
  }

  Skip(N: number): void {
    this.Need(N);
    this.Pos += N;
  }

  // A count field: non-negative and sane, or the packet is not what we think.
  Count(): number {
    const N = this.I32();
    if (N < 0 || N > MAX_COUNT) throw new OutOfBounds();
    return N;
  }

  // NUL-terminated UTF-8 string. A missing terminator is a malformed packet.
  CStr(): string {
    const Nul = this.Buf.indexOf(0, this.Pos);
    if (Nul < 0 || Nul >= this.End) throw new OutOfBounds();
    const S = this.Buf.toString('utf8', this.Pos, Nul);
    this.Pos = Nul + 1;
    return S.length > MAX_NAMELENGTH ? S.slice(0, MAX_NAMELENGTH) : S;
  }
}

// --- Decoding ---------------------------------------------------------------

export interface NatNetPacket {
  MessageId: number;
  // The payload, clamped to what actually arrived (a truncated datagram yields
  // a shorter payload; the parsers' bounds checks take it from there).
  Payload: Buffer;
  Truncated: boolean;
}

export function ParsePacket(Buf: Buffer): NatNetPacket | null {
  if (!Buffer.isBuffer(Buf) || Buf.length < 4) return null;
  const Declared = Buf.readUInt16LE(2);
  const End = Math.min(Buf.length, 4 + Declared);
  return {
    MessageId: Buf.readUInt16LE(0),
    Payload: Buf.subarray(4, End),
    Truncated: Buf.length < 4 + Declared,
  };
}

export type Version4 = [number, number, number, number];

export interface ServerInfo {
  AppName: string;
  AppVersion: Version4;
  NatNetVersion: Version4;
  // Present only from NatNet 3.0+ servers (the sSender_Server tail).
  Connection: {
    DataPort: number;
    Multicast: boolean;
    MulticastGroup: string;
  } | null;
}

function ReadVersion(Buf: Buffer, At: number): Version4 {
  return [Buf[At] ?? 0, Buf[At + 1] ?? 0, Buf[At + 2] ?? 0, Buf[At + 3] ?? 0];
}

export function ParseServerInfo(Payload: Buffer): ServerInfo | null {
  if (!Buffer.isBuffer(Payload) || Payload.length < SENDER_BYTES) return null;
  const NameEnd = Payload.indexOf(0);
  const AppName = Payload.toString(
    'utf8',
    0,
    NameEnd >= 0 && NameEnd < MAX_NAMELENGTH ? NameEnd : MAX_NAMELENGTH
  );
  const NatNetVersion = ReadVersion(Payload, MAX_NAMELENGTH + 4);
  let Connection: ServerInfo['Connection'] = null;
  if (Payload.length >= SERVER_INFO_FULL_BYTES && NatNetVersion[0] >= 3) {
    const DataPort = Payload.readUInt16LE(SENDER_BYTES + 8);
    const Group = ReadVersion(Payload, SENDER_BYTES + 11).join('.');
    Connection = {
      DataPort: DataPort > 0 ? DataPort : DEFAULT_DATA_PORT,
      Multicast: Payload[SENDER_BYTES + 10] !== 0,
      MulticastGroup: Group === '0.0.0.0' ? DEFAULT_MULTICAST_GROUP : Group,
    };
  }
  return {
    AppName: AppName.replace(/\s+$/, ''),
    AppVersion: ReadVersion(Payload, MAX_NAMELENGTH),
    NatNetVersion,
    Connection,
  };
}

// "3.1.0.0" -> "3.1", "3.0.1.0" -> "3.0.1": trailing zero parts after the
// minor version add nothing.
export function FormatVersion(V: Version4 | null | undefined): string | null {
  if (!Array.isArray(V)) return null;
  const Parts = V.slice();
  while (Parts.length > 2 && Parts[Parts.length - 1] === 0) Parts.pop();
  return Parts.join('.');
}

// Per-section byte counts in frame data (and per-description sizes in the model
// list) exist from NatNet 4.1.
export function HasSectionSizes(Major: number, Minor: number): boolean {
  return Major > 4 || (Major === 4 && Minor >= 1);
}

export type ResponseKind = 'int' | 'float' | 'string';

// Decode a NAT_RESPONSE payload as the kind the command returns. Null when the
// payload is not that shape (so the caller can tell it is not this request's
// answer). PacketClient: 4 bytes = number, otherwise a string.
export function DecodeResponse(Payload: Buffer, Kind: ResponseKind): number | string | null {
  if (!Buffer.isBuffer(Payload)) return null;
  if (Kind === 'string') {
    if (Payload.length === 4 || Payload.length === 0) return null;
    const Nul = Payload.indexOf(0);
    return Payload.toString('utf8', 0, Nul >= 0 ? Nul : Payload.length);
  }
  if (Payload.length !== 4) return null;
  return Kind === 'int' ? Payload.readInt32LE(0) : Payload.readFloatLE(0);
}

// --- Model definitions ------------------------------------------------------

export interface RigidBodyDef {
  Id: number;
  Name: string;
}

export interface ModelDefs {
  RigidBodies: RigidBodyDef[];
  // False when the walk had to stop early (a description type the parser does
  // not know on a pre-4.1 stream, or a size that disagreed with the parse), so
  // a name that is missing may simply not have been reached.
  Complete: boolean;
}

// One rigid body description (PacketClient UnpackRigidBodyDescription, NatNet
// 3.0+): name, id, parent id, position offset, rotation offset (4.2+), marker
// count, marker positions, required labels, marker names (4.0+).
function ReadRigidBodyDescription(R: Reader, Major: number, Minor: number): RigidBodyDef {
  const Name = R.CStr();
  const Id = R.I32();
  R.Skip(4 + 12); // parent id, position offset
  if (Major > 4 || (Major === 4 && Minor >= 2)) R.Skip(16); // rotation offset
  const Markers = R.Count();
  R.Skip(Markers * 12 + Markers * 4);
  if (Major >= 4) for (let I = 0; I < Markers; I++) R.CStr();
  return { Id, Name };
}

// Walk NAT_MODELDEF for the top-level rigid body descriptions (type 1). Marker
// sets (0) and skeletons (2) are parsed through exactly as the samples do;
// other types are skipped by their declared size on NatNet 4.1+, and end the
// walk on older streams (which carry no size). On 4.1+ the size of every parsed
// description is checked against what the parse consumed, which also confirms
// that skipping by size lands on the next description. Null for NatNet < 3.
export function ParseModelDefs(Payload: Buffer, Major: number, Minor: number): ModelDefs | null {
  if (!Buffer.isBuffer(Payload) || Major < 3) return null;
  const Sized = HasSectionSizes(Major, Minor);
  const Out: ModelDefs = { RigidBodies: [], Complete: true };
  const R = new Reader(Payload);
  try {
    const Count = R.Count();
    for (let I = 0; I < Count; I++) {
      const Type = R.I32();
      const Size = Sized ? R.I32() : null;
      const Start = R.Pos;
      if (Type === 0) {
        R.CStr();
        const Markers = R.Count();
        for (let M = 0; M < Markers; M++) R.CStr();
      } else if (Type === 1) {
        Out.RigidBodies.push(ReadRigidBodyDescription(R, Major, Minor));
      } else if (Type === 2) {
        R.CStr();
        R.Skip(4); // skeleton id
        const Bones = R.Count();
        for (let B = 0; B < Bones; B++) ReadRigidBodyDescription(R, Major, Minor);
      } else if (Size != null && Size >= 0) {
        R.Skip(Size);
        continue;
      } else {
        Out.Complete = false;
        break;
      }
      if (Size != null && R.Pos - Start !== Size) {
        Out.Complete = false;
        break;
      }
    }
  } catch {
    // A truncated or garbled list: keep what parsed cleanly, but say so.
    Out.Complete = false;
  }
  return Out;
}

// --- Frame data -------------------------------------------------------------

export interface FrameRigidBody {
  Id: number;
  Tracked: boolean;
}

export interface FrameRigidBodies {
  FrameNumber: number;
  Bodies: FrameRigidBody[];
}

// Decode a NAT_FRAMEOFDATA payload as far as the rigid body section
// (PacketClient UnpackFrameData: prefix, marker sets, legacy other markers,
// rigid bodies). On NatNet 4.1+ every walked section is checked against its
// declared byte count, so a stream in a different bitstream version than the
// server info claims is rejected instead of misread. Null for NatNet < 3 and
// for anything malformed.
export function ParseFrameRigidBodies(
  Payload: Buffer,
  Major: number,
  Minor: number
): FrameRigidBodies | null {
  if (!Buffer.isBuffer(Payload) || Major < 3) return null;
  const Sized = HasSectionSizes(Major, Minor);
  const R = new Reader(Payload);
  try {
    const FrameNumber = R.I32();

    const MarkerSets = R.Count();
    let Declared = Sized ? R.I32() : null;
    let Start = R.Pos;
    for (let I = 0; I < MarkerSets; I++) {
      R.CStr();
      R.Skip(R.Count() * 12);
    }
    if (Declared != null && R.Pos - Start !== Declared) return null;

    const Others = R.Count();
    Declared = Sized ? R.I32() : null;
    Start = R.Pos;
    R.Skip(Others * 12);
    if (Declared != null && R.Pos - Start !== Declared) return null;

    const Count = R.Count();
    Declared = Sized ? R.I32() : null;
    if (Declared != null && Declared !== Count * RIGID_BODY_FRAME_BYTES) return null;
    const Bodies: FrameRigidBody[] = [];
    for (let I = 0; I < Count; I++) {
      const Id = R.I32();
      R.Skip(28 + 4); // position, orientation, mean error
      const Params = R.I16();
      Bodies.push({ Id, Tracked: (Params & 0x01) !== 0 });
    }
    return { FrameNumber, Bodies };
  } catch {
    return null;
  }
}

export const _internal = { Reader, OutOfBounds, SENDER_BYTES, SERVER_INFO_FULL_BYTES };
