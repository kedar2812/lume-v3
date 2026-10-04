import { bucketOf, dayOf, quantileFromHist, wallTime } from "@lume/core";
import { analyticsSeed } from "../analytics-seed";
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
  /** 8D: the package a won lead bought (index into the fixture's products). */
  product: number | null;
  /** 8D: a call two days after arrival, at 15:00 business time, and what became of it. */
  meeting: {
    startsAt: Date;
    createdAt: Date;
    status: "completed" | "no_show" | "cancelled" | "scheduled";
  } | null;
  /** 8D: why a lost lead was lost (index into the business's lost reasons). */
  reason: number | null;
  /**
   * 8D: a lost lead reopened two days after it was lost (and then won three days later, at 700). Reopening clears
   * the loss, as LUME's writer does: only the stage history remembers it.
   */
  reopened: Date | null;
  /** 8D: handed to people[to] twenty days after it was won: the win stays with whoever had it then. */
  handoff: { at: Date; to: number } | null;
};

const MEETING_STATUS = ["completed", "no_show", "cancelled", "scheduled"] as const;

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
    const lost = i % 7 === 3 ? new Date(arrival.getTime() + 3 * DAY) : null;
    // Half the lost leads (i % 14 === 3) come back: reopened two days after, won three days after that.
    const reopened = lost && i % 14 === 3 ? new Date(lost.getTime() + 2 * DAY) : null;
    const won =
      i % 7 === 0
        ? new Date(arrival.getTime() + ((i % 10) + 1) * DAY)
        : reopened
          ? new Date(reopened.getTime() + 3 * DAY)
          : null;
    const arrivalDay = new Date(Date.parse(dayOf(arrival, FIXTURE_TZ)) + 2 * DAY);
    const meeting =
      i % 5 === 0
        ? {
            startsAt: wallTime(
              arrivalDay.getUTCFullYear(),
              arrivalDay.getUTCMonth() + 1,
              arrivalDay.getUTCDate(),
              15,
              0,
              FIXTURE_TZ,
            ),
            createdAt: new Date(arrival.getTime() + 60 * MIN),
            status: MEETING_STATUS[(i / 5) % 4]!,
          }
        : null;
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
      value: reopened ? 700 : won ? (i % 2 === 0 ? 1000 + i : null) : null,
      lost,
      reassign,
      task: due ? { due, done } : null,
      product: won ? i % 3 : null,
      meeting,
      reason: lost ? i % 2 : null,
      reopened,
      handoff:
        won && i % 7 === 0 && i % 13 === 0
          ? { at: new Date(won.getTime() + 20 * DAY), to: (i % 6) + 3 }
          : null,
    };
  });
}

export type Fixture = {
  people: SeededUser[];
  sources: string[];
  products: string[];
  reasons: string[];
  leads: { id: string; s: ScriptLead }[];
};

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
  const products: string[] = [];
  for (const name of ["Starter", "Growth", "Premium"])
    products.push(
      (
        await h.ownerPool.query(
          "INSERT INTO products (id, name) VALUES (gen_random_uuid(), $1) RETURNING id",
          [name],
        )
      ).rows[0].id,
    );
  const reasons = (await h.config()).lostReasons.slice(0, 2);
  const stages = await h.queryAll<{ id: string; kind: string; pipeline_id: string }>(
    "SELECT id, kind, pipeline_id FROM stages WHERE pipeline_id = (SELECT id FROM pipelines ORDER BY position LIMIT 1) ORDER BY position",
  );
  const st = (kind: string) => stages.find((x) => x.kind === kind)!.id;
  const leads: { id: string; s: ScriptLead }[] = [];
  for (const s of script()) {
    const id = await h.seedLead({
      ownerId: people[s.owner]!.id,
      name: `Fixture Lead ${String(s.i).padStart(3, "0")}`,
    });
    leads.push({ id, s });
  }
  for (const { id, s } of leads) {
    const owner = people[ownerAtScript(s, new Date())]!.id;
    // Each win, loss and reopen as the writer leaves it (leads/write.ts): a move in the stage history, and the lead's
    // dates and stage to match its last move.
    const moves: [string, string, Date][] = [];
    if (s.lost) moves.push([st("open"), st("lost"), s.lost]);
    if (s.reopened) moves.push([st("lost"), st("open"), s.reopened]);
    if (s.won) moves.push([st("open"), st("won"), s.won]);
    for (const [from, to, at] of moves)
      await h.queryAll(
        "INSERT INTO lead_stage_history (lead_id, from_stage_id, to_stage_id, pipeline_id, changed_at) VALUES ($1, $2, $3, $4, $5)",
        [id, from, to, stages[0]!.pipeline_id, at],
      );
    const stillLost = s.lost && !s.reopened;
    const last = moves.at(-1);
    await h.queryAll(
      `UPDATE leads SET created_at = $2, source_id = $3, won_at = $4, value = $5, lost_at = $6, owner_id = $7,
                        product_id = $8, lost_reason_id = $9, stage_id = coalesce($10::uuid, stage_id),
                        stage_entered_at = coalesce($11::timestamptz, $2::timestamptz) WHERE id = $1`,
      [
        id,
        s.arrival,
        sources[s.source],
        s.won,
        s.value,
        stillLost ? s.lost : null,
        owner,
        s.product === null ? null : products[s.product],
        stillLost && s.reason !== null ? reasons[s.reason] : null,
        last?.[1] ?? null,
        last?.[2] ?? null,
      ],
    );
    if (s.reopened)
      await h.queryAll(
        "INSERT INTO activities (id, lead_id, type, occurred_at) VALUES (gen_random_uuid(), $1, 'reopened', $2)",
        [id, s.reopened],
      );
    if (s.meeting) {
      const at = s.reassign && s.reassign.at <= s.meeting.startsAt ? s.reassign.to : s.owner;
      await analyticsSeed(h).meeting({
        lead: id,
        owner: people[at]!.id,
        startsAt: s.meeting.startsAt,
        status: s.meeting.status,
        createdAt: s.meeting.createdAt,
      });
    }
    if (s.reassign)
      await h.queryAll(
        "INSERT INTO lead_assignment_history (lead_id, from_user_id, to_user_id, changed_at) VALUES ($1, $2, $3, $4)",
        [id, people[s.owner]!.id, people[s.reassign.to]!.id, s.reassign.at],
      );
    if (s.handoff)
      await h.queryAll(
        "INSERT INTO lead_assignment_history (lead_id, from_user_id, to_user_id, changed_at) VALUES ($1, $2, $3, $4)",
        [
          id,
          people[ownerAtScript(s, new Date(s.handoff.at.getTime() - 1))]!.id,
          people[s.handoff.to % 6]!.id,
          s.handoff.at,
        ],
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
  return { people, sources, products, reasons, leads };
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
  const ownerAt = ownerAtScript;
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
    // Leads still lost (a reopen clears the loss).
    lost: all.filter((s) => s.lost && !s.reopened && inDays(s.lost) && mine(ownerAt(s, s.lost))).length,
    ontime: ratio(onTime.length, done.length),
  };
}

