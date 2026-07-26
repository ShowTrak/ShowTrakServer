// Cuts a release: dispatches the Build workflow, waits for it, and reports what
// came out the other end.
//
// The build itself runs on GitHub -- the Apple signing certificate and the
// notarization key live in repository secrets, so a release cannot be produced
// from a laptop even if you wanted to. This script is the trigger and the
// verification around that: it checks the things that silently produce a WRONG
// release, dispatches the workflow against the current branch, streams the run,
// and then confirms the release that appeared is actually published with its
// assets attached.
//
// The checks matter more than the dispatch. The workflow builds from the REMOTE
// ref, not from your working copy, so anything uncommitted or unpushed is
// simply not in the release -- and the submodule check exists because a
// protocol commit left unpushed fails the build minutes later, in CI, for
// reasons that read as a type error rather than a missing push.
//
// Usage:
//   npm run publish                 # publish the current version
//   npm run publish -- --draft      # build + draft, stop short of publishing
//   npm run publish -- --yes        # no confirmation prompt (for automation)
//   npm run publish -- --variant=unsigned
//   npm run publish -- --no-watch   # dispatch and return immediately
//
// Bumping the version is deliberately NOT part of this. `npm version <x.y.z>`
// already writes package.json + the lock file, and the release commit is its
// own step; this script refuses to run against a version that is already
// published rather than quietly re-cutting it.
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_FILE = 'build-and-draft-release.yml';
const VARIANTS = ['unsigned', 'signed', 'signed-notarized'];
// How long to wait for the dispatched run to appear in the API before giving up
// on finding it. The dispatch itself has already succeeded by then, so this
// only bounds the watching, never the release.
const RUN_LOOKUP_TIMEOUT_MS = 60_000;
const RUN_LOOKUP_INTERVAL_MS = 2_000;

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

// Same as run(), but a non-zero exit is an answer rather than a failure.
function tryRun(command, args, options = {}) {
  try {
    return { ok: true, out: run(command, args, options) };
  } catch (error) {
    return { ok: false, out: String((error.stdout || '') + (error.stderr || '')).trim() };
  }
}

function fail(message, detail) {
  console.error(`\n  ✖ ${message}`);
  if (detail) console.error(`    ${String(detail).split('\n').join('\n    ')}`);
  console.error('');
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    mode: 'publish',
    variant: 'signed-notarized',
    yes: false,
    watch: true,
    allowDirty: false,
    republish: false,
  };

  for (const arg of argv) {
    if (arg === '--draft') options.mode = 'draft';
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--no-watch') options.watch = false;
    else if (arg === '--allow-dirty') options.allowDirty = true;
    else if (arg === '--republish') options.republish = true;
    else if (arg.startsWith('--variant=')) options.variant = arg.slice('--variant='.length);
    else
      fail(
        `Unknown option: ${arg}`,
        'See the usage block at the top of scripts/publish-release.js'
      );
  }

  if (!VARIANTS.includes(options.variant)) {
    fail(`Unknown variant: ${options.variant}`, `Expected one of: ${VARIANTS.join(', ')}`);
  }
  return options;
}

// owner/repo from the origin remote, so this script works unchanged in both the
// Server and the Client repositories.
function resolveRepo() {
  const url = tryRun('git', ['remote', 'get-url', 'origin']);
  if (!url.ok) fail('No `origin` remote found.', url.out);
  const match = url.out.match(/github\.com[:/](.+?)(?:\.git)?$/);
  if (!match) fail(`Could not read a GitHub repository from the origin remote: ${url.out}`);
  return match[1];
}

function checkGhAvailable() {
  const version = tryRun('gh', ['--version']);
  if (!version.ok) {
    fail('The GitHub CLI (`gh`) is not installed.', 'https://cli.github.com');
  }
  const auth = tryRun('gh', ['auth', 'status']);
  if (!auth.ok) fail('The GitHub CLI is not authenticated.', 'Run: gh auth login');
}

