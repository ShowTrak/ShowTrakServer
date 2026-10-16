// Art-Net node health: unicasts an ArtPoll to one node and reads its
// ArtPollReply — identity, the node report, and the per-port status flags.
//
// Protocol (Art-Net 4, Artistic Licence):
//   - ArtPoll (OpPoll 0x2000) is the discovery packet every controller sends
//     every 2.5–3 s. It changes nothing on the node; we send it with Flags = 0
//     (no targeted mode, no diagnostics, no "reply on change" subscription).
//   - The node answers with one ArtPollReply (OpPollReply 0x2100) per bound
//     group of up to four ports, distinguished by BindIndex (1 = root). Art-Net 4
//     mandates that replies are UNICAST to the poller's port 6454, and that a node
//     waits a random 0–1 s before replying to spread out large systems.
//
// Design choices:
//   - The poll goes out from the process-wide socket in ./_artnet-shared, which
//     is already bound to 6454: that is where the node sends its reply, and a
//     second socket on 6454 would split unicast delivery between the two.
//   - Online = any ArtPollReply from the node AFTER our poll went out, within the
//     timeout. A reply overheard before the poll (a console's poll, or an Art-Net
//     3 node's broadcast) never satisfies the check: Art-Net 4 nodes no longer
//     broadcast replies, so passively overheard replies would make the verdict
//     depend on whether some console happens to be polling, and their age says
//     nothing about the node right now. A reply that arrives after our poll counts
//     whoever provoked it, since it proves the same thing.
//   - Rate limit: concurrent checks of one IP share a single ArtPoll, and a poll
//     within 1 s of the last reuses its result (see PollNode), so the traffic is
//     at most one unicast ArtPoll per node per check interval — far below the
//     2.5–3 s broadcast cadence the spec expects of every controller.
//   - Replies from a node with more than four ports arrive as a burst, one per
//     BindIndex; after the first we keep listening POLL_SETTLE_MS for the rest
//     and merge them, numbering ports 1..N in BindIndex order.
//   - The random reply delay makes the poll→reply time a poor latency signal, so
//     the latency-threshold field is hidden; the time is still reported.
//
// Assertions (Degraded):
//   CheckPortErrors (on)  GoodInput bit 2 "receive errors detected" on an input
//                         port; GoodOutputA bit 2 "DMX output short detected" on
//                         an output port. No other GoodInput/GoodOutput bit is an
//                         error — the rest describe data, merging and conversion.
//   CheckNodeReport (on)  The NodeReport status code is a fault code (see
//                         NODE_REPORT_CODES). Advisory and confirmation codes are
//                         shown but never degrade.
//   CheckName (off)       ExpectedName must equal the short or long name.
import net from 'net';
import {
  ArtnetReceiver,
  BuildArtPoll,
  ParseArtPollReply,
  STYLE_CODES,
  type ArtPollReply,
  type ArtPollReplyPort,
} from './_artnet-shared';
import { Card, Esc, FormatLatency, Note, Pill, Row, Rows, TextRow } from './debug';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'artnet-node';

const DEFAULT_TIMEOUT_MS = 4000;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 30000;
// Polling a node is cheap and node faults (a shorted output) matter quickly.
const DEFAULT_INTERVAL_MS = 10000;

// --- Node report -------------------------------------------------------------
//
// Table 3 of the spec. Fault = a condition that is wrong with the node now.
// Deliberately NOT faults:
//   RcDebug 0x0000, RcPowerOk 0x0001, RcShNameOk/RcLoNameOk 0x0006/7 — status
//     and confirmations.
//   RcSocketWr1 0x0003 — one truncated transmission, "most likely caused by a
//     collision": a transient that stays reported until the next event, so it
//     would hold a healthy node Degraded.
//   RcParseFail 0x0004 — the node received a packet it did not recognise, which
//     any third-party Art-Net extension on the network can trigger.
//   RcUserFail 0x000f — front-panel changes ignored because the node is locked
//     by remote programming: the configuration is unchanged.
//   RcFactoryRes 0x0010 — a factory reset occurred; advisory per the spec.
// Unknown codes are shown as-is and never degrade.
export const NODE_REPORT_CODES: Record<
  number,
  { Mnemonic: string; Description: string; Fault: boolean }
