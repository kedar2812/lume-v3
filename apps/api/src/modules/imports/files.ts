import { readCsv, type Delimiter, type Encoding, type Keyring, type ReadCsv } from "@lume/core";
import type { schema } from "@lume/db";
import { HttpError } from "../../http/errors";

type ImportRow = typeof schema.imports.$inferSelect;
// The import id is the encryption context: a sealed file can't be swapped onto another import.
const context = (id: string) => `import-file:${id}`;

export const sealFile = (keyring: Keyring, importId: string, bytes: Buffer): Buffer =>
  keyring.encrypt(bytes.toString("base64"), context(importId));
export const openFile = (keyring: Keyring, importId: string, sealed: Buffer): Buffer =>
  Buffer.from(keyring.decrypt(sealed, context(importId)), "base64");

/** The import's file, read with its saved settings. 409 once the retention sweep has removed it. */
export function readImportFile(
  keyring: Keyring,
  imp: Pick<ImportRow, "id" | "kind" | "fileEnc" | "fileName" | "encoding" | "delimiter" | "headerRow">,
): ReadCsv {
  if (!imp.fileEnc) throw new HttpError(409, "FILE_PURGED", "This import's file was removed after 30 days.");
  const r = readCsv(new Uint8Array(openFile(keyring, imp.id, imp.fileEnc)), {
    fileName: imp.fileName,
    encoding: (imp.encoding as Encoding | null) ?? undefined,
    delimiter: (imp.delimiter as Delimiter | null) ?? undefined,
    headerRow: imp.headerRow ?? undefined,
    allowNoRows: imp.kind === "sheet",
  });
  if (!r.ok) throw new HttpError(400, r.code, r.message);
  return r;
}
