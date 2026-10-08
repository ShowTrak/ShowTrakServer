const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { installJQuery } = require('./helpers/renderer-stubs');

// The renderer half of check actions: which starred actions a selection offers,
// what parameter value a control starts on, and whether a star draws lit.
//
// The selection rule is the one with consequences. An action offered on a
// monitor that cannot take it would report a failure the operator did not cause;
// an action withheld from one that can would quietly do less than the menu
// promised. Both are the kind of thing only noticed mid-show.

installJQuery();

const APP = path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app');
const Actions = require(path.join(APP, 'monitoring-actions.js'));
const State = require(path.join(APP, 'state/index.js'));

const POWER_ON = { ID: 'power.on', Label: 'Power On', Icon: 'power', Group: 'Power' };
const INPUT_SET = {
  ID: 'input.set',
  Label: 'Set Input',
  Icon: 'box-arrow-in-right',
  Group: 'Input',
  Params: [{ Key: 'Input', Label: 'Input', Type: 'string', Default: '11' }],
};

function setMethods() {
  State.setMonitoringMethodsCache([
    { ID: 'pjlink', Name: 'Projector Health (PJLink)', Actions: [POWER_ON, INPUT_SET] },
    { ID: 'ping', Name: 'Ping', Actions: [] },
    // A method from an older server that predates actions entirely.
    { ID: 'dns', Name: 'DNS' },
  ]);
}

function target(TargetID, Nickname, methods) {
  return {
    TargetID,
    Nickname,
    Checks: methods.map((Method, Index) => ({
      CheckID: TargetID * 10 + Index,
      TargetID,
      Method,
      ActionOptions: {},
    })),
  };
}

test('GetMethodActions reports a method that declares none as empty, not undefined', () => {
  setMethods();
  assert.equal(Actions.GetMethodActions('pjlink').length, 2);
  assert.deepEqual(Actions.GetMethodActions('ping'), []);
  assert.deepEqual(Actions.GetMethodActions('dns'), []);
  assert.deepEqual(Actions.GetMethodActions('not-a-method'), []);
  assert.equal(Actions.GetMethodAction('pjlink', 'power.on').Label, 'Power On');
  assert.equal(Actions.GetMethodAction('pjlink', 'nope'), null);
});

test('a starred action is offered only to the selected monitors that can take it', () => {
  setMethods();
  State.setMonitoringTargets([
    target(1, 'Projector SL', ['pjlink']),
    target(2, 'Projector SR', ['pjlink']),
    // A mixed target: it has a pjlink check alongside a ping one, so it counts.
    target(3, 'Projector US', ['ping', 'pjlink']),
    target(4, 'Core Switch', ['ping']),
  ]);
  State.setMonitoringActionFavourites([
    {
      FavouriteID: 1,
      Method: 'pjlink',
      ActionID: 'power.on',
      Params: {},
      Label: 'Power On',
      Icon: 'power',
      Weight: 1,
    },
    // A favourite nothing in the selection can take must not appear at all,
    // rather than appear and report failures for everything.
    {
      FavouriteID: 2,
      Method: 'qlab5',
      ActionID: 'go',
      Params: {},
      Label: 'Go',
      Icon: 'play',
      Weight: 2,
    },
  ]);

  const offered = Actions.GetFavouritesForSelection(['1', '2', '3', '4']);
  assert.equal(offered.length, 1);
  assert.equal(offered[0].Favourite.ActionID, 'power.on');
  assert.deepEqual(offered[0].TargetIDs, [1, 2, 3]);

  // A selection with nothing applicable offers nothing.
  assert.deepEqual(Actions.GetFavouritesForSelection(['4']), []);
  // Unknown ids are ignored rather than throwing the menu build.
  assert.deepEqual(Actions.GetFavouritesForSelection(['999']), []);
});

test('a control opens on a value the device actually reports', () => {
  setMethods();
  const withOptions = {
    CheckID: 10,
    Method: 'pjlink',
    ActionOptions: { Input: [{ value: '31', label: 'Digital 1 (31)' }] },
  };
  // The device's own first choice beats the schema default: Set Input should
  // open on an input this projector has, not on a code from the manual.
  assert.deepEqual(Actions.GetActionParams(withOptions, INPUT_SET), { Input: '31' });

  // A device that reports nothing falls back to the field's declared default.
  const noOptions = { CheckID: 11, Method: 'pjlink', ActionOptions: {} };
  assert.deepEqual(Actions.GetActionParams(noOptions, INPUT_SET), { Input: '11' });

  // A parameterless action has nothing to collect.
  assert.deepEqual(Actions.GetActionParams(noOptions, POWER_ON), {});

  // A typed value wins over both, and survives the panel's next re-render.
  Actions.SetActionParamDraft('11', 'input.set', 'Input', '52');
  assert.deepEqual(Actions.GetActionParams(noOptions, INPUT_SET), { Input: '52' });
  Actions.ResetActionParamDrafts();
  assert.deepEqual(Actions.GetActionParams(noOptions, INPUT_SET), { Input: '11' });
});

