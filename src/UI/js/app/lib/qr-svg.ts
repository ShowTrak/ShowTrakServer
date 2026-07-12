// Self-contained QR Code generator that renders directly to an SVG string.
//
// This replaces the previous approach of dynamically loading a vendored
// canvas-based library (davidshimjs/qrcodejs). That path was unreliable: it
// depended on a runtime <script> fetch, rendered to <canvas>/<img> (timing- and
// environment-sensitive), and the code even mixed in a second library's API
// (createDataURL) that was never loaded. Here everything is pure computation in
// TypeScript with an SVG string as output — no async, no canvas, no globals.
//
// Algorithm ported from Project Nayuki's "QR Code generator" (MIT License):
//   https://www.nayuki.io/page/qr-code-generator-library
// Copyright (c) Project Nayuki. Adapted for ShowTrak (byte-mode + SVG output).
//
// Leaf module: must not import from any app module.

// --- Error correction level -------------------------------------------------

export type Ecc = 'LOW' | 'MEDIUM' | 'QUARTILE' | 'HIGH';

const ECC_FORMAT_BITS: Record<Ecc, number> = { LOW: 1, MEDIUM: 0, QUARTILE: 3, HIGH: 2 };

// --- Public entry point -----------------------------------------------------

// Encode `text` and return a complete, self-contained SVG string. `border` is
// the quiet-zone width in modules; `dark`/`light` are CSS colours; `size`, when
// given, sets explicit width/height (px) on the root — otherwise the SVG scales
// to its container via the viewBox alone.
export function QrToSvg(
  text: string,
  opts: { border?: number; dark?: string; light?: string; ecc?: Ecc; size?: number } = {}
): string {
  const border = opts.border ?? 4;
  const dark = opts.dark ?? '#000000';
  const light = opts.light ?? '#ffffff';
  const ecc = opts.ecc ?? 'MEDIUM';
  const qr = encodeText(text, ecc);
  const count = qr.length;
  const dim = count + border * 2;

  let path = '';
  for (let y = 0; y < count; y++) {
    for (let x = 0; x < count; x++) {
      if (qr[y][x]) {
        if (path) path += ' ';
        path += `M${x + border},${y + border}h1v1h-1z`;
      }
    }
  }

  const sizeAttr = opts.size ? ` width="${opts.size}" height="${opts.size}"` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}"${sizeAttr} ` +
    `stroke="none" shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="100%" height="100%" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/>` +
    `</svg>`
  );
}

// --- Encoder ----------------------------------------------------------------

// Returns a square boolean matrix (true = dark module) for the given text using
// byte mode. Automatically selects the smallest version (1..40) that fits.
function encodeText(text: string, ecc: Ecc): boolean[][] {
  const data = utf8Bytes(text);

  // Build the byte-mode data segment bit buffer (without version-dependent
  // length prefix yet — length header width depends on the chosen version).
  let version = 1;
  let dataCapacityBits = 0;
  for (; version <= 40; version++) {
    dataCapacityBits = getNumDataCodewords(version, ecc) * 8;
    const charCountBits = version < 10 ? 8 : 16; // byte mode
    const usedBits = 4 + charCountBits + data.length * 8;
    if (usedBits <= dataCapacityBits) break;
  }
  if (version > 40) throw new Error('qr-data-too-long');

  const charCountBits = version < 10 ? 8 : 16;
  const bb: number[] = [];
  appendBits(0x4, 4, bb); // mode indicator: byte mode
  appendBits(data.length, charCountBits, bb);
  for (const b of data) appendBits(b, 8, bb);

  // Terminator + bit padding to a byte boundary.
  appendBits(0, Math.min(4, dataCapacityBits - bb.length), bb);
  appendBits(0, (8 - (bb.length % 8)) % 8, bb);

  // Pad bytes alternating 0xEC / 0x11 until capacity is filled.
  for (let pad = 0xec; bb.length < dataCapacityBits; pad ^= 0xec ^ 0x11) {
    appendBits(pad, 8, bb);
  }

  // Pack bits into data codewords.
  const dataCodewords = new Array<number>(bb.length / 8).fill(0);
  bb.forEach((bit, i) => (dataCodewords[i >>> 3] |= bit << (7 - (i & 7))));

  const allCodewords = addEccAndInterleave(dataCodewords, version, ecc);
  return renderMatrix(version, ecc, allCodewords);
}

