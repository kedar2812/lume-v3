import { createHash, randomBytes } from "node:crypto";
import { can, newId } from "@lume/core";
import { schema } from "@lume/db";
import { and, asc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { HttpError, forbidden, notFound } from "../../http/errors";
import { checkFile, keepBytes } from "./keep-bytes";
import type { Sniffed } from "./sniff";

/*
 * The file library (plan W3b-1, spec 2026-10-18 §4.3): the business's brochures, price lists and photos, kept once
 * in the shared store and sent from any lead. Business configuration: everyone who may use templates sees it; only
 * templates.manage changes it. A share link is a 256-bit token, sealed in the row (to show it again) and hashed
 * (to find it); turning the link off keeps the token, so on again is the same link.
 */

const F = schema.messageFiles;
export type LibraryFile = {
  id: string;
  name: string;
  kind: Sniffed["kind"];
  mime: string;
  size: number;
  link: { on: boolean; url: string | null; opens: number };
  createdAt: string;
  archived: boolean;
};
type Row = typeof F.$inferSelect;

const linkContext = (id: string) => `message-file-link:${id}`;
export const hashOfToken = (token: string) => createHash("sha256").update(token).digest("hex");

function viewOf(d: AppDeps, row: Row): LibraryFile {
  const token = row.linkOn && row.linkEnc ? d.keyring.decrypt(row.linkEnc, linkContext(row.id)) : null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    mime: row.mime,
    size: row.size,
    link: { on: row.linkOn, url: token ? `${d.config.publicUrl}/f/${token}` : null, opens: row.opens },
    createdAt: row.createdAt.toISOString(),
    archived: row.archivedAt !== null,
  };
}

const nameTaken = (name: string) =>
  new HttpError(409, "NAME_TAKEN", `A file called “${name}” is already in your files.`);

/** The name, unless a live file other than `except` already has it (in any case). */
async function assertNameFree(req: FastifyRequest, name: string, except?: string) {
  const [hit] = await req.db
    .select({ id: F.id })
    .from(F)
    .where(
      and(
        sql`lower(${F.name}) = lower(${name})`,
        isNull(F.archivedAt),
        except ? ne(F.id, except) : undefined,
      ),
    )
    .limit(1);
  if (hit) throw nameTaken(name);
}

/**
 * Two at once with the same name: the unique index decides, and the loser hears the same words. Under a savepoint,
 * because the request is one transaction and a failed write would end it.
 */
async function orTaken<T>(req: FastifyRequest, name: string, write: () => Promise<T>): Promise<T> {
  await req.db.execute(sql`SAVEPOINT lume_file_name`);
  try {
    const out = await write();
    await req.db.execute(sql`RELEASE SAVEPOINT lume_file_name`);
    return out;
  } catch (e) {
    await req.db.execute(sql`ROLLBACK TO SAVEPOINT lume_file_name`);
    const pg = e as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
    if (
      (pg.code ?? pg.cause?.code) === "23505" &&
      (pg.constraint ?? pg.cause?.constraint) === "message_files_live_name"
    )
      throw nameTaken(name);
    throw e;
  }
}

async function rowOf(req: FastifyRequest, id: string): Promise<Row> {
  const [row] = await req.db.select().from(F).where(eq(F.id, id));
  if (!row) throw notFound();
  return row;
}

export async function listFiles(
  req: FastifyRequest,
  d: AppDeps,
  archived: boolean,
): Promise<{ files: LibraryFile[] }> {
  if (archived && !can(req.actor!, "templates.manage")) throw forbidden();
  const rows = await req.db
    .select()
    .from(F)
    .where(archived ? isNotNull(F.archivedAt) : isNull(F.archivedAt))
    .orderBy(asc(sql`lower(${F.name})`), asc(F.id));
  return { files: rows.map((r) => viewOf(d, r)) };
}

export async function uploadFile(
  req: FastifyRequest,
  d: AppDeps,
  bytes: Buffer,
  filename: string | null,
): Promise<{ file: LibraryFile }> {
  const type = checkFile(bytes, filename);
  const name = (filename?.trim() || `File.${type.mime.split("/")[1] ?? "bin"}`).slice(0, 120);
  await assertNameFree(req, name);
  const sha256 = await keepBytes(req, d, bytes);
  const id = newId();
  const [row] = await orTaken(req, name, () =>
    req.db
      .insert(F)
      .values({
        id,
        sha256,
        name,
        mime: type.mime,
        kind: type.kind,
        size: bytes.length,
        createdBy: req.actor!.userId,
      })
      .returning(),
  );
  await audit(req, { action: "file.uploaded", entityType: "message_file", entityId: id, diff: { name } });
  return { file: viewOf(d, row!) };
}

export async function renameFile(
  req: FastifyRequest,
  d: AppDeps,
  id: string,
  name: string,
): Promise<{ file: LibraryFile }> {
  const before = await rowOf(req, id);
  if (before.archivedAt === null) await assertNameFree(req, name, id);
  const [row] = await orTaken(req, name, () =>
    req.db.update(F).set({ name }).where(eq(F.id, id)).returning(),
  );
  await audit(req, {
    action: "file.renamed",
    entityType: "message_file",
    entityId: id,
    diff: { name: [before.name, name] },
  });
  return { file: viewOf(d, row!) };
}

/** Archived: out of every list and picker, its link answering nothing; the stored file stays for what sent it. */
export async function archiveFile(
  req: FastifyRequest,
  d: AppDeps,
  id: string,
  archive: boolean,
): Promise<{ file: LibraryFile }> {
  const before = await rowOf(req, id);
  if (!archive && before.archivedAt !== null) await assertNameFree(req, before.name, id);
  const [row] = await orTaken(req, before.name, () =>
    req.db
      .update(F)
      .set({ archivedAt: archive ? (before.archivedAt ?? sql`now()`) : null })
      .where(eq(F.id, id))
      .returning(),
  );
  await audit(req, {
    action: archive ? "file.archived" : "file.restored",
    entityType: "message_file",
    entityId: id,
  });
  return { file: viewOf(d, row!) };
}

export async function setFileLink(
  req: FastifyRequest,
  d: AppDeps,
  id: string,
  on: boolean,
): Promise<{ file: LibraryFile }> {
  const before = await rowOf(req, id);
  // The first time on, a token; after that, the same one, so a link already shared works again.
  const fresh = on && !before.linkEnc ? randomBytes(32).toString("base64url") : null;
  const [row] = await req.db
    .update(F)
    .set({
      linkOn: on,
      ...(fresh ? { linkHash: hashOfToken(fresh), linkEnc: d.keyring.encrypt(fresh, linkContext(id)) } : {}),
    })
    .where(eq(F.id, id))
    .returning();
  if (on !== before.linkOn)
    await audit(req, {
      action: on ? "file.link_on" : "file.link_off",
      entityType: "message_file",
      entityId: id,
    });
  return { file: viewOf(d, row!) };
}
