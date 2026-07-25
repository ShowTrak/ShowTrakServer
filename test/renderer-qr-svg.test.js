const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/lib/qr-svg.ts — the self-contained QR encoder that
// renders straight to an SVG string (used by the "Scan to Open" modal for the
// Web UI URL). Loaded from dist-test/ (see test/renderer-utils.test.js for why).
//
// There is no reference implementation to diff against offline, so instead of
// asserting a golden output blob these tests decode the emitted SVG back into a
// module matrix and check the structural invariants that ANY conforming QR
// symbol must satisfy: symbol size, finder patterns, separators, timing
// patterns, the always-dark module, and the quiet zone. A broken port of the
// Reed-Solomon/masking stages would still have to keep all of those intact,
// and a broken port of the layout stages breaks them immediately.
const { QrToSvg } = require('../dist-test/UI/js/app/lib/qr-svg.js');

// --- SVG -> matrix ----------------------------------------------------------

/**
 * Parse a QrToSvg result back into { size, border, at(x, y) }.
 *
 * Each dark module is emitted as `M<x>,<y>h1v1h-1z` where the coordinates are
 * already offset by the quiet-zone border, so we subtract it back off.
 */
function decode(svg, border) {
  const ViewBox = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
  assert.ok(ViewBox, 'svg should carry a square viewBox');
  const Dim = Number(ViewBox[1]);
  assert.equal(Number(ViewBox[2]), Dim, 'viewBox should be square');

  const Size = Dim - border * 2;
  const Dark = new Set();
  const Path = svg.match(/<path d="([^"]*)"/);
  assert.ok(Path, 'svg should carry a path');
  for (const M of Path[1].matchAll(/M(\d+),(\d+)h1v1h-1z/g)) {
    Dark.add(`${Number(M[1]) - border},${Number(M[2]) - border}`);
  }

  return {
    size: Size,
    dim: Dim,
    darkCount: Dark.size,
    /** @returns {boolean} true when module (x=col, y=row) is dark */
    at: (x, y) => Dark.has(`${x},${y}`),
    /** Every drawn module, for quiet-zone checks. */
    all: () => Array.from(Dark, (k) => k.split(',').map(Number)),
  };
}

/** The 7x7 finder pattern: solid ring, light ring, solid 3x3 core. */
const FINDER = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];

function assertFinderAt(qr, originX, originY, label) {
  for (let dy = 0; dy < 7; dy++) {
    for (let dx = 0; dx < 7; dx++) {
      assert.equal(
        qr.at(originX + dx, originY + dy),
        FINDER[dy][dx] === '1',
        `${label} finder mismatch at offset ${dx},${dy}`
      );
    }
  }
}

// --- Symbol geometry --------------------------------------------------------

test('QrToSvg produces a version-1 21x21 symbol for a short string', () => {
  const Qr = decode(QrToSvg('HELLO', { border: 4 }), 4);
  // size = 4 * version + 17; version 1 => 21.
  assert.equal(Qr.size, 21);
  assert.equal(Qr.dim, 21 + 8);
});

test('QrToSvg grows the version as the payload grows, always to 4v+17', () => {
  const Seen = new Set();
  for (const Length of [1, 20, 60, 150, 400, 1200]) {
    const Qr = decode(QrToSvg('a'.repeat(Length), { border: 0 }), 0);
    assert.equal((Qr.size - 17) % 4, 0, `size ${Qr.size} is not 4v+17`);
    const Version = (Qr.size - 17) / 4;
    assert.ok(Version >= 1 && Version <= 40, `version ${Version} out of range`);
    Seen.add(Version);
  }
  // The versions must actually differ, or version selection is not happening.
  assert.ok(Seen.size > 1, 'expected more than one version across the size range');
});

test('QrToSvg counts UTF-8 bytes, not characters, when picking a version', () => {
  // Each of these is 3 UTF-8 bytes, so 200 of them need more capacity than 200
  // ASCII characters. If the encoder measured .length it would under-size.
  const Wide = decode(QrToSvg('★'.repeat(200), { border: 0 }), 0);
  const Ascii = decode(QrToSvg('a'.repeat(200), { border: 0 }), 0);
  assert.ok(Wide.size > Ascii.size, 'multi-byte payload should need a larger symbol');
});

// --- Function patterns ------------------------------------------------------

test('QrToSvg places the three finder patterns in the correct corners', () => {
  const Qr = decode(QrToSvg('https://showtrak.co.uk', { border: 4 }), 4);
  assertFinderAt(Qr, 0, 0, 'top-left');
  assertFinderAt(Qr, Qr.size - 7, 0, 'top-right');
  assertFinderAt(Qr, 0, Qr.size - 7, 'bottom-left');
});

test('QrToSvg leaves no fourth finder in the bottom-right corner', () => {
  // A real QR has exactly three; a fourth would mean the layout stage is wrong.
  const Qr = decode(QrToSvg('https://showtrak.co.uk', { border: 4 }), 4);
  let Matches = true;
  for (let dy = 0; dy < 7 && Matches; dy++) {
    for (let dx = 0; dx < 7 && Matches; dx++) {
      if (Qr.at(Qr.size - 7 + dx, Qr.size - 7 + dy) !== (FINDER[dy][dx] === '1')) Matches = false;
    }
  }
  assert.equal(Matches, false, 'bottom-right must not contain a finder pattern');
});

