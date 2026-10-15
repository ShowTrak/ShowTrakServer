// How much the hidden log console holds, on screen or waiting to be drawn:
// whichever limit is hit first. Lines can be up to 20,000 characters (the
// server's cap), so a line count alone could still hold tens of megabytes; the
// character budget bounds the worst case at a few MB however long the console is
// left open.
import type { LogConsoleEntry } from '@showtrak/protocol';

export const MAX_LINES = 2000;
export const MAX_CHARS = 2_000_000;
// Rough cost of a line's time, type and alias columns, on top of its message.
const LINE_OVERHEAD_CHARS = 40;

/** What one line counts against the character budget. */
export function EntryChars(Entry: LogConsoleEntry): number {
  return String(Entry.Message ?? '').length + LINE_OVERHEAD_CHARS;
}

/** The newest entries that fit the line and character budget, oldest first. */
export function NewestWithinBudget(Entries: LogConsoleEntry[]): LogConsoleEntry[] {
  let Chars = 0;
  let Start = Entries.length;
  while (Start > 0 && Entries.length - Start < MAX_LINES) {
    const Next = Chars + EntryChars(Entries[Start - 1]!);
    // Always keep the newest line, however long.
    if (Next > MAX_CHARS && Start < Entries.length) break;
    Chars = Next;
    Start--;
  }
  return Start === 0 ? Entries : Entries.slice(Start);
}
