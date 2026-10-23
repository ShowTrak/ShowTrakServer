// PTZ camera check for Panasonic AW-series cameras (HTTP CGI) and Sony cameras
// (VISCA over IP). Built for the camera nobody notices has dropped into
// standby, or is reporting a fan / motor / temperature fault, until it is
// needed on air. A `Protocol` setting picks the vendor; every message the
// check itself sends is a QUERY. The operator actions (power, preset recall)
// are the only commands, and only ever sent from RunAction.
//
// Panasonic (Panasonic "HD/4K Integrated Camera Interface Specifications" and
// its Compatible Model Table, cross-checked against Bitfocus
// companion-module-panasonic-cameras):
//   GET /cgi-bin/aw_ptz?cmd=%23<cmd>&res=1 for the PT (`#`) commands and
//   GET /cgi-bin/aw_cam?cmd=<cmd>&res=1 for camera commands. The body is the
//   bare answer. Queries used:
//     #O    -> p0 standby, p1 on, p3 starting            (fingerprint)
//     QID   -> OID:<model>, e.g. OID:AW-UE150
//     QSV   -> OSV:<software version>
//     #RER  -> rER<hex>, 00 = normal, else the error code. Read as the
//              CURRENT error: the spec's error-notification section says the
//              camera posts "00 Normal" once it has recovered, so it does not
//              latch. (The query itself is not separately documented either way.)
//     QER   -> OER:<n>, 0 normal, 1 fan error, 2 other error (not every model)
//     #DA   -> dA0 / dA1, red tally
//   Refusals come back with HTTP 200 as ER1 (unsupported), ER2 (busy) or ER3
//   (out of range) followed by the command; the value is then simply unknown.
//   The specification asks for at least 130 ms between commands, so queries
//   are spaced that far apart. When the camera's control-command
//   authentication is on, it answers 401 with a Digest or Basic challenge;
//   both are supported (Digest via the BrightSign helper, MD5 / qop=auth).
//   Error codes differ per model (fan / temperature codes are swapped between
//   generations), so only codes that mean the same in every table of the spec
//   are named; the rest are shown as their hex code.
//
// Sony (Sony "VISCA Command List" for the BRC-X400 / X401 / SRG-X400 range,
// whose "VISCA over IP" section defines the framing; model IDs from the other
// Sony command lists collected in Bitfocus companion-module-sony-visca/protocol):
//   UDP 52381. Each message is an 8-byte header — payload type, payload
//   length, 32-bit sequence number — then the VISCA bytes. Sony's payload
//   types: 0x0100 VISCA command, 0x0110 VISCA inquiry, 0x0111 VISCA reply,
//   0x0120 VISCA device setting command (CAM_VersionInq is one of those),
//   0x0200 / 0x0201 control command / reply. The reply echoes the sequence
//   number. Messages used by the check:
//     CAM_PowerInq        81 09 04 00 FF -> 90 50 02 FF on / 03 standby (fingerprint)
//     CAM_VersionInq      81 09 00 02 FF -> 90 50 GGGG HHHH JJJJ KK FF
//                          (vendor, model, ROM revision, sockets; sent as a
//                          device setting command, 0x0120, as Sony lists it)
//     CAM_PanTiltStatusInq 81 09 06 10 FF -> 90 50 pp pp FF (mechanism status bits)
//     CAM_TallyInq        81 09 7E 01 0A FF -> 90 50 02 FF on / 03 off (some models)
//   `90 6z ee FF` is an error reply (02 syntax = not supported, 41 not
//   executable now); that value is then unknown. The pan/tilt status word is
//   what Sony exposes as a fault: "pan / tilt mechanism is defective" and
//   "initialization failed". No sequence RESET is ever sent — it would also
//   reset the counter another controller (Companion, a joystick) relies on.
//   Not documented by Sony: whether replies go to the sending port or always
//   to 52381 (the command list names only the camera's port). Companion's
//   module receives on a socket bound to 52381, so the reply port is an
//   advanced setting.
//
// Actions (RunAction only):
//   power.on / power.standby — Panasonic #O1 / #O0 (answers p1 / p0); Sony
//     CAM_Power 81 01 04 00 02 / 03 FF.
//   preset.recall — Panasonic #R00–#R99 for presets 1–100 (answers s<nn>);
//     Sony preset RECALL 81 01 04 3F 02 pp FF with pp = preset number - 1,
//     as the BRC-X400 list numbers them (00–63h, presets 1–100; older models
//     with fewer memories answer a syntax error for higher numbers).
//   Sony commands go out as payload type 0x0100. The camera answers ACK
//   (90 4z FF) then Completion (90 5z FF), or an error (90 6z ee FF); the
//   first of these settles the action, since completion of a power-on or a
//   long preset move can take longer than the timeout.
//
// Assertions:
//   - CheckStandby (default ON): a camera in standby is not on air.
//   - CheckErrors (default ON): an error the camera reports.
import dgram from 'dgram';
import dns from 'dns';
import http from 'http';
import crypto from 'crypto';
import { Manager as CacheManager } from '../CacheManager';
import {
  BmdStatePill,
  MonoRow,
  ResolveSnapshotTtlMs,
  ResolveTimeoutMs,
  TimeoutSetting,
} from './_blackmagic-shared';
import { BuildDigestHeader, ParseDigestChallenge } from './_brightsign-shared';
import { FormatLatency, Note, Pill, Row, Rows, TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type {
  MonitoringActionDef,
  MonitoringActionResult,
  MonitoringResult,
  MonitoringSettingField,
  MonitoringTargetLike,
} from './types';

const ID = 'ptz-camera';
const DEFAULT_HTTP_PORT = 80;
const DEFAULT_VISCA_PORT = 52381;
// "Leave a gap of at least 130 ms between each command" (Panasonic spec).
const PANASONIC_GAP_MS = 130;
const MAX_BODY_BYTES = 16 * 1024;

export type PtzProtocol = 'panasonic' | 'sony';

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Protocol',
    Label: 'Protocol',
    Type: 'select',
    Default: 'panasonic',
    Options: [
      { value: 'panasonic', label: 'Panasonic (HTTP)' },
      { value: 'sony', label: 'Sony (VISCA over IP)' },
    ],
    Required: true,
  },
  {
    Key: 'Port',
    Label: 'HTTP port',
    Type: 'number',
    Default: DEFAULT_HTTP_PORT,
    Min: 1,
    Max: 65535,
    VisibleWhen: { Key: 'Protocol', Equals: 'panasonic' },
  },
  {
    Key: 'Username',
    Label: 'Username',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'Protocol', Equals: 'panasonic' },
    Note: 'Only needed when the camera requires authentication for control commands. Leave it blank otherwise.',
  },
  {
    Key: 'Password',
    Label: 'Password',
    Type: 'string',
    Default: '',
    Sensitive: true,
    VisibleWhen: { Key: 'Protocol', Equals: 'panasonic' },
  },
  {
    Key: 'ViscaPort',
    Label: 'VISCA port',
    Type: 'number',
    Default: DEFAULT_VISCA_PORT,
    Min: 1,
    Max: 65535,
    VisibleWhen: { Key: 'Protocol', Equals: 'sony' },
  },
  {
    Key: 'ReplyPort',
    Label: 'Receive replies on',
    Type: 'select',
    Default: 'any',
    Options: [
      { value: 'any', label: 'Any free port' },
      { value: 'visca', label: 'UDP 52381' },
    ],
    Advanced: true,
    VisibleWhen: { Key: 'Protocol', Equals: 'sony' },
    Note: 'Choose UDP 52381 if the camera answers other controllers but never this check. It cannot be shared with another VISCA controller on this computer.',
  },
  {
    Key: 'CheckStandby',
    Label: 'Check standby',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded when the camera is in standby.',
  },
  {
    Key: 'CheckErrors',
    Label: 'Check errors',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded when the camera reports an error, such as a fan, temperature or pan/tilt fault.',
  },
  TimeoutSetting(),
];

