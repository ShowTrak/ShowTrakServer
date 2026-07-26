// Markup for the tile tag-badge row.
//
// Kept beside the fitting rules (./tag-badges) rather than inside any one tile
// builder, because all three tile kinds — ShowTrak clients, monitoring targets
// and dummy clients — render the identical row. The user requirement is that
// tagged tiles look the same whatever they are, so there is exactly one builder.
//
// The row REPLACES the tile's type line (OS + version / method + interval /
// "Dummy") rather than sitting alongside it: tiles are a fixed 220x100, so an
// extra row would push their own content out. Both elements are always emitted
// and exactly one carries `d-none`, which removes it from the tile's grid
// entirely — so a tagged tile is the same height as an untagged one.

import type { TagView } from '@showtrak/protocol';
import { Safe } from '../utils';
import { ScriptColourHex } from './script-colours';
import { SelectVisibleTagBadges, TagBadgeLabel, TILE_BADGE_ROW_WIDTH } from './tag-badges';

/**
 * One badge: the tag's upper-cased slug, in the tag's own colour.
 *
 * The colour carries the identity — the label is drawn in it and the pill is
 * filled with a transparent tint of it — so no separate swatch or icon is
 * needed. Both are driven off one `--tag-colour` custom property rather than
 * two inline declarations, so the CSS owns the tint ratio.
 */
function RenderTagBadge(Tag: TagView): string {
  const Label = TagBadgeLabel(Tag);
  return `<span class="TILE_TAG_BADGE" title="${Safe(Label)}" style="--tag-colour:${Safe(
    ScriptColourHex(Tag.Colour)
  )}"><span class="TILE_TAG_LABEL">${Safe(Label)}</span></span>`;
}

/**
 * The whole row, or '' when the entity carries no tags.
 *
 * The row's `title` lists every tag including the hidden ones, so the "+N" chip
 * is never a dead end — hovering the tile still answers "which tags?".
 */
export function RenderTagBadgeRow(
  Tags: TagView[] | null | undefined,
  AvailableWidth: number = TILE_BADGE_ROW_WIDTH
): string {
  const All = Array.isArray(Tags) ? Tags.filter(Boolean) : [];
  if (!All.length) return '';

  const { Visible, Overflow } = SelectVisibleTagBadges(All, AvailableWidth);
  const Badges = Visible.map(RenderTagBadge).join('');
  const Chip = Overflow > 0 ? `<span class="TILE_TAG_BADGE TILE_TAG_MORE">+${Overflow}</span>` : '';
  const FullList = All.map(TagBadgeLabel).join(', ');

  return `<div class="TILE_TAG_ROW" data-type="TagBadges" title="${Safe(
    FullList
  )}">${Badges}${Chip}</div>`;
}
