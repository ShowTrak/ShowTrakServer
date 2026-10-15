// Hidden log console: a live feed of the server's log, opened by typing the
// Konami code anywhere outside a text field. Deliberately undocumented — it is
// a production debugging aid, so it appears in no menu, shortcut list or help.
//
// The server streams lines only while this modal is open, already filtered to
// the chosen minimum level, so a closed console costs no IPC or Web UI traffic.
import type { LogConsoleEntry, LogConsoleSnapshot } from '@showtrak/protocol';
import { closeModal, openModal } from './lib/modal';
import { buildModalHeader } from './lib/modal-header';
import { EntryChars, MAX_CHARS, MAX_LINES, NewestWithinBudget } from './lib/log-console-budget';
import { CloseAllModals } from './modals';
import { HandleNonFatalError } from './utils';

const KONAMI = [
  'arrowup',
  'arrowup',
  'arrowdown',
  'arrowdown',
  'arrowleft',
  'arrowright',
  'arrowleft',
  'arrowright',
  'b',
  'a',
];

const LEVEL_RANK: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const DEFAULT_LEVEL = 'info';
const LEVEL_STORAGE_KEY = 'ShowTrak:LogConsoleLevel';
// How close to the bottom still counts as "following" the feed.
const FOLLOW_THRESHOLD_PX = 24;

let KonamiProgress = 0;
let IsOpen = false;
let Level = ReadStoredLevel();
// The highest Seq on screen; live lines at or below it are already shown.
let LastSeq = 0;
// While an open/re-level request is in flight, live lines are held back so the
// backlog that answers it can be drawn first.
let Loading = false;
let Held: LogConsoleEntry[] = [];
// The cost of each line on screen, oldest first, in step with the terminal's
// children (the notice placeholder is never counted).
let ShownChars: number[] = [];
let ShownTotal = 0;
// Discards an answer that a later open/re-level/close has overtaken.
let LoadToken = 0;

function ReadStoredLevel(): string {
  try {
    const Stored = localStorage.getItem(LEVEL_STORAGE_KEY);
    if (Stored && Object.prototype.hasOwnProperty.call(LEVEL_RANK, Stored)) return Stored;
  } catch {
    /* intentional: storage unavailable, use the default */
  }
  return DEFAULT_LEVEL;
}

function StoreLevel(Value: string): void {
  try {
    localStorage.setItem(LEVEL_STORAGE_KEY, Value);
  } catch {
    /* intentional: the choice just isn't remembered */
  }
}

function IsEditableTarget(Target: EventTarget | null): boolean {
  return (
    Target instanceof HTMLElement &&
    (Target.isContentEditable ||
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(Target.tagName) ||
      Boolean(Target.closest('[contenteditable=""], [contenteditable="true"]')))
  );
}

function OnKeyDown(e: KeyboardEvent): void {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  if (IsEditableTarget(e.target)) {
    KonamiProgress = 0;
    return;
  }
  const Key = String(e.key || '').toLowerCase();
  if (Key === KONAMI[KonamiProgress]) {
    KonamiProgress++;
    if (KonamiProgress === KONAMI.length) {
      KonamiProgress = 0;
      void OpenLogConsoleModal();
    }
    return;
  }
  // A third Up keeps the two before it: "Up Up Up Down…" is still a match.
  KonamiProgress = Key === 'arrowup' ? (KonamiProgress === 2 ? 2 : 1) : 0;
}

async function OpenLogConsoleModal(): Promise<void> {
  if (IsOpen) return;
  await CloseAllModals();
  openModal('LOG_CONSOLE_MODAL');
}

function Terminal(): HTMLElement | null {
  return document.getElementById('LOG_CONSOLE_TERMINAL');
}

// Empty the terminal and forget what it held. Every path that wipes the
// terminal goes through here so the budget never counts lines that are gone.
function ClearLines(Term: HTMLElement, ...Nodes: Node[]): void {
  Term.replaceChildren(...Nodes);
  ShownChars = [];
  ShownTotal = 0;
}

function ShowNotice(Text: string): void {
  const Term = Terminal();
  if (!Term) return;
  const Notice = document.createElement('div');
  Notice.className = 'osc-http-debug-empty';
  Notice.textContent = Text;
  ClearLines(Term, Notice);
}

function FormatTime(Time: number): string {
  const D = new Date(Number(Time) || Date.now());
  const P = (V: number, L = 2) => String(V).padStart(L, '0');
  return `${P(D.getHours())}:${P(D.getMinutes())}:${P(D.getSeconds())}.${P(D.getMilliseconds(), 3)}`;
}

function BuildLine(Entry: LogConsoleEntry): HTMLElement {
  const Line = document.createElement('div');
  Line.className = `log-console-line is-${String(Entry.Type || 'Info').toLowerCase()}`;
  const Cell = (ClassName: string, Text: string) => {
    const Span = document.createElement('span');
    Span.className = ClassName;
    Span.textContent = Text;
    Line.appendChild(Span);
  };
  Cell('log-console-time', FormatTime(Entry.Time));
  Cell('log-console-type', String(Entry.Type || 'Info').toUpperCase());
  Cell('log-console-alias', String(Entry.Alias || ''));
  Cell('log-console-message', String(Entry.Message ?? ''));
  return Line;
}

