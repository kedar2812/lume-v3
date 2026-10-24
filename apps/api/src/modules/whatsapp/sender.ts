import { readFile } from "node:fs/promises";
import { canOnRecord, outboundBody, refusalOf, templateBody, type WaStatus } from "@lume/core";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { loadActor } from "../../rbac/actor";
import { jobServer, withJobRequest } from "../imports/job-request";
import { countSend, dncWords } from "../leads/sending";
import { recordActivity, visibleLead } from "../leads/service";
import { HttpError } from "../../http/errors";
import { MetaError, metaClient } from "./meta";
import { unsent } from "../autopilot/unsent";
import type { WhatsAppJobDeps } from "./process";
import { tokenContext } from "./service";

/** A message that has been "sending" this long was cut short somewhere: never sent again (it may have gone). */
const SENDING_STUCK_MS = 2 * 60_000;
/** Meta's ids for uploaded files last 30 days: reused for 25. */
const UPLOAD_KEEP_MS = 25 * 86_400_000;
/** Tries of a passing refusal (busy, rate limited) before it's failed with words. */
export const SEND_TRIES = 5;
const MAYBE_SENT = "LUME couldn't tell whether this went. Check the phone before sending it again.";

/** A transaction that sees every lead: background work only. */
export async function allScope<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.lead_scope', 'all', true)");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

type Row = {
  status: string;
  /** "sending" untouched for 2 minutes, by the database's clock. */
  stuck: boolean;
  lead_name: string | null;
  lead_dnc: boolean;
  allow_after_dnc: boolean;
  autopilot_run_id: string | null;
  run_status: string | null;
  run_lead_state: string | null;
  run_lead_active: boolean | null;
  tries: number;
  text: string | null;
  task_id: string | null;
  user_id: string;
  user_name: string | null;
  lead_id: string;
  lead_deleted: boolean;
  lead_phone: string | null;
  number_id: string;
  phone_number_id: string;
  number_status: string;
  display_phone: string;
  token_enc: Buffer | null;
  media_kind: "image" | "video" | "audio" | "document" | null;
  media_mime: string | null;
  media_filename: string | null;
  media_sha: string | null;
  /** An approved template (W3b-2): WhatsApp's name for it, its language, this lead's values, a file at the top. */
  sub_id: string | null;
  sub_name: string | null;
  sub_language: string | null;
  params: string[] | null;
  header_kind: "image" | "video" | "audio" | "document" | null;
  header_mime: string | null;
  header_name: string | null;
  header_sha: string | null;
};

/**
 * Send one reply from LUME (plan W3a outcomes 7–9, 14, 21–24). Run by the `whatsapp.send` queue; a throw means "try
 * again later" (pg-boss's backoff), anything else is final.
 *
 * - Never twice: the message is marked `sending` (committed) before Meta is called, and one found `sending` for over
 *   2 minutes is failed with words, never sent again; it may have gone.
 * - Sent as the person who tapped Send: if they can't message the lead any more, or the lead went to the bin, it
 *   isn't sent.
 * - A file is uploaded to Meta once per number and content, its id reused for 25 days; an id Meta no longer has is
 *   dropped and the file uploaded again, once.
 * - Once Meta takes it, it counts as a send, as that person: the lead's last message, first contact, the follow-up
 *   done, the stage's move.
 */
