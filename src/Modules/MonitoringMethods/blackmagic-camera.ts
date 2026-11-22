// Blackmagic Design camera check (URSA Broadcast G2, URSA Cine, PYXIS, Cinema
// Camera 6K, Studio Camera 4K/6K Plus/Pro (G2), Micro Studio Camera 4K G2) over
// the Blackmagic Camera Control REST API. Built for the same failure as the
// HyperDeck check: "the camera didn't record" / "the card filled".
//
// Protocol ("REST API for Blackmagic Cameras", Blackmagic Design developer
// information, August 2025:
// documents.blackmagicdesign.com/DeveloperManuals/RESTAPIforBlackmagicCameras.pdf;
// the same YAML is served by each camera at /control/documentation.html):
//   - HTTP (or HTTPS, when enabled in Blackmagic Camera Setup), rooted at
//     /control/api/v1. No authentication. The camera only answers when Web
//     Media Manager is enabled under Network Access in Blackmagic Camera Setup.
//   - Every body is JSON. A feature a model lacks answers 501 (System API) or
//     404; neither is a fault here, the reading is just left empty.
//
// Reads, in order, one request at a time (a camera is a small embedded web
// server; the doc says nothing about concurrent connections):
//   GET /system/product           {deviceName, productName, softwareVersion}   identity
//   GET /system                   {codecFormat{codec,container}, videoFormat{name,frameRate,width,height,interlaced}}
//   GET /transports/0             {mode: InputPreview | InputRecord | Output}
//   GET /transports/0/record      {recording: bool}
//   GET /transports/0/timecode    {display, timeline}
//   GET /media/workingset         {size, workingset: [ {volume, deviceName, remainingRecordTime (s),
//                                  totalSpace, remainingSpace, clipCount} | null ]}
//   GET /media/active             {workingsetIndex, deviceName}, or 204 when no media is active
//   GET /camera/power             {source: Battery|AC|Fiber|USB|POE, milliVolt,
//                                  batteries: [{milliVolt, chargeRemainingPercent, statusFlags[]}]}
//   GET /camera/tallyStatus       {status: None | Preview | Program}
//   GET /camera/timingReferenceLock {locked: bool}
//
// INFERRED (not stated in the doc):
//   - media/active's workingsetIndex is the 0-based index into the workingset
//     array (shown to the operator as Slot 1, 2, ...).
//   - A remainingRecordTime of a slot that is present but not the active one
//     is still meaningful (the doc gives it per working-set entry).
//   - /camera/* endpoints are recent additions; older firmware answers 404,
//     which leaves those readings empty rather than failing the check.
//
// Actions (documented, same reference):
//   record.start: POST /transports/0/record (current). Firmware older than
//                 that answers 404/405, so it falls back to the deprecated but
//                 still documented PUT /transports/0/record {"recording": true}.
//   record.stop:  POST /transports/0/stop (current), falling back the same way
//                 to PUT /transports/0/record {"recording": false}.
// Each first reads /transports/0/record so pressing Start on a recording
// camera (or Stop on a stopped one) sends nothing: POST /transports/0/stop also
// stops playback, which Stop Recording must never do.
//
// Result semantics:
//   - No HTTP answer, or not the camera REST API   -> offline.
//   - Any enabled assertion breached               -> degraded.
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
import { Card, Esc, FormatLatency, Note, Pill, Row, Rows, TextRow, HealthPill } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type {
  MonitoringActionDef,
  MonitoringActionResult,
  MonitoringResult,
  MonitoringSettingField,
  MonitoringTargetLike,
} from './types';

