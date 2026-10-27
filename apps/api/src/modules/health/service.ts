import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { localDayBounds } from "@lume/core";
import { bytesText } from "@lume/core/shared";
import type { Mailer } from "../../mail/mailer";
import { opsAlertMail } from "../../mail/templates";
import { notify } from "../notifications/notify";
import { followUpsFrom } from "../settings/follow-ups";
import { usedShare, type FilesDeps } from "../whatsapp/files";

type Q = Pick<pg.Pool, "query">;
const H = 3_600_000;

/**
 * What to do about a problem (owner, 2026-10-27: a warning with no action has no point): a place in LUME to fix it, or
 * "tell", Tell LUME, for what's on the server's side, which the business can't change from LUME.
 */
export type ProblemAction = { label: string; href: string } | "tell";
/** A problem in words a business owner understands (what's wrong, what it means for them), and what to do about it. */
export type Problem = { key: string; words: string; actions: ProblemAction[] };
export type Health = {
  checkedAt: string;
  followUps: { lastSweepAt: string | null; pending: number; late: number; firedToday: number };
  queue: { waiting: number; active: number; retrying: number; failed24h: number };
  digest: { lastSentAt: string | null; sentToday: number; failures24h: number };
  noTouch: { enabled: boolean; lastRunAt: string | null; createdToday: number };
  sources: { id: string; name: string; type: string; status: string; lastSyncAt: string | null }[];
  restoreTest: { at: string | null; ok: boolean | null };
  /** The server's disk and what LUME keeps on it, in bytes (2026-10-19); null where it can't be read. */
  storage: {
    diskTotal: number | null;
    diskFree: number | null;
    database: number | null;
    whatsappFiles: number;
  };
  problems: Problem[];
};

/** From this share of the disk in use, admins are told (once a business day). */
export const DISK_WARN = 0.85;

const n = (v: unknown) => Number(v ?? 0);
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const plural = (k: number, one: string, many: string) => (k === 1 ? `1 ${one}` : `${k} ${many}`);

/**
 * Is LUME keeping its promises (3C Task 5; report §10.4.7)? Every reminder firing, background jobs
 * running, morning emails going, sources syncing, backups restorable — read from what LUME already writes
 * down. Names no lead and no contact: only counts, times, and the names of sources.
 */
/** After a start, this long for the sweeper to catch up before late reminders mean a stopped engine. */
const SETTLE_MS = 5 * 60_000;

