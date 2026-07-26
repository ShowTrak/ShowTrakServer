// Pure rules for showing a client's tags as badges on its tile.
//
// Tags are cross-cutting collections whose membership is a dynamic scope
// ({ Workspace, Groups[], Clients[] }), so which tags a given tile carries is
// DERIVED, never stored on the entity. These helpers own that derivation and
// the "how many badges fit on one line" decision, both of which have to be
// right for the badge row to be readable at a glance during a show.
//
// IMPORTANT — this is NOT the same predicate as script-targeting's
// IsClientWhitelisted, and the two must not be merged. There, an absent or
// empty scope means "unrestricted" (a script nobody narrowed runs everywhere).
// Here, an empty scope means the tag has NO members: a tag that targets nothing
// must render on nothing. Reusing the whitelist predicate would stamp every
// empty tag onto every tile in the show.

import type { TagView } from '@showtrak/protocol';

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
export type TagMembershipKind = 'direct' | 'group' | 'workspace' | null;

/**
 * Why a tag covers this entity, or null if it does not.
 *
 * The distinction matters in the editor: only `direct` membership can be
 * toggled off for one client. Removing a `group` or `workspace` tag would mean
 * rewriting the tag for every other client it covers, which is never what
 * someone editing a single machine intends.
 */
export function GetTagMembershipKind(
  Tag: TagView | null | undefined,
  Entity: TagBadgeEntity | null | undefined
): TagMembershipKind {
  const Scope = Tag && Tag.Scope;
  if (!Scope || !Entity || !Entity.ScopedID) return null;
  if (Array.isArray(Scope.Clients) && Scope.Clients.includes(Entity.ScopedID)) return 'direct';
  if (Scope.Workspace) return 'workspace';
  if (
    Entity.GroupID != null &&
    Array.isArray(Scope.Groups) &&
    Scope.Groups.some((GroupID) => Number(GroupID) === Number(Entity.GroupID))
  ) {
    return 'group';
  }
  return null;
}

/** Whether a tag covers an entity at all, by any route. */
export function TagCoversEntity(
  Tag: TagView | null | undefined,
  Entity: TagBadgeEntity | null | undefined
): boolean {
  return GetTagMembershipKind(Tag, Entity) !== null;
}

/**
 * Every tag covering an entity, in the tag list's own order.
 *
 * The list arrives ordered by Weight (the Tag Manager's drag order), so the
 * operator's own priority decides which badges survive the overflow cut below.
 */
export function ResolveEntityTags(
  Tags: TagView[] | null | undefined,
  Entity: TagBadgeEntity | null | undefined
): TagView[] {
  if (!Entity || !Entity.ScopedID) return [];
  return (Array.isArray(Tags) ? Tags : []).filter((Tag) => TagCoversEntity(Tag, Entity));
}

/** Badge text: the slug, upper-cased. Falls back to the ID for a slugless row. */
export function TagBadgeLabel(Tag: TagView | null | undefined): string {
  const Slug = Tag && Tag.Slug ? String(Tag.Slug).trim() : '';
  if (Slug) return Slug.toUpperCase();
  return Tag && Tag.TagID != null ? `TAG ${Tag.TagID}` : '';
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

/** Full width of one badge: its label plus the pill's horizontal padding. */
export function EstimateTagBadgeWidth(Tag: TagView | null | undefined): number {
  return BADGE_PADDING + EstimateLabelWidth(TagBadgeLabel(Tag));
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
 */
export function SelectVisibleTagBadges(
  Tags: TagView[] | null | undefined,
  AvailableWidth: number = TILE_BADGE_ROW_WIDTH
): TagBadgeFit {
  const All = Array.isArray(Tags) ? Tags.filter(Boolean) : [];
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
