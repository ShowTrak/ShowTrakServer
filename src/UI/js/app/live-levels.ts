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
  FormatLevel,
  LevelPercent,
  LevelZoneOf,
  LiveLevelsCardHtml,
  LiveLevelsSignature,
  NextPeak,
  type PeakState,
} from './lib/live-levels';
import { HandleNonFatalError } from './utils';

let WatchedTarget: number | null = null;
let Checks = new Map<number, MonitorLiveLevelsCheck>();
const Peaks = new Map<string, PeakState>();
let Unsubscribe: (() => void) | null = null;

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
    });
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
  if (Unsubscribe) Unsubscribe();
  Unsubscribe = null;
  window.API.CloseMonitorLiveLevels().catch((Err: unknown) =>
    HandleNonFatalError('MonitorLiveLevels:Close', Err)
  );
}
