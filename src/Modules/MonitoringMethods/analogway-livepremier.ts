// Analog Way LivePremier presentation system check (Aquilon RS / C series and
// other units running LivePremier firmware 4.0 or later) over the LivePremier
// REST API.
//
// Protocol (Analog Way "LivePremier REST API Programmer's Guide" v4.0, January
// 2024, and v4.01, June 2025):
//   - Plain HTTP on port 80, base path /api/tpp/v1. GET requests are documented
//     as read-only ("making a GET request cannot change the state of any
//     information stored on the LivePremier"); the check (Run) only ever GETs.
//   - The REST API must be enabled in the Web RCS under Application
//     Programming Interfaces.
//   - When the Web RCS is password protected every call answers 401 until the
//     client logs in with POST /auth/login?identifier=Admin&password=... and sends
//     the returned auth-jwt cookie on later calls. That login is the only POST
//     the check makes; it changes nothing on the unit. Section 10.1 documents
//     no other form (no body, no header), so the password has to travel in the
//     query string, in clear over plain HTTP like the rest of the API. That URL
//     is built in one place (Login below) and never logged or put in a result:
//     a failed login reports only the socket error.
//
// Endpoints used:
//   GET /api/tpp/v1/system           → { type, label, version: {major, minor, patch, beta} }
//   GET /api/tpp/v1/inputs/{inputId} → { isEnabled, capacity, label, isValid, isFrozen }
//
// NOT AVAILABLE: the REST API documents no power supply, fan or temperature
// readings, so this check cannot report device hardware health. Those live
// only in Analog Way's AWJ protocol, which is not publicly documented.
// Midra 4K / Pulse 4K units do not offer this REST API.
//
// Actions (section 3, both guide versions; all POST, answering 204 or 200):
//   memory.preview /  POST /screens/{screenId}/load-memory
//   memory.program    {"memoryId": 1–1000, "target": "preview" | "program"}
//                     once per chosen screen (screens 1–24)
//   transition.take   POST /screens/{screenId}/take  (no body)
// Errors are 400 / 404 / 409 with a JSON body explaining them.
//
// The session cookie is cached per unit so a protected unit is not logged in
// to on every poll; the actions share it. A cache entry is dropped once no check has used it for
// MONITORING_INTEREST_TTL_MS, or as soon as the unit rejects it.
//
// Result semantics:
//   - No answer, or /system is not the LivePremier API          -> offline.
//   - Password missing or rejected                              -> degraded.
//   - Any enabled assertion breached                            -> degraded.
import {
  BuildBaseUrl,
  WithPath,
  RequestJson,
  IsObject,
  StrOrNull,
  NumOrNull,
  BoolOrNull,
  AsList,
  TimeoutOf,
  DeviceErrorText,
  type JsonRequest,
  type JsonResponse,
} from './_videoproc-http-shared';
import { Card, Esc, FormatLatency, Note, Pill, Row, Rows, TextRow } from './debug';
import { createHash } from 'crypto';
import { DEFAULT_MONITORING_INTERVAL_MS, MONITORING_INTEREST_TTL_MS } from '../Config/constants';
import type {
  MonitoringActionDef,
  MonitoringActionResult,
  MonitoringResult,
  MonitoringSettingField,
  MonitoringTargetLike,
} from './types';

