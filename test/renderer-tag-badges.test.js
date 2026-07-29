const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Covers the rules behind the tag badges on client tiles:
//
//   lib/tag-badges       which tags a tile carries, and how many badges fit
//   lib/tag-badge-view   the row's markup
//
// Both matter operationally. Tags target scripts and wake-on-LAN, so a badge is
// how an operator confirms at a glance that the machine in front of them is the
// one a tag-addressed action will hit. A badge on the wrong tile is worse than
// no badge at all.

const LIB = path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app', 'lib');

const {
  GetTagMembershipKind,
  TagCoversEntity,
  ResolveEntityTags,
  TagBadgeLabel,
  EstimateLabelWidth,
  EstimateTagBadgeWidth,
  EstimateOverflowChipWidth,
  SelectVisibleTagBadges,
  TagDisplayModeOf,
  TagShowsIcon,
  TagShowsLabel,
  TagBadgeIconName,
  FilterDisplayableTags,
  TILE_BADGE_ROW_WIDTH,
} = require(path.join(LIB, 'tag-badges.js'));
const { RenderTagBadgeRow } = require(path.join(LIB, 'tag-badge-view.js'));

const tag = (TagID, Slug, Scope = {}, Colour = 0) => ({
  TagID,
  Slug,
  Colour,
  Icon: 'tag',
  Scope: { Workspace: false, Groups: [], Clients: [], Tags: [], ...Scope },
});

const client = (ScopedID, GroupID = null) => ({ ScopedID, GroupID });

// ===========================================================================
// Membership
// ===========================================================================

// A tag may absorb other tags, so membership is resolved against the whole tag
// list. These pin the reading of that: a superset tag badges everything its
// members badge, and the badge says it was inherited so nobody hunts for a
// direct assignment that does not exist.

test('a tag that absorbs another tag badges everything that one covers', () => {
  const Video = tag(2, 'video', { Clients: ['uuid-a'] });
  const AllAV = tag(1, 'all-av', { Tags: [2] });
  const List = [AllAV, Video];

  assert.equal(GetTagMembershipKind(AllAV, client('uuid-a'), List), 'tag');
  assert.equal(GetTagMembershipKind(AllAV, client('uuid-b'), List), null);
  assert.deepEqual(
    ResolveEntityTags(List, client('uuid-a')).map((T) => T.Slug),
    ['all-av', 'video']
  );
});

test('without the tag list an absorbed tag reports no membership', () => {
  // The expansion needs the list; a caller that forgets it must under-match
  // (a missing badge), never over-match (a badge on the wrong machine).
  const AllAV = tag(1, 'all-av', { Tags: [2] });
  assert.equal(GetTagMembershipKind(AllAV, client('uuid-a')), null);
});

test('a cycle between tags does not hang the tile render', () => {
  const A = tag(1, 'a', { Tags: [2] });
  const B = tag(2, 'b', { Tags: [1], Clients: ['uuid-a'] });
  assert.deepEqual(
    ResolveEntityTags([A, B], client('uuid-a')).map((T) => T.Slug),
    ['a', 'b']
  );
});

test('a client named directly in the scope is a direct member', () => {
  const T = tag(1, 'foh', { Clients: ['uuid-a'] });
  assert.equal(GetTagMembershipKind(T, client('uuid-a')), 'direct');
  assert.equal(GetTagMembershipKind(T, client('uuid-b')), null);
});

test('a client in a scoped group inherits the tag, and says it came from the group', () => {
  const T = tag(1, 'audio', { Groups: [4] });
  assert.equal(GetTagMembershipKind(T, client('uuid-a', 4)), 'group');
  assert.equal(GetTagMembershipKind(T, client('uuid-a', 5)), null);
  assert.equal(GetTagMembershipKind(T, client('uuid-a', null)), null);
});

test('a workspace tag covers every client, as workspace membership', () => {
  const T = tag(1, 'all', { Workspace: true });
  assert.equal(GetTagMembershipKind(T, client('anything', null)), 'workspace');
});

test('direct membership outranks group and workspace', () => {
  // The editor only offers a toggle for direct membership, so a client that is
  // BOTH named directly and covered by its group must report 'direct' — else
  // its own entry would be unremovable through the UI that wrote it.
  const T = tag(1, 'foh', { Workspace: true, Groups: [2], Clients: ['uuid-a'] });
  assert.equal(GetTagMembershipKind(T, client('uuid-a', 2)), 'direct');
});

