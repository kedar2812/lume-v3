/**
 * Each person's look (7C, canvas Profile): their initials on a colour, or a photo they lined up. The browser crops
 * and encodes the photo (a 256 px square); the API takes it only if it's exactly that and nothing more — the size
 * read from the header before anything decodes it, and no metadata (where it was taken, and with what), animation
 * or extra parts. Pure byte checks: no image library on the server.
 */

/** Deep enough that white initials reach 4.5:1 on every one (WCAG AA). No violet (owner, 2026-10-01). */
export const AVATAR_COLORS = {
  red: "#C62A30",
  amber: "#A15C00",
  blue: "#2A5BFF",
  green: "#0F7F44",
  rose: "#B02E6B",
  teal: "#0B7285",
} as const;
export type AvatarColor = keyof typeof AVATAR_COLORS;
export const isAvatarColor = (v: unknown): v is AvatarColor =>
  typeof v === "string" && Object.hasOwn(AVATAR_COLORS, v);

export const AVATAR_SIZE = 256;
export const AVATAR_MAX_BYTES = 200 * 1024;

export type AvatarCheck = { ok: true; type: "image/webp" | "image/jpeg" } | { ok: false; reason: string };

const no = (reason: string): AvatarCheck => ({ ok: false, reason });
const fourcc = (b: Uint8Array, at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);
const le32 = (b: Uint8Array, at: number) =>
  (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
const le24 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);

export function checkAvatarImage(b: Uint8Array): AvatarCheck {
  if (b.length > AVATAR_MAX_BYTES) return no("over 200 KB");
  if (b.length >= 12 && fourcc(b, 0) === "RIFF" && fourcc(b, 8) === "WEBP") return checkWebp(b);
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return checkJpeg(b);
  return no("not a WebP or JPEG image");
}

function checkWebp(b: Uint8Array): AvatarCheck {
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
  if (pictures !== 1) return no("not exactly one picture");
  if (!size || size[0] !== AVATAR_SIZE || size[1] !== AVATAR_SIZE) return no("not 256 × 256");
  return { ok: true, type: "image/webp" };
}

/** Markers a canvas-made JPEG has: JFIF, tables, one frame, scans. Anything else (EXIF, XMP, comments) is refused. */
const JPEG_ALLOWED = new Set([0xe0, 0xdb, 0xc4, 0xdd, 0xc0, 0xc1, 0xc2, 0xda]);

function checkJpeg(b: Uint8Array): AvatarCheck {
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
      if (size[0] !== AVATAR_SIZE || size[1] !== AVATAR_SIZE) return no("not 256 × 256"); // before any decoding
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
  return { ok: true, type: "image/jpeg" };
}
