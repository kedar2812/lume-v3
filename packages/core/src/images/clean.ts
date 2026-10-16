/**
 * A screenshot's bytes with only the picture left in them (spec 2026-10-16 §1.2: no colour profile, no metadata).
 * Browsers add their own: Chrome puts an sRGB colour profile in every canvas WebP and JPEG, and a JPEG from elsewhere
 * can carry EXIF or comments. Those parts go; the picture is untouched. Anything it can't read comes back as it was, for readImage
 * to judge.
 */
export function cleanImage(
  b: Uint8Array<ArrayBuffer>,
  type: "image/webp" | "image/jpeg",
): Uint8Array<ArrayBuffer> {
  return (type === "image/webp" ? cleanWebp(b) : cleanJpeg(b)) ?? b;
}

const le32 = (b: Uint8Array, at: number) =>
  (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
const WEBP_EXTRAS = new Set(["ICCP", "EXIF", "XMP "]);

function cleanWebp(b: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> | null {
  if (b.length < 12 || le32(b, 4) + 8 !== b.length) return null;
  const keep: Uint8Array<ArrayBuffer>[] = [];
  let dropped = false;
  for (let at = 12; at < b.length;) {
    if (at + 8 > b.length) return null;
    const len = le32(b, at + 4);
    const end = at + 8 + len + (len % 2);
    if (at + 8 + len > b.length) return null;
    const id = String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);
    if (WEBP_EXTRAS.has(id)) dropped = true;
    else keep.push(b.slice(at, Math.min(end, b.length)));
    at = end;
  }
  if (!dropped) return null;
  const out = new Uint8Array(12 + keep.reduce((n, c) => n + c.length, 0));
  out.set(b.subarray(0, 12));
  let at = 12;
  for (const c of keep) {
    // The extended header says what's in the file: now only transparency, if it was there.
    if (String.fromCharCode(c[0]!, c[1]!, c[2]!, c[3]!) === "VP8X") c[8] = c[8]! & 0x10;
    out.set(c, at);
    at += c.length;
  }
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return out;
}

function cleanJpeg(b: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const keep: Uint8Array<ArrayBuffer>[] = [b.subarray(0, 2)];
  let dropped = false;
  let at = 2;
  // Up to the first scan, a JPEG is a row of marked parts; after it, picture data, kept as it is.
  for (;;) {
    if (at + 4 > b.length || b[at] !== 0xff) return null;
    const marker = b[at + 1]!;
    const len = (b[at + 2]! << 8) | b[at + 3]!;
    if (len < 2 || at + 2 + len > b.length) return null;
    if (marker === 0xda) break;
    if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) dropped = true;
    else keep.push(b.subarray(at, at + 2 + len));
    at += 2 + len;
  }
  if (!dropped) return null;
  keep.push(b.subarray(at));
  const out = new Uint8Array(keep.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of keep) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
