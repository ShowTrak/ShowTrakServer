// AJA device check over AJA's REST parameter API — the same `/config` interface
// on Ki Pro recorders, HELO / HELO Plus streamers, FS-series frame syncs and the
// other AJA network products. Built for "the recorder stopped and nobody saw"
// and for the alarms the device already raises on its own front panel.
//
// Protocol (AJA "REST API" docs, gitlab.aja.com/pub/rest_api, chapters 01, 02
// and 08, plus the HELO / Ki Pro chapters; cross-checked against Bitfocus
// companion-module-aja-kipro and companion-module-aja-helo):
//   - GET /config?action=get&paramid=eParamID_X answers one JSON object,
//       {"paramid":"33619978","name":"eParamID_VideoInSelect","value":"1","value_name":"HDMI"}
//     `value_name` is the enum text (a copy of the value for integers).
//   - GET /desc.json lists EVERY parameter descriptor the device has, as an
//     array of {param_id: "eParamID_…", param_name, string_attributes[], …}.
//     Parameter sets vary per product and firmware, so the descriptors decide
//     which of the status parameters below are worth asking for at all.
//   - Alarms are parameters whose descriptor carries the string attributes
//     Content-Type = application/vnd.google.protobuf and protobuf_message =
//     "/alarm.proto". Their value is a base64 protobuf `Alarm` message:
//       state 1 (NORMAL 0 / ALARM 1), severity 2 (WARNING 0 / ERROR 1 /
//       FATAL 2), repeated error 3 { text 1, short_text 2 }.
//     The first error is the alarm's label ("Dropped Frames"); later ones
//     explain an active alarm. AJA also describes per-alarm "suppression"
//     parameters, but not the descriptor attribute that links an alarm to
//     its suppression control, so suppression is NOT honoured here: an alarm
//     the operator has suppressed on the device still shows (and degrades at
//     or above the chosen severity). AJA documents that these cover input signal
//     loss, temperature, media errors and the like, which is why this check
//     has no separate input-signal rule: the device's own alarm is the source
//     of truth, whatever the product calls it.
//   - Authentication, when turned on in the device: POST /authenticator/login
//     with `password_provided=…` answers {"login":"success"} and a session
//     cookie that every later request returns. Companion's HELO module notes a
//     404 is how an expired session shows, so a 401/403/404 with a cookie
//     triggers one fresh login.
//
// Status parameters read when the device has them (sources noted per entry in
// STATUS_PARAMS). Every request is `action=get` — nothing that changes device
// state is ever sent. The login POST creates a web session, nothing more.
//
// Not read: model and firmware. AJA documents no parameter for either, and
// parameter names are not guessed here.
//
// Actions (RunAction only; the check itself never sets anything), via the
// documented `/config?action=set` command parameters:
//   - Ki Pro family (Ki Pro GO / Ultra / Ultra Plus / Ultra 12G chapters):
//     eParamID_TransportCommand 1 Play, 3 Record, 4 Stop. AJA: "Stop: once to
//     pause, twice to stop (idle)" — either way a recording ends.
//   - HELO / HELO Plus (chapter 03): eParamID_ReplicatorCommand 1 Record,
//     2 Stop Recording, 3 Stream, 4 Stop Streaming.
//   The family is told apart by which command parameter the device describes
//   (cached desc.json) or, failing that, answers a plain `get` for. An action
//   the family has no command for is refused before anything is set.
//
// Assertions:
//   - CheckAlarms (default ON) + AlarmMinSeverity: an active device alarm at or
//     above the chosen severity, or a recorder / streamer that reports one of
//     its failure states.
//   - CheckRecording (default OFF): recorders sit idle between shows, so "must
//     be recording" is opted into for the show.
//   - CheckMediaRemaining (default OFF) + MinMediaPercent.
import crypto from 'crypto';
import http from 'http';
import { Manager as CacheManager } from '../CacheManager';
import {
  BmdStatePill,
  MonoRow,
  ResolveSnapshotTtlMs,
  ResolveTimeoutMs,
  TimeoutSetting,
} from './_blackmagic-shared';
import { Card, Esc, FormatLatency, Note, Pill, Row, Rows, TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type {
  MonitoringActionDef,
  MonitoringActionResult,
  MonitoringResult,
  MonitoringSettingField,
  MonitoringTargetLike,
} from './types';

const ID = 'aja-device';
const DEFAULT_PORT = 80;
const DEFAULT_MIN_MEDIA_PERCENT = 10;
// One parameter reply is ~100 bytes. desc.json is the whole descriptor table,
// which runs to megabytes on the larger products.
const MAX_PARAM_BODY_BYTES = 64 * 1024;
const MAX_DESC_BODY_BYTES = 16 * 1024 * 1024;
// Bounds a device that reports a nonsense number of alarm parameters; the
// Timeout budget bounds the rest.
const MAX_ALARMS = 64;
const CONCURRENCY = 4;
// Descriptors only change with a firmware update. Re-reading them every tick
// would cost megabytes per probe, so they are kept for a while; a failed read
// is kept for less so a device that was booting is re-read soon.
const DESC_TTL_MS = 10 * 60 * 1000;
const DESC_FAILED_TTL_MS = 60 * 1000;
const SESSION_TTL_MS = 10 * 60 * 1000;

const SEVERITY_LABELS = ['Warning', 'Error', 'Fatal'];

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'HTTP port',
    Type: 'number',
    Default: DEFAULT_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
  },
  {
    Key: 'Password',
    Label: 'Password',
    Type: 'string',
    Default: '',
    Sensitive: true,
    Note: 'Only needed when authentication is turned on in the device. Leave it blank otherwise.',
  },
  {
    Key: 'CheckAlarms',
    Label: 'Check alarms',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded when the device raises an alarm (input loss, temperature, media and so on) or its recorder reports a failure.',
  },
  {
    Key: 'AlarmMinSeverity',
    Label: 'Lowest alarm severity',
    Type: 'select',
    Default: 'warning',
    Options: [
      { value: 'warning', label: 'Warning' },
      { value: 'error', label: 'Error' },
      { value: 'fatal', label: 'Fatal' },
    ],
    VisibleWhen: { Key: 'CheckAlarms', Equals: true },
    Note: 'Alarms below this severity are shown but do not degrade the check.',
  },
  {
    Key: 'CheckRecording',
    Label: 'Check recording',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded unless the device is recording. Enable it for the show, when the recorder should be rolling.',
  },
  {
    Key: 'CheckMediaRemaining',
    Label: 'Check media remaining',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when the free space on the current media drops below the minimum.',
  },
  {
    Key: 'MinMediaPercent',
    Label: 'Minimum media remaining (%)',
    Type: 'number',
    Default: DEFAULT_MIN_MEDIA_PERCENT,
    Min: 1,
    Max: 99,
    VisibleWhen: { Key: 'CheckMediaRemaining', Equals: true },
  },
  TimeoutSetting(),
];