const ID = 'analogway-livepremier';
const API_BASE = '/api/tpp/v1';
const LOGIN_IDENTIFIER = 'Admin';
const DEFAULT_TIMEOUT_MS = 6000;
const ACTION_TIMEOUT_MS = 5000;
const MAX_SCREEN = 24;
const MAX_MEMORY = 1000;
// Inputs read per probe. The API numbers inputs 1–256; a check watching more
// than this many is almost certainly a typo, and each is its own request.
const MAX_INPUTS = 48;

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'Port',
    Type: 'number',
    Default: 80,
    Min: 1,
    Max: 65535,
    Advanced: true,
    Note: 'The REST API is served on port 80. Change it only for the LivePremier simulator.',
  },
  {
    Key: 'Password',
    Label: 'Web RCS password',
    Type: 'string',
    Default: '',
    Sensitive: true,
    Note: 'Only needed when the Web RCS is password protected. ShowTrak logs in as Admin.',
  },
  {
    Key: 'CheckInputs',
    Label: 'Check input signal',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when a listed input has no valid signal, is disabled or does not exist.',
  },
  {
    Key: 'Inputs',
    Label: 'Inputs to watch',
    Type: 'list',
    ItemType: 'number',
    Default: [],
    VisibleWhen: { Key: 'CheckInputs', Equals: true },
    Note: 'Input numbers as shown in the Web RCS, e.g. 1, 2, 5.',
  },
  {
    Key: 'CheckFrozen',
    Label: 'Check frozen inputs',
    Type: 'boolean',
    Default: false,
    VisibleWhen: { Key: 'CheckInputs', Equals: true },
    Note: 'Also report Degraded while a listed input is frozen.',
  },
  {
    Key: 'CheckFirmware',
    Label: 'Check firmware version',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when the unit runs a different firmware version.',
  },
  {
    Key: 'ExpectedFirmware',
    Label: 'Expected firmware',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'CheckFirmware', Equals: true },
    Note: 'Major.minor.patch, e.g. 4.1.12.',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: DEFAULT_TIMEOUT_MS,
    Min: 500,
    Max: 30000,
    Advanced: true,
  },
];

// --- Session cookie cache ---------------------------------------------------

interface CachedSession {
  Cookie: string;
  LastUsedAt: number;
}

const Sessions = new Map<string, CachedSession>();

// Keyed by unit and a hash of the password, so the plaintext is not kept as a
// map key and a changed password never reuses the old session.
function SessionKey(Base: URL, Password: string): string {
  return `${Base.host}\u0000${createHash('sha256').update(Password).digest('hex')}`;
}

function PruneSessions(Now: number): void {
  for (const [Key, Entry] of Sessions) {
    if (Now - Entry.LastUsedAt > MONITORING_INTEREST_TTL_MS) Sessions.delete(Key);
  }
}

// The auth-jwt cookie from a login reply's Set-Cookie header(s).
function ExtractAuthCookie(Res: JsonResponse): string | null {
  if (!Res.Ok) return null;
  const Raw = Res.Headers['set-cookie'];
  const List = Array.isArray(Raw) ? Raw : Raw ? [Raw] : [];
  for (const Line of List) {
    const Match = String(Line).match(/(?:^|;\s*)(auth-jwt=[^;]+)/);
    if (Match) return Match[1] as string;
  }
  return null;
}

// One unit's API calls against a shared deadline, logged in on demand: a 401
// with a password configured triggers one login and one retry, and a session
// the unit rejects is dropped. A 401 that survives that is returned as is
// (password missing or wrong) for the caller to word.
class ApiSession {
  private Cookie: string | null;
  private readonly Key: string;
  private LoggedIn = false;

  constructor(
    private readonly Base: URL,
    private readonly Password: string,
    private readonly DeadlineAt: number
  ) {
    const Now = Date.now();
    PruneSessions(Now);
    this.Key = SessionKey(Base, Password);
    this.Cookie = Password ? Sessions.get(this.Key)?.Cookie || null : null;
  }

  private Send(
    Path: string,
    Request: Omit<JsonRequest, 'DeadlineAt' | 'Headers'>
  ): Promise<JsonResponse> {
    return RequestJson(WithPath(this.Base, `${API_BASE}${Path}`), {
      ...Request,
      DeadlineAt: this.DeadlineAt,
      ...(this.Cookie ? { Headers: { Cookie: this.Cookie } } : {}),
    });
  }

  // The documented login. Returns null on success, else the transport error.
  private async Login(): Promise<string | null> {
    Sessions.delete(this.Key);
    this.Cookie = null;
    this.LoggedIn = true;
    // The only place the password enters a URL (see the header comment).
    const LoginPath =
      `/auth/login?identifier=${encodeURIComponent(LOGIN_IDENTIFIER)}` +
      `&password=${encodeURIComponent(this.Password)}`;
    const Res = await RequestJson(WithPath(this.Base, LoginPath), {
      Method: 'POST',
      DeadlineAt: this.DeadlineAt,
    });
    if (!Res.Ok) return Res.Error;
    this.Cookie = ExtractAuthCookie(Res);
    if (this.Cookie) Sessions.set(this.Key, { Cookie: this.Cookie, LastUsedAt: Date.now() });
    return null;
  }

