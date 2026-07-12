const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function actionPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'AlertActions', name);
}

function loggerStub() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, log: noop, debug: noop, success: noop };
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

test('_http-shared.requestJson posts JSON and reports status outcomes', async () => {
  const { requestJson } = loadWithMocks(actionPath('_http-shared.js'), {});

  const received = [];
  const server = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url, method: req.method, body });
      if (req.url === '/ok') {
        res.writeHead(204);
        return res.end();
      }
      res.writeHead(500);
      res.end('boom');
    });
  });

  try {
    const ok = await requestJson({
      Url: `http://127.0.0.1:${server.port}/ok`,
      Method: 'POST',
      Body: { hello: 'world' },
    });
    assert.equal(ok.Success, true);
    assert.equal(ok.StatusCode, 204);
    assert.equal(received[0].method, 'POST');
    assert.deepEqual(JSON.parse(received[0].body), { hello: 'world' });

    const fail = await requestJson({ Url: `http://127.0.0.1:${server.port}/err`, Body: {} });
    assert.equal(fail.Success, false);
    assert.equal(fail.StatusCode, 500);

    // Invalid URL and unsupported scheme are rejected before any request.
    assert.equal((await requestJson({ Url: 'not a url' })).Success, false);
    assert.equal((await requestJson({ Url: 'ftp://host/x' })).Success, false);

    // Connection error to a closed port.
    const connErr = await requestJson({ Url: 'http://127.0.0.1:1/x', Timeout: 500 });
    assert.equal(connErr.Success, false);
  } finally {
    await server.close();
  }
});

test('http-api action normalizes settings, validates, and posts context', async () => {
  const action = loadWithMocks(actionPath('http-api.js'), {});
  assert.equal(action.ID, 'http-api');

  // Normalization clamps and defaults.
  const norm = action.NormalizeSettings({
    Protocol: 'HTTPS',
    Port: 0,
    Route: 'api/x',
    Method: 'put',
    Timeout: 5,
  });
  assert.equal(norm.Protocol, 'https');
  assert.equal(norm.Port, 1);
  assert.equal(norm.Route, '/api/x');
  assert.equal(norm.Method, 'PUT');
  assert.equal(norm.Timeout, 250);

  // Validation.
  assert.equal(action.ValidateSettings({ TargetIP: '127.0.0.1', Route: '/x' }), true);
  // Whitespace-only TargetIP trims to empty and fails validation.
  assert.throws(
    () => action.ValidateSettings({ TargetIP: '   ', Route: '/x' }),
    /TargetIP is required/
  );

  const received = [];
  const server = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(200);
      res.end('{}');
    });
  });

  try {
    const result = await action.Execute(
      {
        Settings: {
          Protocol: 'http',
          TargetIP: '127.0.0.1',
          Port: server.port,
          Route: '/api/alerts',
          Method: 'POST',
        },
      },
      {
        TriggerType: 'CLIENT_OFFLINE',
        EntityType: 'client',
        EntityName: 'PC1',
        Severity: 'critical',
        UUID: 'abc',
      },
      loggerStub()
    );
    assert.equal(result.Success, true);
    assert.equal(received[0].Event, 'ShowTrakAlert');
    assert.equal(received[0].EntityName, 'PC1');

    // Server returns 500 -> failure tuple.
    const failServer = await startServer((req, res) => {
      res.writeHead(500);
      res.end();
    });
    const failResult = await action.Execute(
      { Settings: { Protocol: 'http', TargetIP: '127.0.0.1', Port: failServer.port, Route: '/x' } },
      { TriggerType: 'X' },
      loggerStub()
    );
    assert.equal(failResult.Success, false);
    await failServer.close();
  } finally {
    await server.close();
  }
});

