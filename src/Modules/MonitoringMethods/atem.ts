// Blackmagic ATEM switcher monitoring. Holds one persistent, read-only session
// per switcher over the ATEM UDP protocol (port 9910) and reports from the
// state the switcher pushes: product name, protocol version, power supply
// status, ME 1 program/preview, and streaming/recording status on models that
// have them. The protocol, the session manager and the command parsers live in
// ./_atem-shared.
//
// Result semantics:
//   - nothing answers / the session drops / no full state within Timeout → Offline
//   - something answers on the port but not with the ATEM protocol      → Degraded
//   - the switcher refuses the session (all client slots taken)         → Degraded
//   - connected and the state dump finished                             → Online
//   - an enabled assertion fails                                         → Degraded
//
// Power is checked by default: a supply dying mid-show is a hardware fault worth
// knowing about without opting in. Only a supply that has reported OK since
// this address was first watched can fail — dual-supply switchers are routinely
// run from one supply (several of atem-connection's real dumps show exactly
// that), and flagging the unconnected one would be a permanent false alarm.
// Single-supply models never report a failure. Streaming and recording are
// opt-in, because whether a switcher SHOULD be live is a property of the show,
// not the device.
//
// LATENCY is the handshake round trip (hello → hello answer), measured once per
// session. The client never sends a reliable packet (that would mean sending the
// switcher something it acts on), so there is no later round trip to time; the
// switcher's keepalives arrive on its own schedule and say nothing about the
// path. Because the figure is per-session rather than per-probe, the latency
// threshold is not offered.
import {
  AtemSessionManager,
  DEFAULT_ATEM_PORT,
  IsValidPort,
  type AtemPsu,
  type AtemSnapshot,
  type AtemSource,
  type RecordingError,
  type StreamingError,
} from './_atem-shared';
import { Esc, FormatLatency, Pill, Row, Rows, TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'atem';

const DEFAULT_TIMEOUT_MS = 4000;

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'Port',
    Type: 'number',
    Default: DEFAULT_ATEM_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
    Note: 'The ATEM control port. Switchers always use UDP 9910.',
  },
  {
    Key: 'CheckPower',
    Label: 'Check power supplies',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded when a power supply that has reported OK since monitoring began reports failed. A supply that was never connected is shown as not connected, not failed.',
  },
  {
    Key: 'CheckStreaming',
    Label: 'Check streaming',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded unless the switcher is streaming. Only models with a built-in encoder (ATEM Mini Pro and later) report this.',
  },
  {
    Key: 'CheckRecording',
    Label: 'Check recording',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded unless the switcher is recording, or when it reports a recording fault (media full, dropping frames). Only models that record to USB or SSD report this.',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: DEFAULT_TIMEOUT_MS,
    Min: 500,
    Max: 30000,
    Advanced: true,
    Note: 'How long a check waits for the switcher to connect and send its state. Once connected, the session is held open and checks read from it.',
  },
];

// --- Options ----------------------------------------------------------------

export interface AtemOptions {
  CheckPower: boolean;
  CheckStreaming: boolean;
  CheckRecording: boolean;
}

export function ParseOptions(Target: MonitoringTargetLike): AtemOptions {
  const Cfg = (Target && Target.Settings) || {};
  return {
    CheckPower: Cfg.CheckPower !== false, // default ON
    CheckStreaming: Cfg.CheckStreaming === true,
    CheckRecording: Cfg.CheckRecording === true,
  };
}

// --- Labels -----------------------------------------------------------------

const STREAMING_ERROR_LABELS: Record<StreamingError, string> = {
  None: '',
  InvalidState: 'invalid state',
  Unknown: 'unknown error',
};

const RECORDING_ERROR_LABELS: Record<RecordingError, string> = {
  None: '',
  NoMedia: 'no media',
  MediaFull: 'media full',
  MediaError: 'media error',
  MediaUnformatted: 'media unformatted',
  DroppingFrames: 'dropping frames',
  Unknown: 'unknown error',
};

// Recording faults worth degrading on even while recording. Each is an explicit
// bit; 'NoMedia' is only the absence of the "no error" bit, so it is not used to
// second-guess a switcher that says it is recording.
const RECORDING_FAULTS: RecordingError[] = [
  'MediaFull',
  'MediaError',
  'MediaUnformatted',
  'DroppingFrames',
];

