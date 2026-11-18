// An execution's console history: lifecycle stages, the client's streamed
// output, and how it ended. Backs the execution panel's console view.
//
// Every entry gets an increasing Seq, so a viewer polls with the last Seq it has
// and receives only what is new. The log is capped (MAX_LOG_CHARS): the oldest
// entries are dropped first and `Trimmed` is set, so a chatty script can never
// grow the server's memory without bound however long it runs.
//
// Older clients cannot stream output; they report only the latest output line
// in their progress updates. Those lines are kept as `tail` entries, but only
// until real output arrives, which they would otherwise duplicate.
//
// Pure: no I/O, no timers. The caller passes the time in.

import type { ExecutionLogEntry } from '@showtrak/protocol';

/** Upper bound on the text one execution's log holds (characters). */
export const MAX_LOG_CHARS = 128 * 1024;
/** A single chunk is cut to this before it is stored. */
export const MAX_CHUNK_CHARS = 32 * 1024;

export class ExecutionLog {
  private Entries: ExecutionLogEntry[] = [];
  private NextSeq = 1;
  private Chars = 0;
  private LastStage = '';
  private LastTail = '';
  Trimmed = false;
  HasStreamOutput = false;
  ClientTruncated = false;

  private Push(Entry: Omit<ExecutionLogEntry, 'Seq'>): void {
    const Text =
      Entry.Text.length > MAX_CHUNK_CHARS ? Entry.Text.slice(0, MAX_CHUNK_CHARS) : Entry.Text;
    this.Entries.push({ ...Entry, Text, Seq: this.NextSeq++ });
    this.Chars += Text.length;
    while (this.Chars > MAX_LOG_CHARS && this.Entries.length > 1) {
      const Dropped = this.Entries.shift();
      if (Dropped) this.Chars -= Dropped.Text.length;
      this.Trimmed = true;
    }
  }

  /** A lifecycle step. Repeats of the step just recorded are ignored. */
  Stage(Text: string, Time: number): void {
    const Value = String(Text || '').trim();
    if (!Value || Value === this.LastStage) return;
    this.LastStage = Value;
    this.Push({ Time, Kind: 'stage', Text: Value });
  }

  /** The latest output line from a progress update (older clients' only output). */
  Tail(Text: string, Time: number): void {
    if (this.HasStreamOutput) return;
    const Value = String(Text || '').trim();
    if (!Value || Value === this.LastTail) return;
    this.LastTail = Value;
    this.Push({ Time, Kind: 'tail', Text: Value });
  }

  /** Console output streamed by the client. */
  Output(Stream: 'stdout' | 'stderr', Text: string, Time: number): void {
    if (!Text) return;
    if (!this.HasStreamOutput) {
      // The client's progress line can reach us before its first output batch
      // and would then show twice. Real output supersedes those samples.
      const Kept = this.Entries.filter((Entry) => Entry.Kind !== 'tail');
      if (Kept.length !== this.Entries.length) {
        this.Entries = Kept;
        this.Chars = Kept.reduce((N, Entry) => N + Entry.Text.length, 0);
      }
    }
    this.HasStreamOutput = true;
    this.Push({ Time, Kind: Stream, Text });
  }

  /** How the execution ended. */
  Result(Error: string | null, Time: number): void {
    if (Error) this.Push({ Time, Kind: 'result', Text: Error, Error: true });
    else this.Push({ Time, Kind: 'result', Text: 'Completed' });
  }

  /** The entries after AfterSeq, and the Seq to ask from next time. */
  Since(AfterSeq: number): { Entries: ExecutionLogEntry[]; LastSeq: number } {
    const After = Number.isFinite(AfterSeq) ? AfterSeq : 0;
    return {
      Entries: this.Entries.filter((Entry) => Entry.Seq > After),
      LastSeq: this.NextSeq - 1,
    };
  }
}