const ID = 'blackmagic-camera';
const API_ROOT = '/control/api/v1';
const DEFAULT_TIMEOUT_MS = 5000;
const ACTION_TIMEOUT_MS = 5000;
const DEFAULT_MIN_RECORD_MINUTES = 15;
const DEFAULT_MIN_BATTERY_PERCENT = 20;
// Cameras have two or three slots (CFast, SD, USB-C); the cap only bounds a
// nonsense working-set size.
const MAX_SLOTS = 8;
// Battery status flags the doc lists that mean "act now", and how each reads.
const LOW_BATTERY_TEXT: Record<string, string> = {
  'Battery Is Critically Low': 'critically low',
  'Battery Percentage Is Low': 'charge low',
  'Battery Voltage Is Low': 'voltage low',
};
const LOW_BATTERY_FLAGS = Object.keys(LOW_BATTERY_TEXT);

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Protocol',
    Label: 'Protocol',
    Type: 'select',
    Default: 'http',
    Options: [
      { value: 'http', label: 'HTTP' },
      { value: 'https', label: 'HTTPS' },
    ],
    Note: 'Choose HTTPS only if secure access is turned on for Web Media Manager in Blackmagic Camera Setup.',
  },
  {
    Key: 'Port',
    Label: 'Port',
    Type: 'number',
    Default: 0,
    Min: 0,
    Max: 65535,
    Advanced: true,
    Note: 'Leave at 0 to use the protocol default: 80 for HTTP, 443 for HTTPS.',
  },
  {
    Key: 'IgnoreTlsErrors',
    Label: 'Ignore TLS Errors',
    Type: 'boolean',
    Default: true,
    Advanced: true,
    Note: "Applies to HTTPS only. On by default so the camera's self-signed certificate is not treated as an outage.",
  },
  {
    Key: 'RequireMedia',
    Label: 'Require media',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded when no media is inserted, or no slot is active for recording.',
  },
  {
    Key: 'CheckRecording',
    Label: 'Check recording',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded unless the camera is recording. Enable it for the show, when the camera should be rolling.',
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
    Default: 'active',
    Options: [
      { value: 'active', label: 'Active slot only' },
      { value: 'all', label: 'All slots with media' },
    ],
    Advanced: true,
    VisibleWhen: { Key: 'CheckRecordTime', Equals: true },
    Note: 'The camera reports the time left on each slot at the current codec and format. Count every slot only if the camera is set to continue recording on the next card.',
  },
  {
    Key: 'CheckFormat',
    Label: 'Check recording format',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when the video format or codec differs from what is expected.',
  },
  {
    Key: 'ExpectedVideoFormat',
    Label: 'Expected video format',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'CheckFormat', Equals: true },
    Note: 'Enter it as the camera reports it in the last response, e.g. 1080p25. Leave blank to accept any format.',
  },
  {
    Key: 'ExpectedCodec',
    Label: 'Expected codec',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'CheckFormat', Equals: true },
    Note: 'Enter it as the camera reports it in the last response. Leave blank to accept any codec.',
  },
  {
    Key: 'CheckPower',
    Label: 'Check power',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when a battery reports low charge, or the camera leaves the expected power source. Needs camera firmware with the power API.',
  },
  {
    Key: 'MinBatteryPercent',
    Label: 'Minimum battery charge (%)',
    Type: 'number',
    Default: DEFAULT_MIN_BATTERY_PERCENT,
    Min: 0,
    Max: 100,
    VisibleWhen: { Key: 'CheckPower', Equals: true },
    Note: "Only judged while the camera runs on battery. 0 relies on the battery's own low warnings.",
  },
  {
    Key: 'ExpectedPowerSource',
    Label: 'Expected power source',
    Type: 'select',
    Default: '',
    Options: [
      { value: '', label: 'Any' },
      { value: 'AC', label: 'AC' },
      { value: 'Fiber', label: 'Fibre' },
      { value: 'POE', label: 'PoE' },
      { value: 'USB', label: 'USB' },
      { value: 'Battery', label: 'Battery' },
    ],
    VisibleWhen: { Key: 'CheckPower', Equals: true },
  },
  {
    Key: 'CheckReferenceLock',
    Label: 'Check reference lock',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when the camera is not locked to its timing reference (genlock).',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: DEFAULT_TIMEOUT_MS,
    Min: 500,
    Max: 30000,
    Advanced: true,
    Note: 'The time allowed for the whole check, which makes up to ten small requests.',
  },
];

// --- Transport --------------------------------------------------------------

interface CameraConfig {
  Base: URL;
  IgnoreTlsErrors: boolean;
}

function ParseConfig(Target: MonitoringTargetLike): CameraConfig | null {
  const Cfg = (Target && Target.Settings) || {};
  const Protocol = Cfg.Protocol === 'https' ? 'https' : 'http';
  const Port = Number.isFinite(Number(Cfg.Port)) ? Number(Cfg.Port) | 0 : 0;
  const Base = BuildBaseUrl(Target && Target.Address, Protocol, Port);
  if (!Base) return null;
  return { Base, IgnoreTlsErrors: Cfg.IgnoreTlsErrors !== false };
}

