// Barco Event Master processor check (E2, S3, EX, Encore3 and other Event
// Master frames) over the Event Master JSON-RPC API.
//
// Protocol (Barco "JSON RPC with Event Master processors" doc 8.2 and "JSON RPC
// for Encore3 Processors v10.0", both shipped in Bitfocus
// companion-module-barco-eventmaster/docs; transport path from that module's
// barco-eventmaster client library):
//   - JSON-RPC 2.0 over plain HTTP POST to the host processor on fixed port
//     9999 ({"jsonrpc":"2.0","id":…,"method":…,"params":{}}). In a host + client
//     system, requests go to the host unit. The Barco docs give only the port
//     ("Enter the request URL with port 9999"); the /jsonrpc path is the one
//     the open-source client the Companion module uses posts to, so it is an
//     Advanced setting rather than a constant.
//   - Each result is {"success":0,"response":…}; success other than 0 is an
//     error.
//
// Methods used (all documented reads — nothing that changes state):
//   getFrameSettings → System name, FrameCollection.Frame (name, FrameTypeName,
//                      Version, OSVersion, SysCard, Slot[].Card with
//                      CardStatusLabel / OverTemp / FanWarn)
//   powerStatus      → per frame {PowerSupply1Status, PowerSupply2Status}:
//                      0 not present, 1 no AC, 2 no DC, 3 OK
//   listSources      → per source InputCfgVideoStatus: 0 invalid, 1 OK,
//                      2 format mismatch, 3 out of range, 4 no sync; Freeze
//   listPresets      → {ScreenDest:-1, AuxDest:-1} = every preset: id, Name,
//                      presetSno. Only feeds the Recall Preset choices; its
//                      failure never affects the verdict.
//
// INFERRED (not stated by Barco): the doc writes the powerStatus reply only as
// a sketch, {FrameId:{PwrStatus1, PwrStatus2}}; the Companion module reads the
// keys as PowerSupply1Status / PowerSupply2Status. Both spellings are read;
// a FrameCollection holding an array of frames on multi-frame systems is
// handled defensively; card status "Ready" / "Not Installed" are the only
// labels the docs show, so any other label is read as a fault; which sources
// are live inputs (InputCfgIndex >= 0, not a destination or user key) follows
// the Companion module. The API has no documented read for the last recalled
// preset, so the active preset is not reported.
//
// Actions (documented in both Barco guides; each is one JSON-RPC call):
//   preset.preview     activatePreset {presetSno | presetName, type: 0}  (Preview)
//   preset.program     activatePreset {presetSno | presetName, type: 1}  (Program)
//   transition.take    allTrans {}   — transitions every armed destination
//   transition.cut     cut {}        — cuts every armed destination
// In multi-operator mode Barco requires {operatorId} or the super operator
// {password} on these calls; the Operator settings add them. A refusal is a
// non-zero "success" code, reported as such.
//
// Result semantics:
//   - No answer, or getFrameSettings fails / is not Event Master -> offline.
//   - Any enabled assertion breached                              -> degraded.
import {
  BuildBaseUrl,
  WithPath,
  RequestJson,
  IsObject,
  StrOrNull,
  NumOrNull,
  AsList,
  TimeoutOf,
} from './_videoproc-http-shared';
import type { URL } from 'url';
import { Card, FormatLatency, Note, Pill, Row, Rows, TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type {
  MonitoringActionDef,
  MonitoringActionOptions,
  MonitoringActionResult,
  MonitoringResult,
  MonitoringSettingField,
  MonitoringTargetLike,
} from './types';

const ID = 'barco-eventmaster';
const DEFAULT_PORT = 9999;
const DEFAULT_PATH = '/jsonrpc';
const DEFAULT_TIMEOUT_MS = 6000;
const ACTION_TIMEOUT_MS = 5000;

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'Port',
    Type: 'number',
    Default: DEFAULT_PORT,
    Min: 1,
    Max: 65535,
    Advanced: true,
    Note: 'Event Master answers JSON-RPC on port 9999.',
  },
  {
    Key: 'Path',
    Label: 'Path',
    Type: 'string',
    Default: DEFAULT_PATH,
    Advanced: true,
    Note: 'Barco documents the port but not the path. Leave as /jsonrpc unless the processor answers somewhere else.',
  },
  {
    Key: 'CheckHardware',
    Label: 'Check temperature and fan warnings',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded when any card reports an over-temperature or fan warning.',
  },
  {
    Key: 'CheckCards',
    Label: 'Check card status',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when an installed card is not Ready.',
  },
  {
    Key: 'CheckPower',
    Label: 'Check power supplies',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded when a fitted power supply has lost AC or DC.',
  },
  {
    Key: 'RequireBothSupplies',
    Label: 'Require both power supplies',
    Type: 'boolean',
    Default: false,
    VisibleWhen: { Key: 'CheckPower', Equals: true },
    Note: 'Also report Degraded when a power supply slot is empty.',
  },
  {
    Key: 'CheckSignal',
    Label: 'Check input signal',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when a watched source has no valid video.',
  },
  {
    Key: 'Sources',
    Label: 'Sources to watch',
    Type: 'list',
    ItemType: 'string',
    Default: [],
    VisibleWhen: { Key: 'CheckSignal', Equals: true },
    Note: 'Source names as shown in Event Master. Leave empty to watch every live input source.',
  },
  {
    Key: 'CheckFrozen',
    Label: 'Check frozen sources',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded while a watched source is frozen.',
  },
  {
    Key: 'OperatorMode',
    Label: 'Multi-operator mode',
    Type: 'select',
    Default: 'off',
    Options: [
      { value: 'off', label: 'Off' },
      { value: 'operator', label: 'Act as an operator' },
      { value: 'super', label: 'Act as the super operator' },
    ],
    Advanced: true,
    Note: 'Only needed for the actions, and only when multi-operator mode is on in Event Master. The check itself never needs it.',
  },
  {
    Key: 'OperatorId',
    Label: 'Operator number',
    Type: 'number',
    Default: 0,
    Min: 0,
    Max: 2,
    Advanced: true,
    VisibleWhen: { Key: 'OperatorMode', Equals: 'operator' },
    Note: 'Barco numbers operators from 0. Preset recalls and takes only affect this operator’s destinations.',
  },
  {
    Key: 'SuperPassword',
    Label: 'Super operator password',
    Type: 'string',
    Default: '',
    Sensitive: true,
    Advanced: true,
    VisibleWhen: { Key: 'OperatorMode', Equals: 'super' },
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

// --- Parsing ----------------------------------------------------------------

export interface EventMasterCard {
  Frame: string | null;
  Label: string;
  Id: string | null;
  Status: string | null;
  StatusId: number | null;
  OverTemp: boolean;
  FanWarn: boolean;
}

export interface EventMasterFrame {
  Name: string | null;
  Type: string | null;
  Version: string | null;
  OSVersion: string | null;
  Mac: string | null;
}

export interface EventMasterSupply {
  Frame: string;
  Slot: number;
  Status: number | null;
}

export interface EventMasterSource {
  Id: number | null;
  Name: string;
  VideoStatus: number | null;
  Frozen: boolean;
  Live: boolean;
}

const POWER_LABELS = ['Not present', 'No AC', 'No DC', 'OK'];
const SIGNAL_LABELS = ['Invalid', 'OK', 'Format mismatch', 'Out of range', 'No signal'];
const CARD_NOT_INSTALLED = 0;
const CARD_READY = 2;

function PowerLabel(Status: number | null): string {
  return Status != null && POWER_LABELS[Status] ? (POWER_LABELS[Status] as string) : 'Unknown';
}

function SignalLabel(Status: number | null): string {
  return Status != null && SIGNAL_LABELS[Status] ? (SIGNAL_LABELS[Status] as string) : 'Unknown';
}

// Unwrap a JSON-RPC reply to its "response", or explain why it is unusable.
function UnwrapRpc(Json: unknown): { Ok: true; Response: unknown } | { Ok: false; Error: string } {
  if (!IsObject(Json)) return { Ok: false, Error: 'Reply is not JSON-RPC' };
  if (Json.error != null) {
    const Err = Json.error;
    const Message = IsObject(Err) ? StrOrNull(Err.message) : StrOrNull(Err);
    return { Ok: false, Error: `JSON-RPC error${Message ? `: ${Message}` : ''}` };
  }
  const Result = Json.result;
  if (!IsObject(Result)) return { Ok: false, Error: 'Reply has no result' };
  if (Result.success != null && Number(Result.success) !== 0) {
    return { Ok: false, Error: `Request refused (success ${String(Result.success)})` };
  }
  return { Ok: true, Response: Result.response };
}

function ParseFrames(Response: unknown): {
  SystemName: string | null;
  Frames: EventMasterFrame[];
  Cards: EventMasterCard[];
} | null {
  const System = IsObject(Response) ? Response.System : null;
  if (!IsObject(System)) return null;
  const Collection = System.FrameCollection;
  const Raw = IsObject(Collection) ? Collection.Frame : null;
  const List = Array.isArray(Raw) ? Raw : Raw != null ? [Raw] : [];
  const Frames: EventMasterFrame[] = [];
  const Cards: EventMasterCard[] = [];
  for (const F of List) {
    if (!IsObject(F)) continue;
    const Enet = IsObject(F.Enet) ? F.Enet : {};
    const FrameName = StrOrNull(F.Name);
    Frames.push({
      Name: FrameName,
      Type: StrOrNull(F.FrameTypeName),
      Version: StrOrNull(F.Version),
      OSVersion: StrOrNull(F.OSVersion),
      Mac: StrOrNull(Enet.MacAddress) || StrOrNull(F.id),
    });
    const Raws: unknown[] = [F.SysCard];
    if (Array.isArray(F.Slot)) for (const S of F.Slot) Raws.push(IsObject(S) ? S.Card : null);
    for (const C of Raws) {
      if (!IsObject(C)) continue;
      Cards.push({
        Frame: List.length > 1 ? FrameName : null,
        Label: StrOrNull(C.CardTypeLabel) || 'Card',
        Id: StrOrNull(C.CardID),
        Status: StrOrNull(C.CardStatusLabel),
        StatusId: NumOrNull(C.CardStatusID),
        OverTemp: Number(C.OverTemp) > 0,
        FanWarn: Number(C.FanWarn) > 0,
      });
    }
  }
  return Frames.length ? { SystemName: StrOrNull(System.Name), Frames, Cards } : null;
}

function ParsePower(Response: unknown): EventMasterSupply[] {
  const Out: EventMasterSupply[] = [];
  if (!IsObject(Response)) return Out;
  for (const [Frame, Value] of Object.entries(Response)) {
    if (!IsObject(Value)) continue;
    for (const Slot of [1, 2]) {
      // Companion's spelling first, then the one Barco's sketch uses.
      const Raw =
        Value[`PowerSupply${Slot}Status`] !== undefined
          ? Value[`PowerSupply${Slot}Status`]
          : Value[`PwrStatus${Slot}`];
      if (Raw === undefined) continue;
      Out.push({ Frame, Slot, Status: NumOrNull(Raw) });
    }
  }
  return Out;
}

function ParseSources(Response: unknown): EventMasterSource[] {
  if (!Array.isArray(Response)) return [];
  const Out: EventMasterSource[] = [];
  for (const S of Response) {
    if (!IsObject(S)) continue;
    const InputCfg = NumOrNull(S.InputCfgIndex);
    const Dest = NumOrNull(S.DestIndex);
    const UserKey = NumOrNull(S.UserKeyIndex);
    Out.push({
      Id: NumOrNull(S.id),
      Name: StrOrNull(S.Name) || `Source ${String(S.id)}`,
      VideoStatus: NumOrNull(S.InputCfgVideoStatus),
      Frozen: Number(S.Freeze) > 0,
      Live:
        InputCfg != null &&
        InputCfg >= 0 &&
        !(Dest != null && Dest >= 0) &&
        !(UserKey != null && UserKey >= 0),
    });
  }
  return Out;
}

export interface EventMasterPreset {
  Id: number | null;
  Sno: string | null;
  Name: string;
}

// listPresets → presets with their serial number ("3.00" style, as the UI shows them).
function ParsePresets(Response: unknown): EventMasterPreset[] {
  if (!Array.isArray(Response)) return [];
  const Out: EventMasterPreset[] = [];
  for (const P of Response) {
    if (!IsObject(P)) continue;
    const Sno = NumOrNull(P.presetSno);
    Out.push({
      Id: NumOrNull(P.id),
      Sno: Sno == null ? null : Sno.toFixed(2),
      Name: StrOrNull(P.Name) || `Preset ${Sno == null ? String(P.id) : Sno.toFixed(2)}`,
    });
  }
  return Out;
}

export interface EventMasterSnapshot {
  SystemName: string | null;
  Frames: EventMasterFrame[];
  Cards: EventMasterCard[];
  Supplies: EventMasterSupply[] | null;
  PowerError: string | null;
  Sources: EventMasterSource[] | null;
  SourcesError: string | null;
  Presets: EventMasterPreset[] | null;
}

// The sources the signal/freeze checks judge: the listed names, else every live input.
function WatchedSources(
  Sources: EventMasterSource[],
  Wanted: string[]
): { Watched: EventMasterSource[]; Missing: string[] } {
  if (!Wanted.length) return { Watched: Sources.filter((S) => S.Live), Missing: [] };
  const Watched: EventMasterSource[] = [];
  const Missing: string[] = [];
  for (const Name of Wanted) {
    const Hit = Sources.find((S) => S.Name.toLowerCase() === Name.toLowerCase());
    if (Hit) Watched.push(Hit);
    else Missing.push(Name);
  }
  return { Watched, Missing };
}

function CardName(C: EventMasterCard): string {
  return `${C.Frame ? `${C.Frame} ` : ''}${C.Label}${C.Id ? ` (${C.Id})` : ''}`;
}

// The reasons a reachable processor is unhealthy, per the enabled toggles. Pure.
function EvaluateHealth(Snap: EventMasterSnapshot, Cfg: Record<string, unknown>): string[] {
  const Reasons: string[] = [];

  if (Cfg.CheckHardware !== false) {
    for (const C of Snap.Cards) {
      if (C.OverTemp) Reasons.push(`${CardName(C)}: over temperature`);
      if (C.FanWarn) Reasons.push(`${CardName(C)}: fan warning`);
    }
  }

  if (Cfg.CheckCards) {
    for (const C of Snap.Cards) {
      if (C.StatusId == null || C.StatusId === CARD_NOT_INSTALLED || C.StatusId === CARD_READY)
        continue;
      Reasons.push(`${CardName(C)}: ${C.Status || `status ${C.StatusId}`}`);
    }
  }

  if (Cfg.CheckPower !== false) {
    if (Snap.Supplies == null) {
      Reasons.push(`Power status: ${Snap.PowerError || 'not reported'}`);
    } else {
      const Many = new Set(Snap.Supplies.map((S) => S.Frame)).size > 1;
      for (const S of Snap.Supplies) {
        const Bad =
          S.Status === 1 || S.Status === 2 || (S.Status === 0 && !!Cfg.RequireBothSupplies);
        if (Bad) {
          Reasons.push(
            `${Many ? `${S.Frame} ` : ''}Power supply ${S.Slot}: ${PowerLabel(S.Status)}`
          );
        }
      }
    }
  }

  if (Cfg.CheckSignal || Cfg.CheckFrozen) {
    if (Snap.Sources == null) {
      Reasons.push(`Sources: ${Snap.SourcesError || 'not reported'}`);
    } else {
      const { Watched, Missing } = WatchedSources(Snap.Sources, AsList(Cfg.Sources));
      if (Cfg.CheckSignal) {
        for (const Name of Missing) Reasons.push(`Source "${Name}": not found`);
        for (const S of Watched) {
          if (S.VideoStatus != null && S.VideoStatus !== 1) {
            Reasons.push(`${S.Name}: ${SignalLabel(S.VideoStatus)}`);
          }
        }
      }
      if (Cfg.CheckFrozen) {
        for (const S of Watched) if (S.Frozen) Reasons.push(`${S.Name}: frozen`);
      }
    }
  }

  return Reasons;
}

// --- Transport ---------------------------------------------------------------

function RpcUrl(Base: URL, Cfg: Record<string, unknown>): URL {
  const RawPath = String(Cfg.Path || DEFAULT_PATH).trim() || DEFAULT_PATH;
  return WithPath(Base, RawPath.startsWith('/') ? RawPath : `/${RawPath}`);
}

type RpcOutcome =
  { Ok: true; Response: unknown } | { Ok: false; Error: string; Status?: number; Code?: string };

// One JSON-RPC 2.0 call against the shared deadline.
async function CallRpc(
  Url: URL,
  DeadlineAt: number,
  Id: string,
  Method: string,
  Params: Record<string, unknown>
): Promise<RpcOutcome> {
  const Res = await RequestJson(Url, {
    Method: 'POST',
    DeadlineAt,
    Json: { jsonrpc: '2.0', id: Id, method: Method, params: Params },
  });
  if (!Res.Ok) return { Ok: false, Error: Res.Error };
  if (Res.Status !== 200) return { Ok: false, Error: `HTTP ${Res.Status}`, Status: Res.Status };
  const Unwrapped = UnwrapRpc(Res.Json);
  if (Unwrapped.Ok) return { Ok: true, Response: Unwrapped.Response };
  const Result = IsObject(Res.Json) && IsObject(Res.Json.result) ? Res.Json.result : null;
  return {
    Ok: false,
    Error: Unwrapped.Error,
    Status: Res.Status,
    ...(Result && Result.success != null ? { Code: String(Result.success) } : {}),
  };
}

// --- Run --------------------------------------------------------------------

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Cfg = (Target && Target.Settings) || {};
  const Port =
    Number.isFinite(Number(Cfg.Port)) && Number(Cfg.Port) > 0 ? Number(Cfg.Port) | 0 : DEFAULT_PORT;
  const Base = BuildBaseUrl(Target && Target.Address, 'http', Port);
  if (!Base) return { Success: false, Error: 'No address configured' };
  const Url = RpcUrl(Base, Cfg);

  const Started = Date.now();
  const DeadlineAt = Started + TimeoutOf(Cfg, DEFAULT_TIMEOUT_MS);
  let NextId = 1;
  const Call = (Method: string, Params: Record<string, unknown> = {}) =>
    CallRpc(Url, DeadlineAt, String(NextId++), Method, Params);

  // The frame read is the fingerprint: without it this is not Event Master.
  const FrameRes = await Call('getFrameSettings');
  if (!FrameRes.Ok) {
    return {
      Success: false,
      Error:
        FrameRes.Status === 404
          ? 'HTTP 404. Event Master answers JSON-RPC on the host processor at port 9999; check the address and the Path setting.'
          : FrameRes.Error,
    };
  }
  const Parsed = ParseFrames(FrameRes.Response);
  if (!Parsed)
    return { Success: false, Error: 'Answered, but not with Event Master frame settings' };
  const LatencyMs = Date.now() - Started;

  const PowerRes = await Call('powerStatus');
  const SourcesRes = await Call('listSources');
  const PresetsRes = await Call('listPresets', { ScreenDest: -1, AuxDest: -1 });

  const Snap: EventMasterSnapshot = {
    ...Parsed,
    Supplies: PowerRes.Ok ? ParsePower(PowerRes.Response) : null,
    PowerError: PowerRes.Ok ? null : PowerRes.Error,
    Sources: SourcesRes.Ok ? ParseSources(SourcesRes.Response) : null,
    SourcesError: SourcesRes.Ok ? null : SourcesRes.Error,
    Presets: PresetsRes.Ok ? ParsePresets(PresetsRes.Response) : null,
  };
  const Reasons = EvaluateHealth(Snap, Cfg);
  const Main = Snap.Frames[0] as EventMasterFrame;
  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs,
    FrameName: Main.Name,
    FrameType: Main.Type,
    Version: Main.Version,
    ...Snap,
  };
}