// --- Status parameters ------------------------------------------------------
//
// Only names with a public source. Each device answers a subset.
const STATUS_PARAMS = [
  // Companion aja-kipro (Ki Pro family).
  'eParamID_SysName',
  'eParamID_TransportState',
  'eParamID_CurrentClip',
  'eParamID_DisplayTimecode',
  // AJA REST docs (HELO chapter 03, Ki Pro chapter 06).
  'eParamID_ReplicatorRecordState',
  'eParamID_ReplicatorStreamState',
  'eParamID_MediaState',
  'eParamID_VideoInSelect',
  // Companion aja-kipro + aja-helo: percent of the current media still free.
  // The unit is Companion's reading (it appends "%"), not an AJA statement.
  'eParamID_CurrentMediaAvailable',
  // Companion aja-helo. The unit is not documented, so it is shown as reported.
  'eParamID_Temperature',
] as const;

type StatusParam = (typeof STATUS_PARAMS)[number];

// eParamID_TransportState numbering, from Companion aja-kipro (the AJA docs
// show only the parameters used to SET the transport). Used for the label only
// when the device sends no value_name, and for the recording / error tests.
// Companion leaves 4-7 and 9-13 out: they are the shuttle speeds, which it
// reads from eParamID_TransportCurrentSpeed instead, so those show the
// device's own value_name (or the bare number).
const KIPRO_TRANSPORT: Record<number, string> = {
  0: 'Unknown',
  1: 'Idle',
  2: 'Recording',
  3: 'Forward',
  8: 'Step forward',
  14: 'Step reverse',
  15: 'Paused',
  16: 'Idle error',
  17: 'Record error',
  18: 'Play error',
  19: 'Pause error',
  20: 'Shutdown',
};
const KIPRO_RECORDING = 2;
const KIPRO_ERRORS = new Set([16, 17, 18, 19]);

// eParamID_ReplicatorRecordState / StreamState (AJA HELO chapter 03). The
// device's own value_name is the enum identifier (`eRRSFailingInIdle`), so
// these tables are preferred over it for display.
const RECORD_STATES: Record<number, string> = {
  0: 'Uninitialized',
  1: 'Idle',
  2: 'Recording',
  3: 'Failing (idle)',
  4: 'Failing (recording)',
  5: 'Shutdown',
};
const STREAM_STATES: Record<number, string> = {
  ...RECORD_STATES,
  2: 'Streaming',
  4: 'Failing (streaming)',
};
const REPLICATOR_ACTIVE = 2;
const REPLICATOR_FAILING_ACTIVE = 4;
const REPLICATOR_FAILING = new Set([3, 4]);

// --- Pure protocol helpers --------------------------------------------------

export interface AjaParam {
  Name: string;
  Value: string;
  ValueName: string;
}

/** One `/config?action=get` reply, or null when it is not one (wrong name, not JSON). */
export function ParseParamReply(Body: string, Expected: string): AjaParam | null {
  let Json: unknown;
  try {
    Json = JSON.parse(Body);
  } catch {
    return null;
  }
  if (!Json || typeof Json !== 'object' || Array.isArray(Json)) return null;
  const Obj = Json as Record<string, unknown>;
  if (typeof Obj.name !== 'string' || Obj.name !== Expected) return null;
  if (Obj.value === undefined || Obj.value === null) return null;
  return {
    Name: Obj.name,
    Value: String(Obj.value),
    ValueName: Obj.value_name == null ? '' : String(Obj.value_name),
  };
}

export interface AjaDescriptors {
  /** Every eParamID the device describes. */
  Params: Set<string>;
  /** The alarm parameters (protobuf `/alarm.proto`), in descriptor order. */
  Alarms: string[];
}

/** Read desc.json. Null when it is not a descriptor array. */
export function ParseDescriptors(Body: string): AjaDescriptors | null {
  let Json: unknown;
  try {
    Json = JSON.parse(Body);
  } catch {
    return null;
  }
  if (!Array.isArray(Json)) return null;
  const Params = new Set<string>();
  const Alarms: string[] = [];
  for (const Entry of Json) {
    if (!Entry || typeof Entry !== 'object') continue;
    const Desc = Entry as Record<string, unknown>;
    const Id = typeof Desc.param_id === 'string' ? Desc.param_id : '';
    if (!Id.startsWith('eParamID_')) continue;
    Params.add(Id);
    let ContentType = '';
    let ProtoMessage = '';
    if (Array.isArray(Desc.string_attributes)) {
      for (const Attr of Desc.string_attributes as Array<Record<string, unknown>>) {
        if (!Attr || typeof Attr !== 'object') continue;
        if (Attr.name === 'Content-Type') ContentType = String(Attr.value ?? '');
        else if (Attr.name === 'protobuf_message') ProtoMessage = String(Attr.value ?? '');
      }
    }
    if (
      ContentType.toLowerCase() === 'application/vnd.google.protobuf' &&
      /alarm\.proto$/i.test(ProtoMessage)
    ) {
      Alarms.push(Id);
    }
  }
  return Params.size ? { Params, Alarms } : null;
}