function Send(
  Config: CameraConfig,
  Method: 'GET' | 'POST' | 'PUT',
  Path: string,
  DeadlineAt: number,
  Json?: unknown
): Promise<JsonResponse> {
  return RequestJson(WithPath(Config.Base, `${API_ROOT}${Path}`), {
    Method,
    ...(Json !== undefined ? { Json } : {}),
    DeadlineAt,
    IgnoreTlsErrors: Config.IgnoreTlsErrors,
  });
}

// --- Parsing ----------------------------------------------------------------

export interface CameraSlot {
  // 1-based, as an operator counts them.
  Slot: number;
  Present: boolean;
  Volume: string | null;
  DeviceName: string | null;
  RemainingRecordSec: number | null;
  TotalBytes: number | null;
  RemainingBytes: number | null;
  ClipCount: number | null;
}

export interface CameraBattery {
  MilliVolt: number | null;
  Percent: number | null;
  Flags: string[];
}

export interface CameraSnapshot {
  DeviceName: string | null;
  ProductName: string | null;
  SoftwareVersion: string | null;
  VideoFormat: string | null;
  FrameRate: string | null;
  Width: number | null;
  Height: number | null;
  Codec: string | null;
  Container: string | null;
  TransportMode: string | null;
  // null = not read.
  Recording: boolean | null;
  Timecode: string | null;
  // null = the working set was not read.
  Slots: CameraSlot[] | null;
  // 1-based; null = none active (or not read; see ActiveRead).
  ActiveSlot: number | null;
  ActiveRead: boolean;
  PowerSource: string | null;
  PowerMilliVolt: number | null;
  Batteries: CameraBattery[] | null;
  Tally: string | null;
  ReferenceLocked: boolean | null;
}

export function ParseWorkingSet(Value: unknown): CameraSlot[] | null {
  if (!IsObject(Value) || !Array.isArray(Value.workingset)) return null;
  return Value.workingset.slice(0, MAX_SLOTS).map((Entry: unknown, I: number) => {
    if (!IsObject(Entry)) {
      return {
        Slot: I + 1,
        Present: false,
        Volume: null,
        DeviceName: null,
        RemainingRecordSec: null,
        TotalBytes: null,
        RemainingBytes: null,
        ClipCount: null,
      };
    }
    return {
      Slot: I + 1,
      Present: true,
      Volume: StrOrNull(Entry.volume),
      DeviceName: StrOrNull(Entry.deviceName),
      RemainingRecordSec: NumOrNull(Entry.remainingRecordTime),
      TotalBytes: NumOrNull(Entry.totalSpace),
      RemainingBytes: NumOrNull(Entry.remainingSpace),
      ClipCount: NumOrNull(Entry.clipCount),
    };
  });
}

// The active slot, 1-based, from GET /media/active; null when none is active.
export function ParseActive(Value: unknown): number | null {
  if (!IsObject(Value)) return null;
  const Index = NumOrNull(Value.workingsetIndex);
  return Index != null && Number.isInteger(Index) && Index >= 0 ? Index + 1 : null;
}

export function ParsePower(Value: unknown): {
  Source: string | null;
  MilliVolt: number | null;
  Batteries: CameraBattery[];
} | null {
  if (!IsObject(Value)) return null;
  const Batteries = Array.isArray(Value.batteries)
    ? Value.batteries.filter(IsObject).map((B) => ({
        MilliVolt: NumOrNull(B.milliVolt),
        Percent: NumOrNull(B.chargeRemainingPercent),
        Flags: Array.isArray(B.statusFlags)
          ? B.statusFlags.map((F) => StrOrNull(F)).filter((F): F is string => !!F)
          : [],
      }))
    : [];
  return { Source: StrOrNull(Value.source), MilliVolt: NumOrNull(Value.milliVolt), Batteries };
}

// --- Verdict ----------------------------------------------------------------