export async function sendOutbox(o: WhatsAppJobDeps, id: string): Promise<void> {
  const { d } = o;
  const pool = d.jobPool ?? d.pool;
  const row = await allScope(
    pool,
    async (c) =>
      (
        await c.query<Row>(
          `SELECT o.status, o.updated_at < now() - make_interval(secs => $2) AS stuck, o.tries, o.text, o.task_id, o.user_id, u.name AS user_name, o.lead_id,
                  l.deleted_at IS NOT NULL AS lead_deleted, l.phone_e164 AS lead_phone, l.name AS lead_name,
                  l.dnc_at IS NOT NULL AS lead_dnc, o.allow_after_dnc,
                  o.autopilot_run_id, ar.status AS run_status, al.state AS run_lead_state, al.active AS run_lead_active,
                  n.id AS number_id, n.phone_number_id, n.status AS number_status, n.display_phone, n.token_enc,
                  m.kind AS media_kind, m.mime AS media_mime, m.filename AS media_filename, m.sha256 AS media_sha,
                  s.id AS sub_id, s.meta_name AS sub_name, s.language AS sub_language, o.params,
                  hf.kind AS header_kind, hf.mime AS header_mime, hf.name AS header_name, hf.sha256 AS header_sha
             FROM whatsapp_outbox o
             JOIN leads l ON l.id = o.lead_id
             JOIN whatsapp_numbers n ON n.id = o.number_id
             LEFT JOIN users u ON u.id = o.user_id
             LEFT JOIN autopilot_runs ar ON ar.id = o.autopilot_run_id
             LEFT JOIN autopilot_leads al ON al.run_id = o.autopilot_run_id AND al.lead_id = o.lead_id
             LEFT JOIN whatsapp_media m ON m.id = o.media_id
             LEFT JOIN whatsapp_template_submissions s ON s.id = o.submission_id
             LEFT JOIN message_files hf ON hf.id = s.header_file_id
            WHERE o.id = $1`,
          [id, SENDING_STUCK_MS / 1000],
        )
      ).rows[0],
  );
  if (!row) return;
  /** Its new status, and anything that must change with it (`also`), in one transaction. */
  const set = (
    status: string,
    f: { problem?: string | null; wamid?: string; tries?: number } = {},
    also?: (c: pg.PoolClient) => Promise<void>,
  ) =>
    allScope(pool, async (c) => {
      await c.query(
        `UPDATE whatsapp_outbox SET status = $2, problem = $3, wamid = coalesce($4, wamid),
                tries = coalesce($5, tries), updated_at = now()
          WHERE id = $1`,
        [id, status, f.problem ?? null, f.wamid ?? null, f.tries ?? null],
      );
      await also?.(c);
    });
  const fail = (problem: string) => set("failed", { problem });
  if (row.status === "sending") {
    if (row.stuck) await fail(MAYBE_SENT);
    return;
  }
  if (row.status !== "queued") return;
  if (row.lead_deleted) return void (await fail("This lead isn't here any more."));
  // Do not contact, set after this was queued: it never goes (only LUME AI's one apology for a stop may).
  if (row.lead_dnc && !row.allow_after_dnc) return void (await fail(dncWords(row.lead_name)));
  // LUME AI's (Autopilot A2): paused, ended, or the lead taken over since it was queued: never sent (§2.1).
  if (
    row.autopilot_run_id &&
    !row.allow_after_dnc &&
    (row.run_status !== "running" ||
      !row.run_lead_active ||
      row.run_lead_state === "with_you" ||
      row.run_lead_state === "stopped")
  )
    // Held by a Pause, it never went: Resume writes it again (an ended run, or a lead taken over, is left as it is).
    return void (await set("cancelled", { problem: "LUME AI's run was paused before this went." }, (c) =>
      row.run_status === "paused" && row.run_lead_active
        ? unsent(c, {
            runId: row.autopilot_run_id!,
            leadId: row.lead_id,
            template: !!row.sub_id,
            at: o.d.clock(),
          })
        : Promise.resolve(),
    ));
  if (row.number_status !== "active" || !row.token_enc)
    return void (await fail(`Connect ${row.display_phone} again to reply from LUME.`));
  if (!row.lead_phone) return void (await fail("This lead has no WhatsApp number."));
  if (!d.meta) return void (await fail("WhatsApp isn't set up on this server."));

  // The sender, as they are now: someone who can't message this lead any more doesn't send to it.
  const actor = await loadActor(pool, row.user_id);
  const who = row.user_name?.trim() || "This person";
  const lost = `${who} can't message this lead any more.`;
  if (!actor) return void (await fail(lost));
  const allowed = await withJobRequest(
    { app: jobServer(o.app), pool, actor, requestId: `whatsapp-send:${id}`, allLeads: false },
    async (req) => {
      const lead = await visibleLead(req, row.lead_id).catch((e: unknown) => {
        if (e instanceof HttpError) return null;
        throw e;
      });
      return !!lead && canOnRecord(actor, "messages.send", lead.ownerId);
    },
  );
  if (!allowed) return void (await fail(lost));

  const tries = row.tries + 1;
  await set("sending", { tries });
  const meta = metaClient(d.meta, d.keyring.decrypt(row.token_enc, tokenContext(row.number_id)));
  let wamid: string;
  try {
    const first = await bodyOf(o, row, meta, false);
    try {
      wamid = await meta.sendMessage(row.phone_number_id, first.body);
    } catch (e) {
      // A reused file id Meta no longer has (131053): dropped, the file uploaded again, and sent once more.
      if (!first.reused || !(e instanceof MetaError) || e.code !== 131053) throw e;
      await pool.query("DELETE FROM whatsapp_meta_uploads WHERE number_id = $1 AND sha256 = $2", [
        row.number_id,
        row.media_sha ?? row.header_sha,
      ]);
      wamid = await meta.sendMessage(row.phone_number_id, (await bodyOf(o, row, meta, true)).body);
    }
  } catch (e) {
    if (e instanceof MissingFile)
      return void (await fail("This file isn't on the server any more. Attach it again."));
    if (!(e instanceof MetaError)) {
      await set("queued");
      throw e;
    }
    const why = refusalOf(e.kind === "token" ? 190 : e.code);
    if (why.token)
      await pool.query(
        "UPDATE whatsapp_numbers SET status = 'needs_attention', problem = $2, updated_at = now() WHERE id = $1 AND status = 'active'",
        [row.number_id, "WhatsApp stopped letting LUME in. Connect this number again."],
      );
    if (why.retry && tries < SEND_TRIES) {
      await set("queued");
      throw e; // the queue tries again later, with backoff
    }
    // The person turned off this business's marketing (131050): no marketing template is offered for them again.
    if (e.code === 131050)
      await withJobRequest(
        { app: jobServer(o.app), pool, actor, requestId: `whatsapp-marketing-off:${id}`, allLeads: true },
        (req) =>
          req.db.execute(sql`UPDATE leads SET whatsapp_marketing_off_at = now() WHERE id = ${row.lead_id}`),
      );
    // WhatsApp no longer has the template as approved (132000, 132001): it says so where it's submitted.
    if ((e.code === 132000 || e.code === 132001) && row.sub_id)
      await pool.query(
        "UPDATE whatsapp_template_submissions SET status = 'failed', reason = $2 WHERE id = $1",
        [row.sub_id, why.words],
      );
    // Meta's error codes only: never its message text, which can quote the request.
    o.app.log.warn({ outbox: id, code: e.code }, "whatsapp reply refused");
    return void (await fail(why.words));
  }

  // Meta took it: it's sent (its id on the outbox, which an echo of it is matched by), and it counts as a send, as
  // the person who sent it.
  await withJobRequest(
    { app: jobServer(o.app), pool, actor, requestId: `whatsapp-sent:${id}`, allLeads: true },
    async (req) => {
      await req.db.execute(sql`
        UPDATE whatsapp_outbox SET status = 'sent', wamid = ${wamid}, problem = NULL, updated_at = now()
         WHERE id = ${id} AND status = 'sending'`);
      const lead = await visibleLead(req, row.lead_id);
      await recordActivity(req, lead.id, "whatsapp_confirmed_sent", { via: "lume", outboxId: id });
      await countSend(req, d, lead, row.task_id ?? undefined);
    },
  );
}

