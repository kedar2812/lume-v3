import { isCurrency, type LicenceType } from "@lume/core/shared";
import type pg from "pg";
import { z } from "zod";
import { alertsFor, compareVersions, visibleAlerts, type AlertClient } from "@/lib/alerts";
import { computeAnalytics, SOURCES, type AClient, type Source } from "@/lib/analytics";
import { hashKey, lastFour, maskedKey, newInstanceId, newLicenceKey } from "@/lib/keys";
import { monthlyInr, rateOf, type Rates } from "@/lib/money";
import { INDIA_STATES, isCountry } from "@/lib/places";
import { addDays, serverState, utcDay } from "@/lib/state";
import type { Ctx } from "./context";
import { currentRates } from "./fx";

export class Refusal extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}
const TRIAL_DAYS = 14;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ---------- inputs ---------- */

const money = z.number().positive().max(1_000_000_000);
const place = {
  country: z.string().refine(isCountry, "Not a country"),
  region: z.string().nullable().optional(),
  city: z.string().trim().max(80).nullable().optional(),
};
export const newClientSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: z
      .string()
      .regex(/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/)
      .optional(),
    ...place,
    source: z.enum(SOURCES),
    plan: z
      .object({
        type: z.enum(["subscription", "trial", "perpetual"]),
        currency: z.string().refine(isCurrency, "Not a currency"),
        amount: money,
        periodMonths: z.union([z.literal(0), z.literal(1), z.literal(3), z.literal(12)]),
      })
      .strict(),
  })
  .strict();
export const patchClientSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    ...place,
    country: place.country.optional(),
    source: z.enum(SOURCES).optional(),
  })
  .strict();
export const priceSchema = z
  .object({
    currency: z.string().refine(isCurrency, "Not a currency"),
    amount: money,
    periodMonths: z.union([z.literal(0), z.literal(1), z.literal(3), z.literal(12)]),
  })
  .strict();

function checkPlace(country: string, region: string | null | undefined) {
  if (region == null) return;
  if (country !== "IN") throw new Refusal(400, "A state is for clients in India.");
  if (!Object.hasOwn(INDIA_STATES, region)) throw new Refusal(400, "Not one of India's states.");
}
/** A subscription or trial's price repeats (1, 3 or 12 months); a perpetual licence's is one-time (0). */
function checkPeriod(type: LicenceType, periodMonths: number) {
  if (type === "perpetual" ? periodMonths !== 0 : periodMonths === 0)
    throw new Refusal(
      400,
      type === "perpetual" ? "A one-time price has no period." : "Choose monthly, quarterly or yearly.",
    );
}

/* ---------- reading ---------- */

type Row = {
  id: string;
  name: string;
  slug: string;
  country: string;
  region: string | null;
  city: string | null;
  source: Source;
  created_at: Date;
  decommissioned_at: Date | null;
  instance_id: string;
  key_last4: string;
  type: LicenceType;
  paid_until: string | null;
  trial_ends: string | null;
  suspended_at: Date | null;
  paying_since: Date | null;
  currency: string | null;
  amount: string | null;
  period_months: number | null;
  last_at: Date | null;
  last_version: string | null;
};
const CLIENTS_SQL = `
  SELECT c.id, c.name, c.slug, c.country, c.region, c.city, c.source, c.created_at, c.decommissioned_at,
         l.instance_id, l.key_last4, l.type, to_char(l.paid_until, 'YYYY-MM-DD') AS paid_until,
         to_char(l.trial_ends, 'YYYY-MM-DD') AS trial_ends, l.suspended_at, l.paying_since,
         p.currency, p.amount::text AS amount, p.period_months,
         ci.at AS last_at, ci.app_version AS last_version
    FROM clients c
    JOIN licences l ON l.client_id = c.id
    LEFT JOIN LATERAL (SELECT currency, amount, period_months FROM prices WHERE client_id = c.id
                        ORDER BY effective_from DESC, id DESC LIMIT 1) p ON true
    LEFT JOIN LATERAL (SELECT at, app_version FROM check_ins WHERE client_id = c.id
                        ORDER BY at DESC, id DESC LIMIT 1) ci ON true`;
