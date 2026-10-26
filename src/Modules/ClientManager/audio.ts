// Audio endpoint monitoring: the pure half.
//
// Everything here is a function of its arguments: normalising a reported
// snapshot, judging a critical endpoint against its baseline, building the view
// the renderer draws, and diffing two snapshots into the transitions alert rules
// fire on. The Client entity (./client.ts) holds the state and calls these.
//
// One principle runs through all of it, inherited from the rest of the critical
// machinery: an unknown is never a fault. A check the client's platform cannot
// answer (a level macOS will not read for a non-default device, a default ALSA
// cannot name) is skipped rather than failed, and the renderer says why.
import type {
  AudioCapabilities,
  AudioControlScope,
  AudioDevicesView,
  AudioDirection,
  AudioEndpoint,
  AudioEndpointView,
  AudioIssue,
  AudioIssueKind,
  AudioMonitorState,
  AudioMonitorStatus,
  AudioTransport,
  CriticalAudioDevice,
} from '@showtrak/protocol';
import { AsRecord } from './normalizers';
import type { CriticalKind } from './critical-kind';

/** DegradedWarnings entries, one per kind of fault (several kinds share one). */
export const AUDIO_WARNINGS: Record<AudioIssueKind, string> = {
  missing: 'Missing Audio Device',
  not_default: 'Audio Device Not Default',
  channels: 'Audio Format Changed',
  sample_rate: 'Audio Format Changed',
  muted: 'Audio Device Muted',
  volume: 'Audio Level Out Of Range',
};

/** What the server holds from the client's last audio report. */
export interface ObservedAudio {
  SampledAt: number | null;
  Endpoints: AudioEndpoint[];
  Status: AudioMonitorStatus;
  Capabilities: AudioCapabilities | null;
}

const STATES: ReadonlySet<string> = new Set<AudioMonitorState>([
  'unknown',
  'ok',
  'error',
  'unsupported',
]);
const BACKENDS: ReadonlySet<string> = new Set(['coreaudio', 'wasapi', 'pulseaudio', 'alsa']);
const TRANSPORTS: ReadonlySet<string> = new Set<AudioTransport>([
  'builtin',
  'usb',
  'bluetooth',
  'hdmi',
  'displayport',
  'thunderbolt',
  'firewire',
  'pci',
  'network',
  'virtual',
  'aggregate',
  'airplay',
  'unknown',
]);
const SCOPES: ReadonlySet<string> = new Set<AudioControlScope>(['device', 'default', 'none']);

export function EmptyAudioStatus(): AudioMonitorStatus {
  return { State: 'unknown', Message: null, Platform: '', Backend: null };
}

export function EmptyObservedAudio(): ObservedAudio {
  return { SampledAt: null, Endpoints: [], Status: EmptyAudioStatus(), Capabilities: null };
}

export function EmptyAudioView(): AudioDevicesView {
  return { SampledAt: null, Status: EmptyAudioStatus(), Capabilities: null, Endpoints: [] };
}

function PositiveIntegerOrNull(Value: unknown): number | null {
  if (Value === null || Value === undefined || Value === '') return null;
  const Parsed = Number(Value);
  if (!Number.isFinite(Parsed) || Parsed <= 0) return null;
  return Math.round(Parsed);
}

function LevelOrNull(Value: unknown): number | null {
  if (Value === null || Value === undefined || Value === '') return null;
  const Parsed = Number(Value);
  if (!Number.isFinite(Parsed)) return null;
  return Math.max(0, Math.round(Parsed));
}

function TrimmedOrNull(Value: unknown, Max = 256): string | null {
  if (typeof Value !== 'string') return null;
  const Trimmed = Value.trim();
  return Trimmed ? Trimmed.slice(0, Max) : null;
}

export function normalizeAudioDirection(Value: unknown): AudioDirection | null {
  return Value === 'input' || Value === 'output' ? Value : null;
}

