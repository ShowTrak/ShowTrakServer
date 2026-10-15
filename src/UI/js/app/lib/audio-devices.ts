// Audio section of the client info modal — the decisions, without the DOM.
//
// What the section shows and what it may offer (a level slider, a mute button,
// a condition). What a device supports is derived from the capabilities the
// client itself reported, never from a table here, so a client that learns to
// do more needs no server change to offer it.
import type {
  AudioCapabilities,
  AudioControlScope,
  AudioDevicesView,
  AudioDirection,
  AudioEndpointView,
  AudioTransport,
  ClientView,
} from '@showtrak/protocol';

/**
 * The first ShowTrak Client release with audio monitoring. Older clients have no
 * audio monitor at all, so their section reads as unsupported. Mirrors
 * MINIMUM_AUDIO_MONITORING_VERSION in Modules/Config/constants.ts.
 */
export const MINIMUM_AUDIO_MONITORING_VERSION = [3, 21, 0] as const;
export const MINIMUM_AUDIO_VERSION_LABEL = MINIMUM_AUDIO_MONITORING_VERSION.join('.');

/** Whether `Version` (e.g. "3.21.0", "v3.22.1-beta") is at least `Minimum`. */
export function IsVersionAtLeast(Version: unknown, Minimum: readonly number[]): boolean {
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

/**
 * Which overall message the section shows:
 *  - `outdated`: the client predates audio monitoring — the whole section is
 *    unsupported, no lists, no controls;
 *  - `waiting`: a capable client that has not reported yet (just connected);
 *  - `offline`: nothing live to show beyond the critical baselines;
 *  - `unsupported` / `error`: the client tried and its platform said no;
 *  - `ok`: render the endpoints.
 */
export type AudioSectionState = 'outdated' | 'waiting' | 'offline' | 'unsupported' | 'error' | 'ok';

export function GetAudioSectionState(Client: ClientView): AudioSectionState {
  if (!IsVersionAtLeast(Client.Version, MINIMUM_AUDIO_MONITORING_VERSION)) return 'outdated';
  if (!Client.Online) return 'offline';
  const View = Client.AudioDevices;
  if (!View || View.SampledAt === null || View.SampledAt === undefined) return 'waiting';
  if (View.Status.State === 'unsupported') return 'unsupported';
  if (View.Status.State === 'error') return 'error';
  if (View.Status.State === 'ok') return 'ok';
  return 'waiting';
}

/** "macOS" rather than "darwin". Falls back to the reported OS name, then a phrase. */
export function AudioPlatformLabel(
  Platform: string | null | undefined,
  OperatingSystem?: string | null
): string {
  if (Platform === 'darwin') return 'macOS';
  if (Platform === 'win32') return 'Windows';
  if (Platform === 'linux') return 'Linux';
  if (Platform) return Platform;
  const OS = String(OperatingSystem || '').trim();
  return OS || "this client's operating system";
}

/** "Audio Inputs" / "Audio Outputs": the heading of each direction's section. */
export function AudioDirectionTitle(Direction: AudioDirection): string {
  return Direction === 'input' ? 'Audio Inputs' : 'Audio Outputs';
}

/**
 * The headline + body for every state except `ok`, for one direction's section.
 * Inputs and outputs are separate sections, so an unsupported client shows the
 * message in each — each section has to stand on its own.
 */
export function AudioSectionMessage(
  State: Exclude<AudioSectionState, 'ok'>,
  Client: ClientView,
  Direction: AudioDirection
): { Title: string; Body: string } {
  const Platform = AudioPlatformLabel(
    Client.AudioDevices?.Status?.Platform,
    Client.OperatingSystem
  );
  const Title = AudioDirectionTitle(Direction);
  const Plural = `${Direction}s`;
  switch (State) {
    case 'outdated':
      return {
        Title: `${Title} Unsupported`,
        Body: `Audio monitoring needs ShowTrak Client ${MINIMUM_AUDIO_VERSION_LABEL} or later${
          Client.Version ? ` — this client runs ${Client.Version}` : ''
        }. Update the client to monitor and control its audio ${Plural}.`,
      };
    case 'waiting':
      return {
        Title: `Waiting for ${Title}`,
        Body: `This client has not reported its audio ${Plural} yet.`,
      };
    case 'offline':
      return {
        Title: 'Client Offline',
        Body: `Audio ${Plural} are reported while the client is connected.`,
      };
    case 'unsupported':
      return {
        Title: `${Title} Not Available`,
        Body:
          Client.AudioDevices?.Status?.Message ||
          `Audio ${Direction} monitoring is not available on ${Platform}.`,
      };
    case 'error':
    default:
      return {
        Title: `${Title} Warning`,
        Body:
          Client.AudioDevices?.Status?.Message || `The client failed to read its audio ${Plural}.`,
      };
  }
}

/** The endpoints of one direction, in the order the client reported them. */
export function EndpointsFor(
  Endpoints: AudioEndpointView[],
  Direction: AudioDirection
): AudioEndpointView[] {
  return Endpoints.filter((Endpoint) => Endpoint.Direction === Direction);
}

const TRANSPORT_LABELS: Record<AudioTransport, string> = {
  builtin: 'Built-in',
  usb: 'USB',
  bluetooth: 'Bluetooth',
  hdmi: 'HDMI',
  displayport: 'DisplayPort',
  thunderbolt: 'Thunderbolt',
  firewire: 'FireWire',
  pci: 'PCI',
  network: 'Network',
  virtual: 'Virtual',
  aggregate: 'Aggregate',
  airplay: 'AirPlay',
  unknown: '',
};

export function FormatSampleRate(Hz: number | null | undefined): string | null {
  if (!Hz || !Number.isFinite(Hz)) return null;
  const Khz = Hz / 1000;
  return `${Number.isInteger(Khz) ? Khz : Number(Khz.toFixed(1))} kHz`;
}

/** "Focusrite · USB · 18 ch · 96 kHz" — whatever the platform reported. */
export function AudioEndpointSummary(Endpoint: AudioEndpointView): string {
  const Parts: string[] = [];
  if (Endpoint.Manufacturer) Parts.push(Endpoint.Manufacturer);
  const Transport = Endpoint.Transport ? TRANSPORT_LABELS[Endpoint.Transport] : '';
  if (Transport) Parts.push(Transport);
  if (Endpoint.Channels) Parts.push(`${Endpoint.Channels} ch`);
  const Rate = FormatSampleRate(Endpoint.SampleRate);
  if (Rate) Parts.push(Rate);
  return Parts.join(' · ');
}

function ScopeFor(
  Capabilities: AudioCapabilities | null,
  Direction: AudioDirection,
  Kind: 'Volume' | 'Mute'
): AudioControlScope {
  if (!Capabilities) return 'none';
  if (Kind === 'Volume') {
    return Direction === 'input' ? Capabilities.InputVolume : Capabilities.OutputVolume;
  }
  return Direction === 'input' ? Capabilities.InputMute : Capabilities.OutputMute;
}

/**
 * Whether this endpoint's level or mute can be changed from here. Only a
 * connected endpoint can be; one the platform cannot reach simply offers no
 * control, rather than a sentence saying so.
 */
export function CanControlAudio(
  Endpoint: AudioEndpointView,
  Capabilities: AudioCapabilities | null,
  Kind: 'Volume' | 'Mute'
): boolean {
  if (!Endpoint.IsConnected) return false;
  const Scope = ScopeFor(Capabilities, Endpoint.Direction, Kind);
  return Scope === 'device' || (Scope === 'default' && Endpoint.IsDefault);
}

export type AudioEndpointState = 'healthy' | 'issue' | 'missing' | 'unreported' | 'plain';

/** The badge the critical toggle shows, and what clicking it will do. */
export function AudioEndpointBadge(Endpoint: AudioEndpointView): {
  State: AudioEndpointState;
  Label: string;
  Icon: string;
  Title: string;
} {
  if (!Endpoint.IsCritical) {
    return {
      State: 'plain',
      Label: 'Monitor',
      Icon: 'bi-check-circle',
      Title: 'Monitor this audio device',
    };
  }
  if (Endpoint.Missing) {
    return {
      State: 'missing',
      Label: 'Missing',
      Icon: 'bi-x-circle-fill',
      Title: 'Stop monitoring (device not connected)',
    };
  }
  if (!Endpoint.IsConnected) {
    return {
      State: 'unreported',
      Label: 'Monitored',
      Icon: 'bi-question-circle',
      Title: 'Stop monitoring (not reported yet)',
    };
  }
  if (Endpoint.Issues.length) {
    return {
      State: 'issue',
      Label: 'Changed',
      Icon: 'bi-exclamation-triangle-fill',
      Title: 'Stop monitoring (conditions not met)',
    };
  }
  return {
    State: 'healthy',
    Label: 'Monitored',
    Icon: 'bi-check-circle-fill',
    Title: 'Stop monitoring',
  };
}

/** A condition a critical endpoint can be held to, as its form field is named. */
export type AudioConditionField =
  | 'RequireDefault'
  | 'CheckChannels'
  | 'CheckSampleRate'
  | 'RequireUnmuted'
  | 'MinVolume'
  | 'MaxVolume';

/** One row of a critical endpoint's conditions table. */
export interface AudioConditionRow {
  Field: AudioConditionField;
  /** Key-style label, e.g. "Is default output". */
  Label: string;
  /** What the device reports now ("Yes", "2", "48 kHz", "—"), or "Unsupported". */
  Value: string;
  /** Whether this device can be held to it. A condition already set always is, so it can be cleared. */
  Supported: boolean;
  /** Whether the condition is being monitored. */
  Checked: boolean;
  /** The level bound, for MinVolume/MaxVolume. */
  Bound: number | null;
  /** The issue this condition currently raises, when it is not met. */
  Failing: string | null;
}

const YesNo = (Value: boolean | null) => (Value === null ? '—' : Value ? 'Yes' : 'No');

/**
 * The conditions table of a critical endpoint, one row per condition, in a
 * key-value style. Support is judged per device: what the platform reports for
 * a connected endpoint, and what its capabilities promise for one that is not.
 */
export function AudioConditionRows(
  Endpoint: AudioEndpointView,
  Capabilities: AudioCapabilities | null
): AudioConditionRow[] {
  const Critical = Endpoint.Critical;
  if (!Critical) return [];
  const Readable = (Kind: 'Volume' | 'Mute') => {
    if (!Endpoint.IsConnected) return ScopeFor(Capabilities, Endpoint.Direction, Kind) !== 'none';
    return (Kind === 'Volume' ? Endpoint.Volume : Endpoint.Muted) !== null;
  };
  const Issue = (Kind: string) =>
    Endpoint.Issues.find((Candidate) => Candidate.Kind === Kind)?.Message ?? null;
  const Volume = Endpoint.Volume;
  const LevelIssue = Issue('volume');
  const Row = (
    Field: AudioConditionField,
    Label: string,
    Value: string,
    Capable: boolean,
    Checked: boolean,
    Failing: string | null,
    Bound: number | null = null
  ): AudioConditionRow => {
    const Supported = Capable || Checked;
    return {
      Field,
      Label,
      Value: Supported ? Value : 'Unsupported',
      Supported,
      Checked,
      Bound,
      Failing,
    };
  };
  return [
    Row(
      'RequireDefault',
      `Is default ${Endpoint.Direction}`,
      Endpoint.IsConnected ? YesNo(Endpoint.IsDefault) : '—',
      !!Capabilities?.DefaultDevice,
      Critical.RequireDefault,
      Issue('not_default')
    ),
    Row(
      'CheckChannels',
      'Channels',
      Endpoint.Channels ? String(Endpoint.Channels) : '—',
      !!Capabilities?.Channels,
      Critical.Channels !== null,
      Issue('channels')
    ),
    Row(
      'CheckSampleRate',
      'Sample rate',
      FormatSampleRate(Endpoint.SampleRate) ?? '—',
      !!Capabilities?.SampleRate,
      Critical.SampleRate !== null,
      Issue('sample_rate')
    ),
    Row(
      'RequireUnmuted',
      'Is muted',
      YesNo(Endpoint.Muted),
      Readable('Mute'),
      Critical.RequireUnmuted,
      Issue('muted')
    ),
    Row(
      'MinVolume',
      'Minimum level',
      Volume === null ? '—' : `${Volume}%`,
      Readable('Volume'),
      Critical.MinVolume !== null,
      LevelIssue && Volume !== null && Critical.MinVolume !== null && Volume < Critical.MinVolume
        ? LevelIssue
        : null,
      Critical.MinVolume
    ),
    Row(
      'MaxVolume',
      'Maximum level',
      Volume === null ? '—' : `${Volume}%`,
      Readable('Volume'),
      Critical.MaxVolume !== null,
      LevelIssue && Volume !== null && Critical.MaxVolume !== null && Volume > Critical.MaxVolume
        ? LevelIssue
        : null,
      Critical.MaxVolume
    ),
  ];
}

/**
 * Rebuild the list only when its structure changes. A level, a mute, or a
 * condition being ticked is patched into the existing cards instead (see the
 * modal), so a refresh can never yank a slider out from under the operator's
 * pointer mid-drag, nor a level bound out from under their typing.
 */
export function AudioRenderKey(
  Client: ClientView,
  State: AudioSectionState,
  Direction: AudioDirection
): string {
  const View: AudioDevicesView | undefined = Client.AudioDevices;
  const Prefix = `${Client.UUID}::${Direction}::${State}`;
  if (State !== 'ok' || !View) {
    return `${Prefix}::${View?.Status?.Message || ''}`;
  }
  const Endpoints = EndpointsFor(View.Endpoints, Direction).map((Endpoint) =>
    [
      Endpoint.EndpointID,
      Endpoint.Name,
      Endpoint.IsDefault ? 1 : 0,
      Endpoint.IsConnected ? 1 : 0,
      Endpoint.Missing ? 1 : 0,
      Endpoint.Channels ?? '',
      Endpoint.SampleRate ?? '',
      Endpoint.Volume === null ? 'n' : 'v',
      Endpoint.Muted === null ? 'n' : 'm',
      Endpoint.Issues.map((Issue) => Issue.Message).join(','),
      // Which condition rows exist and can be ticked — not whether they are.
      AudioConditionRows(Endpoint, View.Capabilities)
        .map((Row) => `${Row.Field}${Row.Supported ? 1 : 0}`)
        .join(','),
    ].join('|')
  );
  return `${Prefix}::${View.Status.Message || ''}::${JSON.stringify(View.Capabilities)}::${Endpoints.join(';;')}`;
}

/** The fields of a critical endpoint's conditions form, as read from the DOM. */
export interface AudioRuleFields {
  RequireDefault: boolean;
  RequireUnmuted: boolean;
  CheckChannels: boolean;
  CheckSampleRate: boolean;
  MinVolume: string;
  MaxVolume: string;
}

/** Turn the conditions form into a request, or say what is wrong with it. */
export function ParseAudioRuleFields(
  EndpointID: string,
  Fields: AudioRuleFields
):
  | {
      Payload: {
        EndpointID: string;
        RequireDefault: boolean;
        RequireUnmuted: boolean;
        CheckChannels: boolean;
        CheckSampleRate: boolean;
        MinVolume: number | null;
        MaxVolume: number | null;
      };
    }
  | { Error: string } {
  const Level = (Raw: string, Name: string): number | null | string => {
    const Trimmed = String(Raw ?? '').trim();
    if (!Trimmed) return null;
    const Value = Number(Trimmed);
    if (!Number.isFinite(Value) || Value < 0 || Value > 100) {
      return `${Name} level must be between 0 and 100`;
    }
    return Math.round(Value);
  };
  const Min = Level(Fields.MinVolume, 'Minimum');
  if (typeof Min === 'string') return { Error: Min };
  const Max = Level(Fields.MaxVolume, 'Maximum');
  if (typeof Max === 'string') return { Error: Max };
  if (Min !== null && Max !== null && Min > Max) {
    return { Error: 'The minimum level cannot be above the maximum' };
  }
  return {
    Payload: {
      EndpointID,
      RequireDefault: !!Fields.RequireDefault,
      RequireUnmuted: !!Fields.RequireUnmuted,
      CheckChannels: !!Fields.CheckChannels,
      CheckSampleRate: !!Fields.CheckSampleRate,
      MinVolume: Min,
      MaxVolume: Max,
    },
  };
}

/**
 * The live state of a critical endpoint's history row: green while connected and
 * meeting its conditions, orange while connected but not, red while missing.
 * Idle while the client is offline or the endpoint has not been judged yet —
 * a timeline must never paint a state nobody observed.
 */
export function AudioTimelineLiveState(
  Endpoint: AudioEndpointView,
  Online: boolean
): { State: 'IDLE' | 'ONLINE' | 'DEGRADED' | 'OFFLINE'; Label: string } {
  if (!Online) return { State: 'IDLE', Label: 'Idle' };
  if (Endpoint.Missing) return { State: 'OFFLINE', Label: 'Missing' };
  if (!Endpoint.IsConnected) return { State: 'IDLE', Label: 'Not Reported' };
  if (Endpoint.Issues.length) {
    return { State: 'DEGRADED', Label: Endpoint.Issues.map((Issue) => Issue.Message).join('; ') };
  }
  return { State: 'ONLINE', Label: 'Connected' };
}

/** Clamp a slider/typed value to a whole 0-100 level, or null when it is not one. */
export function ParseLevelInput(Value: unknown): number | null {
  const Parsed = Number(Value);
  if (!Number.isFinite(Parsed)) return null;
  return Math.max(0, Math.min(100, Math.round(Parsed)));
}
