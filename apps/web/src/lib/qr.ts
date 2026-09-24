/**
 * A small QR encoder: byte mode, error-correction level M, versions 1–10, mask pattern 0.
 *
 * Local on purpose. The only QR code LUME draws holds a TOTP secret, and a secret must never be
 * handed to a QR web service — not even over HTTPS, because it would then exist on someone else's
 * machine (report §12.5). Byte mode alone keeps this small; it costs a slightly larger code for
 * all-uppercase text, which an otpauth:// URI never is.
 *
 * Reference: ISO/IEC 18004. The output was checked module-for-module against an independent
 * implementation (node-qrcode, byte mode, level M, mask 0) for every length from 1 to 213 and
 * decoded back with jsQR; `qr.test.ts` pins one of those matrices so a refactor can't quietly
 * produce a code no phone can read.
 */

// ── GF(256) with the QR primitive polynomial 0x11d ───────────────────────────────────────────────
const EXP = new Uint8Array(256);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
const gfMul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[(LOG[a]! + LOG[b]!) % 255]!);

const polyMul = (a: number[], b: number[]): number[] => {
  const out = new Array<number>(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) out[i + j]! ^= gfMul(a[i]!, b[j]!);
  return out;
};

/** The Reed–Solomon generator polynomial ∏(x − α^i), whose remainder is the error correction. */
const rsGenerator = (degree: number): number[] => {
  let poly = [1];
  for (let i = 0; i < degree; i++) poly = polyMul(poly, [1, EXP[i]!]);
  return poly;
};

const rsRemainder = (data: number[], degree: number): number[] => {
  const gen = rsGenerator(degree);
  const out = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ out[0]!;
    out.shift();
    out.push(0);
    for (let i = 0; i < degree; i++) out[i]! ^= gfMul(gen[i + 1]!, factor);
  }
  return out;
};

// ── The bits of the standard we need ─────────────────────────────────────────────────────────────
/** ISO/IEC 18004 table 13–22, level M: EC codewords per block, and [block count, data codewords]. */
const SPECS: Record<number, { ec: number; blocks: [number, number][] }> = {
  1: { ec: 10, blocks: [[1, 16]] },
  2: { ec: 16, blocks: [[1, 28]] },
  3: { ec: 26, blocks: [[1, 44]] },
  4: { ec: 18, blocks: [[2, 32]] },
  5: { ec: 24, blocks: [[2, 43]] },
  6: { ec: 16, blocks: [[4, 27]] },
  7: { ec: 18, blocks: [[4, 31]] },
  8: {
    ec: 22,
    blocks: [
      [2, 38],
      [2, 39],
    ],
  },
  9: {
    ec: 22,
    blocks: [
      [3, 36],
      [2, 37],
    ],
  },
  10: {
    ec: 26,
    blocks: [
      [4, 43],
      [1, 44],
    ],
  },
};
/** Alignment pattern centres (ISO/IEC 18004 table E.1). */
const ALIGN: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};
const VERSIONS = Object.keys(SPECS).map(Number);

const specOf = (version: number) => SPECS[version]!;
const dataCodewords = (version: number): number =>
  specOf(version).blocks.reduce((n, [count, size]) => n + count * size, 0);
/** The character-count field is 8 bits up to version 9 and 16 bits from version 10. */
const countBits = (version: number): number => (version < 10 ? 8 : 16);
const capacity = (version: number): number =>
  Math.floor((dataCodewords(version) * 8 - 4 - countBits(version)) / 8);

/** BCH remainder, used for the format and version information. */
const bch = (data: number, poly: number, bits: number): number => {
  const width = (n: number) => (n === 0 ? 0 : 32 - Math.clz32(n));
  let d = data << bits;
  while (width(d) >= width(poly)) d ^= poly << (width(d) - width(poly));
  return d;
};
/** 15 format bits: EC level M is 0b00, so the data is the mask pattern alone. */
const formatBits = (mask: number): number => (((mask << 10) | bch(mask, 0x537, 10)) ^ 0x5412) >>> 0;
const versionBits = (version: number): number => (version << 12) | bch(version, 0x1f25, 12);