// --- Actions ----------------------------------------------------------------

const PRESET_PARAM: MonitoringSettingField = {
  Key: 'Preset',
  Label: 'Preset',
  Type: 'string',
  Default: '',
  Required: true,
  Note: 'The preset number as Event Master shows it (e.g. 3 or 3.00), or its exact name. The check lists the presets this processor reports.',
};

const Actions: MonitoringActionDef[] = [
  {
    ID: 'preset.preview',
    Label: 'Recall Preset to Preview',
    Icon: 'collection',
    Group: 'Presets',
    Params: [PRESET_PARAM],
    Note: 'Recalls a preset to Preview only, ready to check before a take. The audience sees no change.',
  },
  {
    ID: 'preset.program',
    Label: 'Recall Preset to Program',
    Icon: 'collection-play',
    Group: 'Presets',
    Destructive: true,
    Params: [PRESET_PARAM],
    Note: 'Recalls a preset straight to Program, changing the screens at once.',
  },
  {
    ID: 'transition.take',
    Label: 'Take',
    Icon: 'arrow-right-square',
    Group: 'Transitions',
    Destructive: true,
    Note: 'Transitions every armed destination from Preview to Program, as the Take button does.',
  },
  {
    ID: 'transition.cut',
    Label: 'Cut',
    Icon: 'scissors',
    Group: 'Transitions',
    Destructive: true,
    Note: 'Cuts every armed destination from Preview to Program with no transition.',
  },
];