> = {
  0x0000: { Mnemonic: 'RcDebug', Description: 'Booted in debug mode', Fault: false },
  0x0001: { Mnemonic: 'RcPowerOk', Description: 'Power-on tests successful', Fault: false },
  0x0002: {
    Mnemonic: 'RcPowerFail',
    Description: 'Hardware tests failed at power-on',
    Fault: true,
  },
  0x0003: {
    Mnemonic: 'RcSocketWr1',
    Description: 'Last UDP transmission truncated (likely a collision)',
    Fault: false,
  },
  0x0004: {
    Mnemonic: 'RcParseFail',
    Description: 'Unable to identify last UDP transmission',
    Fault: false,
  },
  0x0005: { Mnemonic: 'RcUdpFail', Description: 'Unable to open UDP socket', Fault: true },
  0x0006: { Mnemonic: 'RcShNameOk', Description: 'Short name programmed', Fault: false },
  0x0007: { Mnemonic: 'RcLoNameOk', Description: 'Long name programmed', Fault: false },
  0x0008: { Mnemonic: 'RcDmxError', Description: 'DMX512 receive errors detected', Fault: true },
  0x0009: {
    Mnemonic: 'RcDmxUdpFull',
    Description: 'Ran out of internal DMX transmit buffers',
    Fault: true,
  },
  0x000a: {
    Mnemonic: 'RcDmxRxFull',
    Description: 'Ran out of internal DMX receive buffers',
    Fault: true,
  },
  0x000b: {
    Mnemonic: 'RcSwitchErr',
    Description: 'Receive universe switches conflict',
    Fault: true,
  },
  0x000c: {
    Mnemonic: 'RcConfigErr',
    Description: 'Product configuration does not match firmware',
    Fault: true,
  },
  0x000d: { Mnemonic: 'RcDmxShort', Description: 'DMX output short detected', Fault: true },
  0x000e: {
    Mnemonic: 'RcFirmwareFail',
    Description: 'Last firmware upload failed',
    Fault: true,
  },
  0x000f: {
    Mnemonic: 'RcUserFail',
    Description: 'Switch changes ignored while remotely locked',
    Fault: false,
  },
  0x0010: { Mnemonic: 'RcFactoryRes', Description: 'Factory reset has occurred', Fault: false },
};

export interface ParsedNodeReport {
  Raw: string;
  Code: number | null;
  CodeHex: string | null;
  Counter: number | null;
  Text: string;
  Mnemonic: string | null;
  Description: string | null;
  Fault: boolean;
}

// "#xxxx [yyyy..] zzzzz…": xxxx = hex status code (Table 3), yyyy = decimal count
// of ArtPollReplies sent (rolls over at 9999), zzzz = free text. Nodes vary in
// spacing and some omit the counter, so both are optional here; a report that
// does not start with '#' is kept as plain text with no code.
const NODE_REPORT_PATTERN = /^#([0-9a-f]{1,4})\s*(?:\[\s*(\d+)\s*\])?\s*(.*)$/i;

export function ParseNodeReport(Raw: unknown): ParsedNodeReport {
  const Text = String(Raw == null ? '' : Raw).trim();
  const Match = NODE_REPORT_PATTERN.exec(Text);
  if (!Match) {
    return {
      Raw: Text,
      Code: null,
      CodeHex: null,
      Counter: null,
      Text,
      Mnemonic: null,
      Description: null,
      Fault: false,
    };
  }
  const Code = parseInt(Match[1]!, 16); // group 1 always participates in a match
  const Known = NODE_REPORT_CODES[Code];
  return {
    Raw: Text,
    Code,
    CodeHex: `0x${Code.toString(16).padStart(4, '0')}`,
    Counter: Match[2] != null ? Number(Match[2]) : null,
    Text: (Match[3] || '').trim(),
    Mnemonic: Known ? Known.Mnemonic : null,
    Description: Known ? Known.Description : null,
    Fault: Known ? Known.Fault : false,
  };
}

// --- Ports -------------------------------------------------------------------

export type FlagKind = 'success' | 'warning' | 'danger' | 'muted';

export interface PortFlag {
  Label: string;
  Kind: FlagKind;
}