// Minimal protobuf reader: varint (wire type 0) and length-delimited (2) are
// all alarm.proto / error.proto use. Fixed 64 / 32-bit fields (1 / 5) are
// skipped so a field added by later firmware cannot hide the ones after it;
// the deprecated group types (3 / 4) or a truncated field end the message.
type ProtoField = { Field: number; Int?: number; Bytes?: Buffer };

function ReadVarint(Data: Buffer, Pos: number): { Value: number; Pos: number } | null {
  let Value = 0;
  let Multiplier = 1;
  for (let I = 0; I < 10 && Pos < Data.length; I++) {
    const Byte = Data[Pos++] as number;
    Value += (Byte & 0x7f) * Multiplier;
    Multiplier *= 128;
    if (!(Byte & 0x80)) return { Value, Pos };
  }
  return null;
}

function ReadFields(Data: Buffer): ProtoField[] {
  const Out: ProtoField[] = [];
  let Pos = 0;
  while (Pos < Data.length) {
    const Tag = ReadVarint(Data, Pos);
    if (!Tag) break;
    Pos = Tag.Pos;
    const Field = Math.floor(Tag.Value / 8);
    const WireType = Tag.Value & 7;
    if (WireType === 0) {
      const V = ReadVarint(Data, Pos);
      if (!V) break;
      Pos = V.Pos;
      Out.push({ Field, Int: V.Value });
    } else if (WireType === 2) {
      const Len = ReadVarint(Data, Pos);
      if (!Len || Len.Pos + Len.Value > Data.length) break;
      Out.push({ Field, Bytes: Data.subarray(Len.Pos, Len.Pos + Len.Value) });
      Pos = Len.Pos + Len.Value;
    } else if (WireType === 1 || WireType === 5) {
      const Size = WireType === 1 ? 8 : 4;
      if (Pos + Size > Data.length) break;
      Pos += Size;
    } else {
      break;
    }
  }
  return Out;
}

export interface AjaAlarm {
  Param: string;
  /** The alarm's own label (first error entry), or the parameter name. */
  Label: string;
  Active: boolean;
  /** 0 Warning, 1 Error, 2 Fatal. */
  Severity: number;
  /** Explanation entries after the label, present while active. */
  Details: string[];
  /** The value could not be decoded as an Alarm message. */
  Undecodable?: boolean;
}

/** Decode one base64 Alarm protobuf. */
export function DecodeAlarm(Param: string, Base64: string): AjaAlarm {
  const Fallback = Param.replace(/^eParamID_/, '').replace(/_/g, ' ');
  const Raw = String(Base64 || '').trim();
  if (!Raw || !/^[A-Za-z0-9+/=\s]+$/.test(Raw)) {
    return { Param, Label: Fallback, Active: false, Severity: 0, Details: [], Undecodable: true };
  }
  const Fields = ReadFields(Buffer.from(Raw, 'base64'));
  let State: number | null = null;
  let Severity = 0;
  const Texts: string[] = [];
  for (const F of Fields) {
    if (F.Field === 1 && F.Int !== undefined) State = F.Int;
    else if (F.Field === 2 && F.Int !== undefined) Severity = F.Int;
    else if (F.Field === 3 && F.Bytes) {
      let Text = '';
      let Short = '';
      for (const E of ReadFields(F.Bytes)) {
        if (E.Field === 1 && E.Bytes) Text = E.Bytes.toString('utf8');
        else if (E.Field === 2 && E.Bytes) Short = E.Bytes.toString('utf8');
      }
      Texts.push(Texts.length === 0 ? Short || Text : Text || Short);
    }
  }
  if (State === null) {
    return { Param, Label: Fallback, Active: false, Severity: 0, Details: [], Undecodable: true };
  }
  return {
    Param,
    Label: Texts[0] || Fallback,
    Active: State === 1,
    Severity: Math.max(0, Math.min(2, Severity)),
    Details: Texts.slice(1).filter(Boolean),
  };
}

// --- HTTP ---------------------------------------------------------------------

interface HttpReply {
  Status: number;
  Body: string;
  Headers: http.IncomingHttpHeaders;
  /** The body ran past the cap and was dropped. */
  TooLarge: boolean;
}

/**
 * One request bounded by `BudgetMs`. Rejects on transport failure. Uses the
 * lenient HTTP parser because Companion's Ki Pro module documents older Ki Pro
 * firmware sending headers Node's strict parser refuses
 * (HPE_UNEXPECTED_CONTENT_LENGTH).
 */
function HttpRequest(
  Address: string,
  Port: number,
  Method: 'GET' | 'POST',
  Path: string,
  BudgetMs: number,
  MaxBytes: number,
  Headers: Record<string, string> = {},
  Body?: string
): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    let Settled = false;
    let Req: http.ClientRequest | null = null;
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
    const Timer = setTimeout(
      () => Finish(new Error(`No reply after ${Math.max(1, BudgetMs | 0)}ms`)),
      Math.max(1, BudgetMs | 0)
    );
    try {
      Req = http.request({
        host: Address,
        port: Port,
        method: Method,
        path: Path,
        insecureHTTPParser: true,
        headers: {
          'User-Agent': 'ShowTrak-Monitoring/1.0',
          Accept: 'application/json, */*',
          Connection: 'close',
          ...(Body !== undefined
            ? {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': String(Buffer.byteLength(Body)),
              }
            : {}),
          ...Headers,
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
      let TooLarge = false;
      Res.on('data', (Chunk: Buffer) => {
        Bytes += Chunk.length;
        if (Bytes > MaxBytes) {
          TooLarge = true;
          Res.destroy();
          Finish(null, { Status: Res.statusCode || 0, Body: '', Headers: Res.headers, TooLarge });
          return;
        }
        Chunks.push(Chunk);
      });
      Res.on('end', () =>
        Finish(null, {
          Status: Res.statusCode || 0,
          Body: Buffer.concat(Chunks).toString('utf8'),
          Headers: Res.headers,
          TooLarge,
        })
      );
      Res.on('error', (Err) => Finish(Err));
    });
    Req.end(Body);
  });
}

