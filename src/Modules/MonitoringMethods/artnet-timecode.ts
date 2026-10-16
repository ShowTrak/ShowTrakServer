// Art-Net timecode: confirms a timecode generator (source IP) is sending
// ArtTimeCode right now and, optionally, that the time is advancing at the
// expected frame rate.
//
// Protocol (Art-Net 4, ArtTimeCode / OpTimeCode 0x9700): a 19-byte packet with
// Frames, Seconds, Minutes, Hours and Type (0 Film 24, 1 EBU 25, 2 DF 29.97,
// 3 SMPTE 30), plus a StreamId (0x00 = master) that older senders transmit as a
// zero filler. The spec leaves casting to the application; generators usually
// broadcast it. There is nothing to ask for, so this is passive — like
// artnet-universe it reads the cache of the process-wide receiver in
// ./_artnet-shared, which tracks per (source IP, StreamId) the latest value, when
// a packet last arrived and when the value last CHANGED. As in artnet-universe,
// Address is the transmitter.
//
// Verdicts:
//   Offline   no ArtTimeCode from the source within the grace period (Timeout).
//             Many generators stop sending when their clock is stopped, so this
//             check suits "timecode must be running now" moments, not a rig that
//             idles between cues.
//   Degraded  packets arrive but the time has not moved for StallMs
//             [CheckAdvancing, on] — a paused generator that keeps repeating the
//             same frame; or the Type differs from the expected rate
//             [CheckFrameRate, off].
//
// When the source sends several streams, the master (StreamId 0) is evaluated,
// else the most recently heard stream; the others are listed in the result.
import {
  ArtnetReceiver,
  AddressesEqual,
  FormatTimecode,
  ParseArtTimeCode,
  TIMECODE_TYPES,
  type ArtTimecodeSnapshot,
  type ArtTimecodeSource,
} from './_artnet-shared';
import { Card, Esc, FormatLatency, Note, Pill, Row, Rows, TextRow } from './debug';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'artnet-timecode';

const DEFAULT_GRACE_PERIOD_MS = 3000;
const DEFAULT_STALL_MS = 2000;
const DEFAULT_INTERVAL_MS = 5000;

const FRAME_RATE_OPTIONS = [
  { value: '0', label: 'Film (24 fps)' },
  { value: '1', label: 'EBU (25 fps)' },
  { value: '2', label: 'Drop-frame (29.97 fps)' },
  { value: '3', label: 'SMPTE (30 fps)' },
];

const Settings: MonitoringSettingField[] = [
  {
    Key: 'CheckAdvancing',
    Label: 'Check timecode is advancing',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded when packets keep arriving but the time has stopped moving, e.g. a paused generator.',
  },
  {
    Key: 'StallMs',
    Label: 'Stalled after (ms)',
    Type: 'number',
    Default: DEFAULT_STALL_MS,
    Min: 200,
    Max: 60000,
    VisibleWhen: { Key: 'CheckAdvancing', Equals: true },
    Note: 'How long the time may stay unchanged before the check reports Degraded.',
  },
  {
    Key: 'CheckFrameRate',
    Label: 'Check frame rate',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when the timecode type in the packets differs from the expected frame rate.',
  },
  {
    Key: 'ExpectedFrameRate',
    Label: 'Expected frame rate',
    Type: 'select',
    Default: '1',
    Options: FRAME_RATE_OPTIONS,
    VisibleWhen: { Key: 'CheckFrameRate', Equals: true },
  },
  {
    Key: 'Timeout',
    Label: 'Grace period (ms)',
    Type: 'number',
    Default: DEFAULT_GRACE_PERIOD_MS,
    Min: 500,
    Max: 60000,
    Advanced: true,
    Note: 'Offline when no ArtTimeCode has arrived from the source for this long.',
  },
];

export interface TimecodeOptions {
  GracePeriodMs: number;
  CheckAdvancing: boolean;
  StallMs: number;
  CheckFrameRate: boolean;
  ExpectedType: number;
}

