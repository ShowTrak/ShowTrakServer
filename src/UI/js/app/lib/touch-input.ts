// Touch-input rules shared by the context menu's long-press and its
// tap-to-confirm guard. DOM-free so they can be unit tested.

// Finger or stylus (Apple Pencil, Surface pen, ...). Mouse and trackpad report
// 'mouse' and keep normal desktop behaviour, even on a touch-screen device.
export function IsTouchPointerType(pointerType: unknown): boolean {
  return pointerType === 'touch' || pointerType === 'pen';
}

// Which input produced a context-menu row click. Prefers the click's own
// pointerType (Chromium/Firefox set it), falling back to the most recent
// pointerdown for browsers that leave it empty or report a plain MouseEvent
// (older iOS WebKit). `hasNativeEvent` is false for the keyboard path, which
// fires a synthetic jQuery click on Enter/Space: that is never a tap.
export function ResolveClickPointerType(
  hasNativeEvent: boolean,
  clickPointerType: unknown,
  lastPointerDownType: string | null
): string | null {
  if (!hasNativeEvent) return null;
  if (typeof clickPointerType === 'string' && clickPointerType !== '') return clickPointerType;
  return lastPointerDownType;
}

// A context-menu action needs a confirm tap (first tap arms the row, second
// runs it) whenever it was tapped with a finger or pen, on any device or
// layout, to stop a stray touch firing a script. The compact phone layout
// keeps requiring it for every input, as it always has.
export function RequiresTapConfirm(isMobileLayout: boolean, pointerType: string | null): boolean {
  return isMobileLayout || IsTouchPointerType(pointerType);
}