export function normalizeEndpointID(Value: unknown): string | null {
  return TrimmedOrNull(Value, 512);
}

function normalizeCapabilities(Value: unknown): AudioCapabilities | null {
  if (!Value || typeof Value !== 'object') return null;
  const C = AsRecord(Value);
  const Scope = (Raw: unknown): AudioControlScope =>
    typeof Raw === 'string' && SCOPES.has(Raw) ? (Raw as AudioControlScope) : 'none';
  return {
    DefaultDevice: C.DefaultDevice === true,
    Channels: C.Channels === true,
    SampleRate: C.SampleRate === true,
    Transport: C.Transport === true,
    InputVolume: Scope(C.InputVolume),
    OutputVolume: Scope(C.OutputVolume),
    InputMute: Scope(C.InputMute),
    OutputMute: Scope(C.OutputMute),
  };
}

function normalizeEndpoint(Value: unknown): AudioEndpoint | null {
  const E = AsRecord(Value);
  const EndpointID = normalizeEndpointID(E.EndpointID);
  const Direction = normalizeAudioDirection(E.Direction);
  if (!EndpointID || !Direction) return null;
  const Transport =
    typeof E.Transport === 'string'
      ? TRANSPORTS.has(E.Transport)
        ? E.Transport
        : 'unknown'
      : null;
  return {
    EndpointID,
    Direction,
    Name: TrimmedOrNull(E.Name) || (Direction === 'input' ? 'Audio Input' : 'Audio Output'),
    Manufacturer: TrimmedOrNull(E.Manufacturer),
    Transport: Transport as AudioTransport | null,
    Channels: PositiveIntegerOrNull(E.Channels),
    SampleRate: PositiveIntegerOrNull(E.SampleRate),
    IsDefault: E.IsDefault === true,
    Volume: LevelOrNull(E.Volume),
    Muted: typeof E.Muted === 'boolean' ? E.Muted : null,
  };
}

/**
 * Normalise a reported snapshot into what is stored. The socket validator has
 * already bounded and reconstructed it; this decides meaning: an endpoint
 * without a usable id or direction is dropped, and a repeated id keeps its first
 * occurrence, so one bad row can never make two devices share a baseline.
 */
export function normalizeAudioSnapshot(Snapshot: unknown): ObservedAudio {
  const S = AsRecord(Snapshot);
  const RawStatus = AsRecord(S.Status);
  const State =
    typeof RawStatus.State === 'string' && STATES.has(RawStatus.State.trim().toLowerCase())
      ? (RawStatus.State.trim().toLowerCase() as AudioMonitorState)
      : 'unknown';
  const Backend =
    typeof RawStatus.Backend === 'string' && BACKENDS.has(RawStatus.Backend)
      ? (RawStatus.Backend as AudioMonitorStatus['Backend'])
      : null;
  const Endpoints: AudioEndpoint[] = [];
  const Seen = new Set<string>();
  for (const Raw of Array.isArray(S.Endpoints) ? S.Endpoints : []) {
    const Endpoint = normalizeEndpoint(Raw);
    if (!Endpoint || Seen.has(Endpoint.EndpointID)) continue;
    Seen.add(Endpoint.EndpointID);
    Endpoints.push(Endpoint);
  }
  return {
    SampledAt:
      Number.isFinite(Number(S.SampledAt)) && S.SampledAt !== null ? Number(S.SampledAt) : null,
    Endpoints,
    Status: {
      State,
      Message: TrimmedOrNull(RawStatus.Message, 512),
      Platform: TrimmedOrNull(RawStatus.Platform, 32) || '',
      Backend,
    },
    Capabilities: normalizeCapabilities(S.Capabilities),
  };
}

