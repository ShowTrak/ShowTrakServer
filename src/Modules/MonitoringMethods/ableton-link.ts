// Ableton Link: watches the Link session(s) on the network and reports how many
// peers are in it, how many separate sessions there are, the tempo and whether
// the transport is playing (start/stop sync).
//
// Passive and network-wide, like ndi-source: Link apps multicast their state to
// 224.76.78.75:20808 every 250 ms and ShowTrak only listens (see _link-shared.ts
// for the wire format, cited against the Link source, and for why it never
// announces itself). The Address field is unused; an optional address list
// restricts which peers count.
//
// Verdicts:
//   Offline   no peers heard (or the listener failed), or fewer than MinPeers
//             when BelowMinimum is 'offline'.
//   Degraded  fewer than MinPeers [BelowMinimum 'degraded']; more than one
//             session [ExpectSingleSession, on]; a tempo outside ExpectedTempo ±
//             TempoTolerance [CheckTempo, off]; a transport that is not in the
//             expected state [CheckPlaying, off].
import {
  LinkReceiver,
  NormalizeAddress,
  ParseLinkMessage,
  LINK_MULTICAST_GROUP,
  LINK_PORT,
  MIN_TEMPO_BPM,
  MAX_TEMPO_BPM,
  type LinkPeer,
  type LinkSnapshot,
} from './_link-shared';
import { Card, Esc, FormatLatency, Note, Pill, Row, Rows, TextRow } from './debug';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'ableton-link';

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_TEMPO = 120;
const DEFAULT_TEMPO_TOLERANCE = 0.5;
const MAX_PEERS_SETTING = 100;

const Settings: MonitoringSettingField[] = [
  {
    Key: 'MinPeers',
    Label: 'Minimum peers',
    Type: 'number',
    Default: 1,
    Min: 1,
    Max: MAX_PEERS_SETTING,
    Note: 'How many Link apps must be heard. ShowTrak only listens, so it never counts itself.',
  },
  {
    Key: 'BelowMinimum',
    Label: 'Below the minimum',
    Type: 'select',
    Default: 'offline',
    Options: [
      { value: 'offline', label: 'Offline' },
      { value: 'degraded', label: 'Degraded' },
    ],
    Note: 'What fewer peers than the minimum reports. No peers at all is always Offline.',
  },
  {
    Key: 'ExpectSingleSession',
    Label: 'Expect a single session',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded when the peers are split across more than one Link session.',
  },
  {
    Key: 'CheckTempo',
    Label: 'Check tempo',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when any peer reports a tempo outside the expected range.',
  },
  {
    Key: 'ExpectedTempo',
    Label: 'Expected tempo (BPM)',
    Type: 'number',
    Default: DEFAULT_TEMPO,
    Min: MIN_TEMPO_BPM,
    Max: MAX_TEMPO_BPM,
    VisibleWhen: { Key: 'CheckTempo', Equals: true },
  },
  {
    Key: 'TempoTolerance',
    Label: 'Tempo tolerance (BPM)',
    Type: 'number',
    Default: DEFAULT_TEMPO_TOLERANCE,
    Min: 0,
    Max: 100,
    VisibleWhen: { Key: 'CheckTempo', Equals: true },
    Note: 'How far either side of the expected tempo still counts as correct.',
  },
  {
    Key: 'CheckPlaying',
    Label: 'Check transport',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when the session transport is not in the expected state. Needs Start Stop Sync turned on in at least one Link app.',
  },
  {
    Key: 'ExpectedPlaying',
    Label: 'Expected transport',
    Type: 'select',
    Default: 'playing',
    Options: [
      { value: 'playing', label: 'Playing' },
      { value: 'stopped', label: 'Stopped' },
    ],
    VisibleWhen: { Key: 'CheckPlaying', Equals: true },
  },
  {
    Key: 'PeerAddresses',
    Label: 'Only count peers from',
    Type: 'list',
    ItemType: 'string',
    Default: [],
    Advanced: true,
    Note: 'IP addresses of the Link apps to count. Leave empty to count every peer heard.',
  },
];

export interface LinkOptions {
  MinPeers: number;
  BelowMinimum: 'offline' | 'degraded';
  ExpectSingleSession: boolean;
  CheckTempo: boolean;
  ExpectedTempo: number;
  TempoTolerance: number;
  CheckPlaying: boolean;
  ExpectedPlaying: boolean;
  PeerAddresses: string[];
}

function Clamp(Value: unknown, Min: number, Max: number, Fallback: number): number {
  const N = Number(Value);
  if (Value === null || Value === '' || !Number.isFinite(N)) return Fallback;
  return Math.min(Max, Math.max(Min, N));
}