// A dirty tree or an unpushed commit means the release is built from something
// other than what you are looking at, which is the failure worth catching here:
// it produces a plausible release containing the wrong code.
function checkWorkingTreeIsReleasable(branch, options) {
  const status = run('git', ['status', '--porcelain']);
  if (status && !options.allowDirty) {
    fail(
      'Working tree has uncommitted changes.',
      `The build runs from the pushed branch, so these would NOT be in the release:\n${status}\n\nCommit them, or pass --allow-dirty if that is genuinely intended.`
    );
  }

  tryRun('git', ['fetch', '--quiet', 'origin', branch]);
  const local = run('git', ['rev-parse', 'HEAD']);
  const remote = tryRun('git', ['rev-parse', `origin/${branch}`]);
  if (!remote.ok) {
    fail(`Branch ${branch} has not been pushed to origin.`, `Run: git push -u origin ${branch}`);
  }
  if (local !== remote.out) {
    const ahead = tryRun('git', ['rev-list', '--count', `origin/${branch}..HEAD`]);
    const behind = tryRun('git', ['rev-list', '--count', `HEAD..origin/${branch}`]);
    fail(
      `Local ${branch} and origin/${branch} have diverged.`,
      `ahead ${ahead.out || '?'}, behind ${behind.out || '?'}. The workflow builds origin/${branch}; push or pull first.`
    );
  }
}

// A submodule commit that exists only locally is the trap this catches: the
// pointer is committed and pushed, the build checks the submodule out by SHA,
// and the SHA is not there. The failure lands minutes later, in CI, looking
// like a type error rather than a missing push.
function checkSubmodulesArePushed() {
  const listed = tryRun('git', ['submodule', 'status']);
  if (!listed.ok || !listed.out) return;

  for (const line of listed.out.split('\n')) {
    const match = line.trim().match(/^([+\-U]?)([0-9a-f]{40})\s+(\S+)/);
    if (!match) continue;
    const [, marker, sha, submodulePath] = match;

    if (marker === '-') {
      fail(
        `Submodule ${submodulePath} is not initialised.`,
        'Run: git submodule update --init --recursive'
      );
    }
    if (marker === '+') {
      fail(
        `Submodule ${submodulePath} is checked out at a different commit than the one recorded.`,
        'Commit the pointer move (or reset the submodule) before releasing.'
      );
    }

    const cwd = path.join(ROOT, submodulePath);
    tryRun('git', ['fetch', '--quiet', 'origin'], { cwd });
    const contained = tryRun('git', ['branch', '--remotes', '--contains', sha], { cwd });
    if (!contained.ok || !contained.out) {
      fail(
        `Submodule ${submodulePath} points at a commit that is not on its remote.`,
        `${sha.slice(0, 7)} exists only locally, so the build will check out a commit that is not there.\nRun: git -C ${submodulePath} push`
      );
    }
  }
}

