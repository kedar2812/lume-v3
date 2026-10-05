import { randomUUID } from "node:crypto";
import type pg from "pg";
import { dayOf, wallTime } from "@lume/core";
import { rollupDays } from "../modules/analytics/rollup";
import { BUDGET, FIRST, LAST, MEETING_TITLES, PEOPLE, PRODUCTS, REASONS, SOURCES, TAGS } from "./names";

/**
 * A made-up business with six months of natural data, ending at `now` (8D spec §3): for the Analytics review
 * screenshots now, and the demo later. Deterministic for a seed and a day. It goes only into a LUME with no leads,
 * unless demo mode is on: a client's data is never mixed with it.
 *
 * The patterns LUME noticed should find are planted on purpose:
 * - leads contacted within an hour are won about twice as often (speed pays);
 * - referrals win far above their share; webinars, with a spend set, far below;
 * - a third of leads arrive in the evening, and most of those wait until the next morning;
 * - Monday morning calls are missed three times as often; Friday afternoons are held best;
 * - one person (Leo) contacts slowest, and his Monday follow-ups slip;
 * - "No reply" is the commonest reason for losing, and rising in the last month;
 * - a dozen lost leads come back and are won.
 */
export class DemoSeedRefused extends Error {
  constructor() {
    super("This LUME already has leads. The demo business only goes into an empty one.");
    this.name = "DemoSeedRefused";
  }
}

export type DemoOptions = {
  now: Date;
  /** The random seed: the same seed and day give the same business. */
  seed?: number;
  /** How many months back it starts. */
  months?: number;
  /** Demo mode: allowed into a LUME that has (demo) leads already. */
  demoMode?: boolean;
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** A user id that is no one, for the writes' row-level scope (as the migrations' backfills use). */
const SYSTEM = "0190e0c0-0000-7000-8000-000000000000";

/** A small, fast, seeded generator (mulberry32): the same seed, the same business. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    chance: (p: number) => next() < p,
    between: (lo: number, hi: number) => lo + (hi - lo) * next(),
    int: (lo: number, hi: number) => Math.floor(lo + (hi - lo + 1) * next()),
    pick<T>(xs: readonly T[]): T {
      return xs[Math.floor(next() * xs.length)]!;
    },
    weighted<T extends { weight: number }>(xs: readonly T[]): number {
      let r = next() * xs.reduce((s, x) => s + x.weight, 0);
      for (let i = 0; i < xs.length; i++) if ((r -= xs[i]!.weight) <= 0) return i;
      return xs.length - 1;
    },
    /** Log-normal around a median (minutes), for how long things take. */
    lognormal(median: number, spread = 0.9) {
      const u = Math.max(1e-9, next());
      const v = next();
      return median * Math.exp(spread * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
    },
  };
}

type Lead = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  phoneStatus: "valid" | "needs_country";
  phoneRaw: string | null;
  owner: number | null;
  source: number;
  createdAt: Date;
  stage: number; // index into the open stages, or -1 won, -2 lost
  stageAt: Date;
  wonAt: Date | null;
  value: number | null;
  product: number | null;
  lostAt: Date | null;
  reason: number | null;
  custom: Record<string, string>;
  tag: number | null;
};

/**
 * Rows into a table in batches, so thousands of leads are a few statements. Each caller writes its statement out in
 * full, as `INSERT … SELECT * FROM unnest($1::type[], …)`; this turns the rows into one array per column.
 */
async function insert(c: pg.PoolClient, statement: string, rows: unknown[][]) {
  for (let i = 0; i < rows.length; i += 1000) {
    const batch = rows.slice(i, i + 1000);
    const columns = batch[0]?.map((_, k) => batch.map((r) => r[k])) ?? [];
    if (columns.length) await c.query(statement, columns);
  }
}

const atLocal = (day: string, hour: number, minute: number, tz: string) => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return wallTime(y, m, d, hour, minute, tz);
};
const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday

export async function seedDemoBusiness(pool: pg.Pool, o: DemoOptions) {
  const r = rng(o.seed ?? 7);
  const months = o.months ?? 6;
  const now = o.now;
  const c = await pool.connect();
  let tz = "UTC";
  const days: string[] = [];
  const people: { id: string; name: string; email: string }[] = [];
  let leadCount = 0;
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', 'all', true)", [
      SYSTEM,
    ]);
    const has = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM leads")).rows[0]!.n;
    if (has > 0 && !o.demoMode) throw new DemoSeedRefused();
    tz =
      (await c.query<{ tz: string }>("SELECT timezone AS tz FROM settings WHERE id = 1")).rows[0]?.tz ??
      "UTC";
    await c.query(
      `UPDATE settings SET business_name = 'Brightpath Studio',
         working_hours = '{"days": [1, 2, 3, 4, 5, 6], "start": "10:00", "end": "19:00"}'::jsonb WHERE id = 1`,
    );

    // The people, in two teams; a Sales role if the business has one. No password: they can't sign in.
    const sales = (await c.query<{ id: string }>("SELECT id FROM roles WHERE name = 'Sales' LIMIT 1")).rows[0]
      ?.id;
    const teamIds = new Map<string, string>();
    for (const p of PEOPLE) {
      const id = randomUUID();
      const email = `${p.name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`;
      await c.query(
        "INSERT INTO users (id, email, name, password_hash, status) VALUES ($1, $2, $3, NULL, 'active')",
        [id, email, p.name],
      );
      if (sales) await c.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [id, sales]);
      if (!teamIds.has(p.team)) {
        const t = randomUUID();
        await c.query("INSERT INTO teams (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING", [t, p.team]);
        const existing = await c.query<{ id: string }>(
          "SELECT id FROM teams WHERE name = $1 AND deleted_at IS NULL",
          [p.team],
        );
        teamIds.set(p.team, existing.rows[0]!.id);
      }
      await c.query("INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)", [teamIds.get(p.team), id]);
      people.push({ id, name: p.name, email });
    }
    const leo = PEOPLE.findIndex((p) => p.name.startsWith("Leo"));

    // The catalogue: sources (spend on the paid ones), packages, tags, a budget question, and lost reasons.
    const sources = SOURCES.map(() => randomUUID());
    await insert(
      c,
      "INSERT INTO lead_sources (id, type, name, monthly_spend) SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::numeric[])",
      SOURCES.map((s, i) => [sources[i], "manual", s.name, s.spend]),
    );
    const products = PRODUCTS.map(() => randomUUID());
    await insert(
      c,
      "INSERT INTO products (id, name, default_value) SELECT * FROM unnest($1::uuid[], $2::text[], $3::numeric[])",
      PRODUCTS.map((p, i) => [products[i], p.name, p.value]),
    );
    const tags = TAGS.map(() => randomUUID());
    await insert(
      c,
      "INSERT INTO tags (id, label) SELECT * FROM unnest($1::uuid[], $2::text[])",
      TAGS.map((t, i) => [tags[i], t]),
    );
    // A choice field stores {id, label} options and each lead the option's id (core/leads/custom-fields.ts), so the
    // demo answers are read by every screen exactly as a real business's are.
    const budgetField = (
      await c.query<{ options: unknown }>("SELECT options FROM field_definitions WHERE key = 'budget'")
    ).rows[0];
    if (!budgetField)
      await c.query(
        "INSERT INTO field_definitions (id, key, label, type, options) VALUES ($1, 'budget', 'Budget', 'select', $2::jsonb)",
        [
          randomUUID(),
          JSON.stringify(BUDGET.map((label) => ({ id: `budget-${label.toLowerCase()}`, label }))),
        ],
      );
    // A budget field already here: its own options, matched by label; an answer it doesn't offer is left out.
    const budgetIds = BUDGET.map((label) => {
      if (!budgetField) return `budget-${label.toLowerCase()}`;
      const opts = Array.isArray(budgetField.options)
        ? (budgetField.options as { id?: string; label?: string }[])
        : [];
      return opts.find((o) => o.label === label)?.id ?? null;
    });
    let reasons = (
      await c.query<{ id: string }>("SELECT id FROM lost_reasons WHERE archived_at IS NULL ORDER BY position")
    ).rows.map((x) => x.id);
    if (!reasons.length) {
      reasons = REASONS.map(() => randomUUID());
      await insert(
        c,
        "INSERT INTO lost_reasons (id, label, position) SELECT * FROM unnest($1::uuid[], $2::text[], $3::int[])",
        REASONS.map((x, i) => [reasons[i], x, i]),
      );
    }

    // The default pipeline, as the business set it up: its stages are never renamed.
    const pipeline = (
      await c.query<{ id: string }>(
        "SELECT id FROM pipelines WHERE archived_at IS NULL ORDER BY is_default DESC, position LIMIT 1",
      )
    ).rows[0]!.id;
    const stages = (
      await c.query<{ id: string; kind: string }>(
        "SELECT id, kind FROM stages WHERE pipeline_id = $1 AND archived_at IS NULL ORDER BY position",
        [pipeline],
      )
    ).rows;
    const open = stages.filter((s) => s.kind === "open").map((s) => s.id);
    const wonStage = stages.find((s) => s.kind === "won")!.id;
    const lostStage = stages.find((s) => s.kind === "lost")!.id;
    const openAt = (i: number) => open[Math.min(i, open.length - 1)]!;
    // A chance of winning on each open stage that has none, rising through the pipeline, so the forecast means
    // something. A stage the business already set keeps its own.
    for (const [i, id] of open.entries())
      await c.query("UPDATE stages SET win_probability = $2 WHERE id = $1 AND win_probability IS NULL", [
        id,
        Math.round(10 + (60 * i) / Math.max(1, open.length - 1)),
      ]);

    // Arrivals: six months, growing 6% a month, Sundays at 40%, the third month slow (70%).
    const today = dayOf(now, tz);
    const first = addDays(today, -Math.round(months * 30.44));
    for (let d = first; d <= today; d = addDays(d, 1)) days.push(d);
    const leads: Lead[] = [];
    const activities: unknown[][] = [];
    const history: unknown[][] = [];
    const meetings: { lead: string; owner: number; startsAt: Date; createdAt: Date; status: string }[] = [];
    const tasks: unknown[][] = [];
    const lastMonthStart = addDays(today, -30);
    days.forEach((day, di) => {
      const month = Math.floor(di / 30.44);
      const growth = Math.pow(1.06, month) * (month === 2 ? 0.7 : 1);
      const n = Math.round((weekday(day) === 0 ? 0.4 : 1) * 15 * growth * r.between(0.8, 1.2));
      for (let k = 0; k < n; k++) {
        const evening = r.chance(0.34);
        const hour = evening ? r.int(19, 22) : r.int(9, 18);
        const createdAt = atLocal(day, hour, r.int(0, 59), tz);
        if (createdAt > now) continue;
        const i = leads.length;
        const source = r.weighted(SOURCES);
        // The last ten days keep a few leads nobody has picked up yet.
        const owner =
          createdAt > new Date(now.getTime() - 10 * DAY) && r.chance(0.03)
            ? null
            : r.int(0, PEOPLE.length - 1);
        const firstName = r.pick(FIRST);
        const lastName = r.pick(LAST);
        const needsCountry = r.chance(0.04);
        const lead: Lead = {
          id: randomUUID(),
          name: `${firstName} ${lastName}`,
          email: `${firstName}.${lastName}.${i}`.toLowerCase() + "@example.com",
          // The range set aside for drama: +44 7700 900000–900999.
          phone: needsCountry ? null : `+447700900${String(i % 1000).padStart(3, "0")}`,
          phoneStatus: needsCountry ? "needs_country" : "valid",
          phoneRaw: needsCountry ? `07700 900${String(i % 1000).padStart(3, "0")}` : null,
          owner,
          source,
          createdAt,
          stage: 0,
          stageAt: createdAt,
          wonAt: null,
          value: null,
          product: null,
          lostAt: null,
          reason: null,
          // Most leads arrive with the package they're asking about, so open deals carry a value.
          ...(() => {
            if (!r.chance(0.7)) return {};
            const pi = r.weighted(PRODUCTS);
            return { value: PRODUCTS[pi]!.value, product: pi };
          })(),
          custom: ((): Record<string, string> => {
            if (!r.chance(0.6)) return {};
            const id = budgetIds[r.weighted([{ weight: 0.45 }, { weight: 0.4 }, { weight: 0.15 }])];
            return id ? { budget: id } : {};
          })(),
          tag: r.chance(0.2) ? r.int(0, TAGS.length - 1) : null,
        };
        leads.push(lead);
        const move = (to: string, at: Date, from: string) => {
          history.push([lead.id, from, to, pipeline, at]);
        };
        // First contact: most within the hour; evening arrivals mostly the next morning; Leo slowest.
        let contactAt: Date | null = null;
        if (owner !== null && r.chance(0.85)) {
          if (evening && r.chance(0.6)) contactAt = atLocal(addDays(day, 1), 10, r.int(0, 90), tz);
          else contactAt = new Date(createdAt.getTime() + r.lognormal(owner === leo ? 180 : 35) * MIN);
          if (contactAt > now) contactAt = null;
        }
        if (contactAt) {
          activities.push([randomUUID(), lead.id, "whatsapp_opened", contactAt, people[owner!]!.id]);
          move(openAt(1), contactAt, openAt(0));
          lead.stage = 1;
          lead.stageAt = contactAt;
        }
        const fast = contactAt !== null && contactAt.getTime() - createdAt.getTime() < HOUR;
        let replyAt: Date | null = null;
        if (contactAt && r.chance(0.45)) {
          replyAt = new Date(contactAt.getTime() + r.between(1, 20) * HOUR);
          if (replyAt > now) replyAt = null;
          else {
            activities.push([randomUUID(), lead.id, "reply_logged", replyAt, null]);
            move(openAt(2), replyAt, openAt(1));
            lead.stage = 2;
            lead.stageAt = replyAt;
          }
        }
        // A call, for some: Monday mornings are missed most, Friday afternoons held best.
        if (contactAt && owner !== null && r.chance(0.25)) {
          const booked = new Date((replyAt ?? contactAt).getTime() + r.between(1, 24) * HOUR);
          const callDay = addDays(dayOf(booked, tz), r.int(2, 10));
          const wd = weekday(callDay);
          // Monday calls mostly at 9; Friday ones in the afternoon.
          const slot =
            wd === 1 && r.chance(0.85) ? 9 : wd === 5 && r.chance(0.6) ? r.int(14, 16) : r.int(10, 17);
          const startsAt = atLocal(callDay, slot, r.pick([0, 30]), tz);
          const missRate = wd === 1 && slot === 9 ? 0.45 : wd === 5 && slot >= 14 ? 0.04 : 0.1;
          const status =
            startsAt > now
              ? "scheduled"
              : r.chance(missRate)
                ? "no_show"
                : r.chance(0.07)
                  ? "cancelled"
                  : "completed";
          if (booked <= now) {
            meetings.push({ lead: lead.id, owner: owner, startsAt, createdAt: booked, status });
            move(openAt(3), booked, openAt(lead.stage));
            lead.stage = 3;
            lead.stageAt = booked;
          }
        }
        // Won or lost: speed pays; referrals win far more, webinars far less.
        const p =
          (contactAt ? (fast ? 0.085 : 0.035) : 0.003) *
          SOURCES[source]!.win *
          (meetings.at(-1)?.lead === lead.id ? 1.5 : 1);
        if (r.chance(p)) {
          const wonAt = new Date(createdAt.getTime() + r.between(4, 45) * DAY);
          if (wonAt <= now) {
            lead.product = r.weighted(PRODUCTS);
            lead.value = Math.round((PRODUCTS[lead.product]!.value * r.between(0.8, 1.2)) / 100) * 100;
            lead.wonAt = wonAt;
            move(wonStage, wonAt, openAt(lead.stage));
            lead.stage = -1;
            lead.stageAt = wonAt;
          }
        } else if (r.chance(0.32)) {
          const lostAt = new Date(createdAt.getTime() + r.between(2, 25) * DAY);
          if (lostAt <= now) {
            // "No reply" leads the reasons, more so in the last month.
            const noReply = lostAt >= atLocal(lastMonthStart, 0, 0, tz) ? 0.55 : 0.35;
            lead.reason = reasons.length < 2 || r.chance(noReply) ? 0 : r.int(1, reasons.length - 1);
            lead.lostAt = lostAt;
            move(lostStage, lostAt, openAt(lead.stage));
            lead.stage = -2;
            lead.stageAt = lostAt;
          }
        }
        // Follow-ups: most done on time; Leo's Mondays slip.
        if (contactAt && owner !== null && r.chance(0.7)) {
          const due = atLocal(addDays(dayOf(contactAt, tz), r.int(1, 3)), r.int(10, 17), 0, tz);
          // Leo's Mondays slip; his other days are reliable.
          const late = (owner === leo ? (weekday(dayOf(due, tz)) === 1 ? 0.9 : 0.03) : 0.12) > r.next();
          const done =
            due > now || r.chance(0.04)
              ? null
              : new Date(due.getTime() + (late ? r.between(1, 30) * HOUR : -r.between(0, 120) * MIN));
          tasks.push([
            randomUUID(),
            lead.id,
            people[owner]!.id,
            "Follow up",
            due,
            done && done <= now ? "done" : "open",
            randomUUID(),
            done && done <= now ? done : null,
          ]);
        }
      }
    });
    // A dozen lost leads come back: reopened a few days after, then won. Reopening clears the loss (leads/write.ts).
    const lost = leads.filter(
      (l) => l.lostAt && l.lostAt < new Date(now.getTime() - 20 * DAY) && l.owner !== null,
    );
    for (let k = 0; k < 12 && lost.length; k++) {
      const l = lost.splice(r.int(0, lost.length - 1), 1)[0]!;
      const reopened = new Date(l.lostAt!.getTime() + r.between(3, 10) * DAY);
      const wonAt = new Date(reopened.getTime() + r.between(2, 8) * DAY);
      activities.push([randomUUID(), l.id, "reopened", reopened, people[l.owner!]!.id]);
      history.push([l.id, lostStage, openAt(1), pipeline, reopened]);
      history.push([l.id, openAt(1), wonStage, pipeline, wonAt]);
      l.product = r.weighted(PRODUCTS);
      l.value = Math.round((PRODUCTS[l.product]!.value * r.between(0.8, 1.2)) / 100) * 100;
      l.wonAt = wonAt;
      l.lostAt = null;
      l.reason = null;
      l.stage = -1;
      l.stageAt = wonAt;
    }

    const stageOf = (l: Lead) => (l.stage === -1 ? wonStage : l.stage === -2 ? lostStage : openAt(l.stage));
    // Each lead last touched when its latest thing happened (not the moment the demo was seeded), so the list's
    // "Last activity" and its sorting read like a real business.
    const lastTouch = new Map<string, number>();
    for (const a of activities) {
      const at = (a[3] as Date).getTime();
      if (at > (lastTouch.get(a[1] as string) ?? 0)) lastTouch.set(a[1] as string, at);
    }
    const touched = (l: Lead) =>
      new Date(Math.max(l.createdAt.getTime(), l.stageAt.getTime(), lastTouch.get(l.id) ?? 0));
    await insert(
      c,
      "INSERT INTO leads (id, pipeline_id, stage_id, stage_entered_at, owner_id, name, email, phone_e164, phone_status, phone_raw, source_id, created_at, won_at, value, product_id, lost_at, lost_reason_id, custom, updated_at, last_activity_at) SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::timestamptz[], $5::uuid[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::uuid[], $12::timestamptz[], $13::timestamptz[], $14::numeric[], $15::uuid[], $16::timestamptz[], $17::uuid[], $18::jsonb[], $19::timestamptz[], $20::timestamptz[])",
      leads.map((l) => [
        l.id,
        pipeline,
        stageOf(l),
        l.stageAt,
        l.owner === null ? null : people[l.owner]!.id,
        l.name,
        l.email,
        l.phone,
        l.phoneStatus,
        l.phoneRaw,
        sources[l.source],
        l.createdAt,
        l.wonAt,
        l.value,
        l.product === null ? null : products[l.product],
        l.lostAt,
        l.reason === null ? null : reasons[l.reason]!,
        JSON.stringify(l.custom),
        touched(l),
        touched(l),
      ]),
    );
    await insert(
      c,
      "INSERT INTO lead_tags (lead_id, tag_id) SELECT * FROM unnest($1::uuid[], $2::uuid[])",
      leads.filter((l) => l.tag !== null).map((l) => [l.id, tags[l.tag!]]),
    );
    await insert(
      c,
      "INSERT INTO activities (id, lead_id, type, occurred_at, user_id) SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::timestamptz[], $5::uuid[])",
      activities,
    );
    await insert(
      c,
      "INSERT INTO lead_stage_history (lead_id, from_stage_id, to_stage_id, pipeline_id, changed_at) SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::timestamptz[])",
      history,
    );
    await insert(
      c,
      "INSERT INTO tasks (id, lead_id, assignee_id, title, due_at, status, series_id, done_at) SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::timestamptz[], $6::text[], $7::uuid[], $8::timestamptz[])",
      tasks,
    );
    // A meeting is written by the person whose calendar it's on (its row-level security).
    for (const [pi, person] of people.entries()) {
      const mine = meetings.filter((m) => m.owner === pi);
      if (!mine.length) continue;
      await c.query("SELECT set_config('lume.user_id', $1, true)", [person.id]);
      await insert(
        c,
        "INSERT INTO meetings (id, lead_id, owner_id, source, external_id, matched_by, title, starts_at, ends_at, status, created_at) SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[], $8::timestamptz[], $9::timestamptz[], $10::text[], $11::timestamptz[])",
        mine.map((m, i) => {
          const id = randomUUID();
          return [
            id,
            m.lead,
            person.id,
            "calendly",
            id,
            "calendly",
            MEETING_TITLES[(i + m.startsAt.getUTCDate()) % MEETING_TITLES.length]!,
            m.startsAt,
            new Date(m.startsAt.getTime() + 30 * MIN),
            m.status,
            m.createdAt,
          ];
        }),
      );
    }
    await c.query("SELECT set_config('lume.user_id', $1, true)", [SYSTEM]);

    // Goals for this month: the business 10% over last month's revenue; each person a little over last month's wins.
    const monthFirst = `${today.slice(0, 8)}01`;
    const lastFirst = addDays(monthFirst, -1).slice(0, 8) + "01";
    const inLast = (l: Lead) => l.wonAt && dayOf(l.wonAt, tz) >= lastFirst && dayOf(l.wonAt, tz) < monthFirst;
    const lastRevenue = leads.filter(inLast).reduce((a, l) => a + (l.value ?? 0), 0);
    const goals: unknown[][] = [];
    if (lastRevenue > 0)
      goals.push([
        randomUUID(),
        "business",
        null,
        "revenue",
        "month",
        monthFirst,
        Math.round((lastRevenue * 1.1) / 1000) * 1000,
      ]);
    people.forEach((p, pi) => {
      const won = leads.filter((l) => inLast(l) && l.owner === pi).length;
      goals.push([
        randomUUID(),
        "user",
        p.id,
        "won",
        "month",
        monthFirst,
        Math.max(2, Math.round(won * 1.1) + 1),
      ]);
    });
    await insert(
      c,
      "INSERT INTO goals (id, scope, scope_id, metric, period, period_start, target) SELECT * FROM unnest($1::uuid[], $2::text[], $3::uuid[], $4::text[], $5::text[], $6::date[], $7::numeric[])",
      goals,
    );
    leadCount = leads.length;
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  // Every day's rollups, so Analytics answers at once.
  await rollupDays(pool, days, tz);
  return { people, leads: leadCount };
}