export interface NodePort {
  // 1-based across every reply, in BindIndex order.
  Index: number;
  BindIndex: number;
  Direction: 'Input' | 'Output' | 'Input/Output';
  Protocol: string;
  InputUniverse: number | null;
  OutputUniverse: number | null;
  Flags: PortFlag[];
  // Error conditions, each already phrased for a reason: universe + text.
  Faults: Array<{ Universe: number; Text: string }>;
}

function Bit(Value: number, BitIndex: number): boolean {
  return (Value & (1 << BitIndex)) !== 0;
}

// Decode one port's GoodInput / GoodOutputA / GoodOutputB into display flags and
// faults. Only the bits for the port's own direction(s) are read: nodes fill all
// four array slots and an output-only port's GoodInput byte means nothing.
function DecodePort(P: ArtPollReplyPort, Index: number, BindIndex: number): NodePort {
  const Flags: PortFlag[] = [];
  const Faults: NodePort['Faults'] = [];

  if (P.CanInput) {
    const G = P.GoodInput;
    if (Bit(G, 7)) Flags.push({ Label: 'Input receiving', Kind: 'success' });
    if (Bit(G, 2)) {
      Flags.push({ Label: 'Input receive errors', Kind: 'danger' });
      Faults.push({ Universe: P.InputUniverse, Text: 'DMX input receive errors' });
    }
    if (Bit(G, 3)) Flags.push({ Label: 'Input disabled', Kind: 'warning' });
    if (Bit(G, 6)) Flags.push({ Label: 'Input test packets', Kind: 'muted' });
    if (Bit(G, 5)) Flags.push({ Label: 'Input SIPs', Kind: 'muted' });
    if (Bit(G, 4)) Flags.push({ Label: 'Input text packets', Kind: 'muted' });
    if (Bit(G, 0)) Flags.push({ Label: 'Input to sACN', Kind: 'muted' });
  }

  if (P.CanOutput) {
    const G = P.GoodOutputA;
    if (Bit(G, 7)) Flags.push({ Label: 'Output active', Kind: 'success' });
    if (Bit(G, 2)) {
      Flags.push({ Label: 'DMX output short', Kind: 'danger' });
      Faults.push({ Universe: P.OutputUniverse, Text: 'DMX output short' });
    }
    if (Bit(G, 3)) {
      Flags.push({ Label: Bit(G, 1) ? 'Merging (LTP)' : 'Merging (HTP)', Kind: 'muted' });
    }
    if (Bit(G, 6)) Flags.push({ Label: 'Output test packets', Kind: 'muted' });
    if (Bit(G, 5)) Flags.push({ Label: 'Output SIPs', Kind: 'muted' });
    if (Bit(G, 4)) Flags.push({ Label: 'Output text packets', Kind: 'muted' });
    if (Bit(G, 0)) Flags.push({ Label: 'Output from sACN', Kind: 'muted' });
    // GoodOutputB: only set bits are shown. Art-Net 3 nodes zero-fill this byte,
    // and its all-clear reading ("RDM on, delta, discovery running") would be
    // asserting things such a node never said.
    if (P.GoodOutputB != null) {
      const B = P.GoodOutputB;
      if (Bit(B, 7)) Flags.push({ Label: 'RDM disabled', Kind: 'muted' });
      if (Bit(B, 6)) Flags.push({ Label: 'Continuous output', Kind: 'muted' });
      if (Bit(B, 4)) Flags.push({ Label: 'Background discovery off', Kind: 'muted' });
    }
  }

  return {
    Index,
    BindIndex,
    Direction: P.CanInput && P.CanOutput ? 'Input/Output' : P.CanInput ? 'Input' : 'Output',
    Protocol: P.Protocol,
    InputUniverse: P.CanInput ? P.InputUniverse : null,
    OutputUniverse: P.CanOutput ? P.OutputUniverse : null,
    Flags,
    Faults,
  };
}

// --- Status registers --------------------------------------------------------