  async Request(
    Path: string,
    Request: Omit<JsonRequest, 'DeadlineAt' | 'Headers'>
  ): Promise<JsonResponse> {
    let Res = await this.Send(Path, Request);
    if (Res.Ok && Res.Status === 401 && this.Password && !this.LoggedIn) {
      // No session yet, or the cached one expired: log in once and retry.
      const LoginError = await this.Login();
      if (LoginError) return { Ok: false, Error: `Login failed: ${LoginError}` };
      if (!this.Cookie) return Res;
      Res = await this.Send(Path, Request);
    }
    if (Res.Ok && Res.Status === 401) {
      Sessions.delete(this.Key);
      this.Cookie = null;
    } else if (Res.Ok && this.Cookie) {
      Sessions.set(this.Key, { Cookie: this.Cookie, LastUsedAt: Date.now() });
    }
    return Res;
  }
}

// --- Parsing ----------------------------------------------------------------

export interface LivePremierSystem {
  Type: string;
  Label: string | null;
  Firmware: string | null;
  Beta: boolean;
}

export interface LivePremierInput {
  Id: number;
  Label: string | null;
  Found: boolean;
  Enabled: boolean | null;
  Valid: boolean | null;
  Frozen: boolean | null;
  Error?: string;
}

function ParseSystem(Json: unknown): LivePremierSystem | null {
  if (!IsObject(Json)) return null;
  const Type = StrOrNull(Json.type);
  if (!Type || !IsObject(Json.version)) return null;
  const V = Json.version;
  const Parts = [NumOrNull(V.major), NumOrNull(V.minor), NumOrNull(V.patch)];
  return {
    Type,
    Label: StrOrNull(Json.label),
    Firmware: Parts.every((P) => P != null) ? Parts.join('.') : null,
    Beta: V.beta === true,
  };
}

function ParseInput(Id: number, Json: unknown): LivePremierInput {
  const O = IsObject(Json) ? Json : {};
  return {
    Id,
    Label: StrOrNull(O.label),
    Found: true,
    Enabled: BoolOrNull(O.isEnabled),
    Valid: BoolOrNull(O.isValid),
    Frozen: BoolOrNull(O.isFrozen),
  };
}

function ParseInputIds(Value: unknown): number[] {
  const Out: number[] = [];
  for (const Raw of AsList(Value)) {
    const N = Number(Raw);
    if (Number.isInteger(N) && N >= 1 && N <= 256 && !Out.includes(N)) Out.push(N);
  }
  return Out.slice(0, MAX_INPUTS);
}

function NormalizeVersion(Value: unknown): string {
  return String(Value == null ? '' : Value)
    .trim()
    .replace(/^v/i, '');
}

function InputName(I: LivePremierInput): string {
  return `Input ${I.Id}${I.Label ? ` (${I.Label})` : ''}`;
}

// The reasons a reachable unit is unhealthy, per the enabled toggles. Pure.
function EvaluateHealth(
  System: LivePremierSystem,
  Inputs: LivePremierInput[],
  Cfg: Record<string, unknown>
): string[] {
  const Reasons: string[] = [];

  if (Cfg.CheckFirmware) {
    const Want = NormalizeVersion(Cfg.ExpectedFirmware);
    if (Want && System.Firmware && System.Firmware !== Want) {
      Reasons.push(`Firmware ${System.Firmware} (expected ${Want})`);
    }
  }

  if (Cfg.CheckInputs) {
    for (const I of Inputs) {
      if (I.Error) Reasons.push(`${InputName(I)}: ${I.Error}`);
      else if (!I.Found) Reasons.push(`${InputName(I)}: not found`);
      else if (I.Enabled === false) Reasons.push(`${InputName(I)}: disabled`);
      else if (I.Valid === false) Reasons.push(`${InputName(I)}: no valid signal`);
      else if (Cfg.CheckFrozen && I.Frozen === true) Reasons.push(`${InputName(I)}: frozen`);
    }
  }

  return Reasons;
}