// --- Shared snapshot shape ------------------------------------------------------

export interface PtzSnapshot {
  Reachable: boolean;
  Error?: string;
  LatencyMs?: number;
  Protocol: PtzProtocol;
  /** The power reply proved this is a camera of the chosen protocol. */
  IsCamera: boolean;
  /** The camera wants a login (none configured, or it was refused). */
  AuthFailed: boolean;
  Power: 'on' | 'standby' | 'starting' | null;
  Model: string | null;
  Firmware: string | null;
  /** Red tally, where queryable. */
  Tally: boolean | null;
  /** Reported faults, as plain sentences. */
  Faults: string[];
  /** Panasonic #RER code (hex) when non-zero. */
  ErrorCode: string | null;
  /** Sony pan/tilt status word, when read. */
  PanTiltStatus: number | null;
  /** Queries the camera refused, e.g. `QSV: ER1 (not supported)`. */
  Refused: string[];
  Incomplete: string | null;
}

function EmptySnapshot(Protocol: PtzProtocol): PtzSnapshot {
  return {
    Reachable: false,
    Protocol,
    IsCamera: false,
    AuthFailed: false,
    Power: null,
    Model: null,
    Firmware: null,
    Tally: null,
    Faults: [],
    ErrorCode: null,
    PanTiltStatus: null,
    Refused: [],
    Incomplete: null,
  };
}

// --- Panasonic --------------------------------------------------------------------

const PANASONIC_REFUSALS: Record<string, string> = {
  '1': 'not supported',
  '2': 'busy',
  '3': 'out of range',
};

// #RER codes that mean the same thing in every model table of the spec. Fan
// and temperature codes (31h–36h) do not: on the HE50 / HE60, 31h–33h are
// self-test results, so those are left as bare codes.
const PANASONIC_ERRORS: Record<string, string> = {
  '03': 'Motor driver error',
  '04': 'Pan sensor error',
  '05': 'Tilt sensor error',
  '21': 'System error',
  '22': 'Pan/tilt limit exceeded',
  '23': 'FPGA configuration error',
};

/** `ER2:QSV` -> refusal code, or null for an ordinary answer. */
export function ParsePanasonicRefusal(Body: string): string | null {
  const Match = /^[eE][rR]([123])(?::|$)/.exec(Body.trim());
  return Match ? (Match[1] as string) : null;
}

export function ParsePanasonicPower(Body: string): PtzSnapshot['Power'] | undefined {
  const Match = /^p(\d)$/.exec(Body.trim());
  if (!Match) return undefined;
  if (Match[1] === '1') return 'on';
  if (Match[1] === '0') return 'standby';
  if (Match[1] === '3') return 'starting';
  return null;
}

/** `rER00` -> '00'; null when the body is not an rER answer. */
export function ParsePanasonicRer(Body: string): string | null {
  const Match = /^rER([0-9A-Fa-f]{2})$/.exec(Body.trim());
  return Match ? (Match[1] as string).toUpperCase() : null;
}

/** `OID:AW-UE150` -> 'AW-UE150' for the expected prefix. */
export function ParsePanasonicValue(Body: string, Prefix: string): string | null {
  const Trimmed = Body.trim();
  if (!Trimmed.startsWith(`${Prefix}:`)) return null;
  const Value = Trimmed.slice(Prefix.length + 1).trim();
  return Value || null;
}

export function DescribePanasonicError(Code: string): string {
  const Name = PANASONIC_ERRORS[Code];
  return Name ? `${Name} (${Code}h)` : `Error code ${Code}h`;
}

interface HttpReply {
  Status: number;
  Body: string;
  Headers: http.IncomingHttpHeaders;
}