export interface CameraOptions {
  RequireMedia: boolean;
  CheckRecording: boolean;
  CheckRecordTime: boolean;
  MinRecordMinutes: number;
  RecordTimeScope: 'active' | 'all';
  CheckFormat: boolean;
  ExpectedVideoFormat: string;
  ExpectedCodec: string;
  CheckPower: boolean;
  MinBatteryPercent: number;
  ExpectedPowerSource: string;
  CheckReferenceLock: boolean;
}

function ParseOptions(Target: MonitoringTargetLike): CameraOptions {
  const Cfg = (Target && Target.Settings) || {};
  const MinRecord = Number(Cfg.MinRecordMinutes);
  const MinBattery = Number(Cfg.MinBatteryPercent);
  return {
    // Default ON: an absent key still requires media.
    RequireMedia: Cfg.RequireMedia !== false,
    CheckRecording: Cfg.CheckRecording === true,
    CheckRecordTime: Cfg.CheckRecordTime === true,
    MinRecordMinutes:
      Number.isFinite(MinRecord) && MinRecord > 0 ? MinRecord : DEFAULT_MIN_RECORD_MINUTES,
    RecordTimeScope: Cfg.RecordTimeScope === 'all' ? 'all' : 'active',
    CheckFormat: Cfg.CheckFormat === true,
    ExpectedVideoFormat: String(Cfg.ExpectedVideoFormat ?? '').trim(),
    ExpectedCodec: String(Cfg.ExpectedCodec ?? '').trim(),
    CheckPower: Cfg.CheckPower === true,
    MinBatteryPercent:
      Number.isFinite(MinBattery) && MinBattery >= 0
        ? Math.min(100, MinBattery)
        : DEFAULT_MIN_BATTERY_PERCENT,
    ExpectedPowerSource: String(Cfg.ExpectedPowerSource ?? '').trim(),
    CheckReferenceLock: Cfg.CheckReferenceLock === true,
  };
}

/**
 * Seconds of recording left and the slots it was counted from. 'active' reads
 * the active slot only; 'all' adds up every slot with media. Null when there
 * is nothing to count.
 */
export function RemainingRecordTime(
  Snap: CameraSnapshot,
  Scope: 'active' | 'all'
): { Seconds: number; Slots: number[] } | null {
  if (!Snap.Slots) return null;
  if (Scope === 'active') {
    const Active = Snap.Slots.find((S) => S.Slot === Snap.ActiveSlot);
    if (!Active || !Active.Present || Active.RemainingRecordSec == null) return null;
    return { Seconds: Math.max(0, Active.RemainingRecordSec), Slots: [Active.Slot] };
  }
  const Counted = Snap.Slots.filter((S) => S.Present && S.RemainingRecordSec != null);
  if (!Counted.length) return { Seconds: 0, Slots: [] };
  return {
    Seconds: Counted.reduce((Sum, S) => Sum + Math.max(0, S.RemainingRecordSec ?? 0), 0),
    Slots: Counted.map((S) => S.Slot),
  };
}

const Same = (A: string | null, B: string): boolean =>
  String(A ?? '')
    .trim()
    .toLowerCase() === B.toLowerCase();