class MissingFile extends Error {}

/**
 * What to send: the words, the file by Meta's id with its caption, or an approved template with this lead's values (and
 * its file at the top). A file's id is reused when this number uploaded the same file in the last 25 days (`reused`),
 * unless `fresh` asks for a new upload.
 */
async function bodyOf(
  o: WhatsAppJobDeps,
  row: Row,
  meta: ReturnType<typeof metaClient>,
  fresh: boolean,
): Promise<{ body: Record<string, unknown>; reused: boolean }> {
  const to = row.lead_phone!;
  if (row.sub_id) {
    const header =
      row.header_sha && row.header_kind && row.header_kind !== "audio"
        ? { kind: row.header_kind, sha: row.header_sha, mime: row.header_mime, filename: row.header_name }
        : null;
    const up = header ? await uploaded(o, row, meta, fresh, header) : null;
    return {
      body: templateBody(to, {
        name: row.sub_name!,
        language: row.sub_language!,
        values: row.params ?? [],
        ...(header && up
          ? {
              header: {
                kind: header.kind,
                mediaId: up.mediaId,
                ...(header.filename ? { filename: header.filename } : {}),
              },
            }
          : {}),
      }),
      reused: up?.reused ?? false,
    };
  }
  if (!row.media_kind) return { body: outboundBody(to, { text: row.text ?? "" }), reused: false };
  if (!row.media_sha) throw new MissingFile();
  const kind = row.media_kind;
  const up = await uploaded(o, row, meta, fresh, {
    kind,
    sha: row.media_sha,
    mime: row.media_mime,
    filename: row.media_filename,
  });
  const file = {
    kind,
    ...(row.text ? { caption: row.text } : {}),
    ...(row.media_filename ? { filename: row.media_filename } : {}),
  };
  return { body: outboundBody(to, { ...file, mediaId: up.mediaId }), reused: up.reused };
}

