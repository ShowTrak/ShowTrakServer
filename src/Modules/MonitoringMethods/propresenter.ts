// Renewed Vision ProPresenter 7 check over its official network API (HTTP,
// enabled with Enable Network in ProPresenter's Network settings; 7.9 and later).
//
// Protocol (ProPresenter API, OpenAPI 3.0.2 "ProPresenter API 1.0",
// openapi.propresenter.com):
//   - Plain HTTP on the port set in ProPresenter's Network settings (the spec's
//     example is 50001). No authentication. Every body is JSON, including bare
//     booleans and strings. 404 means "the receiving machine does not have
//     Network enabled or the requested path was not found".
//   - /version is unversioned and promises name, platform, os_version,
//     host_description and api_version will always exist.
//
// Reads (after /version, all at once: ProPresenter is a desktop application,
// not an embedded server):
//   GET /version                     {name, platform, os_version, host_description, api_version}  identity
//   GET /v1/status/audience_screens  true | false
//   GET /v1/status/stage_screens     true | false
//   GET /v1/look/current             {id: {uuid, name, index}, screens: [...]}
//   GET /v1/presentation/slide_index {presentation_index: {index, presentation_id: {uuid, name, index}}}
//   GET /v1/playlist/active          {presentation: {playlist: {name}, item: {name}}, announcements: {...}}
//   GET /v1/status/layers            {video_input, media, slide, announcements, props, messages, audio}: bool
//   GET /v1/timers/current           [{id: {name}, time, state: stopped|running|complete|overrunning|overran}]
//   GET /v1/stage/message            "text"
//   GET /v1/clear/groups             [{id: {name}, layers: [...]}]   (choices for Trigger Clear Group)
//   GET /v1/looks                    [{id: {name}}]                  (choices for Set Look)
//
// INFERRED (not stated in the spec):
//   - With nothing active, slide_index / playlist/active answer null members
//     (or 404); either way the reading is left empty.
//
// Actions (documented, same reference; every trigger is a GET):
//   cue.next / cue.previous  GET /v1/trigger/next | previous     next/previous cue or item in
//                                                                the active playlist or library
//   clear.group              GET /v1/clear/group/{id}/trigger    id = name, index or UUID
//   clear.layer              GET /v1/clear/layer/{layer}
//   clear.all                GET /v1/clear/layer/{layer} for each of the seven documented layers
//                            (the spec has no single "clear all" call)
//   look.set                 GET /v1/look/{id}/trigger           id = UUID, name or index
//   audience.enable|disable  PUT /v1/status/audience_screens  true | false
//   stage.enable|disable     PUT /v1/status/stage_screens     true | false
//
// Result semantics:
//   - No HTTP answer, or /version is not ProPresenter's   -> offline.
//   - Any enabled assertion breached                      -> degraded.
import {
  BuildBaseUrl,
  WithPath,
  RequestJson,
  IsObject,
  StrOrNull,
  NumOrNull,
  BoolOrNull,
  TimeoutOf,
  type JsonResponse,
} from './_videoproc-http-shared';
import { Card, Esc, FormatLatency, Note, Pill, Row, Rows, TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type {
  MonitoringActionDef,
  MonitoringActionOptions,
  MonitoringActionResult,
  MonitoringResult,
  MonitoringSettingField,
  MonitoringTargetLike,
} from './types';

const ID = 'propresenter';
const DEFAULT_PORT = 50001;
const DEFAULT_TIMEOUT_MS = 5000;
const ACTION_TIMEOUT_MS = 5000;
// The layers GET /v1/clear/layer/{layer} accepts, in the spec's order.
const CLEAR_LAYERS: Array<{ value: string; label: string }> = [
  { value: 'audio', label: 'Audio' },
  { value: 'props', label: 'Props' },
  { value: 'messages', label: 'Messages' },
  { value: 'announcements', label: 'Announcements' },
  { value: 'slide', label: 'Slide' },
  { value: 'media', label: 'Media' },
  { value: 'video_input', label: 'Video input' },
];
// Keys of GET /v1/status/layers, in the order the debug panel lists them.
const STATUS_LAYERS: Array<[string, string]> = [
  ['slide', 'Slide'],
  ['media', 'Media'],
  ['video_input', 'Video input'],
  ['announcements', 'Announcements'],
  ['props', 'Props'],
  ['messages', 'Messages'],
  ['audio', 'Audio'],
];

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'Port',
    Type: 'number',
    Default: DEFAULT_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
    Note: "The port shown in ProPresenter's Network settings, where Enable Network must be on.",
  },
  {
    Key: 'CheckAudienceScreens',
    Label: 'Check audience screens',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded when the audience screens are switched off in ProPresenter.',
  },
  {
    Key: 'CheckStageScreens',
    Label: 'Check stage screens',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when the stage screens are switched off in ProPresenter.',
  },
  {
    Key: 'ExpectedLook',
    Label: 'Expected look',
    Type: 'string',
    Default: '',
    Note: 'Degraded when a different audience look is live. Leave blank to accept any look.',
  },
  {
    Key: 'ExpectedPresentation',
    Label: 'Expected presentation',
    Type: 'string',
    Default: '',
    Note: 'Degraded when a different presentation is active, or none is. Leave blank to accept any presentation.',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: DEFAULT_TIMEOUT_MS,
    Min: 500,
    Max: 30000,
    Advanced: true,
    Note: 'The time allowed for the whole check, which makes up to eleven small requests.',
  },
];

