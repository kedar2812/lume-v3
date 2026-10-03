import { inflateRawSync } from "node:zlib";

/**
 * What a zip (an .xlsx file) really opens to, measured by inflating each entry with a ceiling, so a small file
 * that swells to gigabytes is refused before anything builds it in memory (6B review). The sizes a zip declares
 * are never trusted: only the bytes inflation produces count.
 *
 * "big": it opens to more than `cap` bytes; "bad": it isn't a zip LUME can read; "ok": it fits.
 */
export function zipFits(bytes: Buffer, cap: number): "ok" | "big" | "bad" {
  // The end-of-central-directory record: the last "PK\x05\x06" within the final 64 KiB + 22 bytes.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--)
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) return "bad";
  const entries = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  // Zip64 markers: no export LUME makes needs them, and a 10 MB upload never does.
  if (entries === 0xffff || at === 0xffffffff || entries > 10_000) return "bad";
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== 0x02014b50) return "bad";
    const method = bytes.readUInt16LE(at + 10);
    const packed = bytes.readUInt32LE(at + 20);
    const local = bytes.readUInt32LE(at + 42);
    at += 46 + bytes.readUInt16LE(at + 28) + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) return "bad";
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (start + packed > bytes.length) return "bad";
    const data = bytes.subarray(start, start + packed);
    if (method === 0) total += packed;
    else if (method === 8) {
      try {
        total += inflateRawSync(data, { maxOutputLength: cap - total + 1 }).length;
      } catch (e) {
        return (e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" ? "big" : "bad";
      }
    } else return "bad";
    if (total > cap) return "big";
  }
  return "ok";
}