function HttpGet(
  Address: string,
  Port: number,
  Path: string,
  BudgetMs: number,
  Authorization: string | null
): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    let Settled = false;
    let Req: http.ClientRequest | null = null;
    const Wait = Math.max(1, BudgetMs | 0);
    const Finish = (Err: Error | null, Reply?: HttpReply) => {
      if (Settled) return;
      Settled = true;
      clearTimeout(Timer);
      if (Err) {
        try {
          Req?.destroy();
        } catch {
          // Already gone.
        }
        reject(Err);
      } else resolve(Reply as HttpReply);
    };
    const Timer = setTimeout(() => Finish(new Error(`No reply after ${Wait}ms`)), Wait);
    try {
      Req = http.request({
        host: Address,
        port: Port,
        method: 'GET',
        path: Path,
        headers: {
          'User-Agent': 'ShowTrak-Monitoring/1.0',
          Connection: 'close',
          ...(Authorization ? { Authorization } : {}),
        },
      });
    } catch (Err) {
      Finish(Err instanceof Error ? Err : new Error(String(Err)));
      return;
    }
    Req.on('error', (Err) => Finish(Err));
    Req.on('response', (Res) => {
      const Chunks: Buffer[] = [];
      let Bytes = 0;
      Res.on('data', (Chunk: Buffer) => {
        Bytes += Chunk.length;
        if (Bytes <= MAX_BODY_BYTES) Chunks.push(Chunk);
      });
      Res.on('end', () =>
        Finish(null, {
          Status: Res.statusCode || 0,
          Body: Buffer.concat(Chunks).toString('latin1'),
          Headers: Res.headers,
        })
      );
      Res.on('error', (Err) => Finish(Err));
    });
    Req.end();
  });
}

const Sleep = (Ms: number) => new Promise((R) => setTimeout(R, Math.max(0, Ms)));

// One Panasonic control conversation: the 130 ms spacing, the 401 challenge /
// retry and the reachability bookkeeping, shared by the probe and the actions.
export interface PanasonicAnswer {
  /** The trimmed body of an ordinary answer. */
  Body?: string;
  /** ER1 / ER2 / ER3 refusal code. */
  Refusal?: string;
  /** Any HTTP status other than 200 / 401. */
  Status?: number;
}

export function CreatePanasonicClient(
  Address: string,
  Port: number,
  Username: string,
  Password: string,
  Deadline: number
) {
  const Remaining = () => Deadline - Date.now();
  const State = {
    Reachable: false,
    AuthFailed: false,
    LastError: '',
    FirstReplyAt: null as number | null,
  };
  let Challenge: Record<string, string> | 'basic' | null = null;
  let Nc = 0;
  // When the previous command's reply (or failure) came back. The gap is timed
  // from here, not from the send: each command opens a new connection, so a
  // slow connect would otherwise land two commands closer than 130 ms apart.
  let LastDoneAt = 0;

  const AuthHeader = (Path: string): string | null => {
    if (!Challenge || (!Username && !Password)) return null;
    if (Challenge === 'basic') {
      return `Basic ${Buffer.from(`${Username}:${Password}`, 'utf8').toString('base64')}`;
    }
    Nc++;
    return BuildDigestHeader(
      Challenge,
      'GET',
      Path,
      Username,
      Password,
      crypto.randomBytes(8).toString('hex'),
      Nc.toString(16).padStart(8, '0')
    );
  };

  // One command. Undefined when no usable answer came (transport failure,
  // budget spent, or the login was refused — see State).
  const Ask = async (Path: string): Promise<PanasonicAnswer | undefined> => {
    for (let Attempt = 0; Attempt < 2; Attempt++) {
      // Respect the spec's minimum gap between commands, including the
      // authenticated retry after a 401.
      const Gap = LastDoneAt ? PANASONIC_GAP_MS - (Date.now() - LastDoneAt) : 0;
      if (Gap > 0) {
        if (Remaining() <= Gap) return undefined;
        await Sleep(Gap);
      }
      if (Remaining() <= 0) return undefined;
      let Reply: HttpReply;
      try {
        Reply = await HttpGet(Address, Port, Path, Remaining(), AuthHeader(Path));
      } catch (Err) {
        State.LastError = Err instanceof Error ? Err.message : String(Err);
        return undefined;
      } finally {
        LastDoneAt = Date.now();
      }
      if (State.FirstReplyAt === null) State.FirstReplyAt = Date.now();
      State.Reachable = true;
      if (Reply.Status === 401) {
        const Header = String(Reply.Headers['www-authenticate'] || '');
        const Digest = ParseDigestChallenge(Header);
        // Retry once with credentials; a second 401 (or none configured) is a refusal.
        if (Attempt === 0 && (Username || Password)) {
          Challenge = Digest || 'basic';
          continue;
        }
        State.AuthFailed = true;
        return undefined;
      }
      if (Reply.Status !== 200) return { Status: Reply.Status };
      const Body = Reply.Body.trim();
      const Refusal = ParsePanasonicRefusal(Body);
      return Refusal ? { Refusal } : { Body };
    }
    return undefined;
  };

  return { Ask, State };
}

const PtzPath = (Cmd: string) => `/cgi-bin/aw_ptz?cmd=%23${Cmd}&res=1`;
const CamPath = (Cmd: string) => `/cgi-bin/aw_cam?cmd=${Cmd}&res=1`;