export function ParseOptions(Target: MonitoringTargetLike): TimecodeOptions {
  const Cfg = (Target && Target.Settings) || {};
  const Grace = Number(Cfg.Timeout);
  const Stall = Number(Cfg.StallMs);
  const Expected = Number(Cfg.ExpectedFrameRate);
  return {
    GracePeriodMs: Number.isFinite(Grace) ? Math.max(500, Grace | 0) : DEFAULT_GRACE_PERIOD_MS,
    // Absent counts as on so the default holds for a check saved before the toggle.
    CheckAdvancing: Cfg.CheckAdvancing !== false,
    StallMs: Number.isFinite(Stall) ? Math.max(200, Stall | 0) : DEFAULT_STALL_MS,
    CheckFrameRate: Cfg.CheckFrameRate === true,
    ExpectedType: Number.isInteger(Expected) && TIMECODE_TYPES[Expected] ? Expected : 1,
  };
}

function TypeLabel(Type: number): string {
  return TIMECODE_TYPES[Type]?.Label ?? `Unknown type ${Type}`;
}

function Seconds(Ms: number): string {
  return `${(Ms / 1000).toFixed(1)} s`;
}

export interface OtherTimecodeSource {
  Address: string;
  StreamId: number;
  Timecode: string;
  Type: string;
  AgeMs: number;
}

interface EvaluateParams {
  Snapshot: ArtTimecodeSnapshot;
  Address: string;
  Options: TimecodeOptions;
  Now: number;
}

function Describe(S: ArtTimecodeSource, Now: number): OtherTimecodeSource {
  return {
    Address: S.Address,
    StreamId: S.StreamId,
    Timecode: FormatTimecode(S),
    Type: TypeLabel(S.Type),
    AgeMs: Math.max(0, Now - S.LastSeenAt),
  };
}

// Pure decision logic over a receiver snapshot. Exported via _internal.
export function EvaluateTimecode(P: EvaluateParams): MonitoringResult {
  const Base = { Address: P.Address };
  if (P.Snapshot.Error) {
    return {
      Success: false,
      Error: `Art-Net listener error: ${P.Snapshot.Error}`,
      ...Base,
      OtherSources: [],
    };
  }

  const Fresh = P.Snapshot.Sources.filter(
    (S) => P.Now - S.LastSeenAt <= P.Options.GracePeriodMs
  ).sort((A, B) => B.LastSeenAt - A.LastSeenAt);
  const FromTarget = Fresh.filter((S) => AddressesEqual(S.Address, P.Address));
  const Others = Fresh.filter((S) => !AddressesEqual(S.Address, P.Address));

  if (!FromTarget.length) {
    const Heard = Others.map((S) => S.Address).filter((A, I, All) => All.indexOf(A) === I);
    return {
      Success: false,
      Error: !P.Snapshot.Ready
        ? 'Art-Net listener starting…'
        : `No Art-Net timecode from ${P.Address}` +
          (Heard.length ? ` (heard from ${Heard.join(', ')})` : ''),
      ...Base,
      OtherSources: Others.map((S) => Describe(S, P.Now)),
    };
  }

  const Source = FromTarget.find((S) => S.StreamId === 0) ?? FromTarget[0]!; // non-empty: checked above
  const Rest = Fresh.filter((S) => S !== Source);
  const SinceAdvanceMs = Math.max(0, P.Now - Source.LastChangedAt);
  const Timecode = FormatTimecode(Source);

  const Reasons: string[] = [];
  if (P.Options.CheckAdvancing && SinceAdvanceMs > P.Options.StallMs) {
    Reasons.push(`Timecode stalled at ${Timecode} for ${Seconds(SinceAdvanceMs)}`);
  }
  if (P.Options.CheckFrameRate && Source.Type !== P.Options.ExpectedType) {
    Reasons.push(
      `Frame rate ${TypeLabel(Source.Type)} (expected ${TypeLabel(P.Options.ExpectedType)})`
    );
  }

  const Result: MonitoringResult = {
    Success: true,
    // Passive: the "latency" is the age of the newest packet, as artnet-universe.
    LatencyMs: Math.max(0, P.Now - Source.LastSeenAt),
    ...Base,
    Timecode,
    TimecodeType: TypeLabel(Source.Type),
    TypeCode: Source.Type,
    DropFrame: !!TIMECODE_TYPES[Source.Type]?.DropFrame,
    StreamId: Source.StreamId,
    AgeMs: Math.max(0, P.Now - Source.LastSeenAt),
    SinceAdvanceMs,
    PacketCount: Source.PacketCount,
    OtherSources: Rest.map((S) => Describe(S, P.Now)),
  };
  if (Reasons.length) {
    Result.Degraded = true;
    Result.DegradedReason = Reasons.join('; ');
  }
  return Result;
}