// The multi-operator parameters Barco requires on control calls, per the settings.
function OperatorParams(Cfg: Record<string, unknown>): Record<string, unknown> {
  const Mode = String(Cfg.OperatorMode || 'off');
  if (Mode === 'operator') {
    const Id = Number(Cfg.OperatorId);
    return { operatorId: Number.isInteger(Id) && Id >= 0 && Id <= 2 ? Id : 0 };
  }
  if (Mode === 'super' && Cfg.SuperPassword != null && String(Cfg.SuperPassword) !== '') {
    return { password: String(Cfg.SuperPassword) };
  }
  return {};
}

// A preset given as a number recalls by serial number (what the UI shows);
// anything else recalls by exact name.
function PresetSelector(Value: unknown): { Params: Record<string, unknown>; Label: string } | null {
  const Raw = String(Value == null ? '' : Value).trim();
  if (!Raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(Raw)) {
    const Sno = Number(Raw);
    return { Params: { presetSno: Sno }, Label: `Preset ${Sno.toFixed(2)}` };
  }
  return { Params: { presetName: Raw }, Label: `Preset "${Raw}"` };
}

async function RunAction(
  Target: MonitoringTargetLike,
  ActionID: string,
  Params: Record<string, unknown> = {}
): Promise<MonitoringActionResult> {
  const Cfg = (Target && Target.Settings) || {};
  const Port =
    Number.isFinite(Number(Cfg.Port)) && Number(Cfg.Port) > 0 ? Number(Cfg.Port) | 0 : DEFAULT_PORT;
  const Base = BuildBaseUrl(Target && Target.Address, 'http', Port);
  if (!Base) return { Success: false, Error: 'No address configured' };

  let Method: string;
  let RpcParams: Record<string, unknown>;
  let Detail: string;
  if (ActionID === 'preset.preview' || ActionID === 'preset.program') {
    const Preset = PresetSelector(Params.Preset);
    if (!Preset) return { Success: false, Error: 'Enter a preset number or name' };
    const Program = ActionID === 'preset.program';
    Method = 'activatePreset';
    RpcParams = { ...Preset.Params, type: Program ? 1 : 0 };
    Detail = `${Preset.Label} recalled to ${Program ? 'Program' : 'Preview'}`;
  } else if (ActionID === 'transition.take') {
    Method = 'allTrans';
    RpcParams = {};
    Detail = 'Take sent';
  } else if (ActionID === 'transition.cut') {
    Method = 'cut';
    RpcParams = {};
    Detail = 'Cut sent';
  } else {
    return { Success: false, Error: `Unknown Event Master action "${ActionID}"` };
  }

  const DeadlineAt = Date.now() + Math.min(TimeoutOf(Cfg, DEFAULT_TIMEOUT_MS), ACTION_TIMEOUT_MS);
  const Res = await CallRpc(RpcUrl(Base, Cfg), DeadlineAt, '1', Method, {
    ...RpcParams,
    ...OperatorParams(Cfg),
  });
  if (Res.Ok) return { Success: true, Detail };
  if (Res.Code != null) {
    return {
      Success: false,
      Error:
        Method === 'activatePreset'
          ? `Event Master refused the recall (code ${Res.Code}). Check the preset exists and, in multi-operator mode, the operator settings.`
          : `Event Master refused the ${Method === 'cut' ? 'cut' : 'take'} (code ${Res.Code}). In multi-operator mode, check the operator settings.`,
    };
  }
  return { Success: false, Error: Res.Error };
}

