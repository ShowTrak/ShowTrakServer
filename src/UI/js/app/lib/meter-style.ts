// Writing a level meter's frame: shared by the monitor tiles' meters
// (../tile-widgets.ts) and the view modal's (../live-levels.ts).
//
// Meters update ten times a second. The fill is a full-width bar scaled along
// x and the peak line rides a full-width layer translated along x, so a frame
// is a composited transform; animating width/left re-laid-out the row on
// every frame. Each write is skipped when the value has not changed.

/** A percentage as a 0-100 number, anything unreadable as 0. */
function ClampPercent(Percent: number): number {
  const Value = Number(Percent);
  if (!Number.isFinite(Value)) return 0;
  return Math.min(100, Math.max(0, Value));
}

/** The fill's transform for a level, as a percentage of the bar. */
export function MeterScaleTransform(Percent: number): string {
  return `scaleX(${ClampPercent(Percent) / 100})`;
}

/** The peak layer's transform for a peak, as a percentage of the bar. */
export function MeterOffsetTransform(Percent: number): string {
  return `translateX(${ClampPercent(Percent)}%)`;
}

/** Scale a fill to `Percent` of its bar. */
export function SetMeterScale(El: HTMLElement, Percent: number): void {
  const Next = MeterScaleTransform(Percent);
  if (El.style.transform !== Next) El.style.transform = Next;
}

/** Move a peak layer to `Percent` along its bar. */
export function SetMeterOffset(El: HTMLElement, Percent: number): void {
  const Next = MeterOffsetTransform(Percent);
  if (El.style.transform !== Next) El.style.transform = Next;
}

/** Set a dataset entry (or any string map) only when it differs. */
export function SetIfChanged(Map: DOMStringMap, Key: string, Value: string): void {
  if (Map[Key] !== Value) Map[Key] = Value;
}
