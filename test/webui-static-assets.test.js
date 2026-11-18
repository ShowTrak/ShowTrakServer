const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const express = require('express');

const { CreateWebUiAssetHandler } = require('../dist/Modules/Server/static-assets');

// The Web UI's text assets are served compressed (brotli or gzip, as the
// browser accepts), with validators for 304s, `no-cache` on everything that
// changes with a release, and a year's cache only on vendor files requested
// with the current version.

function makeRoot() {
  const Root = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-webui-'));
  fs.mkdirSync(path.join(Root, 'vendors', 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(Root, 'index.html'),
    '<html><script src="./vendors/lib/lib.js" defer></script><script src="./main.js"></script>' +
      '<!--' +
      'x'.repeat(4000) +
      '--></html>'
  );
  fs.writeFileSync(path.join(Root, 'main.js'), `console.log(${JSON.stringify('y'.repeat(5000))});`);
  fs.writeFileSync(path.join(Root, 'vendors', 'lib', 'lib.js'), `var lib = "${'z'.repeat(3000)}";`);
  fs.writeFileSync(path.join(Root, 'tiny.css'), 'a{}');
  fs.writeFileSync(path.join(Root, 'logo.png'), Buffer.from([137, 80, 78, 71]));
  test.after(() => fs.rmSync(Root, { recursive: true, force: true }));
  return Root;
}

async function serve(Root, VersionTag) {
  const app = express();
  app.use(CreateWebUiAssetHandler(Root, { VersionTag }));
  app.use(express.static(Root));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  test.after(() => server.close());
  const { port } = server.address();
  return (urlPath, headers = {}) =>
    new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
        })
        .on('error', reject);
    });
}

test('text assets are compressed for clients that accept it, and only then', async () => {
  const Root = makeRoot();
  const get = await serve(Root, '');
  const original = fs.readFileSync(path.join(Root, 'main.js'));

  const br = await get('/main.js', { 'accept-encoding': 'gzip, deflate, br' });
  assert.equal(br.res.statusCode, 200);
  assert.equal(br.res.headers['content-encoding'], 'br');
  assert.equal(br.res.headers.vary, 'Accept-Encoding');
  assert.match(br.res.headers['content-type'], /javascript/);
  assert.ok(br.body.length < original.length / 4);
  assert.deepEqual(zlib.brotliDecompressSync(br.body), original);

  const gz = await get('/main.js', { 'accept-encoding': 'gzip' });
  assert.equal(gz.res.headers['content-encoding'], 'gzip');
  assert.deepEqual(zlib.gunzipSync(gz.body), original);

  const plain = await get('/main.js');
  assert.equal(plain.res.headers['content-encoding'], undefined);
  assert.deepEqual(plain.body, original);
  assert.equal(plain.res.headers['cache-control'], 'no-cache');

  // Each encoding has its own validator, and a matching one gets a 304.
  assert.notEqual(br.res.headers.etag, gz.res.headers.etag);
  const again = await get('/main.js', {
    'accept-encoding': 'br',
    'if-none-match': br.res.headers.etag,
  });
  assert.equal(again.res.statusCode, 304);
  assert.equal(again.body.length, 0);

  // Too small to be worth it: served as is.
  const tiny = await get('/tiny.css', { 'accept-encoding': 'br' });
  assert.equal(tiny.res.headers['content-encoding'], undefined);
  assert.equal(tiny.body.toString(), 'a{}');

  // Binary assets fall through to express.static untouched.
  const png = await get('/logo.png', { 'accept-encoding': 'br' });
  assert.equal(png.res.headers['content-encoding'], undefined);
  assert.equal(png.body.length, 4);

  // Paths outside the root, and dotfiles, are never served by the handler.
  const escape = await get('/..%2f..%2fetc%2fpasswd.js');
  assert.equal(escape.res.statusCode, 404);
});

test('vendor URLs carry the server version and only then cache for a year', async () => {
  const Root = makeRoot();
  const get = await serve(Root, '3.31.1');

  const page = await get('/', { 'accept-encoding': 'gzip' });
  const html = zlib.gunzipSync(page.body).toString();
  assert.match(html, /src="\.\/vendors\/lib\/lib\.js\?v=3\.31\.1"/);
  assert.match(html, /src="\.\/main\.js"/, 'the app bundle is not versioned');
  assert.equal(page.res.headers['cache-control'], 'no-cache');

  const versioned = await get('/vendors/lib/lib.js?v=3.31.1');
  assert.equal(versioned.res.headers['cache-control'], 'public, max-age=31536000, immutable');

  // An older page's request (another version, or none) revalidates instead.
  const stale = await get('/vendors/lib/lib.js?v=3.30.0');
  assert.equal(stale.res.headers['cache-control'], 'no-cache');
  const bare = await get('/vendors/lib/lib.js');
  assert.equal(bare.res.headers['cache-control'], 'no-cache');
});

test('a file changed on disk is served fresh (a dev rebuild)', async () => {
  const Root = makeRoot();
  const get = await serve(Root, '');
  const first = await get('/main.js');
  fs.writeFileSync(path.join(Root, 'main.js'), `console.log(${JSON.stringify('w'.repeat(6000))});`);
  const second = await get('/main.js');
  assert.notEqual(first.res.headers.etag, second.res.headers.etag);
  assert.match(second.body.toString(), /w{6000}/);
});
