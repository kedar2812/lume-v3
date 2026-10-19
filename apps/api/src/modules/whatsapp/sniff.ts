/** A file someone attaches to a reply (plan W3a): what it really is, and how big WhatsApp lets it be. */
export type Sniffed = { mime: string; kind: "image" | "video" | "audio" | "document" };

const MB = 1024 * 1024;
/** WhatsApp's limits (spec 2026-10-18 §4.3), documents at LUME's own 25 MB (the most it keeps of any file). */
export const LIMITS: Record<Sniffed["kind"], number> = {
  image: 5 * MB,
  video: 16 * MB,
  audio: 16 * MB,
  document: 25 * MB,
};

const starts = (bytes: Buffer, sig: number[] | string, at = 0) => {
  const s = typeof sig === "string" ? Buffer.from(sig, "latin1") : Buffer.from(sig);
  return bytes.length >= at + s.length && bytes.subarray(at, at + s.length).equals(s);
};
const extOf = (name: string | undefined) => name?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const OLD_OFFICE: Record<string, string> = {
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
};
const OOXML: [string, string][] = [
  ["word/", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["xl/", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["ppt/", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
];

/**
 * What a file is, read from its first bytes: never from its name or the browser's word for it, so an HTML page, an
 * SVG or a program can't go out to a lead as a "photo" or a "PDF". Only what WhatsApp takes: JPEG and PNG; MP4 and
 * 3GPP; AAC, MP4 audio, MP3, AMR and OGG; PDF, Word, Excel, PowerPoint and plain text. Anything else is null.
 * The name helps only where the bytes can't tell (old Office files, plain text).
 */
export function sniffType(bytes: Buffer, filename?: string): Sniffed | null {
  if (!bytes.length) return null;
  if (starts(bytes, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", kind: "image" };
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { mime: "image/png", kind: "image" };
  if (starts(bytes, "ftyp", 4)) {
    const brand = bytes.subarray(8, 12).toString("latin1");
    if (brand.startsWith("3gp")) return { mime: "video/3gpp", kind: "video" };
    if (brand === "M4A " || brand === "M4B ") return { mime: "audio/mp4", kind: "audio" };
    return { mime: "video/mp4", kind: "video" };
  }
  if (starts(bytes, "OggS")) return { mime: "audio/ogg", kind: "audio" };
  if (starts(bytes, "ID3")) return { mime: "audio/mpeg", kind: "audio" };
  if (starts(bytes, "#!AMR")) return { mime: "audio/amr", kind: "audio" };
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
    // A frame header: layer bits 00 are AAC's ADTS; anything else is MPEG audio (MP3).
    return (bytes[1]! & 0x06) === 0
      ? { mime: "audio/aac", kind: "audio" }
      : { mime: "audio/mpeg", kind: "audio" };
  if (starts(bytes, "%PDF-")) return { mime: "application/pdf", kind: "document" };
  if (starts(bytes, "PK\x03\x04")) {
    // Word, Excel and PowerPoint are zips that name their parts; any other zip isn't a document WhatsApp takes.
    const head = bytes.subarray(0, Math.min(bytes.length, 64 * 1024)).toString("latin1");
    if (!head.includes("[Content_Types].xml")) return null;
    const hit = OOXML.find(([part]) => head.includes(part));
    return hit ? { mime: hit[1], kind: "document" } : null;
  }
  if (starts(bytes, OLE)) {
    const mime = OLD_OFFICE[extOf(filename)];
    return mime ? { mime, kind: "document" } : null;
  }
  if (extOf(filename) === "txt" && !bytes.includes(0)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { mime: "text/plain", kind: "document" };
    } catch {
      return null;
    }
  }
  return null;
}
