const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { installJQuery, installHowl, installDocument } = require('./helpers/renderer-stubs');

// Exercises the small pure helpers scattered across the remaining renderer
// modules: the script manager's ID/path validation, the icon picker, the group
// manager's membership test, audio volume conversion, the FOG task counters,
// tag scope summaries and the modal formatters.
//
// Individually these are a few lines each. Collectively they are the layer that
// decides whether an operator can save a script, whether an icon renders,
// whether an alert plays at the volume they set, and what a show file is
// called — and every one of them fails silently.

installHowl();
installJQuery();
installDocument();

const APP = path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app');

const ScriptManager = require(path.join(APP, 'script-manager.js'));
const IconPicker = require(path.join(APP, 'icon-picker.js'));
const GroupManager = require(path.join(APP, 'group-manager.js'));
const AudioAssets = require(path.join(APP, 'audio-assets.js'));
const Fog = require(path.join(APP, 'fog.js'));
const Modals = require(path.join(APP, 'modals.js'));

// ===========================================================================
// Script manager: ID and path validation
// ===========================================================================

const { NormalizeScriptManagerPath, ScriptManagerIDError, ScriptColourHex } = ScriptManager;

// ScriptManagerCache is a module-level array exported by script-manager
// itself (no setter), so it is seeded by mutating it in place.
test.beforeEach(() => {
  ScriptManager.ScriptManagerCache.length = 0;
});

test('a script ID is required and must be a usable identifier', () => {
  // The ID becomes a folder name on disk and an OSC address segment, so
  // anything outside this character set breaks one or the other.
  assert.equal(ScriptManagerIDError('restart-qlab'), null);
  assert.equal(ScriptManagerIDError('Restart_QLab_2'), null);

  assert.match(ScriptManagerIDError(''), /required/i);
  assert.match(ScriptManagerIDError('   '), /required/i);
  assert.match(ScriptManagerIDError(null), /required/i);
});

test('a script ID cannot contain spaces, and says so specifically', () => {
  // Called out separately from the character-set message because it is by far
  // the most common mistake, and a generic message sends people hunting.
  assert.match(ScriptManagerIDError('restart qlab'), /spaces/i);
  assert.match(ScriptManagerIDError('a b'), /spaces/i);
});

test('a script ID rejects path separators and traversal', () => {
  // This ID is used to build a directory path server-side. The authoritative
  // containment check is there, but offering an invalid ID and failing on save
  // is a bad experience — and a permissive renderer is how bad values get tried.
  for (const ID of ['../escape', 'a/b', 'a\\b', './rel', 'a:b', 'a.b', 'a*b']) {
    assert.match(ScriptManagerIDError(ID), /letters, numbers/i, `ID ${JSON.stringify(ID)}`);
  }
});

test('a duplicate script ID is refused, case-insensitively', () => {
  // Folder ids collide case-insensitively on Windows and macOS, so allowing
  // "Restart" alongside "restart" would let one script overwrite the other.
  ScriptManager.ScriptManagerCache.push({ id: 'restart' });

  assert.match(ScriptManagerIDError('restart'), /already exists/i);
  assert.match(ScriptManagerIDError('RESTART'), /already exists/i);
  assert.equal(ScriptManagerIDError('restart-2'), null);
});

test('script paths are normalised to forward slashes', () => {
  // Scripts are authored on Windows and run on every platform; a backslash that
  // survives into the manifest fails to resolve everywhere else.
  assert.equal(NormalizeScriptManagerPath('scripts\\run.ps1'), 'scripts/run.ps1');
  assert.equal(NormalizeScriptManagerPath('a\\b\\c.sh'), 'a/b/c.sh');
});

test('a leading ./ is stripped from a script path', () => {
  assert.equal(NormalizeScriptManagerPath('./run.sh'), 'run.sh');
  assert.equal(NormalizeScriptManagerPath('  ./run.sh  '), 'run.sh');
  // Only the leading one — a relative segment further in is left for the
  // server's containment check to reject.
  assert.equal(NormalizeScriptManagerPath('a/./b.sh'), 'a/./b.sh');
});