// --- Caches -------------------------------------------------------------------

// Several checks on one device (alarms, recording, media) share one snapshot
// per tick.
const SNAPSHOT_CACHE = CacheManager.GetBucket('MonitoringMethods:AjaDevice', {
  defaultTtlMs: 1000,
  maxEntries: 500,
});
const DESC_CACHE = CacheManager.GetBucket('MonitoringMethods:AjaDevice:Descriptors', {
  defaultTtlMs: DESC_TTL_MS,
  maxEntries: 500,
});
const SESSION_CACHE = CacheManager.GetBucket('MonitoringMethods:AjaDevice:Session', {
  defaultTtlMs: SESSION_TTL_MS,
  maxEntries: 500,
});

const HostKey = (Address: string, Port: number) => `${Address.toLowerCase()}|${Port}`;
const PasswordKey = (Password: string) =>
  crypto.createHash('sha256').update(Password).digest('hex').slice(0, 16);

// --- One-probe status snapshot ----------------------------------------------

export interface AjaSnapshot {
  Reachable: boolean;
  Error?: string;
  LatencyMs?: number;
  /** A parameter reply or descriptor table proved this is an AJA REST device. */
  IsAja: boolean;
  /** A password is configured and the device refused it. */
  AuthFailed: boolean;
  /** The device asked for a login and no password is configured. */
  AuthRequired: boolean;
  /** desc.json was read (from cache or now); false = every status param was tried blind. */
  HaveDescriptors: boolean;
  Params: Partial<Record<StatusParam, AjaParam>>;
  Alarms: AjaAlarm[];
  /** Which step the budget ran out in, when it did. */
  Incomplete: string | null;
}

function EmptySnapshot(): AjaSnapshot {
  return {
    Reachable: false,
    IsAja: false,
    AuthFailed: false,
    AuthRequired: false,
    HaveDescriptors: false,
    Params: {},
    Alarms: [],
    Incomplete: null,
  };
}

const IsAuthStatus = (Status: number) => Status === 401 || Status === 403 || Status === 404;

// One REST conversation with the device: the login, the cached session cookie
// and the one re-login on an expired session. Shared by the probe and the
// actions so both honour the same password.
export function CreateAjaClient(Address: string, Port: number, Password: string, Deadline: number) {
  const Remaining = () => Deadline - Date.now();
  const State = {
    Reachable: false,
    AuthFailed: false,
    LastError: '',
    FirstReplyAt: null as number | null,
  };
  const SessionKey = `${HostKey(Address, Port)}|${PasswordKey(Password)}`;
  let Cookie = Password ? (SESSION_CACHE.Get(SessionKey) as string | undefined) || '' : '';

  // Every request goes through here so the first reply marks the device
  // reachable and transport errors are remembered for the offline message.
  const Send = async (
    Method: 'GET' | 'POST',
    Path: string,
    MaxBytes: number,
    BudgetCapMs = Infinity,
    Body?: string
  ): Promise<HttpReply | null> => {
    const Left = Math.min(Remaining(), BudgetCapMs);
    if (Left <= 0) return null;
    try {
      const Reply = await HttpRequest(
        Address,
        Port,
        Method,
        Path,
        Left,
        MaxBytes,
        Cookie ? { Cookie } : {},
        Body
      );
      if (State.FirstReplyAt === null) State.FirstReplyAt = Date.now();
      State.Reachable = true;
      return Reply;
    } catch (Err) {
      State.LastError = Err instanceof Error ? Err.message : String(Err);
      return null;
    }
  };

  const Login = async (): Promise<boolean> => {
    const Reply = await Send(
      'POST',
      '/authenticator/login',
      MAX_PARAM_BODY_BYTES,
      Infinity,
      `password_provided=${encodeURIComponent(Password)}`
    );
    if (!Reply) return false;
    let Ok = false;
    try {
      Ok = (JSON.parse(Reply.Body) as Record<string, unknown>).login === 'success';
    } catch {
      Ok = false;
    }
    const SetCookie = Reply.Headers['set-cookie'];
    const First = Array.isArray(SetCookie) ? SetCookie[0] : SetCookie;
    if (!Ok || !First) {
      State.AuthFailed = true;
      return false;
    }
    // Only `name=value` goes back; attributes such as `path=/` are not part of a Cookie header.
    Cookie = String(First).split(';')[0] || '';
    SESSION_CACHE.Set(SessionKey, Cookie, SESSION_TTL_MS);
    return true;
  };

  // Log in first when a password is set and no session is cached. False when
  // that login failed (State says whether it was refused or unanswered).
  const Start = async (): Promise<boolean> => {
    if (!Password || Cookie) return true;
    return Login();
  };

  // A GET that re-logs in once when a cached session has expired.
  let Relogged = false;
  const Get = async (Path: string, MaxBytes: number, CapMs = Infinity) => {
    let Reply = await Send('GET', Path, MaxBytes, CapMs);
    if (Reply && IsAuthStatus(Reply.Status) && Password && !Relogged && !State.AuthFailed) {
      Relogged = true;
      SESSION_CACHE.Delete(SessionKey);
      Cookie = '';
      if (await Login()) Reply = await Send('GET', Path, MaxBytes, CapMs);
    }
    return Reply;
  };

  return { State, Start, Get, Remaining };
}

