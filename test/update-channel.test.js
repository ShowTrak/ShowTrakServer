const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Exercises shared/src/runtime/update-channel.ts (@showtrak/protocol/runtime):
// which release each update channel moves to. Both apps' self-updaters and the
// server's client deployment use these rules, so a mistake here would offer a
// pre-release to a stable install, or strand a beta tester on an old build.

const U = require(path.join(__dirname, '..', 'shared', 'dist', 'runtime', 'index.js'));

const sign = (n) => Math.sign(n);

test('anything but "beta" is the stable channel', () => {
  assert.equal(U.NormalizeUpdateChannel('Beta'), 'beta');
  assert.equal(U.NormalizeUpdateChannel(' beta '), 'beta');
  for (const V of ['Stable', 'stable', '', null, undefined, 'nightly', 1]) {
    assert.equal(U.NormalizeUpdateChannel(V), 'stable', String(V));
  }
});

test('versions order like semver, pre-releases below their release', () => {
  assert.equal(sign(U.CompareVersions('v3.32.0', '3.31.9')), 1);
  assert.equal(sign(U.CompareVersions('3.32.0', '3.32.0-beta.9')), 1);
  assert.equal(sign(U.CompareVersions('3.32.0-beta.10', '3.32.0-beta.9')), 1);
  assert.equal(sign(U.CompareVersions('3.32.0-beta.1', '3.32.0-alpha.5')), 1);
  assert.equal(sign(U.CompareVersions('3.32.0-beta', '3.32.0-beta.1')), -1);
  assert.equal(sign(U.CompareVersions('v3.31.2', '3.32.0-beta.1')), -1);
  assert.equal(U.CompareVersions('v3.31.1', '3.31.1'), 0);
  assert.equal(sign(U.CompareVersions('not-a-version', '0.0.1')), -1);
  assert.equal(U.IsPrereleaseVersion('v3.32.0-beta.1'), true);
  assert.equal(U.IsPrereleaseVersion('v3.32.0'), false);
});

test('stable takes the highest full release; beta the highest of any kind', () => {
  const Releases = [
    { tag_name: 'v3.31.1' },
    { tag_name: 'v3.32.0-beta.1', prerelease: true },
    { tag_name: 'v3.31.2' }, // a hotfix published after the beta
    { tag_name: 'v3.33.0', draft: true }, // drafts never count
    { tag_name: 'v3.31.3', prerelease: true }, // flagged on GitHub only
  ];
  assert.equal(U.PickChannelRelease(Releases, 'stable').tag_name, 'v3.31.2');
  assert.equal(U.PickChannelRelease(Releases, 'beta').tag_name, 'v3.32.0-beta.1');
});

test('beta moves to a full release once it is newer than the last beta', () => {
  const Releases = [{ tag_name: 'v3.32.0-beta.3', prerelease: true }, { tag_name: 'v3.32.0' }];
  assert.equal(U.PickChannelRelease(Releases, 'beta').tag_name, 'v3.32.0');
});

test('ChannelAllowsRelease keeps pre-releases and drafts away from stable', () => {
  assert.equal(U.ChannelAllowsRelease('stable', { tag_name: 'v3.31.1' }), true);
  assert.equal(U.ChannelAllowsRelease('stable', { tag_name: 'v3.32.0-beta.1' }), false);
  assert.equal(U.ChannelAllowsRelease('stable', { tag_name: 'v3.32.0', prerelease: true }), false);
  assert.equal(U.ChannelAllowsRelease('beta', { tag_name: 'v3.32.0-beta.1' }), true);
  assert.equal(U.ChannelAllowsRelease('beta', { tag_name: 'v3.32.0', draft: true }), false);
  assert.equal(U.ChannelAllowsRelease('beta', { tag_name: 'nightly' }), false);
  assert.equal(U.ChannelAllowsRelease('beta', null), false);
});

test('ResolveChannelRelease points at the chosen release own files', async () => {
  const Asked = [];
  const Result = await U.ResolveChannelRelease({
    Owner: 'ShowTrak',
    Repo: 'ShowTrakServer',
    Channel: 'beta',
    FetchJson: async (Url) => {
      Asked.push(Url);
      return [{ tag_name: 'v3.31.1' }, { tag_name: 'v3.32.0-beta.1', prerelease: true }];
    },
  });
  assert.deepEqual(Asked, [
    'https://api.github.com/repos/ShowTrak/ShowTrakServer/releases?per_page=30',
  ]);
  assert.deepEqual(Result, {
    Tag: 'v3.32.0-beta.1',
    FeedURL: 'https://github.com/ShowTrak/ShowTrakServer/releases/download/v3.32.0-beta.1/',
    Prerelease: true,
  });
  const Nothing = await U.ResolveChannelRelease({
    Owner: 'o',
    Repo: 'r',
    Channel: 'beta',
    FetchJson: async () => ({ message: 'rate limited' }),
  });
  assert.equal(Nothing, null);
});