const ONE_CLIENT_SQL = CLIENTS_SQL + " WHERE c.id = $1";
const ALL_CLIENTS_SQL = CLIENTS_SQL + " ORDER BY c.created_at DESC, c.id";

export type ClientView = ReturnType<typeof view>;
function view(r: Row, rates: Rates, now: Date) {
  const price = r.currency
    ? { currency: r.currency, amount: Number(r.amount), periodMonths: r.period_months! }
    : null;
  const { state, reason } = serverState(
    {
      type: r.type,
      paidUntil: r.paid_until,
      trialEnds: r.trial_ends,
      suspended: !!r.suspended_at,
      decommissioned: !!r.decommissioned_at,
    },
    now,
  );
  const paying = !!r.paying_since && r.type !== "perpetual" && !r.suspended_at && !r.decommissioned_at;
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    country: r.country,
    region: r.region,
    city: r.city,
    source: r.source,
    createdAt: r.created_at.toISOString(),
    instanceId: r.instance_id,
    keyMasked: maskedKey(r.key_last4),
    type: r.type,
    state,
    reason,
    paidUntil: r.paid_until,
    trialEnds: r.trial_ends,
    suspendedAt: r.suspended_at?.toISOString() ?? null,
    decommissionedAt: r.decommissioned_at?.toISOString() ?? null,
    price,
    /** What it adds to monthly revenue now, in rupees (0 for a trial, a one-time price, or a client paused); null if no rate. */
    monthlyInr: price && paying ? monthlyInr(price, rates) : 0,
    lastCheckIn: r.last_at ? { at: r.last_at.toISOString(), version: r.last_version! } : null,
  };
}

async function row(db: pg.Pool | pg.PoolClient, id: string): Promise<Row> {
  if (!UUID.test(id)) throw new Refusal(404, "No such client.");
  const r = (await db.query<Row>(ONE_CLIENT_SQL, [id])).rows[0];
  if (!r) throw new Refusal(404, "No such client.");
  return r;
}

export async function listClients(ctx: Ctx) {
  const rates = await currentRates(ctx);
  const { rows } = await ctx.db.query<Row>(ALL_CLIENTS_SQL);
  const now = ctx.now();
  const a = computeAnalytics({
    clients: await analyticsClients(ctx.db),
    rates: rates.rates,
    now,
    range: 3,
    listPriceInr: 0,
  });
  return {
    clients: rows.map((r) => view(r, rates.rates, now)),
    totals: { mrr: a.mrr, mrrBefore: a.mrrBefore },
    rates: { day: rates.day, ageDays: rates.ageDays },
  };
}