function readReleaseState(repo, tag) {
  const view = tryRun('gh', [
    'release',
    'view',
    tag,
    '--repo',
    repo,
    '--json',
    'isDraft,name,assets,url',
  ]);
  if (!view.ok) return null;
  try {
    return JSON.parse(view.out);
  } catch {
    return null;
  }
}

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// gh does not return the run it just created, so the run is identified by being
// the newest workflow_dispatch run that started after the dispatch went in.
async function findDispatchedRun(repo, dispatchedAt) {
  const deadline = Date.now() + RUN_LOOKUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const list = tryRun('gh', [
      'run',
      'list',
      '--repo',
      repo,
      '--workflow',
      WORKFLOW_FILE,
      '--event',
      'workflow_dispatch',
      '--limit',
      '5',
      '--json',
      'databaseId,createdAt,url',
    ]);
    if (list.ok) {
      try {
        const runs = JSON.parse(list.out)
          .filter((entry) => new Date(entry.createdAt).getTime() >= dispatchedAt - 5_000)
          .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        if (runs.length) return runs[runs.length - 1];
      } catch {
        /* fall through to retry */
      }
    }
    await wait(RUN_LOOKUP_INTERVAL_MS);
  }
  return null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const pkg = require(path.join(ROOT, 'package.json'));
  const version = pkg.version;
  const productName = pkg.productName || pkg.name;
  const tag = `v${version}`;

  checkGhAvailable();
  const repo = resolveRepo();
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === 'HEAD') fail('Detached HEAD; check out a branch before releasing.');

  checkWorkingTreeIsReleasable(branch, options);
  checkSubmodulesArePushed();

  const existing = readReleaseState(repo, tag);
  if (existing && !existing.isDraft && !options.republish) {
    fail(
      `${tag} is already published.`,
      `Bump the version first (npm version <x.y.z> && git push), or pass --republish to rebuild ${tag} in place.`
    );
  }

  const action = options.mode === 'publish' ? 'BUILD AND PUBLISH' : 'BUILD AND DRAFT';
  console.log('');
  console.log(`  ${action}`);
  console.log(`    repository  ${repo}`);
  console.log(`    branch      ${branch} @ ${run('git', ['rev-parse', '--short', 'HEAD'])}`);
  console.log(`    release     ${tag} - ${productName}`);
  console.log(`    macOS       ${options.variant}`);
  if (existing) {
    // Stated exactly, because this is the line somebody reads before agreeing
    // to it: rebuilding a live release is a different act from updating a draft
    // nobody has seen.
    console.log(
      existing.isDraft
        ? `    note        ${tag} already exists as a draft and will be updated`
        : `    note        ${tag} is ALREADY PUBLISHED and will be rebuilt in place`
    );
  }
  if (options.mode === 'publish') {
    console.log('');
    console.log('    This publishes the release publicly and marks it Latest, which is');
    console.log('    what every installed copy checks for updates.');
  }
  console.log('');

  if (!options.yes) {
    if (!process.stdin.isTTY) {
      fail(
        'Refusing to release without confirmation.',
        'Pass --yes when running non-interactively.'
      );
    }
    const proceed = await confirm(`  Continue? [y/N] `);
    if (!proceed) {
      console.log('\n  Cancelled.\n');
      process.exit(1);
    }
  }

  const dispatchedAt = Date.now();
  const dispatch = tryRun('gh', [
    'workflow',
    'run',
    WORKFLOW_FILE,
    '--repo',
    repo,
    '--ref',
    branch,
    '-f',
    `macos_variant=${options.variant}`,
    '-f',
    `release=${options.mode}`,
  ]);
  if (!dispatch.ok) fail('Failed to dispatch the workflow.', dispatch.out);
  console.log('  Dispatched.');

  const dispatched = await findDispatchedRun(repo, dispatchedAt);
  if (!dispatched) {
    console.log(`  Could not identify the run; check https://github.com/${repo}/actions`);
    return;
  }
  console.log(`  Run: ${dispatched.url}`);

  if (!options.watch) {
    console.log('\n  Not waiting (--no-watch).\n');
    return;
  }

  console.log('');
  const watched = spawnSync(
    'gh',
    ['run', 'watch', String(dispatched.databaseId), '--repo', repo, '--exit-status'],
    { cwd: ROOT, stdio: 'inherit' }
  );

  if (watched.status !== 0) {
    fail('The build failed.', `gh run view ${dispatched.databaseId} --repo ${repo} --log-failed`);
  }

  // The run going green is not the same as the release being right: verify the
  // thing this script exists to produce actually exists, in the state asked for.
  const released = readReleaseState(repo, tag);
  if (!released) {
    fail(
      `The build succeeded but no ${tag} release was found.`,
      `Check https://github.com/${repo}/releases`
    );
  }
  if (options.mode === 'publish' && released.isDraft) {
    fail(
      `${tag} was built but is still a draft.`,
      'The publish step did not run; check the run log.'
    );
  }

  console.log('');
  console.log(`  ✔ ${released.name}`);
  console.log(`    ${released.isDraft ? 'draft' : 'published'}, ${released.assets.length} assets`);
  console.log(`    ${released.url}`);
  console.log('');
}

main().catch((error) => fail('Unexpected failure.', error && error.stack ? error.stack : error));