test('discord-webhook action builds an embed and validates the URL', async () => {
  const action = loadWithMocks(actionPath('discord-webhook.js'), {});
  assert.equal(action.ID, 'discord-webhook');

  assert.throws(() => action.ValidateSettings({}), /WebhookURL is required/);
  assert.throws(() => action.ValidateSettings({ WebhookURL: 'not-a-url' }), /valid URL/);
  assert.equal(action.ValidateSettings({ WebhookURL: 'https://discord.com/api/webhooks/x' }), true);

  let captured = null;
  const server = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      captured = JSON.parse(body);
      res.writeHead(200);
      res.end('{}');
    });
  });

  try {
    const result = await action.Execute(
      { Settings: { WebhookURL: `http://127.0.0.1:${server.port}/webhook` } },
      {
        TriggerType: 'CLIENT_OFFLINE',
        EntityName: 'PC1',
        Severity: 'critical',
        Description: 'down',
      },
      loggerStub()
    );
    assert.equal(result.Success, true);
    assert.equal(captured.username, 'ShowTrak Alerts');
    assert.equal(captured.embeds[0].color, 15158332); // critical -> red
    // Details become the title; trigger type moves to the footer.
    assert.equal(captured.embeds[0].title, 'down');
    assert.match(captured.embeds[0].footer.text, /CLIENT_OFFLINE/);
    // Only Entity + IP remain as fields (no Severity / Group / UUID / Type).
    const fieldNames = captured.embeds[0].fields.map((f) => f.name);
    assert.deepEqual(fieldNames, ['Entity', 'IP']);
  } finally {
    await server.close();
  }
});

test('discord-webhook text mode posts a single-line content string', async () => {
  const action = loadWithMocks(actionPath('discord-webhook.js'), {});

  let captured = null;
  const server = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      captured = JSON.parse(body);
      res.writeHead(200);
      res.end('{}');
    });
  });

  try {
    const result = await action.Execute(
      { Settings: { WebhookURL: `http://127.0.0.1:${server.port}/webhook`, Mode: 'text' } },
      {
        TriggerType: 'CLIENT_OFFLINE',
        EntityName: 'PC1',
        IP: '10.0.0.5',
        Description: 'PC1 is offline',
      },
      loggerStub()
    );
    assert.equal(result.Success, true);
    assert.equal(captured.embeds, undefined);
    assert.equal(typeof captured.content, 'string');
    assert.doesNotMatch(captured.content, /\n/); // single line
    // Format: "ShowTrak hh:mm:ss > <hostname> (<ip>) is offline"
    assert.match(captured.content, /^ShowTrak \d{2}:\d{2}:\d{2} > PC1 \(10\.0\.0\.5\) is offline$/);
  } finally {
    await server.close();
  }
});

test('slack-webhook action builds an attachment and validates the URL', async () => {
  const action = loadWithMocks(actionPath('slack-webhook.js'), {});
  assert.equal(action.ID, 'slack-webhook');

  assert.throws(() => action.ValidateSettings({}), /WebhookURL is required/);
  assert.throws(() => action.ValidateSettings({ WebhookURL: 'not-a-url' }), /valid URL/);
  assert.equal(action.ValidateSettings({ WebhookURL: 'https://hooks.slack.com/services/x' }), true);

  let captured = null;
  const server = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      captured = JSON.parse(body);
      res.writeHead(200);
      res.end('ok');
    });
  });

  try {
    const result = await action.Execute(
      { Settings: { WebhookURL: `http://127.0.0.1:${server.port}/webhook` } },
      { TriggerType: 'CLIENT_OFFLINE', EntityName: 'PC1', Severity: 'critical', Description: 'down' },
      loggerStub()
    );
    assert.equal(result.Success, true);
    assert.equal(captured.attachments[0].color, 'danger'); // critical -> danger
    assert.equal(captured.attachments[0].fields[0].value, 'PC1');
  } finally {
    await server.close();
  }
});

