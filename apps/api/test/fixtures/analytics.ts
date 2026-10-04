import { bucketOf, dayOf, quantileFromHist, wallTime } from "@lume/core";
import type { Harness, SeededUser } from "../harness";

/**
 * A small business whose every event is known (8A, spec §7): six people, four sources, 400 leads over eight weeks in
 * Asia/Kolkata, each with a scripted arrival, contact, reply, win or loss, reassignment and follow-up, at fixed
 * instants. The answers aren't read back from LUME: `reference` computes them from the same script with plain
 * arithmetic, by the spec's definitions, so the engine (SQL rollups) and the reference (this file) must agree.
 */
export const FIXTURE_TZ = "Asia/Kolkata";
export const FIRST_DAY = { y: 2026, m: 5, d: 4 }; // Monday, May 4
export const LEADS = 400;
const MIN = 60_000;
const DAY = 86_400_000;

export type ScriptLead = {
  i: number;
  owner: number; // index into people, at arrival
  source: number;
  arrival: Date;
  contact: Date | null;
  reply: Date | null;
  won: Date | null;
  value: number | null;
  lost: Date | null;
  /** Handed to people[next] at this instant. */
  reassign: { at: Date; to: number } | null;
  task: { due: Date; done: Date | null } | null;
};

export function script(): ScriptLead[] {
  return Array.from({ length: LEADS }, (_, i) => {
    const day = i % 56;
    const hour = (i * 7) % 24;
    const minute = (i * 13) % 60;
    const date = new Date(Date.UTC(FIRST_DAY.y, FIRST_DAY.m - 1, FIRST_DAY.d + day));
    const arrival = wallTime(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      hour,
      minute,
      FIXTURE_TZ,
    );
    const contact = i % 3 !== 0 ? new Date(arrival.getTime() + ((i * 17) % 600) * MIN) : null;
    const reply = contact && (i % 5 === 1 || i % 5 === 2) ? new Date(contact.getTime() + 120 * MIN) : null;
    const won = i % 7 === 0 ? new Date(arrival.getTime() + ((i % 10) + 1) * DAY) : null;
    const lost = i % 7 === 3 ? new Date(arrival.getTime() + 3 * DAY) : null;
    const reassign = i % 11 === 5 ? { at: new Date(arrival.getTime() + DAY), to: (i + 1) % 6 } : null;
    const due = i % 4 === 0 ? new Date(arrival.getTime() + DAY) : null;
    // Early, exactly on time, and 30 minutes late, in turn; every eighth one still open.
    const done = due && i % 8 !== 4 ? new Date(due.getTime() + ((i % 3) - 1) * 30 * MIN) : null;
    return {
      i,
      owner: i % 6,
      source: i % 4,
      arrival,
      contact,
      reply,
      won,
      value: won ? (i % 2 === 0 ? 1000 + i : null) : null,
      lost,
      reassign,
      task: due ? { due, done } : null,
    };
  });
}

export type Fixture = { people: SeededUser[]; sources: string[]; leads: { id: string; s: ScriptLead }[] };