// Offer the presets listPresets returned, by serial number and name.
function GetActionOptions(Result: MonitoringResult): MonitoringActionOptions {
  const Presets = Array.isArray(Result && Result.Presets)
    ? (Result.Presets as EventMasterPreset[])
    : [];
  const Choices = Presets.filter((P) => P.Sno != null).map((P) => ({
    value: P.Sno as string,
    label: `${P.Sno} · ${P.Name}`,
  }));
  return Choices.length ? { Preset: Choices } : {};
}

function DescribeAction(ActionID: string, Params: Record<string, unknown>): string | null {
  if (ActionID !== 'preset.preview' && ActionID !== 'preset.program') return null;
  const Preset = PresetSelector(Params && Params.Preset);
  if (!Preset) return null;
  return `Recall ${Preset.Label} to ${ActionID === 'preset.program' ? 'Program' : 'Preview'}`;
}

// --- Debug ------------------------------------------------------------------

function StatePill(Result: MonitoringResult): string {
  const Reachable = !!(Result && Result.Success === true);
  if (Reachable && !Result.Degraded) return Pill('success', 'Healthy');
  if (Reachable) return Pill('warning', Result.DegradedReason || 'Degraded');
  return Pill('danger', 'Offline');
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  const Reachable = !!(Result && Result.Success === true);
  const R = (Result || {}) as Partial<EventMasterSnapshot> & MonitoringResult;
  const Frames = Array.isArray(R.Frames) ? R.Frames : [];

  const Head = Rows([
    TextRow('Processor', `${Address || '—'}${R.SystemName ? ` (${R.SystemName})` : ''}`),
    Row('Status', StatePill(Result)),
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(R.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Failed to reach Event Master'),
    ...Frames.map((F) =>
      TextRow(
        F.Name || 'Frame',
        [F.Type, F.Version ? `v${F.Version}` : null].filter(Boolean).join(' · ') || '—'
      )
    ),
    Reachable && R.PowerError ? TextRow('Power status', R.PowerError) : null,
    Reachable && R.SourcesError ? TextRow('Sources', R.SourcesError) : null,
  ]);
  if (!Reachable) {
    return (
      Head +
      '<div class="mt-2">' +
      Note(
        'Failed to read the Event Master JSON-RPC API on port 9999. Requests must go to the host processor.'
      ) +
      '</div>'
    );
  }

  const Cards: string[] = [];
  for (const S of Array.isArray(R.Supplies) ? R.Supplies : []) {
    const Kind = S.Status === 3 ? 'success' : S.Status === 0 ? 'muted' : 'warning';
    const Many = Frames.length > 1;
    Cards.push(
      Card({
        Title: `${Many ? `${S.Frame} ` : ''}Power supply ${S.Slot}`,
        Badge: Pill(Kind, PowerLabel(S.Status)),
      })
    );
  }
  for (const C of Array.isArray(R.Cards) ? R.Cards : []) {
    if (C.StatusId === CARD_NOT_INSTALLED) continue;
    const Warn = C.OverTemp ? 'Over temperature' : C.FanWarn ? 'Fan warning' : null;
    const Kind = Warn || (C.StatusId != null && C.StatusId !== CARD_READY) ? 'warning' : 'success';
    Cards.push(Card({ Title: CardName(C), Badge: Pill(Kind, Warn || C.Status || 'Unknown') }));
  }
  for (const S of (Array.isArray(R.Sources) ? R.Sources : []).filter((X) => X.Live)) {
    const Kind = S.VideoStatus === 1 ? 'success' : S.VideoStatus == null ? 'muted' : 'warning';
    Cards.push(
      Card({
        Title: S.Name,
        Badge: Pill(Kind, `${SignalLabel(S.VideoStatus)}${S.Frozen ? ' · Frozen' : ''}`),
        BodyHtml: '',
      })
    );
  }
  return Cards.length
    ? Head + `<div class="d-grid gap-1 mt-2">${Cards.join('')}</div>`
    : Head + `<div class="mt-2">${Note('No cards, supplies or live sources reported.')}</div>`;
}

export const Name = 'Barco Event Master';
export const Description =
  'Reads a Barco Event Master processor (E2, S3, EX, Encore3) over its JSON-RPC API on port 9999: frame type and software, card temperature and fan warnings, power supplies and input source signal. Optionally flags warnings, lost power, missing signal and frozen sources. The check only reads; preset recall to Preview or Program, take and cut are offered as actions.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  UnwrapRpc,
  ParseFrames,
  ParsePower,
  ParseSources,
  ParsePresets,
  PresetSelector,
  OperatorParams,
  WatchedSources,
  EvaluateHealth,
};
export { ID, Settings, Actions, Run, RunAction, GetActionOptions, DescribeAction, Debug };
