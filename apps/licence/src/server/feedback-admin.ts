import { FEEDBACK_KINDS, type FeedbackKind } from "@lume/core";
import type pg from "pg";
import { z } from "zod";
import { latestVersion, Refusal } from "./clients";
import type { Ctx } from "./context";

export type FeedbackStatus = "new" | "seen" | "fixing" | "fixed" | "not_a_bug";
export type FeedbackTab = "new" | "fixing" | "fixed" | "all";
const TABS: Record<FeedbackTab, FeedbackStatus[]> = {
  new: ["new"],
  fixing: ["seen", "fixing"],
  fixed: ["fixed", "not_a_bug"],
  all: ["new", "seen", "fixing", "fixed", "not_a_bug"],
};
const PAGE = 50;
const DAY = 86_400_000;
/** Screenshots can hold a client's lead data: kept 90 days after a report is closed (spec 2026-10-16 §3.3). */
export const KEEP_IMAGES_MS = 90 * DAY;
const uuid = z.uuid();

type Row = {
  id: string;
  received_at: Date;
  kind: FeedbackKind;
  text: string;
  client_id: string;
  client_name: string;
  reporter_name: string;
  reporter_role: string;
  reporter_email: string;
  page: string;
  status: FeedbackStatus;
  fixed_in: string | null;
  image_count: number;
  app_version: string;
  browser: string;
  screen: string;
  theme: "porcelain" | "obsidian";
  note: string;
  closed_at: Date | null;
  images_removed_at: Date | null;
};
/** Every report column, with its client's name. */
const SELECT = `SELECT f.id, f.received_at, f.kind, f.text, f.client_id, c.name AS client_name, f.reporter_name,
  f.reporter_role, f.reporter_email, f.page, f.status, f.fixed_in, f.image_count, f.app_version, f.browser, f.screen,
  f.theme, f.note, f.closed_at, f.images_removed_at
  FROM feedback f JOIN clients c ON c.id = f.client_id`;
/** The list's filters, each off when its parameter is null: kind $1, client $2, fixed in $3, search $4. */
const FILTERS = `($1::text IS NULL OR f.kind = $1)
  AND ($2::uuid IS NULL OR f.client_id = $2)
  AND ($3::text IS NULL OR f.fixed_in = $3)
  AND ($4::text IS NULL OR f.text ILIKE $4 OR f.reporter_name ILIKE $4 OR f.reporter_email ILIKE $4)`;
const COUNTS = `SELECT count(*) FILTER (WHERE status = 'new')::int AS new,
  count(*) FILTER (WHERE status IN ('seen', 'fixing'))::int AS fixing,
  count(*) FILTER (WHERE status IN ('fixed', 'not_a_bug'))::int AS fixed,
  count(*)::int AS all
  FROM feedback f WHERE ${FILTERS}`;
const PAGE_SQL = `${SELECT} WHERE ${FILTERS}
  AND f.status = ANY($5)
  AND ($6::timestamptz IS NULL OR (f.received_at, f.id) < ($6, $7::uuid))
  ORDER BY f.received_at DESC, f.id DESC LIMIT ${PAGE + 1}`;
const ONE_SQL = `${SELECT} WHERE f.id = $1`;

/** The first line of a report, for a list: 160 characters at most. */
export function firstLine(text: string): string {
  const line = text.trim().split("\n")[0]!.trim();
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}
const item = (r: Row) => ({
  id: r.id,
  receivedAt: r.received_at.toISOString(),
  kind: r.kind,
  firstLine: firstLine(r.text),
  client: { id: r.client_id, name: r.client_name },
  reporter: { name: r.reporter_name, role: r.reporter_role },
  page: r.page,
  status: r.status,
  fixedIn: r.fixed_in,
  imageCount: r.image_count,
});
export type FeedbackItem = ReturnType<typeof item>;

/** A search taken literally: % and _ match themselves. */
const like = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