export async function QueryPanasonic(
  Address: string,
  Port: number,
  Username: string,
  Password: string,
  TimeoutMs: number
): Promise<PtzSnapshot> {
  const BudgetMs = Math.max(500, TimeoutMs | 0);
  const Started = Date.now();
  const Snap = EmptySnapshot('panasonic');
  const Client = CreatePanasonicClient(Address, Port, Username, Password, Started + BudgetMs);
  let Step = 'power';

  // One query. Returns the body, or null when the camera refused it (or
  // answered with another HTTP status), or undefined when no answer came.
  const Ask = async (Name: string, Path: string): Promise<string | null | undefined> => {
    Step = Name;
    const Answer = await Client.Ask(Path);
    Snap.Reachable = Client.State.Reachable;
    Snap.AuthFailed = Client.State.AuthFailed;
    if (!Answer) return undefined;
    if (Answer.Refusal) {
      Snap.Refused.push(`${Name}: ER${Answer.Refusal} (${PANASONIC_REFUSALS[Answer.Refusal]})`);
      return null;
    }
    return Answer.Body ?? null;
  };

  const Finish = (): PtzSnapshot => {
    if (!Snap.Reachable) {
      return {
        ...Snap,
        Error: Client.State.LastError || `No reply from the camera after ${BudgetMs}ms`,
      };
    }
    return { ...Snap, LatencyMs: (Client.State.FirstReplyAt ?? Date.now()) - Started };
  };

  const PowerBody = await Ask('power', PtzPath('O'));
  if (PowerBody === undefined) {
    if (Snap.Reachable && !Snap.AuthFailed) Snap.Incomplete = Step;
    return Finish();
  }
  const Power = PowerBody === null ? undefined : ParsePanasonicPower(PowerBody);
  if (Power === undefined) return Finish(); // Answered, but not with a power state.
  Snap.IsCamera = true;
  Snap.Power = Power;

  const Steps: Array<[string, string, (Body: string) => void]> = [
    ['model', CamPath('QID'), (B) => (Snap.Model = ParsePanasonicValue(B, 'OID'))],
    ['software version', CamPath('QSV'), (B) => (Snap.Firmware = ParsePanasonicValue(B, 'OSV'))],
    [
      'error information',
      PtzPath('RER'),
      (B) => {
        const Code = ParsePanasonicRer(B);
        if (Code && Code !== '00') {
          Snap.ErrorCode = Code;
          Snap.Faults.push(DescribePanasonicError(Code));
        }
      },
    ],
    [
      'camera error',
      CamPath('QER'),
      (B) => {
        const Value = ParsePanasonicValue(B, 'OER');
        const N = Value == null ? NaN : parseInt(Value, 16);
        if (N === 1) Snap.Faults.push('Fan error');
        else if (Number.isFinite(N) && N > 1) Snap.Faults.push('Camera error');
      },
    ],
    [
      'tally',
      PtzPath('DA'),
      (B) => {
        const Match = /^dA([01])$/.exec(B);
        if (Match) Snap.Tally = Match[1] === '1';
      },
    ],
  ];
  for (const [Name, Path, Apply] of Steps) {
    const Body = await Ask(Name, Path);
    if (Body === undefined) {
      Snap.Incomplete = Snap.AuthFailed ? null : Step;
      break;
    }
    if (Body !== null) Apply(Body);
  }
  return Finish();
}

// --- Sony VISCA over IP ---------------------------------------------------------

// Payload types, from the VISCA over IP section of Sony's BRC-X400 / SRG-X400
// VISCA Command List: 0x0100 VISCA command, 0x0110 VISCA inquiry, 0x0111 VISCA
// reply, 0x0120 VISCA device setting command (Address Set, IF_Clear and
// CAM_VersionInq), 0x0200 control command, 0x0201 control reply.
export const VISCA_COMMAND = 0x0100;
export const VISCA_INQUIRY = 0x0110;
const VISCA_REPLY = 0x0111;
export const VISCA_DEVICE_SETTING = 0x0120;
const VISCA_CONTROL_REPLY = 0x0201;

// Sony model IDs from CAM_VersionInq, per Companion sony-visca's
// protocol/VISCA_vendor_model_ids.html (sourced from each model's Sony manual).
const SONY_MODELS: Record<string, string> = {
  '0511': 'SRG-120DH',
  '0513': 'SRG-300H',
  '0516': 'SRG-300SE / SRG-301SE / SRG-201SE',
  '0604': 'SRG-360SHE',
  '0605': 'SRG-280SHE',
  '0519': 'BRC-X1000',
  '051A': 'BRC-H800',
  '051B': 'BRC-H780',
  '051C': 'BRC-X400',
  '051D': 'BRC-X401',
  '051E': 'ILME-FR7',
  '051F': 'BRC-AM7',
  '0617': 'SRG-X400',
  '0618': 'SRG-X120',
  '061A': 'SRG-201M2',
  '061B': 'SRG-HD1M2',
  '061C': 'SRG-X402',
  '061F': 'SRG-X40UH',
  '0620': 'SRG-H40UH',
  '0621': 'SRG-A40',
  '0622': 'SRG-A12',
};

const SONY_ERRORS: Record<number, string> = {
  0x01: 'message length error',
  0x02: 'not supported',
  0x03: 'command buffer full',
  0x41: 'not executable now',
};

let ViscaSequence = Math.floor(Math.random() * 0x10000);
function NextSequence(): number {
  ViscaSequence = (ViscaSequence + 1) >>> 0;
  if (ViscaSequence === 0) ViscaSequence = 1;
  return ViscaSequence;
}

export function BuildViscaPacket(
  Sequence: number,
  Payload: number[],
  Type: number = VISCA_INQUIRY
): Buffer {
  const Buf = Buffer.alloc(8 + Payload.length);
  Buf.writeUInt16BE(Type, 0);
  Buf.writeUInt16BE(Payload.length, 2);
  Buf.writeUInt32BE(Sequence >>> 0, 4);
  Buffer.from(Payload).copy(Buf, 8);
  return Buf;
}

export interface ViscaReply {
  Type: number;
  Sequence: number;
  Payload: Buffer;
}

