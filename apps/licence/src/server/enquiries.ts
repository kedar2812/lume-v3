import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Refusal } from "./clients";
import type { Ctx } from "./context";
import { clientIp, json, readCapped } from "./http";

/** Where the owner has got to with an enquiry (website spec §7). */
export type Status = "new" | "contacted" | "demo_booked" | "won" | "not_a_fit";
export const STATUSES: Status[] = ["new", "contacted", "demo_booked", "won", "not_a_fit"];
export type Enquiry = {
  id: string;
  createdAt: string;
  name: string;
  business: string;
  whatsapp: string;
  email: string | null;
  teamSize: string;
  how: string | null;
  source: "website";
  status: Status;
  notes: string;
  updatedAt: string;
};

const trimmed = (max: number) => z.string().trim().min(1).max(max);
/** Exactly what the website sends: nothing else is accepted. */
export const enquirySchema = z
  .object({
    name: trimmed(120),
    business: trimmed(160),
    whatsapp: z.string().regex(/^\+[1-9][0-9]{6,14}$/, "A WhatsApp number with its country code."),
    email: z.email().max(254).nullish(),
    teamSize: z.enum(["1", "2-5", "6-20", "21+"]),
    how: z.string().trim().max(500).nullish(),
  })
  .strict();
const MAX_BODY = 8192;
const FOLD_MS = 10 * 60_000;

/** The same token, compared in constant time (hashed first, so the lengths never tell anything). */
function tokenOk(given: string | null, want: string): boolean {
  if (!given) return false;
  return timingSafeEqual(
    createHash("sha256").update(given).digest(),
    createHash("sha256").update(want).digest(),
  );
}

/**
 * POST /v1/enquiries (website spec §7): the website files an enquiry with its token. Limited per address and
 * altogether; the same WhatsApp number within ten minutes folds into the enquiry it already made.
 */
export async function handleEnquiry(req: Request, ctx: Ctx): Promise<Response> {
  if (!ctx.enquiryToken)
    return json(503, {
      error: { code: "NOT_SET_UP", message: "Enquiries aren't set up on this server yet." },
    });
  const bearer = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? null;
  if (!tokenOk(bearer, ctx.enquiryToken))
    return json(401, { error: { code: "UNAUTHORIZED", message: "Not the website." } });
  const nowMs = ctx.now().getTime();
  const byIp = ctx.limits.enquiryIp.take(clientIp(req), nowMs);
  const take = byIp.ok ? ctx.limits.enquiryAll.take("all", nowMs) : byIp;
  if (!take.ok)
    return json(
      429,
      { error: { code: "LIMITED", message: "Too many enquiries just now." } },
      { "retry-after": String(take.retryAfterS) },
    );
  const text = await readCapped(req, MAX_BODY);
  if (text === null) return json(413, { error: { code: "TOO_LARGE", message: "Too large." } });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return json(400, { error: { code: "BAD_REQUEST", message: "Not JSON." } });
  }
  const p = enquirySchema.safeParse(raw);
  if (!p.success)
    return json(400, {
      error: { code: "BAD_REQUEST", message: p.error.issues[0]?.message ?? "Not an enquiry." },
    });
  const b = p.data;
  const now = new Date(nowMs);
  const recent = await ctx.db.query<{ id: string }>(
    "SELECT id FROM enquiries WHERE whatsapp = $1 AND created_at > $2 ORDER BY created_at DESC LIMIT 1",
    [b.whatsapp, new Date(nowMs - FOLD_MS)],
  );
  const again = recent.rows[0];
  if (again) {
    await ctx.db.query(
      `UPDATE enquiries SET name = $2, business = $3, email = $4, team_size = $5, how = coalesce($6, how),
              updated_at = $7 WHERE id = $1`,
      [again.id, b.name, b.business, b.email ?? null, b.teamSize, b.how || null, now],
    );
    return json(201, { id: again.id, folded: true });
  }
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO enquiries (name, business, whatsapp, email, team_size, how, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
    [b.name, b.business, b.whatsapp, b.email ?? null, b.teamSize, b.how || null, now],
  );
  return json(201, { id: rows[0]!.id });
}

type Row = {
  id: string;
  created_at: Date;
  name: string;
  business: string;
  whatsapp: string;
  email: string | null;
  team_size: string;
  how: string | null;
  source: "website";
  status: Status;
  notes: string;
  updated_at: Date;
};
const view = (r: Row): Enquiry => ({
  id: r.id,
  createdAt: r.created_at.toISOString(),
  name: r.name,
  business: r.business,
  whatsapp: r.whatsapp,
  email: r.email,
  teamSize: r.team_size,
  how: r.how,
  source: r.source,
  status: r.status,
  notes: r.notes,
  updatedAt: r.updated_at.toISOString(),
});

/** The panel's list: newest first (the latest 500), with how many are still new. */
export async function listEnquiries(ctx: Ctx, status: Status | "all") {
  const { rows } = await ctx.db.query<Row>(
    "SELECT * FROM enquiries WHERE ($1 = 'all' OR status = $1) ORDER BY created_at DESC LIMIT 500",
    [status],
  );
  const n = await ctx.db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM enquiries WHERE status = 'new'",
  );
  return { enquiries: rows.map(view), newCount: n.rows[0]!.n };
}

export async function getEnquiry(ctx: Ctx, id: string) {
  const { rows } = await ctx.db.query<Row>("SELECT * FROM enquiries WHERE id::text = $1", [id]);
  if (!rows[0]) throw new Refusal(404, "No such enquiry.");
  return { enquiry: view(rows[0]) };
}

/** A status and notes; refused in words when someone saved it since it was read. */
export const patchEnquirySchema = z
  .object({
    status: z.enum(["new", "contacted", "demo_booked", "won", "not_a_fit"]).optional(),
    notes: z.string().max(5000).optional(),
    expectedUpdatedAt: z.iso.datetime(),
  })
  .strict();
export async function patchEnquiry(ctx: Ctx, id: string, p: z.infer<typeof patchEnquirySchema>) {
  const { rows } = await ctx.db.query<Row>(
    `UPDATE enquiries SET status = coalesce($2, status), notes = coalesce($3, notes), updated_at = $4
      WHERE id::text = $1 AND updated_at = $5 RETURNING *`,
    [id, p.status ?? null, p.notes ?? null, ctx.now(), p.expectedUpdatedAt],
  );
  if (rows[0]) return { enquiry: view(rows[0]) };
  await getEnquiry(ctx, id);
  throw new Refusal(409, "Changed elsewhere — reload to see it.", "CHANGED");
}
