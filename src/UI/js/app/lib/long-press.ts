// Touch long-press -> context menu, as a DOM-free state machine.
//
// iOS/iPadOS WebKit never fires `contextmenu` for a long-press, and every
// browser on iPad (Chrome included) is WebKit underneath, so on a tablet wide
// enough to get the desktop layout (no bottom-bar Actions button) there was no
// way to open the context menu at all. wire-context-menu.ts feeds pointer
// events in here and opens the menu when onLongPress fires.
//
// Android Chrome and Windows touch DO fire a native `contextmenu` on
// long-press, so the two must not both open the menu: whichever lands first
// wins, and the other is dropped (see OnNativeContextMenu).
//
// The timer and clock are injected so this can be tested without a DOM.
import { IsTouchPointerType } from './touch-input';

export const LONG_PRESS_MS = 500;
// Finger drift allowed before the press counts as a scroll/drag instead.
export const LONG_PRESS_MOVE_TOLERANCE_PX = 10;
// After our long-press opens the menu, the platform may still deliver a
// native `contextmenu` (Android, still holding) and a `click` on lift (iOS).
// Both are swallowed within these windows; the click one is measured from the
// lift so a genuine tap moments later is never eaten.
export const NATIVE_CONTEXTMENU_SUPPRESS_MS = 1000;
export const CLICK_SWALLOW_MS = 400;

export interface LongPressClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface LongPressPointer {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
}

interface ActivePress {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  timer: unknown;
}

export class LongPressTracker {
  private press: ActivePress | null = null;
  private firedAt = -Infinity;
  private swallowClicksUntil = -Infinity;
  private firedForCurrentPress = false;

  constructor(
    private readonly onLongPress: (clientX: number, clientY: number) => void,
    private readonly clock: LongPressClock
  ) {}

  // Only touch and pen start a press: a mouse (incl. an iPad trackpad) gets a
  // real `contextmenu` from the platform. A second finger going down means a
  // pinch/multi-touch gesture, so it abandons the press rather than starting
  // a new one.
  PointerDown(ev: LongPressPointer): void {
    if (!IsTouchPointerType(ev.pointerType)) return;
    if (this.press) {
      this.Cancel();
      return;
    }
    this.firedForCurrentPress = false;
    const press: ActivePress = {
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      lastX: ev.clientX,
      lastY: ev.clientY,
      timer: null,
    };
    press.timer = this.clock.setTimeout(() => {
      if (this.press !== press) return;
      press.timer = null;
      this.firedAt = this.clock.now();
      this.firedForCurrentPress = true;
      this.onLongPress(press.lastX, press.lastY);
    }, LONG_PRESS_MS);
    this.press = press;
  }

  PointerMove(ev: LongPressPointer): void {
    const press = this.press;
    if (!press || press.pointerId !== ev.pointerId) return;
    press.lastX = ev.clientX;
    press.lastY = ev.clientY;
    if (press.timer === null) return;
    const dx = ev.clientX - press.startX;
    const dy = ev.clientY - press.startY;
    if (dx * dx + dy * dy > LONG_PRESS_MOVE_TOLERANCE_PX * LONG_PRESS_MOVE_TOLERANCE_PX) {
      this.Cancel();
    }
  }

  PointerUp(ev: { pointerId: number }): void {
    const press = this.press;
    if (!press || press.pointerId !== ev.pointerId) return;
    if (this.firedForCurrentPress) {
      this.swallowClicksUntil = this.clock.now() + CLICK_SWALLOW_MS;
    }
    this.Cancel();
  }

  // pointercancel (the browser took over to scroll/zoom), dragstart (edit-mode
  // tile drag), blur, etc. Never arms click swallowing: no click follows.
  Cancel(): void {
    const press = this.press;
    if (press && press.timer !== null) this.clock.clearTimeout(press.timer);
    this.press = null;
    this.firedForCurrentPress = false;
  }

  // Call for every platform-originated `contextmenu`. Returns true when it
  // duplicates a long-press we already handled and must be dropped. Otherwise
  // the native event wins, so any pending press is abandoned.
  OnNativeContextMenu(): boolean {
    if (this.clock.now() - this.firedAt < NATIVE_CONTEXTMENU_SUPPRESS_MS) return true;
    this.Cancel();
    return false;
  }

  // Call for every `click`. Returns true for the lift-click that follows a
  // fired long-press; it would otherwise toggle the tile's selection or land
  // on (and trigger) the menu row that just opened under the finger.
  ShouldSwallowClick(): boolean {
    if (this.clock.now() < this.swallowClicksUntil) {
      this.swallowClicksUntil = -Infinity;
      return true;
    }
    return false;
  }
}