// The reasons a reachable camera is unhealthy, per the enabled assertions. A
// reading the camera did not give is reported only when it is the thing an
// enabled assertion needs. Pure.
export function EvaluateHealth(Snap: CameraSnapshot, Options: CameraOptions): string[] {
  const Reasons: string[] = [];

  if (Options.RequireMedia) {
    if (!Snap.Slots) {
      Reasons.push('Failed to read media status');
    } else if (!Snap.Slots.some((S) => S.Present)) {
      Reasons.push('No media inserted');
    } else if (Snap.ActiveRead && Snap.ActiveSlot == null) {
      Reasons.push('No active media slot');
    }
  }

  if (Options.CheckRecording) {
    if (Snap.Recording == null) Reasons.push('Failed to read recording state');
    else if (!Snap.Recording) Reasons.push('Not recording');
  }

  if (Options.CheckRecordTime) {
    const Left = RemainingRecordTime(Snap, Options.RecordTimeScope);
    const Minimum = Options.MinRecordMinutes;
    if (!Left) {
      Reasons.push(
        Options.RecordTimeScope === 'active'
          ? 'No active slot to read recording time from'
          : 'Failed to read recording time'
      );
    } else if (Left.Seconds < Minimum * 60) {
      const Where =
        Left.Slots.length === 1
          ? `Slot ${Left.Slots[0]}: `
          : Left.Slots.length > 1
            ? `Slots ${Left.Slots.join(' + ')}: `
            : '';
      Reasons.push(
        `${Where}${Math.floor(Left.Seconds / 60)} min recording time left (minimum ${Minimum})`
      );
    }
  }

  if (Options.CheckFormat) {
    if (Options.ExpectedVideoFormat) {
      if (!Snap.VideoFormat) Reasons.push('Video format not reported');
      else if (!Same(Snap.VideoFormat, Options.ExpectedVideoFormat)) {
        Reasons.push(`Format ${Snap.VideoFormat} (expected ${Options.ExpectedVideoFormat})`);
      }
    }
    if (Options.ExpectedCodec) {
      if (!Snap.Codec) Reasons.push('Codec not reported');
      else if (!Same(Snap.Codec, Options.ExpectedCodec)) {
        Reasons.push(`Codec ${Snap.Codec} (expected ${Options.ExpectedCodec})`);
      }
    }
  }

  if (Options.CheckPower) {
    if (!Snap.Batteries && !Snap.PowerSource) {
      Reasons.push('Power status not reported');
    } else {
      if (Options.ExpectedPowerSource && !Same(Snap.PowerSource, Options.ExpectedPowerSource)) {
        Reasons.push(
          `Power source ${Snap.PowerSource || 'unknown'} (expected ${Options.ExpectedPowerSource})`
        );
      }
      const OnBattery = Same(Snap.PowerSource, 'Battery');
      (Snap.Batteries || []).forEach((B, I) => {
        const Name = (Snap.Batteries || []).length > 1 ? `Battery ${I + 1}` : 'Battery';
        const Flag = LOW_BATTERY_FLAGS.find((F) => B.Flags.includes(F));
        if (Flag) {
          Reasons.push(`${Name} ${LOW_BATTERY_TEXT[Flag]}`);
        } else if (
          OnBattery &&
          Options.MinBatteryPercent > 0 &&
          B.Percent != null &&
          B.Percent < Options.MinBatteryPercent
        ) {
          Reasons.push(`${Name} at ${B.Percent}% (minimum ${Options.MinBatteryPercent}%)`);
        }
      });
    }
  }

  if (Options.CheckReferenceLock) {
    if (Snap.ReferenceLocked == null) Reasons.push('Reference lock not reported');
    else if (!Snap.ReferenceLocked) Reasons.push('Not locked to reference');
  }

  return Reasons;
}