/** One client's page: the client, its installation, 14 days of check-ins, history, payments, reminder. */
export async function getClient(ctx: Ctx, id: string) {
  const r = await row(ctx.db, id);
  const now = ctx.now();
  const rates = await currentRates(ctx);
  const since = new Date(now.getTime() - 14 * 86_400_000);
  const [last, ins, events, payments, notice] = await Promise.all([
    ctx.db.query<{
      at: Date;
      ip: string | null;
      app_version: string;
      active_users: number;
      lead_count: number;
      server_time: Date | null;
    }>(
      "SELECT at, ip, app_version, active_users, lead_count, server_time FROM check_ins WHERE client_id = $1 ORDER BY at DESC, id DESC LIMIT 1",
      [id],
    ),
    ctx.db.query<{ at: Date }>("SELECT at FROM check_ins WHERE client_id = $1 AND at >= $2 ORDER BY at", [
      id,
      since,
    ]),
    ctx.db.query<{ at: Date; kind: string; detail: Record<string, unknown> }>(
      "SELECT at, kind, detail FROM events WHERE client_id = $1 ORDER BY at DESC, id DESC LIMIT 100",
      [id],
    ),
    paymentsOf(ctx.db, id),
    ctx.db.query<{ id: string; note: string; due_date: string | null; created_at: Date }>(
      "SELECT id, note, to_char(due_date, 'YYYY-MM-DD') AS due_date, created_at FROM notices WHERE client_id = $1 AND cleared_at IS NULL",
      [id],
    ),
  ]);
  // One slot per 6 hours over 14 days (56): did it check in during that slot?
  const SLOT = 6 * 3_600_000;
  const slots = Array.from({ length: 56 }, (_, i) => {
    const from = since.getTime() + i * SLOT;
    return {
      from: new Date(from).toISOString(),
      seen: ins.rows.some((x) => x.at.getTime() >= from && x.at.getTime() < from + SLOT),
    };
  });
  const l = last.rows[0];
  const n = notice.rows[0];
  return {
    client: view(r, rates.rates, now),
    installation: l
      ? {
          version: l.app_version,
          ip: l.ip,
          activeUsers: l.active_users,
          leadCount: l.lead_count,
          lastCheckInAt: l.at.toISOString(),
          serverTime: l.server_time?.toISOString() ?? null,
        }
      : null,
    checkIns: slots,
    history: events.rows.map((e) => ({ at: e.at.toISOString(), kind: e.kind, detail: e.detail })),
    payments,
    notice: n ? { id: n.id, note: n.note, dueDate: n.due_date, createdAt: n.created_at.toISOString() } : null,
  };
}

type PaymentRow = {
  id: string;
  client_id: string;
  client_name: string;
  amount: string;
  currency: string;
  rate_to_inr: string | null;
  amount_inr: string | null;
  paid_at: Date;
  paid_until: string | null;
  note: string | null;
};
const PAYMENTS_SQL = `
  SELECT p.id::text, p.client_id, c.name AS client_name, p.amount::text, p.currency, p.rate_to_inr::text,
         p.amount_inr::text, p.paid_at, to_char(p.paid_until, 'YYYY-MM-DD') AS paid_until, p.note
    FROM payments p JOIN clients c ON c.id = p.client_id`;
const CLIENT_PAYMENTS_SQL = PAYMENTS_SQL + " WHERE p.client_id = $1 ORDER BY p.paid_at DESC, p.id DESC";
const ALL_PAYMENTS_SQL = PAYMENTS_SQL + " ORDER BY p.paid_at DESC, p.id DESC LIMIT 1000";
const paymentView = (p: PaymentRow) => ({
  id: p.id,
  clientId: p.client_id,
  clientName: p.client_name,
  amount: Number(p.amount),
  currency: p.currency,
  rateToInr: p.rate_to_inr === null ? null : Number(p.rate_to_inr),
  amountInr: p.amount_inr === null ? null : Number(p.amount_inr),
  paidAt: p.paid_at.toISOString(),
  paidUntil: p.paid_until,
  note: p.note,
});
async function paymentsOf(db: pg.Pool, clientId: string) {
  const { rows } = await db.query<PaymentRow>(CLIENT_PAYMENTS_SQL, [clientId]);
  return rows.map(paymentView);
}
/** Every payment, native and in rupees, newest first. */
export async function listPayments(ctx: Ctx) {
  const { rows } = await ctx.db.query<PaymentRow>(ALL_PAYMENTS_SQL);
  return { payments: rows.map(paymentView) };
}

/* ---------- actions (each in one transaction, each an event in the client's history) ---------- */

