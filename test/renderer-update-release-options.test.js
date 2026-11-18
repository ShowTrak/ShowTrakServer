const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Exercises src/UI/js/app/lib/update-release-options.ts: the client update
// screen's release picker. A pre-release must always be labelled as one, must
// not be the default on the Stable channel, and must be what triggers the
// deploy confirmation.

const {
  GetReleaseOptionLabel,
  IsReleaseOptionSelectable,
  PickDefaultReleaseTag,
  IsPrereleaseTag,
} = require(
  path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app', 'lib', 'update-release-options.js')
);

const stable = (tag) => ({
  tag,
  name: tag,
  publishedAt: null,
  prerelease: false,
  selectable: true,
});
const pre = (tag, selectable) => ({
  tag,
  name: tag,
  publishedAt: null,
  prerelease: true,
  selectable,
});

test('labels say what a release is', () => {
  assert.equal(GetReleaseOptionLabel(stable('v3.14.0'), ''), 'v3.14.0');
  assert.equal(GetReleaseOptionLabel(stable('v3.14.0'), 'v3.14.0'), 'v3.14.0 (downloaded)');
  assert.equal(
    GetReleaseOptionLabel(pre('v3.15.0-beta.1', true), ''),
    'v3.15.0-beta.1 (pre-release)'
  );
  assert.equal(
    GetReleaseOptionLabel(pre('v3.15.0-beta.1', false), ''),
    'v3.15.0-beta.1 (pre-release, Beta channel only)'
  );
});

test('the default is never a release the channel does not allow', () => {
  // Stable channel: the newest entry is a pre-release, so the first full release wins.
  const OnStable = [pre('v3.15.0-beta.1', false), stable('v3.14.0'), stable('v3.13.0')];
  assert.equal(PickDefaultReleaseTag(OnStable, '', ''), 'v3.14.0');
  // A previous choice or download that the channel no longer allows is dropped.
  assert.equal(PickDefaultReleaseTag(OnStable, 'v3.15.0-beta.1', 'v3.15.0-beta.1'), 'v3.14.0');
  // An allowed choice is kept, then the downloaded build.
  assert.equal(PickDefaultReleaseTag(OnStable, 'v3.13.0', 'v3.14.0'), 'v3.13.0');
  assert.equal(PickDefaultReleaseTag(OnStable, '', 'v3.13.0'), 'v3.13.0');
  // Beta channel: the newest of any kind.
  const OnBeta = [pre('v3.15.0-beta.1', true), stable('v3.14.0')];
  assert.equal(PickDefaultReleaseTag(OnBeta, '', ''), 'v3.15.0-beta.1');
  assert.equal(PickDefaultReleaseTag([], '', ''), '');
});

test('selectability and pre-release lookups', () => {
  assert.equal(IsReleaseOptionSelectable(pre('v1.0.0-beta', false)), false);
  assert.equal(IsReleaseOptionSelectable(pre('v1.0.0-beta', true)), true);
  // Older servers did not send selectable at all: treat as allowed.
  assert.equal(
    IsReleaseOptionSelectable({ tag: 'v1.0.0', name: '', publishedAt: null, prerelease: false }),
    true
  );
  assert.equal(IsReleaseOptionSelectable(null), false);
  const Options = [pre('v3.15.0-beta.1', true), stable('v3.14.0')];
  assert.equal(IsPrereleaseTag(Options, 'v3.15.0-beta.1'), true);
  assert.equal(IsPrereleaseTag(Options, 'v3.14.0'), false);
  assert.equal(IsPrereleaseTag(Options, 'v9.9.9'), false);
});