// --- Transport --------------------------------------------------------------

function BaseOf(Target: MonitoringTargetLike): URL | null {
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number.isFinite(Number(Cfg.Port)) ? Number(Cfg.Port) | 0 : 0;
  return BuildBaseUrl(Target && Target.Address, 'http', Port > 0 ? Port : DEFAULT_PORT);
}

function Send(
  Base: URL,
  Method: 'GET' | 'PUT',
  Path: string,
  DeadlineAt: number,
  Json?: unknown
): Promise<JsonResponse> {
  return RequestJson(WithPath(Base, Path), {
    Method,
    ...(Json !== undefined ? { Json } : {}),
    DeadlineAt,
  });
}

// --- Parsing ----------------------------------------------------------------

// The `name` of an {id: {uuid, name, index}} item.
function IdName(Value: unknown): string | null {
  return IsObject(Value) && IsObject(Value.id) ? StrOrNull(Value.id.name) : null;
}

export interface ProPresenterTimer {
  Name: string;
  Time: string | null;
  State: string | null;
}

export interface ProPresenterSnapshot {
  MachineName: string | null;
  Platform: string | null;
  OsVersion: string | null;
  HostDescription: string | null;
  ApiVersion: string | null;
  AudienceScreens: boolean | null;
  StageScreens: boolean | null;
  Look: string | null;
  Presentation: string | null;
  SlideIndex: number | null;
  Playlist: string | null;
  PlaylistItem: string | null;
  // null = not read.
  Layers: Record<string, boolean> | null;
  Timers: ProPresenterTimer[];
  StageMessage: string | null;
  ClearGroups: string[];
  Looks: string[];
}

export function ParseVersion(Value: unknown): {
  Name: string | null;
  Platform: string | null;
  OsVersion: string | null;
  HostDescription: string | null;
  ApiVersion: string | null;
} | null {
  if (!IsObject(Value)) return null;
  const HostDescription = StrOrNull(Value.host_description);
  const ApiVersion = StrOrNull(Value.api_version);
  // The spec promises both; one missing is enough to say "not ProPresenter".
  if (!HostDescription || !ApiVersion) return null;
  return {
    Name: StrOrNull(Value.name),
    Platform: StrOrNull(Value.platform),
    OsVersion: StrOrNull(Value.os_version),
    HostDescription,
    ApiVersion,
  };
}

export function ParseSlideIndex(Value: unknown): { Name: string | null; Index: number | null } {
  const Pi = IsObject(Value) ? Value.presentation_index : null;
  if (!IsObject(Pi)) return { Name: null, Index: null };
  const Pid = IsObject(Pi.presentation_id) ? Pi.presentation_id : {};
  return { Name: StrOrNull(Pid.name), Index: NumOrNull(Pi.index) };
}

