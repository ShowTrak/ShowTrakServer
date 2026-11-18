// The execution panel's console view: one execution's history and, while it
// runs, its live output.
//
// Opened from the console icon on an execution row. It replaces the list
// inside the panel (a drill-in, not a second modal), so clicks in it are inside
// the panel and Escape / Back return to the list. While open it polls the
// server for entries after the last one it has; nothing is pushed for
// executions nobody is looking at. Output is always inserted as text nodes,
// never as HTML: it is whatever a script printed.

import type { ScriptExecutionView } from '@showtrak/protocol';
import { FormatConsoleEntry, GetConsoleNotes } from './lib/execution-console-format';
import { HandleNonFatalError } from './utils';

const POLL_MS = 500;
// Keep the view itself bounded too; the server already caps each history.
const MAX_RENDERED_CHARS = 512 * 1024;

interface ConsoleState {
  RequestID: string;
  Internal: boolean;
  LastSeq: number;
  SawTail: boolean;
  Timer: ReturnType<typeof setTimeout> | null;
  Settled: boolean;
  Root: HTMLElement;
  Output: HTMLElement;
  Notes: HTMLElement;
  Status: HTMLElement;
  RenderedChars: number;
  EndsWithNewline: boolean;
  OnClose: (() => void) | null;
}

let Current: ConsoleState | null = null;

export function IsExecutionConsoleOpen(): boolean {
  return !!Current && document.body.contains(Current.Root);
}

/** Close the console view (back to the list). Returns whether one was open. */
export function CloseExecutionConsole(): boolean {
  const State = Current;
  if (!State) return false;
  Current = null;
  if (State.Timer) clearTimeout(State.Timer);
  State.Root.remove();
  const Toast = document.getElementById('EXECUTION_TOAST');
  if (Toast) Toast.classList.remove('console-open');
  if (State.OnClose) {
    try {
      State.OnClose();
    } catch (e) {
      HandleNonFatalError('ExecutionConsole:OnClose', e);
    }
  }
  return true;
}

function SetStatus(State: ConsoleState, Status: string) {
  const Label = Status === 'Pending' ? 'Running' : Status;
  if (State.Status.textContent !== Label) State.Status.textContent = Label;
  State.Status.dataset.status = Status;
}

function Append(State: ConsoleState, Text: string, Style: string, OwnLine: boolean) {
  if (!Text) return;
  const Out = State.Output;
  const NearBottom = Out.scrollHeight - Out.scrollTop - Out.clientHeight < 24;
  let Value = Text;
  if (OwnLine) {
    if (!State.EndsWithNewline && State.RenderedChars > 0) Value = `\n${Value}`;
    if (!Value.endsWith('\n')) Value += '\n';
  }
  const Span = document.createElement('span');
  Span.className = `exec-console-${Style}`;
  Span.textContent = Value;
  Out.appendChild(Span);
  State.RenderedChars += Value.length;
  State.EndsWithNewline = Value.endsWith('\n');
  // Drop the oldest spans once the view grows past its own cap.
  while (State.RenderedChars > MAX_RENDERED_CHARS && Out.firstChild) {
    State.RenderedChars -= (Out.firstChild.textContent || '').length;
    Out.removeChild(Out.firstChild);
  }
  if (NearBottom) Out.scrollTop = Out.scrollHeight;
}

