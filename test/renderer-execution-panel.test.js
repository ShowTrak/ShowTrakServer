const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Exercises src/UI/js/app/lib/execution-panel.ts: the rules behind the script
// execution panel. The visual state decides each row's colour and indicator
// and, since completed rows collapse into the section at the top of the panel,
// whether the operator still sees the row at all. A row wrongly classed as
// completed would hide a machine that is still working (or stuck) from the
// person waiting on it.

const PANEL_PATH = path.join(
  __dirname,
  '..',
  'dist-test',
  'UI',
  'js',
  'app',
  'lib',
  'execution-panel.js'
);
const {
  GetReportedProgress,
  GetExecutionVisualState,
  CountCompletedExecutions,
  GetCompletedSectionLabel,
  AllExecutionsSettled,
  ShouldAutoDismissExecutions,
} = require(PANEL_PATH);

test('GetReportedProgress clamps to 0-100 and treats junk as 0', () => {
  assert.equal(GetReportedProgress({ Status: 'Pending', Progress: 45 }), 45);
  assert.equal(GetReportedProgress({ Status: 'Pending', Progress: 140 }), 100);
  assert.equal(GetReportedProgress({ Status: 'Pending', Progress: -5 }), 0);
  assert.equal(GetReportedProgress({ Status: 'Pending', Progress: NaN }), 0);
  assert.equal(GetReportedProgress({ Status: 'Pending', Progress: '60' }), 0);
  assert.equal(GetReportedProgress(null), 0);
});

test('GetExecutionVisualState maps status and progress to one state', () => {
  assert.equal(GetExecutionVisualState({ Status: 'Completed', Progress: 0 }), 'completed');
  assert.equal(GetExecutionVisualState({ Status: 'Failed', Progress: 80 }), 'failed');
  // Queued and running are both Pending; the Running stage starts at 50.
  assert.equal(GetExecutionVisualState({ Status: 'Pending', Progress: 0 }), 'pending');
  assert.equal(GetExecutionVisualState({ Status: 'Pending', Progress: 49 }), 'pending');
  assert.equal(GetExecutionVisualState({ Status: 'Pending', Progress: 50 }), 'running');
  assert.equal(GetExecutionVisualState({ Status: 'Pending', Progress: 99 }), 'running');
  assert.equal(GetExecutionVisualState(undefined), 'pending');
});

test('only successful completions count towards the completed section', () => {
  const Executions = [
    { Status: 'Completed', Progress: 100 },
    { Status: 'Completed', Progress: 100 },
    { Status: 'Failed', Progress: 100 },
    { Status: 'Pending', Progress: 90 },
    { Status: 'Pending', Progress: 0 },
    null,
  ];
  assert.equal(CountCompletedExecutions(Executions), 2);
  assert.equal(CountCompletedExecutions([]), 0);
});

test('GetCompletedSectionLabel shows progress, then "All N" once done', () => {
  assert.equal(GetCompletedSectionLabel(1, 300), '1 of 300 completed');
  assert.equal(GetCompletedSectionLabel(212, 300), '212 of 300 completed');
  assert.equal(GetCompletedSectionLabel(300, 300), 'All 300 completed');
  // Never claims fewer total than completed.
  assert.equal(GetCompletedSectionLabel(5, 3), 'All 5 completed');
});

test('only a run that finished cleanly may close the panel by itself', () => {
  const done = { Status: 'Completed', Progress: 100 };
  const failed = { Status: 'Failed', Progress: 100 };
  const running = { Status: 'Pending', Progress: 60 };
  // Clean and finished: auto-dismiss after the dwell.
  assert.equal(AllExecutionsSettled([done, done]), true);
  assert.equal(ShouldAutoDismissExecutions([done, done]), true);
  // Any failure keeps it up until the operator dismisses it.
  assert.equal(AllExecutionsSettled([done, failed]), true);
  assert.equal(ShouldAutoDismissExecutions([done, failed]), false);
  assert.equal(ShouldAutoDismissExecutions([failed]), false);
  // Still working: neither.
  assert.equal(AllExecutionsSettled([done, running]), false);
  assert.equal(ShouldAutoDismissExecutions([done, running]), false);
  // Nothing to show is not "settled".
  assert.equal(AllExecutionsSettled([]), false);
  assert.equal(ShouldAutoDismissExecutions([]), false);
});
