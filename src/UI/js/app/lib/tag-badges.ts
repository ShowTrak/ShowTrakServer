// Pure rules for showing a client's tags as badges on its tile.
//
// Tags are cross-cutting collections whose membership is a dynamic scope
// ({ Workspace, Groups[], Clients[], Tags[] }), so which tags a given tile
// carries is DERIVED, never stored on the entity. These helpers own that
// derivation and the "how many badges fit on one line" decision, both of which
// have to be right for the badge row to be readable at a glance during a show.
//
// The scope walk itself lives in ./scope-matching (a tag can absorb other tags,
// so membership is a graph, cycles included); this file adds only the tag-
// specific reading of it.
//
// IMPORTANT — this is NOT the same predicate as script-targeting's
// IsClientWhitelisted, and the two must not be merged. There, an absent or
// empty scope means "unrestricted" (a script nobody narrowed runs everywhere).
// Here, an empty scope means the tag has NO members: a tag that targets nothing
// must render on nothing. Reusing the whitelist predicate would stamp every
// empty tag onto every tile in the show.

import type { TagDisplayMode, TagView } from '@showtrak/protocol';
import { ScopeMembershipKindFor } from './scope-matching';

/**
 * The identity a tag scope is matched against.
 *
 * `ScopedID` is the same string the scope-dropdown persists into Scope.Clients:
 * a plain UUID for ShowTrak and dummy clients, `monitor:<TargetID>` for a
 * monitoring target. Getting this wrong is silent — the tag simply never
 * matches — so tile builders derive it from the same value they put in the
 * tile's `data-uuid`.
 */
export interface TagBadgeEntity {
  ScopedID: string;
  GroupID: number | null;
}

/** How a tag came to cover an entity. `null` means it does not. */
export type TagMembershipKind = 'direct' | 'group' | 'tag' | 'workspace' | null;

/**
 * Why a tag covers this entity, or null if it does not.
 *
 * The distinction matters in the editor: only `direct` membership can be
 * toggled off for one client. Removing a `group`, `tag` or `workspace` tag
 * would mean rewriting the tag for every other client it covers, which is never
 * what someone editing a single machine intends.
 *
 * `AllTags` is the full tag list, needed only to expand a tag that absorbs
 * other tags. Omit it and such a tag reports no membership.
 */
export function GetTagMembershipKind(
  Tag: TagView | null | undefined,
  Entity: TagBadgeEntity | null | undefined,
  AllTags?: TagView[] | null
): TagMembershipKind {
  if (!Tag || !Tag.Scope) return null;
  return ScopeMembershipKindFor(Tag.Scope, Entity, AllTags);
}

/** Whether a tag covers an entity at all, by any route. */
export function TagCoversEntity(
  Tag: TagView | null | undefined,
  Entity: TagBadgeEntity | null | undefined,
  AllTags?: TagView[] | null
): boolean {
  return GetTagMembershipKind(Tag, Entity, AllTags) !== null;
}

/**
 * Every tag covering an entity, in the tag list's own order.
 *
 * The list arrives ordered by Weight (the Tag Manager's drag order), so the
 * operator's own priority decides which badges survive the overflow cut below.
 * It doubles as the expansion source for tags that absorb other tags, so a
 * superset tag badges everything its members badge.
 */
export function ResolveEntityTags(
  Tags: TagView[] | null | undefined,
  Entity: TagBadgeEntity | null | undefined
): TagView[] {
  if (!Entity || !Entity.ScopedID) return [];
  const List = Array.isArray(Tags) ? Tags : [];
  return List.filter((Tag) => TagCoversEntity(Tag, Entity, List));
}

/** Badge text: the slug, upper-cased. Falls back to the ID for a slugless row. */
export function TagBadgeLabel(Tag: TagView | null | undefined): string {
  const Slug = Tag && Tag.Slug ? String(Tag.Slug).trim() : '';
  if (Slug) return Slug.toUpperCase();
  return Tag && Tag.TagID != null ? `TAG ${Tag.TagID}` : '';
}

// --- Display mode ------------------------------------------------------------
// Presentation only. A tag's display mode says what its badge CONTAINS; it never
// affects membership, so a hidden tag still targets scripts, alert rules and OSC
// exactly as a shown one does. Filtering therefore happens here, at the badge
// layer, and never in ResolveEntityTags — the client editor must keep listing
// hidden tags or they would be untoggleable.

const DISPLAY_MODES: TagDisplayMode[] = ['hidden', 'icon', 'name', 'both'];

/**
 * A tag's display mode, defaulted to `name`.
 *
 * `Display` is absent on tags from a server that predates the setting, and on
 * anything hand-built in a test. Those must draw their name — the behaviour
 * every tag had before — rather than vanish, so an unknown value is never read
 * as `hidden`.
 */
export function TagDisplayModeOf(Tag: TagView | null | undefined): TagDisplayMode {
  const Raw = Tag && Tag.Display ? String(Tag.Display).trim().toLowerCase() : '';
  const Match = DISPLAY_MODES.find((Mode) => Mode === Raw);
  return Match || 'name';
}

/** Whether the badge shows the tag's icon. */
export function TagShowsIcon(Tag: TagView | null | undefined): boolean {
  const Mode = TagDisplayModeOf(Tag);
  return Mode === 'icon' || Mode === 'both';
}

/**
 * The bare Bootstrap Icons name to draw for a tag, defaulted to `tag`.
 *
 * Deliberately a local normalizer rather than an import of icon-picker's: this
 * module is pure by contract (it is loaded straight into Node by the tests) and
 * the picker pulls in modals and jQuery.
 */