export async function QueryAja(
  Address: string,
  Port: number,
  Password: string,
  TimeoutMs: number
): Promise<AjaSnapshot> {
  const BudgetMs = Math.max(500, TimeoutMs | 0);
  const Started = Date.now();
  const Client = CreateAjaClient(Address, Port, Password, Started + BudgetMs);
  const { Get, Remaining } = Client;
  const Snap = EmptySnapshot();
  const Key = HostKey(Address, Port);

  const Finish = (): AjaSnapshot => {
    Snap.Reachable = Client.State.Reachable;
    Snap.AuthFailed = Client.State.AuthFailed;
    if (!Snap.Reachable) {
      return {
        ...Snap,
        Error: Client.State.LastError || `No reply from the AJA device after ${BudgetMs}ms`,
      };
    }
    return { ...Snap, LatencyMs: (Client.State.FirstReplyAt ?? Date.now()) - Started };
  };

  if (!(await Client.Start())) return Finish();

  // 1. Descriptors (cached). Capped at half the budget so a slow, huge
  //    desc.json on the first tick still leaves time for the status reads.
  let Desc = DESC_CACHE.Get(Key) as AjaDescriptors | 'missing' | null;
  if (!Desc) {
    const Reply = await Get('/desc.json', MAX_DESC_BODY_BYTES, BudgetMs / 2);
    const Parsed =
      Reply && Reply.Status === 200 && !Reply.TooLarge ? ParseDescriptors(Reply.Body) : null;
    if (Parsed) {
      Desc = Parsed;
      DESC_CACHE.Set(Key, Parsed, DESC_TTL_MS);
    } else if (Reply && !IsAuthStatus(Reply.Status)) {
      // Answered, but no usable table: remember for a while and read blind.
      Desc = 'missing';
      DESC_CACHE.Set(Key, 'missing', DESC_FAILED_TTL_MS);
    }
  }
  const Descriptors = Desc && Desc !== 'missing' ? Desc : null;
  Snap.HaveDescriptors = !!Descriptors;
  if (Descriptors) Snap.IsAja = true;

  // 2. Status parameters, then 3. alarms, a few at a time.
  const Wanted = STATUS_PARAMS.filter((P) => !Descriptors || Descriptors.Params.has(P));
  const AlarmIds = Descriptors ? Descriptors.Alarms.slice(0, MAX_ALARMS) : [];
  let AuthBlocked = false;

  const ReadParam = async (Param: string): Promise<AjaParam | null> => {
    const Reply = await Get(
      `/config?action=get&paramid=${encodeURIComponent(Param)}`,
      MAX_PARAM_BODY_BYTES
    );
    if (!Reply) return null;
    // 401 / 403 only: a 404 is just as likely a web server that is not AJA.
    if ((Reply.Status === 401 || Reply.Status === 403) && !Password) AuthBlocked = true;
    if (Reply.Status !== 200) return null;
    return ParseParamReply(Reply.Body, Param);
  };

  const RunPool = async (Items: string[], Each: (Item: string) => Promise<void>) => {
    let Next = 0;
    const Worker = async () => {
      while (Next < Items.length && Remaining() > 0) {
        const Item = Items[Next++] as string;
        await Each(Item);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Items.length) }, Worker));
  };

  await RunPool(Wanted, async (Param) => {
    const Value = await ReadParam(Param);
    if (Value) {
      Snap.Params[Param as StatusParam] = Value;
      Snap.IsAja = true;
    }
  });
  if (Remaining() <= 0 && Client.State.Reachable) Snap.Incomplete = 'status parameters';

  const Alarms: Array<AjaAlarm | null> = AlarmIds.map(() => null);
  if (!Snap.Incomplete) {
    await RunPool(
      AlarmIds.map((_, I) => String(I)),
      async (Index) => {
        const I = Number(Index);
        const Param = AlarmIds[I] as string;
        const Value = await ReadParam(Param);
        if (Value) Alarms[I] = DecodeAlarm(Param, Value.Value);
      }
    );
    if (Remaining() <= 0 && Client.State.Reachable && Alarms.some((A) => !A)) {
      Snap.Incomplete = 'alarms';
    }
  }
  Snap.Alarms = Alarms.filter((A): A is AjaAlarm => !!A);
  if (AuthBlocked && !Snap.IsAja) Snap.AuthRequired = true;

  return Finish();
}

// --- Settings / evaluation ----------------------------------------------------

export interface AjaConfig {
  Address: string;
  Port: number;
  Password: string;
  TimeoutMs: number;
}

function ParseConfig(Target: MonitoringTargetLike): AjaConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number(Cfg.Port);
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Port: Number.isFinite(Port) && Port > 0 ? Port | 0 : DEFAULT_PORT,
    Password: Cfg.Password == null ? '' : String(Cfg.Password),
    TimeoutMs: ResolveTimeoutMs(Cfg.Timeout),
  };
}

export interface AjaOptions {
  CheckAlarms: boolean;
  /** 0 Warning, 1 Error, 2 Fatal. */
  AlarmMinSeverity: number;
  CheckRecording: boolean;
  CheckMediaRemaining: boolean;
  MinMediaPercent: number;
}

function ParseOptions(Target: MonitoringTargetLike): AjaOptions {
  const Cfg = (Target && Target.Settings) || {};
  const Min = Number(Cfg.MinMediaPercent);
  const Sev = String(Cfg.AlarmMinSeverity || 'warning').toLowerCase();
  return {
    // Default ON: an absent key still checks alarms.
    CheckAlarms: Cfg.CheckAlarms !== false,
    AlarmMinSeverity: Sev === 'fatal' ? 2 : Sev === 'error' ? 1 : 0,
    CheckRecording: Cfg.CheckRecording === true,
    CheckMediaRemaining: Cfg.CheckMediaRemaining === true,
    MinMediaPercent:
      Number.isFinite(Min) && Min > 0 ? Math.min(99, Min) : DEFAULT_MIN_MEDIA_PERCENT,
  };
}

const IntOf = (P: AjaParam | undefined): number | null => {
  if (!P || !/^-?\d+$/.test(P.Value.trim())) return null;
  return Number(P.Value.trim());
};

