const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Exercises the two rule sets extracted from the last renderer modules that
// were still at 0%: 19-tag-manager.ts and 17-unassigned-clients.ts. Both were
// otherwise entirely DOM and event wiring, with their decisions buried inside.
//
//   - lib/tag-summary.ts is the one line that tells an operator what a tag
//     covers. Tags target scripts and wake-on-LAN, so this is how someone
//     confirms a tag means what they think BEFORE firing an action at it.
//
//   - lib/unassigned-clients.ts gates the creation of reserved slots. Neither
//     of its rules is the security boundary — the main process re-reads the
//     setting and re-validates the payload (see
//     main-registrar-unassigned-clients.test.js). These exist so the operator
//     gets a useful message instead of a rejected round trip, and so a disabled
//     feature is not advertised in the menu.

const LIB = path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app', 'lib');

const { SummarizeTagScope } = require(path.join(LIB, 'tag-summary.js'));
const {
  ValidateUnassignedClientRequest,
  ResolveUnassignedClientsEnabled,
  FormatUnassignedClientsCreated,
  MAX_UNASSIGNED_CLIENTS_PER_REQUEST,
  MAX_UNASSIGNED_CLIENT_NAME_LENGTH,
} = require(path.join(LIB, 'unassigned-clients.js'));

// ===========================================================================
// Tag scope summary
// ===========================================================================

const scope = (O = {}) => ({ Scope: { Workspace: false, Groups: [], Clients: [], ...O } });

test('a workspace tag says it covers everything', () => {
  // Short-circuits deliberately: a workspace tag also covers clients adopted
  // later, so listing today's counts alongside it would understate its reach.
  assert.equal(SummarizeTagScope(scope({ Workspace: true })), 'All clients');
  assert.equal(
    SummarizeTagScope(scope({ Workspace: true, Groups: [1, 2], Clients: ['a'] })),
    'All clients'
  );
});

test('groups and clients are counted and pluralised', () => {
  assert.equal(SummarizeTagScope(scope({ Groups: [1] })), '1 group');
  assert.equal(SummarizeTagScope(scope({ Groups: [1, 2] })), '2 groups');
  assert.equal(SummarizeTagScope(scope({ Clients: ['a'] })), '1 client');
  assert.equal(SummarizeTagScope(scope({ Clients: ['a', 'b'] })), '2 clients');
});

test('a mixed scope reports both halves', () => {
  assert.equal(SummarizeTagScope(scope({ Groups: [1, 2], Clients: ['a'] })), '2 groups + 1 client');
});

test('a tag that targets nothing says so rather than rendering blank', () => {
  // A tag that exists but covers nothing is a real and confusing state — it is
  // usually a scope the operator half-configured and then navigated away from.
  // An empty cell would read as a rendering fault instead.
  assert.equal(SummarizeTagScope(scope()), 'No clients');
  assert.equal(SummarizeTagScope({}), 'No clients');
  assert.equal(SummarizeTagScope(null), 'No clients');
  assert.equal(SummarizeTagScope({ Scope: null }), 'No clients');
});

test('a malformed scope is counted as empty rather than throwing', () => {
  for (const Bad of [
    { Groups: 'nope', Clients: null },
    { Groups: null, Clients: 42 },
    { Groups: undefined, Clients: undefined },
  ]) {
    assert.equal(SummarizeTagScope({ Scope: Bad }), 'No clients', JSON.stringify(Bad));
  }
});

// ===========================================================================
// Unassigned client slots
// ===========================================================================

test('a valid request passes through with trimmed values', () => {
  const Result = ValidateUnassignedClientRequest('  Rack A  ', 4);
  assert.equal(Result.ok, true);
  assert.deepEqual(Result.payload, { Name: 'Rack A', Count: 4 });
});

test('a count arriving as a string from the number input is accepted', () => {
  // jQuery's .val() hands back a string; rejecting it would make the form
  // unusable for the only path that reaches it.
  const Result = ValidateUnassignedClientRequest('Rack A', '4');
  assert.equal(Result.ok, true);
  assert.equal(Result.payload.Count, 4);
});

test('a name is required and says what is missing', () => {
  for (const Name of ['', '   ', null, undefined]) {
    const Result = ValidateUnassignedClientRequest(Name, 1);
    assert.equal(Result.ok, false, `name ${JSON.stringify(Name)}`);
    assert.match(Result.error, /enter a name/i);
  }
});