function utf8Bytes(str: string): number[] {
  // TextEncoder is available in every renderer/browser this app targets.
  return Array.from(new TextEncoder().encode(str));
}

function appendBits(val: number, len: number, out: number[]): void {
  for (let i = len - 1; i >= 0; i--) out.push((val >>> i) & 1);
}

// --- Error correction & interleaving ---------------------------------------

function addEccAndInterleave(data: number[], version: number, ecc: Ecc): number[] {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ECC_ORDINAL[ecc]][version];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ECC_ORDINAL[ecc]][version];
  const rawCodewords = Math.floor(getNumRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks: number[][] = [];
  const rsDiv = reedSolomonComputeDivisor(blockEccLen);
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.slice(k, k + datLen);
    k += datLen;
    const ecCodewords = reedSolomonComputeRemainder(dat, rsDiv);
    const block = dat.slice();
    if (i < numShortBlocks) block.push(0); // pad so all blocks are equal length
    block.push(...ecCodewords);
    blocks.push(block);
  }

  // Interleave the codewords from every block.
  const result: number[] = [];
  const maxLen = shortBlockLen + 1;
  for (let i = 0; i < maxLen; i++) {
    blocks.forEach((block, j) => {
      // Skip the padding position of short blocks in the data region.
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
        result.push(block[i]);
      }
    });
  }
  return result;
}

// --- Reed–Solomon (GF(2^8), 0x11D) -----------------------------------------

function reedSolomonComputeDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function reedSolomonComputeRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => (result[i] ^= gfMul(coef, factor)));
  }
  return result;
}

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

// --- Matrix construction ----------------------------------------------------

function renderMatrix(version: number, ecc: Ecc, allCodewords: number[]): boolean[][] {
  const size = version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFunction: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  const setFunction = (x: number, y: number, dark: boolean) => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };

  // Timing patterns.
  for (let i = 0; i < size; i++) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }

  // Finder patterns (+ separators) at the three corners.
  drawFinder(3, 3, size, setFunction);
  drawFinder(size - 4, 3, size, setFunction);
  drawFinder(3, size - 4, size, setFunction);

  // Alignment patterns.
  const alignPositions = alignmentPatternPositions(version);
  const numAlign = alignPositions.length;
  for (let i = 0; i < numAlign; i++) {
    for (let j = 0; j < numAlign; j++) {
      // Skip the three corners occupied by finder patterns.
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === numAlign - 1) ||
        (i === numAlign - 1 && j === 0)
      )
        continue;
      drawAlignment(alignPositions[i], alignPositions[j], setFunction);
    }
  }

  // Reserve format/version areas as function modules (values set later).
  drawFormatBits(ecc, 0, size, setFunction, true);
  if (version >= 7) drawVersionBits(version, size, setFunction);

  // Draw data + error-correction codewords in the zig-zag pattern.
  drawCodewords(allCodewords, modules, isFunction, size);

  // Pick the mask that minimises penalty, then apply it and stamp format bits.
  let bestMask = 0;
  let minPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask, modules, isFunction, size);
    drawFormatBits(ecc, mask, size, (x, y, dark) => (modules[y][x] = dark), false);
    const penalty = computePenalty(modules, size);
    if (penalty < minPenalty) {
      minPenalty = penalty;
      bestMask = mask;
    }
    applyMask(mask, modules, isFunction, size); // undo (XOR is its own inverse)
  }
  applyMask(bestMask, modules, isFunction, size);
  drawFormatBits(ecc, bestMask, size, (x, y, dark) => (modules[y][x] = dark), false);

  return modules;
}

type SetFn = (x: number, y: number, dark: boolean) => void;

function drawFinder(cx: number, cy: number, size: number, set: SetFn): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const x = cx + dx;
      const y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) {
        set(x, y, dist !== 2 && dist !== 4);
      }
    }
  }
}

