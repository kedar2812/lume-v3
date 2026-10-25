import {
  aiAllowance,
  aiLimitState,
  aiMonthKey,
  aiPace,
  aiSpend,
  aiWindows,
  backWords,
  can,
  moduleIncluded,
  usesMonthly,
  type AiLimitState,
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
import { adminIds, notify } from "../notifications/notify";
import { integrationsView } from "../sheets/service";

/** How long a read may take (spec 2026-10-18 plan Review Focus 4): the call or note is already saved. */
const TIMEOUT_MS = 20_000;

export type AiUnavailable =
  | { unavailable: "off" | "not_configured" | "failed" }
  | { unavailable: "limit"; by: AiPause["by"]; until: string };
export type AiStatus = { on: boolean } & AiLimitState & {
    /** The month's spend at the owner's prices (LUME_AI_PRICE_IN/OUT); null when none are set. */
    spend: { used: number; cap: number | null; currency: "USD" } | null;
    /** About how many days the month's allowance lasts at this pace. */
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
 * The plan's limits. A licence that signs the month (plan4, Autopilot spec 2026-10-19 §4) counts the month and its
 * top-ups, and the week no longer applies; an older one keeps the week. The hour holds either way.
 */
const limitsOf = (req: FastifyRequest, month: string) => {
  const plan = planOf(req);
  const monthlyPlan = usesMonthly(plan);
  return {
    hourly: plan?.aiReadsHourly ?? null,
    weekly: monthlyPlan ? null : (plan?.aiReadsWeekly ?? null),
    monthly: monthlyPlan ? aiAllowance(plan, month) : null,
  };
};

/** Switched on, set up on this server, and in this LUME's plan. */
export async function available(
  req: FastifyRequest,
  d: AppDeps,
): Promise<{ ok: boolean; why: "off" | "not_configured"; tz: string }> {
  const s = await settingsOf(req);
  if (!d.ai) return { ok: false, why: "not_configured", tz: s.tz };
  return { ok: s.on && moduleIncluded(planOf(req), "ai"), why: "off", tz: s.tz };
}

async function stateNow(
  req: FastifyRequest,
  d: AppDeps,
  tz: string,
): Promise<AiLimitState & { tokens: { inputTokens: number; outputTokens: number } }> {
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
  const state = aiLimitState(
    {
      hourN: Number(u?.hour_n ?? 0),
      hourOldest: u?.hour_oldest ? new Date(u.hour_oldest) : null,
      weekN: Number(u?.week_n ?? 0),
      monthN: Number(u?.month_n ?? 0),
    },
    limitsOf(req, aiMonthKey(now, tz)),
    now,
    tz,
  );
  return {
    ...state,
    tokens: { inputTokens: Number(u?.month_in ?? 0), outputTokens: Number(u?.month_out ?? 0) },
  };
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
  const { tokens, ...state } = await stateNow(req, d, a.tz);
  const w = aiWindows(d.clock(), a.tz);
  return {
    on: a.ok,
    ...state,
    spend: aiSpend(tokens, d.aiPricing ?? null),
    pace: aiPace(state.month, d.clock(), w.monthStart),
    topUp: can(req.actor!, "settings.manage")
      ? { asked: await topUpAsked(d.jobPool ?? d.pool, w.monthStart, state.month.limit) }
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
  const allowance = limitsOf(req, aiMonthKey(now, tz)).monthly;
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
  kind: "week_75" | "week_90" | "week_limit" | "hour_limit" | "month_75" | "month_90" | "month_limit",
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
 * One AI read on a lead the caller may see (spec 2026-10-18 §2.2–2.3). Its slot is reserved — under one lock, in its
 * own short transaction, so the limits hold exactly — then the provider is called outside any transaction, then the
 * slot is finished. A failed or timed-out read isn't counted. Admins hear at 75% and 90% of the week and at a limit.
 */
export async function runRead<T>(
  req: FastifyRequest,
  d: AppDeps,
  o: {
    task: AiTask;
    leadId: string;
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
): Promise<{ id: string; output: T } | AiUnavailable> {
  const a = await available(req, d);
  if (!a.ok || !d.ai) return { unavailable: a.why };
  const ai = d.ai;
  const side = d.jobPool ?? d.pool;
  const now = d.clock();
  const w = aiWindows(now, a.tz);
  const limits = limitsOf(req, aiMonthKey(now, a.tz));
  const slot = (
    await side.query<{
      id: string | null;
      refused: "hour" | "week" | "month" | null;
      hour_oldest: Date | null;
    }>("SELECT * FROM lume_ai_reserve($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)", [
      o.leadId,
      req.actor!.userId,
      o.task,
      o.sourceActivityId ?? null,
      ai.name,
      ai.model,
      now,
      limits.hourly,
      limits.weekly,
      limits.monthly,
      w.hourSince,
      w.weekStart,
      w.monthStart,
    ])
  ).rows[0]!;
  if (!slot.id) {
    const pause: AiPause =
      slot.refused === "month"
        ? { by: "month", until: w.nextMonthStart.toISOString() }
        : slot.refused === "week"
          ? { by: "week", until: w.nextWeekStart.toISOString() }
          : { by: "hour", until: new Date((slot.hour_oldest ?? now).getTime() + 3_600_000).toISOString() };
    const notice =
      pause.by === "month"
        ? {
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
  const finish = (status: "ok" | "failed", result: unknown, input = 0, output = 0) =>
    side.query("SELECT lume_ai_finish($1, $2, $3, $4, $5)", [
      slot.id,
      status,
      result === null ? null : JSON.stringify(result),
      input,
      output,
    ]);
  let answer: Awaited<ReturnType<typeof ai.read<T>>>;
  try {
    answer = await ai.read({
      instructions: o.instructions,
      input: o.input,
      schema: o.schema,
      maxOutputTokens: o.maxOutputTokens,
      signal: AbortSignal.timeout(d.aiTimeoutMs ?? TIMEOUT_MS),
    });
  } catch (err) {
    req.log.warn({ err, provider: ai.name, task: o.task }, "LUME AI couldn't read this");
    await finish("failed", null);
    return { unavailable: "failed" };
  }
  const output = o.clean ? o.clean(answer.output) : answer.output;
  await finish("ok", o.store ? o.store(output) : output, answer.inputTokens, answer.outputTokens);
  if (limits.monthly !== null && limits.monthly !== undefined) {
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
  return { id: slot.id, output };
}