export function ParseOptions(Target: MonitoringTargetLike): LinkOptions {
  const Cfg = (Target && Target.Settings) || {};
  const Addresses = Array.isArray(Cfg.PeerAddresses)
    ? (Cfg.PeerAddresses as unknown[])
    : typeof Cfg.PeerAddresses === 'string'
      ? String(Cfg.PeerAddresses).split(/[\s,]+/)
      : [];
  return {
    MinPeers: Math.round(Clamp(Cfg.MinPeers, 1, MAX_PEERS_SETTING, 1)),
    BelowMinimum: Cfg.BelowMinimum === 'degraded' ? 'degraded' : 'offline',
    // Absent counts as on so the default holds for a check saved before the toggle.
    ExpectSingleSession: Cfg.ExpectSingleSession !== false,
    CheckTempo: Cfg.CheckTempo === true,
    ExpectedTempo: Clamp(Cfg.ExpectedTempo, MIN_TEMPO_BPM, MAX_TEMPO_BPM, DEFAULT_TEMPO),
    TempoTolerance: Clamp(Cfg.TempoTolerance, 0, 100, DEFAULT_TEMPO_TOLERANCE),
    CheckPlaying: Cfg.CheckPlaying === true,
    ExpectedPlaying: Cfg.ExpectedPlaying !== 'stopped',
    PeerAddresses: Addresses.map(NormalizeAddress).filter(
      (A, I, All) => A !== '' && All.indexOf(A) === I
    ),
  };
}

// '120', '128.5', '99.99': at most two decimals, no trailing zeros.
export function FormatTempo(Bpm: number | null): string {
  if (Bpm == null || !Number.isFinite(Bpm)) return '-';
  return String(Math.round(Bpm * 100) / 100);
}

function PlayingLabel(Playing: boolean | null): string {
  return Playing == null ? 'Unknown' : Playing ? 'Playing' : 'Stopped';
}

export interface LinkPeerSummary {
  NodeId: string;
  Address: string;
  SessionId: string;
  Tempo: number | null;
  IsPlaying: boolean | null;
  MeasurementEndpoint: string | null;
  AgeMs: number;
}

export interface LinkSessionSummary {
  SessionId: string;
  PeerCount: number;
  // Distinct tempos its peers report (rounded to 0.01 BPM), most common first.
  Tempos: number[];
  // The start/stop state with the newest timestamp among its peers; null when
  // no peer carries one, or it is still Link's never-set default.
  Playing: boolean | null;
  Peers: LinkPeerSummary[];
}

function PeerMatches(Peer: LinkPeer, Addresses: string[]): boolean {
  if (!Addresses.length) return true;
  if (Addresses.includes(Peer.Address)) return true;
  const Mep = Peer.MeasurementEndpoint ? Peer.MeasurementEndpoint.split(':')[0] : '';
  return !!Mep && Addresses.includes(Mep);
}

// Group peers by session. Sessions are ordered largest first, then by ID.
export function SummariseSessions(Peers: LinkPeer[], Now: number): LinkSessionSummary[] {
  const BySession = new Map<string, LinkPeer[]>();
  for (const Peer of Peers) {
    const List = BySession.get(Peer.SessionId);
    if (List) List.push(Peer);
    else BySession.set(Peer.SessionId, [Peer]);
  }
  const Sessions: LinkSessionSummary[] = [];
  for (const [SessionId, Members] of BySession) {
    const Counts = new Map<number, number>();
    let Newest: LinkPeer | null = null;
    for (const P of Members) {
      if (P.Tempo != null) {
        const T = Math.round(P.Tempo * 100) / 100;
        Counts.set(T, (Counts.get(T) || 0) + 1);
      }
      if (
        P.IsPlaying != null &&
        P.StartStopTimestamp != null &&
        (!Newest || P.StartStopTimestamp > (Newest.StartStopTimestamp as number))
      ) {
        Newest = P;
      }
    }
    // An all-zero start/stop state is the default before any app has set it
    // (link/StartStopState.hpp:89-91), so it says nothing about the transport.
    const Playing =
      Newest && (Newest.IsPlaying || Newest.StartStopTimestamp !== 0)
        ? (Newest.IsPlaying as boolean)
        : null;
    Sessions.push({
      SessionId,
      PeerCount: Members.length,
      Tempos: Array.from(Counts.entries())
        .sort((A, B) => B[1] - A[1] || A[0] - B[0])
        .map(([T]) => T),
      Playing,
      Peers: Members.map((P) => ({
        NodeId: P.NodeId,
        Address: P.Address,
        SessionId: P.SessionId,
        Tempo: P.Tempo,
        IsPlaying: P.IsPlaying,
        MeasurementEndpoint: P.MeasurementEndpoint,
        AgeMs: Math.max(0, Now - P.LastSeenAt),
      })).sort((A, B) => A.Address.localeCompare(B.Address) || A.NodeId.localeCompare(B.NodeId)),
    });
  }
  return Sessions.sort(
    (A, B) => B.PeerCount - A.PeerCount || A.SessionId.localeCompare(B.SessionId)
  );
}