test('an over-long name is refused with the limit stated', () => {
  // The name becomes each slot's nickname; the limit matches the server's own
  // so the operator is told here rather than after a round trip.
  const Result = ValidateUnassignedClientRequest('x'.repeat(65), 1);
  assert.equal(Result.ok, false);
  assert.match(Result.error, new RegExp(String(MAX_UNASSIGNED_CLIENT_NAME_LENGTH)));

  const AtLimit = ValidateUnassignedClientRequest('x'.repeat(64), 1);
  assert.equal(AtLimit.ok, true, 'the limit itself must be allowed');
});

test('a count must be a whole number of at least one', () => {
  for (const Count of [0, -1, 2.5, 'four', '', null, undefined, NaN, Infinity]) {
    const Result = ValidateUnassignedClientRequest('Rack A', Count);
    assert.equal(Result.ok, false, `count ${String(Count)}`);
    assert.match(Result.error, /whole number/i);
  }
});

test('the per-request cap is enforced', () => {
  // The count comes from a free-text number input. A mistyped 1000 would flood
  // the client list with rows the operator then deletes one at a time.
  const Over = ValidateUnassignedClientRequest('Rack A', MAX_UNASSIGNED_CLIENTS_PER_REQUEST + 1);
  assert.equal(Over.ok, false);
  assert.match(Over.error, new RegExp(String(MAX_UNASSIGNED_CLIENTS_PER_REQUEST)));

  const AtCap = ValidateUnassignedClientRequest('Rack A', MAX_UNASSIGNED_CLIENTS_PER_REQUEST);
  assert.equal(AtCap.ok, true, 'the cap itself must be allowed');
});

test('the cap matches the server-side limit', () => {
  // These two must agree, or the renderer either refuses requests the server
  // would accept, or lets through requests it will reject.
  assert.equal(MAX_UNASSIGNED_CLIENTS_PER_REQUEST, 64);
  assert.equal(MAX_UNASSIGNED_CLIENT_NAME_LENGTH, 64);
});

test('the name is checked before the count', () => {
  // Reporting one problem at a time, in field order, is what lets the operator
  // fix the form top to bottom instead of playing whack-a-mole.
  const Result = ValidateUnassignedClientRequest('', 0);
  assert.match(Result.error, /enter a name/i);
});

// --- Menu visibility --------------------------------------------------------

test('the desktop reads the setting', () => {
  const Capabilities = { isWeb: false };
  assert.equal(ResolveUnassignedClientsEnabled(Capabilities, true), true);
  assert.equal(ResolveUnassignedClientsEnabled(Capabilities, 1), true);
  assert.equal(ResolveUnassignedClientsEnabled(Capabilities, false), false);
  assert.equal(ResolveUnassignedClientsEnabled(Capabilities, 0), false);
});

test('the browser uses the capability hint, not the setting', () => {
  // The Web UI cannot read settings at all. The hint already folds in both
  // SYSTEM_ALLOW_UNASSIGNED_CLIENTS and WEBUI_ALLOW_UNASSIGNED_CLIENTS, so the
  // setting value must be ignored entirely on that surface.
  assert.equal(
    ResolveUnassignedClientsEnabled({ isWeb: true, allowUnassignedClients: true }, false),
    true
  );
  assert.equal(
    ResolveUnassignedClientsEnabled({ isWeb: true, allowUnassignedClients: false }, true),
    false,
    'a truthy setting must not override a browser that is not permitted'
  );
});

test('anything unreadable fails closed', () => {
  // An entry point that is offered and then refused by the server is worse than
  // one that is simply absent — it looks like a bug rather than a policy.
  for (const Capabilities of [null, undefined, {}, { isWeb: true }]) {
    assert.equal(
      ResolveUnassignedClientsEnabled(Capabilities, undefined),
      false,
      `capabilities ${JSON.stringify(Capabilities)}`
    );
  }
  assert.equal(ResolveUnassignedClientsEnabled({ isWeb: true }, true), false);
});

// --- Result message ---------------------------------------------------------

test('the created message is pluralised', () => {
  assert.equal(FormatUnassignedClientsCreated(1), 'Created 1 unassigned client');
  assert.equal(FormatUnassignedClientsCreated(4), 'Created 4 unassigned clients');
  assert.equal(FormatUnassignedClientsCreated(0), 'Created 0 unassigned clients');
});

test('an unusable count reports zero rather than "Created undefined"', () => {
  for (const Count of [null, undefined, 'four', {}, NaN]) {
    assert.equal(
      FormatUnassignedClientsCreated(Count),
      'Created 0 unassigned clients',
      `count ${String(Count)}`
    );
  }
});
