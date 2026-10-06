import { randomUUID } from "node:crypto";
import type pg from "pg";
import { dayBounds, dayOf, NO_TOUCH_RULE_ID } from "@lume/core";
import { rollupDays } from "../modules/analytics/rollup";
import { MEETING_TITLES, PRODUCTS } from "./names";

/**
 * Today's work for chosen people on the demo business (website spec §6): a working day around `now` (at 10:45, a
 * morning) — some follow-ups overdue (one brought back by the no-touch rule), some due soon, some later, a few done,
 * a call held and one to come, WhatsApps sent and answered, a deal won before lunch, and (for someone who sees
 * everyone) new leads waiting for someone. Fictional and generic: for the website's captures now, and
 * demo.lumecrm.in later. Plants once per business day.
 */
export class LiveDayRefused extends Error {
  constructor() {
    super("Today's work is already planted.");
    this.name = "LiveDayRefused";
  }
}

/** A user id that is no one, for the writes' row-level scope (as the demo seed uses). */
const SYSTEM = "0190e0c0-0000-7000-8000-000000000000";
const NO_TOUCH_TITLE = "No contact for 3 days";
export type LiveDayPerson = { userId: string; scope: "all" | "own" };

export async function seedLiveDay(
  pool: pg.Pool,
  o: { now: Date; people: LiveDayPerson[] },
): Promise<{ planted: number }> {
  const c = await pool.connect();
  let planted = 0;
  let tz = "UTC";
  let today = "";
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', 'all', true)", [
      SYSTEM,
    ]);
    tz = (await c.query<{ tz: string }>("SELECT timezone AS tz FROM settings WHERE id = 1")).rows[0]!.tz;
    today = dayOf(o.now, tz);
    const { start, end } = dayBounds(today, tz);
    // Everything is placed around `now` (minutes before or after), kept inside the business day: at 10:45 that is
    // 9:30 and 10:15 overdue, 11:00–12:30 due soon, 14:00–18:00 later, three done since 9.
    const at = (minutes: number) =>
      new Date(
        Math.min(
          end.getTime() - 60_000,
          Math.max(start.getTime() + 60_000, o.now.getTime() + minutes * 60_000),
        ),
      );
    // Once a day: the day's no-touch follow-up is the mark that it's planted.
    const already = await c.query(
      "SELECT 1 FROM tasks WHERE auto_rule_id = $1 AND title = $2 AND due_at >= $3 AND due_at < $4 LIMIT 1",
      [NO_TOUCH_RULE_ID, NO_TOUCH_TITLE, start, end],
    );
    if (already.rowCount) throw new LiveDayRefused();

    const stages = (
      await c.query<{ id: string; kind: string; pipeline_id: string }>(
        `SELECT s.id, s.kind, s.pipeline_id FROM stages s JOIN pipelines p ON p.id = s.pipeline_id
          WHERE p.archived_at IS NULL AND s.archived_at IS NULL
          ORDER BY p.is_default DESC, p.position, s.position`,
      )
    ).rows;
    const pipeline = stages[0]!.pipeline_id;
    const inPipeline = stages.filter((s) => s.pipeline_id === pipeline);
    const wonStage = inPipeline.find((s) => s.kind === "won")!.id;
    const openIds = inPipeline.filter((s) => s.kind === "open").map((s) => s.id);
    const used: string[] = [];

    for (const p of o.people) {
      // Twelve open leads for the day: the person's own first, else others' given to them now.
      const leads = (
        await c.query<{ id: string }>(
          `SELECT id FROM leads
            WHERE deleted_at IS NULL AND stage_id = ANY($1::uuid[]) AND owner_id IS NOT NULL
              AND NOT (id = ANY($3::uuid[]))
            ORDER BY (owner_id = $2) DESC, created_at DESC LIMIT 12`,
          [openIds, p.userId, used],
        )
      ).rows.map((l) => l.id);
      if (leads.length < 12) throw new Error("The demo business has too few open leads for a working day.");
      used.push(...leads);
      await c.query("UPDATE leads SET owner_id = $1 WHERE id = ANY($2::uuid[])", [p.userId, leads]);
      const task = async (
        lead: string,
        title: string,
        due: Date,
        done: Date | null,
        rule: string | null = null,
      ) => {
        const id = randomUUID();
        await c.query(
          `INSERT INTO tasks (id, lead_id, assignee_id, title, due_at, status, series_id, done_at, done_by, auto_rule_id,
                              created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $1, $7::timestamptz, $8, $9, $5::timestamptz - interval '1 day',
                   coalesce($7::timestamptz, $5::timestamptz - interval '1 day'))`,
          [id, lead, p.userId, title, due, done ? "done" : "open", done, done ? p.userId : null, rule],
        );
        planted++;
      };
      // Overdue (one brought back by the no-touch rule), due within two hours, later today, done this morning.
      await task(leads[0]!, NO_TOUCH_TITLE, at(-75), null, NO_TOUCH_RULE_ID);
      await task(leads[1]!, "Send the brochure", at(-30), null);
      await task(leads[2]!, "Follow up", at(15), null);
      await task(leads[3]!, "Confirm the date", at(45), null);
      await task(leads[4]!, "Follow up", at(105), null);
      await task(leads[5]!, "Share the quote", at(195), null);
      await task(leads[6]!, "Follow up", at(285), null);
      await task(leads[7]!, "Check in after the call", at(345), null);
      await task(leads[8]!, "Follow up", at(435), null);
      await task(leads[9]!, "Follow up", at(-105), at(-95));
      await task(leads[10]!, "Send the brochure", at(-75), at(-65));
      await task(leads[11]!, "Follow up", at(-45), at(-25));
      // WhatsApps this morning, two of them answered.
      for (const [i, when] of [at(-93), at(-64), at(-40), at(-23)].entries())
        await c.query(
          "INSERT INTO activities (id, lead_id, type, occurred_at, user_id) VALUES ($1, $2, 'whatsapp_opened', $3, $4)",
          [randomUUID(), leads[9 + (i % 3)]!, when, p.userId],
        );
      for (const when of [at(-47), at(-14)])
        await c.query(
          "INSERT INTO activities (id, lead_id, type, occurred_at, user_id) VALUES ($1, $2, 'reply_logged', $3, NULL)",
          [randomUUID(), leads[9]!, when],
        );
      // A deal won this morning.
      const won = leads[11]!;
      await c.query(
        `INSERT INTO lead_stage_history (lead_id, from_stage_id, to_stage_id, pipeline_id, changed_at)
         SELECT id, stage_id, $2, pipeline_id, $3 FROM leads WHERE id = $1`,
        [won, wonStage, at(-20)],
      );
      await c.query(
        `UPDATE leads SET stage_id = $2, stage_entered_at = $3, won_at = $3, value = $4, updated_at = $3,
                          last_activity_at = $3 WHERE id = $1`,
        [won, wonStage, at(-20), PRODUCTS[1]!.value],
      );
      // Two calls on their calendar: one held at 10, one at 4 (written as them: meetings' row-level security).
      await c.query("SELECT set_config('lume.user_id', $1, true)", [p.userId]);
      for (const [i, [when, status]] of (
        [
          [at(-45), "completed"],
          [at(315), "scheduled"],
        ] as const
      ).entries()) {
        const id = randomUUID();
        await c.query(
          `INSERT INTO meetings (id, lead_id, owner_id, source, external_id, matched_by, title, starts_at, ends_at, status, created_at)
           VALUES ($1::uuid, $2, $3, 'calendly', $1::text, 'calendly', $4, $5::timestamptz, $5::timestamptz + interval '30 minutes', $6,
                   $5::timestamptz - interval '2 days')`,
          [id, leads[2 + i]!, p.userId, MEETING_TITLES[i]!, when, status],
        );
      }
      await c.query("SELECT set_config('lume.user_id', $1, true)", [SYSTEM]);
      // For someone who sees everyone: three new leads nobody has yet.
      if (p.scope === "all") {
        const src =
          (await c.query<{ id: string }>("SELECT id FROM lead_sources WHERE name = 'Instagram ads' LIMIT 1"))
            .rows[0]?.id ?? null;
        for (const [i, when] of [at(-115), at(-50), at(-15)].entries())
          await c.query(
            `INSERT INTO leads (id, pipeline_id, stage_id, stage_entered_at, owner_id, name, email, phone_e164,
                                phone_status, source_id, created_at, updated_at, last_activity_at)
             VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, 'valid', $8, $4, $4, $4)`,
            [
              randomUUID(),
              pipeline,
              openIds[0],
              when,
              ["Ira Menon", "Kunal Bhat", "Tara Dsouza"][i],
              `new.${i}.${today}@example.com`,
              // The range set aside for drama, as the demo seed uses.
              `+447700900${960 + i}`,
              src,
            ],
          );
      }
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  await rollupDays(pool, [today], tz);
  return { planted };
}