test('the star follows the parameters, so one input is starred and another is not', () => {
  setMethods();
  State.setMonitoringActionFavourites([
    {
      FavouriteID: 1,
      Method: 'pjlink',
      ActionID: 'input.set',
      Params: { Input: '31' },
      Label: 'Set Input — Digital 1 (31)',
      Icon: 'box-arrow-in-right',
      Weight: 1,
    },
  ]);

  assert.equal(Actions.IsActionFavourited('pjlink', INPUT_SET, { Input: '31' }), true);
  assert.equal(Actions.IsActionFavourited('pjlink', INPUT_SET, { Input: '32' }), false);
  // Same action id on a different method is a different action.
  assert.equal(Actions.IsActionFavourited('other', INPUT_SET, { Input: '31' }), false);
  // A parameterless action compares on the action alone.
  assert.equal(Actions.IsActionFavourited('pjlink', POWER_ON, {}), false);
});

test('the controls menu renders a method with actions and nothing for one without', () => {
  setMethods();
  State.setMonitoringActionFavourites([]);

  const online = {
    CheckID: 10,
    Method: 'pjlink',
    Online: true,
    LastChecked: Date.now(),
    ActionOptions: { Input: [{ value: '31', label: 'Digital 1 (31)' }] },
  };
  const html = Actions.RenderCheckActionsMenu(online);
  assert.match(html, /Power On/);
  assert.match(html, /data-action-id="power\.on"/);
  assert.match(html, /monitor-action-star/);
  // The device's reported inputs become the picker's choices.
  assert.match(html, /Digital 1 \(31\)/);
  assert.doesNotMatch(html, /disabled/);

  // A read-only check type draws no menu at all rather than an empty one.
  assert.equal(
    Actions.RenderCheckActionsMenu({ CheckID: 11, Method: 'ping', Online: true, LastChecked: 1 }),
    ''
  );
});

test('controls are disabled while the check is offline, but not while degraded', () => {
  setMethods();
  State.setMonitoringActionFavourites([]);

  // Offline means ShowTrak cannot reach the device, so every button would fail
  // the same way.
  const offline = { CheckID: 10, Method: 'pjlink', Online: false, LastChecked: Date.now() };
  const offlineHtml = Actions.RenderCheckActionsMenu(offline);
  assert.match(offlineHtml, /disabled/);
  assert.match(offlineHtml, /cannot reach the device/);

  // Degraded is left enabled on purpose: a projector in standby reads as
  // degraded, and powering it on is the whole point of the menu.
  const degraded = { CheckID: 10, Method: 'pjlink', Online: true, Degraded: true, LastChecked: 1 };
  assert.doesNotMatch(Actions.RenderCheckActionsMenu(degraded), /disabled/);

  // A check that has never run is not yet known to be unreachable.
  const fresh = { CheckID: 10, Method: 'pjlink', Online: false, LastChecked: null };
  assert.doesNotMatch(Actions.RenderCheckActionsMenu(fresh), /disabled/);
});

test('a starred value the device no longer reports is kept, not silently swapped', () => {
  setMethods();
  State.setMonitoringActionFavourites([]);
  Actions.SetActionParamDraft('10', 'input.set', 'Input', '99');
  try {
    const check = {
      CheckID: 10,
      Method: 'pjlink',
      Online: true,
      LastChecked: 1,
      ActionOptions: { Input: [{ value: '31', label: 'Digital 1 (31)' }] },
    };
    const html = Actions.RenderCheckActionsMenu(check);
    assert.match(html, /99 \(not reported\)/);
    assert.match(html, /value="99" selected/);
  } finally {
    Actions.ResetActionParamDrafts();
  }
});

test('the controls sit behind a ⋯ button on the end of the timeline', () => {
  setMethods();
  State.setMonitoringActionFavourites([]);

  const check = { CheckID: 10, Method: 'pjlink', Online: true, LastChecked: 1 };
  const html = Actions.RenderTimelineWithActions(check, '<div class="status-timeline"></div>');
  assert.match(html, /monitor-actions-toggle/);
  assert.match(html, /bi-three-dots/);
  // Closed until the operator opens it.
  assert.doesNotMatch(html, /monitor-actions-menu is-open/);
  assert.match(html, /aria-expanded="false"/);

  // A read-only check type keeps its bare timeline.
  const timeline = '<div class="status-timeline"></div>';
  assert.equal(
    Actions.RenderTimelineWithActions(
      { CheckID: 11, Method: 'ping', Online: true, LastChecked: 1 },
      timeline
    ),
    timeline
  );
});