/** Split one datagram into header + payload; null when it is not VISCA over IP. */
export function ParseViscaPacket(Msg: Buffer): ViscaReply | null {
  if (Msg.length < 9) return null;
  const Length = Msg.readUInt16BE(2);
  if (Length < 1 || 8 + Length > Msg.length) return null;
  return {
    Type: Msg.readUInt16BE(0),
    Sequence: Msg.readUInt32BE(4),
    Payload: Msg.subarray(8, 8 + Length),
  };
}

/** Decode the CAM_PanTiltStatusInq word into faults (Sony "Pan/Tilt Status Code" table). */
export function SonyPanTiltFaults(Word: number): string[] {
  const Out: string[] = [];
  if (((Word >> 4) & 3) === 1) Out.push('Pan mechanism is defective');
  if (((Word >> 8) & 3) === 1) Out.push('Tilt mechanism is defective');
  if (((Word >> 12) & 3) === 3) Out.push('Pan/tilt initialization failed');
  return Out;
}

// One VISCA over IP conversation on its own UDP socket, shared by the probe
// and the actions. Replies are matched on the sequence number and the
// camera's address; anything else on the socket is somebody else's.
interface ViscaSession {
  Send(Type: number, Payload: number[], WaitMs: number): Promise<ViscaReply | null>;
  Close(): void;
  LastError(): string;
}

async function OpenViscaSession(
  Address: string,
  Port: number,
  BindVisca: boolean
): Promise<ViscaSession | { Error: string }> {
  let SocketError = '';
  // The camera's address as the socket will see it in replies.
  let ResolvedAddress = Address;
  const Socket = dgram.createSocket({ type: 'udp4', reuseAddr: BindVisca });
  let Waiting: { Sequence: number; Resolve: (R: ViscaReply | null) => void } | null = null;
  Socket.on('error', (Err) => {
    SocketError = Err.message;
    if (Waiting) Waiting.Resolve(null);
  });
  Socket.on('message', (Msg, Info) => {
    if (!Waiting) return;
    const Reply = ParseViscaPacket(Msg);
    if (!Reply || Reply.Sequence !== Waiting.Sequence) return;
    if (Info.address !== ResolvedAddress) return;
    Waiting.Resolve(Reply);
  });

  const Close = () => {
    try {
      Socket.close();
    } catch {
      // Already closed.
    }
  };

  const Bound = await new Promise<boolean>((Resolve) => {
    Socket.once('error', () => Resolve(false));
    Socket.bind(BindVisca ? DEFAULT_VISCA_PORT : 0, () => Resolve(true));
  });
  if (!Bound) {
    Close();
    return { Error: `Failed to open the reply port${SocketError ? `: ${SocketError}` : ''}` };
  }

  try {
    ResolvedAddress = (await dns.promises.lookup(Address, { family: 4 })).address;
  } catch (Err) {
    Close();
    return { Error: Err instanceof Error ? Err.message : String(Err) };
  }

  // One message. Resolves the first reply carrying its sequence number, or
  // null on timeout / send failure.
  const Send = (Type: number, Payload: number[], WaitMs: number): Promise<ViscaReply | null> => {
    if (WaitMs <= 0) return Promise.resolve(null);
    const Sequence = NextSequence();
    return new Promise((Resolve) => {
      const Timer = setTimeout(() => Done(null), WaitMs);
      const Done = (R: ViscaReply | null) => {
        clearTimeout(Timer);
        Waiting = null;
        Resolve(R);
      };
      Waiting = { Sequence, Resolve: Done };
      Socket.send(BuildViscaPacket(Sequence, Payload, Type), Port, ResolvedAddress, (Err) => {
        if (Err) {
          SocketError = Err.message;
          Done(null);
        }
      });
    });
  };

  return { Send, Close, LastError: () => SocketError };
}