// --- Run --------------------------------------------------------------------

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Cfg = (Target && Target.Settings) || {};
  const Port =
    Number.isFinite(Number(Cfg.Port)) && Number(Cfg.Port) > 0 ? Number(Cfg.Port) | 0 : 80;
  const Base = BuildBaseUrl(Target && Target.Address, 'http', Port);
  if (!Base) return { Success: false, Error: 'No address configured' };
  // Deliberately not trimmed: trailing whitespace can be part of a password.
  const Password = Cfg.Password == null ? '' : String(Cfg.Password);

  const Started = Date.now();
  const DeadlineAt = Started + TimeoutOf(Cfg, DEFAULT_TIMEOUT_MS);
  const Session = new ApiSession(Base, Password, DeadlineAt);
  const Get = (Path: string) => Session.Request(Path, { Method: 'GET' });

  const SystemRes = await Get('/system');
  if (!SystemRes.Ok) return { Success: false, Error: SystemRes.Error };
  if (SystemRes.Status === 401) {
    return {
      Success: true,
      Degraded: true,
      AuthFailed: true,
      LatencyMs: Date.now() - Started,
      DegradedReason: Password
        ? 'The Web RCS password was rejected'
        : 'The Web RCS is password protected. Enter the password.',
    };
  }
  if (SystemRes.Status !== 200) {
    return {
      Success: false,
      Error: `HTTP ${SystemRes.Status} from ${API_BASE}/system. Check the REST API is enabled in the Web RCS.`,
    };
  }
  const System = ParseSystem(SystemRes.Json);
  if (!System) return { Success: false, Error: 'Answered, but not with the LivePremier REST API' };
  const LatencyMs = Date.now() - Started;

  const Inputs: LivePremierInput[] = [];
  if (Cfg.CheckInputs) {
    for (const Id of ParseInputIds(Cfg.Inputs)) {
      const Res = await Get(`/inputs/${Id}`);
      if (!Res.Ok) {
        Inputs.push({
          Id,
          Label: null,
          Found: false,
          Enabled: null,
          Valid: null,
          Frozen: null,
          Error: Res.Error,
        });
      } else if (Res.Status === 404) {
        Inputs.push({ Id, Label: null, Found: false, Enabled: null, Valid: null, Frozen: null });
      } else if (Res.Status !== 200 || !IsObject(Res.Json)) {
        Inputs.push({
          Id,
          Label: null,
          Found: false,
          Enabled: null,
          Valid: null,
          Frozen: null,
          Error: `HTTP ${Res.Status}`,
        });
      } else {
        Inputs.push(ParseInput(Id, Res.Json));
      }
    }
  }

  const Reasons = EvaluateHealth(System, Inputs, Cfg);
  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs,
    DeviceType: System.Type,
    DeviceLabel: System.Label,
    Firmware: System.Firmware,
    FirmwareBeta: System.Beta,
    Inputs,
  };
}

// --- Actions ----------------------------------------------------------------

const MEMORY_PARAM: MonitoringSettingField = {
  Key: 'Memory',
  Label: 'Memory',
  Type: 'number',
  Required: true,
  Note: 'The screen memory number, 1 to 1000, as shown in the Web RCS.',
};

const SCREENS_PARAM: MonitoringSettingField = {
  Key: 'Screens',
  Label: 'Screens',
  Type: 'list',
  ItemType: 'number',
  Default: [1],
  Note: 'The screen numbers (1 to 24) to load the memory on.',
};

const Actions: MonitoringActionDef[] = [
  {
    ID: 'memory.preview',
    Label: 'Load Memory to Preview',
    Icon: 'collection',
    Group: 'Presets',
    Params: [MEMORY_PARAM, SCREENS_PARAM],
    Note: 'Loads a screen memory to Preview on one or more screens, ready to check before a take. The audience sees no change.',
  },
  {
    ID: 'memory.program',
    Label: 'Load Memory to Program',
    Icon: 'collection-play',
    Group: 'Presets',
    Destructive: true,
    Params: [MEMORY_PARAM, SCREENS_PARAM],
    Note: 'Loads a screen memory straight to Program on one or more screens, changing them at once.',
  },
  {
    ID: 'transition.take',
    Label: 'Take',
    Icon: 'arrow-right-square',
    Group: 'Transitions',
    Destructive: true,
    Params: [
      {
        Key: 'Screen',
        Label: 'Screen',
        Type: 'number',
        Default: 1,
        Required: true,
        Note: 'The screen number, 1 to 24.',
      },
    ],
    Note: 'Transitions one screen from Preview to Program.',
  },
];