export function SourceLabel(Source: AtemSource | null): string {
  if (!Source) return '—';
  if (!Source.Name) return Source.ShortName || `Source ${Source.Id}`;
  return Source.ShortName && Source.ShortName !== Source.Name
    ? `${Source.Name} (${Source.ShortName})`
    : Source.Name;
}

// --- Evaluation (pure; exported for tests) ----------------------------------

export function Evaluate(Snapshot: AtemSnapshot, Options: AtemOptions): string[] {
  const Reasons: string[] = [];

  if (Options.CheckPower && Snapshot.PowerSupplies && Snapshot.PowerSupplies.length > 1) {
    for (const Psu of Snapshot.PowerSupplies) {
      if (!Psu.Ok && Psu.SeenOk) Reasons.push(`Power supply ${Psu.Index} failed`);
    }
  }

  if (Options.CheckStreaming) {
    const S = Snapshot.Streaming;
    if (!S) {
      Reasons.push('Streaming status not reported by this switcher');
    } else if (S.State !== 'Streaming') {
      const Err = STREAMING_ERROR_LABELS[S.Error];
      const Base =
        S.State === 'Idle'
          ? 'Not streaming'
          : S.State === 'Connecting'
            ? 'Streaming: connecting'
            : 'Streaming: stopping';
      Reasons.push(Err ? `${Base} (${Err})` : Base);
    }
  }

  if (Options.CheckRecording) {
    const R = Snapshot.Recording;
    if (!R) {
      Reasons.push('Recording status not reported by this switcher');
    } else if (R.State === 'Recording') {
      if (RECORDING_FAULTS.includes(R.Error)) {
        Reasons.push(`Recording: ${RECORDING_ERROR_LABELS[R.Error]}`);
      }
    } else {
      const Err = RECORDING_ERROR_LABELS[R.Error];
      const Base = R.State === 'Stopping' ? 'Recording: stopping' : 'Not recording';
      Reasons.push(Err ? `${Base} (${Err})` : Base);
    }
  }

  return Reasons;
}

// --- Run --------------------------------------------------------------------

function ResolveParams(Target: MonitoringTargetLike): {
  Address: string;
  Port: number;
  TimeoutMs: number;
  Error?: string;
} {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number.isFinite(Cfg.Port) ? (Cfg.Port as number) | 0 : DEFAULT_ATEM_PORT;
  const RawTimeout = Number(Cfg.Timeout);
  const TimeoutMs = Number.isFinite(RawTimeout)
    ? Math.min(30000, Math.max(500, RawTimeout))
    : DEFAULT_TIMEOUT_MS;
  if (!Address) return { Address, Port, TimeoutMs, Error: 'No address configured' };
  if (!IsValidPort(Port)) return { Address, Port, TimeoutMs, Error: `Invalid port: ${Port}` };
  return { Address, Port, TimeoutMs };
}

function SnapshotFields(Snapshot: AtemSnapshot): Record<string, unknown> {
  return {
    ProductName: Snapshot.ProductName,
    Model: Snapshot.Model,
    ProtocolVersion: Snapshot.ProtocolVersion,
    PowerSupplies: Snapshot.PowerSupplies,
    Program: Snapshot.Program,
    Preview: Snapshot.Preview,
    Streaming: Snapshot.Streaming,
    Recording: Snapshot.Recording,
  };
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const P = ResolveParams(Target);
  if (P.Error) return { Success: false, Error: P.Error };

  const Key = AtemSessionManager.Observe({ Address: P.Address, Port: P.Port });
  const Snapshot = await AtemSessionManager.WaitReady(Key, P.TimeoutMs);

  if (Snapshot.Ready) {
    const Reasons = Evaluate(Snapshot, ParseOptions(Target));
    return {
      Success: true,
      LatencyMs: Snapshot.HandshakeMs == null ? null : Math.round(Snapshot.HandshakeMs * 10) / 10,
      ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
      ...SnapshotFields(Snapshot),
    };
  }
  if (Snapshot.NotAtem) {
    return {
      Success: true,
      LatencyMs: null,
      Degraded: true,
      DegradedReason: `A device answered on port ${P.Port} but is not an ATEM switcher`,
    };
  }
  if (Snapshot.Full) {
    return {
      Success: true,
      LatencyMs: null,
      Degraded: true,
      DegradedReason: 'The switcher has no free connections (too many control clients)',
    };
  }
  if (Snapshot.Refused) {
    return { Success: false, Degraded: true, Error: Snapshot.Error || 'Connection refused' };
  }
  if (Snapshot.Connected) {
    return {
      Success: false,
      Error: 'Connected, but the switcher has not finished sending its state',
      ...SnapshotFields(Snapshot),
    };
  }
  return { Success: false, Error: Snapshot.Error || 'No reply from the switcher' };
}