async function Poll(State: ConsoleState) {
  if (Current !== State || !document.body.contains(State.Root)) return;
  let Again = true;
  try {
    const [Err, View] = await window.API.GetScriptExecutionOutput(State.RequestID, State.LastSeq);
    if (Current !== State) return;
    if (Err || !View) {
      Append(State, String(Err || 'This execution is no longer available.'), 'error', true);
      SetStatus(State, 'Unavailable');
      return;
    }
    for (const Entry of View.Entries) {
      if (Entry.Kind === 'tail') State.SawTail = true;
      const Segment = FormatConsoleEntry(Entry);
      Append(State, Segment.Text, Segment.Style, Segment.OwnLine);
    }
    State.LastSeq = Math.max(State.LastSeq, View.LastSeq);
    SetStatus(State, View.Status);
    const Notes = GetConsoleNotes(View, { Internal: State.Internal, SawTail: State.SawTail });
    const NotesText = Notes.join(' ');
    if (State.Notes.textContent !== NotesText) State.Notes.textContent = NotesText;
    State.Notes.hidden = !NotesText;
    if (!State.RenderedChars) Append(State, 'Waiting for output...', 'stage', true);
    // A settled run has nothing more to say: one last read, then stop.
    if (View.Status !== 'Pending') {
      Again = !State.Settled;
      State.Settled = true;
    }
  } catch (e) {
    HandleNonFatalError('ExecutionConsole:Poll', e);
  }
  if (Again && Current === State) State.Timer = setTimeout(() => void Poll(State), POLL_MS);
}

/**
 * Open the console for an execution inside the execution panel. `OnClose` runs
 * when the view closes (Back, Escape, or the panel closing).
 */
export function OpenExecutionConsole(
  Execution: Pick<ScriptExecutionView, 'RequestID' | 'Internal' | 'Client' | 'Script'>,
  OnClose: (() => void) | null = null
): void {
  const Toast = document.getElementById('EXECUTION_TOAST');
  if (!Toast) return;
  CloseExecutionConsole();

  const Root = document.createElement('div');
  Root.id = 'EXECUTION_CONSOLE';
  Root.className = 'exec-console';
  Root.innerHTML = `
    <div class="exec-console-bar">
      <button type="button" class="btn btn-sm exec-console-back"><i class="bi bi-arrow-left" aria-hidden="true"></i> All executions</button>
      <span class="exec-console-title"></span>
      <span class="badge exec-console-status" data-status="Pending">Loading</span>
      <button type="button" class="exec-btn-icon exec-console-copy" title="Copy output" aria-label="Copy output"><i class="bi bi-clipboard"></i></button>
    </div>
    <div class="exec-console-notes" hidden></div>
    <pre class="exec-console-output" tabindex="0" aria-label="Console output"></pre>`;
  const Client = Execution.Client || ({} as ScriptExecutionView['Client']);
  const Who = Client.Nickname || Client.Hostname || Client.UUID || 'Unknown client';
  const What = Execution.Script && Execution.Script.Name ? Execution.Script.Name : '';
  const Title = Root.querySelector<HTMLElement>('.exec-console-title');
  if (Title) {
    Title.textContent = What ? `${Who} · ${What}` : String(Who);
    Title.title = Title.textContent;
  }
  const Header = Toast.querySelector('.exec-toast-header');
  if (Header && Header.nextSibling) Toast.insertBefore(Root, Header.nextSibling);
  else Toast.appendChild(Root);
  Toast.classList.add('console-open');

  const State: ConsoleState = {
    RequestID: String(Execution.RequestID),
    Internal: !!Execution.Internal,
    LastSeq: 0,
    SawTail: false,
    Timer: null,
    Settled: false,
    Root,
    Output: Root.querySelector<HTMLElement>('.exec-console-output')!,
    Notes: Root.querySelector<HTMLElement>('.exec-console-notes')!,
    Status: Root.querySelector<HTMLElement>('.exec-console-status')!,
    RenderedChars: 0,
    EndsWithNewline: true,
    OnClose,
  };
  Current = State;

  Root.querySelector('.exec-console-back')?.addEventListener('click', () => {
    CloseExecutionConsole();
  });
  Root.querySelector('.exec-console-copy')?.addEventListener('click', () => {
    const Text = State.Output.textContent || '';
    navigator.clipboard?.writeText(Text).catch((e: unknown) => {
      HandleNonFatalError('ExecutionConsole:Copy', e);
    });
  });
  void Poll(State);
  State.Output.focus({ preventScroll: true });
}
