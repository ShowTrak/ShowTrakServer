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
  TILE_BADGE_ROW_WIDTH,
} = require(path.join(LIB, 'tag-badges.js'));
const { RenderTagBadgeRow } = require(path.join(LIB, 'tag-badge-view.js'));

const tag = (TagID, Slug, Scope = {}, Colour = 0) => ({
  TagID,
  Slug,
  Colour,
  Icon: 'tag',
  Scope: { Workspace: false, Groups: [], Clients: [], ...Scope },
});

const client = (ScopedID, GroupID = null) => ({ ScopedID, GroupID });

// ===========================================================================
// Membership
// ===========================================================================

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

test('a hostile tag slug cannot break out of the badge markup', () => {
  // Slugs are validated on the way in, but this row is built by string
  // concatenation inside a tile — the escaping is what makes that safe.
  const Html = RenderTagBadgeRow([tag(1, '"><img src=x onerror=alert(1)>', { Workspace: true })]);
  assert.ok(!Html.includes('<img'), 'markup survived into the row');
  assert.match(Html, /&quot;&gt;&lt;IMG/);
});