/** A file's id at Meta for this number: reused for 25 days, else uploaded now (and remembered). */
async function uploaded(
  o: WhatsAppJobDeps,
  row: Row,
  meta: ReturnType<typeof metaClient>,
  fresh: boolean,
  f: { kind: string; sha: string; mime: string | null; filename: string | null },
): Promise<{ mediaId: string; reused: boolean }> {
  if (!o.d.files) throw new MissingFile();
  const pool = o.d.jobPool ?? o.d.pool;
  if (!fresh) {
    const cached = await pool.query<{ meta_media_id: string }>(
      "SELECT meta_media_id FROM whatsapp_meta_uploads WHERE number_id = $1 AND sha256 = $2 AND uploaded_at > $3",
      [row.number_id, f.sha, new Date(o.d.clock().getTime() - UPLOAD_KEEP_MS)],
    );
    const reused = cached.rows[0]?.meta_media_id;
    if (reused) return { mediaId: reused, reused: true };
  }
  const bytes = await readFile(o.d.files.store.path(f.sha)).catch(() => {
    throw new MissingFile();
  });
  const mediaId = await meta.uploadMedia(
    row.phone_number_id,
    bytes,
    f.mime ?? "application/octet-stream",
    f.filename ?? `file.${f.kind}`,
  );
  await pool.query(
    `INSERT INTO whatsapp_meta_uploads (number_id, sha256, meta_media_id, uploaded_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (number_id, sha256) DO UPDATE SET meta_media_id = excluded.meta_media_id, uploaded_at = excluded.uploaded_at`,
    [row.number_id, f.sha, mediaId, o.d.clock()],
  );
  return { mediaId, reused: false };
}

/**
 * Meta's delivery statuses for replies LUME sent (plan W3a outcomes 18–20): forward only (queued, sending, sent,
 * delivered, read); a failure counts only before delivery; a status for a message LUME didn't send is nothing.
 */
export async function applyStatuses(pool: pg.Pool, statuses: WaStatus[]): Promise<void> {
  if (!statuses.length) return;
  await allScope(pool, async (c) => {
    for (const s of statuses)
      await c.query(
        `UPDATE whatsapp_outbox o SET status = $2, problem = $3, updated_at = now()
          WHERE o.wamid = $1
            AND o.number_id IN (SELECT id FROM whatsapp_numbers WHERE phone_number_id = $4)
            AND CASE
                  WHEN $2 = 'failed' THEN o.status IN ('queued', 'sending', 'sent')
                  ELSE o.status <> 'failed' AND
                       (CASE o.status WHEN 'queued' THEN 0 WHEN 'sending' THEN 1 WHEN 'sent' THEN 2
                                      WHEN 'delivered' THEN 3 WHEN 'read' THEN 4 END)
                       < (CASE $2 WHEN 'sent' THEN 2 WHEN 'delivered' THEN 3 WHEN 'read' THEN 4 END)
                END`,
        [s.wamid, s.status, s.status === "failed" ? refusalOf(s.errorCode).words : null, s.phoneNumberId],
      );
  });
}