test('an EMPTY scope covers nothing — the opposite of a script whitelist', () => {
  // This is the trap that makes this predicate distinct from
  // script-targeting's IsClientWhitelisted, where an empty scope means
  // "unrestricted". Sharing that behaviour here would stamp every freshly
  // created tag onto every tile in the show.
  const T = tag(1, 'new-tag');
  assert.equal(GetTagMembershipKind(T, client('uuid-a', 1)), null);
  assert.equal(TagCoversEntity(T, client('uuid-a', 1)), false);
});

test('a malformed or missing scope covers nothing rather than throwing', () => {
  assert.equal(GetTagMembershipKind(null, client('uuid-a')), null);
  assert.equal(GetTagMembershipKind({ TagID: 1 }, client('uuid-a')), null);
  assert.equal(GetTagMembershipKind(tag(1, 'x', { Clients: ['uuid-a'] }), null), null);
  assert.equal(GetTagMembershipKind(tag(1, 'x', { Clients: ['uuid-a'] }), client('')), null);
});

test('group IDs match across string/number forms', () => {
  // GroupID arrives as a number from the client list but tag scopes are parsed
  // from stored JSON, so a string 4 must still match group 4.
  const T = tag(1, 'audio', { Groups: ['4'] });
  assert.equal(GetTagMembershipKind(T, client('uuid-a', 4)), 'group');
});

test('monitors and dummies match on their own scope-ID forms', () => {
  // A monitoring target is scoped as monitor:<TargetID>; a dummy uses its bare
  // UUID exactly like a real client. Getting either wrong fails silently.
  const T = tag(1, 'probes', { Clients: ['monitor:7', 'dummy-uuid'] });
  assert.equal(GetTagMembershipKind(T, client('monitor:7')), 'direct');
  assert.equal(GetTagMembershipKind(T, client('dummy-uuid')), 'direct');
  assert.equal(GetTagMembershipKind(T, client('7')), null);
});

test('ResolveEntityTags keeps the tag list order, which is the operator’s order', () => {
  // The list arrives ordered by Weight (the Tag Manager's drag order), and that
  // order decides which badges survive the overflow cut.
  const Tags = [
    tag(1, 'first', { Clients: ['uuid-a'] }),
    tag(2, 'skipped', { Clients: ['uuid-b'] }),
    tag(3, 'second', { Workspace: true }),
  ];
  assert.deepEqual(
    ResolveEntityTags(Tags, client('uuid-a')).map((T) => T.Slug),
    ['first', 'second']
  );
});

test('ResolveEntityTags tolerates a missing list or entity', () => {
  assert.deepEqual(ResolveEntityTags(null, client('uuid-a')), []);
  assert.deepEqual(ResolveEntityTags([tag(1, 'x', { Workspace: true })], null), []);
});

// ===========================================================================
// Labels
// ===========================================================================

test('badge labels are the slug in upper case', () => {
  assert.equal(TagBadgeLabel(tag(1, 'front-of-house')), 'FRONT-OF-HOUSE');
});

test('a slugless tag falls back to its ID rather than rendering blank', () => {
  assert.equal(TagBadgeLabel({ TagID: 9, Slug: null }), 'TAG 9');
  assert.equal(TagBadgeLabel({ TagID: 9, Slug: '   ' }), 'TAG 9');
  assert.equal(TagBadgeLabel(null), '');
});

// ===========================================================================
// Fitting one line
// ===========================================================================

test('wide and narrow characters are not costed the same', () => {
  // A flat per-character width would let "IIIIII" reserve as much room as
  // "MMMMMM", so a row of narrow labels would overflow early.
  assert.ok(EstimateLabelWidth('MMMM') > EstimateLabelWidth('AAAA'));
  assert.ok(EstimateLabelWidth('IIII') < EstimateLabelWidth('AAAA'));
  assert.equal(EstimateLabelWidth(''), 0);
});

test('every fitted badge row stays within the tile width', () => {
  const Tags = [
    tag(1, 'foh', { Workspace: true }),
    tag(2, 'audio', { Workspace: true }),
    tag(3, 'recording', { Workspace: true }),
    tag(4, 'backstage', { Workspace: true }),
    tag(5, 'lighting', { Workspace: true }),
  ];
  const { Visible, Overflow } = SelectVisibleTagBadges(Tags, TILE_BADGE_ROW_WIDTH);
  const Used = Visible.reduce((Sum, T) => Sum + EstimateTagBadgeWidth(T) + 4, 0);
  assert.ok(Used <= TILE_BADGE_ROW_WIDTH, `row estimated at ${Used}px`);
  assert.equal(Visible.length + Overflow, Tags.length, 'no tag is lost or double counted');
});

test('a row that fits entirely reports no overflow', () => {
  const Tags = [tag(1, 'foh', { Workspace: true }), tag(2, 'av', { Workspace: true })];
  assert.deepEqual(SelectVisibleTagBadges(Tags, TILE_BADGE_ROW_WIDTH), {
    Visible: Tags,
    Overflow: 0,
  });
});