interface EvaluateParams {
  Snapshot: LinkSnapshot;
  Options: LinkOptions;
  Now: number;
}

function Plural(N: number, Word: string): string {
  return `${N} ${Word}${N === 1 ? '' : 's'}`;
}

// Pure decision logic over a receiver snapshot. Exported via _internal.
export function EvaluateLink(P: EvaluateParams): MonitoringResult {
  const O = P.Options;
  const Base = { MinPeers: O.MinPeers, PeerAddresses: O.PeerAddresses };
  if (P.Snapshot.Error) {
    return {
      Success: false,
      Error: `Failed to listen for Ableton Link: ${P.Snapshot.Error}`,
      ...Base,
      PeerCount: 0,
      TotalPeerCount: 0,
      SessionCount: 0,
      Sessions: [],
    };
  }

  const Live = P.Snapshot.Peers.filter((Peer) => Peer.ExpiresAt > P.Now);
  const Counted = Live.filter((Peer) => PeerMatches(Peer, O.PeerAddresses));
  const Sessions = SummariseSessions(Counted, P.Now);
  const Tempos = Array.from(new Set(Sessions.flatMap((S) => S.Tempos))).sort((A, B) => A - B);
  const States = Array.from(new Set(Sessions.map((S) => S.Playing)));
  const Playing = States.length === 1 ? States[0]! : null; // non-empty: length checked
  const Newest = Counted.reduce((Max, Peer) => Math.max(Max, Peer.LastSeenAt), 0);
  const Info = {
    ...Base,
    PeerCount: Counted.length,
    TotalPeerCount: Live.length,
    SessionCount: Sessions.length,
    Sessions,
    Tempos,
    Playing,
  };

  if (!Counted.length) {
    const Filtered = O.PeerAddresses.length
      ? ` from ${O.PeerAddresses.join(', ')}` +
        (Live.length ? ` (${Plural(Live.length, 'other peer')} heard)` : '')
      : '';
    return {
      Success: false,
      Error: P.Snapshot.Ready
        ? `No Ableton Link peers heard${Filtered}`
        : 'Ableton Link listener starting…',
      ...Info,
    };
  }

  const Reasons: string[] = [];
  if (Counted.length < O.MinPeers) {
    const Message = `${Plural(Counted.length, 'Link peer')} heard (minimum ${O.MinPeers})`;
    if (O.BelowMinimum === 'offline') return { Success: false, Error: Message, ...Info };
    Reasons.push(Message);
  }
  if (O.ExpectSingleSession && Sessions.length > 1) {
    Reasons.push(`Link session split (${Sessions.length} sessions)`);
  }
  if (O.CheckTempo) {
    const Wrong = Tempos.filter((T) => Math.abs(T - O.ExpectedTempo) > O.TempoTolerance + 1e-9);
    if (Wrong.length) {
      Reasons.push(
        `Tempo ${Wrong.map(FormatTempo).join(', ')} BPM (expected ${FormatTempo(
          O.ExpectedTempo
        )} ± ${FormatTempo(O.TempoTolerance)})`
      );
    }
  }
  if (O.CheckPlaying) {
    const Expected = O.ExpectedPlaying ? 'playing' : 'stopped';
    if (Sessions.some((S) => S.Playing == null)) {
      Reasons.push(`Transport state unknown (expected ${Expected})`);
    } else if (Sessions.some((S) => S.Playing !== O.ExpectedPlaying)) {
      Reasons.push(`Transport ${O.ExpectedPlaying ? 'stopped' : 'playing'} (expected ${Expected})`);
    }
  }

  const Result: MonitoringResult = {
    Success: true,
    // Passive: the "latency" is the age of the newest announcement.
    LatencyMs: Math.max(0, P.Now - Newest),
    ...Info,
  };
  if (Reasons.length) {
    Result.Degraded = true;
    Result.DegradedReason = Reasons.join('; ');
  }
  return Result;
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Options = ParseOptions(Target);
  LinkReceiver.Observe();
  // The first run after the listener opens waits for a round of announcements.
  await LinkReceiver.WarmUp();
  return EvaluateLink({ Snapshot: LinkReceiver.Snapshot(), Options, Now: Date.now() });
}