/** The data and error-correction codewords, interleaved block by block as the standard requires. */
function codewords(text: string, version: number): number[] {
  const bytes = [...new TextEncoder().encode(text)];
  const bits: number[] = [];
  const push = (value: number, width: number) => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, countBits(version));
  for (const b of bytes) push(b, 8);
  const room = dataCodewords(version) * 8;
  for (let i = 0; i < 4 && bits.length < room; i++) bits.push(0); // terminator
  while (bits.length % 8 !== 0) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((n, b) => (n << 1) | b, 0));
  for (let i = 0; data.length < dataCodewords(version); i++) data.push(i % 2 === 0 ? 0xec : 0x11); // pad bytes

  const spec = specOf(version);
  const blocks: { data: number[]; ec: number[] }[] = [];
  let at = 0;
  for (const [count, size] of spec.blocks)
    for (let i = 0; i < count; i++) {
      const block = data.slice(at, at + size);
      at += size;
      blocks.push({ data: block, ec: rsRemainder(block, spec.ec) });
    }
  const out: number[] = [];
  const widest = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < widest; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]!);
  for (let i = 0; i < spec.ec; i++) for (const b of blocks) out.push(b.ec[i]!);
  return out;
}

/** Function patterns, then the zig-zag data placement, with mask pattern 0 applied as it goes. */
function place(version: number, data: number[]): boolean[][] {
  const n = 17 + 4 * version;
  const m: (boolean | null)[][] = Array.from({ length: n }, () => new Array<boolean | null>(n).fill(null));
  const finder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r++)
      for (let c = -1; c <= 7; c++) {
        if (row + r < 0 || row + r >= n || col + c < 0 || col + c >= n) continue;
        m[row + r]![col + c] =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      }
  };
  finder(0, 0); // with its separator, which is why the loop starts at −1
  finder(0, n - 7);
  finder(n - 7, 0);
  const centres = ALIGN[version]!;
  for (const row of centres)
    for (const col of centres) {
      if (m[row]![col] !== null) continue; // where it would sit on a finder pattern
      for (let r = -2; r <= 2; r++)
        for (let c = -2; c <= 2; c++)
          m[row + r]![col + c] = r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
    }
  for (let i = 8; i < n - 8; i++) {
    if (m[i]![6] === null) m[i]![6] = i % 2 === 0; // timing patterns
    if (m[6]![i] === null) m[6]![i] = i % 2 === 0;
  }
  const format = formatBits(0);
  for (let i = 0; i < 15; i++) {
    const bit = ((format >> i) & 1) === 1;
    if (i < 6) m[i]![8] = bit;
    else if (i < 8) m[i + 1]![8] = bit;
    else m[n - 15 + i]![8] = bit;
    if (i < 8) m[8]![n - i - 1] = bit;
    else if (i < 9) m[8]![15 - i] = bit;
    else m[8]![14 - i] = bit;
  }
  m[n - 8]![8] = true; // the dark module
  if (version >= 7) {
    const info = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = ((info >> i) & 1) === 1;
      m[Math.floor(i / 3)]![(i % 3) + n - 11] = bit;
      m[(i % 3) + n - 11]![Math.floor(i / 3)] = bit;
    }
  }
  let bitIndex = 7;
  let byteIndex = 0;
  let row = n - 1;
  let inc = -1;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--; // the vertical timing pattern is not a data column
    for (;;) {
      for (let c = 0; c < 2; c++) {
        if (m[row]![col - c] !== null) continue;
        let dark = byteIndex < data.length && ((data[byteIndex]! >>> bitIndex) & 1) === 1;
        if ((row + col - c) % 2 === 0) dark = !dark; // mask pattern 0
        m[row]![col - c] = dark;
        if (--bitIndex < 0) {
          byteIndex++;
          bitIndex = 7;
        }
      }
      row += inc;
      if (row < 0 || row >= n) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }
  return m.map((r) => r.map((cell) => cell === true));
}

/** The smallest version that holds `text`, as a matrix of modules; `true` is dark. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text).length;
  const version = VERSIONS.find((v) => capacity(v) >= bytes);
  if (version === undefined) throw new Error(`qrMatrix: ${bytes} bytes is more than version 10 holds`);
  return place(version, codewords(text, version));
}

/** One SVG path in module units, so the code scales to any size without a second pass. */
export function qrPath(matrix: boolean[][]): string {
  const parts: string[] = [];
  matrix.forEach((row, r) => row.forEach((dark, c) => dark && parts.push(`M${c} ${r}h1v1h-1z`)));
  return parts.join("");
}