/** GET /api/feedback: one tab, filtered, newest first, 50 at a time; and how many each tab holds under the same filters. */
export async function listFeedback(ctx: Ctx, url: URL) {
  const p = url.searchParams;
  const tab = (p.get("tab") ?? "new") as FeedbackTab;
  if (!Object.hasOwn(TABS, tab)) throw new Refusal(400, "Not a tab.");
  const kind = p.get("kind");
  if (kind && !FEEDBACK_KINDS.includes(kind as FeedbackKind)) throw new Refusal(400, "Not a kind.");
  const client = p.get("client");
  if (client && !uuid.safeParse(client).success) throw new Refusal(400, "Not a client.");
  const fixedIn = p.get("fixedIn");
  const q = p.get("q")?.trim().slice(0, 200) || null;
  const before = p.get("before");
  let cursor: [string, string] | null = null;
  if (before) {
    const [at, id] = before.split("|");
    if (!at || !id || Number.isNaN(Date.parse(at)) || !uuid.safeParse(id).success)
      throw new Refusal(400, "Not a page.");
    cursor = [at, id];
  }

  const filters = [kind, client, fixedIn, q ? like(q) : null];
  const counts = (await ctx.db.query<Record<FeedbackTab, number>>(COUNTS, filters)).rows[0]!;
  const { rows } = await ctx.db.query<Row>(PAGE_SQL, [...filters, TABS[tab], cursor?.[0] ?? null, cursor?.[1] ?? null]);
  const shown = rows.slice(0, PAGE);
  const last = shown.at(-1);
  return {
    items: shown.map(item),
    next: rows.length > PAGE && last ? `${last.received_at.toISOString()}|${last.id}` : null,
    counts,
  };
}

/** Beside Feedback in the sidebar. */
export async function newCount(ctx: Ctx) {
  const { rows } = await ctx.db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM feedback WHERE status = 'new'",
  );
  return { newCount: rows[0]!.n };
}

async function one(db: pg.Pool | pg.PoolClient, id: string): Promise<Row> {
  if (!uuid.safeParse(id).success) throw new Refusal(404, "No such report.");
  const { rows } = await db.query<Row>(ONE_SQL, [id]);
  if (!rows[0]) throw new Refusal(404, "No such report.");
  return rows[0];
}

/** GET /api/feedback/:id: the whole report, its screenshots' sizes, the latest release, and the client's own version. */
export async function getFeedback(ctx: Ctx, id: string) {
  const r = await one(ctx.db, id);
  const [images, version, latest] = await Promise.all([
    ctx.db.query<{ n: number; type: string; width: number; height: number }>(
      "SELECT n, type, width, height FROM feedback_images WHERE feedback_id = $1 ORDER BY n",
      [id],
    ),
    ctx.db.query<{ v: string }>(
      "SELECT app_version AS v FROM check_ins WHERE client_id = $1 ORDER BY at DESC, id DESC LIMIT 1",
      [r.client_id],
    ),
    latestVersion(ctx.db),
  ]);
  return {
    ...item(r),
    text: r.text,
    reporter: { name: r.reporter_name, role: r.reporter_role, email: r.reporter_email },
    appVersion: r.app_version,
    browser: r.browser,
    screen: r.screen,
    theme: r.theme,
    note: r.note,
    closedAt: r.closed_at?.toISOString() ?? null,
    imagesRemovedAt: r.images_removed_at?.toISOString() ?? null,
    images: images.rows,
    latestRelease: latest,
    clientVersion: version.rows[0]?.v ?? null,
  };
}
export type FeedbackDetail = Awaited<ReturnType<typeof getFeedback>>;

/** GET /api/feedback/:id/images/:n: the screenshot as it was kept, only to the signed-in admin. */
export async function feedbackImage(ctx: Ctx, id: string, n: string, download: boolean): Promise<Response> {
  if (!uuid.safeParse(id).success || !/^[0-4]$/.test(n)) throw new Refusal(404, "No such screenshot.");
  const { rows } = await ctx.db.query<{ type: string; bytes: Buffer }>(
    "SELECT type, bytes FROM feedback_images WHERE feedback_id = $1 AND n = $2",
    [id, Number(n)],
  );
  const img = rows[0];
  if (!img) throw new Refusal(404, "No such screenshot.");
  const ext = img.type === "image/webp" ? "webp" : "jpg";
  return new Response(new Uint8Array(img.bytes), {
    status: 200,
    headers: {
      "content-type": img.type,
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=3600",
      "content-disposition": download ? `attachment; filename="feedback-${id.slice(0, 8)}-${n}.${ext}"` : "inline",
    },
  });
}