export async function QuerySony(
  Address: string,
  Port: number,
  BindVisca: boolean,
  TimeoutMs: number
): Promise<PtzSnapshot> {
  const BudgetMs = Math.max(500, TimeoutMs | 0);
  const Started = Date.now();
  const Deadline = Started + BudgetMs;
  const Remaining = () => Deadline - Date.now();
  const Snap = EmptySnapshot('sony');

  const Session = await OpenViscaSession(Address, Port, BindVisca);
  if ('Error' in Session) return { ...Snap, Error: Session.Error };

  const Ask = (Type: number, Payload: number[], CapMs: number) =>
    Session.Send(Type, Payload, Math.min(Remaining(), CapMs));

  // Read one inquiry's data bytes (after `90 50`), or record why there are none.
  const Data = (Name: string, Reply: ViscaReply | null): Buffer | null => {
    if (!Reply) return null;
    const P = Reply.Payload;
    if (Reply.Type === VISCA_CONTROL_REPLY) {
      // Sony's control reply carries 0F 01 (sequence number) or 0F 02 (message) abnormality.
      Snap.Refused.push(`${Name}: rejected by the camera (control reply ${P.toString('hex')})`);
      return null;
    }
    if (P[0] !== 0x90) return null;
    if (((P[1] as number) & 0xf0) === 0x60) {
      const Code = P[2] as number;
      Snap.Refused.push(`${Name}: ${SONY_ERRORS[Code] || `error ${Code.toString(16)}`}`);
      return null;
    }
    if (P[1] !== 0x50 || P[P.length - 1] !== 0xff) return null;
    return P.subarray(2, P.length - 1);
  };

  try {
    const PowerReply = await Ask(VISCA_INQUIRY, [0x81, 0x09, 0x04, 0x00, 0xff], Infinity);
    if (!PowerReply) {
      return {
        ...Snap,
        Error: Session.LastError() || `No reply from the camera after ${BudgetMs}ms`,
      };
    }
    const FirstReplyAt = Date.now();
    Snap.Reachable = true;
    const PowerData = Data('power', PowerReply);
    const IsReply = PowerReply.Type === VISCA_REPLY || PowerReply.Type === VISCA_CONTROL_REPLY;
    if (!IsReply && !PowerData) return { ...Snap, LatencyMs: FirstReplyAt - Started };
    Snap.IsCamera = PowerReply.Payload[0] === 0x90 || PowerReply.Type === VISCA_CONTROL_REPLY;
    if (PowerData && PowerData.length === 1) {
      Snap.Power = PowerData[0] === 0x02 ? 'on' : PowerData[0] === 0x03 ? 'standby' : null;
    }

    // Later inquiries may be silently ignored by models without them, so none
    // may eat the whole budget.
    const Cap = Math.max(300, Math.floor(BudgetMs / 4));
    const Steps: Array<[string, number, number[], (D: Buffer) => void]> = [
      [
        'version',
        // Sony lists CAM_VersionInq under the VISCA device setting commands,
        // so it goes out with that payload type rather than as an inquiry.
        VISCA_DEVICE_SETTING,
        [0x81, 0x09, 0x00, 0x02, 0xff],
        (D) => {
          if (D.length < 6) return;
          const Vendor = D.subarray(0, 2).toString('hex').toUpperCase();
          const ModelId = D.subarray(2, 4).toString('hex').toUpperCase();
          const Rom = D.subarray(4, 6).toString('hex').toUpperCase();
          Snap.Model =
            Vendor === '0001'
              ? SONY_MODELS[ModelId] || `Sony model ${ModelId}`
              : `Vendor ${Vendor} model ${ModelId}`;
          Snap.Firmware = `ROM ${Rom}`;
        },
      ],
      [
        'pan/tilt status',
        VISCA_INQUIRY,
        [0x81, 0x09, 0x06, 0x10, 0xff],
        (D) => {
          if (D.length !== 2) return;
          Snap.PanTiltStatus = D.readUInt16BE(0);
          Snap.Faults.push(...SonyPanTiltFaults(Snap.PanTiltStatus));
        },
      ],
      [
        'tally',
        VISCA_INQUIRY,
        [0x81, 0x09, 0x7e, 0x01, 0x0a, 0xff],
        (D) => {
          if (D.length === 1) Snap.Tally = D[0] === 0x02 ? true : D[0] === 0x03 ? false : null;
        },
      ],
    ];
    for (const [Name, Type, Payload, Apply] of Steps) {
      if (Remaining() <= 0) {
        Snap.Incomplete = Name;
        break;
      }
      const D = Data(Name, await Ask(Type, Payload, Cap));
      if (D) Apply(D);
    }
    return { ...Snap, LatencyMs: FirstReplyAt - Started };
  } finally {
    Session.Close();
  }
}

// --- Snapshot cache -------------------------------------------------------------

// Standby and error checks on one camera share one probe per tick.
const SNAPSHOT_CACHE = CacheManager.GetBucket('MonitoringMethods:PtzCamera', {
  defaultTtlMs: 1000,
  maxEntries: 500,
});

// --- Settings / evaluation ------------------------------------------------------

export interface PtzConfig {
  Protocol: PtzProtocol;
  Address: string;
  Port: number;
  Username: string;
  Password: string;
  BindVisca: boolean;
  TimeoutMs: number;
}

function ParseConfig(Target: MonitoringTargetLike): PtzConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Protocol: PtzProtocol = Cfg.Protocol === 'sony' ? 'sony' : 'panasonic';
  const RawPort = Number(Protocol === 'sony' ? Cfg.ViscaPort : Cfg.Port);
  const Default = Protocol === 'sony' ? DEFAULT_VISCA_PORT : DEFAULT_HTTP_PORT;
  return {
    Protocol,
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Port: Number.isFinite(RawPort) && RawPort > 0 ? RawPort | 0 : Default,
    Username: Cfg.Username == null ? '' : String(Cfg.Username),
    Password: Cfg.Password == null ? '' : String(Cfg.Password),
    BindVisca: Cfg.ReplyPort === 'visca',
    TimeoutMs: ResolveTimeoutMs(Cfg.Timeout),
  };
}

export interface PtzOptions {
  CheckStandby: boolean;
  CheckErrors: boolean;
}

function ParseOptions(Target: MonitoringTargetLike): PtzOptions {
  const Cfg = (Target && Target.Settings) || {};
  // Both default ON: an absent key still checks.
  return { CheckStandby: Cfg.CheckStandby !== false, CheckErrors: Cfg.CheckErrors !== false };
}

const VENDOR_NAMES: Record<PtzProtocol, string> = {
  panasonic: 'a Panasonic camera',
  sony: 'a VISCA camera',
};

function EvaluateHealth(Snap: PtzSnapshot, Options: PtzOptions): string[] {
  if (Snap.AuthFailed) return ['The camera requires a username and password, or refused them'];
  if (!Snap.IsCamera) {
    return Snap.Incomplete
      ? [`Timed out reading ${Snap.Incomplete}`]
      : [`Responded, but does not look like ${VENDOR_NAMES[Snap.Protocol]}`];
  }
  const Reasons: string[] = [];
  if (Snap.Incomplete) Reasons.push(`Timed out reading ${Snap.Incomplete}`);
  if (Options.CheckStandby && Snap.Power === 'standby') Reasons.push('Camera is in standby');
  if (Options.CheckErrors) Reasons.push(...Snap.Faults);
  return Reasons;
}

// --- Run ------------------------------------------------------------------------