/** Normalise a stored or requested critical entry; null when it cannot be one. */
export function normalizeCriticalAudioEntry(Value: unknown): CriticalAudioDevice | null {
  const E = AsRecord(Value);
  const EndpointID = normalizeEndpointID(E.EndpointID);
  const Direction = normalizeAudioDirection(E.Direction);
  if (!EndpointID || !Direction) return null;
  const Bound = (Raw: unknown) => {
    const Level = LevelOrNull(Raw);
    return Level === null ? null : Math.min(100, Level);
  };
  return {
    EndpointID,
    Direction,
    Name: TrimmedOrNull(E.Name) || EndpointID,
    Channels: PositiveIntegerOrNull(E.Channels),
    SampleRate: PositiveIntegerOrNull(E.SampleRate),
    // sqlite hands booleans back as 0/1.
    RequireDefault: E.RequireDefault === true || E.RequireDefault === 1,
    RequireUnmuted: E.RequireUnmuted === true || E.RequireUnmuted === 1,
    MinVolume: Bound(E.MinVolume),
    MaxVolume: Bound(E.MaxVolume),
    Timestamp: Number.isFinite(Number(E.Timestamp)) && E.Timestamp ? Number(E.Timestamp) : null,
  };
}

/** 48000 -> "48 kHz", 44100 -> "44.1 kHz". */
export function FormatSampleRate(Hz: number): string {
  const Khz = Hz / 1000;
  return `${Number.isInteger(Khz) ? Khz : Number(Khz.toFixed(1))} kHz`;
}

function DescribeBounds(Min: number | null, Max: number | null): string {
  if (Min !== null && Max !== null) return `${Min}–${Max}%`;
  if (Min !== null) return `at least ${Min}%`;
  return `at most ${Max}%`;
}

/**
 * Judge one critical endpoint. `Endpoint` is null when the client did not report
 * it. Each check runs only when the baseline asks for it AND the live value is
 * known; a null reading is the platform saying "I cannot tell", not a fault.
 */
export function evaluateAudioIssues(
  Endpoint: AudioEndpoint | null,
  Critical: CriticalAudioDevice,
  Capabilities: AudioCapabilities | null
): AudioIssue[] {
  if (!Endpoint) {
    return [{ Kind: 'missing', Message: `${Critical.Name} is not connected` }];
  }
  const Issues: AudioIssue[] = [];
  if (Critical.RequireDefault && Capabilities?.DefaultDevice && !Endpoint.IsDefault) {
    Issues.push({
      Kind: 'not_default',
      Message: `No longer the default ${Endpoint.Direction}`,
    });
  }
  if (
    Critical.Channels !== null &&
    Endpoint.Channels !== null &&
    Critical.Channels !== Endpoint.Channels
  ) {
    Issues.push({
      Kind: 'channels',
      Message: `${Endpoint.Channels} channels (expected ${Critical.Channels})`,
    });
  }
  if (
    Critical.SampleRate !== null &&
    Endpoint.SampleRate !== null &&
    Critical.SampleRate !== Endpoint.SampleRate
  ) {
    Issues.push({
      Kind: 'sample_rate',
      Message: `Sample rate is ${FormatSampleRate(Endpoint.SampleRate)} (expected ${FormatSampleRate(Critical.SampleRate)})`,
    });
  }
  if (Critical.RequireUnmuted && Endpoint.Muted === true) {
    Issues.push({ Kind: 'muted', Message: 'Muted' });
  }
  if (Endpoint.Volume !== null && (Critical.MinVolume !== null || Critical.MaxVolume !== null)) {
    const TooLow = Critical.MinVolume !== null && Endpoint.Volume < Critical.MinVolume;
    const TooHigh = Critical.MaxVolume !== null && Endpoint.Volume > Critical.MaxVolume;
    if (TooLow || TooHigh) {
      Issues.push({
        Kind: 'volume',
        Message: `Level is ${Endpoint.Volume}% (expected ${DescribeBounds(Critical.MinVolume, Critical.MaxVolume)})`,
      });
    }
  }
  return Issues;
}

