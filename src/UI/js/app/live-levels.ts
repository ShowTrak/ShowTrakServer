// Live levels in a monitor's view: input meters for each check that has them
// turned on (e.g. TASCAM MX-8A "Show live input levels").
//
// The server only streams while a view has asked for them, and a stream can hold
// a device's only control connection, so the stream is opened when a monitor's
// view opens and closed the moment it closes. The Status tab is redrawn on every
// monitor push; each check's slot is redrawn from the last snapshot, and the bars
// are then updated in place as frames arrive.
import type { MonitorLiveLevelsCheck, MonitorLiveLevelsSnapshot } from '@showtrak/protocol';
import {
  FaderToSlider,
  FormatFader,
  FormatLevel,
  LevelPercent,
  SliderToFader,
  LevelZoneOf,
  LiveLevelsCardHtml,
  LiveLevelsSignature,
  NextPeak,
  type PeakState,
} from './lib/live-levels';
import { HandleNonFatalError } from './utils';
import { Notify } from './selection-init';

// While dragging a fader, sends go out at most this often; the final value goes
// out on release. After a move, the unit's echo is ignored for a moment so the
// slider does not jump back to a value from before it.
const SEND_INTERVAL_MS = 100;
const HOLD_AFTER_MOVE_MS = 1500;

let WatchedTarget: number | null = null;
let Checks = new Map<number, MonitorLiveLevelsCheck>();
const Peaks = new Map<string, PeakState>();
let Unsubscribe: (() => void) | null = null;
// `<CheckID>:<ChannelID>` → until when the slider is the operator's, not the unit's.
const HeldUntil = new Map<string, number>();
const Dragging = new Set<string>();
const SendTimers = new Map<string, ReturnType<typeof setTimeout>>();
const LastSentAt = new Map<string, number>();

/** The slot under a check's timeline, filled from the last snapshot. */
export function LiveLevelsSlotHtml(CheckID: number): string {
  const Check = Checks.get(Number(CheckID));
  return `<div class="monitor-live-levels-slot" data-check-id="${Number(CheckID)}">${
    Check ? LiveLevelsCardHtml(Check) : ''
  }</div>`;
}

/** Fill the freshly drawn slots with the current levels. */
export function ApplyLiveLevels(): void {
  const Now = performance.now();
  $('.monitor-live-levels-slot').each(function () {
    const Slot = this as HTMLElement;
    const Check = Checks.get(Number(Slot.dataset.checkId));
    if (!Check) {
      if (Slot.childElementCount) Slot.innerHTML = '';
      return;
    }
    const Signature = LiveLevelsSignature(Check);
    if (Slot.dataset.signature !== Signature || !Slot.childElementCount) {
      Slot.innerHTML = LiveLevelsCardHtml(Check);
      Slot.dataset.signature = Signature;
    }
    Check.Channels.forEach((Channel, Index) => {
      const Row = Slot.querySelector<HTMLElement>(`.live-levels-row[data-index="${Index}"]`);
      if (!Row) return;
      const PeakKey = `${Check.CheckID}:${Index}`;
      const Peak = NextPeak(Peaks.get(PeakKey), Channel.Db, Now);
      Peaks.set(PeakKey, Peak);
      const Fill = Row.querySelector<HTMLElement>('.live-levels-fill');
      const PeakMark = Row.querySelector<HTMLElement>('.live-levels-peak');
      const Value = Row.querySelector<HTMLElement>('.live-levels-value');
      const Bar = Row.querySelector<HTMLElement>('.live-levels-bar');
      if (Fill) {
        Fill.style.width = `${LevelPercent(Channel.Db)}%`;
        Fill.dataset.zone = LevelZoneOf(Channel.Db);
      }
      if (PeakMark) {
        const Percent = LevelPercent(Peak.Db);
        PeakMark.style.left = `${Percent}%`;
        PeakMark.dataset.zone = LevelZoneOf(Peak.Db);
        PeakMark.hidden = Percent <= 0;
      }
      if (Value) Value.textContent = FormatLevel(Channel.Db);
      if (Bar && Channel.Db != null) Bar.setAttribute('aria-valuenow', String(Channel.Db));
      if (Channel.Control) PatchControls(Row, Check, Channel);
    });
  });
}

function ControlKey(CheckID: number, ChannelID: string): string {
  return `${CheckID}:${ChannelID}`;
}

function PatchControls(
  Row: HTMLElement,
  Check: MonitorLiveLevelsCheck,
  Channel: MonitorLiveLevelsCheck['Channels'][number]
): void {
  const Live = Check.State === 'live';
  const Fader = Row.querySelector<HTMLInputElement>('.live-levels-fader');
  const FaderValue = Row.querySelector<HTMLElement>('.live-levels-fader-value');
  const Mute = Row.querySelector<HTMLButtonElement>('.live-levels-mute');
  const Key = ControlKey(Check.CheckID, Channel.ID);
  const Held = Dragging.has(Key) || (HeldUntil.get(Key) || 0) > Date.now();
  if (Fader) {
    Fader.disabled = !Live || Channel.Fader === undefined;
    if (!Held) {
      Fader.value = String(FaderToSlider(Channel.Fader));
      if (FaderValue) FaderValue.textContent = FormatFader(Channel.Fader);
    }
  }
  if (Mute) {
    Mute.disabled = !Live || Channel.Muted === undefined;
    if (!Held) {
      Mute.classList.toggle('is-muted', !!Channel.Muted);
      Mute.setAttribute('aria-pressed', Channel.Muted ? 'true' : 'false');
    }
  }
}