async function tx<T>(ctx: Ctx, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await ctx.db.connect();
  try {
    await c.query("BEGIN");
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
const event = (c: pg.PoolClient, clientId: string, at: Date, kind: string, detail: object = {}) =>
  c.query("INSERT INTO events (client_id, at, kind, detail) VALUES ($1, $2, $3, $4)", [
    clientId,
    at,
    kind,
    JSON.stringify(detail),
  ]);
async function lockRow(c: pg.PoolClient, id: string): Promise<Row> {
  if (!UUID.test(id)) throw new Refusal(404, "No such client.");
  await c.query("SELECT 1 FROM licences WHERE client_id = $1 FOR UPDATE", [id]);
  return row(c, id);
}
const slugOf = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
    .replace(/-+$/, "") || "client";

/** New licence: the client, its licence and first price. The key is returned once; only its hash is kept. */
export async function createClient(ctx: Ctx, body: z.infer<typeof newClientSchema>) {
  const { plan } = body;
  checkPlace(body.country, body.region);
  checkPeriod(plan.type, plan.periodMonths);
  const now = ctx.now();
  const today = utcDay(now);
  const licenseKey = newLicenceKey();
  const id = await tx(ctx, async (c) => {
    const base = body.slug ?? slugOf(body.name);
    const taken = new Set(
      (
        await c.query<{ slug: string }>("SELECT slug FROM clients WHERE slug = $1 OR slug LIKE $2", [
          base,
          `${base}-%`,
        ])
      ).rows.map((r) => r.slug),
    );
    let slug = base;
    for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
    const cid = (
      await c.query<{ id: string }>(
        "INSERT INTO clients (name, slug, country, region, city, source, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
        [body.name, slug, body.country, body.region ?? null, body.city || null, body.source, now],
      )
    ).rows[0]!.id;
    let instanceId = newInstanceId();
    while ((await c.query("SELECT 1 FROM licences WHERE instance_id = $1", [instanceId])).rowCount)
      instanceId = newInstanceId();
    await c.query(
      `INSERT INTO licences (client_id, instance_id, key_hash, key_last4, type, paid_until, trial_ends, paying_since, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        cid,
        instanceId,
        hashKey(licenseKey),
        lastFour(licenseKey),
        plan.type,
        // A subscription's first payment is due the day it's made (Mark paid moves it on); ruled in the ledger.
        plan.type === "subscription" ? today : null,
        plan.type === "trial" ? addDays(today, TRIAL_DAYS) : null,
        plan.type === "subscription" ? now : null,
        now,
      ],
    );
    await c.query(
      "INSERT INTO prices (client_id, currency, amount, period_months, effective_from) VALUES ($1, $2, $3, $4, $5)",
      [cid, plan.currency, plan.amount, plan.periodMonths, now],
    );
    await event(c, cid, now, "created", {
      type: plan.type,
      price: { currency: plan.currency, amount: plan.amount, periodMonths: plan.periodMonths },
    });
    return cid;
  });
  return { client: (await getClient(ctx, id)).client, licenseKey };
}

export async function updateClient(ctx: Ctx, id: string, body: z.infer<typeof patchClientSchema>) {
  await tx(ctx, async (c) => {
    const r = await lockRow(c, id);
    const country = body.country ?? r.country;
    const region = body.region !== undefined ? body.region : country === r.country ? r.region : null;
    checkPlace(country, region);
    await c.query(
      "UPDATE clients SET name = $2, country = $3, region = $4, city = $5, source = $6 WHERE id = $1",
      [
        id,
        body.name ?? r.name,
        country,
        region,
        body.city !== undefined ? body.city || null : r.city,
        body.source ?? r.source,
      ],
    );
  });
  return getClient(ctx, id);
}

/** A new price adds a row (the old one stays: "Price up", "Price down"); it starts with the next bill. */
export async function changePrice(ctx: Ctx, id: string, p: z.infer<typeof priceSchema>) {
  const now = ctx.now();
  await tx(ctx, async (c) => {
    const r = await lockRow(c, id);
    checkPeriod(r.type, p.periodMonths);
    await c.query(
      "INSERT INTO prices (client_id, currency, amount, period_months, effective_from) VALUES ($1, $2, $3, $4, $5)",
      [id, p.currency, p.amount, p.periodMonths, now],
    );
    await event(c, id, now, "price", {
      from: r.currency
        ? { currency: r.currency, amount: Number(r.amount), periodMonths: r.period_months }
        : null,
      to: { currency: p.currency, amount: p.amount, periodMonths: p.periodMonths },
    });
  });
  return getClient(ctx, id);
}

/** A day plus whole months, held to the month's last day (31 Jan + 1 month is 28 Feb). */
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return utcDay(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))));
}
const later = (a: string | null, b: string) => (a && a > b ? a : b);

async function clearReminder(c: pg.PoolClient, id: string, now: Date) {
  const r = await c.query("UPDATE notices SET cleared_at = $2 WHERE client_id = $1 AND cleared_at IS NULL", [
    id,
    now,
  ]);
  if (r.rowCount) await event(c, id, now, "reminder_off");
}

/**
 * Mark paid: a payment of the current price at today's rate (kept with it), and paid until moves on one period
 * from the later of today and where it was. A trial's first payment makes it a subscription. The reminder clears.
 */
export async function markPaid(ctx: Ctx, id: string, note: string | null) {
  const now = ctx.now();
  const today = utcDay(now);
  const rates = await currentRates(ctx);
  await tx(ctx, async (c) => {
    const r = await lockRow(c, id);
    if (!r.currency) throw new Refusal(409, "This client has no price to be paid.");
    const amount = Number(r.amount);
    const rate = rateOf(rates.rates, r.currency);
    let until: string | null = null;
    if (r.type !== "perpetual") {
      until = addMonths(later(r.type === "subscription" ? r.paid_until : null, today), r.period_months || 1);
      await c.query(
        "UPDATE licences SET type = 'subscription', paid_until = $2, paying_since = coalesce(paying_since, $3) WHERE client_id = $1",
        [id, until, now],
      );
      if (r.type === "trial") await event(c, id, now, "converted");
    }
    await c.query(
      `INSERT INTO payments (client_id, amount, currency, rate_to_inr, amount_inr, paid_at, paid_until, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        amount,
        r.currency,
        rate,
        rate === null ? null : Math.round(amount * rate * 100) / 100,
        now,
        until,
        note,
      ],
    );
    await event(c, id, now, "paid", { until, amount, currency: r.currency });
    await clearReminder(c, id, now);
  });
  return getClient(ctx, id);
}

/** Extend: paid until (or a trial's end) moves on 1, 3 or 12 months, with no payment. */
export async function extend(ctx: Ctx, id: string, months: 1 | 3 | 12) {
  const now = ctx.now();
  const today = utcDay(now);
  await tx(ctx, async (c) => {
    const r = await lockRow(c, id);
    if (r.type === "perpetual") throw new Refusal(409, "A perpetual licence never runs out.");
    const until = addMonths(later(r.type === "trial" ? r.trial_ends : r.paid_until, today), months);
    if (r.type === "trial")
      await c.query("UPDATE licences SET trial_ends = $2 WHERE client_id = $1", [id, until]);
    else await c.query("UPDATE licences SET paid_until = $2 WHERE client_id = $1", [id, until]);
    await event(c, id, now, "extended", { months, until });
  });
  return getClient(ctx, id);
}

/** The payment reminder: on (with an optional note; a second one replaces the note), and Stop. */
export async function reminderOn(ctx: Ctx, id: string, note: string) {
  const now = ctx.now();
  await tx(ctx, async (c) => {
    const r = await lockRow(c, id);
    const open = await c.query("UPDATE notices SET note = $2 WHERE client_id = $1 AND cleared_at IS NULL", [
      id,
      note,
    ]);
    if (open.rowCount) return;
    await c.query("INSERT INTO notices (client_id, note, due_date, created_at) VALUES ($1, $2, $3, $4)", [
      id,
      note,
      r.paid_until ?? r.trial_ends,
      now,
    ]);
    await event(c, id, now, "reminder_on", { note });
  });
  return getClient(ctx, id);
}
export async function reminderOff(ctx: Ctx, id: string) {
  await tx(ctx, async (c) => {
    await lockRow(c, id);
    await clearReminder(c, id, ctx.now());
  });
  return getClient(ctx, id);
}

/** A new key, shown once; the old one stops at once. */
export async function rotateKey(ctx: Ctx, id: string) {
  const licenseKey = newLicenceKey();
  await tx(ctx, async (c) => {
    await lockRow(c, id);
    await c.query("UPDATE licences SET key_hash = $2, key_last4 = $3 WHERE client_id = $1", [
      id,
      hashKey(licenseKey),
      lastFour(licenseKey),
    ]);
    await event(c, id, ctx.now(), "key_rotated", { last4: lastFour(licenseKey) });
  });
  return { licenseKey, ...(await getClient(ctx, id)) };
}

export async function setSuspended(ctx: Ctx, id: string, suspended: boolean) {
  const now = ctx.now();
  await tx(ctx, async (c) => {
    const r = await lockRow(c, id);
    if (!!r.suspended_at === suspended) return;
    await c.query("UPDATE licences SET suspended_at = $2 WHERE client_id = $1", [id, suspended ? now : null]);
    await event(c, id, now, suspended ? "suspended" : "resumed");
  });
  return getClient(ctx, id);
}

/* ---------- settings ---------- */

export const settingsSchema = z
  .object({
    listPriceInr: z.number().min(0).max(100_000_000).optional(),
    latestVersion: z
      .string()
      .regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/)
      .nullable()
      .optional(),
    billingContact: z
      .string()
      .max(300)
      .regex(/^(mailto:|tel:|https:)\S+$/)
      .nullable()
      .optional(),
  })
  .strict();
type SettingsRow = { list_price_inr: string; latest_version: string | null; billing_contact: string | null };
async function settingsRow(db: pg.Pool): Promise<SettingsRow> {
  return (
    await db.query<SettingsRow>(
      "SELECT list_price_inr::text, latest_version, billing_contact FROM settings WHERE id = 1",
    )
  ).rows[0]!;
}
export async function getSettings(ctx: Ctx, email: string) {
  const s = await settingsRow(ctx.db);
  return {
    listPriceInr: Number(s.list_price_inr),
    latestVersion: s.latest_version,
    billingContact: s.billing_contact,
    email,
  };
}
export async function patchSettings(ctx: Ctx, email: string, b: z.infer<typeof settingsSchema>) {
  const s = await settingsRow(ctx.db);
  await ctx.db.query(
    "UPDATE settings SET list_price_inr = $1, latest_version = $2, billing_contact = $3, updated_at = $4 WHERE id = 1",
    [
      b.listPriceInr ?? Number(s.list_price_inr),
      b.latestVersion !== undefined ? b.latestVersion : s.latest_version,
      b.billingContact !== undefined ? b.billingContact : s.billing_contact,
      ctx.now(),
    ],
  );
  return getSettings(ctx, email);
}

/* ---------- analytics, alerts, releases ---------- */

/** Every client as the analytics read them. */
export async function analyticsClients(db: pg.Pool): Promise<AClient[]> {
  const { rows } = await db.query<{
    id: string;
    name: string;
    country: string;
    region: string | null;
    source: Source;
    type: LicenceType;
    created_at: Date;
    paying_since: Date | null;
    ended_at: Date | null;
    trial_ends: string | null;
    prices: { currency: string; amount: number; period_months: number; from: string }[];
  }>(
    `SELECT c.id, c.name, c.country, c.region, c.source, l.type, c.created_at, l.paying_since,
            coalesce(c.decommissioned_at, l.suspended_at) AS ended_at, to_char(l.trial_ends, 'YYYY-MM-DD') AS trial_ends,
            coalesce((SELECT json_agg(json_build_object('currency', p.currency, 'amount', p.amount, 'period_months', p.period_months,
                                                        'from', p.effective_from) ORDER BY p.effective_from, p.id)
                        FROM prices p WHERE p.client_id = c.id), '[]') AS prices
       FROM clients c JOIN licences l ON l.client_id = c.id`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    country: r.country,
    region: r.region,
    source: r.source,
    type: r.type,
    createdAt: r.created_at,
    payingSince: r.type === "perpetual" ? null : r.paying_since,
    endedAt: r.ended_at,
    trialEnds: r.trial_ends,
    trialStarted: r.trial_ends !== null,
    prices: r.prices.map((p) => ({
      currency: p.currency,
      amount: Number(p.amount),
      periodMonths: p.period_months,
      from: new Date(p.from),
    })),
  }));
}