export interface AudioViewResult {
  View: AudioDevicesView;
  /** Critical endpoints the client did not report (only populated when trusted). */
  Missing: AudioEndpointView[];
  /** De-duplicated DegradedWarnings entries, in a stable order. */
  Warnings: string[];
}

/**
 * Merge the observed endpoints with the critical baselines into the renderer's
 * view. `Trusted` is whether the stored snapshot came from a sample that
 * succeeded on this connection: until then nothing is judged, and a critical
 * endpoint the client has not reported reads as "not reported" rather than as
 * missing.
 */
export function buildAudioView(
  Observed: ObservedAudio,
  Criticals: CriticalAudioDevice[],
  Trusted: boolean
): AudioViewResult {
  const CriticalByID = new Map<string, CriticalAudioDevice>();
  for (const Entry of Criticals) {
    if (Entry && Entry.EndpointID && !CriticalByID.has(Entry.EndpointID)) {
      CriticalByID.set(Entry.EndpointID, Entry);
    }
  }
  const Capabilities = Observed.Capabilities;
  const Connected: AudioEndpointView[] = Observed.Endpoints.map((Endpoint) => {
    const Critical = CriticalByID.get(Endpoint.EndpointID) || null;
    return {
      ...Endpoint,
      IsConnected: true,
      IsCritical: !!Critical,
      Missing: false,
      Issues: Critical && Trusted ? evaluateAudioIssues(Endpoint, Critical, Capabilities) : [],
      Critical,
    };
  });
  const ConnectedIDs = new Set(Observed.Endpoints.map((Endpoint) => Endpoint.EndpointID));
  const Absent: AudioEndpointView[] = [];
  for (const Critical of CriticalByID.values()) {
    if (ConnectedIDs.has(Critical.EndpointID)) continue;
    Absent.push({
      EndpointID: Critical.EndpointID,
      Direction: Critical.Direction,
      Name: Critical.Name,
      Manufacturer: null,
      Transport: null,
      Channels: Critical.Channels,
      SampleRate: Critical.SampleRate,
      IsDefault: false,
      Volume: null,
      Muted: null,
      IsConnected: false,
      IsCritical: true,
      Missing: Trusted,
      Issues: Trusted ? evaluateAudioIssues(null, Critical, Capabilities) : [],
      Critical,
    });
  }

  const Endpoints = Connected.concat(Absent);
  const Warnings: string[] = [];
  if (Trusted) {
    for (const Endpoint of Endpoints) {
      for (const Issue of Endpoint.Issues) {
        const Warning = AUDIO_WARNINGS[Issue.Kind];
        if (!Warnings.includes(Warning)) Warnings.push(Warning);
      }
    }
  }
  return {
    View: {
      SampledAt: Observed.SampledAt,
      Status: Observed.Status,
      Capabilities,
      Endpoints,
    },
    Missing: Trusted ? Absent : [],
    Warnings,
  };
}

/** A transition between two trusted snapshots, as alert rules see it. */
export type AudioChangeKind =
  'connected' | 'disconnected' | 'default_changed' | 'muted' | 'format_changed';

export interface AudioChange {
  Kind: AudioChangeKind;
  /** The endpoint as it is now (or, for a disconnect, as it was last seen). */
  Endpoint: AudioEndpoint;
  /** The previous default for `default_changed`; the old endpoint otherwise. */
  Previous: AudioEndpoint | null;
}

/**
 * Derive transitions between two snapshots. Only meaningful when both are
 * trusted; the caller guarantees that, for the same reason the application diff
 * does: diffing against "nothing yet" would announce every device as new.
 */