/** A display label for an enum parameter: the device's own text, else our table. */
function EnumLabel(
  P: AjaParam | undefined,
  Table: Record<number, string>,
  PreferTable = false
): string | null {
  if (!P) return null;
  const N = IntOf(P);
  const Named = P.ValueName && P.ValueName !== P.Value ? P.ValueName : '';
  const FromTable = N != null ? Table[N] || '' : '';
  return (PreferTable ? FromTable || Named : Named || FromTable) || P.Value || null;
}

/** True / false when a recorder state was read, null when the device has none. */
export function IsRecording(Snap: AjaSnapshot): boolean | null {
  const KiPro = IntOf(Snap.Params.eParamID_TransportState);
  const Replicator = IntOf(Snap.Params.eParamID_ReplicatorRecordState);
  if (KiPro == null && Replicator == null) return null;
  return (
    KiPro === KIPRO_RECORDING ||
    Replicator === REPLICATOR_ACTIVE ||
    Replicator === REPLICATOR_FAILING_ACTIVE
  );
}

/** The recorder / streamer failure states, as reasons. */
export function RecorderFaults(Snap: AjaSnapshot): string[] {
  const Out: string[] = [];
  const KiPro = IntOf(Snap.Params.eParamID_TransportState);
  if (KiPro != null && KIPRO_ERRORS.has(KiPro)) {
    Out.push(`Transport: ${EnumLabel(Snap.Params.eParamID_TransportState, KIPRO_TRANSPORT)}`);
  }
  const Rec = IntOf(Snap.Params.eParamID_ReplicatorRecordState);
  if (Rec != null && REPLICATOR_FAILING.has(Rec)) {
    Out.push(`Recorder: ${RECORD_STATES[Rec]}`);
  }
  const Stream = IntOf(Snap.Params.eParamID_ReplicatorStreamState);
  if (Stream != null && REPLICATOR_FAILING.has(Stream)) {
    Out.push(`Streamer: ${STREAM_STATES[Stream]}`);
  }
  return Out;
}

export function MediaPercent(Snap: AjaSnapshot): number | null {
  const N = IntOf(Snap.Params.eParamID_CurrentMediaAvailable);
  return N == null ? null : Math.max(0, Math.min(100, N));
}

function AlarmText(A: AjaAlarm): string {
  const Sev = SEVERITY_LABELS[A.Severity] || 'Warning';
  return `${A.Label} (${Sev.toLowerCase()})${A.Details.length ? `: ${A.Details.join('; ')}` : ''}`;
}

// The reasons a reachable device is unhealthy, per the enabled assertions.
function EvaluateHealth(Snap: AjaSnapshot, Options: AjaOptions): string[] {
  if (Snap.AuthFailed) return ['The device refused the password'];
  if (Snap.AuthRequired) return ['The device requires a password'];
  if (!Snap.IsAja) return ['Responded, but does not look like an AJA device'];

  const Reasons: string[] = [];
  if (Snap.Incomplete) Reasons.push(`Timed out reading ${Snap.Incomplete}`);

  if (Options.CheckAlarms) {
    for (const A of Snap.Alarms) {
      if (A.Active && A.Severity >= Options.AlarmMinSeverity) Reasons.push(AlarmText(A));
    }
    Reasons.push(...RecorderFaults(Snap));
  }

  if (Options.CheckRecording) {
    const Recording = IsRecording(Snap);
    if (Recording === null) {
      if (!Snap.Incomplete) Reasons.push('Failed to read the recording state');
    } else if (!Recording) {
      const DataLan = IntOf(Snap.Params.eParamID_MediaState) === 1;
      const State =
        EnumLabel(Snap.Params.eParamID_TransportState, KIPRO_TRANSPORT) ??
        EnumLabel(Snap.Params.eParamID_ReplicatorRecordState, RECORD_STATES, true);
      Reasons.push(
        `Not recording (${State ? `state ${State}` : 'idle'}${DataLan ? ', media in Data - LAN mode' : ''})`
      );
    }
  }

  if (Options.CheckMediaRemaining) {
    const Pct = MediaPercent(Snap);
    if (Pct === null) {
      if (!Snap.Incomplete) Reasons.push('Failed to read media remaining');
    } else if (Pct < Options.MinMediaPercent) {
      Reasons.push(`${Pct}% media remaining (minimum ${Options.MinMediaPercent}%)`);
    }
  }
  return Reasons;
}

// --- Run ------------------------------------------------------------------------

const SnapshotKey = (Config: AjaConfig) =>
  `${HostKey(Config.Address, Config.Port)}|${PasswordKey(Config.Password)}|${Config.TimeoutMs}`;

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Success: false, Error: `Invalid port: ${Config.Port}` };
  }

  const Snap = (await SNAPSHOT_CACHE.GetOrCreate(
    SnapshotKey(Config),
    () => QueryAja(Config.Address, Config.Port, Config.Password, Config.TimeoutMs),
    { ttlMs: ResolveSnapshotTtlMs(Config.TimeoutMs) }
  )) as AjaSnapshot;

  if (!Snap.Reachable) {
    return { Success: false, Error: Snap.Error || 'No reply from the AJA device' };
  }

  const Options = ParseOptions(Target);
  const Reasons = EvaluateHealth(Snap, Options);
  const P = Snap.Params;

  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs: Snap.LatencyMs ?? null,
    IsAja: Snap.IsAja,
    AuthFailed: Snap.AuthFailed,
    AuthRequired: Snap.AuthRequired,
    HaveDescriptors: Snap.HaveDescriptors,
    SystemName: P.eParamID_SysName ? P.eParamID_SysName.Value : null,
    Transport: EnumLabel(P.eParamID_TransportState, KIPRO_TRANSPORT),
    RecordState: EnumLabel(P.eParamID_ReplicatorRecordState, RECORD_STATES, true),
    StreamState: EnumLabel(P.eParamID_ReplicatorStreamState, STREAM_STATES, true),
    Recording: IsRecording(Snap),
    MediaState: P.eParamID_MediaState
      ? P.eParamID_MediaState.ValueName || P.eParamID_MediaState.Value
      : null,
    MediaRemainingPercent: MediaPercent(Snap),
    VideoInput: P.eParamID_VideoInSelect
      ? P.eParamID_VideoInSelect.ValueName || P.eParamID_VideoInSelect.Value
      : null,
    CurrentClip: P.eParamID_CurrentClip ? P.eParamID_CurrentClip.Value || null : null,
    Timecode: P.eParamID_DisplayTimecode ? P.eParamID_DisplayTimecode.Value || null : null,
    Temperature: P.eParamID_Temperature ? P.eParamID_Temperature.Value : null,
    Alarms: Snap.Alarms,
    ActiveAlarms: Snap.Alarms.filter((A) => A.Active).length,
    Incomplete: Snap.Incomplete,
  };
}