test('the +N chip is budgeted for, not added on top of a full row', () => {
  // Without reserving room the chip would be pushed off the line it exists to
  // describe, and the operator would see a truncated badge and no count.
  const Tags = Array.from({ length: 6 }, (_, i) => tag(i + 1, `tag-${i}`, { Workspace: true }));
  const { Visible, Overflow } = SelectVisibleTagBadges(Tags, TILE_BADGE_ROW_WIDTH);
  assert.ok(Overflow > 0, 'six tags cannot fit a 200px row');
  const Used =
    Visible.reduce((Sum, T) => Sum + EstimateTagBadgeWidth(T) + 4, 0) +
    EstimateOverflowChipWidth(Overflow);
  assert.ok(Used <= TILE_BADGE_ROW_WIDTH, `row plus chip estimated at ${Used}px`);
});

test('at least one badge is always shown, even when nothing fits', () => {
  // An all-overflow row ("+3") would tell the operator the machine is tagged
  // while withholding every tag name — strictly worse than one clipped badge.
  const Tags = [
    tag(1, 'an-extremely-long-tag-name-that-cannot-fit', { Workspace: true }),
    tag(2, 'another-very-long-one', { Workspace: true }),
  ];
  const { Visible, Overflow } = SelectVisibleTagBadges(Tags, TILE_BADGE_ROW_WIDTH);
  assert.equal(Visible.length, 1);
  assert.equal(Overflow, 1);
});

test('no tags means no row at all', () => {
  assert.deepEqual(SelectVisibleTagBadges([], 200), { Visible: [], Overflow: 0 });
  assert.deepEqual(SelectVisibleTagBadges(null, 200), { Visible: [], Overflow: 0 });
});

// ===========================================================================
// Markup
// ===========================================================================

test('an untagged entity renders no row, so the tile keeps its type line', () => {
  assert.equal(RenderTagBadgeRow([]), '');
  assert.equal(RenderTagBadgeRow(null), '');
});