export function diffAudioEndpoints(
  Previous: AudioEndpoint[],
  Next: AudioEndpoint[]
): AudioChange[] {
  const Changes: AudioChange[] = [];
  const PreviousByID = new Map(Previous.map((Endpoint) => [Endpoint.EndpointID, Endpoint]));
  const NextByID = new Map(Next.map((Endpoint) => [Endpoint.EndpointID, Endpoint]));

  for (const Endpoint of Next) {
    const Before = PreviousByID.get(Endpoint.EndpointID);
    if (!Before) {
      Changes.push({ Kind: 'connected', Endpoint, Previous: null });
      continue;
    }
    if (Endpoint.Muted === true && Before.Muted !== true) {
      Changes.push({ Kind: 'muted', Endpoint, Previous: Before });
    }
    const ChannelsMoved =
      Endpoint.Channels !== null &&
      Before.Channels !== null &&
      Endpoint.Channels !== Before.Channels;
    const RateMoved =
      Endpoint.SampleRate !== null &&
      Before.SampleRate !== null &&
      Endpoint.SampleRate !== Before.SampleRate;
    if (ChannelsMoved || RateMoved) {
      Changes.push({ Kind: 'format_changed', Endpoint, Previous: Before });
    }
  }
  for (const Endpoint of Previous) {
    if (!NextByID.has(Endpoint.EndpointID)) {
      Changes.push({ Kind: 'disconnected', Endpoint, Previous: Endpoint });
    }
  }
  for (const Direction of ['output', 'input'] as const) {
    const Before = Previous.find(
      (Endpoint) => Endpoint.Direction === Direction && Endpoint.IsDefault
    );
    const After = Next.find((Endpoint) => Endpoint.Direction === Direction && Endpoint.IsDefault);
    if (After && (!Before || Before.EndpointID !== After.EndpointID)) {
      Changes.push({ Kind: 'default_changed', Endpoint: After, Previous: Before || null });
    }
  }
  return Changes;
}

/** Options a mark/update request may carry; absent ones keep their current value. */
export interface CriticalAudioOptions {
  RequireDefault?: boolean;
  RequireUnmuted?: boolean;
  MinVolume?: number | null;
  MaxVolume?: number | null;
  CheckChannels?: boolean;
  CheckSampleRate?: boolean;
}

/**
 * Work out the critical entry a mark/update request produces.
 *
 * Baselines are captured from the live endpoint, so "guard the channel count"
 * means "guard the count it has now". An endpoint that is currently missing can
 * still have its rules edited: it keeps the baseline it was marked with rather
 * than losing it for want of a live reading. A first mark on an endpoint the
 * client has never reported is refused; there is nothing to take a baseline
 * from, and no way to name its direction.
 *
 * Defaults for a FIRST mark follow what the operator is looking at: the default
 * device is expected to stay default, an unmuted one to stay unmuted.
 */
export function resolveCriticalAudioEntry(
  EndpointID: string,
  Options: CriticalAudioOptions,
  Live: AudioEndpoint | null,
  Existing: CriticalAudioDevice | null,
  Capabilities: AudioCapabilities | null,
  Now: number
): [string | null, CriticalAudioDevice | null] {
  if (!Live && !Existing) return ['That audio device is not connected to this client', null];
  const Has = (Key: keyof CriticalAudioOptions) =>
    Object.prototype.hasOwnProperty.call(Options, Key) && Options[Key] !== undefined;

  const RequireDefault = Has('RequireDefault')
    ? !!Options.RequireDefault
    : Existing
      ? Existing.RequireDefault
      : !!(Live?.IsDefault && Capabilities?.DefaultDevice);
  const RequireUnmuted = Has('RequireUnmuted')
    ? !!Options.RequireUnmuted
    : Existing
      ? Existing.RequireUnmuted
      : Live?.Muted === false;
  const MinVolume = Has('MinVolume') ? (Options.MinVolume ?? null) : (Existing?.MinVolume ?? null);
  const MaxVolume = Has('MaxVolume') ? (Options.MaxVolume ?? null) : (Existing?.MaxVolume ?? null);
  if (MinVolume !== null && MaxVolume !== null && MinVolume > MaxVolume) {
    return ['The minimum level cannot be above the maximum', null];
  }

  const CheckChannels = Has('CheckChannels')
    ? !!Options.CheckChannels
    : Existing
      ? Existing.Channels !== null
      : true;
  const CheckSampleRate = Has('CheckSampleRate')
    ? !!Options.CheckSampleRate
    : Existing
      ? Existing.SampleRate !== null
      : true;

  return [
    null,
    {
      EndpointID,
      Direction: (Live?.Direction || Existing?.Direction) as AudioDirection,
      Name: Live?.Name || Existing?.Name || EndpointID,
      Channels: CheckChannels ? (Live?.Channels ?? Existing?.Channels ?? null) : null,
      SampleRate: CheckSampleRate ? (Live?.SampleRate ?? Existing?.SampleRate ?? null) : null,
      RequireDefault,
      RequireUnmuted,
      MinVolume,
      MaxVolume,
      Timestamp: Existing?.Timestamp ?? Now,
    },
  ];
}

