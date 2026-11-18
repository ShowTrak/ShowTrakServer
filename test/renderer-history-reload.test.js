const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { installJQuery, installDocument, installHowl } = require('./helpers/renderer-stubs');

// When the open view modal reloads its history.
//
// Every live push (a client heartbeat each second, every monitor update) used
// to reload the open modal's history: nine IPC reads for a client, each
// answering with the whole 12h retention. A push now reloads only for another
// entity or once the last load is HISTORY_RELOAD_INTERVAL_MS old (a change of
// state forces one sooner, from the render), and a load asks for the last hour
// plus a margin rather than everything kept.

installJQuery();
installDocument();
installHowl();

const Modal = require(
  path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app', 'monitoring-history-modal.js')
);
const { MONITOR_HISTORY_WINDOW_MS } = require(
  path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app', 'lib', 'history-window.js')
);
const { HistoryReloadDue, HistoryContextKey, HISTORY_RELOAD_INTERVAL_MS, HISTORY_FETCH_WINDOW_MS } =
  Modal;

test('the context key names the entity type and id', () => {
  assert.equal(HistoryContextKey({ type: 'client', id: 'abc' }), 'client:abc');
  assert.equal(HistoryContextKey({ type: 'target', id: 7 }), 'target:7');
  assert.equal(HistoryContextKey(null), null);
  assert.equal(HistoryContextKey({ type: '', id: 1 }), null);
});

test('a push reloads for an entity that was never loaded', () => {
  assert.equal(HistoryReloadDue(null, 'client:a', 1000), true);
  assert.equal(HistoryReloadDue({ Key: 'client:b', At: 1000 }, 'client:a', 1001), true);
});

test('a push within the interval of the last load does not reload', () => {
  const Last = { Key: 'client:a', At: 10_000 };
  assert.equal(HistoryReloadDue(Last, 'client:a', 10_000 + 1_000), false);
  assert.equal(HistoryReloadDue(Last, 'client:a', 10_000 + HISTORY_RELOAD_INTERVAL_MS - 1), false);
});

test('a push once the interval has passed reloads', () => {
  const Last = { Key: 'client:a', At: 10_000 };
  assert.equal(HistoryReloadDue(Last, 'client:a', 10_000 + HISTORY_RELOAD_INTERVAL_MS), true);
});

test('a clock that went backwards reloads rather than waiting it out', () => {
  assert.equal(HistoryReloadDue({ Key: 'client:a', At: 10_000 }, 'client:a', 5_000), true);
});

test('no open entity never reloads', () => {
  assert.equal(HistoryReloadDue(null, null, 1000), false);
});

test('the reload interval is at least 15 s', () => {
  assert.ok(HISTORY_RELOAD_INTERVAL_MS >= 15_000);
});

test('a load asks for the drawn hour plus a margin, not the whole retention', () => {
  assert.ok(HISTORY_FETCH_WINDOW_MS > MONITOR_HISTORY_WINDOW_MS);
  assert.ok(HISTORY_FETCH_WINDOW_MS <= 2 * MONITOR_HISTORY_WINDOW_MS);
});