function Run(Target: MonitoringTargetLike): MonitoringResult {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  if (!Address) return { Success: false, Error: 'No source IP configured' };

  ArtnetReceiver.ObserveTimecode();
  return EvaluateTimecode({
    Snapshot: ArtnetReceiver.TimecodeSnapshot(),
    Address,
    Options: ParseOptions(Target),
    Now: Date.now(),
  });
}

function Mono(Value: unknown): string {
  return `<span class="font-monospace">${Esc(Value)}</span>`;
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  const Online = !!(Result && Result.Success === true);
  const Degraded = !!(Result && Result.Degraded);
  const StatusPill =
    Online && !Degraded
      ? Pill('success', 'Running')
      : Online
        ? Pill('warning', (Result && Result.DegradedReason) || 'Degraded')
        : Pill('danger', 'Not receiving');

  const Head = Rows([
    TextRow('Source IP', Address || '—'),
    Row('Status', StatusPill),
    Online ? Row('Timecode', Mono(Result.Timecode)) : null,
    Online ? TextRow('Type', Result.TimecodeType) : null,
    Online && Number(Result.StreamId) !== 0 ? TextRow('Stream', String(Result.StreamId)) : null,
    Online ? Row('Last packet', Mono(`${FormatLatency(Result.AgeMs)} ago`)) : null,
    Online ? Row('Last advanced', Mono(`${FormatLatency(Result.SinceAdvanceMs)} ago`)) : null,
    !Online && Result && Result.Error ? TextRow('Detail', Result.Error) : null,
  ]);

  const Others: OtherTimecodeSource[] = Array.isArray(Result && Result.OtherSources)
    ? (Result.OtherSources as OtherTimecodeSource[])
    : [];
  if (!Others.length) {
    return Head + '<div class="mt-2">' + Note('No other timecode sources heard') + '</div>';
  }

  const Cards = Others.map((S) =>
    Card({
      Title: S.StreamId ? `${S.Address} · stream ${S.StreamId}` : S.Address,
      TitleClass: 'font-monospace',
      Badge: Pill('muted', S.Timecode),
      BodyHtml: `<div class="text-muted small">${Esc(S.Type)} · ${Esc(FormatLatency(S.AgeMs))} ago</div>`,
    })
  ).join('');
  return (
    Head +
    `<div class="text-muted small mt-2 mb-1">Other timecode sources (${Others.length})</div>` +
    `<div class="d-grid gap-1">${Cards}</div>`
  );
}

export const Name = 'Art-Net - Timecode running';
export const Description =
  'Passively listens for Art-Net timecode (ArtTimeCode) from a source and confirms it is arriving and advancing, optionally at the expected frame rate.';
export const DefaultInterval = DEFAULT_INTERVAL_MS;
// Passive listener: no round-trip latency is measured.
export const SupportsLatencyThreshold = false;
export { ID, Settings, Run, Debug };

// Exported for unit tests.
export const _internal = {
  EvaluateTimecode,
  ParseOptions,
  FormatTimecode,
  ParseArtTimeCode,
  ArtnetReceiver,
};