/**
 * Whether the server may forward a level/mute change to this endpoint, judged
 * from the client's own capabilities, so the operator gets the real reason at
 * once instead of a round trip to the client to hear it.
 */
export function audioControlRefusal(
  Endpoint: AudioEndpoint,
  Capabilities: AudioCapabilities | null,
  Change: { Volume?: number; Muted?: boolean },
  PlatformLabel: string
): string | null {
  if (!Capabilities) return 'This client has not reported its audio devices yet';
  const Check = (Scope: AudioControlScope, What: string): string | null => {
    if (Scope === 'device') return null;
    if (Scope === 'default') {
      return Endpoint.IsDefault
        ? null
        : `${PlatformLabel} can only change the ${What} of the default ${Endpoint.Direction}`;
    }
    return `Changing the ${What} of this device is not available on ${PlatformLabel}`;
  };
  if (Change.Volume !== undefined) {
    const Refusal = Check(
      Endpoint.Direction === 'input' ? Capabilities.InputVolume : Capabilities.OutputVolume,
      'level'
    );
    if (Refusal) return Refusal;
  }
  if (Change.Muted !== undefined) {
    const Refusal = Check(
      Endpoint.Direction === 'input' ? Capabilities.InputMute : Capabilities.OutputMute,
      'mute'
    );
    if (Refusal) return Refusal;
  }
  return null;
}

/** "macOS" rather than "darwin" in anything an operator reads. */
export function AudioPlatformLabel(Platform: string | null | undefined): string {
  if (Platform === 'darwin') return 'macOS';
  if (Platform === 'win32') return 'Windows';
  if (Platform === 'linux') return 'Linux';
  return Platform || 'this operating system';
}

/**
 * Whether a reported client version is at least `Minimum`. An unparseable version
 * is treated as too old: a client that cannot say what it is gets no feature that
 * depends on it, which is the safe reading for "send this machine a command".
 */
export function IsClientVersionAtLeast(Version: unknown, Minimum: readonly number[]): boolean {
  const Match = /(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(?:[^0-9]|$)/.exec(String(Version ?? '').trim());
  if (!Match) return false;
  const Parsed = [Number(Match[1]), Number(Match[2]), Number(Match[3])];
  for (let Index = 0; Index < Minimum.length; Index += 1) {
    const Current = Parsed[Index] || 0;
    const Required = Minimum[Index] || 0;
    if (Current !== Required) return Current > Required;
  }
  return true;
}

/** Audio endpoints monitored by endpoint id (see ./critical-kind). */
export const AUDIO_KIND: CriticalKind<CriticalAudioDevice> = {
  KeyOf: (Entry) => Entry.EndpointID,
  NormalizeKey: normalizeEndpointID,
  NormalizeEntry: normalizeCriticalAudioEntry,
  Messages: {
    KeyRequired: 'Audio device identifier is required',
    SaveFailed: 'Failed to save monitored audio device',
    RemoveFailed: 'Failed to remove monitored audio device',
    LookupFailed: 'Failed to determine monitored audio device status',
  },
};
