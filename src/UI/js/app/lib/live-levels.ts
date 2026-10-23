// Live levels card in a monitor's view — the decisions, without the DOM.
//
// The server streams dBFS per channel while the view is open (see
// src/main/monitoring-live.ts); this lays out a card of horizontal meters and
// works out each bar's width, colour zone and peak-hold marker.
import type { MonitorLiveLevelsCheck } from '@showtrak/protocol';

/** The bottom of the meter scale; anything quieter reads as an empty bar. */
export const METER_FLOOR_DB = -60;
/** From here up the bar turns amber, and from CLIP_DB red. */
export const HOT_DB = -12;
export const CLIP_DB = -3;
/** How long a peak marker holds before it falls, and how fast it falls. */
export const PEAK_HOLD_MS = 1500;
export const PEAK_FALL_DB_PER_SEC = 20;

export type LevelZone = 'ok' | 'hot' | 'clip';

/** Bar width in percent of the scale, 0-100. No signal is an empty bar. */
export function LevelPercent(Db: number | null): number {
  if (Db == null || !Number.isFinite(Db)) return 0;
  const Clamped = Math.min(0, Math.max(METER_FLOOR_DB, Db));
  return Math.round(((Clamped - METER_FLOOR_DB) / -METER_FLOOR_DB) * 1000) / 10;
}

export function LevelZoneOf(Db: number | null): LevelZone {
  if (Db == null) return 'ok';
  if (Db >= CLIP_DB) return 'clip';
  if (Db >= HOT_DB) return 'hot';
  return 'ok';
}

/** `-18.5 dB`, or `−∞` for no signal. */
export function FormatLevel(Db: number | null): string {
  if (Db == null || !Number.isFinite(Db)) return '−∞';
  return `${Db.toFixed(1)} dB`;
}

export interface PeakState {
  Db: number | null;
  /** When the held value was set (ms, any monotonic clock). */
  At: number;
}

/**
 * The peak marker after a new reading: a louder reading takes over at once; a
 * quieter one leaves the marker where it is for PEAK_HOLD_MS, then lets it fall
 * at PEAK_FALL_DB_PER_SEC until it meets the level.
 */
export function NextPeak(Prev: PeakState | undefined, Db: number | null, Now: number): PeakState {
  const Level = Db == null ? null : Db;
  if (!Prev || Prev.Db == null) return { Db: Level, At: Now };
  if (Level != null && Level >= Prev.Db) return { Db: Level, At: Now };
  const Held = Now - Prev.At;
  if (Held <= PEAK_HOLD_MS) return Prev;
  const Fallen = Prev.Db - ((Held - PEAK_HOLD_MS) / 1000) * PEAK_FALL_DB_PER_SEC;
  const Floor = Level == null ? METER_FLOOR_DB : Level;
  if (Fallen <= Floor) return { Db: Level, At: Now };
  return { Db: Fallen, At: Prev.At };
}

/** The status line under the card title. */
export function LiveLevelsStatus(Check: MonitorLiveLevelsCheck): {
  Text: string;
  Kind: 'live' | 'connecting' | 'problem';
} {
  if (Check.State === 'live') return { Text: 'Live', Kind: 'live' };
  if (Check.State === 'connecting') return { Text: 'Connecting…', Kind: 'connecting' };
  return { Text: Check.Message || 'Levels unavailable', Kind: 'problem' };
}

function Escape(Value: unknown): string {
  return String(Value == null ? '' : Value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * What the card's markup depends on. While it is unchanged the DOM is updated
 * in place (bar widths, values) rather than redrawn ten times a second.
 */
export function LiveLevelsSignature(Check: MonitorLiveLevelsCheck): string {
  const Status = LiveLevelsStatus(Check);
  return JSON.stringify([Check.Name, Status.Kind, Status.Text, Check.Channels.map((C) => C.Label)]);
}

/** The card's markup with empty bars; levels are filled in by the caller. */
export function LiveLevelsCardHtml(Check: MonitorLiveLevelsCheck): string {
  const Status = LiveLevelsStatus(Check);
  const Rows = Check.Channels.map(
    (Channel, Index) =>
      `<div class="live-levels-row" data-index="${Index}">` +
      `<span class="live-levels-number">${Index + 1}</span>` +
      `<span class="live-levels-label" title="${Escape(Channel.Label)}">${Escape(Channel.Label)}</span>` +
      `<span class="live-levels-bar" role="meter" aria-label="${Escape(Channel.Label)}" aria-valuemin="${METER_FLOOR_DB}" aria-valuemax="0">` +
      '<span class="live-levels-fill"></span><span class="live-levels-peak"></span></span>' +
      '<span class="live-levels-value">−∞</span>' +
      '</div>'
  ).join('');
  return (
    `<div class="live-levels-card is-${Status.Kind}">` +
    '<div class="live-levels-head">' +
    `<span class="live-levels-title">${Escape(Check.Name ? `${Check.Name} · Input Levels` : 'Input Levels')}</span>` +
    `<span class="live-levels-status is-${Status.Kind}">${Escape(Status.Text)}</span>` +
    '</div>' +
    (Rows ? `<div class="live-levels-rows">${Rows}</div>` : '') +
    '</div>'
  );
}