test('teams-webhook action builds an adaptive card and validates the URL', async () => {
  const action = loadWithMocks(actionPath('teams-webhook.js'), {});
  assert.equal(action.ID, 'teams-webhook');

  assert.throws(() => action.ValidateSettings({}), /WebhookURL is required/);
  assert.equal(
    action.ValidateSettings({ WebhookURL: 'https://example.webhook.office.com/x' }),
    true
  );

  let captured = null;
  const server = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      captured = JSON.parse(body);
      res.writeHead(200);
      res.end('1');
    });
  });

  try {
    const result = await action.Execute(
      { Settings: { WebhookURL: `http://127.0.0.1:${server.port}/webhook` } },
      { TriggerType: 'CLIENT_OFFLINE', EntityName: 'PC1', Severity: 'critical', Description: 'down' },
      loggerStub()
    );
    assert.equal(result.Success, true);
    const card = captured.attachments[0].content;
    assert.equal(card.type, 'AdaptiveCard');
    assert.equal(card.body[0].color, 'attention'); // critical -> attention
  } finally {
    await server.close();
  }
});

test('telegram-bot action validates token/chat and posts to the Bot API', async () => {
  // Execute targets the fixed api.telegram.org host, so mock the HTTP transport
  // to capture the request instead of hitting the network.
  let captured = null;
  const httpMock = {
    requestJson: async (opts) => {
      captured = opts;
      return { Success: true, StatusCode: 200, BodyText: '{"ok":true}', Error: null };
    },
  };
  const action = loadWithMocks(actionPath('telegram-bot.js'), { './_http-shared': httpMock });
  assert.equal(action.ID, 'telegram-bot');

  assert.throws(() => action.ValidateSettings({ ChatID: '1' }), /BotToken is required/);
  assert.throws(
    () => action.ValidateSettings({ BotToken: 'bogus', ChatID: '1' }),
    /BotToken format is invalid/
  );
  assert.throws(
    () => action.ValidateSettings({ BotToken: '123:ABC-def_1', ChatID: '' }),
    /ChatID is required/
  );
  assert.equal(action.ValidateSettings({ BotToken: '123:ABC-def_1', ChatID: '99' }), true);

  const result = await action.Execute(
    { Settings: { BotToken: '123:ABC-def_1', ChatID: '99' } },
    { TriggerType: 'CLIENT_OFFLINE', EntityName: 'PC1', Severity: 'critical', Description: 'down' },
    loggerStub()
  );
  assert.equal(result.Success, true);
  assert.equal(captured.Url, 'https://api.telegram.org/bot123:ABC-def_1/sendMessage');
  assert.equal(captured.Body.chat_id, '99');
  assert.equal(captured.Body.parse_mode, 'HTML');
  assert.match(captured.Body.text, /ShowTrak Alert/);
});

test('osc-trigger action interpolates message tokens and sends via node-osc', async () => {
  const sent = [];
  let closed = false;
  const oscMock = {
    Client: class {
      constructor(ip, port) {
        this.ip = ip;
        this.port = port;
      }
      send(msg, cb) {
        sent.push({ ip: this.ip, port: this.port, msg });
        cb();
      }
      close() {
        closed = true;
      }
    },
    Message: class {
      constructor(path) {
        this.path = path;
      }
    },
  };

  const action = loadWithMocks(actionPath('osc-trigger.js'), { 'node-osc': oscMock });
  assert.equal(action.ID, 'osc-trigger');

  // Normalization + validation.
  const norm = action.NormalizeSettings({ Port: 99999, Message: '' });
  assert.equal(norm.Port, 65535);
  assert.equal(norm.Message, '/API/Alert');
  assert.throws(() => action.ValidateSettings({ Message: 'no-slash' }), /must start with/);

  const result = await action.Execute(
    {
      Settings: {
        TargetIP: '127.0.0.1',
        Port: 3333,
        Message: '/alert/{{entityName}}/{{severity}}',
      },
    },
    { EntityName: 'PC1', Severity: 'warning' },
    loggerStub()
  );
  assert.equal(result.Success, true);
  assert.equal(sent[0].msg.path, '/alert/PC1/warning');
  assert.equal(closed, true);
});

test('osc-trigger action reports failures when the client throws', async () => {
  const oscMock = {
    Client: class {
      constructor() {
        throw new Error('socket failed');
      }
    },
    Message: class {},
  };
  const action = loadWithMocks(actionPath('osc-trigger.js'), { 'node-osc': oscMock });
  const result = await action.Execute({ Settings: {} }, {}, loggerStub());
  assert.equal(result.Success, false);
  assert.match(result.Error, /socket failed/);
});
