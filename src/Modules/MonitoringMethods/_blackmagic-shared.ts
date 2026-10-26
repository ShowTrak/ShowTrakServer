// Shared parsing for Blackmagic Design's text control protocols.
//
// HyperDeck (TCP 9993) and Videohub (TCP 9990) both speak a line-oriented text
// protocol built from the same "block" shape:
//
//   HEADER:            <- a header line ending in a colon
//   Key: Value         <- zero or more body lines
//   Key: Value
//                      <- terminated by a blank line
//
// The two differ in what a header looks like (HyperDeck prefixes a three-digit
// response code, `208 transport info:`; Videohub uses an all-caps name,
// `VIDEO OUTPUT ROUTING:`) and in their body lines (HyperDeck and the Videohub
// device / alarm blocks are `Key: Value`; Videohub's label / routing / lock
// blocks are `<index> <value>`). What they share (the framing, the CR LF
// handling and the `Key: Value` reading) lives here.
//
// HyperDeck also sends single-line replies with NO blank-line terminator
// (`200 ok`, `102 invalid value`, `120 connection failed`): a header that does
// not end in a colon is a complete message on its own. Videohub's `ACK` / `NAK`
// look similar but ARE followed by a blank line, so the framer takes a flag.
import { Esc, Pill, Row } from './debug';
import type { MonitoringResult, MonitoringSettingField } from './types';

// The devices send CR LF; clients may send either. Dropping every CR as it is
// received (rather than rewriting CR LF pairs) is immune to a CR and its LF
// landing in different TCP chunks, and no protocol value contains a bare CR.
export function StripCarriageReturns(Text: string): string {
  return Text.replace(/\r/g, '');
}

export interface BmdBlock {
  /** The header line, trimmed, colon included (`VIDEOHUB DEVICE:`, `204 device info:`). */
  Header: string;
  /** Body lines, trimmed, without the terminating blank line. */
  Lines: string[];
}

export interface TakenBlock {
  Block: BmdBlock;
  /** Characters consumed from the front of the buffer, terminator included. */
  Consumed: number;
}

/**
 * Take one complete block from the front of Buffered (CRs already stripped),
 * or null while it is still arriving. Leading blank lines are skipped.
 *
 * With SingleLineWithoutColon, a header that does not end in a colon is a
 * complete message by itself (HyperDeck's `200 ok`). Without it, every block
 * runs to a blank line (Videohub, where even `ACK` is blank-terminated).
 */
export function TakeBlock(Buffered: string, SingleLineWithoutColon: boolean): TakenBlock | null {
  let Start = 0;
  while (Buffered[Start] === '\n') Start++;
  const HeaderEnd = Buffered.indexOf('\n', Start);
  if (HeaderEnd === -1) return null;
  const Header = Buffered.slice(Start, HeaderEnd).trim();

  if (SingleLineWithoutColon && !Header.endsWith(':')) {
    return { Block: { Header, Lines: [] }, Consumed: HeaderEnd + 1 };
  }

  // A blank line ends the block. The header's own newline may be immediately
  // followed by it (an empty block such as `END PRELUDE:`).
  const Terminator = Buffered.indexOf('\n\n', HeaderEnd);
  if (Terminator === -1) return null;
  const Body = Buffered.slice(HeaderEnd + 1, Terminator);
  const Lines = Body.length ? Body.split('\n').map((Line) => Line.trim()) : [];
  return { Block: { Header, Lines }, Consumed: Terminator + 2 };
}

/** Every complete block in Buffered, plus the unconsumed remainder. */
export function SplitBlocks(
  Buffered: string,
  SingleLineWithoutColon: boolean
): { Blocks: BmdBlock[]; Rest: string } {
  const Blocks: BmdBlock[] = [];
  let Rest = Buffered;
  for (;;) {
    const Taken = TakeBlock(Rest, SingleLineWithoutColon);
    if (!Taken) break;
    Blocks.push(Taken.Block);
    Rest = Rest.slice(Taken.Consumed);
  }
  return { Blocks, Rest };
}

/**
 * Read `Key: Value` body lines into a map keyed by the LOWER-CASED key. Split
 * on the first colon only, so values that contain colons (timecodes) survive.
 * Lines without a colon are ignored; both protocols tell clients to skip lines
 * they do not recognise. Case is folded because Videohub capitalises its keys
 * inconsistently across firmware (`Unique ID` vs `Unique id`).
 */
export function ParseFields(Lines: string[]): Record<string, string> {
  const Out: Record<string, string> = {};
  for (const Line of Lines) {
    const Colon = Line.indexOf(':');
    if (Colon <= 0) continue;
    const Key = Line.slice(0, Colon).trim().toLowerCase();
    if (!Key) continue;
    Out[Key] = Line.slice(Colon + 1).trim();
  }
  return Out;
}

/** A finite integer from a protocol value, or null (`none`, blank, junk). */
export function ParseIntOrNull(Value: string | undefined): number | null {
  if (Value == null) return null;
  const Trimmed = Value.trim();
  if (!/^-?\d+$/.test(Trimmed)) return null;
  const N = Number(Trimmed);
  return Number.isSafeInteger(N) ? N : null;
}

/** `true` / `false` from a protocol value, or null when absent / unrecognised. */
export function ParseBoolOrNull(Value: string | undefined): boolean | null {
  if (Value == null) return null;
  const Lower = Value.trim().toLowerCase();
  if (Lower === 'true') return true;
  if (Lower === 'false') return false;
  return null;
}

/** A protocol string value, with HyperDeck's literal `none` and blanks as null. */
export function StringOrNull(Value: string | undefined): string | null {
  if (Value == null) return null;
  const Trimmed = Value.trim();
  return Trimmed && Trimmed.toLowerCase() !== 'none' ? Trimmed : null;
}

/** A refused / reset connection: the host answered but nothing is listening. */
export function IsRefusal(Message: string): boolean {
  return Message.includes('ECONNREFUSED') || Message.includes('ECONNRESET');
}

export function TimeoutSetting(): MonitoringSettingField {
  return {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: 4000,
    Min: 500,
    Max: 30000,
    Advanced: true,
    Note: 'Budget for the whole probe: connect, read the status and disconnect.',
  };
}

/** Clamp a stored Timeout to the schema range, defaulting when unset. */
export function ResolveTimeoutMs(Value: unknown): number {
  const N = Number(Value);
  if (!Number.isFinite(N) || N <= 0) return 4000;
  return Math.max(500, Math.min(30000, N | 0));
}

/** Snapshot cache TTL: long enough to share one session between sibling checks in a tick. */
export function ResolveSnapshotTtlMs(TimeoutMs: number): number {
  return Math.max(300, Math.min(1500, (TimeoutMs / 2) | 0));
}

export function BmdStatePill(Result: MonitoringResult, HealthyText: string): string {
  const Reachable = !!(Result && Result.Success === true);
  if (Reachable && !Result.Degraded) return Pill('success', HealthyText);
  if (Reachable) return Pill('warning', 'Degraded');
  return Pill('danger', 'Offline');
}

export function MonoRow(Label: string, Value: unknown): string {
  return Row(Label, `<span class="font-monospace">${Esc(String(Value))}</span>`);
}

export const _internal = {
  StripCarriageReturns,
  TakeBlock,
  SplitBlocks,
  ParseFields,
  ParseIntOrNull,
  ParseBoolOrNull,
  StringOrNull,
  ResolveTimeoutMs,
};
