// Where a pop-up menu goes. Pure arithmetic over measurements the caller takes
// from the DOM, so the rules can be tested without one.

/** The box the menu must stay inside, in viewport (client) coordinates. */
export interface MenuBounds {
  MinX: number;
  MaxX: number;
  MinY: number;
  MaxY: number;
}

/** The fields of a (possibly synthetic) contextmenu event the anchor is read from. */
export interface MenuAnchorSource {
  clientX?: unknown;
  clientY?: unknown;
  pageX?: unknown;
  pageY?: unknown;
}

/**
 * The point the menu opens at. A real mouse contextmenu carries clientX/clientY;
 * synthetic triggers (keyboard shortcuts, touch long-press) may only set
 * pageX/pageY, which are converted from page to client coordinates for the
 * position:fixed menu. With neither, the menu opens at the viewport centre.
 */
export function ResolveMenuAnchor(
  Event: MenuAnchorSource,
  Scroll: { X: number; Y: number },
  Viewport: { Width: number; Height: number }
): { X: number; Y: number } {
  const HasClient = typeof Event.clientX === 'number' && typeof Event.clientY === 'number';
  const HasPage = typeof Event.pageX === 'number' && typeof Event.pageY === 'number';
  if (HasClient) return { X: Event.clientX as number, Y: Event.clientY as number };
  if (HasPage)
    return { X: (Event.pageX as number) - Scroll.X, Y: (Event.pageY as number) - Scroll.Y };
  return { X: Math.floor(Viewport.Width / 2), Y: Math.floor(Viewport.Height / 2) };
}

/**
 * The menu's top-left corner. It opens down and to the right of the anchor,
 * flips to the other side on an axis where it would overflow, then is clamped
 * inside the bounds (flush to the top-left edge if it is larger than them).
 */
export function PlaceMenu(
  Anchor: { X: number; Y: number },
  Size: { Width: number; Height: number },
  Bounds: MenuBounds
): { Left: number; Top: number } {
  let Left = Anchor.X;
  let Top = Anchor.Y;
  if (Left + Size.Width > Bounds.MaxX) Left = Anchor.X - Size.Width;
  if (Top + Size.Height > Bounds.MaxY) Top = Anchor.Y - Size.Height;
  const MaxLeft = Math.max(Bounds.MinX, Bounds.MaxX - Size.Width);
  const MaxTop = Math.max(Bounds.MinY, Bounds.MaxY - Size.Height);
  return {
    Left: Math.min(Math.max(Bounds.MinX, Left), MaxLeft),
    Top: Math.min(Math.max(Bounds.MinY, Top), MaxTop),
  };
}