function SnapshotKey(Config: PtzConfig): string {
  const CredKey = crypto
    .createHash('sha256')
    .update(`${Config.Username}\0${Config.Password}`)
    .digest('hex')
    .slice(0, 16);
  return `${Config.Protocol}|${Config.Address.toLowerCase()}|${Config.Port}|${Config.BindVisca}|${CredKey}|${Config.TimeoutMs}`;
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Success: false, Error: `Invalid port: ${Config.Port}` };
  }

  const Snap = (await SNAPSHOT_CACHE.GetOrCreate(
    SnapshotKey(Config),
    () =>
      Config.Protocol === 'sony'
        ? QuerySony(Config.Address, Config.Port, Config.BindVisca, Config.TimeoutMs)
        : QueryPanasonic(
            Config.Address,
            Config.Port,
            Config.Username,
            Config.Password,
            Config.TimeoutMs
          ),
    { ttlMs: ResolveSnapshotTtlMs(Config.TimeoutMs) }
  )) as PtzSnapshot;

  if (!Snap.Reachable) return { Success: false, Error: Snap.Error || 'No reply from the camera' };

  const Reasons = EvaluateHealth(Snap, ParseOptions(Target));
  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs: Snap.LatencyMs ?? null,
    Protocol: Snap.Protocol,
    IsCamera: Snap.IsCamera,
    AuthFailed: Snap.AuthFailed,
    Power: Snap.Power,
    Model: Snap.Model,
    Firmware: Snap.Firmware,
    Tally: Snap.Tally,
    Faults: Snap.Faults,
    ErrorCode: Snap.ErrorCode,
    PanTiltStatus: Snap.PanTiltStatus,
    Refused: Snap.Refused,
    Incomplete: Snap.Incomplete,
  };
}

// --- Actions --------------------------------------------------------------------

const MAX_PRESET = 100;

const Actions: MonitoringActionDef[] = [
  {
    ID: 'power.on',
    Label: 'Power On',
    Icon: 'power',
    Group: 'Power',
    Note: 'Brings the camera out of standby. It takes a few seconds to start up and move to its power-on position.',
  },
  {
    ID: 'power.standby',
    Label: 'Standby',
    Icon: 'power',
    Group: 'Power',
    Destructive: true,
    Note: 'Puts the camera into standby. Its picture is lost until it is powered on again.',
  },
  {
    ID: 'preset.recall',
    Label: 'Recall Preset',
    Icon: 'bookmark-star',
    Group: 'Presets',
    Destructive: true,
    Params: [
      {
        Key: 'Preset',
        Label: 'Preset',
        Type: 'number',
        Required: true,
        Note: 'The preset number as the camera shows it, starting at 1. Panasonic cameras have presets 1 to 100; Sony cameras up to 100, depending on the model.',
      },
    ],
    Note: 'Moves the camera to a stored preset. The shot changes on air.',
  },
];

/** The preset number from an action's params, or null when it is not 1-100. */
function PresetOf(Params: Record<string, unknown>): number | null {
  const Raw = Params ? Params.Preset : undefined;
  if (Raw === undefined || Raw === null || String(Raw).trim() === '') return null;
  const N = Number(Raw);
  return Number.isInteger(N) && N >= 1 && N <= MAX_PRESET ? N : null;
}

const PANASONIC_ACTION_REFUSALS: Record<string, string> = {
  '1': 'The camera does not support this command',
  '2': 'The camera is busy or in standby and refused the command',
  '3': 'The camera refused the value as out of range',
};

async function RunPanasonicAction(
  Config: PtzConfig,
  Cmd: string,
  Expected: RegExp,
  Detail: string
): Promise<MonitoringActionResult> {
  const BudgetMs = Math.max(500, Config.TimeoutMs | 0);
  const Client = CreatePanasonicClient(
    Config.Address,
    Config.Port,
    Config.Username,
    Config.Password,
    Date.now() + BudgetMs
  );
  const Answer = await Client.Ask(PtzPath(Cmd));
  if (!Answer) {
    if (Client.State.AuthFailed) {
      return {
        Success: false,
        Error: 'The camera requires a username and password, or refused them',
      };
    }
    return {
      Success: false,
      Error: Client.State.LastError || `No reply from the camera after ${BudgetMs}ms`,
    };
  }
  if (Answer.Refusal) {
    return { Success: false, Error: PANASONIC_ACTION_REFUSALS[Answer.Refusal] as string };
  }
  if (Answer.Status) {
    return { Success: false, Error: `The camera answered HTTP ${Answer.Status}` };
  }
  if (!Expected.test(Answer.Body || '')) {
    return {
      Success: false,
      Error: `Unexpected answer from the camera: ${String(Answer.Body || '(empty)').slice(0, 40)}`,
    };
  }
  return { Success: true, Detail };
}

const SONY_ACTION_ERRORS: Record<number, string> = {
  0x02: 'The camera does not support this command or value',
  0x03: 'The camera is busy with two other commands; try again',
  0x41: 'The camera cannot do that right now, for example while in standby or with a menu open',
};

async function RunSonyAction(
  Config: PtzConfig,
  Payload: number[],
  Detail: string
): Promise<MonitoringActionResult> {
  const BudgetMs = Math.max(500, Config.TimeoutMs | 0);
  const Deadline = Date.now() + BudgetMs;
  const Session = await OpenViscaSession(Config.Address, Config.Port, Config.BindVisca);
  if ('Error' in Session) return { Success: false, Error: Session.Error };
  try {
    const Reply = await Session.Send(VISCA_COMMAND, Payload, Deadline - Date.now());
    if (!Reply) {
      return {
        Success: false,
        Error: Session.LastError() || `No reply from the camera after ${BudgetMs}ms`,
      };
    }
    const P = Reply.Payload;
    if (Reply.Type === VISCA_CONTROL_REPLY) {
      return {
        Success: false,
        Error: `The camera rejected the message (control reply ${P.toString('hex')})`,
      };
    }
    const Kind = (P[1] as number) & 0xf0;
    if (P[0] === 0x90 && (Kind === 0x40 || Kind === 0x50)) return { Success: true, Detail };
    if (P[0] === 0x90 && Kind === 0x60) {
      const Code = P[2] as number;
      return {
        Success: false,
        Error: SONY_ACTION_ERRORS[Code] || `The camera answered error ${Code.toString(16)}`,
      };
    }
    return { Success: false, Error: `Unexpected reply from the camera: ${P.toString('hex')}` };
  } finally {
    Session.Close();
  }
}