function AppendEntries(Entries: LogConsoleEntry[]): void {
  const Term = Terminal();
  if (!Term || !Array.isArray(Entries)) return;
  const Want = LEVEL_RANK[Level] ?? LEVEL_RANK[DEFAULT_LEVEL]!;
  const Fresh = Entries.filter(
    (Entry) =>
      Entry &&
      Entry.Seq > LastSeq &&
      (LEVEL_RANK[Entry.Level] ?? LEVEL_RANK[DEFAULT_LEVEL]!) <= Want
  );
  if (!Fresh.length) return;
  LastSeq = Fresh[Fresh.length - 1]!.Seq;

  const Following = Term.scrollHeight - Term.scrollTop - Term.clientHeight <= FOLLOW_THRESHOLD_PX;
  if (Term.querySelector('.osc-http-debug-empty')) ClearLines(Term);

  // Build only what can stay: a large backlog never creates nodes just to
  // delete them again.
  const Fragment = document.createDocumentFragment();
  for (const Entry of NewestWithinBudget(Fresh)) {
    Fragment.appendChild(BuildLine(Entry));
    const Chars = EntryChars(Entry);
    ShownChars.push(Chars);
    ShownTotal += Chars;
  }
  Term.appendChild(Fragment);
  while (
    Term.firstElementChild &&
    ShownChars.length > 1 &&
    (ShownChars.length > MAX_LINES || ShownTotal > MAX_CHARS)
  ) {
    Term.firstElementChild.remove();
    ShownTotal -= ShownChars.shift()!;
  }

  if (Following) Term.scrollTop = Term.scrollHeight;
}

// Ask the server to stream at the current level and redraw from its backlog.
// Also used to re-level, which replaces the server-side filter in place.
async function Load(): Promise<void> {
  const Token = ++LoadToken;
  Loading = true;
  Held = [];
  let Snapshot: LogConsoleSnapshot | null = null;
  try {
    Snapshot = await window.API.OpenLogConsole(Level);
  } catch (Err) {
    HandleNonFatalError('LogConsole:Open', Err);
  }
  if (Token !== LoadToken || !IsOpen) return;
  Loading = false;
  LastSeq = 0;
  if (!Snapshot) {
    Held = [];
    ShowNotice('The log feed is unavailable.');
    return;
  }
  ShowNotice('Waiting for log lines…');
  AppendEntries(Snapshot.Entries);
  AppendEntries(Held);
  Held = [];
}

// Called by the bootstrap orchestrator in main.ts — never at import time.
export function InitLogConsole() {
  // Capture phase, and never preventDefault: the arrows and B/A keep doing
  // whatever they normally do, so typing the code has no visible side effect.
  document.addEventListener('keydown', OnKeyDown, true);

  $('#LOG_CONSOLE_HEADER')
    .empty()
    .append(
      buildModalHeader({
        title: 'Console',
        titleId: 'LOG_CONSOLE_MODAL_Label',
        onClose: () => closeModal('LOG_CONSOLE_MODAL'),
      }).$el
    );

  $('#LOG_CONSOLE_LEVEL')
    .val(Level)
    .off('change.logconsole')
    .on('change.logconsole', function () {
      const Next = String($(this).val() || DEFAULT_LEVEL);
      if (!Object.prototype.hasOwnProperty.call(LEVEL_RANK, Next) || Next === Level) return;
      Level = Next;
      StoreLevel(Level);
      if (IsOpen) void Load();
    });

  // Clears the screen only; LastSeq stays put so cleared lines do not return.
  $('#LOG_CONSOLE_CLEAR')
    .off('click.logconsole')
    .on('click.logconsole', () => ShowNotice('Waiting for log lines…'));

  $('#LOG_CONSOLE_MODAL')
    .off('show.bs.modal.logconsole hidden.bs.modal.logconsole')
    .on('show.bs.modal.logconsole', () => {
      IsOpen = true;
      $('#LOG_CONSOLE_LEVEL').val(Level);
      ShowNotice('Connecting…');
      void Load();
    })
    .on('hidden.bs.modal.logconsole', () => {
      IsOpen = false;
      Loading = false;
      Held = [];
      LoadToken++;
      LastSeq = 0;
      const Term = Terminal();
      if (Term) ClearLines(Term);
      window.API.CloseLogConsole().catch((Err: unknown) =>
        HandleNonFatalError('LogConsole:Close', Err)
      );
    });

  window.API.OnLogConsoleEntries((Entries) => {
    if (!IsOpen) return;
    if (Loading) {
      // Bounded like the screen: if the answer never comes, this must not
      // grow for as long as the console stays open.
      if (Array.isArray(Entries)) Held = NewestWithinBudget(Held.concat(Entries));
      return;
    }
    AppendEntries(Entries);
  });
}