export async function readHealth(
  db: Q,
  o: { now?: Date; lastSweepAt?: () => Date | null; startedAt?: Date; files?: FilesDeps | null } = {},
): Promise<Health> {
  const now = o.now ?? new Date();
  const { rows: s } = await db.query<{ tz: string; f: unknown; created_at: Date; whatsapp: boolean | null }>(
    `SELECT timezone AS tz, follow_ups AS f, created_at,
            (integrations -> 'whatsapp' ->> 'enabled')::boolean AS whatsapp
       FROM settings WHERE id = 1`,
  );
  const tz = s[0]?.tz ?? "UTC";
  const { start } = localDayBounds(now, tz);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now); // YYYY-MM-DD
  const one = async <T>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0] as T;

  const reminders = await one<{ pending: string; late: string; fired: string }>(
    `SELECT count(*) FILTER (WHERE status = 'pending') AS pending,
            count(*) FILTER (WHERE status = 'pending' AND fire_at < $1::timestamptz - interval '2 minutes') AS late,
            count(*) FILTER (WHERE status = 'fired' AND fired_at >= $2) AS fired
       FROM scheduled_notifications`,
    [now, start],
  );
  const jobs = await one<Record<string, string>>(
    `SELECT count(*) FILTER (WHERE state = 'created') AS waiting,
            count(*) FILTER (WHERE state = 'active') AS active,
            count(*) FILTER (WHERE state = 'retry') AS retrying,
            count(*) FILTER (WHERE state = 'failed' AND completed_on > $1::timestamptz - interval '24 hours') AS failed
       FROM pgboss.job WHERE name NOT LIKE '\\_\\_pgboss%'`,
    [now],
  ).catch(() => null); // unreadable: said below, never shown as healthy zeros (3C final review)
  const digest = await one<{ last: Date | null; today: string; sent24h: string }>(
    `SELECT max(sent_at) FILTER (WHERE items > 0) AS last,
            count(*) FILTER (WHERE local_date = $1::date AND items > 0) AS today,
            count(*) FILTER (WHERE items > 0 AND sent_at > $2::timestamptz - interval '24 hours') AS sent24h
       FROM digest_runs`,
    [today, now],
  );
  const events = await one<{
    digest_failed: string;
    digest_failed_people: string;
    no_touch_last: Date | null;
    no_touch_today: string;
  }>(
    `SELECT count(*) FILTER (WHERE kind = 'digest.failed' AND at > $1::timestamptz - interval '24 hours') AS digest_failed,
            count(DISTINCT detail ->> 'userId') FILTER (WHERE kind = 'digest.failed' AND at > $1::timestamptz - interval '24 hours') AS digest_failed_people,
            max(at) FILTER (WHERE kind = 'tasks.no_touch') AS no_touch_last,
            coalesce(sum((detail ->> 'created')::int) FILTER (WHERE kind = 'tasks.no_touch' AND ok AND at >= $2), 0) AS no_touch_today
       FROM ops_events`,
    [now, start],
  );
  const { rows: sources } = await db.query<{
    id: string;
    name: string;
    type: string;
    status: string;
    last_synced_at: Date | null;
  }>(
    `SELECT id, name, type, status, last_synced_at FROM lead_sources
      WHERE type IN ('google_sheet', 'webhook') AND status NOT IN ('draft', 'archived') ORDER BY name`,
  );
  const restore = await one<{ finished_at: Date; ok: boolean } | undefined>(
    "SELECT finished_at, ok FROM ops_restore_tests ORDER BY finished_at DESC LIMIT 1",
  );
  const lastSweep = o.lastSweepAt?.() ?? null;
  // Storage (2026-10-19): the disk under the files, the database, and WhatsApp's files; and their off-site copy.
  const disk = o.files ? await o.files.disk().catch(() => null) : null;
  const database = await one<{ bytes: string }>("SELECT pg_database_size(current_database()) AS bytes").then(
    (r) => Number(r.bytes),
    () => null,
  );
  const files = await one<{ bytes: string; oldest: Date | null }>(
    "SELECT coalesce(sum(size), 0) AS bytes, min(created_at) AS oldest FROM whatsapp_files",
  );
  const filesBackup = await one<{ at: Date | null }>(
    "SELECT max(at) AS at FROM ops_events WHERE kind = 'backup.files' AND ok",
  );
  const writable = o.files && s[0]?.whatsapp ? await o.files.store.writable() : true;

  const problems: Problem[] = [];
  const late = n(reminders.late);
  // Just started (after an outage), the sweeper is still catching up: late ones then aren't a stopped engine.
  const settling = !!o.startedAt && now.getTime() - o.startedAt.getTime() < SETTLE_MS;
  if (late && !settling)
    problems.push({
      key: "reminders_late",
      words: `${plural(late, "reminder is", "reminders are")} late: follow-ups aren't reaching people on time.`,
      actions: ["tell"],
    });
  if (o.lastSweepAt && (!lastSweep || now.getTime() - lastSweep.getTime() > 5 * 60_000))
    problems.push({
      key: "sweeper_stopped",
      words:
        "Follow-up reminders haven't been checked for over 5 minutes, so new ones may not go out on time.",
      actions: ["tell"],
    });
  if (!jobs)
    problems.push({
      key: "jobs_unreadable",
      words:
        "LUME couldn't check its background work just now. If this stays, imports, syncs and messages may wait.",
      actions: ["tell"],
    });
  const failed = n(jobs?.failed);
  if (failed)
    problems.push({
      key: "jobs_failed",
      words: `${plural(failed, "background job", "background jobs")} failed in the last day, after 5 tries: something LUME was doing for you didn't finish.`,
      actions: ["tell"],
    });
  const digestFailed = n(events.digest_failed);
  // The mail server, not one bad address: failures for more than one person, or none sent at all
  // (3C final review: one address retried every 15 minutes isn't SMTP).
  if (digestFailed >= 3 && (n(events.digest_failed_people) >= 2 || n(digest.sent24h) === 0))
    problems.push({
      key: "digest_failing",
      words: "Morning emails aren't going out, so people don't get their day's list by email.",
      actions: ["tell"],
    });
  for (const src of sources)
    if (src.status === "needs_attention")
      problems.push({
        key: `source:${src.id}`,
        words: `${src.name} needs attention: new leads from it may not be arriving.`,
        actions: [{ label: `Open ${src.name}`, href: `/settings/integrations/${src.id}` }],
      });
  const installedLongAgo = s[0] ? now.getTime() - s[0].created_at.getTime() > 8 * 24 * H : false;
  if (restore && !restore.ok)
    problems.push({
      key: "restore_test",
      words: "The last backup test failed: LUME couldn't prove a backup can be brought back.",
      actions: ["tell"],
    });
  else if (
    (restore && now.getTime() - restore.finished_at.getTime() > 8 * 24 * H) ||
    (!restore && installedLongAgo)
  )
    problems.push({
      key: "restore_test",
      words:
        "No backup has been test-restored in over a week, so there's no proof the backups can be brought back.",
      actions: ["tell"],
    });

  if (disk && usedShare(disk) >= DISK_WARN)
    problems.push({
      key: "disk_full",
      words: `The server's disk is ${Math.round(usedShare(disk) * 100)}% full (${bytesText(disk.free)} left). When it's full, LUME can't save new messages or files.`,
      actions: [{ label: "Keep files for fewer months", href: "/settings/integrations" }, "tell"],
    });
  if (!writable)
    problems.push({
      key: "files_unwritable",
      words: "LUME can't save WhatsApp photos, voice notes or documents on this server right now.",
      actions: ["tell"],
    });
  // Backups run every 6 hours: a day without one that carried the files, once there have been files for a day.
  const DAY = 24 * H;
  if (
    files.oldest &&
    now.getTime() - files.oldest.getTime() > DAY &&
    (!filesBackup.at || now.getTime() - filesBackup.at.getTime() > DAY)
  )
    problems.push({
      key: "files_backup",
      words:
        "Photos, voice notes and documents from WhatsApp haven't reached the off-site backup for over a day. If this server were lost, they couldn't be brought back.",
      actions: ["tell"],
    });

  return {
    checkedAt: now.toISOString(),
    followUps: {
      lastSweepAt: iso(lastSweep),
      pending: n(reminders.pending),
      late,
      firedToday: n(reminders.fired),
    },
    queue: {
      waiting: n(jobs?.waiting),
      active: n(jobs?.active),
      retrying: n(jobs?.retrying),
      failed24h: failed,
    },
    digest: { lastSentAt: iso(digest.last), sentToday: n(digest.today), failures24h: digestFailed },
    noTouch: {
      enabled: followUpsFrom(s[0]?.f).noTouch.enabled,
      lastRunAt: iso(events.no_touch_last),
      createdToday: n(events.no_touch_today),
    },
    sources: sources.map((x) => ({
      id: x.id,
      name: x.name,
      type: x.type,
      status: x.status,
      lastSyncAt: iso(x.last_synced_at),
    })),
    restoreTest: { at: iso(restore?.finished_at), ok: restore ? restore.ok : null },
    storage: {
      diskTotal: disk?.total ?? null,
      diskFree: disk?.free ?? null,
      database,
      whatsappFiles: Number(files.bytes),
    },
    problems,
  };
}

