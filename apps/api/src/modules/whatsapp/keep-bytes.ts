import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { AppDeps } from "../../app";
import { HttpError } from "../../http/errors";
import { sha256Of, usedShare } from "./files";
import { DISK_STOP } from "./media";
import { LIMITS, sniffType, type Sniffed } from "./sniff";

/*
 * A file someone gives LUME to send (a reply's attachment, W3a; a file in the library, W3b-1): what it is, that
 * WhatsApp takes it at its size, and its bytes kept once in the shared store. One way for every upload, so a check
 * added for one is never missing from the other.
 */

const KIND_WORDS: Record<keyof typeof LIMITS, string> = {
  image: "Photos",
  video: "Videos",
  audio: "Voice notes and audio",
  document: "Documents",
};
const TYPES =
  "LUME can send photos (JPEG, PNG), videos (MP4), voice notes and documents (PDF, Word, Excel, PowerPoint, text).";
const diskFull = () =>
  new HttpError(507, "DISK_FULL", "The server's disk is full. Ask an admin to free space.");

/** The name a file came with (the `x-file-name` header, URI-encoded), with nothing that could break a path or a header. */
export function fileNameOf(req: FastifyRequest): string | null {
  const raw = req.headers["x-file-name"];
  try {
    return typeof raw === "string" ? decodeURIComponent(raw).replace(/[\\/\r\n"]/g, "") : null;
  } catch {
    return null;
  }
}

/** What a file is, read from its bytes, and that WhatsApp takes it at its size; refused in words otherwise. */
export function checkFile(bytes: Buffer, filename?: string | null): Sniffed {
  const type = sniffType(bytes, filename ?? undefined);
  if (!type) throw new HttpError(415, "FILE_TYPE", TYPES);
  if (bytes.length > LIMITS[type.kind])
    throw new HttpError(
      413,
      "FILE_TOO_BIG",
      `${KIND_WORDS[type.kind]} can be up to ${LIMITS[type.kind] / (1024 * 1024)} MB.`,
    );
  return type;
}

/**
 * The bytes kept once in the shared store (0074), named by their SHA-256, which it returns. The file's row first,
 * touched now, so the hourly sweep can't take the file between the write and the row that holds it; a file that had
 * gone comes back off the off-site list. A full disk is refused in words, before anything is written.
 */
export async function keepBytes(req: FastifyRequest, d: AppDeps, bytes: Buffer): Promise<string> {
  const disk = d.files ? await d.files.disk() : null;
  if (!d.files || (disk && usedShare(disk) >= DISK_STOP)) throw diskFull();
  const sha256 = sha256Of(bytes);
  await req.db.execute(sql`
    INSERT INTO whatsapp_files (sha256, size) VALUES (${sha256}, ${bytes.length})
    ON CONFLICT (sha256) DO UPDATE SET last_ref_at = now()`);
  await req.db.execute(sql`DELETE FROM whatsapp_files_gone WHERE sha256 = ${sha256}`);
  try {
    await d.files.store.put(bytes);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "";
    if (code === "ENOSPC" || code === "EDQUOT") throw diskFull();
    throw e;
  }
  return sha256;
}
