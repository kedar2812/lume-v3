import {
  AI_LEAD_ACTIONS_MAX,
  AI_LEADS_NOTICE_SHARE,
  aiAllowance,
  aiLeadAllowance,
  aiLimitState,
  aiMonthKey,
  aiPace,
  aiSpend,
  aiWindows,
  backWords,
  aiSafetyMonthly,
  can,
  isCountedTask,
  moduleIncluded,
  moreLeadsLine,
  PLAN_TIERS,
  tierName,
  type PlanTier,
  usesLeads,
  usesMonthly,
  type AiLimitState,
  type AiModelTokens,
  type AiPause,
  type AiTask,
} from "@lume/core";
import { eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type pg from "pg";
import type { z } from "zod";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { HttpError } from "../../http/errors";
import { assertModule } from "../../licence/plan";
import { AiUnreadable, type AiUsage } from "../../ai/provider";
import { handOverAtMax } from "../autopilot/at-max";
import { adminIds, notify } from "../notifications/notify";
import { integrationsView } from "../sheets/service";

/** How long a read may take (spec 2026-10-18 plan Review Focus 4): the call or note is already saved. */
const TIMEOUT_MS = 20_000;

/**
 * Why there's no read. `leads`: this month's AI leads are used up and this lead isn't one of them; `lead_cap`: this lead
 * has had its 20 counted reads this month (AI leads, 2026-11-12). Both until the 1st (`until`), a top-up sooner for
 * `leads`.
 */
export type AiUnavailable =
  | { unavailable: "off" | "not_configured" | "failed" }
  | { unavailable: "limit"; by: AiPause["by"]; until: string }
  | { unavailable: "leads" | "lead_cap"; until: string };
export type AiStatus = { on: boolean } & AiLimitState & {
    /** The licence counts LUME AI in AI leads (plan5, 2026-11-12), whether or not it sets a limit. */
    countsLeads: boolean;
    /** The month's spend at the owner's prices per model (LUME_AI_PRICES); null when none are set or one is missing. */
    spend: { used: number; cap: number | null; currency: "USD" } | null;
    /** About how many days the month's allowance (its AI leads, when the licence counts them) lasts at this pace. */
    pace: { daysLeft: number | null };
    /** For admins: whether a top-up has been asked for this month. Null for everyone else. */
    topUp: { asked: boolean } | null;
  };

async function settingsOf(req: FastifyRequest): Promise<{ on: boolean; tz: string }> {
  const [s] = await req.db
    .select({ i: schema.settings.integrations, tz: schema.settings.timezone })
    .from(schema.settings)
    .where(eq(schema.settings.id, 1));
  return { on: !!s?.i.ai?.enabled, tz: s?.tz ?? "UTC" };
}

const planOf = (req: FastifyRequest) => req.server.licence.view().plan;
/**
 * The plan's limits. A licence that counts AI leads (plan5, 2026-11-12) gives the month's AI leads with their top-ups
 * and each lead's 20 counted reads, and its reads a month become a hidden safety net. One that signs the month (plan4,
 * Autopilot spec 2026-10-19 §4) counts the month's reads and their top-ups. Either way the week no longer applies; an
 * older licence keeps it. The hour holds always. A licence with no AI leads limit has no per-lead limit either.
 */
const limitsOf = (req: FastifyRequest, month: string) => {
  const plan = planOf(req);
  const leadsPlan = usesLeads(plan);
  const monthlyPlan = usesMonthly(plan) || leadsPlan;
  const leads = leadsPlan ? aiLeadAllowance(plan, month) : null;
  return {
    hourly: plan?.aiReadsHourly ?? null,
    weekly: monthlyPlan ? null : (plan?.aiReadsWeekly ?? null),
    monthly: leadsPlan ? aiSafetyMonthly(plan, month) : monthlyPlan ? aiAllowance(plan, month) : null,
    leads,
    leadMax: leads === null ? null : AI_LEAD_ACTIONS_MAX,
    leadsPlan,
  };
};
/** What a top-up is asked against and noticed at: the month's AI leads when the licence counts them, else its reads. */
const allowanceOf = (l: ReturnType<typeof limitsOf>) => (l.leadsPlan ? l.leads : (l.monthly ?? null));

/** Switched on, set up on this server, and in this LUME's plan. */
export async function available(
  req: FastifyRequest,
  d: AppDeps,
): Promise<{ ok: boolean; why: "off" | "not_configured"; tz: string }> {
  const s = await settingsOf(req);
  if (!d.ai) return { ok: false, why: "not_configured", tz: s.tz };
  return { ok: s.on && moduleIncluded(planOf(req), "ai"), why: "off", tz: s.tz };
}

async function stateNow(req: FastifyRequest, d: AppDeps, tz: string): Promise<AiLimitState> {
  const now = d.clock();
  const w = aiWindows(now, tz);
  const r = await req.db.execute<{
    hour_n: number;
    hour_oldest: Date | string | null;
    week_n: number;
    month_n: number;
    month_in: string | number;
    month_out: string | number;
  }>(
    sql`SELECT * FROM lume_ai_usage(${w.hourSince.toISOString()}::timestamptz, ${w.weekStart.toISOString()}::timestamptz, ${w.monthStart.toISOString()}::timestamptz)`,
  );
  const u = r.rows[0];
  const month = aiMonthKey(now, tz);
  const state = aiLimitState(
    {
      hourN: Number(u?.hour_n ?? 0),
      hourOldest: u?.hour_oldest ? new Date(u.hour_oldest) : null,
      weekN: Number(u?.week_n ?? 0),
      monthN: Number(u?.month_n ?? 0),
      leadsN: await leadsUsed(d.jobPool ?? d.pool, month),
    },
    limitsOf(req, month),
    now,
    tz,
  );
  return state;
}

/** The month's AI leads ("YYYY-MM" on the business's clock), counted always, whatever the licence. */
async function leadsUsed(pool: pg.Pool, month: string): Promise<number> {
  const r = await pool.query<{ n: number }>("SELECT lume_ai_leads_used($1) AS n", [month]);
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * The month's tokens by the model that served them (2026-11-12): every finished read, failed ones too (the provider
 * billed them), on the business's month.
 */
async function monthTokens(req: FastifyRequest, monthStart: Date): Promise<AiModelTokens[]> {
  const r = await req.db.execute<{
    model: string;
    input_tokens: string | number;
    output_tokens: string | number;
    cache_write_tokens: string | number;
    cache_read_tokens: string | number;
  }>(sql`SELECT * FROM lume_ai_month_tokens(${monthStart.toISOString()}::timestamptz)`);
  return r.rows.map((x) => ({
    model: x.model,
    inputTokens: Number(x.input_tokens),
    outputTokens: Number(x.output_tokens),
    cacheWriteTokens: Number(x.cache_write_tokens),
    cacheReadTokens: Number(x.cache_read_tokens),
  }));
}

/**
 * Whether a top-up asked for this month still stands (kept in ai_limit_notices as `topup_asked`, with the month's
 * allowance when it was asked): until the licence brings a larger allowance, the owner's top-up. A request from before
 * the allowance was kept stands all month, as it used to.
 */
async function topUpAsked(pool: pg.Pool, monthStart: Date, allowance: number | null): Promise<boolean> {
  const r = await pool.query<{ allowance: number | null }>(
    "SELECT allowance FROM ai_limit_notices WHERE kind = 'topup_asked' AND window_start = $1",
    [monthStart],
  );
  const row = r.rows[0];
  if (!row) return false;
  return row.allowance === null || allowance === null || allowance <= row.allowance;
}

/**
 * `GET /api/v1/ai`: whether LUME AI is on for this person, this hour's, this week's and this month's use, the month's
 * spend at the owner's prices and its pace, and for admins whether a top-up has been asked for.
 */
export async function aiStatus(req: FastifyRequest, d: AppDeps): Promise<AiStatus> {
  const a = await available(req, d);
  const state = await stateNow(req, d, a.tz);
  const w = aiWindows(d.clock(), a.tz);
  const byLeads = limitsOf(req, aiMonthKey(d.clock(), a.tz)).leadsPlan;
  return {
    on: a.ok,
    ...state,
    countsLeads: byLeads,
    spend: d.aiPricing ? aiSpend(await monthTokens(req, w.monthStart), d.aiPricing) : null,
    pace: aiPace(byLeads ? state.leads : state.month, d.clock(), w.monthStart),
    topUp: can(req.actor!, "settings.manage")
      ? {
          asked: await topUpAsked(
            d.jobPool ?? d.pool,
            w.monthStart,
            byLeads ? state.leads.limit : state.month.limit,
          ),
        }
      : null,
  };
}

/**
 * `POST /api/v1/ai/topup` (admins; Autopilot spec 2026-10-19 §4): ask the owner for more LUME AI this month, through the
 * licence server. One request reaches the owner until the top-up arrives; asking again meanwhile says it's already asked.
 */
export async function requestTopUp(
  req: FastifyRequest,
  d: AppDeps,
  note: string | undefined,
): Promise<{ asked: true; already?: true }> {
  const tz = (await settingsOf(req)).tz;
  const now = d.clock();
  const w = aiWindows(now, tz);
  const allowance = allowanceOf(limitsOf(req, aiMonthKey(now, tz)));
  const pool = d.jobPool ?? d.pool;
  // Still asked (pressed again, or by another admin): LUME answers itself; nothing more goes to the owner.
  if (await topUpAsked(pool, w.monthStart, allowance)) return { asked: true, already: true };
  const me = (
    await req.db
      .select({ name: schema.users.name, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, req.actor!.userId))
  )[0];
  const r = await req.server.licence.requestTopUp({
    month: aiMonthKey(now, tz),
    askedBy: { name: me?.name ?? "An admin", email: me?.email ?? "" },
    ...(note ? { note } : {}),
  });
  if (!r.ok) {
    if (r.reason === "no_key")
      throw new HttpError(
        409,
        "NO_LICENCE",
        "This LUME has no licence key to ask with. Add it in Settings → About.",
      );
    if (r.reason === "limited")
      throw new HttpError(429, "RATE_LIMITED", "LUME has asked several times today. Try again tomorrow.");
    throw new HttpError(
      502,
      "UNREACHABLE",
      "LUME couldn't reach its licence server just now. Try again in a minute.",
    );
  }
  // Asked at this allowance: it stands until a larger one arrives (a new ask after a top-up replaces the last).
  await pool.query(
    `INSERT INTO ai_limit_notices (kind, window_start, allowance) VALUES ('topup_asked', $1, $2)
     ON CONFLICT (kind, window_start) DO UPDATE SET allowance = EXCLUDED.allowance, sent_at = now()`,
    [w.monthStart, allowance],
  );
  await audit(req, { action: "ai.topup_asked", entityType: "integration", diff: { module: "ai" } });
  return r.already ? { asked: true, already: true } : { asked: true };
}

/**
 * `POST /api/v1/plan/ask` (admins; Plans and pricing, November 2026): ask LUME about a higher tier, through the
 * licence server's request channel, in words the owner reads. Only a tier above this LUME's own.
 */
export async function askAboutPlan(
  req: FastifyRequest,
  d: AppDeps,
  tier: PlanTier,
): Promise<{ asked: true }> {
  const now = PLAN_TIERS.indexOf(planOf(req)?.tier ?? "enterprise");
  if (PLAN_TIERS.indexOf(tier) <= now)
    throw new HttpError(409, "PLAN_TIER", `This LUME already has everything in ${tierName(tier)}.`);
  const tz = (await settingsOf(req)).tz;
  const me = (
    await req.db
      .select({ name: schema.users.name, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, req.actor!.userId))
  )[0];
  const r = await req.server.licence.requestTopUp({
    month: aiMonthKey(d.clock(), tz),
    askedBy: { name: me?.name ?? "An admin", email: me?.email ?? "" },
    note: `They'd like to move to ${tierName(tier)}.`,
  });
  if (!r.ok) {
    if (r.reason === "no_key")
      throw new HttpError(
        409,
        "NO_LICENCE",
        "This LUME has no licence key to ask with. Add it in Settings → About.",
      );
    if (r.reason === "limited")
      throw new HttpError(429, "RATE_LIMITED", "LUME has asked several times today. Try again tomorrow.");
    throw new HttpError(
      502,
      "UNREACHABLE",
      "LUME couldn't reach its licence server just now. Try again in a minute.",
    );
  }
  await audit(req, { action: "plan.asked", entityType: "integration", diff: { tier } });
  return { asked: true };
}

/** Settings → Integrations → LUME AI (admins). */
export async function setAiEnabled(req: FastifyRequest, d: AppDeps, enabled: boolean) {
  if (enabled) {
    assertModule(req, "ai");
    if (!d.ai) throw new HttpError(409, "AI_NOT_CONFIGURED", "LUME AI isn't set up on this server yet.");
  }
  await req.db.execute(
    sql`UPDATE settings SET integrations = jsonb_set(integrations, '{ai}', ${JSON.stringify({ enabled })}::jsonb) WHERE id = 1`,
  );
  await audit(req, {
    action: enabled ? "integration.enabled" : "integration.disabled",
    entityType: "integration",
    diff: { module: "ai" },
  });
  return integrationsView(req, d);
}

/**
 * One notice per window to every admin. The month's are once per allowance: after a top-up raises it, admins hear again
 * at 75%, 90% and the limit of the new one (a busy month can run through a top-up too).
 */
async function noticeOnce(
  pool: pg.Pool,
  kind:
    | "week_75"
    | "week_90"
    | "week_limit"
    | "hour_limit"
    | "month_75"
    | "month_90"
    | "month_limit"
    | "leads_80"
    | "leads_limit",
  windowStart: Date,
  n: { title: string; body: string },
  allowance: number | null = null,
): Promise<void> {
  const first = await pool.query(
    `INSERT INTO ai_limit_notices (kind, window_start, allowance) VALUES ($1, $2, $3)
     ON CONFLICT (kind, window_start) DO UPDATE SET allowance = EXCLUDED.allowance, sent_at = now()
       WHERE ai_limit_notices.allowance < EXCLUDED.allowance`,
    [kind, windowStart, allowance],
  );
  if (!first.rowCount) return;
  for (const id of await adminIds(pool)) await notify(pool, id, { kind: "system_alert", ...n });
}

/**
 * Admins hear at 80% of the month's AI leads and when they're all used (2026-11-12), once per allowance (a top-up
 * raises it and they hear again). `full`: a new lead was just turned away, so they're all used whatever the count says.
 */
async function noticeLeads(
  req: FastifyRequest,
  side: pg.Pool,
  limit: number | null,
  month: string,
  monthStart: Date,
  back: string,
  full = false,
): Promise<void> {
  if (limit === null) return;
  const used = await leadsUsed(side, month);
  const notices = [
    {
      at: Math.ceil(limit * AI_LEADS_NOTICE_SHARE),
      kind: "leads_80" as const,
      title: `LUME AI has used ${Math.round(AI_LEADS_NOTICE_SHARE * 100)}% of this month's AI leads`,
      body: `${used.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")} AI leads used this month. They start again ${back}.`,
    },
    {
      at: limit,
      kind: "leads_limit" as const,
      title: "LUME AI has used this month's AI leads",
      body: `${limit === 1 ? "The month's 1 AI lead is" : `All ${limit.toLocaleString("en-US")} AI leads are`} used this month. Leads it's already working on keep it; new leads start again ${back}, or sooner with a top-up.`,
    },
  ];
  // On a tier (Plans and pricing, November 2026), what to do about it: a top-up, or the next tier.
  const more = moreLeadsLine(planOf(req)?.tier);
  for (const x of notices)
    if (full ? x.kind === "leads_limit" : limit > 0 && used >= x.at)
      await noticeOnce(
        side,
        x.kind,
        monthStart,
        { title: x.title, body: more ? `${x.body} ${more}` : x.body },
        limit,
      ).catch((err: unknown) => req.log.warn({ err }, "couldn't tell admins about LUME AI's leads"));
}

/**
 * Autopilot starting on a lead (its first message, AI leads 2026-11-12) counts it this month, whether or not choosing
 * its template needs a read. Turned away when the month's AI leads are used up and it isn't one of them, or when it has
 * had its 20 this month. Nothing is counted while LUME AI is off or not set up (the run pauses for that itself).
 */
export async function startAiLead(
  req: FastifyRequest,
  d: AppDeps,
  leadId: string,
): Promise<
  { ok: true } | { ok: false; why: "leads" | "lead_cap"; until: string; back: string; month: string }
> {
  const a = await available(req, d);
  if (!a.ok || !d.ai) return { ok: true };
  const side = d.jobPool ?? d.pool;
  const now = d.clock();
  const w = aiWindows(now, a.tz);
  const month = aiMonthKey(now, a.tz);
  const limits = limitsOf(req, month);
  const until = w.nextMonthStart.toISOString();
  const back = backWords({ by: "month", until }, now, a.tz);
  if (limits.leadMax !== null) {
    const m = (
      await side.query<{ counted: boolean; reads: number }>(
        "SELECT counted, reads FROM lume_ai_lead_month($1, $2, $3)",
        [leadId, month, now],
      )
    ).rows[0];
    if (m?.counted && Number(m.reads) >= limits.leadMax)
      return { ok: false, why: "lead_cap", until, back, month };
  }
  const r = (
    await side.query<{ r: "counted" | "started" | "full" }>(
      "SELECT lume_ai_start_lead($1, $2, $3, $4) AS r",
      [leadId, month, now, limits.leads],
    )
  ).rows[0]?.r;
  if (r === "full") {
    await noticeLeads(req, side, limits.leads, month, w.monthStart, back, true);
    return { ok: false, why: "leads", until, back, month };
  }
  if (r === "started") await noticeLeads(req, side, limits.leads, month, w.monthStart, back);
  return { ok: true };
}

/** Whether a new lead could start LUME AI now: no AI leads limit, or some left this month (a top-up, the 1st). */
export async function aiLeadsRoom(req: FastifyRequest, d: AppDeps): Promise<boolean> {
  const tz = (await settingsOf(req)).tz;
  const month = aiMonthKey(d.clock(), tz);
  const limit = limitsOf(req, month).leads;
  return limit === null || (await leadsUsed(d.jobPool ?? d.pool, month)) < limit;
}

/**
 * One AI read on a lead the caller may see (spec 2026-10-18 §2.2–2.3). Its slot is reserved — under one lock, in its
 * own short transaction, so the limits hold exactly — then the provider is called outside any transaction, then the
 * slot is finished. A failed or timed-out read isn't counted. Admins hear at 75% and 90% of the week and at a limit;
 * with AI leads (2026-11-12) at 80% and all of the month's. A read that counts (an Autopilot reply, a next step, a
 * catch-up) counts its lead this month, or is refused when the month's AI leads are used up and it isn't one of them,
 * or when it has had its 20; after its 20th a next step or a catch-up hands the lead to a person (Autopilot's own
 * reply does once it's sent: `atMax`).
 */
export async function runRead<T>(
  req: FastifyRequest,
  d: AppDeps,
  o: {
    task: AiTask;
    /** None only for a template drafted for the business (2026-10-31). */
    leadId: string | null;
    sourceActivityId?: string;
    instructions: string;
    input: string;
    schema: z.ZodType<T>;
    maxOutputTokens: number;
    /** What the business can actually use of the answer (ids from its own lists, a time after now…). */
    clean?: (out: T) => T;
    /** What's kept on the read, from the cleaned answer (the answer itself when unset). */
    store?: (out: T) => unknown;
  },
): Promise<{ id: string; output: T; atMax?: true } | AiUnavailable> {
  const a = await available(req, d);
  if (!a.ok || !d.ai) return { unavailable: a.why };
  const ai = d.ai;
  // The action's own model when one is set (the Haiku split, 2026-11-12): sent with the read and kept on it.
  const model = d.aiModels?.[o.task] ?? ai.model;
  const side = d.jobPool ?? d.pool;
  const now = d.clock();
  const w = aiWindows(now, a.tz);
  const monthKey = aiMonthKey(now, a.tz);
  const limits = limitsOf(req, monthKey);
  // The month a read that counts counts in: only those, and only about a lead.
  const leadMonth = isCountedTask(o.task) && o.leadId !== null ? monthKey : null;
  const slot = (
    await side.query<{
      id: string | null;
      refused: "hour" | "week" | "month" | "leads" | "lead_cap" | null;
      hour_oldest: Date | null;
    }>(
      "SELECT * FROM lume_ai_reserve($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)",
      [
        o.leadId,
        req.actor!.userId,
        o.task,
        o.sourceActivityId ?? null,
        ai.name,
        model,
        now,
        limits.hourly,
        limits.weekly,
        limits.monthly,
        w.hourSince,
        w.weekStart,
        w.monthStart,
        leadMonth,
        limits.leads,
        limits.leadMax,
      ],
    )
  ).rows[0]!;
  const backOn = () => backWords({ by: "month", until: w.nextMonthStart.toISOString() }, now, a.tz);
  if (slot.refused === "lead_cap") {
    // Its 20 this month: a person's from here (said once), and back on the 1st.
    if (o.leadId) await handOverAtMax(req, d, o.leadId, monthKey, backOn());
    return { unavailable: "lead_cap", until: w.nextMonthStart.toISOString() };
  }
  if (slot.refused === "leads") {
    await noticeLeads(req, side, limits.leads, monthKey, w.monthStart, backOn(), true);
    return { unavailable: "leads", until: w.nextMonthStart.toISOString() };
  }
  if (!slot.id) {
    const pause: AiPause =
      slot.refused === "month"
        ? { by: "month", until: w.nextMonthStart.toISOString() }
        : slot.refused === "week"
          ? { by: "week", until: w.nextWeekStart.toISOString() }
          : { by: "hour", until: new Date((slot.hour_oldest ?? now).getTime() + 3_600_000).toISOString() };
    const notice =
      pause.by === "month"
        ? limits.leadsPlan
          ? {
              kind: "month_limit" as const,
              window: w.monthStart,
              title: "LUME AI has paused for the rest of the month",
              body: `It reached its monthly safety limit and is back ${backWords(pause, now, a.tz)}, or sooner with a top-up: ask for one from LUME AI's ring.`,
            }
          : {
              kind: "month_limit" as const,
              window: w.monthStart,
              title: "LUME AI has reached this month's allowance",
              body: `It's back ${backWords(pause, now, a.tz)}, or sooner with a top-up: ask for one from LUME AI's ring.`,
            }
        : {
            kind: pause.by === "week" ? ("week_limit" as const) : ("hour_limit" as const),
            window: pause.by === "week" ? w.weekStart : new Date(pause.until),
            title: `LUME AI has reached this ${pause.by}'s limit`,
            body: `It's back ${backWords(pause, now, a.tz)}.`,
          };
    await noticeOnce(
      side,
      notice.kind,
      notice.window,
      { title: notice.title, body: notice.body },
      pause.by === "month" ? (limits.monthly ?? null) : null,
    ).catch((err: unknown) => req.log.warn({ err }, "couldn't tell admins about LUME AI's limit"));
    return { unavailable: "limit", by: pause.by, until: pause.until };
  }
  // Every finished read keeps what the provider billed (2026-11-12): a failed one too, when it answered at all.
  const finish = (status: "ok" | "failed", result: unknown, u: AiUsage | null) =>
    side.query("SELECT lume_ai_finish($1, $2, $3, $4, $5, $6, $7)", [
      slot.id,
      status,
      result === null ? null : JSON.stringify(result),
      u?.inputTokens ?? 0,
      u?.outputTokens ?? 0,
      u?.cacheWriteTokens ?? 0,
      u?.cacheReadTokens ?? 0,
    ]);
  let answer: Awaited<ReturnType<typeof ai.read<T>>>;
  try {
    answer = await ai.read({
      model,
      instructions: o.instructions,
      input: o.input,
      schema: o.schema,
      maxOutputTokens: o.maxOutputTokens,
      signal: AbortSignal.timeout(d.aiTimeoutMs ?? TIMEOUT_MS),
    });
  } catch (err) {
    req.log.warn({ err, provider: ai.name, task: o.task }, "LUME AI couldn't read this");
    await finish("failed", null, err instanceof AiUnreadable ? err.usage : null);
    return { unavailable: "failed" };
  }
  const output = o.clean ? o.clean(answer.output) : answer.output;
  await finish("ok", o.store ? o.store(output) : output, {
    inputTokens: answer.inputTokens,
    outputTokens: answer.outputTokens,
    cacheWriteTokens: answer.cacheWriteTokens ?? 0,
    cacheReadTokens: answer.cacheReadTokens ?? 0,
  });
  let atMax = false;
  if (leadMonth !== null && o.leadId !== null && limits.leadMax !== null) {
    const reads = await side.query<{ reads: number }>("SELECT reads FROM lume_ai_lead_month($1, $2, $3)", [
      o.leadId,
      leadMonth,
      now,
    ]);
    atMax = Number(reads.rows[0]?.reads ?? 0) >= limits.leadMax;
    // Its 20th: a next step or a catch-up hands it over now; Autopilot's own reply goes first, then hands it over.
    if (atMax && o.task !== "autopilot_reply") await handOverAtMax(req, d, o.leadId, leadMonth, backOn());
  }
  if (leadMonth !== null) await noticeLeads(req, side, limits.leads, leadMonth, w.monthStart, backOn());
  if (!limits.leadsPlan && limits.monthly !== null && limits.monthly !== undefined) {
    const used = (await stateNow(req, d, a.tz)).month.used;
    const back = backWords({ by: "month", until: w.nextMonthStart.toISOString() }, now, a.tz);
    for (const [share, kind] of [
      [0.75, "month_75"],
      [0.9, "month_90"],
    ] as const)
      if (used >= Math.ceil(limits.monthly * share)) {
        await noticeOnce(
          side,
          kind,
          w.monthStart,
          {
            title: `LUME AI has used ${share * 100}% of this month's allowance`,
            body: `${used} of ${limits.monthly} used this month. It starts again ${back}.`,
          },
          limits.monthly,
        ).catch((err: unknown) => req.log.warn({ err }, "couldn't tell admins about LUME AI's use"));
      }
  }
  if (limits.weekly !== null) {
    const used = (await stateNow(req, d, a.tz)).week.used;
    for (const [share, kind] of [
      [0.75, "week_75"],
      [0.9, "week_90"],
    ] as const)
      if (used >= Math.ceil(limits.weekly * share)) {
        await noticeOnce(side, kind, w.weekStart, {
          title: `LUME AI has used ${share * 100}% of this week's reads`,
          body: `${used} of ${limits.weekly} used this week. It starts again Monday.`,
        }).catch((err: unknown) => req.log.warn({ err }, "couldn't tell admins about LUME AI's use"));
      }
  }
  return atMax ? { id: slot.id, output, atMax: true } : { id: slot.id, output };
}
