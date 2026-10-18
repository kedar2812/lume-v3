import {
  aiLimitState,
  aiWindows,
  backWords,
  moduleIncluded,
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
export type AiStatus = { on: boolean } & AiLimitState;

async function settingsOf(req: FastifyRequest): Promise<{ on: boolean; tz: string }> {
  const [s] = await req.db
    .select({ i: schema.settings.integrations, tz: schema.settings.timezone })
    .from(schema.settings)
    .where(eq(schema.settings.id, 1));
  return { on: !!s?.i.ai?.enabled, tz: s?.tz ?? "UTC" };
}

const planOf = (req: FastifyRequest) => req.server.licence.view().plan;
const limitsOf = (req: FastifyRequest) => ({
  hourly: planOf(req)?.aiReadsHourly ?? null,
  weekly: planOf(req)?.aiReadsWeekly ?? null,
});

/** Switched on, set up on this server, and in this LUME's plan. */
async function available(
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
  const r = await req.db.execute<{ hour_n: number; hour_oldest: Date | string | null; week_n: number }>(
    sql`SELECT * FROM lume_ai_usage(${w.hourSince.toISOString()}::timestamptz, ${w.weekStart.toISOString()}::timestamptz)`,
  );
  const u = r.rows[0];
  return aiLimitState(
    {
      hourN: Number(u?.hour_n ?? 0),
      hourOldest: u?.hour_oldest ? new Date(u.hour_oldest) : null,
      weekN: Number(u?.week_n ?? 0),
    },
    limitsOf(req),
    now,
    tz,
  );
}

/** `GET /api/v1/ai`: whether LUME AI is on for this person, and this hour's and this week's use. */
export async function aiStatus(req: FastifyRequest, d: AppDeps): Promise<AiStatus> {
  const a = await available(req, d);
  return { on: a.ok, ...(await stateNow(req, d, a.tz)) };
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

/** One notice per window to every admin; false when this one had already gone. */
async function noticeOnce(
  pool: pg.Pool,
  kind: "week_75" | "week_90" | "week_limit" | "hour_limit",
  windowStart: Date,
  n: { title: string; body: string },
): Promise<void> {
  const first = await pool.query(
    "INSERT INTO ai_limit_notices (kind, window_start) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [kind, windowStart],
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
  const limits = limitsOf(req);
  const slot = (
    await side.query<{ id: string | null; refused: "hour" | "week" | null; hour_oldest: Date | null }>(
      "SELECT * FROM lume_ai_reserve($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
      [
        o.leadId,
        req.actor!.userId,
        o.task,
        o.sourceActivityId ?? null,
        ai.name,
        ai.model,
        now,
        limits.hourly,
        limits.weekly,
        w.hourSince,
        w.weekStart,
      ],
    )
  ).rows[0]!;
  if (!slot.id) {
    const pause: AiPause =
      slot.refused === "week"
        ? { by: "week", until: w.nextWeekStart.toISOString() }
        : { by: "hour", until: new Date((slot.hour_oldest ?? now).getTime() + 3_600_000).toISOString() };
    await noticeOnce(
      side,
      pause.by === "week" ? "week_limit" : "hour_limit",
      pause.by === "week" ? w.weekStart : new Date(pause.until),
      {
        title: `LUME AI has reached this ${pause.by}'s limit`,
        body: `It's back ${backWords(pause, now, a.tz)}.`,
      },
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