/** The owner of a scripted lead at an instant: after a hand-off once it has happened. */
function ownerAtScript(s: ScriptLead, t: Date): number {
  if (s.handoff && s.handoff.at <= t) return s.handoff.to % 6;
  return s.reassign && s.reassign.at <= t ? s.reassign.to : s.owner;
}

/**
 * 8D-1 Task 13: the new numbers, from the script alone, for business days [first, last] and everyone (`person`
 * null) or one person. Each follows the spec's definitions as the reference above does.
 */
export function reference8d(first: string, last: string, person: number | null) {
  const inDays = (t: Date) => {
    const d = dayOf(t, FIXTURE_TZ);
    return d >= first && d <= last;
  };
  const mine = (p: number) => person === null || p === person;
  const all = script();
  // Revenue won by package: wins in the range, credited to the owner when won.
  const wins = all.filter((s) => s.won && inDays(s.won) && mine(ownerAtScript(s, s.won)));
  const byProduct = new Map<number | null, { deals: number; value: number }>();
  for (const s of wins) {
    const x = byProduct.get(s.product) ?? { deals: 0, value: 0 };
    x.deals += 1;
    x.value += s.value ?? 0;
    byProduct.set(s.product, x);
  }
  // Meetings: booked by when the booking was made (not rescheduled); the rest by when the call was due.
  const meetings = all
    .filter((s) => s.meeting)
    .map((s) => ({ s, m: s.meeting!, owner: ownerAtScript(s, s.meeting!.startsAt) }));
  const starting = meetings.filter((x) => inDays(x.m.startsAt) && mine(x.owner));
  const count = (st: string) => starting.filter((x) => x.m.status === st).length;
  const kpis = {
    booked: meetings.filter((x) => inDays(x.m.createdAt) && mine(x.owner)).length,
    held: count("completed"),
    noShow: count("no_show"),
    cancelled: count("cancelled"),
  };
  // Won back: every lead lost in the range (reopened since or not), reopened after it was lost, then won in the range.
  const lostIn = all.filter((s) => s.lost && inDays(s.lost) && mine(ownerAtScript(s, s.lost)));
  const reopened = lostIn.filter((s) => s.reopened && s.reopened > s.lost!);
  const wonBack = reopened.filter((s) => s.won && inDays(s.won));
  // Lost by reason and source: leads still lost.
  const matrix = new Map<string, number>();
  for (const s of lostIn.filter((x) => !x.reopened))
    matrix.set(`${s.reason}:${s.source}`, (matrix.get(`${s.reason}:${s.source}`) ?? 0) + 1);
  // New leads by source (the funnel's split).
  const arrivedBySource = new Map<number, number>();
  for (const s of all.filter((x) => inDays(x.arrival) && mine(x.owner)))
    arrivedBySource.set(s.source, (arrivedBySource.get(s.source) ?? 0) + 1);
  return {
    byProduct,
    kpis,
    wonBackFlow: {
      lost: lostIn.length,
      reopened: reopened.length,
      won: wonBack.length,
      value: wonBack.reduce((a, s) => a + (s.value ?? 0), 0),
    },
    matrix,
    arrivedBySource,
  };
}
