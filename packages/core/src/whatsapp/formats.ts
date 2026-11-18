/**
 * A video or a photo WhatsApp won't take, said in words (owner 2026-11-18). WhatsApp's video types are MP4 and 3GPP,
 * its photo types JPEG and PNG: an iPhone's QuickTime film or HEIC photo is refused by Meta, so LUME says so as the
 * file is chosen (before a big file goes up for nothing) and again when its bytes arrive.
 */
export const VIDEO_FORMATS = "WhatsApp only takes videos as MP4. Save this video as an MP4 and add it again.";
export const PHOTO_FORMATS =
  "WhatsApp only takes photos as JPEG or PNG. Save this photo as a JPEG and add it again.";

const VIDEO_TYPES_OK = new Set(["video/mp4", "video/3gpp", "video/x-m4v"]);
const PHOTO_TYPES_OK = new Set(["image/jpeg", "image/png"]);
const VIDEO_EXT = new Set([
  "mov",
  "qt",
  "avi",
  "mkv",
  "webm",
  "wmv",
  "flv",
  "mpg",
  "mpeg",
  "mts",
  "m2ts",
  "ogv",
]);
const PHOTO_EXT = new Set(["heic", "heif", "avif", "webp", "gif", "bmp", "tif", "tiff"]);

const extOf = (name: string | undefined) => {
  const dot = name?.lastIndexOf(".") ?? -1;
  return dot > 0 ? name!.slice(dot + 1).toLowerCase() : "";
};

/** As a file is chosen, from what the browser says it is (its type, else its name). Null when it may go up. */
export function formatProblem(file: { name: string; type: string }): string | null {
  const type = file.type.toLowerCase();
  const ext = extOf(file.name);
  if ((type.startsWith("video/") && !VIDEO_TYPES_OK.has(type)) || VIDEO_EXT.has(ext)) return VIDEO_FORMATS;
  if ((type.startsWith("image/") && !PHOTO_TYPES_OK.has(type)) || PHOTO_EXT.has(ext)) return PHOTO_FORMATS;
  return null;
}

/** ISO media brands of photos (HEIF/HEIC, AVIF), not films. */
const PHOTO_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
  "avif",
  "avis",
]);
/** The first box of an old QuickTime film that has no ftyp. */
const QT_BOXES = new Set(["moov", "mdat", "wide", "free", "skip", "pnot"]);

const text = (b: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...b.subarray(from, Math.min(to, b.length)));

/**
 * For bytes WhatsApp's types refused: a video or photo of another format gets the words for it, from its bytes or
 * else its name; anything else (a program, a page) is null, for the general words.
 */
export function formatProblemOf(bytes: Uint8Array, filename?: string): string | null {
  const box = text(bytes, 4, 8);
  if (box === "ftyp") return PHOTO_BRANDS.has(text(bytes, 8, 12)) ? PHOTO_FORMATS : VIDEO_FORMATS;
  if (QT_BOXES.has(box)) return VIDEO_FORMATS;
  if (text(bytes, 0, 4) === "RIFF") {
    const kind = text(bytes, 8, 12);
    if (kind === "AVI ") return VIDEO_FORMATS;
    if (kind === "WEBP") return PHOTO_FORMATS;
  }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return VIDEO_FORMATS;
  if (text(bytes, 0, 4) === "GIF8") return PHOTO_FORMATS;
  const ext = extOf(filename);
  if (VIDEO_EXT.has(ext)) return VIDEO_FORMATS;
  if (PHOTO_EXT.has(ext)) return PHOTO_FORMATS;
  return null;
}