export function ParseActivePlaylist(Value: unknown): {
  Playlist: string | null;
  Item: string | null;
} {
  const P = IsObject(Value) && IsObject(Value.presentation) ? Value.presentation : {};
  return {
    Playlist: IsObject(P.playlist) ? StrOrNull(P.playlist.name) : null,
    Item: IsObject(P.item) ? StrOrNull(P.item.name) : null,
  };
}

export function ParseLayers(Value: unknown): Record<string, boolean> | null {
  if (!IsObject(Value)) return null;
  const Out: Record<string, boolean> = {};
  for (const [Key] of STATUS_LAYERS) {
    const B = BoolOrNull(Value[Key]);
    if (B != null) Out[Key] = B;
  }
  return Object.keys(Out).length ? Out : null;
}

export function ParseTimers(Value: unknown): ProPresenterTimer[] {
  if (!Array.isArray(Value)) return [];
  return Value.filter(IsObject)
    .map((T) => ({ Name: IdName(T) || '', Time: StrOrNull(T.time), State: StrOrNull(T.state) }))
    .filter((T) => T.Name);
}

function Names(Value: unknown): string[] {
  if (!Array.isArray(Value)) return [];
  return Value.map(IdName).filter((N): N is string => !!N);
}

// --- Verdict ----------------------------------------------------------------

export interface ProPresenterOptions {
  CheckAudienceScreens: boolean;
  CheckStageScreens: boolean;
  ExpectedLook: string;
  ExpectedPresentation: string;
}

function ParseOptions(Target: MonitoringTargetLike): ProPresenterOptions {
  const Cfg = (Target && Target.Settings) || {};
  return {
    // Default ON: an absent key still checks the audience screens.
    CheckAudienceScreens: Cfg.CheckAudienceScreens !== false,
    CheckStageScreens: Cfg.CheckStageScreens === true,
    ExpectedLook: String(Cfg.ExpectedLook ?? '').trim(),
    ExpectedPresentation: String(Cfg.ExpectedPresentation ?? '').trim(),
  };
}

const Same = (A: string | null, B: string): boolean =>
  String(A ?? '')
    .trim()
    .toLowerCase() === B.toLowerCase();

// The reasons a reachable ProPresenter is unhealthy, per the enabled
// assertions. Pure.
export function EvaluateHealth(Snap: ProPresenterSnapshot, Options: ProPresenterOptions): string[] {
  const Reasons: string[] = [];
  if (Options.CheckAudienceScreens) {
    if (Snap.AudienceScreens == null) Reasons.push('Audience screen status not reported');
    else if (!Snap.AudienceScreens) Reasons.push('Audience screens off');
  }
  if (Options.CheckStageScreens) {
    if (Snap.StageScreens == null) Reasons.push('Stage screen status not reported');
    else if (!Snap.StageScreens) Reasons.push('Stage screens off');
  }
  if (Options.ExpectedLook) {
    if (!Snap.Look) Reasons.push('Live look not reported');
    else if (!Same(Snap.Look, Options.ExpectedLook)) {
      Reasons.push(`Look ${Snap.Look} (expected ${Options.ExpectedLook})`);
    }
  }
  if (Options.ExpectedPresentation) {
    if (!Snap.Presentation) {
      Reasons.push(`No presentation active (expected ${Options.ExpectedPresentation})`);
    } else if (!Same(Snap.Presentation, Options.ExpectedPresentation)) {
      Reasons.push(`Presentation ${Snap.Presentation} (expected ${Options.ExpectedPresentation})`);
    }
  }
  return Reasons;
}

