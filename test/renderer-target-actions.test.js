const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/lib/target-actions.ts: which of a monitoring target's
// check types its Actions tab offers, and what a parameter can be set to when
// one press is sent to every check of that type.
//
// Loaded from dist-test/ (see test/renderer-utils.test.js for why).
const {
  GroupTargetActionMethods,
  IsCheckOffline,
  MergeActionParamOptions,
  MethodsWithActions,
} = require('../dist-test/UI/js/app/lib/target-actions.js');

const POWER_ON = { ID: 'power.on', Label: 'Power On', Icon: 'power', Group: 'Power' };
const METHODS = [
  { ID: 'pjlink', Name: 'PJLink', Actions: [POWER_ON] },
  { ID: 'ping', Name: 'Ping', Actions: [] },
  { ID: 'http', Name: 'HTTP' },
];
const check = (CheckID, Method, extra = {}) => ({ CheckID, Method, ...extra });

test('groups every check of a type with actions, in first-seen order', () => {
  const Groups = GroupTargetActionMethods(
    [check(1, 'ping'), check(2, 'pjlink'), check(3, 'http'), check(4, 'pjlink')],
    METHODS
  );
  assert.equal(Groups.length, 1);
  assert.equal(Groups[0].Method, 'pjlink');
  assert.equal(Groups[0].Name, 'PJLink');
  assert.deepEqual(
    Groups[0].Checks.map((Check) => Check.CheckID),
    [2, 4]
  );
  assert.deepEqual(Groups[0].Actions, [POWER_ON]);
});

test('a target with no controllable checks offers nothing', () => {
  assert.deepEqual(GroupTargetActionMethods([check(1, 'ping'), check(2, 'http')], METHODS), []);
  assert.deepEqual(GroupTargetActionMethods([], METHODS), []);
  assert.deepEqual(GroupTargetActionMethods(null, METHODS), []);
  // A method the catalogue does not know (not loaded yet) is not guessed at.
  assert.deepEqual(GroupTargetActionMethods([check(1, 'mystery')], METHODS), []);
});

test('the empty message names the check types that do have actions', () => {
  assert.deepEqual(MethodsWithActions(METHODS), ['PJLink']);
  assert.deepEqual(MethodsWithActions([]), []);
});

test('only a probed, unreachable check counts as offline', () => {
  assert.equal(IsCheckOffline({ LastChecked: 1, Online: false }), true);
  assert.equal(IsCheckOffline({ LastChecked: 1, Online: true }), false);
  assert.equal(IsCheckOffline({ LastChecked: null, Online: false }), false);
});

test('parameter choices are every check’s reported options, each once', () => {
  const Field = { Key: 'input', Options: ['11'] };
  const Options = MergeActionParamOptions(
    [
      { ActionOptions: { input: [{ value: '31', label: 'Digital 1' }] } },
      {
        ActionOptions: {
          input: [
            { value: '31', label: 'Digital 1' },
            { value: '32', label: 'Digital 2' },
          ],
        },
      },
      {},
    ],
    Field
  );
  assert.deepEqual(Options, [
    { value: '31', label: 'Digital 1' },
    { value: '32', label: 'Digital 2' },
  ]);
});

test('with nothing reported, the field’s own options apply, else free text', () => {
  assert.deepEqual(
    MergeActionParamOptions([{}], {
      Key: 'input',
      Options: ['11', { value: '21', label: 'Video 1' }],
    }),
    [
      { value: '11', label: '11' },
      { value: '21', label: 'Video 1' },
    ]
  );
  assert.deepEqual(MergeActionParamOptions([{}], { Key: 'input' }), []);
});