function WholeNumberIn(Value: unknown, Min: number, Max: number): number | null {
  const N = Number(String(Value == null ? '' : Value).trim());
  return Number.isInteger(N) && N >= Min && N <= Max && String(Value).trim() !== '' ? N : null;
}

// The screens a Load Memory acts on: every entry must be a valid screen number.
function ParseScreens(Value: unknown): number[] | null {
  const Raw = AsList(Array.isArray(Value) || typeof Value === 'string' ? Value : [Value]);
  if (!Raw.length) return null;
  const Out: number[] = [];
  for (const Entry of Raw) {
    const N = WholeNumberIn(Entry, 1, MAX_SCREEN);
    if (N == null) return null;
    if (!Out.includes(N)) Out.push(N);
  }
  return Out;
}

function ListText(Screens: number[]): string {
  return Screens.length === 1 ? `screen ${Screens[0]}` : `screens ${Screens.join(', ')}`;
}

// Why a POST was not accepted, in the operator's terms.
function RefusalText(Res: JsonResponse, What: string, Password: string): string {
  if (!Res.Ok) return Res.Error;
  if (Res.Status === 401) {
    return Password
      ? 'The Web RCS password was rejected'
      : 'The Web RCS is password protected. Enter the password in the check settings.';
  }
  const Why = DeviceErrorText(Res.Json, Res.Body);
  if (Res.Status === 404) return `${What} does not exist on this unit${Why ? ` (${Why})` : ''}`;
  return `The unit refused it (HTTP ${Res.Status})${Why ? `: ${Why}` : ''}`;
}

function Accepted(Res: JsonResponse): boolean {
  return Res.Ok && (Res.Status === 200 || Res.Status === 204);
}

async function RunAction(
  Target: MonitoringTargetLike,
  ActionID: string,
  Params: Record<string, unknown> = {}
): Promise<MonitoringActionResult> {
  const Cfg = (Target && Target.Settings) || {};
  const Port =
    Number.isFinite(Number(Cfg.Port)) && Number(Cfg.Port) > 0 ? Number(Cfg.Port) | 0 : 80;
  const Base = BuildBaseUrl(Target && Target.Address, 'http', Port);
  if (!Base) return { Success: false, Error: 'No address configured' };
  const Password = Cfg.Password == null ? '' : String(Cfg.Password);
  const DeadlineAt = Date.now() + Math.min(TimeoutOf(Cfg, DEFAULT_TIMEOUT_MS), ACTION_TIMEOUT_MS);

  if (ActionID === 'memory.preview' || ActionID === 'memory.program') {
    const Memory = WholeNumberIn(Params.Memory, 1, MAX_MEMORY);
    if (Memory == null) {
      return { Success: false, Error: `Memory must be a whole number from 1 to ${MAX_MEMORY}` };
    }
    const Screens = ParseScreens(Params.Screens == null ? [1] : Params.Screens);
    if (!Screens) {
      return {
        Success: false,
        Error: `Screens must be one or more screen numbers from 1 to ${MAX_SCREEN}`,
      };
    }
    const Destination = ActionID === 'memory.program' ? 'program' : 'preview';
    const Session = new ApiSession(Base, Password, DeadlineAt);
    const Done: number[] = [];
    for (const Screen of Screens) {
      const Res = await Session.Request(`/screens/${Screen}/load-memory`, {
        Method: 'POST',
        Json: { memoryId: Memory, target: Destination },
      });
      if (!Accepted(Res)) {
        const Why = RefusalText(Res, `Screen ${Screen} or memory ${Memory}`, Password);
        return {
          Success: false,
          Error: Done.length
            ? `Memory ${Memory} loaded on ${ListText(Done)}, but not on screen ${Screen}: ${Why}`
            : `Memory ${Memory} not loaded on screen ${Screen}: ${Why}`,
        };
      }
      Done.push(Screen);
    }
    const To = Destination === 'program' ? 'Program' : 'Preview';
    return { Success: true, Detail: `Memory ${Memory} loaded to ${To} on ${ListText(Done)}` };
  }

  if (ActionID === 'transition.take') {
    const Screen = WholeNumberIn(Params.Screen, 1, MAX_SCREEN);
    if (Screen == null) {
      return { Success: false, Error: `Screen must be a whole number from 1 to ${MAX_SCREEN}` };
    }
    const Session = new ApiSession(Base, Password, DeadlineAt);
    const Res = await Session.Request(`/screens/${Screen}/take`, { Method: 'POST' });
    if (!Accepted(Res)) {
      return {
        Success: false,
        Error: `Take on screen ${Screen} failed: ${RefusalText(Res, `Screen ${Screen}`, Password)}`,
      };
    }
    return { Success: true, Detail: `Take on screen ${Screen}` };
  }

  return { Success: false, Error: `Unknown LivePremier action "${ActionID}"` };
}