// --- Run --------------------------------------------------------------------

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Cfg = (Target && Target.Settings) || {};
  const Base = BaseOf(Target);
  if (!Base) return { Success: false, Error: 'No address configured' };

  const Started = Date.now();
  const DeadlineAt = Started + TimeoutOf(Cfg, DEFAULT_TIMEOUT_MS);

  const VersionRes = await Send(Base, 'GET', '/version', DeadlineAt);
  if (!VersionRes.Ok) return { Success: false, Error: VersionRes.Error };
  if (VersionRes.Status === 404) {
    return {
      Success: false,
      Error: "HTTP 404: check that Enable Network is on in ProPresenter's Network settings",
    };
  }
  if (VersionRes.Status !== 200) {
    return { Success: false, Error: `HTTP ${VersionRes.Status}: not the ProPresenter API` };
  }
  const Version = ParseVersion(VersionRes.Json);
  if (!Version) return { Success: false, Error: 'Answered, but not as the ProPresenter API' };
  const LatencyMs = Date.now() - Started;

  let TimedOut = false;
  const Read = async (Path: string): Promise<unknown> => {
    const Res = await Send(Base, 'GET', Path, DeadlineAt);
    if (!Res.Ok) {
      if (Res.TimedOut) TimedOut = true;
      return undefined;
    }
    return Res.Status === 200 ? Res.Json : undefined;
  };

  const [Audience, Stage, Look, SlideIndex, Playlist, Layers, Timers, Message, Groups, Looks] =
    await Promise.all([
      Read('/v1/status/audience_screens'),
      Read('/v1/status/stage_screens'),
      Read('/v1/look/current'),
      Read('/v1/presentation/slide_index'),
      Read('/v1/playlist/active'),
      Read('/v1/status/layers'),
      Read('/v1/timers/current'),
      Read('/v1/stage/message'),
      Read('/v1/clear/groups'),
      Read('/v1/looks'),
    ]);

  // A half-read ProPresenter must not look healthy.
  if (TimedOut) {
    return { Success: false, Error: 'ProPresenter stopped answering before the check finished' };
  }

  const Slide = ParseSlideIndex(SlideIndex);
  const Active = ParseActivePlaylist(Playlist);
  const Snap: ProPresenterSnapshot = {
    MachineName: Version.Name,
    Platform: Version.Platform,
    OsVersion: Version.OsVersion,
    HostDescription: Version.HostDescription,
    ApiVersion: Version.ApiVersion,
    AudienceScreens: BoolOrNull(Audience),
    StageScreens: BoolOrNull(Stage),
    Look: IdName(Look),
    // slide_index names the presentation itself; the active playlist item is
    // the fallback for a version that does not.
    Presentation: Slide.Name ?? Active.Item,
    SlideIndex: Slide.Index,
    Playlist: Active.Playlist,
    PlaylistItem: Active.Item,
    Layers: ParseLayers(Layers),
    Timers: ParseTimers(Timers),
    StageMessage: typeof Message === 'string' && Message.trim() ? Message : null,
    ClearGroups: Names(Groups),
    Looks: Names(Looks),
  };

  const Reasons = EvaluateHealth(Snap, ParseOptions(Target));
  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs,
    ...Snap,
  };
}

// --- Actions ----------------------------------------------------------------
//
// Parameters are free text with suggested choices and no default: the shared
// normaliser turns an unknown select value into its default, which would let a
// mistyped OSC value clear the wrong thing. RunAction validates instead.