// --- Debug ------------------------------------------------------------------

function PsuPills(List: AtemPsu[]): string {
  return List.map((Psu) => {
    if (Psu.Ok) return Pill('success', `PSU ${Psu.Index} OK`);
    if (Psu.SeenOk) return Pill('danger', `PSU ${Psu.Index} failed`);
    return Pill('muted', `PSU ${Psu.Index} Not connected`);
  }).join(' ');
}

function StreamingPill(S: { State: string; Error: StreamingError }): string {
  const Err = STREAMING_ERROR_LABELS[S.Error] || '';
  if (S.State === 'Streaming') return Pill('success', 'Streaming');
  const Text = S.State === 'Idle' ? 'Not streaming' : S.State;
  return Pill(S.State === 'Idle' && !Err ? 'muted' : 'warning', Err ? `${Text} (${Err})` : Text);
}

function RecordingPill(R: { State: string; Error: RecordingError }): string {
  const Err = RECORDING_ERROR_LABELS[R.Error] || '';
  if (R.State === 'Recording') {
    return RECORDING_FAULTS.includes(R.Error)
      ? Pill('warning', `Recording (${Err})`)
      : Pill('success', 'Recording');
  }
  const Text = R.State === 'Idle' ? 'Not recording' : R.State;
  return Pill('muted', Err ? `${Text} (${Err})` : Text);
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number.isFinite(Cfg.Port) ? (Cfg.Port as number) | 0 : DEFAULT_ATEM_PORT;
  const Online = !!(Result && Result.Success);
  const Degraded = !!(Result && Result.Degraded);

  let StatusPill: string;
  if (!Online) StatusPill = Pill('danger', 'Offline');
  else if (Degraded) StatusPill = Pill('warning', 'Degraded');
  else StatusPill = Pill('success', 'Healthy');

  const R = (Result || {}) as Record<string, unknown>;
  const Psus = Array.isArray(R.PowerSupplies) ? (R.PowerSupplies as AtemPsu[]) : null;
  const Program = (R.Program as AtemSource | null | undefined) ?? null;
  const Preview = (R.Preview as AtemSource | null | undefined) ?? null;
  const Streaming = R.Streaming as { State: string; Error: StreamingError } | null | undefined;
  const Recording = R.Recording as { State: string; Error: RecordingError } | null | undefined;

  return Rows([
    TextRow('Host', `${Address || '—'}:${Port}`),
    Row('Status', StatusPill),
    R.ProductName ? TextRow('Product', R.ProductName) : null,
    R.ProtocolVersion ? TextRow('Protocol version', R.ProtocolVersion) : null,
    Online && R.LatencyMs != null ? Row('Handshake', Esc(FormatLatency(R.LatencyMs))) : null,
    Psus && Psus.length ? Row('Power', PsuPills(Psus)) : null,
    Program ? TextRow('ME 1 program', SourceLabel(Program)) : null,
    Preview ? TextRow('ME 1 preview', SourceLabel(Preview)) : null,
    Streaming ? Row('Streaming', StreamingPill(Streaming)) : null,
    Recording ? Row('Recording', RecordingPill(Recording)) : null,
    Degraded && R.DegradedReason ? TextRow('Reason', R.DegradedReason) : null,
    !Online && R.Error ? TextRow('Detail', R.Error) : null,
  ]);
}

export const Name = 'Blackmagic ATEM';
export const Description =
  'Holds a read-only session to a Blackmagic ATEM switcher over its UDP control protocol and reports its product, protocol version, power supplies, ME 1 program/preview, and streaming/recording status where the model has them. Online when connected; Degraded when a power supply has failed or an enabled streaming/recording check fails.';
export const Group = 'Video';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
// Latency is the once-per-session handshake round trip (see header), so a
// per-probe latency threshold would not track anything.
export const SupportsLatencyThreshold = false;
export const _internal = { ParseOptions, Evaluate, SourceLabel, ResolveParams };
export { ID, Settings, Run, Debug };
