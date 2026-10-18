import type { FastifyRequest } from "fastify";
import type pg from "pg";
import { moduleIncluded, PLAN_MODULES, type PlanClaim, type PlanModule } from "@lume/core";
import { sql } from "drizzle-orm";
import { conflict } from "../http/errors";
import { notify } from "../modules/notifications/notify";

/**
 * Control each client (spec 2026-10-17 control §2): what this LUME's plan allows — its places and modules — kept from
 * the licence server's signed answer. No plan in the answer: no limits. Nothing is ever removed.
 */

export const MODULE_NAMES: Record<PlanModule, string> = {
  googleSheets: "Google Sheets",
  webhooks: "Webhooks",
  googleCalendar: "Google Calendar",
  calendly: "Calendly",
  ai: "LUME AI",
  whatsapp: "WhatsApp",
};
/** How each module is named in the audit log, as the module switches already write it. */
const AUDIT_NAMES: Record<PlanModule, string> = {
  googleSheets: "google_sheets",
  webhooks: "webhooks",
  googleCalendar: "google_calendar",
  calendly: "calendly",
  ai: "ai",
  whatsapp: "whatsapp",
};

/** The plan as this person may see it: places, taken and modules for people who manage settings. */
export async function planForPerson(req: FastifyRequest, admin: boolean) {
  const plan = req.server.licence.view().plan;
  if (!plan || !admin) return null;
  const rows = await req.db.execute<{ n: number }>(
    sql`SELECT ((SELECT count(*) FROM users WHERE status IN ('active', 'suspended'))
              + (SELECT count(*) FROM user_invites WHERE accepted_at IS NULL AND revoked_at IS NULL
                  AND expires_at > ${req.server.licence.clock()}))::int AS n`,
  );
  return { places: plan.places, taken: Number(rows.rows[0]?.n ?? 0), modules: plan.modules };
}

/**
 * Refuses a new person (an invite, a restore) when every place is taken (control §2.1). Counted under a lock in the
 * request's own transaction, so two invites at the last place can't both get it. Re-inviting an address doesn't count
 * its own open invite twice.
 */
export async function assertPlace(req: FastifyRequest, o: { inviteEmail?: string } = {}): Promise<void> {
  const plan = req.server.licence.view().plan;
  if (!plan || plan.places === null) return;
  await req.db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('lume.places'))`);
  const rows = await req.db.execute<{ n: number }>(
    sql`SELECT ((SELECT count(*) FROM users WHERE status IN ('active', 'suspended'))
              + (SELECT count(*) FROM user_invites
                  WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ${req.server.licence.clock()}
                    AND lower(email) <> lower(${o.inviteEmail ?? ""})))::int AS n`,
  );
  const n = Number(rows.rows[0]?.n ?? 0);
  if (n >= plan.places)
    throw conflict(
      "PLAN_PLACES",
      `Every place on this LUME's plan is taken (${plan.places} of ${plan.places}). Pause someone, or ask LUME's team about more places.`,
    );
}

/** Refuses switching on a module the plan leaves out (control §2.2). */
export function assertModule(req: FastifyRequest, key: PlanModule): void {
  const plan = req.server.licence.view().plan;
  if (!moduleIncluded(plan, key))
    throw conflict(
      "PLAN_MODULE",
      `${MODULE_NAMES[key]} isn't in this LUME's plan. Ask LUME's team to add it.`,
    );
}

/** Which of the plan's modules are switched on now (for the check-in's health): keys only. */
export async function modulesOn(q: Pick<pg.Pool, "query">): Promise<PlanModule[]> {
  const s = (
    await q.query<{ i: Record<string, { enabled?: boolean }> }>(
      "SELECT integrations AS i FROM settings WHERE id = 1",
    )
  ).rows[0]?.i;
  const calendly = (
    await q.query("SELECT 1 FROM lead_sources WHERE type = 'calendly' AND status <> 'archived' LIMIT 1")
  ).rowCount;
  // WhatsApp (spec 2026-10-18 part D) has no switch yet: never on.
  return PLAN_MODULES.filter((k) =>
    k === "calendly" ? !!calendly : k === "whatsapp" ? false : !!s?.[k]?.enabled,
  );
}

/**
 * A plan has arrived (control §2.2): each module it newly leaves out that is on is switched off — once, however many
 * check-ins carry the same plan — with an audit row, and admins are told once. Settings and connections are kept;
 * Calendly's connection stays and its bookings are ignored while it's left out.
 */
export async function applyPlan(
  pool: pg.Pool,
  plan: PlanClaim | null,
  log: (o: object, msg: string) => void = () => undefined,
): Promise<void> {
  const excluded = plan ? PLAN_MODULES.filter((k) => plan.modules[k] === false) : [];
  const told: PlanModule[] = [];
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtext('lume.plan'))");
    const before =
      (
        await c.query<{ p: { excluded?: string[] } | null }>(
          "SELECT plan_applied AS p FROM licence_state WHERE id = 1",
        )
      ).rows[0]?.p?.excluded ?? [];
    const on = new Set(await modulesOn(c));
    for (const k of excluded.filter((x) => !before.includes(x))) {
      if (!on.has(k)) continue;
      if (k !== "calendly")
        await c.query(
          "UPDATE settings SET integrations = jsonb_set(integrations, ARRAY[$1::text], $2::jsonb) WHERE id = 1",
          [k, JSON.stringify({ enabled: false })],
        );
      await c.query(
        "INSERT INTO audit_log (actor_user_id, action, entity_type, diff) VALUES (NULL, 'integration.disabled', 'integration', $1)",
        [JSON.stringify({ module: AUDIT_NAMES[k], by: "plan" })],
      );
      told.push(k);
    }
    await c.query("UPDATE licence_state SET plan_applied = $1 WHERE id = 1", [JSON.stringify({ excluded })]);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    log({ err: e }, "couldn't apply this LUME's plan");
    return;
  } finally {
    c.release();
  }
  if (!told.length) return;
  const { rows: admins } = await pool.query<{ id: string }>(
    `SELECT u.id FROM users u WHERE u.status = 'active' AND (u.is_owner OR EXISTS (
       SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id AND r.deleted_at IS NULL
         JOIN role_permissions rp ON rp.role_id = r.id
        WHERE ur.user_id = u.id AND rp.permission_key = 'settings.manage'))`,
  );
  for (const k of told)
    for (const a of admins)
      await notify(pool, a.id, {
        kind: "system_alert",
        title: `${MODULE_NAMES[k]} was switched off`,
        body: "It isn't in this LUME's plan any more. Its settings are kept.",
      }).catch((err: unknown) => log({ err }, "couldn't tell an admin about the plan"));
}
