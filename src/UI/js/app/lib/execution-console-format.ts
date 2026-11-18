// Pure formatting rules for the execution console view.
//
// The view turns an execution's log entries (ExecutionLogEntry, recorded by the
// server) into console lines. Kept free of the DOM so the rules can be tested:
// what each kind of entry looks like, and which notes explain gaps in the
// history (trimmed output, a client too old to stream its console).

import type { ExecutionLogEntry, ExecutionOutputView } from '@showtrak/protocol';

/** How one entry is shown: its text, a style, and whether it is its own line. */
export interface ConsoleSegment {
  Text: string;
  Style: 'stage' | 'stdout' | 'stderr' | 'tail' | 'ok' | 'error';
  /** Stages, tails and results always start on a fresh line; output does not. */
  OwnLine: boolean;
}

/** hh:mm:ss in local time. */
export function FormatConsoleTime(Time: number): string {
  const D = new Date(Time);
  const Pad = (N: number) => String(N).padStart(2, '0');
  return `${Pad(D.getHours())}:${Pad(D.getMinutes())}:${Pad(D.getSeconds())}`;
}

export function FormatConsoleEntry(Entry: ExecutionLogEntry): ConsoleSegment {
  const At = FormatConsoleTime(Entry.Time);
  switch (Entry.Kind) {
    case 'stdout':
    case 'stderr':
      return { Text: Entry.Text, Style: Entry.Kind, OwnLine: false };
    case 'tail':
      return { Text: Entry.Text, Style: 'tail', OwnLine: true };
    case 'result':
      return Entry.Error
        ? { Text: `[${At}] Failed: ${Entry.Text}`, Style: 'error', OwnLine: true }
        : { Text: `[${At}] Completed`, Style: 'ok', OwnLine: true };
    case 'stage':
    default:
      return { Text: `[${At}] ${Entry.Text}`, Style: 'stage', OwnLine: true };
  }
}

/**
 * Notes shown above the console to explain what it cannot show. `Internal` is
 * true for server-side actions (Wake on LAN, deployments ...), which have no
 * console of their own, so the "older client" note never applies to them.
 */
export function GetConsoleNotes(
  View: Pick<ExecutionOutputView, 'Trimmed' | 'HasStreamOutput' | 'ClientTruncated'>,
  Context: { Internal: boolean; SawTail: boolean }
): string[] {
  const Notes: string[] = [];
  if (View.Trimmed) Notes.push('Earlier output was trimmed to keep the history small.');
  if (View.ClientTruncated)
    Notes.push('The client stopped sending output after reaching its limit for one run.');
  if (!Context.Internal && !View.HasStreamOutput && Context.SawTail)
    Notes.push(
      'This client only reports its latest output line. Update ShowTrak Client to see the full console.'
    );
  return Notes;
}
