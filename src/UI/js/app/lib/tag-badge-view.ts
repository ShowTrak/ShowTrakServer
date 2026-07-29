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
import {
  FilterDisplayableTags,
  SelectVisibleTagBadges,
  TagBadgeIconName,
  TagBadgeLabel,
  TagShowsIcon,
  TagShowsLabel,
  TILE_BADGE_ROW_WIDTH,
} from './tag-badges';

/**
 * One badge: the tag's icon and/or upper-cased slug, in the tag's own colour.
 *
 * The colour carries the identity — the contents are drawn in it and the pill is
 * filled with a transparent tint of it — so no separate swatch is needed. Both
 * are driven off one `--tag-colour` custom property rather than two inline
 * declarations, so the CSS owns the tint ratio.
 *
 * Which parts appear is the tag's own Display setting. The badge's HEIGHT must
 * not vary with it: the icon is sized in CSS to the same box the 10px label
 * occupies, so an icon badge, a name badge and an icon+name badge are all
 * exactly as tall as each other and the tag row keeps its fixed height.
 *
 * The `title` is always the full label, so an icon-only badge is still
 * identifiable on hover.
 */
function RenderTagBadge(Tag: TagView): string {
  const Label = TagBadgeLabel(Tag);
  const Icon = TagShowsIcon(Tag)
    ? `<i class="bi bi-${Safe(TagBadgeIconName(Tag))} TILE_TAG_ICON"></i>`
    : '';
  const Text = TagShowsLabel(Tag) ? `<span class="TILE_TAG_LABEL">${Safe(Label)}</span>` : '';
  return `<span class="TILE_TAG_BADGE" title="${Safe(Label)}" style="--tag-colour:${Safe(
    ScriptColourHex(Tag.Colour)
  )}">${Icon}${Text}</span>`;
}

/**
 * The whole row, or '' when the entity carries no tags it may draw.
 *
 * The row's `title` lists every tag that overflowed, so the "+N" chip is never a
 * dead end — hovering the tile still answers "which tags?". Tags set to
 * `hidden` are absent from the row and from that list: the tile is meant to look
 * as though they were not there.
 *
 * Returning '' when every tag is hidden matters — the tile builders swap the
 * type line (OS / method / "Dummy") back in whenever this is empty, so a client
 * carrying only hidden tags reads exactly like an untagged one.
 */
export function RenderTagBadgeRow(
  Tags: TagView[] | null | undefined,
  AvailableWidth: number = TILE_BADGE_ROW_WIDTH
): string {
  const All = FilterDisplayableTags(Tags);
  if (!All.length) return '';

  const { Visible, Overflow } = SelectVisibleTagBadges(All, AvailableWidth);
  const Badges = Visible.map(RenderTagBadge).join('');
  const Chip = Overflow > 0 ? `<span class="TILE_TAG_BADGE TILE_TAG_MORE">+${Overflow}</span>` : '';
  const FullList = All.map(TagBadgeLabel).join(', ');

  return `<div class="TILE_TAG_ROW" data-type="TagBadges" title="${Safe(
    FullList
  )}">${Badges}${Chip}</div>`;
}