// --- Run --------------------------------------------------------------------

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Cfg = (Target && Target.Settings) || {};
  const Config = ParseConfig(Target);
  if (!Config) return { Success: false, Error: 'No address configured' };

  const Started = Date.now();
  const DeadlineAt = Started + TimeoutOf(Cfg, DEFAULT_TIMEOUT_MS);

  // Identity first. A 404 at the API root is the usual "Web Media Manager is
  // off" (or not a Blackmagic camera); 501 means this model does not implement
  // the product call, so the check carries on without a name.
  const ProductRes = await Send(Config, 'GET', '/system/product', DeadlineAt);
  if (!ProductRes.Ok) return { Success: false, Error: ProductRes.Error };
  let Product: Record<string, unknown> = {};
  if (ProductRes.Status === 200) {
    if (!IsObject(ProductRes.Json)) {
      return { Success: false, Error: 'Answered, but not as the Blackmagic camera REST API' };
    }
    Product = ProductRes.Json;
  } else if (ProductRes.Status !== 501) {
    return {
      Success: false,
      Error: `HTTP ${ProductRes.Status}: not the Blackmagic camera REST API. Check that Web Media Manager is enabled in Blackmagic Camera Setup.`,
    };
  }
  const LatencyMs = Date.now() - Started;

  // Every later read is best effort. Running out of time, though, is offline:
  // a half-read camera must not look healthy.
  let TimedOut = false;
  const Read = async (Path: string): Promise<{ Status: number; Json: unknown } | null> => {
    if (TimedOut) return null;
    const Res = await Send(Config, 'GET', Path, DeadlineAt);
    if (!Res.Ok) {
      if (Res.TimedOut) TimedOut = true;
      return null;
    }
    return { Status: Res.Status, Json: Res.Json };
  };
  const Json200 = (Res: { Status: number; Json: unknown } | null): unknown =>
    Res && Res.Status === 200 ? Res.Json : undefined;

  const System = Json200(await Read('/system'));
  const Transport = Json200(await Read('/transports/0'));
  const Record = Json200(await Read('/transports/0/record'));
  const Timecode = Json200(await Read('/transports/0/timecode'));
  const WorkingSet = ParseWorkingSet(Json200(await Read('/media/workingset')));
  const ActiveRes = await Read('/media/active');
  const Power = ParsePower(Json200(await Read('/camera/power')));
  const Tally = Json200(await Read('/camera/tallyStatus'));
  const Lock = Json200(await Read('/camera/timingReferenceLock'));

  if (TimedOut) {
    return { Success: false, Error: 'The camera stopped answering before the check finished' };
  }

  const VideoFormat = IsObject(System) && IsObject(System.videoFormat) ? System.videoFormat : {};
  const Codec = IsObject(System) && IsObject(System.codecFormat) ? System.codecFormat : {};
  // 204 = no media is active; 200 with a null body says the same.
  const ActiveRead = !!ActiveRes && (ActiveRes.Status === 200 || ActiveRes.Status === 204);
  const ActiveSlot = ActiveRes && ActiveRes.Status === 200 ? ParseActive(ActiveRes.Json) : null;

  const Snap: CameraSnapshot = {
    DeviceName: StrOrNull(Product.deviceName),
    ProductName: StrOrNull(Product.productName),
    SoftwareVersion: StrOrNull(Product.softwareVersion),
    VideoFormat: StrOrNull(VideoFormat.name),
    FrameRate: StrOrNull(VideoFormat.frameRate),
    Width: NumOrNull(VideoFormat.width),
    Height: NumOrNull(VideoFormat.height),
    Codec: StrOrNull(Codec.codec),
    Container: StrOrNull(Codec.container),
    TransportMode: IsObject(Transport) ? StrOrNull(Transport.mode) : null,
    Recording: IsObject(Record) ? BoolOrNull(Record.recording) : null,
    Timecode: IsObject(Timecode)
      ? (StrOrNull(Timecode.display) ?? StrOrNull(Timecode.timeline))
      : null,
    Slots: WorkingSet,
    ActiveSlot,
    ActiveRead,
    PowerSource: Power ? Power.Source : null,
    PowerMilliVolt: Power ? Power.MilliVolt : null,
    Batteries: Power ? Power.Batteries : null,
    Tally: IsObject(Tally) ? StrOrNull(Tally.status) : null,
    ReferenceLocked: IsObject(Lock) ? BoolOrNull(Lock.locked) : null,
  };

  const Options = ParseOptions(Target);
  const Reasons = EvaluateHealth(Snap, Options);
  const Left = RemainingRecordTime(Snap, Options.RecordTimeScope);
  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs,
    ...Snap,
    RecordTimeLeftSec: Left ? Left.Seconds : null,
  };
}

// --- Actions ----------------------------------------------------------------

const Actions: MonitoringActionDef[] = [
  {
    ID: 'record.start',
    Label: 'Start Recording',
    Icon: 'record-circle',
    Group: 'Recording',
    Note: 'Starts recording to the active media. Does nothing if the camera is already recording.',
  },
  {
    ID: 'record.stop',
    Label: 'Stop Recording',
    Icon: 'stop-circle',
    Group: 'Recording',
    Destructive: true,
    Note: 'Stops the recording in progress. Does nothing if the camera is not recording.',
  },
];

// The POST endpoints are recent; older firmware answers 404 or 405 to them.
const IsMissingEndpoint = (Status: number): boolean => Status === 404 || Status === 405;

