const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

// Covers dns.ts branches the network suite leaves untouched: object/array record
// normalization (MX/SRV/TXT), custom-resolver setServers failure, lookup
// rejection, empty result sets, and the no-records debug panel.

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

// Loads dns.js with a resolve() implementation and an optional Resolver class.
function loadDns({ resolve, Resolver } = {}) {
  const dnsMock = {
    promises: {
      resolve: resolve || (async () => ['1.2.3.4']),
      Resolver:
        Resolver ||
        class {
          setServers() {}
          resolve(...args) {
            return (resolve || (async () => ['1.2.3.4']))(...args);
          }
        },
    },
  };
  const netMock = { isIP: (v) => (/^\d+\.\d+\.\d+\.\d+$/.test(String(v)) ? 4 : 0) };
  return loadWithMocks(methodPath('dns.js'), { dns: dnsMock, net: netMock });
}

test('dns normalizes object records (MX/SRV) to JSON and array records by joining', async () => {
  const dns = loadDns({
    resolve: async (_addr, type) => {
      if (type === 'MX') return [{ exchange: 'mail.example.com', priority: 10 }];
      if (type === 'TXT') return [['v=spf1', ' include:_spf']];
      return ['1.2.3.4'];
    },
  });

  const mx = await dns.Run({ Address: 'example.com', Settings: { RecordType: 'MX' } });
  assert.equal(mx.Success, true);
  // Object record was JSON.stringify'd.
  assert.match(mx.Records[0], /"exchange":"mail\.example\.com"/);

  // TXT array-of-chunks is joined into a single string, matched by ExpectedValue.
  const txt = await dns.Run({
    Address: 'example.com',
    Settings: { RecordType: 'TXT', ExpectedValue: 'v=spf1' },
  });
  assert.equal(txt.Success, true);
  assert.equal(txt.Records[0], 'v=spf1 include:_spf');
});

test('dns reports an invalid resolver when setServers throws', async () => {
  const dns = loadDns({
    Resolver: class {
      setServers() {
        throw new Error('bad server spec');
      }
      resolve() {
        return Promise.resolve(['1.2.3.4']);
      }
    },
  });
  const result = await dns.Run({
    Address: 'example.com',
    Settings: { RecordType: 'A', Resolver: '9.9.9.9', ResolverPort: 53 },
  });
  assert.equal(result.Success, false);
  assert.match(result.Error, /Invalid resolver: bad server spec/);
});

test('dns surfaces a rejected lookup (e.g. NXDOMAIN / timeout) as a failure', async () => {
  const dns = loadDns({
    resolve: async () => {
      throw new Error('queryA ENOTFOUND example.invalid');
    },
  });
  const result = await dns.Run({ Address: 'example.invalid', Settings: { RecordType: 'A' } });
  assert.equal(result.Success, false);
  assert.match(result.Error, /ENOTFOUND/);
});

test('dns treats an empty record set as a failure', async () => {
  const dns = loadDns({ resolve: async () => [] });
  const result = await dns.Run({ Address: 'example.com', Settings: { RecordType: 'A' } });
  assert.equal(result.Success, false);
  assert.match(result.Error, /No DNS records returned/);
  assert.deepEqual(result.Records, []);
});

test('dns Debug renders the no-records branch with the error note', () => {
  const dns = loadDns();
  const html = dns.Debug(
    { Success: false, Error: 'No DNS records returned', RecordType: 'A', Records: [] },
    { Address: 'example.com', Settings: { RecordType: 'A' } }
  );
  assert.match(html, /Failed/);
  assert.match(html, /No DNS records returned/);
});