/** Writes the script into a harness, as the people and integrations would have. */
export async function seedFixture(h: Harness): Promise<Fixture> {
  await h.ownerPool.query("UPDATE settings SET timezone = $1 WHERE id = 1", [FIXTURE_TZ]);
  const people: SeededUser[] = [];
  for (let p = 0; p < 6; p++)
    people.push(
      await h.seedUser({
        grants: [
          { key: "analytics.view", scope: "own" },
          { key: "leads.view", scope: "own" },
        ],
      }),
    );
  const sources: string[] = [];
  for (const name of ["Spring fair", "Website form", "Referral", "Partner list"])
    sources.push(
      (
        await h.ownerPool.query(
          "INSERT INTO lead_sources (id, type, name) VALUES (gen_random_uuid(), 'manual', $1) RETURNING id",
          [name],
        )
      ).rows[0].id,
    );
  const leads: { id: string; s: ScriptLead }[] = [];
  for (const s of script()) {
    const id = await h.seedLead({
      ownerId: people[s.owner]!.id,
      name: `Fixture Lead ${String(s.i).padStart(3, "0")}`,
    });
    leads.push({ id, s });
  }
  for (const { id, s } of leads) {
    const owner =
      s.reassign && s.reassign.at.getTime() <= Date.now() ? people[s.reassign.to]!.id : people[s.owner]!.id;
    await h.queryAll(
      `UPDATE leads SET created_at = $2, source_id = $3, won_at = $4, value = $5, lost_at = $6, owner_id = $7 WHERE id = $1`,
      [id, s.arrival, sources[s.source], s.won, s.value, s.lost, owner],
    );
    if (s.reassign)
      await h.queryAll(
        "INSERT INTO lead_assignment_history (lead_id, from_user_id, to_user_id, changed_at) VALUES ($1, $2, $3, $4)",
        [id, people[s.owner]!.id, people[s.reassign.to]!.id, s.reassign.at],
      );
    if (s.contact)
      await h.queryAll(
        "INSERT INTO activities (id, lead_id, type, occurred_at) VALUES (gen_random_uuid(), $1, 'whatsapp_opened', $2)",
        [id, s.contact],
      );
    if (s.reply)
      await h.queryAll(
        "INSERT INTO activities (id, lead_id, type, occurred_at) VALUES (gen_random_uuid(), $1, 'reply_logged', $2)",
        [id, s.reply],
      );
    if (s.task) {
      const assignee =
        s.reassign && s.reassign.at <= s.task.due ? people[s.reassign.to]!.id : people[s.owner]!.id;
      await h.queryAll(
        `INSERT INTO tasks (id, lead_id, assignee_id, title, due_at, status, series_id, done_at)
         VALUES (gen_random_uuid(), $1, $2, 'Call back', $3, $4, gen_random_uuid(), $5)`,
        [id, assignee, s.task.due, s.task.done ? "done" : "open", s.task.done],
      );
    }
  }
  return { people, sources, leads };
}

export type Expected = Record<string, number | null>;

/**
 * The answers, from the script alone, for business days [first, last] (inclusive), for everyone (`person` null) or
 * one person's own numbers.
 */
export function reference(first: string, last: string, person: number | null): Expected {
  const inDays = (t: Date) => {
    const d = dayOf(t, FIXTURE_TZ);
    return d >= first && d <= last;
  };
  const ownerAt = (s: ScriptLead, t: Date) => (s.reassign && s.reassign.at <= t ? s.reassign.to : s.owner);
  const mine = (p: number) => person === null || p === person;
  const all = script();
  const cohort = all.filter((s) => inDays(s.arrival) && mine(s.owner));
  const contacted = cohort.filter((s) => s.contact);
  const hist = Array(12).fill(0) as number[];
  for (const s of contacted) {
    const b = bucketOf((s.contact!.getTime() - s.arrival.getTime()) / MIN);
    hist[b] = (hist[b] ?? 0) + 1;
  }
  const won = all.filter((s) => s.won && inDays(s.won) && mine(ownerAt(s, s.won)));
  const valued = won.filter((s) => s.value !== null);
  const revenue = valued.reduce((a, s) => a + s.value!, 0);
  const tasks = all.filter((s) => s.task && inDays(s.task.due) && mine(ownerAt(s, s.task.due)));
  const done = tasks.filter((s) => s.task!.done);
  const onTime = done.filter((s) => s.task!.done!.getTime() <= s.task!.due.getTime() + 5 * MIN);
  const ratio = (a: number, b: number) => (b ? a / b : null);
  return {
    new_leads: cohort.length,
    contacted: ratio(contacted.length, cohort.length),
    reply_rate: ratio(contacted.filter((s) => s.reply).length, contacted.length),
    speed_to_lead: quantileFromHist(hist, 0.5),
    won: won.length,
    win_rate: ratio(cohort.filter((s) => s.won).length, cohort.length),
    revenue_won: revenue,
    avg_deal: valued.length ? revenue / valued.length : null,
    lost: all.filter((s) => s.lost && inDays(s.lost) && mine(ownerAt(s, s.lost))).length,
    ontime: ratio(onTime.length, done.length),
  };
}