const Actions: MonitoringActionDef[] = [
  {
    ID: 'cue.next',
    Label: 'Next Cue',
    Icon: 'skip-forward',
    Group: 'Presentation',
    Note: 'Triggers the next cue or item in the active playlist or library.',
  },
  {
    ID: 'cue.previous',
    Label: 'Previous Cue',
    Icon: 'skip-backward',
    Group: 'Presentation',
    Note: 'Triggers the previous cue or item in the active playlist or library.',
  },
  {
    ID: 'clear.group',
    Label: 'Trigger Clear Group',
    Icon: 'eraser',
    Group: 'Clear',
    Destructive: true,
    Params: [
      {
        Key: 'Group',
        Label: 'Clear group',
        Type: 'string',
        Required: true,
        Note: "The clear group's name, as set in ProPresenter.",
      },
    ],
    Note: 'Clears the layers the clear group is set up to clear.',
  },
  {
    ID: 'clear.layer',
    Label: 'Clear Layer',
    Icon: 'eraser',
    Group: 'Clear',
    Destructive: true,
    Params: [
      {
        Key: 'Layer',
        Label: 'Layer',
        Type: 'string',
        Required: true,
        Options: CLEAR_LAYERS,
        Note: 'audio, props, messages, announcements, slide, media or video_input.',
      },
    ],
    Note: 'Clears one layer from the screens.',
  },
  {
    ID: 'clear.all',
    Label: 'Clear All',
    Icon: 'x-octagon',
    Group: 'Clear',
    Destructive: true,
    Note: 'Clears every layer: slide, media, video input, announcements, props, messages and audio.',
  },
  {
    ID: 'look.set',
    Label: 'Set Look',
    Icon: 'layers',
    Group: 'Screens',
    Destructive: true,
    Params: [
      {
        Key: 'Look',
        Label: 'Look',
        Type: 'string',
        Required: true,
        Note: "The audience look's name, as set in ProPresenter.",
      },
    ],
    Note: 'Makes a saved audience look the live look, which changes what each audience screen shows.',
  },
  {
    ID: 'audience.enable',
    Label: 'Audience Screens On',
    Icon: 'display',
    Group: 'Screens',
    Note: 'Switches the audience screens on.',
  },
  {
    ID: 'audience.disable',
    Label: 'Audience Screens Off',
    Icon: 'display',
    Group: 'Screens',
    Destructive: true,
    Note: 'Switches the audience screens off, so the audience sees nothing from ProPresenter.',
  },
  {
    ID: 'stage.enable',
    Label: 'Stage Screens On',
    Icon: 'easel',
    Group: 'Screens',
    Note: 'Switches the stage screens on.',
  },
  {
    ID: 'stage.disable',
    Label: 'Stage Screens Off',
    Icon: 'easel',
    Group: 'Screens',
    Destructive: true,
    Note: 'Switches the stage screens off.',
  },
];

function ParseText(Value: unknown): string | null {
  const Text = String(Value == null ? '' : Value).trim();
  return Text ? Text : null;
}

function ParseLayerParam(Value: unknown): string | null {
  const Text = String(Value == null ? '' : Value)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const Match = CLEAR_LAYERS.find((L) => L.value === Text);
  return Match ? Match.value : null;
}

function LayerLabel(Layer: string): string {
  const Match = CLEAR_LAYERS.find((L) => L.value === Layer);
  return Match ? Match.label : Layer;
}

// 204 is success. 404 means a wrong name (or Network switched off since the
// last check); anything else is reported as the status.
function Outcome(Res: JsonResponse, Detail: string, NotFound: string): MonitoringActionResult {
  if (!Res.Ok) return { Success: false, Error: Res.Error };
  if (Res.Status >= 200 && Res.Status < 300) return { Success: true, Detail };
  if (Res.Status === 404) return { Success: false, Error: NotFound };
  return { Success: false, Error: `ProPresenter refused the request (HTTP ${Res.Status})` };
}

const NOT_FOUND = 'ProPresenter answered 404. Check that Enable Network is still on.';

