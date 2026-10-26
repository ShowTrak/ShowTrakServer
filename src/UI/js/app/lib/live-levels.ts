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

/**
 * The fader slider runs from −60 to +10 dB in 0.5 dB steps, with one step below
 * the bottom for −∞. The unit goes down to −127 dB; a fader set below −60 sits
 * at the bottom of the slider and its value is shown as it is.
 */
export const FADER_SLIDER_MIN = -60.5;
export const FADER_SLIDER_MAX = 10;
export const FADER_SLIDER_STEP = 0.5;

/** The slider position for a fader level (null = −∞). */
export function FaderToSlider(Fader: number | null | undefined): number {
  if (Fader == null || !Number.isFinite(Fader)) return FADER_SLIDER_MIN;
  return Math.min(FADER_SLIDER_MAX, Math.max(FADER_SLIDER_MIN + FADER_SLIDER_STEP, Fader));
}

/** The fader level a slider position sends (null = −∞). */
export function SliderToFader(Position: number): number | null {
  if (!Number.isFinite(Position) || Position <= FADER_SLIDER_MIN) return null;
  return Math.round(Math.min(FADER_SLIDER_MAX, Position) * 10) / 10;
}

/** `-6.0`, `+3.5`, `0.0` or `−∞`, as a fader readout. */
export function FormatFader(Fader: number | null | undefined): string {
  if (Fader === undefined) return '—';
  if (Fader === null || !Number.isFinite(Fader)) return '−∞';
  return `${Fader > 0 ? '+' : ''}${Fader.toFixed(1)}`;
}

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
  return JSON.stringify([
    Check.Name,
    Status.Kind,
    Status.Text,
    Check.Channels.map((C) => [C.ID, C.Group, C.Label, !!C.Control]),
  ]);
}

/**
 * The card's markup with empty bars; levels are filled in by the caller. Each
 * channel is a strip of its own: name and level on top, the meter, and (with
 * live control on) its fader and mute underneath. Strips carry their channel
 * number (Input 1-8, Output 1-8) and keep their index in Channels as data-index.
 */
export function LiveLevelsCardHtml(Check: MonitorLiveLevelsCheck): string {
  const Status = LiveLevelsStatus(Check);
  const Groups: Array<{ Name: string; Strips: string[] }> = [];
  Check.Channels.forEach((Channel, Index) => {
    const Name = Channel.Group || '';
    let Group = Groups[Groups.length - 1];
    if (!Group || Group.Name !== Name) {
      Group = { Name, Strips: [] };
      Groups.push(Group);
    }
    Group.Strips.push(
      `<div class="live-levels-row live-levels-strip" data-index="${Index}" data-channel-id="${Escape(Channel.ID)}">` +
        '<div class="live-levels-strip-head">' +
        `<span class="live-levels-number">${ChannelNumber(Channel.ID, Group.Strips.length + 1)}</span>` +
        `<span class="live-levels-label" title="${Escape(Channel.Label)}">${Escape(Channel.Label)}</span>` +
        '<span class="live-levels-value">−∞</span>' +
        '</div>' +
        `<span class="live-levels-bar" role="meter" aria-label="${Escape(Channel.Label)}" aria-valuemin="${METER_FLOOR_DB}" aria-valuemax="0">` +
        '<span class="live-levels-fill"></span><span class="live-levels-peak"></span></span>' +
        (Channel.Control ? ControlCellsHtml(Channel) : '') +
        '</div>'
    );
  });
  const Body = Groups.map(
    (Group) =>
      (Group.Name ? `<div class="live-levels-group">${Escape(Group.Name)}</div>` : '') +
      `<div class="live-levels-strips">${Group.Strips.join('')}</div>`
  ).join('');
  return (
    `<div class="live-levels-card is-${Status.Kind}">` +
    '<div class="live-levels-head">' +
    `<span class="live-levels-title">${Escape(Check.Name ? `${Check.Name} · Levels` : 'Levels')}</span>` +
    `<span class="live-levels-status is-${Status.Kind}">${Escape(Status.Text)}</span>` +
    '</div>' +
    (Body ? `<div class="live-levels-rows">${Body}</div>` : '') +
    '</div>'
  );
}

// The channel number out of an ID like 'in:3'; Fallback when there is none.
function ChannelNumber(ID: string, Fallback: number): number {
  const N = Number(String(ID || '').split(':')[1]);
  return Number.isInteger(N) && N > 0 ? N : Fallback;
}

// A strip's fader (with its value) and mute, under its meter.
function ControlCellsHtml(Channel: MonitorLiveLevelsCheck['Channels'][number]): string {
  const Name = Escape(Channel.Label);
  return (
    '<div class="live-levels-strip-controls">' +
    `<input type="range" class="form-range live-levels-fader" min="${FADER_SLIDER_MIN}" max="${FADER_SLIDER_MAX}" step="${FADER_SLIDER_STEP}" value="${FaderToSlider(Channel.Fader)}" aria-label="${Name} fader">` +
    `<span class="live-levels-fader-value">${Escape(FormatFader(Channel.Fader))}</span>` +
    `<button type="button" class="btn btn-sm live-levels-mute${Channel.Muted ? ' is-muted' : ''}" aria-pressed="${Channel.Muted ? 'true' : 'false'}" aria-label="Mute ${Name}" title="Mute">` +
    '<i class="bi bi-volume-mute"></i></button>' +
    '</div>'
  );
}
