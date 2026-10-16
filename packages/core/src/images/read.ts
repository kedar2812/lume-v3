/**
 * What a picture is, read from its bytes alone (no image library on the server): a WebP, or a canvas-made JPEG with
 * nothing else in it — no metadata (where it was taken, and with what), animation, colour profile or extra parts.
 * The caller decides what size it may be: a JPEG's size is judged at its frame header, before any picture data is read.
 */
export type ImageRead =
  | { ok: true; type: "image/webp" | "image/jpeg"; width: number; height: number }
  | { ok: false; reason: string };

const no = (reason: string): ImageRead => ({ ok: false, reason });
const fourcc = (b: Uint8Array, at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);
const le32 = (b: Uint8Array, at: number) =>
  (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
const le24 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);

export function readImage(
  b: Uint8Array,
  sizeOk: (w: number, h: number) => string | null = () => null,
): ImageRead {
  if (b.length >= 12 && fourcc(b, 0) === "RIFF" && fourcc(b, 8) === "WEBP") return readWebp(b, sizeOk);
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return readJpeg(b, sizeOk);
  return no("not a WebP or JPEG image");
}

function readWebp(b: Uint8Array, sizeOk: (w: number, h: number) => string | null): ImageRead {
  if (le32(b, 4) + 8 !== b.length) return no("the file's size doesn't match its header");
  let at = 12;
  let first = true;
  let extended = false;
  let pictures = 0;
  let size: [number, number] | null = null;
  while (at < b.length) {
    if (at + 8 > b.length) return no("a part is cut short");
    const id = fourcc(b, at);
    const len = le32(b, at + 4);
    const body = at + 8;
    if (body + len > b.length) return no("a part is cut short");
    if (id === "VP8X") {
      if (!first || len < 10) return no("an extended header out of place");
      const flags = b[body]!;
      if (flags & ~0x10) return no("animation, a colour profile or metadata"); // only "has alpha" may be set
      size = [le24(b, body + 4) + 1, le24(b, body + 7) + 1];
      extended = true;
    } else if (id === "ALPH") {
      if (!extended || pictures) return no("an alpha part out of place");
    } else if (id === "VP8 ") {
      if (len < 10 || b[body + 3] !== 0x9d || b[body + 4] !== 0x01 || b[body + 5] !== 0x2a)
        return no("a broken picture");
      const s: [number, number] = [
        (b[body + 6]! | (b[body + 7]! << 8)) & 0x3fff,
        (b[body + 8]! | (b[body + 9]! << 8)) & 0x3fff,
      ];
      if (size && (size[0] !== s[0] || size[1] !== s[1])) return no("sizes that disagree");
      size = s;
      pictures++;
    } else if (id === "VP8L") {
      if (len < 5 || b[body] !== 0x2f) return no("a broken picture");
      const bits = le32(b, body + 1);
      const s: [number, number] = [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
      if (size && (size[0] !== s[0] || size[1] !== s[1])) return no("sizes that disagree");
      size = s;
      pictures++;
    } else return no(`a part LUME doesn't keep (${id.trim()})`);
    first = false;
    at = body + len + (len % 2);
  }
  if (pictures !== 1 || !size) return no("not exactly one picture");
  const bad = sizeOk(size[0], size[1]);
  if (bad) return no(bad);
  return { ok: true, type: "image/webp", width: size[0], height: size[1] };
}

/** Markers a canvas-made JPEG has: JFIF, tables, one frame, scans. Anything else (EXIF, XMP, comments) is refused. */
const JPEG_ALLOWED = new Set([0xe0, 0xdb, 0xc4, 0xdd, 0xc0, 0xc1, 0xc2, 0xda]);

function readJpeg(b: Uint8Array, sizeOk: (w: number, h: number) => string | null): ImageRead {
  if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return no("cut short");
  let at = 2;
  let size: [number, number] | null = null;
  let scans = 0;
  while (at < b.length - 2) {
    if (b[at] !== 0xff) return no("a broken part");
    const marker = b[at + 1]!;
    if (marker >= 0xd0 && marker <= 0xd7) {
      at += 2; // a restart marker inside scan data
      continue;
    }
    if (!JPEG_ALLOWED.has(marker)) return no("metadata or a part LUME doesn't keep");
    if (at + 4 > b.length) return no("cut short");
    const len = (b[at + 2]! << 8) | b[at + 3]!;
    if (len < 2 || at + 2 + len > b.length) return no("cut short");
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (size) return no("two frames");
      size = [(b[at + 7]! << 8) | b[at + 8]!, (b[at + 5]! << 8) | b[at + 6]!];
      const bad = sizeOk(size[0], size[1]); // before any decoding
      if (bad) return no(bad);
    }
    at += 2 + len;
    if (marker === 0xda) {
      scans++;
      // The scan's data runs to the next marker that isn't a stuffed 0xFF00 or a restart.
      while (
        at < b.length - 2 &&
        !(b[at] === 0xff && b[at + 1] !== 0x00 && !(b[at + 1]! >= 0xd0 && b[at + 1]! <= 0xd7))
      )
        at++;
    }
  }
  if (!size) return no("no picture");
  if (!scans) return no("no picture data");
  return { ok: true, type: "image/jpeg", width: size[0], height: size[1] };
}
