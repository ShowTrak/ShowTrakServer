// Real text measurement for the tile tag-badge row.
//
// ./tag-badges decides how many badges go on a tile's single badge line before
// that line exists in the DOM, because laying it out for real would cost a
// forced reflow per tile on every client list render. Its fallback for that is a
// per-character width table, and a table cannot know the font: it ran a few
// percent under the UI stack's uppercase metrics, so a row that the fit called
// "fits exactly" rendered a glyph or two over the tile and was cropped by the
// row's `overflow: hidden` — no "+N", just a sliced badge.
//
// Canvas text measurement fixes that without giving the reflow back: measureText
// touches no layout, so the exact advance width of a label in the row's own
// computed font is free. This module reads that font off a probe styled by the
// real CSS selectors (so the numbers cannot drift from the stylesheet the way
// hard-coded ones do), installs a measurer into tag-badges, and memoizes per
// label — the same handful of slugs are measured across every tile on screen.

import { SetTagBadgeLabelMeasurer } from './tag-badges';

/** Measured advance widths, keyed by the exact label string. */
const Widths = new Map<string, number>();

let Context: CanvasRenderingContext2D | null = null;
// Separate from `Context` so a failed setup is remembered as failed: without it
// every unmeasurable label would rebuild the probe and re-read the styles.
let Prepared = false;

/**
 * The badge label's computed font, read from a probe in the live stylesheet.
 *
 * The badge row's type is only reachable through the descendant selectors
 * `.SHOWTRAK_PC > .TILE_TAG_ROW .TILE_TAG_LABEL`, so the probe reproduces that
 * whole chain rather than a bare span — a span alone would report the body font
 * and measure everything short.
 *
 * The probe is absolutely positioned off-screen and removed immediately, so it
 * never participates in the client list's grid.
 */
function ReadBadgeFont(): { Font: string; Spacing: string } | null {
  if (typeof document === 'undefined' || !document.body) return null;

  const Host = document.createElement('div');
  Host.className = 'SHOWTRAK_PC';
  Host.setAttribute('aria-hidden', 'true');
  Host.style.cssText =
    'position:absolute;left:-9999px;top:-9999px;visibility:hidden;pointer-events:none;';
  Host.innerHTML =
    '<div class="TILE_TAG_ROW"><span class="TILE_TAG_BADGE">' +
    '<span class="TILE_TAG_LABEL">A</span></span></div>';
  document.body.appendChild(Host);

  try {
    const Label = Host.querySelector('.TILE_TAG_LABEL');
    if (!Label) return null;
    const Style = window.getComputedStyle(Label);
    if (!Style || !Style.fontSize || !Style.fontFamily) return null;
    // Composed rather than taken from the `font` shorthand, which computed
    // styles are not required to serialize.
    const Font = `${Style.fontStyle || 'normal'} ${Style.fontWeight || '400'} ${Style.fontSize} ${
      Style.fontFamily
    }`;
    // `normal` is not a length; canvas wants 0px.
    const Raw = Style.letterSpacing || '';
    const Spacing = !Raw || Raw === 'normal' ? '0px' : Raw;
    return { Font, Spacing };
  } finally {
    Host.remove();
  }
}

/**
 * The measuring context, built once.
 *
 * `letterSpacing` is applied on the context because the badge row is tracked at
 * 0.04em — ~0.4px per character, which over a full row is most of a glyph. Where
 * the property is unsupported the assignment is simply ignored and labels
 * measure marginally narrow, which is why {@link MeasureBadgeLabel} still rounds
 * its result up.
 */
function PrepareContext(): CanvasRenderingContext2D | null {
  if (Prepared) return Context;
  Prepared = true;

  const Metrics = ReadBadgeFont();
  if (!Metrics) return null;

  const Canvas = document.createElement('canvas');
  const Ctx = Canvas.getContext ? Canvas.getContext('2d') : null;
  if (!Ctx) return null;

  Ctx.font = Metrics.Font;
  (Ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = Metrics.Spacing;
  // A context that silently refused the font would measure in the 10px sans
  // default and hand back numbers no better than the table's.
  if (!Ctx.font) return null;

  Context = Ctx;
  return Context;
}

/**
 * Width of one badge label in px, or NaN when it cannot be measured.
 *
 * NaN is tag-badges' documented "fall back to the table" signal, so a browser
 * without a 2D context degrades to the previous behaviour instead of fitting
 * every row to zero width.
 */
export function MeasureBadgeLabel(Label: string): number {
  const Text = String(Label || '');
  if (!Text) return 0;

  const Cached = Widths.get(Text);
  if (Cached !== undefined) return Cached;

  const Ctx = PrepareContext();
  if (!Ctx) return NaN;

  // Rounded up for the same reason the badge total is: several badges share the
  // row, and conceded fractions accumulate into a cropped one.
  const Width = Math.ceil(Ctx.measureText(Text).width);
  if (!Number.isFinite(Width)) return NaN;

  Widths.set(Text, Width);
  return Width;
}

/**
 * Install the measurer, then re-measure once the document's fonts have settled.
 *
 * Must run before the first tile render (main.ts calls it ahead of
 * InitClientList) so no row is ever fitted with the coarse table. The
 * `fonts.ready` pass exists because a webfont arriving after the first
 * measurement would change every width underneath the cache; dropping the cache
 * and the context makes the next render measure against the font that actually
 * landed. Fits already on screen are left alone — they are corrected by the next
 * client list render, which any tag edit triggers anyway.
 */
export function InitTagBadgeMetrics(): void {
  SetTagBadgeLabelMeasurer(MeasureBadgeLabel);

  const Fonts = typeof document !== 'undefined' ? document.fonts : null;
  if (!Fonts || !Fonts.ready) return;
  void Fonts.ready.then(() => {
    Widths.clear();
    Context = null;
    Prepared = false;
  });
}