// --- Actions --------------------------------------------------------------------

const TRANSPORT_COMMAND = 'eParamID_TransportCommand';
const REPLICATOR_COMMAND = 'eParamID_ReplicatorCommand';

type AjaFamily = 'kipro' | 'helo';

// Per action: the command value for each family that has one.
const ACTION_COMMANDS: Record<string, Partial<Record<AjaFamily, number>> & { Detail: string }> = {
  'record.start': { kipro: 3, helo: 1, Detail: 'Record started' },
  'record.stop': { kipro: 4, helo: 2, Detail: 'Recording stopped' },
  play: { kipro: 1, Detail: 'Play started' },
  'stream.start': { helo: 3, Detail: 'Streaming started' },
  'stream.stop': { helo: 4, Detail: 'Streaming stopped' },
};

const FAMILY_PARAM: Record<AjaFamily, string> = {
  kipro: TRANSPORT_COMMAND,
  helo: REPLICATOR_COMMAND,
};

const Actions: MonitoringActionDef[] = [
  {
    ID: 'record.start',
    Label: 'Record',
    Icon: 'record-circle',
    Group: 'Transport',
    Note: 'Starts recording on a Ki Pro or HELO.',
  },
  {
    ID: 'record.stop',
    Label: 'Stop',
    Icon: 'stop',
    Group: 'Transport',
    Destructive: true,
    Note: 'Stops recording on a HELO, or sends Stop to a Ki Pro, which ends a recording or playback.',
  },
  {
    ID: 'play',
    Label: 'Play',
    Icon: 'play',
    Group: 'Transport',
    Note: 'Plays the current clip. Ki Pro only.',
  },
  {
    ID: 'stream.start',
    Label: 'Start Streaming',
    Icon: 'broadcast',
    Group: 'Streaming',
    Note: 'Starts the stream with the selected streaming profile. HELO only.',
  },
  {
    ID: 'stream.stop',
    Label: 'Stop Streaming',
    Icon: 'stop-circle',
    Group: 'Streaming',
    Destructive: true,
    Note: 'Stops the stream. HELO only.',
  },
];

const FAMILY_NAMES: Record<AjaFamily, string> = { kipro: 'Ki Pro', helo: 'HELO' };

async function RunAction(
  Target: MonitoringTargetLike,
  ActionID: string
): Promise<MonitoringActionResult> {
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Success: false, Error: `Invalid port: ${Config.Port}` };
  }
  const Spec = ACTION_COMMANDS[ActionID];
  if (!Spec) return { Success: false, Error: `Unknown AJA action "${ActionID}"` };

  const BudgetMs = Math.max(500, Config.TimeoutMs | 0);
  const Client = CreateAjaClient(
    Config.Address,
    Config.Port,
    Config.Password,
    Date.now() + BudgetMs
  );
  const Unreachable = (): MonitoringActionResult => {
    if (Client.State.AuthFailed)
      return { Success: false, Error: 'The device refused the password' };
    if (Client.State.Reachable)
      return { Success: false, Error: 'The device did not answer in time' };
    return {
      Success: false,
      Error: Client.State.LastError || `No reply from the AJA device after ${BudgetMs}ms`,
    };
  };
  if (!(await Client.Start())) return Unreachable();

  // Which command parameter does this device have? The cached descriptors say
  // for sure; without them, a plain get of each tells (read-only).
  const Desc = DESC_CACHE.Get(HostKey(Config.Address, Config.Port)) as
    AjaDescriptors | 'missing' | null;
  const Has = async (Param: string): Promise<boolean | null> => {
    if (Desc && Desc !== 'missing') return Desc.Params.has(Param);
    const Reply = await Client.Get(
      `/config?action=get&paramid=${encodeURIComponent(Param)}`,
      MAX_PARAM_BODY_BYTES
    );
    if (!Reply) return null;
    if (Reply.Status === 401 || Reply.Status === 403) {
      Client.State.AuthFailed = true;
      return null;
    }
    return Reply.Status === 200 && !!ParseParamReply(Reply.Body, Param);
  };
  let Family: AjaFamily | null = null;
  for (const Candidate of ['helo', 'kipro'] as AjaFamily[]) {
    const Present = await Has(FAMILY_PARAM[Candidate]);
    if (Present === null) {
      return Client.State.AuthFailed && !Config.Password
        ? { Success: false, Error: 'The device requires a password' }
        : Unreachable();
    }
    if (Present) {
      Family = Candidate;
      break;
    }
  }
  if (!Family) {
    // A HELO with authentication on answers 404 to everything (AJA chapter 03).
    return {
      Success: false,
      Error: Config.Password
        ? 'This device has no transport control (it is not a Ki Pro or HELO)'
        : 'This device has no transport control, or it needs a password (it is not a Ki Pro or HELO)',
    };
  }
  const Value = Spec[Family];
  if (Value === undefined) {
    const What = ActionID === 'play' ? 'play' : 'streaming';
    return { Success: false, Error: `This ${FAMILY_NAMES[Family]} has no ${What} control` };
  }

  const Param = FAMILY_PARAM[Family];
  const Reply = await Client.Get(
    `/config?action=set&paramid=${encodeURIComponent(Param)}&value=${Value}`,
    MAX_PARAM_BODY_BYTES
  );
  if (!Reply) return Unreachable();
  if (Reply.Status === 401 || Reply.Status === 403) {
    return {
      Success: false,
      Error: Config.Password ? 'The device refused the password' : 'The device requires a password',
    };
  }
  if (Reply.Status !== 200) {
    return {
      Success: false,
      Error: `The device did not accept the command (HTTP ${Reply.Status})`,
    };
  }
  // A set answers the same four-field object as a get (AJA chapter 01).
  if (!ParseParamReply(Reply.Body, Param)) {
    return { Success: false, Error: 'The device answered, but not with a command confirmation' };
  }
  // A Ki Pro's Stop pauses first (a second Stop idles it), so say what was sent.
  const Detail = Family === 'kipro' && ActionID === 'record.stop' ? 'Stop sent' : Spec.Detail;
  return { Success: true, Detail };
}