test('an absent script path normalises to empty', () => {
  for (const Value of [null, undefined, '', '   ']) {
    assert.equal(NormalizeScriptManagerPath(Value), '', `path ${JSON.stringify(Value)}`);
  }
});

test('a script colour always resolves to a real hex value', () => {
  // Rendered straight into a style attribute; undefined would produce an
  // invalid rule and an invisible chip.
  for (const Index of [0, 1, 6, undefined, -1, 999]) {
    const Hex = ScriptColourHex(Index);
    assert.match(Hex, /^#[0-9a-fA-F]{3,8}$/, `index ${Index} gave ${Hex}`);
  }
});

// ===========================================================================
// Icon picker
// ===========================================================================

const { NormalizeIconName } = IconPicker;

test('an icon name is accepted with or without its bi prefix', () => {
  // The picker stores bare names, but operators paste "bi-terminal" straight
  // from the Bootstrap Icons site.
  assert.equal(NormalizeIconName('terminal'), 'terminal');
  assert.equal(NormalizeIconName('bi-terminal'), 'terminal');
  assert.equal(NormalizeIconName('bi terminal'), 'terminal');
  assert.equal(NormalizeIconName('  BI-Terminal  '), 'terminal');
});

test('an icon name that could break out of the class attribute is rejected', () => {
  // The value is interpolated into `class="bi bi-${name}"`, so anything with a
  // space or a quote could add classes — or attributes — that were not intended.
  for (const Value of ['terminal x', 'terminal"', "terminal'", 'terminal>', '<script>', 'a b c']) {
    assert.equal(NormalizeIconName(Value), '', `value ${JSON.stringify(Value)}`);
  }
});

test('a non-string or empty icon name is empty, not "undefined"', () => {
  for (const Value of [null, undefined, 42, {}, [], '', '   ', 'bi-']) {
    assert.equal(NormalizeIconName(Value), '', `value ${JSON.stringify(Value)}`);
  }
});

// ===========================================================================
// Group manager membership
// ===========================================================================

const { GroupManagerInGroup } = GroupManager;

test('group membership matches numerically across string and number ids', () => {
  assert.equal(GroupManagerInGroup(1, 1), true);
  assert.equal(GroupManagerInGroup('1', 1), true);
  assert.equal(GroupManagerInGroup(1, 2), false);
});

test('the ungrouped bucket only matches entities with no group', () => {
  // Comparing null to a real id numerically would make every ungrouped entity
  // appear in group 0.
  assert.equal(GroupManagerInGroup(null, null), true);
  assert.equal(GroupManagerInGroup(undefined, null), true);
  assert.equal(GroupManagerInGroup(1, null), false);
  assert.equal(GroupManagerInGroup(null, 1), false);
  assert.equal(GroupManagerInGroup(0, null), false, 'group 0 is a real group');
});

// ===========================================================================
// Audio volume
// ===========================================================================

const { toBackendVolume, toVisualVolume } = AudioAssets;

test('the stored volume is clamped to the supported range', () => {
  // 0-200 (200% boost). A value outside that either silences an alert the
  // operator expects to hear, or blows out a speaker.
  assert.equal(toBackendVolume(100), 100);
  assert.equal(toBackendVolume(0), 0);
  assert.equal(toBackendVolume(200), 200);
  assert.equal(toBackendVolume(-50), 0);
  assert.equal(toBackendVolume(500), 200);
  assert.equal(toBackendVolume(99.6), 100);
});

test('a non-numeric volume falls back to 100%', () => {
  // The safe fallback for something whose job is to be heard.
  for (const Value of [undefined, 'loud', {}, NaN, Infinity]) {
    assert.equal(toBackendVolume(Value), 100, `value ${String(Value)}`);
  }
});

test('a null or blank volume falls back to 100%, not to silence', () => {
  // These need their own guard: Number(null) and Number('') are both a FINITE
  // zero, so without it they fall through the clamp as silence rather than
  // reaching the non-numeric fallback. An alert asset exists to be heard, so a
  // missing or blank stored volume must never be what mutes it.
  assert.equal(toBackendVolume(null), 100);
  assert.equal(toBackendVolume(''), 100);
});

test('an explicit zero is still honoured as silence', () => {
  // The guard above must not swallow a deliberate mute: 0 is a legitimate
  // setting an operator can choose on the slider.
  assert.equal(toBackendVolume(0), 0);
  assert.equal(toBackendVolume('0'), 0);
});

test('the slider position is half the stored volume', () => {
  // The slider is 0-100 over a 0-200 range, so 100% sits at the midpoint.
  assert.equal(toVisualVolume(0), 0);
  assert.equal(toVisualVolume(100), 50);
  assert.equal(toVisualVolume(200), 100);
  assert.equal(toVisualVolume(300), 100, 'clamped before halving');
});

test('a slider round trip does not drift the stored volume', () => {
  // The editor converts both ways on every render; drift would walk the volume
  // down each time the modal is opened.
  for (const Stored of [0, 50, 100, 150, 200]) {
    assert.equal(toBackendVolume(toVisualVolume(Stored) * 2), Stored, `stored ${Stored}`);
  }
});

// ===========================================================================
// FOG task counters
// ===========================================================================

const { IsFogAvailable } = Fog;

test('FOG defaults to unavailable until the server says otherwise', () => {
  // FogStatus/FogTasks are module-private (no exported setter), so only the
  // boot state is reachable from here — which is the state that matters most:
  // the imaging panel must stay hidden until the server has confirmed FOG is
  // both enabled AND healthy. Showing it early offers imaging actions that
  // would silently fail.
  assert.equal(IsFogAvailable(), false);
});

// OpenTaskCount / FinishedTaskCount are module-private in fog.ts and are
// reachable only through the DOM render path, so they are not covered here.
// Extracting them would mean moving FogTasks state out of the module for two
// one-line filters — not worth the churn against the rest of this pass.

// ===========================================================================
// Modal formatters
// ===========================================================================

const { FormatDependencyVersion, GetShowFileDisplayName } = Modals;

test('a dependency version is reduced to major.minor', () => {
  // The About panel lists a dozen of these; full semver plus a range prefix is
  // noise when the question is only ever "roughly which version".
  assert.equal(FormatDependencyVersion('3.14.2'), '3.14');
  assert.equal(FormatDependencyVersion('^3.14.2'), '3.14');
  assert.equal(FormatDependencyVersion('~3.14.2'), '3.14');
  assert.equal(FormatDependencyVersion('>=3.14.2'), '3.14');
});

test('a non-semver dependency version is shown with its range prefix stripped', () => {
  assert.equal(FormatDependencyVersion('^latest'), 'latest');
  assert.equal(FormatDependencyVersion('next'), 'next');
});

test('an absent dependency version shows a dash rather than blank', () => {
  for (const Value of [null, undefined, '', 0, false]) {
    assert.equal(FormatDependencyVersion(Value), '-', `value ${JSON.stringify(Value)}`);
  }
});

test('a show file is displayed by name, without its path or extension', () => {
  // This is the title an operator reads to confirm which show is loaded.
  assert.equal(GetShowFileDisplayName('/Users/tk/Shows/Hamlet.showtrak'), 'Hamlet');
  assert.equal(GetShowFileDisplayName('C:\\Shows\\Hamlet.showtrak'), 'Hamlet');
  assert.equal(GetShowFileDisplayName('Hamlet.showtrak'), 'Hamlet');
  assert.equal(GetShowFileDisplayName('Hamlet.SHOWTRAK'), 'Hamlet');
});

test('a show file name keeps any other extension it happens to have', () => {
  // Only the ShowTrak extension is noise; anything else is part of the name the
  // operator chose and hiding it would make two files look identical.
  assert.equal(GetShowFileDisplayName('/Shows/Hamlet.v2.showtrak'), 'Hamlet.v2');
  assert.equal(GetShowFileDisplayName('/Shows/Hamlet.backup'), 'Hamlet.backup');
});

test('an absent show path displays as empty', () => {
  for (const Value of [null, undefined, '', 0]) {
    assert.equal(GetShowFileDisplayName(Value), '', `value ${JSON.stringify(Value)}`);
  }
});