/**
 * A word to the admins when something's wrong (report §10.4.7): each problem once a business day, to
 * everyone who manages settings, in the app and by email. A problem that clears and comes back the next
 * day is said again.
 */
export async function opsAlerts(
  o: {
    app: FastifyInstance;
    pool: pg.Pool;
    mailer?: Mailer;
    publicUrl?: string;
    lastSweepAt?: () => Date | null;
    startedAt?: Date;
    files?: FilesDeps | null;
  },
  now: Date = new Date(),
): Promise<number> {
  const h = await readHealth(o.pool, {
    now,
    files: o.files ?? null,
    ...(o.lastSweepAt ? { lastSweepAt: o.lastSweepAt } : {}),
    ...(o.startedAt ? { startedAt: o.startedAt } : {}),
  });
  if (!h.problems.length) return 0;
  const { rows: s } = await o.pool.query<{ tz: string; business_name: string }>(
    "SELECT timezone AS tz, business_name FROM settings WHERE id = 1",
  );
  const { start } = localDayBounds(now, s[0]?.tz ?? "UTC");
  const { rows: admins } = await o.pool.query<{ id: string; email: string; name: string }>(
    `SELECT u.id, u.email, u.name FROM users u WHERE u.status = 'active' AND (u.is_owner OR EXISTS (
       SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id AND r.deleted_at IS NULL
         JOIN role_permissions rp ON rp.role_id = r.id
        WHERE ur.user_id = u.id AND rp.permission_key = 'settings.manage'))`,
  );
  // Claimed under one lock, so two processes (every API starts its clock at once) never both say it
  // (3C final review, Important 2). Told only once the claim has committed.
  const claimed: typeof h.problems = [];
  const client = await o.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('lume.ops_alerts'))");
    for (const p of h.problems) {
      const claim = await client.query(
        `INSERT INTO ops_events (kind, ok, detail, at)
         SELECT 'ops.alert', false, jsonb_build_object('key', $1::text), $3
          WHERE NOT EXISTS (SELECT 1 FROM ops_events WHERE kind = 'ops.alert' AND detail ->> 'key' = $1 AND at >= $2)`,
        [p.key, start, now],
      );
      if (claim.rowCount) claimed.push(p);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  for (const p of claimed) {
    for (const a of admins) {
      await notify(o.pool, a.id, { kind: "system_alert", title: p.words }).catch((err: unknown) =>
        o.app.log.error({ err }, "couldn't tell an admin about a problem"),
      );
      if (o.mailer)
        await o.mailer
          .send(
            opsAlertMail({
              to: a.email,
              businessName: s[0]?.business_name ?? "LUME",
              words: p.words,
              url: `${(o.publicUrl ?? "").replace(/\/$/, "")}/settings/health`,
            }),
          )
          .catch((err: unknown) => o.app.log.error({ err }, "couldn't email an admin about a problem"));
    }
  }
  return claimed.length;
}