async function RunAction(
  Target: MonitoringTargetLike,
  ActionID: string,
  Params: Record<string, unknown> = {}
): Promise<MonitoringActionResult> {
  const Cfg = (Target && Target.Settings) || {};
  const Base = BaseOf(Target);
  if (!Base) return { Success: false, Error: 'No address configured' };
  const DeadlineAt = Date.now() + Math.min(TimeoutOf(Cfg, DEFAULT_TIMEOUT_MS), ACTION_TIMEOUT_MS);
  const Get = (Path: string) => Send(Base, 'GET', Path, DeadlineAt);

  switch (ActionID) {
    case 'cue.next':
      return Outcome(await Get('/v1/trigger/next'), 'Next cue triggered', NOT_FOUND);
    case 'cue.previous':
      return Outcome(await Get('/v1/trigger/previous'), 'Previous cue triggered', NOT_FOUND);
    case 'clear.group': {
      const Group = ParseText(Params.Group);
      if (!Group) return { Success: false, Error: 'Enter the name of a clear group' };
      return Outcome(
        await Get(`/v1/clear/group/${encodeURIComponent(Group)}/trigger`),
        `Clear group ${Group} triggered`,
        `ProPresenter has no clear group called "${Group}"`
      );
    }
    case 'clear.layer': {
      const Layer = ParseLayerParam(Params.Layer);
      if (!Layer) {
        return {
          Success: false,
          Error:
            'Choose a layer: audio, props, messages, announcements, slide, media or video_input',
        };
      }
      return Outcome(
        await Get(`/v1/clear/layer/${Layer}`),
        `${LayerLabel(Layer)} layer cleared`,
        NOT_FOUND
      );
    }
    case 'clear.all': {
      // One request per layer, in order; say which layers were cleared if one fails.
      const Done: string[] = [];
      for (const { value } of CLEAR_LAYERS) {
        const Res = Outcome(await Get(`/v1/clear/layer/${value}`), '', NOT_FOUND);
        if (!Res.Success) {
          return {
            Success: false,
            Error: Done.length
              ? `Cleared ${Done.join(', ')}, but failed to clear ${LayerLabel(value).toLowerCase()}: ${Res.Error}`
              : (Res.Error as string),
          };
        }
        Done.push(LayerLabel(value).toLowerCase());
      }
      return { Success: true, Detail: 'All layers cleared' };
    }
    case 'look.set': {
      const Look = ParseText(Params.Look);
      if (!Look) return { Success: false, Error: 'Enter the name of a look' };
      return Outcome(
        await Get(`/v1/look/${encodeURIComponent(Look)}/trigger`),
        `Look set to ${Look}`,
        `ProPresenter has no look called "${Look}"`
      );
    }
    case 'audience.enable':
    case 'audience.disable':
    case 'stage.enable':
    case 'stage.disable': {
      const Audience = ActionID.startsWith('audience.');
      const On = ActionID.endsWith('.enable');
      const Res = await Send(
        Base,
        'PUT',
        Audience ? '/v1/status/audience_screens' : '/v1/status/stage_screens',
        DeadlineAt,
        On
      );
      return Outcome(
        Res,
        `${Audience ? 'Audience' : 'Stage'} screens switched ${On ? 'on' : 'off'}`,
        NOT_FOUND
      );
    }
    default:
      return { Success: false, Error: `Unknown ProPresenter action "${ActionID}"` };
  }
}

// The clear groups and looks this ProPresenter reported, as parameter choices.
function GetActionOptions(Result: MonitoringResult): MonitoringActionOptions {
  const Out: MonitoringActionOptions = {};
  const Groups = Result && Array.isArray(Result.ClearGroups) ? Result.ClearGroups : [];
  const Looks = Result && Array.isArray(Result.Looks) ? Result.Looks : [];
  const AsOptions = (List: unknown[]) =>
    List.filter((N): N is string => typeof N === 'string' && !!N).map((N) => ({
      value: N,
      label: N,
    }));
  if (Groups.length) Out.Group = AsOptions(Groups);
  if (Looks.length) Out.Look = AsOptions(Looks);
  return Out;
}

function DescribeAction(ActionID: string, Params: Record<string, unknown>): string | null {
  if (ActionID === 'clear.group') {
    const Group = ParseText(Params && Params.Group);
    return Group ? `Clear Group - ${Group}` : null;
  }
  if (ActionID === 'clear.layer') {
    const Layer = ParseLayerParam(Params && Params.Layer);
    return Layer ? `Clear ${LayerLabel(Layer)}` : null;
  }
  if (ActionID === 'look.set') {
    const Look = ParseText(Params && Params.Look);
    return Look ? `Set Look - ${Look}` : null;
  }
  return null;
}

// --- Debug ------------------------------------------------------------------

function StatePill(Result: MonitoringResult): string {
  const Reachable = !!(Result && Result.Success === true);
  if (Reachable && !Result.Degraded) return Pill('success', 'Healthy');
  if (Reachable) return Pill('warning', 'Degraded');
  return Pill('danger', 'Offline');
}

function OnOffPill(Value: unknown): string {
  if (Value === true) return Pill('success', 'On');
  if (Value === false) return Pill('warning', 'Off');
  return Pill('muted', 'Unknown');
}