// The Status1/2/3 bits worth showing an operator. Capability bits ("supports
// RDMnet", "supports LLRP"…) are left out: they describe the product, not its
// state.
export function DecodeStatus(
  Status1: number,
  Status2: number | null,
  Status3: number | null
): PortFlag[] {
  const Flags: PortFlag[] = [];
  const Indicator = (Status1 >> 6) & 0x03;
  if (Indicator === 1) Flags.push({ Label: 'Locate / identify', Kind: 'warning' });
  else if (Indicator === 2) Flags.push({ Label: 'Indicators muted', Kind: 'muted' });
  else if (Indicator === 3) Flags.push({ Label: 'Indicators normal', Kind: 'muted' });
  const Authority = (Status1 >> 4) & 0x03;
  if (Authority === 1) Flags.push({ Label: 'Addressed from front panel', Kind: 'muted' });
  else if (Authority === 2) Flags.push({ Label: 'Addressed over network', Kind: 'muted' });
  if (Bit(Status1, 2)) Flags.push({ Label: 'Booted from ROM', Kind: 'warning' });
  if (Bit(Status1, 1)) Flags.push({ Label: 'RDM capable', Kind: 'muted' });

  if (Status2 != null) {
    if (Bit(Status2, 2)) {
      Flags.push({ Label: Bit(Status2, 1) ? 'DHCP address' : 'Static address', Kind: 'muted' });
    }
    if (Bit(Status2, 5)) Flags.push({ Label: 'Squawking', Kind: 'muted' });
    if (Bit(Status2, 0)) Flags.push({ Label: 'Web configuration', Kind: 'muted' });
  }

  // Failsafe is only shown when the node evidently populates Status3; a
  // zero-filled byte from an older node would otherwise read as "hold last".
  if (Status3 != null && Status3 !== 0) {
    const Failsafe = ['Hold last state', 'Outputs to zero', 'Outputs to full', 'Failsafe scene'][
      (Status3 >> 6) & 0x03
    ];
    if (Failsafe) Flags.push({ Label: `Failsafe: ${Failsafe}`, Kind: 'muted' });
  }
  return Flags;
}

// --- Snapshot ----------------------------------------------------------------

export interface NodeSnapshot {
  ShortName: string;
  LongName: string;
  ReportedIp: string;
  Report: ParsedNodeReport;
  // Every distinct report across the binds, root first (usually just one).
  Reports: ParsedNodeReport[];
  Firmware: string;
  Oem: string;
  EstaMan: string;
  Mac: string | null;
  Style: string | null;
  BindCount: number;
  StatusFlags: PortFlag[];
  Ports: NodePort[];
}

function Hex4(N: number): string {
  return `0x${N.toString(16).padStart(4, '0')}`;
}

// Merge the replies of one poll (any BindIndex order) into a single snapshot.
// Identity comes from the root (lowest BindIndex); ports are numbered 1..N in
// BindIndex order. Pure — exported via _internal.
export function BuildNodeSnapshot(Replies: ArtPollReply[]): NodeSnapshot | null {
  if (!Replies.length) return null;
  const Sorted = [...Replies].sort((A, B) => A.BindIndex - B.BindIndex);
  const Root = Sorted[0]!; // non-empty: checked above

  const Ports: NodePort[] = [];
  const Reports: ParsedNodeReport[] = [];
  for (const Reply of Sorted) {
    for (const P of Reply.Ports) Ports.push(DecodePort(P, Ports.length + 1, Reply.BindIndex));
    const Report = ParseNodeReport(Reply.NodeReport);
    const Seen = Reports.some((R) =>
      R.Code != null ? R.Code === Report.Code : R.Raw === Report.Raw
    );
    if (!Seen && Report.Raw) Reports.push(Report);
  }

  return {
    ShortName: Root.ShortName,
    LongName: Root.LongName,
    ReportedIp: Root.ReportedIp,
    Report: ParseNodeReport(Root.NodeReport),
    Reports,
    Firmware: `${Root.VersInfoH}.${Root.VersInfoL}`,
    Oem: Hex4(Root.Oem),
    EstaMan: Hex4(Root.EstaMan),
    Mac: Root.Mac,
    Style: Root.Style == null ? null : (STYLE_CODES[Root.Style] ?? `Style ${Root.Style}`),
    BindCount: Sorted.length,
    StatusFlags: DecodeStatus(Root.Status1, Root.Status2, Root.Status3),
    Ports,
  };
}

// --- Settings / evaluation ---------------------------------------------------