async function RunAction(
  Target: MonitoringTargetLike,
  ActionID: string,
  Params: Record<string, unknown> = {}
): Promise<MonitoringActionResult> {
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Success: false, Error: `Invalid port: ${Config.Port}` };
  }
  const Sony = Config.Protocol === 'sony';

  if (ActionID === 'power.on' || ActionID === 'power.standby') {
    const On = ActionID === 'power.on';
    const Detail = On ? 'Camera powered on' : 'Camera put into standby';
    return Sony
      ? RunSonyAction(Config, [0x81, 0x01, 0x04, 0x00, On ? 0x02 : 0x03, 0xff], Detail)
      : RunPanasonicAction(Config, On ? 'O1' : 'O0', On ? /^p1$/ : /^p0$/, Detail);
  }

  if (ActionID === 'preset.recall') {
    const Preset = PresetOf(Params);
    if (Preset === null) {
      return { Success: false, Error: `Preset must be a whole number from 1 to ${MAX_PRESET}` };
    }
    const Detail = `Preset ${Preset} recalled`;
    const Index = Preset - 1;
    if (Sony) return RunSonyAction(Config, [0x81, 0x01, 0x04, 0x3f, 0x02, Index, 0xff], Detail);
    const Nn = String(Index).padStart(2, '0');
    return RunPanasonicAction(Config, `R${Nn}`, new RegExp(`^s${Nn}$`), Detail);
  }

  return { Success: false, Error: `Unknown PTZ camera action "${ActionID}"` };
}

function DescribeAction(ActionID: string, Params: Record<string, unknown>): string | null {
  if (ActionID !== 'preset.recall') return null;
  const Preset = PresetOf(Params);
  return Preset === null ? null : `Recall Preset ${Preset}`;
}

// A power or preset command has just changed what the cached snapshot describes.
function InvalidateCaches(Target: MonitoringTargetLike): void {
  SNAPSHOT_CACHE.Delete(SnapshotKey(ParseConfig(Target)));
}

// --- Debug ----------------------------------------------------------------------

function PowerPill(Power: unknown): string {
  if (Power === 'on') return Pill('success', 'On');
  if (Power === 'standby') return Pill('warning', 'Standby');
  if (Power === 'starting') return Pill('muted', 'Starting');
  return Pill('muted', 'Unknown');
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseConfig(Target);
  const Reachable = !!(Result && Result.Success === true);
  const Transport =
    Config.Protocol === 'sony' ? `VISCA over IP (UDP ${Config.Port})` : `HTTP ${Config.Port}`;

  const Head = Rows([
    TextRow('Host', `${Config.Address || '—'}:${Config.Port}`),
    Reachable && Result.Model ? TextRow('Model', String(Result.Model)) : null,
    Reachable && Result.Firmware ? TextRow('Software', String(Result.Firmware)) : null,
    Row('Status', BmdStatePill(Result, 'Healthy')),
    Reachable && Result.DegradedReason ? TextRow('Reason', String(Result.DegradedReason)) : null,
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Failed to reach the camera'),
  ]);

  if (!Reachable) {
    return (
      Head +
      '<div class="mt-2">' +
      Note(
        Config.Protocol === 'sony'
          ? `No VISCA over IP reply (UDP ${Config.Port}). Check the address, that VISCA over IP is enabled on the camera, and the reply port setting.`
          : `Failed to reach the camera's control interface (HTTP ${Config.Port}). Check the address and that the camera is on the network.`
      ) +
      '</div>'
    );
  }
  if (Result.AuthFailed || Result.IsCamera === false) return Head;

  const Faults: string[] = Array.isArray(Result.Faults) ? (Result.Faults as string[]) : [];
  const Refused: string[] = Array.isArray(Result.Refused) ? (Result.Refused as string[]) : [];
  const Body = Rows([
    TextRow('Protocol', Transport),
    Row('Power', PowerPill(Result.Power)),
    Row(
      'Errors',
      Faults.length ? Pill('danger', Faults.join('; ')) : Pill('success', 'None reported')
    ),
    Result.Tally != null
      ? Row('Red tally', Pill(Result.Tally ? 'danger' : 'muted', Result.Tally ? 'On' : 'Off'))
      : null,
    typeof Result.PanTiltStatus === 'number'
      ? MonoRow('Pan/tilt status', Result.PanTiltStatus.toString(16).padStart(4, '0'))
      : null,
  ]);
  return (
    Head +
    `<div class="mt-2">${Body}</div>` +
    (Refused.length
      ? `<div class="mt-2">${Note(`Not answered by this camera: ${Refused.join(', ')}`)}</div>`
      : '')
  );
}

export const Name = 'PTZ Camera';
export const Description =
  'Queries a Panasonic AW-series camera over its HTTP control interface, or a Sony camera over VISCA over IP, sending queries only. Degraded when the camera is in standby or reports an error.';
export const Group = 'Video';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParsePanasonicRefusal,
  ParsePanasonicPower,
  ParsePanasonicRer,
  ParsePanasonicValue,
  DescribePanasonicError,
  BuildViscaPacket,
  ParseViscaPacket,
  SonyPanTiltFaults,
  ParseConfig,
  ParseOptions,
  EvaluateHealth,
  QueryPanasonic,
  QuerySony,
  PresetOf,
  SNAPSHOT_CACHE,
};
export { ID, Settings, Actions, Run, RunAction, DescribeAction, InvalidateCaches, Debug };