function TimerPill(State: string | null): string {
  if (State === 'running') return Pill('success', 'Running');
  if (State === 'overrunning' || State === 'overran') return Pill('danger', 'Overrun');
  if (State === 'complete') return Pill('muted', 'Complete');
  return Pill('muted', State === 'stopped' ? 'Stopped' : State || 'Unknown');
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  const Cfg = (Target && Target.Settings) || {};
  const Port =
    Number.isFinite(Number(Cfg.Port)) && Number(Cfg.Port) > 0 ? Number(Cfg.Port) : DEFAULT_PORT;
  const Reachable = !!(Result && Result.Success === true);
  const R = (Result || {}) as Partial<ProPresenterSnapshot> & MonitoringResult;

  const Head = Rows([
    TextRow('Host', `${Address || '-'}:${Port}${R.MachineName ? ` (${R.MachineName})` : ''}`),
    Reachable && R.HostDescription
      ? TextRow(
          'Version',
          [R.HostDescription, R.ApiVersion ? `API ${R.ApiVersion}` : null]
            .filter(Boolean)
            .join(' · ')
        )
      : null,
    Reachable && (R.Platform || R.OsVersion)
      ? TextRow('System', [R.Platform, R.OsVersion].filter(Boolean).join(' '))
      : null,
    Row('Status', StatePill(Result)),
    Reachable && R.DegradedReason ? TextRow('Reason', String(R.DegradedReason)) : null,
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(R.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Failed to reach ProPresenter'),
  ]);
  if (!Reachable) {
    return (
      Head +
      '<div class="mt-2">' +
      Note(
        "Failed to read the ProPresenter API. Check the address, the port, and that Enable Network is on in ProPresenter's Network settings."
      ) +
      '</div>'
    );
  }

  const Layers = R.Layers && typeof R.Layers === 'object' ? R.Layers : null;
  const ActiveLayers = Layers
    ? STATUS_LAYERS.filter(([Key]) => Layers[Key] === true).map(([, Label]) => Label)
    : [];
  const State = Rows([
    Row('Audience screens', OnOffPill(R.AudienceScreens)),
    Row('Stage screens', OnOffPill(R.StageScreens)),
    TextRow('Look', R.Look || 'Not reported'),
    TextRow(
      'Presentation',
      R.Presentation
        ? `${R.Presentation}${R.SlideIndex != null ? ` (cue ${Number(R.SlideIndex) + 1})` : ''}`
        : 'None'
    ),
    R.Playlist ? TextRow('Playlist', R.Playlist) : null,
    Layers ? TextRow('Showing', ActiveLayers.length ? ActiveLayers.join(', ') : 'Nothing') : null,
    R.StageMessage ? TextRow('Stage message', R.StageMessage) : null,
  ]);

  const Timers = Array.isArray(R.Timers) ? R.Timers : [];
  const TimerCards = Timers.map((T) =>
    Card({
      Title: T.Name,
      Badge: TimerPill(T.State),
      BodyHtml: T.Time ? `<div class="text-muted small font-monospace">${Esc(T.Time)}</div>` : '',
    })
  ).join('');

  return (
    Head +
    `<div class="mt-2">${State}</div>` +
    (Timers.length
      ? `<div class="text-muted small mt-2 mb-1">Timers (${Timers.length})</div>` +
        `<div class="d-grid gap-1">${TimerCards}</div>`
      : '')
  );
}

export const Name = 'ProPresenter';
export const Description =
  'Reads Renewed Vision ProPresenter 7 over its network API: version, audience and stage screen state, the live look, the active presentation and playlist, showing layers, timers and the stage message. Degraded when the audience screens are off; optionally also when the stage screens are off or the look or presentation is not the expected one.';
export const Group = 'Video';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseOptions,
  ParseVersion,
  ParseSlideIndex,
  ParseActivePlaylist,
  ParseLayers,
  ParseTimers,
  EvaluateHealth,
};
export { ID, Settings, Actions, Run, RunAction, GetActionOptions, DescribeAction, Debug };