function DescribeAction(ActionID: string, Params: Record<string, unknown>): string | null {
  const P = Params || {};
  if (ActionID === 'memory.preview' || ActionID === 'memory.program') {
    const Memory = WholeNumberIn(P.Memory, 1, MAX_MEMORY);
    const Screens = ParseScreens(P.Screens == null ? [1] : P.Screens);
    if (Memory == null || !Screens) return null;
    const To = ActionID === 'memory.program' ? 'Program' : 'Preview';
    const On = ListText(Screens);
    return `Load Memory ${Memory} - ${On.charAt(0).toUpperCase()}${On.slice(1)} (${To})`;
  }
  if (ActionID === 'transition.take') {
    const Screen = WholeNumberIn(P.Screen, 1, MAX_SCREEN);
    return Screen == null ? null : `Take - Screen ${Screen}`;
  }
  return null;
}

// --- Debug ------------------------------------------------------------------

function StatePill(Result: MonitoringResult): string {
  const Reachable = !!(Result && Result.Success === true);
  if (Reachable && !Result.Degraded) return Pill('success', 'Healthy');
  if (Reachable) return Pill('warning', Result.DegradedReason || 'Degraded');
  return Pill('danger', 'Offline');
}

function InputPill(I: LivePremierInput): string {
  if (I.Error) return Pill('danger', I.Error);
  if (!I.Found) return Pill('danger', 'Not found');
  if (I.Enabled === false) return Pill('muted', 'Disabled');
  if (I.Valid === false) return Pill('warning', 'No signal');
  if (I.Frozen === true) return Pill('warning', 'Frozen');
  if (I.Valid === true) return Pill('success', 'Valid');
  return Pill('muted', 'Unknown');
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  const Reachable = !!(Result && Result.Success === true);
  const Identified = Reachable && !!Result.DeviceType;

  const Head = Rows([
    TextRow(
      'Unit',
      `${Address || '-'}${Result && Result.DeviceLabel ? ` (${Result.DeviceLabel})` : ''}`
    ),
    Row('Status', StatePill(Result)),
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Failed to reach the unit'),
    Identified ? TextRow('Model', String(Result.DeviceType)) : null,
    Identified && Result.Firmware
      ? Row(
          'Firmware',
          `<span class="font-monospace">${Esc(Result.Firmware)}</span>` +
            (Result.FirmwareBeta ? ` ${Pill('warning', 'Beta')}` : '')
        )
      : null,
  ]);
  if (!Reachable) {
    return (
      Head +
      '<div class="mt-2">' +
      Note(
        'Failed to reach the LivePremier REST API. Check it is enabled under Application Programming Interfaces in the Web RCS.'
      ) +
      '</div>'
    );
  }
  const Inputs = Array.isArray(Result.Inputs) ? (Result.Inputs as LivePremierInput[]) : [];
  if (!Inputs.length) return Head;
  const Cards = Inputs.map((I) =>
    Card({ Title: InputName(I), Badge: InputPill(I), Highlight: I.Valid === true && !I.Frozen })
  ).join('');
  return Head + `<div class="d-grid gap-1 mt-2">${Cards}</div>`;
}

export const Name = 'Analog Way LivePremier';
export const Description =
  'Reads an Analog Way LivePremier unit (Aquilon RS / C series) over its REST API: model, label and firmware, plus the signal and freeze state of listed inputs. Optionally flags inputs without a valid signal and an unexpected firmware. The REST API does not expose power supply, fan or temperature health. The check only reads; Load Memory and Take are offered as actions.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseSystem,
  ParseInput,
  ParseInputIds,
  ExtractAuthCookie,
  EvaluateHealth,
  ParseScreens,
  SessionKey,
  Sessions,
  MAX_INPUTS,
};
export { ID, Settings, Actions, Run, RunAction, DescribeAction, Debug };