export async function analytics(ctx: Ctx, range: 3 | 6 | 12) {
  const [rates, clients, s] = await Promise.all([
    currentRates(ctx),
    analyticsClients(ctx.db),
    settingsRow(ctx.db),
  ]);
  return {
    ...computeAnalytics({
      clients,
      rates: rates.rates,
      now: ctx.now(),
      range,
      listPriceInr: Number(s.list_price_inr),
    }),
    rates: { day: rates.day, ageDays: rates.ageDays },
  };
}

async function latestVersion(db: pg.Pool): Promise<string | null> {
  const s = await settingsRow(db);
  if (s.latest_version) return s.latest_version;
  const seen = (await db.query<{ v: string }>("SELECT DISTINCT app_version AS v FROM check_ins")).rows.map(
    (r) => r.v,
  );
  return seen.sort(compareVersions).at(-1) ?? null;
}

async function currentAlerts(ctx: Ctx) {
  const { clients } = await listClients(ctx);
  const ac: AlertClient[] = clients.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    paidUntil: c.paidUntil,
    trialEnds: c.trialEnds,
    suspended: !!c.suspendedAt,
    decommissioned: !!c.decommissionedAt,
    lastCheckInAt: c.lastCheckIn?.at ?? null,
    version: c.lastCheckIn?.version ?? null,
    price: c.price,
    monthlyInr: c.monthlyInr,
  }));
  return alertsFor(ac, { now: ctx.now(), latestVersion: await latestVersion(ctx.db) });
}
export async function listAlerts(ctx: Ctx) {
  const hidden = new Map(
    (
      await ctx.db.query<{ alert_id: string; fingerprint: string }>(
        "SELECT alert_id, fingerprint FROM alert_dismissals",
      )
    ).rows.map((r) => [r.alert_id, r.fingerprint]),
  );
  return { alerts: visibleAlerts(await currentAlerts(ctx), hidden) };
}
/** Hide one alert, or all of them, for as long as each one's condition stays the same. */
export async function dismissAlerts(ctx: Ctx, which: { id?: string; all?: boolean }) {
  const all = await currentAlerts(ctx);
  const chosen = which.all ? all : all.filter((a) => a.id === which.id);
  for (const a of chosen)
    await ctx.db.query(
      `INSERT INTO alert_dismissals (alert_id, fingerprint, at) VALUES ($1, $2, $3)
       ON CONFLICT (alert_id) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, at = EXCLUDED.at`,
      [a.id, a.fingerprint, ctx.now()],
    );
  return listAlerts(ctx);
}

/** Releases: the latest version, and which clients are on which (newest first). */
export async function releases(ctx: Ctx) {
  const { clients } = await listClients(ctx);
  const by = new Map<string, { id: string; name: string; lastCheckInAt: string }[]>();
  for (const c of clients) {
    if (!c.lastCheckIn || c.suspendedAt || c.decommissionedAt) continue;
    const list = by.get(c.lastCheckIn.version) ?? [];
    list.push({ id: c.id, name: c.name, lastCheckInAt: c.lastCheckIn.at });
    by.set(c.lastCheckIn.version, list);
  }
  return {
    latest: await latestVersion(ctx.db),
    versions: [...by.entries()]
      .sort(([a], [b]) => compareVersions(b, a))
      .map(([version, cs]) => ({ version, clients: cs })),
    waiting: clients
      .filter((c) => !c.lastCheckIn && !c.suspendedAt && !c.decommissionedAt)
      .map((c) => ({ id: c.id, name: c.name })),
  };
}