const Settings: MonitoringSettingField[] = [
  {
    Key: 'CheckPortErrors',
    Label: 'Check port errors',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded when a port reports a DMX output short or DMX input receive errors.',
  },
  {
    Key: 'CheckNodeReport',
    Label: 'Check node report',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded when the node report carries a fault code, such as a failed power-on test or a DMX short. Advisory codes never degrade.',
  },
  {
    Key: 'CheckName',
    Label: 'Check node name',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when neither the short nor the long name matches, e.g. a replacement node at the same IP.',
  },
  {
    Key: 'ExpectedName',
    Label: 'Expected name',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'CheckName', Equals: true },
    Note: 'Matches the short or the long name, ignoring case.',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: DEFAULT_TIMEOUT_MS,
    Min: MIN_TIMEOUT_MS,
    Max: MAX_TIMEOUT_MS,
    Advanced: true,
    Note: 'How long to wait for the ArtPollReply. Nodes may wait a random delay of up to 1 s before replying.',
  },
];

export interface NodeOptions {
  CheckPortErrors: boolean;
  CheckNodeReport: boolean;
  CheckName: boolean;
  ExpectedName: string;
  TimeoutMs: number;
}

export function ParseOptions(Target: MonitoringTargetLike): NodeOptions {
  const Cfg = (Target && Target.Settings) || {};
  const Timeout = Number(Cfg.Timeout);
  return {
    // Absent counts as on so the defaults hold for a check saved before a toggle.
    CheckPortErrors: Cfg.CheckPortErrors !== false,
    CheckNodeReport: Cfg.CheckNodeReport !== false,
    CheckName: Cfg.CheckName === true,
    ExpectedName: String(Cfg.ExpectedName == null ? '' : Cfg.ExpectedName).trim(),
    TimeoutMs: Number.isFinite(Timeout)
      ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Timeout | 0))
      : DEFAULT_TIMEOUT_MS,
  };
}

// Every reason a replying node is unhealthy, each gated by its toggle. Pure —
// exported via _internal.
export function EvaluateNode(Snapshot: NodeSnapshot, Options: NodeOptions): string[] {
  const Reasons: string[] = [];

  if (Options.CheckPortErrors) {
    for (const Port of Snapshot.Ports) {
      for (const Fault of Port.Faults) {
        Reasons.push(`Port ${Port.Index} (universe ${Fault.Universe}): ${Fault.Text}`);
      }
    }
  }

  if (Options.CheckNodeReport) {
    for (const Report of Snapshot.Reports) {
      if (!Report.Fault) continue;
      Reasons.push(
        `Node report: ${Report.Text || Report.Description || Report.Raw} (${Report.Mnemonic})`
      );
    }
  }

  if (Options.CheckName && Options.ExpectedName) {
    const Want = Options.ExpectedName.toLowerCase();
    const Names = [Snapshot.ShortName, Snapshot.LongName];
    if (!Names.some((N) => N.trim().toLowerCase() === Want)) {
      const Shown = Names.filter(Boolean)
        .map((N) => `"${N}"`)
        .join(' / ');
      Reasons.push(`Name ${Shown || '(none)'} (expected "${Options.ExpectedName}")`);
    }
  }

  return Reasons;
}

// --- Run / Debug -------------------------------------------------------------

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  if (!Address) return { Success: false, Error: 'No address configured' };
  // Replies are matched by source IP, so a hostname could never match one.
  if (!net.isIPv4(Address)) {
    return { Success: false, Error: `Art-Net needs the node's IPv4 address, not "${Address}"` };
  }

  const Options = ParseOptions(Target);
  const Outcome = await ArtnetReceiver.PollNode(Address, Options.TimeoutMs);
  if (!Outcome.Ok) return { Success: false, Error: Outcome.Error };

  const Snapshot = BuildNodeSnapshot(Outcome.Replies);
  if (!Snapshot) return { Success: false, Error: `No ArtPollReply from ${Address}` };

  const Reasons = EvaluateNode(Snapshot, Options);
  const Result: MonitoringResult = {
    Success: true,
    LatencyMs: Math.max(0, Outcome.FirstReplyAt - Outcome.SentAt),
    ...Snapshot,
  };
  if (Reasons.length) {
    Result.Degraded = true;
    Result.DegradedReason = Reasons.join('; ');
  }
  return Result;
}

function FlagPills(Flags: unknown): string {
  if (!Array.isArray(Flags) || !Flags.length) return '';
  return Flags.map((F: PortFlag) => Pill(F.Kind, F.Label)).join(' ');
}