// The control a DOM event came from: its check and channel.
function ControlTarget(El: Element): { CheckID: number; ChannelID: string } | null {
  const Row = El.closest<HTMLElement>('.live-levels-row');
  const Slot = El.closest<HTMLElement>('.monitor-live-levels-slot');
  if (!Row || !Slot || !Row.dataset.channelId) return null;
  return { CheckID: Number(Slot.dataset.checkId), ChannelID: Row.dataset.channelId };
}

function SendChange(
  CheckID: number,
  ChannelID: string,
  Change: { Fader?: number | null; Muted?: boolean },
  Final: boolean
): void {
  if (WatchedTarget == null) return;
  const Key = ControlKey(CheckID, ChannelID);
  HeldUntil.set(Key, Date.now() + HOLD_AFTER_MOVE_MS);
  LastSentAt.set(Key, Date.now());
  window.API.SetMonitorLiveLevel(WatchedTarget, CheckID, ChannelID, Change, Final)
    .then((Result) => {
      // Mid-drag failures would toast ten times a second; the release reports.
      if (Result && !Result.Success && (Final || Change.Muted !== undefined)) {
        Notify(Result.Error || 'The change was not applied.', 'error');
      }
    })
    .catch((Err: unknown) => HandleNonFatalError('MonitorLiveLevels:Set', Err));
}

function OnFaderInput(Input: HTMLInputElement, Final: boolean): void {
  const Target = ControlTarget(Input);
  if (!Target) return;
  const Key = ControlKey(Target.CheckID, Target.ChannelID);
  const Fader = SliderToFader(Number(Input.value));
  const Readout = Input.parentElement?.querySelector<HTMLElement>('.live-levels-fader-value');
  if (Readout) Readout.textContent = FormatFader(Fader);
  const Pending = SendTimers.get(Key);
  if (Pending) clearTimeout(Pending);
  SendTimers.delete(Key);
  if (Final) {
    Dragging.delete(Key);
    SendChange(Target.CheckID, Target.ChannelID, { Fader }, true);
    return;
  }
  Dragging.add(Key);
  const Wait = SEND_INTERVAL_MS - (Date.now() - (LastSentAt.get(Key) || 0));
  if (Wait <= 0) SendChange(Target.CheckID, Target.ChannelID, { Fader }, false);
  else {
    SendTimers.set(
      Key,
      setTimeout(() => {
        SendTimers.delete(Key);
        SendChange(Target.CheckID, Target.ChannelID, { Fader }, false);
      }, Wait)
    );
  }
}

function OnMuteClick(Button: HTMLButtonElement): void {
  const Target = ControlTarget(Button);
  if (!Target) return;
  const Muted = !Button.classList.contains('is-muted');
  Button.classList.toggle('is-muted', Muted);
  Button.setAttribute('aria-pressed', Muted ? 'true' : 'false');
  SendChange(Target.CheckID, Target.ChannelID, { Muted }, true);
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('input', (Event) => {
    const El = Event.target as HTMLElement | null;
    if (El && El.classList && El.classList.contains('live-levels-fader')) {
      OnFaderInput(El as HTMLInputElement, false);
    }
  });
  document.addEventListener('change', (Event) => {
    const El = Event.target as HTMLElement | null;
    if (El && El.classList && El.classList.contains('live-levels-fader')) {
      OnFaderInput(El as HTMLInputElement, true);
    }
  });
  document.addEventListener('click', (Event) => {
    const El = (Event.target as HTMLElement | null)?.closest?.('.live-levels-mute');
    if (El) OnMuteClick(El as HTMLButtonElement);
  });
}

function OnSnapshot(Snapshot: MonitorLiveLevelsSnapshot | null): void {
  if (!Snapshot || WatchedTarget == null || Number(Snapshot.TargetID) !== WatchedTarget) return;
  Checks = new Map((Snapshot.Checks || []).map((Check) => [Number(Check.CheckID), Check]));
  ApplyLiveLevels();
}

/** Start streaming a monitor's live levels; a no-op if it is already the one watched. */
export async function StartMonitorLiveLevels(TargetID: number): Promise<void> {
  const ID = Number(TargetID);
  if (WatchedTarget === ID) return;
  WatchedTarget = ID;
  Checks = new Map();
  Peaks.clear();
  if (!Unsubscribe) Unsubscribe = window.API.OnMonitorLiveLevels(OnSnapshot);
  try {
    OnSnapshot(await window.API.OpenMonitorLiveLevels(ID));
  } catch (Err) {
    HandleNonFatalError('MonitorLiveLevels:Open', Err);
  }
}

/** Stop streaming; safe to call when nothing is being watched. */
export function StopMonitorLiveLevels(): void {
  if (WatchedTarget == null) return;
  WatchedTarget = null;
  Checks = new Map();
  Peaks.clear();
  for (const Timer of SendTimers.values()) clearTimeout(Timer);
  SendTimers.clear();
  Dragging.clear();
  HeldUntil.clear();
  if (Unsubscribe) Unsubscribe();
  Unsubscribe = null;
  window.API.CloseMonitorLiveLevels().catch((Err: unknown) =>
    HandleNonFatalError('MonitorLiveLevels:Close', Err)
  );
}