function drawAlignment(cx: number, cy: number, set: SetFn): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function alignmentPatternPositions(version: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  // Positions are 6 and (size-7), with the interior ones evenly spaced. The
  // step must round UP to an even number — using floor here places the interior
  // patterns wrong for versions where the division isn't exact (v15 was the
  // first such case). Version 32 is a documented spec exception.
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = version * 4 + 10; result.length < numAlign; pos -= step) {
    result.splice(1, 0, pos);
  }
  return result;
}

function drawFormatBits(
  ecc: Ecc,
  mask: number,
  size: number,
  set: SetFn,
  reserveOnly: boolean
): void {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;

  const bit = (i: number) => (reserveOnly ? true : ((bits >>> i) & 1) !== 0);
  // First copy (around the top-left finder).
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  // Second copy (split across the other two finders).
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true); // always-dark module
}

function drawVersionBits(version: number, size: number, set: SetFn): void {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) !== 0;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    set(a, b, dark);
    set(b, a, dark);
  }
}

function drawCodewords(
  codewords: number[],
  modules: boolean[][],
  isFunction: boolean[][],
  size: number
): void {
  let i = 0; // bit index into codewords
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && i < codewords.length * 8) {
          modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }
}

function applyMask(mask: number, modules: boolean[][], isFunction: boolean[][], size: number): void {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (isFunction[y][x]) continue;
      let invert = false;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      }
      if (invert) modules[y][x] = !modules[y][x];
    }
  }
}

function computePenalty(modules: boolean[][], size: number): number {
  let penalty = 0;

  // Rule 1: runs of 5+ same-colour modules in rows and columns.
  for (let y = 0; y < size; y++) {
    let runColor = false;
    let runLen = 0;
    for (let x = 0; x < size; x++) {
      if (modules[y][x] === runColor) {
        runLen++;
        if (runLen === 5) penalty += 3;
        else if (runLen > 5) penalty++;
      } else {
        runColor = modules[y][x];
        runLen = 1;
      }
    }
  }
  for (let x = 0; x < size; x++) {
    let runColor = false;
    let runLen = 0;
    for (let y = 0; y < size; y++) {
      if (modules[y][x] === runColor) {
        runLen++;
        if (runLen === 5) penalty += 3;
        else if (runLen > 5) penalty++;
      } else {
        runColor = modules[y][x];
        runLen = 1;
      }
    }
  }

  // Rule 2: 2x2 blocks of the same colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
        penalty += 3;
      }
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 patterns in rows and columns.
  const pat1 = [true, false, true, true, true, false, true, false, false, false, false];
  const pat2 = [false, false, false, false, true, false, true, true, true, false, true];
  const matches = (get: (i: number) => boolean, start: number, pat: boolean[]) => {
    for (let k = 0; k < pat.length; k++) if (get(start + k) !== pat[k]) return false;
    return true;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x <= size - 11; x++) {
      if (matches((i) => modules[y][i], x, pat1) || matches((i) => modules[y][i], x, pat2)) {
        penalty += 40;
      }
    }
  }
  for (let x = 0; x < size; x++) {
    for (let y = 0; y <= size - 11; y++) {
      if (matches((i) => modules[i][x], y, pat1) || matches((i) => modules[i][x], y, pat2)) {
        penalty += 40;
      }
    }
  }

  // Rule 4: proportion of dark modules deviating from 50%, in 5% steps.
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (modules[y][x]) dark++;
  const total = size * size;
  const k = Math.abs(Math.ceil(((dark * 100) / total) / 5) - 10);
  penalty += k * 10;

  return penalty;
}

// --- Capacity tables --------------------------------------------------------

const ECC_ORDINAL: Record<Ecc, number> = { LOW: 0, MEDIUM: 1, QUARTILE: 2, HIGH: 3 };

// [eccOrdinal][version] — index 0 of the inner arrays is unused (versions 1..40).
// prettier-ignore
const ECC_CODEWORDS_PER_BLOCK: number[][] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
// prettier-ignore
const NUM_ERROR_CORRECTION_BLOCKS: number[][] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

function getNumRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function getNumDataCodewords(version: number, ecc: Ecc): number {
  const e = ECC_ORDINAL[ecc];
  return (
    Math.floor(getNumRawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[e][version] * NUM_ERROR_CORRECTION_BLOCKS[e][version]
  );
}