function Mono(Value: unknown): string {
  return `<span class="font-monospace">${Esc(Value)}</span>`;
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const O = ParseOptions(Target);
  const Online = !!(Result && Result.Success === true);
  const Degraded = !!(Result && Result.Degraded);
  const StatusPill =
    Online && !Degraded
      ? Pill('success', 'In session')
      : Online
        ? Pill('warning', (Result && Result.DegradedReason) || 'Degraded')
        : Pill('danger', 'No session');

  const Sessions: LinkSessionSummary[] = Array.isArray(Result && Result.Sessions)
    ? (Result.Sessions as LinkSessionSummary[])
    : [];
  const Tempos: number[] = Array.isArray(Result && Result.Tempos)
    ? (Result.Tempos as number[])
    : [];
  const PeerCount = Number(Result && Result.PeerCount) || 0;
  const TotalPeerCount = Number(Result && Result.TotalPeerCount) || 0;
  const Playing = Result && typeof Result.Playing === 'boolean' ? Result.Playing : null;

  const Head = Rows([
    Row('Status', StatusPill),
    !Online && Result && Result.Error ? TextRow('Detail', Result.Error) : null,
    TextRow(
      'Peers',
      `${PeerCount} (minimum ${O.MinPeers})` +
        (O.PeerAddresses.length && TotalPeerCount > PeerCount
          ? `, ${TotalPeerCount - PeerCount} filtered out`
          : '')
    ),
    TextRow('Sessions', String(Sessions.length)),
    Tempos.length ? Row('Tempo', Mono(`${Tempos.map(FormatTempo).join(', ')} BPM`)) : null,
    Sessions.length
      ? TextRow(
          'Transport',
          Sessions.length > 1 && Playing == null && Sessions.some((S) => S.Playing != null)
            ? 'Differs between sessions'
            : PlayingLabel(Playing)
        )
      : null,
    O.PeerAddresses.length ? TextRow('Only peers from', O.PeerAddresses.join(', ')) : null,
    TextRow('Listening on', `${LINK_MULTICAST_GROUP}:${LINK_PORT}`),
  ]);

  if (!Sessions.length) {
    return (
      Head +
      '<div class="mt-2">' +
      Note(
        'No Link peers heard. Link apps announce themselves every 250 ms, so a running session shows within a second.'
      ) +
      '</div>'
    );
  }

  const Cards = Sessions.map((S, Index) => {
    const PeerLines = (Array.isArray(S.Peers) ? S.Peers : [])
      .map(
        (Peer) =>
          '<div class="text-muted small text-break">' +
          `<span class="font-monospace">${Esc(Peer.Address || '-')}</span>` +
          ` · node ${Esc(Peer.NodeId)}` +
          (Peer.Tempo != null ? ` · ${Esc(FormatTempo(Peer.Tempo))} BPM` : '') +
          ` · ${Esc(FormatLatency(Peer.AgeMs))} ago` +
          '</div>'
      )
      .join('');
    const Summary =
      '<div class="text-muted small">' +
      `${Esc(S.Tempos.length ? `${S.Tempos.map(FormatTempo).join(', ')} BPM` : 'Tempo unknown')}` +
      ` · ${Esc(PlayingLabel(S.Playing))}` +
      '</div>';
    return Card({
      Title: `Session ${S.SessionId}`,
      TitleClass: 'font-monospace',
      Badge: Pill(Index === 0 ? 'success' : 'warning', Plural(S.PeerCount, 'peer')),
      BodyHtml: Summary + PeerLines,
      Highlight: Index === 0 && Sessions.length === 1,
    });
  }).join('');

  return (
    Head +
    `<div class="text-muted small mt-2 mb-1">Link sessions (${Sessions.length})</div>` +
    `<div class="d-grid gap-1">${Cards}</div>`
  );
}

export const Name = 'Ableton Link - Session';
export const Description =
  'Passively listens for Ableton Link peers on the network and reports the peer count, session split, tempo and transport state.';
export const DefaultInterval = DEFAULT_INTERVAL_MS;
// Link discovery is network-wide multicast: the Address field is unused, and no
// round-trip latency is measured, so both editor fields are hidden.
export const UsesAddress = false;
export const SupportsLatencyThreshold = false;
export { ID, Settings, Run, Debug };

// Exported for unit tests.
export const _internal = {
  ParseLinkMessage,
  ParseOptions,
  SummariseSessions,
  EvaluateLink,
  FormatTempo,
  LinkReceiver,
};
