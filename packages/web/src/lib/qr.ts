/**
 * A small, dependency-free QR code encoder (ISO/IEC 18004), enough for a pairing URL: byte mode, error
 * correction level M, versions 1–10 (up to 213 bytes). Reed–Solomon over GF(256), BCH format and version
 * information, all eight masks scored with the standard penalty rules. The layout follows the spec and
 * Project Nayuki's reference implementation.
 *
 * `encodeQr(text)` returns the module matrix (true = dark), without the quiet zone.
 */

// Per version 1–10, level M: [EC codewords per block, blocks in group 1, data codewords each, blocks in group 2, data codewords each].
const M_BLOCKS: readonly (readonly [number, number, number, number, number])[] = [
  [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
];
const ALIGN: readonly (readonly number[])[] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];
/** Format bits for level M are 00. */
const EC_M = 0;

// ---- GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1 ----
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Generator polynomial of the given degree, highest coefficient first (the leading 1 omitted). */
function rsGenerator(degree: number): number[] {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = next;
  }
  return g.slice(1);
}

/** The `degree` Reed–Solomon EC codewords for `data`. Exported for tests. */
export function rsRemainder(data: readonly number[], degree: number): number[] {
  const gen = rsGenerator(degree);
  const rem = new Array<number>(degree).fill(0);
  for (const b of data) {
    const factor = b ^ rem.shift()!;
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] ^= mul(gen[i], factor);
  }
  return rem;
}

/** 15 format bits (EC level + mask, BCH-protected, XOR-masked). Exported for tests. */
export function formatBits(ec: number, mask: number): number {
  const data = (ec << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** 18 version bits for version >= 7. Exported for tests. */
export function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

function dataCapacity(v: number): number {
  const [, b1, d1, b2, d2] = M_BLOCKS[v - 1];
  return b1 * d1 + b2 * d2;
}

/** Data codewords: mode, count, bytes, terminator, padding. */
function dataCodewords(bytes: Uint8Array, v: number): number[] {
  const cap = dataCapacity(v) * 8;
  const bits: number[] = [];
  const put = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, v <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; out.length < cap / 8; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

/** Split into blocks, add EC to each, interleave. */
function withEc(data: number[], v: number): number[] {
  const [ecLen, b1, d1, b2, d2] = M_BLOCKS[v - 1];
  const blocks: number[][] = [];
  let k = 0;
  for (let i = 0; i < b1 + b2; i++) {
    const len = i < b1 ? d1 : d2;
    blocks.push(data.slice(k, k + len));
    k += len;
  }
  const ecs = blocks.map((b) => rsRemainder(b, ecLen));
  const out: number[] = [];
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecLen; i++) for (const e of ecs) out.push(e[i]);
  return out;
}

class Grid {
  readonly size: number;
  readonly m: boolean[][];
  readonly fn: boolean[][];
  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.m = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fn = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }
  /** x = column, y = row. */
  setFn(x: number, y: number, dark: boolean) {
    this.m[y][x] = dark;
    this.fn[y][x] = true;
  }
}

function drawFunctionPatterns(g: Grid) {
  const n = g.size;
  for (let i = 0; i < n; i++) {
    g.setFn(6, i, i % 2 === 0);
    g.setFn(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        g.setFn(x, y, d !== 2 && d !== 4);
      }
    }
  };
  finder(3, 3);
  finder(n - 4, 3);
  finder(3, n - 4);
  const pos = ALIGN[g.version - 1];
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      // Skip the three that would sit on a finder.
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) g.setFn(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  drawFormat(g, 0); // reserve; real bits drawn after masking
  if (g.version >= 7) {
    const bits = versionBits(g.version);
    for (let i = 0; i < 18; i++) {
      const a = n - 11 + (i % 3);
      const b = Math.floor(i / 3);
      g.setFn(a, b, bit(bits, i));
      g.setFn(b, a, bit(bits, i));
    }
  }
}

function drawFormat(g: Grid, mask: number) {
  const bits = formatBits(EC_M, mask);
  const n = g.size;
  for (let i = 0; i <= 5; i++) g.setFn(8, i, bit(bits, i));
  g.setFn(8, 7, bit(bits, 6));
  g.setFn(8, 8, bit(bits, 7));
  g.setFn(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i++) g.setFn(14 - i, 8, bit(bits, i));
  for (let i = 0; i < 8; i++) g.setFn(n - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i++) g.setFn(8, n - 15 + i, bit(bits, i));
  g.setFn(8, n - 8, true); // the dark module
}

function drawCodewords(g: Grid, cw: number[]) {
  const n = g.size;
  let i = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? n - 1 - vert : vert;
        if (!g.fn[y][x] && i < cw.length * 8) {
          g.m[y][x] = bit(cw[i >>> 3], 7 - (i & 7));
          i++;
        }
      }
    }
  }
}

function maskHit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(g: Grid, mask: number) {
  for (let y = 0; y < g.size; y++) for (let x = 0; x < g.size; x++) if (!g.fn[y][x] && maskHit(mask, x, y)) g.m[y][x] = !g.m[y][x];
}

/** The four standard penalty rules (lower is better). */
function penalty(m: boolean[][]): number {
  const n = m.length;
  let p = 0;
  const line = (get: (i: number) => boolean) => {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && get(i) === get(i - 1)) run++;
      else {
        if (run >= 5) p += run - 2;
        run = 1;
      }
    }
    // 1:1:3:1:1 finder look-alikes with four light modules on one side.
    for (let i = 0; i + 11 <= n; i++) {
      const s = Array.from({ length: 11 }, (_, k) => get(i + k));
      const a = [true, false, true, true, true, false, true, false, false, false, false];
      const b = [false, false, false, false, true, false, true, true, true, false, true];
      if (s.every((v, k) => v === a[k]) || s.every((v, k) => v === b[k])) p += 40;
    }
  };
  for (let y = 0; y < n; y++) line((i) => m[y][i]);
  for (let x = 0; x < n; x++) line((i) => m[i][x]);
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
    const c = m[y][x];
    if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
  }
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  p += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return p;
}

/**
 * Encode `text` (UTF-8, byte mode, level M) in the smallest version 1–10 that fits. `forceMask` is for tests.
 * Throws when the text is longer than version 10 holds.
 */
export function encodeQr(text: string, forceMask?: number): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  let v = 1;
  while (v <= 10 && 4 + (v <= 9 ? 8 : 16) + bytes.length * 8 > dataCapacity(v) * 8) v++;
  if (v > 10) throw new Error('Text too long for a QR code here (' + bytes.length + ' bytes)');
  const cw = withEc(dataCodewords(bytes, v), v);
  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    if (forceMask !== undefined && mask !== forceMask) continue;
    const g = new Grid(v);
    drawFunctionPatterns(g);
    drawCodewords(g, cw);
    applyMask(g, mask);
    drawFormat(g, mask);
    const score = penalty(g.m);
    if (score < bestScore) {
      bestScore = score;
      best = g.m;
    }
  }
  return best!;
}