async function RunAction(
  Target: MonitoringTargetLike,
  ActionID: string
): Promise<MonitoringActionResult> {
  const Cfg = (Target && Target.Settings) || {};
  const Config = ParseConfig(Target);
  if (!Config) return { Success: false, Error: 'No address configured' };
  if (ActionID !== 'record.start' && ActionID !== 'record.stop') {
    return { Success: false, Error: `Unknown Blackmagic camera action "${ActionID}"` };
  }
  const Start = ActionID === 'record.start';
  const DeadlineAt = Date.now() + Math.min(TimeoutOf(Cfg, DEFAULT_TIMEOUT_MS), ACTION_TIMEOUT_MS);

  const State = await Send(Config, 'GET', '/transports/0/record', DeadlineAt);
  if (!State.Ok) return { Success: false, Error: State.Error };
  if (State.Status !== 200 || !IsObject(State.Json)) {
    return { Success: false, Error: `Failed to read the recording state (HTTP ${State.Status})` };
  }
  const Recording = BoolOrNull(State.Json.recording);
  if (Start && Recording === true) return { Success: true, Detail: 'Already recording' };
  if (!Start && Recording === false) return { Success: true, Detail: 'Not recording' };

  let Res = await Send(
    Config,
    'POST',
    Start ? '/transports/0/record' : '/transports/0/stop',
    DeadlineAt
  );
  if (Res.Ok && IsMissingEndpoint(Res.Status)) {
    // Firmware from before the POST endpoints: the deprecated PUT form.
    Res = await Send(Config, 'PUT', '/transports/0/record', DeadlineAt, { recording: Start });
  }
  if (!Res.Ok) return { Success: false, Error: Res.Error };
  if (Res.Status < 200 || Res.Status >= 300) {
    return {
      Success: false,
      Error:
        Res.Status === 400
          ? `The camera refused to ${Start ? 'start' : 'stop'} recording. Check that media is inserted and active.`
          : `Failed to ${Start ? 'start' : 'stop'} recording (HTTP ${Res.Status})`,
    };
  }
  return { Success: true, Detail: Start ? 'Recording started' : 'Recording stopped' };
}

// --- Debug ------------------------------------------------------------------

function Mono(Value: unknown): string {
  return `<span class="font-monospace">${Esc(Value)}</span>`;
}

export function FormatDuration(Seconds: number): string {
  const Total = Math.max(0, Math.floor(Seconds));
  const H = Math.floor(Total / 3600);
  const M = Math.floor((Total % 3600) / 60);
  return H > 0 ? `${H} h ${M} min` : `${M} min`;
}

function FormatBytes(Bytes: number): string {
  const Gb = Bytes / 1e9;
  return Gb >= 100 ? `${Math.round(Gb)} GB` : `${Gb.toFixed(1)} GB`;
}

function RecordingPill(Recording: unknown, Mode: unknown): string {
  if (Recording === true) return Pill('danger', 'Recording');
  if (Recording === false) {
    return Pill('muted', Mode === 'Output' ? 'Playback' : 'Not recording');
  }
  return Pill('muted', 'Unknown');
}