export const patchFeedbackSchema = z
  .object({
    status: z.enum(["seen", "fixing", "fixed", "not_a_bug"]).optional(),
    fixedIn: z
      .string()
      .regex(/^[0-9]+\.[0-9]+\.[0-9]+$/, "A release is three numbers, like 1.4.2.")
      .optional(),
    note: z.string().max(2000, "A note is 2,000 characters at most.").optional(),
  })
  .strict();

/**
 * PATCH /api/feedback/:id: a status (each change written to the client's history), the release that fixed it, the
 * owner's note.
 */
export async function patchFeedback(ctx: Ctx, id: string, b: z.infer<typeof patchFeedbackSchema>) {
  const c = await ctx.db.connect();
  try {
    await c.query("BEGIN");
    // Locked first, so two quick changes can't each read the old status.
    if (uuid.safeParse(id).success) await c.query("SELECT 1 FROM feedback WHERE id = $1 FOR UPDATE", [id]);
    const r = await one(c, id);
    const to = b.status ?? r.status;
    if (b.fixedIn && to !== "fixed") throw new Refusal(400, "A release goes with Fixed.");
    const fixedIn = to === "fixed" ? (b.fixedIn ?? (r.status === "fixed" ? r.fixed_in : null)) : null;
    if (to === "fixed" && !fixedIn) throw new Refusal(400, "Say which release fixed it.");
    const closed = to === "fixed" || to === "not_a_bug";
    const wasClosed = r.status === "fixed" || r.status === "not_a_bug";
    const now = ctx.now();
    await c.query("UPDATE feedback SET status = $2, fixed_in = $3, closed_at = $4, note = $5 WHERE id = $1", [
      id,
      to,
      fixedIn,
      closed ? (wasClosed ? r.closed_at : now) : null,
      b.note ?? r.note,
    ]);
    if (to !== r.status || fixedIn !== r.fixed_in)
      await c.query("INSERT INTO events (client_id, at, kind, detail) VALUES ($1, $2, 'feedback_status', $3)", [
        r.client_id,
        now,
        { id, from: r.status, to, ...(to === "fixed" ? { fixedIn } : {}) },
      ]);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  return getFeedback(ctx, id);
}

/** Hourly: screenshots of reports closed 90 days ago go; the words and details stay. */
export async function pruneFeedbackImages(db: pg.Pool, now: Date): Promise<number> {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const { rows } = await c.query<{ id: string }>(
      `UPDATE feedback SET images_removed_at = $2
        WHERE closed_at <= $1 AND images_removed_at IS NULL AND image_count > 0 RETURNING id`,
      [new Date(now.getTime() - KEEP_IMAGES_MS), now],
    );
    if (rows.length)
      await c.query("DELETE FROM feedback_images WHERE feedback_id = ANY($1)", [rows.map((r) => r.id)]);
    await c.query("COMMIT");
    return rows.length;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** A client's page: its latest three reports and its counts (spec 2026-10-16 §3.4). */
export async function clientFeedback(db: pg.Pool, clientId: string) {
  const [counts, latest] = await Promise.all([
    db.query<{ total: number; new: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'new')::int AS new
         FROM feedback WHERE client_id = $1`,
      [clientId],
    ),
    db.query<{
      id: string;
      kind: FeedbackKind;
      text: string;
      status: FeedbackStatus;
      fixed_in: string | null;
      received_at: Date;
      reporter_name: string;
    }>(
      `SELECT id, kind, text, status, fixed_in, received_at, reporter_name FROM feedback
        WHERE client_id = $1 ORDER BY received_at DESC, id DESC LIMIT 3`,
      [clientId],
    ),
  ]);
  return {
    total: counts.rows[0]!.total,
    new: counts.rows[0]!.new,
    latest: latest.rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      firstLine: firstLine(r.text),
      status: r.status,
      fixedIn: r.fixed_in,
      receivedAt: r.received_at.toISOString(),
      reporterName: r.reporter_name,
    })),
  };
}

/** Releases: how many reports each version fixed. */
export async function fixedByVersion(db: pg.Pool): Promise<Record<string, number>> {
  const { rows } = await db.query<{ v: string; n: number }>(
    "SELECT fixed_in AS v, count(*)::int AS n FROM feedback WHERE status = 'fixed' GROUP BY fixed_in",
  );
  return Object.fromEntries(rows.map((r) => [r.v, r.n]));
}