export function TagBadgeIconName(Tag: TagView | null | undefined): string {
  const Raw = Tag && typeof Tag.Icon === 'string' ? Tag.Icon.trim().toLowerCase() : '';
  const Name = Raw.replace(/^bi\s+/, '').replace(/^bi-/, '');
  return /^[a-z0-9-]+$/.test(Name) ? Name : 'tag';
}

/** Whether the badge shows the tag's label. */
export function TagShowsLabel(Tag: TagView | null | undefined): boolean {
  const Mode = TagDisplayModeOf(Tag);
  return Mode === 'name' || Mode === 'both';
}

/**
 * Drop the tags set to `hidden`.
 *
 * Applied before fitting, so a hidden tag costs no width and — crucially — is
 * not counted into the "+N" chip either. A hidden tag that still bumped the
 * chip would tell the operator a tile has tags it deliberately does not show.
 */
export function FilterDisplayableTags(Tags: TagView[] | null | undefined): TagView[] {
  const List = Array.isArray(Tags) ? Tags.filter(Boolean) : [];
  return List.filter((Tag) => TagDisplayModeOf(Tag) !== 'hidden');
}

// --- Width model -------------------------------------------------------------
// Badges must never wrap (a second line would push the tile's own content out of
// a fixed-height tile), so the count has to be decided BEFORE the row is in the
// DOM. Measuring for real would mean a forced layout per tile on every client
// list render — hundreds per show — so the row is fitted from a character-width
// estimate instead. The estimate is deliberately slightly generous; the row is
// also `overflow: hidden` in CSS, so an underestimate clips a badge rather than
// wrapping the line.
//
// Constants below are for the badge row's type: 10px, weight 600, uppercase,
// 0.04em tracking.

/** Usable width inside an expanded tile: 220px less its 8px padding and 2px border. */
export const TILE_BADGE_ROW_WIDTH = 200;

const BADGE_PADDING = 14;
const BADGE_SPACING = 4;
// A Bootstrap icon at the badge's 12px icon size, drawn in a fixed-width box so
// icon-only badges from different tags line up rather than jittering by glyph.
const ICON_WIDTH = 12;
// Space between icon and label on a `both` badge.
const ICON_LABEL_GAP = 4;
const CHAR_WIDTH_DEFAULT = 6.4;
const CHAR_WIDTH_NARROW = 3.6;
const CHAR_WIDTH_WIDE = 9.2;
const NARROW_CHARS = new Set("IJl1|.,:;'!-_ ".split(''));
const WIDE_CHARS = new Set('MW@%'.split(''));

/** Rendered width of a label at the badge row's type, in px. */
export function EstimateLabelWidth(Label: string): number {
  let Width = 0;
  for (const Char of String(Label || '')) {
    if (NARROW_CHARS.has(Char)) Width += CHAR_WIDTH_NARROW;
    else if (WIDE_CHARS.has(Char)) Width += CHAR_WIDTH_WIDE;
    else Width += CHAR_WIDTH_DEFAULT;
  }
  return Width;
}

/**
 * Full width of one badge: the pill's horizontal padding plus whatever its
 * display mode puts inside it — icon, label, or both with a gap between.
 *
 * A `hidden` tag is never passed here (FilterDisplayableTags removes it first);
 * were it to slip through it would still measure as a normal badge, which is
 * the safe direction — over-reserving width clips, it does not wrap.
 */
export function EstimateTagBadgeWidth(Tag: TagView | null | undefined): number {
  const ShowIcon = TagShowsIcon(Tag);
  const ShowLabel = TagShowsLabel(Tag);
  let Width = BADGE_PADDING;
  if (ShowIcon) Width += ICON_WIDTH;
  if (ShowLabel) Width += EstimateLabelWidth(TagBadgeLabel(Tag));
  if (ShowIcon && ShowLabel) Width += ICON_LABEL_GAP;
  return Width;
}

/** Width of the "+N" overflow chip, which is padded like any other badge. */
export function EstimateOverflowChipWidth(Count: number): number {
  return BADGE_PADDING + EstimateLabelWidth(`+${Math.max(0, Math.trunc(Count))}`);
}

export interface TagBadgeFit {
  Visible: TagView[];
  Overflow: number;
}

/**
 * Split a tag list into the badges that fit on one line and a hidden remainder.
 *
 * The chip itself takes room, so each candidate is tested against the width left
 * AFTER reserving a chip for whatever would still be hidden. At least one badge
 * is always shown when the entity has tags — an all-overflow row ("+3") would
 * tell the operator a machine is tagged while withholding every tag name.
 *
 * Tags set to `hidden` are dropped before any of this: they neither take width
 * nor count toward the chip.
 */
export function SelectVisibleTagBadges(
  Tags: TagView[] | null | undefined,
  AvailableWidth: number = TILE_BADGE_ROW_WIDTH
): TagBadgeFit {
  const All = FilterDisplayableTags(Tags);
  if (!All.length) return { Visible: [], Overflow: 0 };

  const Visible: TagView[] = [];
  let Used = 0;

  for (let Index = 0; Index < All.length; Index++) {
    const Tag = All[Index]!;
    const Width = EstimateTagBadgeWidth(Tag) + (Visible.length ? BADGE_SPACING : 0);
    const Remaining = All.length - Index - 1;
    const ChipReserve = Remaining > 0 ? BADGE_SPACING + EstimateOverflowChipWidth(Remaining) : 0;

    if (Used + Width + ChipReserve > AvailableWidth && Visible.length > 0) break;

    Visible.push(Tag);
    Used += Width;
  }

  return { Visible, Overflow: All.length - Visible.length };
}