function TallyPill(Tally: unknown): string | null {
  if (Tally === 'Program') return Pill('danger', 'Program');
  if (Tally === 'Preview') return Pill('success', 'Preview');
  if (Tally === 'None') return Pill('muted', 'Off');
  return Tally ? Pill('muted', String(Tally)) : null;
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  const Options = ParseOptions(Target);
  const Reachable = !!(Result && Result.Success === true);
  const R = (Result || {}) as Partial<CameraSnapshot> & MonitoringResult;

  const Head = Rows([
    TextRow('Camera', `${Address || '-'}${R.DeviceName ? ` (${R.DeviceName})` : ''}`),
    Reachable && R.ProductName ? TextRow('Model', R.ProductName) : null,
    Reachable && R.SoftwareVersion ? Row('Software', Mono(R.SoftwareVersion)) : null,
    Row('Status', HealthPill(Result, 'Healthy', false)),
    Reachable && R.DegradedReason ? TextRow('Reason', String(R.DegradedReason)) : null,
    Reachable
      ? Row('Reply time', Mono(FormatLatency(R.LatencyMs)))
      : TextRow('Error', (Result && Result.Error) || 'Failed to reach the camera'),
  ]);
  if (!Reachable) {
    return (
      Head +
      '<div class="mt-2">' +
      Note(
        'Failed to read the Blackmagic camera REST API. Check the address, and that Web Media Manager is enabled in Blackmagic Camera Setup.'
      ) +
      '</div>'
    );
  }

  const Format = [
    R.VideoFormat,
    R.Width != null && R.Height != null ? `${R.Width}x${R.Height}` : null,
    R.FrameRate ? `${R.FrameRate} fps` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const CodecText = [R.Codec, R.Container].filter(Boolean).join(' · ');
  const Batteries = Array.isArray(R.Batteries) ? R.Batteries : [];
  const PowerText = [
    R.PowerSource,
    R.PowerMilliVolt != null ? `${(R.PowerMilliVolt / 1000).toFixed(1)} V` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const Tally = TallyPill(R.Tally);

  const State = Rows([
    Row('Recording', RecordingPill(R.Recording, R.TransportMode)),
    R.Timecode ? Row('Timecode', Mono(R.Timecode)) : null,
    Format ? Row('Video format', Mono(Format)) : null,
    CodecText ? Row('Codec', Mono(CodecText)) : null,
    Options.CheckRecordTime && typeof R.RecordTimeLeftSec === 'number'
      ? Row(
          Options.RecordTimeScope === 'active' ? 'Time left (active)' : 'Time left (all slots)',
          Mono(`${FormatDuration(R.RecordTimeLeftSec)} (minimum ${Options.MinRecordMinutes} min)`)
        )
      : null,
    PowerText ? TextRow('Power', PowerText) : null,
    ...Batteries.map((B, I) =>
      TextRow(
        Batteries.length > 1 ? `Battery ${I + 1}` : 'Battery',
        [
          B.Percent != null ? `${B.Percent}%` : null,
          B.MilliVolt != null ? `${(B.MilliVolt / 1000).toFixed(1)} V` : null,
          ...B.Flags.filter((F) => LOW_BATTERY_FLAGS.includes(F)).map((F) => LOW_BATTERY_TEXT[F]),
        ]
          .filter(Boolean)
          .join(' · ') || 'No reading'
      )
    ),
    Tally ? Row('Tally', Tally) : null,
    R.ReferenceLocked != null
      ? Row(
          'Reference',
          R.ReferenceLocked ? Pill('success', 'Locked') : Pill('warning', 'Not locked')
        )
      : null,
  ]);

  const Slots = Array.isArray(R.Slots) ? R.Slots : [];
  const SlotCards = Slots.map((S) => {
    const Body: string[] = [];
    if (S.Present) {
      if (S.RemainingRecordSec != null) {
        Body.push(`${Esc(FormatDuration(S.RemainingRecordSec))} recording time left`);
      }
      if (S.RemainingBytes != null && S.TotalBytes != null) {
        Body.push(
          `${Esc(FormatBytes(S.RemainingBytes))} free of ${Esc(FormatBytes(S.TotalBytes))}`
        );
      }
      if (S.ClipCount != null) Body.push(`${Esc(S.ClipCount)} clips`);
    }
    const IsActive = S.Slot === R.ActiveSlot;
    return Card({
      Title: `Slot ${S.Slot}${S.Volume ? ` · ${S.Volume}` : ''}${IsActive ? ' (active)' : ''}`,
      Badge: S.Present ? Pill('success', 'Media') : Pill('muted', 'Empty'),
      Highlight: IsActive && S.Present,
      BodyHtml: Body.length
        ? `<div class="text-muted small text-break">${Body.join(' · ')}</div>`
        : '',
    });
  }).join('');

  return (
    Head +
    `<div class="mt-2">${State}</div>` +
    (Slots.length
      ? `<div class="text-muted small mt-2 mb-1">Media (${Slots.length} slots)</div>` +
        `<div class="d-grid gap-1">${SlotCards}</div>`
      : '<div class="mt-2">' + Note('No media information reported') + '</div>')
  );
}

export const Name = 'Blackmagic Camera';
export const Description =
  'Reads a Blackmagic camera (URSA, PYXIS, Cinema Camera, Studio Camera) over its REST API: recording state, media slots and recording time left, format, codec, power and tally. Degraded when no media is ready; optionally also when the camera is not recording, recording time runs low, the format is wrong, a battery is low or reference is lost.';
export const Group = 'Video';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseConfig,
  ParseOptions,
  ParseWorkingSet,
  ParseActive,
  ParsePower,
  RemainingRecordTime,
  EvaluateHealth,
  FormatDuration,
};
export { ID, Settings, Actions, Run, RunAction, Debug };