test('a badge carries the tag colour and an upper-cased label', () => {
  // One custom property drives both the text colour and the tinted fill, so the
  // CSS owns the tint ratio and the markup cannot disagree with itself.
  const Html = RenderTagBadgeRow([tag(1, 'foh', { Workspace: true }, 3)]);
  assert.match(Html, /TILE_TAG_ROW/);
  assert.match(Html, /--tag-colour:#2ecc71/, 'palette index 3 is green');
  assert.match(Html, /<span class="TILE_TAG_LABEL">FOH<\/span>/);
});

test('the row title lists every tag, including the ones behind the +N chip', () => {
  // Otherwise "+3" is a dead end: the operator can see that tags are hidden but
  // has no way to find out which.
  const Tags = Array.from({ length: 6 }, (_, i) => tag(i + 1, `tag-${i}`, { Workspace: true }));
  const Html = RenderTagBadgeRow(Tags);
  assert.match(Html, /TILE_TAG_MORE/);
  for (let i = 0; i < 6; i++) assert.ok(Html.includes(`TAG-${i}`), `tag-${i} missing from title`);
});

// ===========================================================================
// Per-tag display mode
// ===========================================================================
// Display is presentation only: it changes what a badge contains, never which
// tags cover a client. A tag that stops drawing must keep targeting scripts,
// alerts and OSC exactly as before, which is why the filtering lives here and
// not in ResolveEntityTags.

const shown = (Mode, Slug = 'foh', Icon = 'tag') => ({
  TagID: 1,
  Slug,
  Colour: 0,
  Icon,
  Display: Mode,
  Scope: { Workspace: true, Groups: [], Clients: [], Tags: [] },
});

test('a tag with no Display draws its name, as every tag did before the setting', () => {
  // Tags from an older server arrive without the field; reading that as
  // "hidden" would blank the badge row of an entire upgraded show.
  assert.equal(TagDisplayModeOf(tag(1, 'foh')), 'name');
  assert.equal(TagDisplayModeOf({ TagID: 1, Slug: 'foh', Display: 'nonsense' }), 'name');
  assert.equal(TagDisplayModeOf(null), 'name');
});

test('each mode selects the badge parts it names', () => {
  assert.deepEqual(
    ['hidden', 'icon', 'name', 'both'].map((M) => [
      TagShowsIcon(shown(M)),
      TagShowsLabel(shown(M)),
    ]),
    [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ]
  );
});

test('hidden tags are dropped before fitting, so they cost no width and no +N', () => {
  const Tags = [shown('hidden'), { ...shown('name'), TagID: 2, Slug: 'audio' }];
  assert.deepEqual(
    FilterDisplayableTags(Tags).map((T) => T.TagID),
    [2]
  );
  const { Visible, Overflow } = SelectVisibleTagBadges(Tags, TILE_BADGE_ROW_WIDTH);
  assert.equal(Visible.length, 1);
  assert.equal(Overflow, 0, 'a hidden tag must not inflate the overflow chip');
});

test('a tile whose every tag is hidden renders no row, so its type line returns', () => {
  // The tile builders swap the OS/method line back in whenever this is empty;
  // an empty <div> would leave the tile showing neither.
  assert.equal(RenderTagBadgeRow([shown('hidden')]), '');
});

test('a hidden tag is absent from the row title too', () => {
  const Html = RenderTagBadgeRow([shown('hidden', 'secret'), { ...shown('name'), TagID: 2 }]);
  assert.ok(!Html.includes('SECRET'), 'hidden tag leaked into the tooltip');
});

test('icon mode draws the icon and no label; name mode the reverse', () => {
  const IconOnly = RenderTagBadgeRow([shown('icon', 'foh', 'star')]);
  assert.match(IconOnly, /<i class="bi bi-star TILE_TAG_ICON"><\/i>/);
  assert.ok(!IconOnly.includes('TILE_TAG_LABEL'), 'icon mode should draw no label');
  // Still identifiable on hover — an icon alone does not name the tag.
  assert.match(IconOnly, /title="FOH"/);

  const NameOnly = RenderTagBadgeRow([shown('name', 'foh', 'star')]);
  assert.ok(!NameOnly.includes('TILE_TAG_ICON'), 'name mode should draw no icon');
  assert.match(NameOnly, /<span class="TILE_TAG_LABEL">FOH<\/span>/);
});

test('both mode draws the icon before the label', () => {
  const Html = RenderTagBadgeRow([shown('both', 'foh', 'star')]);
  assert.match(Html, /TILE_TAG_ICON[\s\S]*TILE_TAG_LABEL/);
});

test('an unusable icon name falls back to the tag glyph rather than emitting junk', () => {
  // The name is interpolated straight into a class attribute, so anything that
  // is not a bare icon name has to be replaced, not escaped and shipped.
  assert.equal(TagBadgeIconName({ Icon: 'bi bi-Star' }), 'star');
  assert.equal(TagBadgeIconName({ Icon: 'bi-star' }), 'star');
  assert.equal(TagBadgeIconName({ Icon: 'not a real icon"' }), 'tag');
  assert.equal(TagBadgeIconName({}), 'tag');
  assert.equal(TagBadgeIconName(null), 'tag');
});

test('an icon badge is costed narrower than the same tag with its name', () => {
  // The fit is decided from an estimate before the row is in the DOM, so each
  // mode has to be measured as what it actually renders — costing an icon-only
  // badge as if it carried its label would hide badges that would have fitted.
  const Icon = EstimateTagBadgeWidth(shown('icon', 'recording'));
  const Name = EstimateTagBadgeWidth(shown('name', 'recording'));
  const Both = EstimateTagBadgeWidth(shown('both', 'recording'));
  assert.ok(Icon < Name, 'icon-only should be the narrowest');
  assert.ok(Both > Name, 'icon + name is wider than either part');
});

test('icon-only badges are all costed the same width whatever the glyph', () => {
  // The icon box is a fixed width in CSS, so the estimate must not vary with
  // the icon name (which is not what is drawn).
  assert.equal(
    EstimateTagBadgeWidth(shown('icon', 'foh', 'star')),
    EstimateTagBadgeWidth(shown('icon', 'a-much-longer-slug', 'exclamation-triangle-fill'))
  );
});

test('a row of icon-only badges fits more tags than the same tags named', () => {
  const Named = Array.from({ length: 6 }, (_, i) => ({
    ...shown('name', `tag-${i}`),
    TagID: i + 1,
  }));
  const Icons = Named.map((T) => ({ ...T, Display: 'icon' }));
  const Fit = (Tags) => SelectVisibleTagBadges(Tags, TILE_BADGE_ROW_WIDTH).Visible.length;
  assert.ok(Fit(Icons) > Fit(Named));
  assert.equal(Fit(Icons), 6, 'six icon badges fit a 200px row');
});

test('a hostile tag slug cannot break out of the badge markup', () => {
  // Slugs are validated on the way in, but this row is built by string
  // concatenation inside a tile — the escaping is what makes that safe.
  const Html = RenderTagBadgeRow([tag(1, '"><img src=x onerror=alert(1)>', { Workspace: true })]);
  assert.ok(!Html.includes('<img'), 'markup survived into the row');
  assert.match(Html, /&quot;&gt;&lt;IMG/);
});