// A transport command has just changed what the cached snapshot describes.
function InvalidateCaches(Target: MonitoringTargetLike): void {
  const Config = ParseConfig(Target);
  SNAPSHOT_CACHE.Delete(SnapshotKey(Config));
}

// --- Debug ----------------------------------------------------------------------

function AlarmPill(A: AjaAlarm): string {
  if (A.Undecodable) return Pill('muted', 'Unreadable');
  if (!A.Active) return Pill('success', 'Normal');
  if (A.Severity >= 1) return Pill('danger', SEVERITY_LABELS[A.Severity] || 'Error');
  return Pill('warning', 'Warning');
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseConfig(Target);
  const Options = ParseOptions(Target);
  const Reachable = !!(Result && Result.Success === true);

  const Head = Rows([
    TextRow('Host', `${Config.Address || '—'}:${Config.Port}`),
    Reachable && Result.SystemName ? TextRow('Name', String(Result.SystemName)) : null,
    Row('Status', BmdStatePill(Result, 'Healthy')),
    Reachable && Result.DegradedReason ? TextRow('Reason', String(Result.DegradedReason)) : null,
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Failed to reach the AJA device'),
  ]);

  if (!Reachable) {
    return (
      Head +
      '<div class="mt-2">' +
      Note(
        `Failed to reach the AJA REST API (HTTP ${Config.Port}). Check the address and that the device's web interface is reachable.`
      ) +
      '</div>'
    );
  }
  if (Result.AuthFailed || Result.AuthRequired || Result.IsAja === false) return Head;

  const Status = Rows([
    Result.Transport ? TextRow('Transport', String(Result.Transport)) : null,
    Result.RecordState ? TextRow('Recorder', String(Result.RecordState)) : null,
    Result.StreamState ? TextRow('Streamer', String(Result.StreamState)) : null,
    Result.Recording != null
      ? Row(
          'Recording',
          Pill(Result.Recording ? 'danger' : 'muted', Result.Recording ? 'Yes' : 'No')
        )
      : null,
    Result.MediaState ? TextRow('Media mode', String(Result.MediaState)) : null,
    typeof Result.MediaRemainingPercent === 'number'
      ? MonoRow(
          'Media remaining',
          `${Result.MediaRemainingPercent}%${Options.CheckMediaRemaining ? ` (minimum ${Options.MinMediaPercent}%)` : ''}`
        )
      : null,
    Result.VideoInput ? TextRow('Video input', String(Result.VideoInput)) : null,
    Result.CurrentClip ? TextRow('Clip', String(Result.CurrentClip)) : null,
    Result.Timecode ? MonoRow('Timecode', String(Result.Timecode)) : null,
    Result.Temperature != null ? MonoRow('Temperature', String(Result.Temperature)) : null,
  ]);

  const Alarms: AjaAlarm[] = Array.isArray(Result.Alarms) ? (Result.Alarms as AjaAlarm[]) : [];
  // Active alarms first; within each group keep the device's own order.
  const Ordered = [...Alarms.filter((A) => A.Active), ...Alarms.filter((A) => !A.Active)];
  const AlarmCards = Ordered.map((A) =>
    Card({
      Title: A.Label,
      Badge: AlarmPill(A),
      BodyHtml: A.Details.length
        ? `<div class="text-muted small text-break">${A.Details.map(Esc).join(' · ')}</div>`
        : '',
    })
  ).join('');

  return (
    Head +
    `<div class="mt-2">${Status}</div>` +
    (Alarms.length
      ? `<div class="text-muted small mt-2 mb-1">Alarms (${Number(Result.ActiveAlarms) || 0} active of ${Alarms.length})</div>` +
        `<div class="d-grid gap-1">${AlarmCards}</div>`
      : '<div class="mt-2">' +
        Note(
          Result.HaveDescriptors
            ? 'This device reports no alarm parameters.'
            : 'Alarms could not be listed because the device did not return its parameter descriptors (desc.json).'
        ) +
        '</div>')
  );
}

export const Name = 'AJA Device';
export const Description =
  "Reads an AJA Ki Pro, HELO, FS-series frame sync or other AJA network device over AJA's REST parameter API, sending queries only. Degraded when the device raises an alarm or its recorder reports a failure; optionally also when it is not recording or media remaining drops below a minimum.";
export const Group = 'Video';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseParamReply,
  ParseDescriptors,
  DecodeAlarm,
  ParseConfig,
  ParseOptions,
  IsRecording,
  RecorderFaults,
  MediaPercent,
  EvaluateHealth,
  QueryAja,
  DESC_CACHE,
  SESSION_CACHE,
  SNAPSHOT_CACHE,
};
export { ID, Settings, Actions, Run, RunAction, InvalidateCaches, Debug };