test('QrToSvg surrounds each finder with a light separator', () => {
  const Qr = decode(QrToSvg('SEPARATORS', { border: 4 }), 4);
  const Last = Qr.size - 1;
  for (let i = 0; i < 8; i++) {
    // Top-left: row 7 and column 7.
    assert.equal(Qr.at(i, 7), false, `top-left separator dark at (${i},7)`);
    assert.equal(Qr.at(7, i), false, `top-left separator dark at (7,${i})`);
    // Top-right: row 7 and column size-8.
    assert.equal(Qr.at(Last - i, 7), false, `top-right separator dark at (${Last - i},7)`);
    assert.equal(Qr.at(Qr.size - 8, i), false, `top-right separator dark at (${Qr.size - 8},${i})`);
    // Bottom-left: row size-8 and column 7.
    assert.equal(
      Qr.at(i, Qr.size - 8),
      false,
      `bottom-left separator dark at (${i},${Qr.size - 8})`
    );
    assert.equal(Qr.at(7, Last - i), false, `bottom-left separator dark at (7,${Last - i})`);
  }
});

test('QrToSvg lays the timing patterns along row 6 and column 6', () => {
  const Qr = decode(QrToSvg('TIMING PATTERN CHECK', { border: 4 }), 4);
  // Between the separators the timing pattern alternates, dark on even indices.
  for (let i = 8; i < Qr.size - 8; i++) {
    assert.equal(Qr.at(i, 6), i % 2 === 0, `horizontal timing wrong at column ${i}`);
    assert.equal(Qr.at(6, i), i % 2 === 0, `vertical timing wrong at row ${i}`);
  }
});

test('QrToSvg always sets the dark module at (8, size-8)', () => {
  // Required by the spec for every version and mask; a missing dark module is a
  // classic sign that format-info placement drifted.
  for (const Text of ['a', 'a'.repeat(100), 'a'.repeat(900)]) {
    const Qr = decode(QrToSvg(Text, { border: 0 }), 0);
    assert.equal(Qr.at(8, Qr.size - 8), true, `dark module missing for length ${Text.length}`);
  }
});

test('QrToSvg keeps the quiet zone clear and every module in bounds', () => {
  const Border = 4;
  const Qr = decode(QrToSvg('QUIET ZONE', { border: Border }), Border);
  for (const [x, y] of Qr.all()) {
    assert.ok(x >= 0 && x < Qr.size, `module x=${x} escaped the symbol`);
    assert.ok(y >= 0 && y < Qr.size, `module y=${y} escaped the symbol`);
  }
});

// --- Output shape and options ----------------------------------------------

test('QrToSvg emits a self-contained, accessible SVG root', () => {
  const Svg = QrToSvg('https://showtrak.co.uk');
  assert.match(Svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(Svg, /role="img"/);
  assert.match(Svg, /aria-label="QR code"/);
  assert.match(Svg, /shape-rendering="crispEdges"/);
  assert.match(Svg, /<\/svg>$/);
  // No external references, no script: it must render offline.
  assert.doesNotMatch(Svg, /<script|href=|xlink/i);
});

test('QrToSvg defaults to a 4-module quiet zone and honours a custom border', () => {
  assert.equal(decode(QrToSvg('BORDER'), 4).size, decode(QrToSvg('BORDER', { border: 0 }), 0).size);
  const Wide = QrToSvg('BORDER', { border: 10 });
  const Size = decode(Wide, 10).size;
  assert.match(Wide, new RegExp(`viewBox="0 0 ${Size + 20} ${Size + 20}"`));
});

test('QrToSvg omits width/height on the root unless an explicit size is given', () => {
  // Without a size the root carries only the viewBox, so the SVG scales to its
  // container. (Match the root specifically: the background <rect> legitimately
  // has width="100%".)
  assert.match(QrToSvg('SIZE'), /<svg [^>]*viewBox="0 0 \d+ \d+" stroke="none"/);
  assert.match(QrToSvg('SIZE', { size: 220 }), /viewBox="0 0 \d+ \d+" width="220" height="220"/);
});

test('QrToSvg applies custom foreground and background colours', () => {
  const Svg = QrToSvg('COLOURS', { dark: '#112233', light: '#fefefe' });
  assert.match(Svg, /<rect width="100%" height="100%" fill="#fefefe"\/>/);
  assert.match(Svg, /fill="#112233"/);
  // Defaults stay black on white.
  assert.match(QrToSvg('COLOURS'), /fill="#ffffff"/);
  assert.match(QrToSvg('COLOURS'), /fill="#000000"/);
});

// --- Determinism and error correction ---------------------------------------

test('QrToSvg is deterministic for the same input', () => {
  assert.equal(QrToSvg('https://showtrak.co.uk'), QrToSvg('https://showtrak.co.uk'));
});

test('QrToSvg produces different output for different payloads', () => {
  assert.notEqual(QrToSvg('one'), QrToSvg('two'));
});

test('QrToSvg honours the error-correction level', () => {
  // Higher ECC spends more codewords on recovery, so the same payload either
  // changes pattern or needs a bigger symbol — it must not be ignored.
  const Low = QrToSvg('a'.repeat(120), { ecc: 'LOW', border: 0 });
  const High = QrToSvg('a'.repeat(120), { ecc: 'HIGH', border: 0 });
  assert.notEqual(Low, High);
  assert.ok(decode(High, 0).size >= decode(Low, 0).size, 'HIGH ecc should not shrink the symbol');
});

test('QrToSvg encodes the empty string rather than throwing', () => {
  const Qr = decode(QrToSvg('', { border: 0 }), 0);
  assert.equal(Qr.size, 21);
  assertFinderAt(Qr, 0, 0, 'top-left');
});

test('QrToSvg rejects a payload that exceeds version 40 capacity', () => {
  // Byte mode at MEDIUM ecc tops out at 2331 bytes.
  assert.throws(() => QrToSvg('a'.repeat(3000)), /qr-data-too-long/);
  assert.doesNotThrow(() => QrToSvg('a'.repeat(2331)));
});