function UniverseText(Port: NodePort): string {
  if (Port.InputUniverse != null && Port.OutputUniverse != null) {
    return Port.InputUniverse === Port.OutputUniverse
      ? `universe ${Port.OutputUniverse}`
      : `in ${Port.InputUniverse} / out ${Port.OutputUniverse}`;
  }
  return `universe ${Port.OutputUniverse ?? Port.InputUniverse ?? '—'}`;
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  const Reachable = !!(Result && Result.Success === true);
  const Degraded = !!(Result && Result.Degraded);
  const StatusPill =
    Reachable && !Degraded
      ? Pill('success', 'Healthy')
      : Reachable
        ? Pill('warning', (Result && Result.DegradedReason) || 'Degraded')
        : Pill('danger', 'Offline');

  if (!Reachable) {
    return (
      Rows([
        TextRow('Node IP', Address || '—'),
        Row('Status', StatusPill),
        TextRow('Error', (Result && Result.Error) || 'No ArtPollReply'),
      ]) +
      '<div class="mt-2">' +
      Note('The node did not answer an ArtPoll on UDP 6454') +
      '</div>'
    );
  }

  const Report = (Result.Report as ParsedNodeReport | undefined) || null;
  const ReportHtml = Report
    ? Esc(Report.Raw || '—') +
      (Report.Mnemonic ? ` ${Pill(Report.Fault ? 'danger' : 'muted', Report.Mnemonic)}` : '')
    : '—';
  const Status = FlagPills(Result.StatusFlags);
  const Head = Rows([
    TextRow('Node IP', Address || '—'),
    Row('Status', StatusPill),
    Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`),
    TextRow('Short name', Result.ShortName || '—'),
    TextRow('Long name', Result.LongName || '—'),
    Row('Node report', ReportHtml),
    Row('Firmware', `<span class="font-monospace">${Esc(Result.Firmware)}</span>`),
    Row(
      'OEM / ESTA',
      `<span class="font-monospace">${Esc(Result.Oem)} / ${Esc(Result.EstaMan)}</span>`
    ),
    Result.Mac ? Row('MAC', `<span class="font-monospace">${Esc(Result.Mac)}</span>`) : null,
    Result.Style ? TextRow('Style', Result.Style) : null,
    Number(Result.BindCount) > 1 ? TextRow('Binds', String(Result.BindCount)) : null,
    Status ? Row('Flags', Status) : null,
  ]);

  const Ports: NodePort[] = Array.isArray(Result.Ports) ? (Result.Ports as NodePort[]) : [];
  if (!Ports.length) {
    return Head + '<div class="mt-2">' + Note('The node reported no DMX ports') + '</div>';
  }

  const Cards = Ports.map((Port) => {
    const HasFault = Array.isArray(Port.Faults) && Port.Faults.length > 0;
    const Pills = FlagPills(Port.Flags);
    return Card({
      Title: `Port ${Port.Index} · ${Port.Direction} · ${UniverseText(Port)}`,
      Badge: HasFault ? Pill('danger', 'Fault') : Pill('muted', Port.Protocol),
      BodyHtml: Pills ? `<div class="d-flex flex-wrap gap-1 mt-1">${Pills}</div>` : '',
    });
  }).join('');

  return (
    Head +
    `<div class="text-muted small mt-2 mb-1">Ports (${Ports.length})</div>` +
    `<div class="d-grid gap-1">${Cards}</div>`
  );
}

export const Name = 'Art-Net - Node health';
export const Description =
  'Polls an Art-Net node with ArtPoll and reads its ArtPollReply: names, node report, firmware and the status of every DMX port.';
export const DefaultInterval = DEFAULT_INTERVAL_MS;
// Art-Net 4 nodes delay their reply by a random 0–1 s, so poll→reply time is
// not a meaningful latency to threshold.
export const SupportsLatencyThreshold = false;
export { ID, Settings, Run, Debug };

// Exported for unit tests.
export const _internal = {
  ParseNodeReport,
  DecodeStatus,
  BuildNodeSnapshot,
  EvaluateNode,
  ParseOptions,
  NODE_REPORT_CODES,
  BuildArtPoll,
  ParseArtPollReply,
  ArtnetReceiver,
};
