// Start-up gate on the client port (src/main/client-port-guard.ts). What is at
// stake: a server that carries on without its port advertises itself anyway, and
// clients connect to whatever program does hold the port, sitting "connected"
// but never appearing for adoption. So start-up must not continue until the bind
// succeeds; the operator's only choices are Retry and Quit.
const test = require('node:test');
const assert = require('node:assert/strict');

const { EnsureClientPortBound, DescribeBindFailure } = require('../dist/main/client-port-guard');

const InUse = () => Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });

test('a successful first bind continues without asking', async () => {
  let Asked = 0;
  const Bound = await EnsureClientPortBound({
    Port: 3000,
    Initial: Promise.resolve(),
    Retry: () => assert.fail('must not retry'),
    AskRetry: async () => ++Asked > 0,
  });
  assert.equal(Bound, true);
  assert.equal(Asked, 0);
});

test('a failed bind asks, and Retry binds again until it succeeds', async () => {
  const Prompts = [];
  let Retries = 0;
  const Bound = await EnsureClientPortBound({
    Port: 3000,
    Initial: Promise.reject(InUse()),
    // Still held on the first retry, freed by the second.
    Retry: () => (++Retries === 1 ? Promise.reject(InUse()) : Promise.resolve()),
    AskRetry: async (Title, Message, Detail) => {
      Prompts.push({ Title, Message, Detail });
      return true;
    },
  });
  assert.equal(Bound, true);
  assert.equal(Retries, 2);
  assert.equal(Prompts.length, 2, 'asked once per failed bind');
  assert.match(Prompts[0].Message, /Port 3000 is already in use/);
});

test('Quit stops start-up without another bind attempt', async () => {
  let Retries = 0;
  const Bound = await EnsureClientPortBound({
    Port: 3000,
    Initial: Promise.reject(InUse()),
    Retry: () => {
      Retries++;
      return Promise.resolve();
    },
    AskRetry: async () => false,
  });
  assert.equal(Bound, false);
  assert.equal(Retries, 0);
});

test('the message names the port and says what to do', () => {
  const InUseText = DescribeBindFailure(3000, InUse());
  assert.match(InUseText.Message, /3000/);
  assert.match(InUseText.Detail, /Close the program using port 3000/);
  const Other = DescribeBindFailure(3000, Object.assign(new Error('x'), { code: 'EACCES' }));
  assert.match(Other.Detail, /EACCES/);
});
