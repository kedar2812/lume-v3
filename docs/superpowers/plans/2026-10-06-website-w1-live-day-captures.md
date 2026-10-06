# Website W1 — Live-day captures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real LUME captures for lumecrm.in — a business doing well, a working day in progress, every problem shown being caught — in both themes, on desktop and phone, with the hero's tile positions.

**Architecture:** The demo seed gains a `trajectory: "growing"` option; a new `seedLiveDay()` plants today's work for chosen people; a new on-request Playwright project `site-captures` seeds an INR / Asia/Kolkata business, opens every screen and action state with real keys and clicks, checks the story (improvements, no empty states) before it shoots, and writes WebP captures plus tile rectangles to `apps/web/e2e/__site__/`.

**Tech Stack:** TypeScript, pg, Vitest (api harness), Playwright, sharp (WebP).

**Spec:** `docs/superpowers/specs/2026-10-06-lumecrm-website-design.md` (§3, §4, §4.1, §5.1, §6)

## Global Constraints

- Demo and seed data are generic and fictional (CLAUDE.md); no client names.
- "This is shaped in the demo data (§6), never by retouching a capture: LUME counts every number itself."
- The default seed (no `trajectory`) behaves exactly as today: seed.test, consistency.test and the 8D fixture unchanged.
- Captures: 1440 × 900 at device scale 2, Porcelain and Obsidian, plus 390 × 844 phone; WebP; `<screen>-<theme>.webp` (`-phone` suffix for phone).
- Captured at 10:45 am business time; business in ₹ (INR) and Asia/Kolkata.
- The phone column is hidden in Leads captures (the demo's numbers are fictional UK ones).
- Never run two `scripts/dev.sh run` at once; fetch outputs before the next run.

## Review Focus

- The capture run on a day where the seed's planted patterns don't all fire → the run must fail loudly, not shoot a weaker story (Task 4 story check).
- A live day planted for a person who has no leads of their own (the seller) → their Today must still fill, from leads assigned to them by `seedLiveDay` (Task 2 test).
- Times near midnight / the business day boundary → live-day items must fall on the business day of `now` in its time zone (Task 2 test at 23:30 IST).
- Running the capture twice on one database → `seedLiveDay` refuses to double-plant (Task 2 test).
- A capture left showing a skeleton or spinner → the settle step waits for `aria-busy` to clear (Task 4).

---

### Task 1: The "growing" trajectory

**Files:**
- Modify: `apps/api/src/demo/seed.ts` (DemoOptions; the arrivals/contact/reply/win/follow-up chances)
- Test: `apps/api/src/demo/seed.test.ts`

**Interfaces:**
- Produces: `DemoOptions.trajectory?: "steady" | "growing"` (default `"steady"`).

- [ ] **Step 1: Write the failing test** (append to seed.test.ts)

```ts
describe("a growing business (the website's captures, spec §4.1)", () => {
  let g: Harness;
  let who: SeededUser;
  beforeAll(async () => {
    g = await createHarness();
    g.clock.now = NOW;
    await seedDemoBusiness(g.ownerPool, { now: NOW, seed: 7, trajectory: "growing" });
    who = await g.seedUser({
      grants: [
        { key: "analytics.view", scope: "all" },
        { key: "analytics.revenue", scope: null },
        { key: "leads.view", scope: "all" },
      ],
    });
  }, 300_000);
  afterAll(async () => g.close());

  it("the last 30 days beat the 30 before on what an owner looks at first", async () => {
    const o = (
      await (await g.signIn(who)).inject({ method: "GET", url: "/api/v1/analytics/overview?range=30d&compare=1" })
    ).json();
    const better = (id: string) => o.tiles.find((t: { id: string }) => t.id === id).trend?.good === true;
    for (const id of ["revenue_won", "won", "reply_rate", "speed_to_lead", "ontime"]) expect([id, better(id)]).toEqual([id, true]);
    const good = o.tiles.filter((t: { trend?: { good?: boolean } }) => t.trend?.good === true).length;
    expect(good).toBeGreaterThanOrEqual(8);
  });

  it("still carries the patterns LUME notices", async () => {
    const c = await g.signIn(who);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++)
      ids.push(...(await c.inject({ method: "GET", url: "/api/v1/analytics/insights?range=90d" })).json().insights.map((x: { id: string }) => x.id));
    for (const id of ["speed_pays", "source_under", "evening_arrivals"]) expect(ids, id).toContain(id);
  });
});
```

Before writing it, read `packages/core/src/analytics/trend.ts` (or wherever `trend()` lives) for the exact shape of a tile's `trend` (`good`/`direction` field names) and use those names.

- [ ] **Step 2: Run it to see it fail**

Run: `bash scratchpad/vt.sh apps/api/src/demo/seed.test.ts`
Expected: FAIL — `trajectory` unknown (type error) or the trend assertions false (the default seed's last month is the "harder month").

- [ ] **Step 3: Implement**

In `DemoOptions` add:

```ts
  /** "growing" (the website's captures): the last 30 days clearly better than the 30 before. Default "steady". */
  trajectory?: "steady" | "growing";
```

In the day loop, after `const month = …`, compute the lift (1 = today's behaviour):

```ts
      // The website's story (spec §4.1): a business doing well with LUME — more leads, faster first contact, more
      // replies, more wins and follow-ups on time in the last 30 days. Off by default, so tests are unchanged.
      const recent = o.trajectory === "growing" && day >= lastMonthStart;
      const lift = recent ? 1 : 0;
```

and apply it where the chances are drawn (each line replaces the existing one):

```ts
      const n = Math.round((weekday(day) === 0 ? 0.4 : 1) * 15 * growth * (recent ? 1.18 : 1) * r.between(0.8, 1.2));
```
```ts
          else contactAt = new Date(createdAt.getTime() + r.lognormal(owner === leo ? 180 : recent ? 18 : 35) * MIN);
```
```ts
        if (contactAt && r.chance(0.45 + 0.12 * lift)) {
```
```ts
          SOURCES[source]!.win *
          (meetings.at(-1)?.lead === lead.id ? 1.5 : 1) *
          (recent ? 1.45 : 1);
```
```ts
          const late = (owner === leo ? (weekday(dayOf(due, tz)) === 1 ? 0.9 : 0.03) : recent ? 0.04 : 0.12) > r.next();
```
```ts
            const noReply = lostAt >= atLocal(lastMonthStart, 0, 0, tz) && o.trajectory !== "growing" ? 0.55 : 0.35;
```

Also, when growing, the third month's dip (`month === 2 ? 0.7 : 1`) stays — it's history, not the last month.

- [ ] **Step 4: Run it to see it pass, then the whole demo folder**

Run: `bash scratchpad/vt.sh apps/api/src/demo/`
Expected: PASS — the new tests and the existing seed.test / consistency.test unchanged. If fewer than 8 tiles improve, raise the lifts by the smallest step that makes the 12-day sweep pass (Step 5), and record the values.

- [ ] **Step 5: Sweep 12 days** (temporary diagnostic, deleted after)

Copy the shape of the 2026-10-06 diagnostic (seed at `Date.now() - back·DAY` for back in 0,4,5,6,7,9,10,11,12,14,15,21 with `trajectory: "growing"`; print improving-tile count and insight ids). Expected: ≥ 8 improving tiles and all three insights on every day. Delete the file.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/demo/seed.ts apps/api/src/demo/seed.test.ts
git commit -m "feat(demo): a growing business for the website's captures — the last month better, the patterns still there"
```

### Task 2: `seedLiveDay` — today's work for chosen people

**Files:**
- Create: `apps/api/src/demo/live-day.ts`
- Test: `apps/api/src/demo/live-day.test.ts`

**Interfaces:**
- Consumes: a database already holding the demo business (`seedDemoBusiness`).
- Produces: `seedLiveDay(pool: pg.Pool, o: { now: Date; people: { userId: string; scope: "all" | "own" }[] }): Promise<{ planted: number }>` and `class LiveDayRefused extends Error` (already planted today).

What it plants for each person (all on the business day of `now`, business time zone from settings), on demo leads given to them for the day (`UPDATE leads SET owner_id = userId` on a chosen open lead set when the person owns none):

- follow-ups: 2 overdue (due 09:30, 10:15), 3 due within two hours (11:00, 11:30, 12:30), 4 later (14:00, 15:30, 16:30, 18:00), 3 done this morning (done_at 09:10, 09:40, 10:20, `done_by` = the person); one of the overdue two is the no-touch kind: title `No contact for 3 days`, `auto_rule_id = NO_TOUCH_RULE_ID`;
- calls: 2 meetings (10:00 completed — held; 16:00 scheduled), source `calendly`, titles from `MEETING_TITLES`, written with `lume.user_id` = the person (meetings RLS);
- WhatsApp: 4 `whatsapp_opened` activities this morning by the person, 2 `reply_logged` after them;
- a deal won at 11:40 (an open lead of theirs → won stage, value from PRODUCTS, history row);
- for `scope: "all"` only: 3 new leads with no owner created at 08:50, 09:55, 10:30 (source Instagram ads), so Needs you and the Leads tile's "with no one yet" read true;
- then `rollupDays(pool, [today], tz)`.

- [ ] **Step 1: Write the failing tests**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NO_TOUCH_RULE_ID } from "@lume/core";
import { createHarness, type Harness, type SeededUser } from "../../test/harness";
import { seedDemoBusiness } from "./seed";
import { LiveDayRefused, seedLiveDay } from "./live-day";

let h: Harness;
let owner: SeededUser;
let seller: SeededUser;
// 10:45 am in Kolkata.
const NOW = new Date("2026-10-07T05:15:00Z");

beforeAll(async () => {
  h = await createHarness();
  h.clock.now = NOW;
  await h.ownerPool.query("UPDATE settings SET timezone = 'Asia/Kolkata', currency = 'INR' WHERE id = 1");
  await seedDemoBusiness(h.ownerPool, { now: NOW, seed: 7, trajectory: "growing" });
  owner = await h.seedUser({ grants: [{ key: "leads.view", scope: "all" }, { key: "leads.assign", scope: "all" }, { key: "analytics.view", scope: "all" }, { key: "analytics.revenue", scope: null }], totp: true });
  seller = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }, { key: "analytics.view", scope: "own" }], totp: true });
  await h.queryAll("UPDATE users SET timezone = NULL WHERE id = ANY($1::uuid[])", [[owner.id, seller.id]]);
  await seedLiveDay(h.ownerPool, { now: NOW, people: [{ userId: owner.id, scope: "all" }, { userId: seller.id, scope: "own" }] });
}, 300_000);
afterAll(async () => h.close());
const today = async (u: SeededUser) => (await (await h.signIn(u)).inject({ method: "GET", url: "/api/v1/today" })).json();
const tiles = async (u: SeededUser) => (await (await h.signIn(u)).inject({ method: "GET", url: "/api/v1/today/tiles" })).json();

describe("a working day on Today (spec §6)", () => {
  it("the owner's day: overdue, soon, later, done, calls, someone waiting", async () => {
    const t = await today(owner);
    expect([t.overdue.length, t.soon.length, t.later.length, t.done]).toEqual([2, 3, 4, 3]);
    expect(t.meetings.map((m: { status: string }) => m.status)).toEqual(["completed", "scheduled"]);
    expect(t.needsYou.unassigned).toBeGreaterThanOrEqual(3);
    expect(t.overdue.some((x: { title: string }) => x.title === "No contact for 3 days")).toBe(true);
  });
  it("a rep's own day fills from their own leads", async () => {
    const t = await today(seller);
    expect([t.overdue.length, t.soon.length, t.later.length, t.done]).toEqual([2, 3, 4, 3]);
    expect(t.needsYou).toBeUndefined();
    const s = await tiles(seller);
    expect(s.leads.reached).toBeGreaterThan(0);
  });
  it("a deal won this morning counts in the month", async () => {
    const s = await tiles(owner);
    expect(s.month.value).toBeGreaterThan(0);
    expect(s.pipeline.wonThisMonth).toBeGreaterThan(0);
  });
  it("the no-touch follow-up is the rule's own kind", async () => {
    const r = await h.queryAll<{ n: number }>("SELECT count(*)::int AS n FROM tasks WHERE auto_rule_id = $1 AND assignee_id = $2", [NO_TOUCH_RULE_ID, owner.id]);
    expect(r[0]!.n).toBe(1);
  });
  it("refuses to plant the same day twice", async () => {
    await expect(seedLiveDay(h.ownerPool, { now: NOW, people: [{ userId: owner.id, scope: "all" }] })).rejects.toBeInstanceOf(LiveDayRefused);
  });
  it("near midnight, everything still lands on that business day", async () => {
    const late = await createHarness();
    const at = new Date("2026-10-07T18:00:00Z"); // 23:30 in Kolkata
    late.clock.now = at;
    await late.ownerPool.query("UPDATE settings SET timezone = 'Asia/Kolkata' WHERE id = 1");
    await seedDemoBusiness(late.ownerPool, { now: at, seed: 7 });
    const u = await late.seedUser({ grants: [{ key: "leads.view", scope: "own" }], totp: true });
    await late.queryAll("UPDATE users SET timezone = NULL WHERE id = $1", [u.id]);
    await seedLiveDay(late.ownerPool, { now: at, people: [{ userId: u.id, scope: "own" }] });
    const days = await late.queryAll<{ d: string }>(
      "SELECT DISTINCT to_char(due_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS d FROM tasks WHERE assignee_id = $1", [u.id]);
    expect(days.map((x) => x.d)).toEqual(["2026-10-07"]);
    await late.close();
  });
});
```

(Times later than `now` are kept as planned — at 23:30 the "later" follow-ups are already past and read as overdue; the test pins the day, not the split.)

- [ ] **Step 2: Run to see it fail**

Run: `bash scratchpad/vt.sh apps/api/src/demo/live-day.test.ts`
Expected: FAIL — `./live-day` not found.

- [ ] **Step 3: Implement `live-day.ts`**

```ts
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { dayOf, NO_TOUCH_RULE_ID, wallTime } from "@lume/core";
import { rollupDays } from "../modules/analytics/rollup";
import { MEETING_TITLES, PRODUCTS } from "./names";

/**
 * Today's work for chosen people on the demo business (website spec §6): what a working morning looks like at
 * 10:45 — some overdue (one brought back by the no-touch rule), some due soon, some later, a few done, a call held
 * and one to come, WhatsApps sent and answered, a deal won before lunch. Fictional, generic; for the website's
 * captures now and demo.lumecrm.in later. Plants once per day.
 */
export class LiveDayRefused extends Error {
  constructor() {
    super("Today's work is already planted.");
    this.name = "LiveDayRefused";
  }
}
const SYSTEM = "0190e0c0-0000-7000-8000-000000000000";
type Person = { userId: string; scope: "all" | "own" };

export async function seedLiveDay(pool: pg.Pool, o: { now: Date; people: Person[] }): Promise<{ planted: number }> {
  const c = await pool.connect();
  let planted = 0;
  let tz = "UTC";
  let today = "";
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', 'all', true)", [SYSTEM]);
    tz = (await c.query<{ tz: string }>("SELECT timezone AS tz FROM settings WHERE id = 1")).rows[0]!.tz;
    today = dayOf(o.now, tz);
    const [y, m, d] = today.split("-").map(Number) as [number, number, number];
    const at = (hh: number, mm: number) => wallTime(y, m, d, hh, mm, tz);
    const already = await c.query("SELECT 1 FROM activities WHERE type = 'note_added' AND body = $1 LIMIT 1", [`live-day:${today}`]);
    if (already.rowCount) throw new LiveDayRefused();
    const stages = (await c.query<{ id: string; kind: string }>(
      `SELECT s.id, s.kind FROM stages s JOIN pipelines p ON p.id = s.pipeline_id
        WHERE p.is_default AND s.archived_at IS NULL ORDER BY s.position`)).rows;
    const wonStage = stages.find((s) => s.kind === "won")!.id;
    const openIds = stages.filter((s) => s.kind === "open").map((s) => s.id);

    for (const p of o.people) {
      // Twelve open leads for the day: theirs, else given to them now.
      const leads = (await c.query<{ id: string; stage_id: string; pipeline_id: string }>(
        `SELECT id, stage_id, pipeline_id FROM leads
          WHERE deleted_at IS NULL AND stage_id = ANY($1::uuid[]) AND (owner_id = $2 OR owner_id IS NOT NULL)
          ORDER BY (owner_id = $2) DESC, created_at DESC LIMIT 12`, [openIds, p.userId])).rows;
      await c.query("UPDATE leads SET owner_id = $1 WHERE id = ANY($2::uuid[])", [p.userId, leads.map((l) => l.id)]);
      const task = async (lead: string, title: string, due: Date, done: Date | null, rule: string | null = null) => {
        const id = randomUUID();
        await c.query(
          `INSERT INTO tasks (id, lead_id, assignee_id, title, due_at, status, series_id, done_at, done_by, auto_rule_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $1, $7, $8, $9, $5 - interval '1 day')`,
          [id, lead, p.userId, title, due, done ? "done" : "open", done, done ? p.userId : null, rule]);
        planted++;
      };
      const L = leads.map((l) => l.id);
      await task(L[0]!, "No contact for 3 days", at(9, 30), null, NO_TOUCH_RULE_ID);
      await task(L[1]!, "Send the brochure", at(10, 15), null);
      await task(L[2]!, "Follow up", at(11, 0), null);
      await task(L[3]!, "Confirm the date", at(11, 30), null);
      await task(L[4]!, "Follow up", at(12, 30), null);
      await task(L[5]!, "Share the quote", at(14, 0), null);
      await task(L[6]!, "Follow up", at(15, 30), null);
      await task(L[7]!, "Check in after the call", at(16, 30), null);
      await task(L[8]!, "Follow up", at(18, 0), null);
      await task(L[9]!, "Follow up", at(9, 0), at(9, 10));
      await task(L[10]!, "Send the brochure", at(9, 30), at(9, 40));
      await task(L[11]!, "Follow up", at(10, 0), at(10, 20));
      // WhatsApps this morning, two answered.
      for (const [i, t] of [at(9, 12), at(9, 41), at(10, 5), at(10, 22)].entries()) {
        await c.query("INSERT INTO activities (id, lead_id, type, occurred_at, user_id) VALUES ($1, $2, 'whatsapp_opened', $3, $4)", [randomUUID(), L[9 + (i % 3)]!, t, p.userId]);
      }
      for (const t of [at(9, 58), at(10, 31)])
        await c.query("INSERT INTO activities (id, lead_id, type, occurred_at, user_id) VALUES ($1, $2, 'reply_logged', $3, NULL)", [randomUUID(), L[9]!, t]);
      // A deal won before lunch.
      const won = L[11]!;
      const product = PRODUCTS[1]!;
      await c.query(
        `INSERT INTO lead_stage_history (lead_id, from_stage_id, to_stage_id, pipeline_id, changed_at)
         SELECT id, stage_id, $2, pipeline_id, $3 FROM leads WHERE id = $1`, [won, wonStage, at(11, 40)]);
      await c.query("UPDATE leads SET stage_id = $2, stage_entered_at = $3, won_at = $3, value = $4, updated_at = $3, last_activity_at = $3 WHERE id = $1", [won, wonStage, at(11, 40), product.value]);
      // Two calls on their calendar: one held at 10, one at 4.
      await c.query("SELECT set_config('lume.user_id', $1, true)", [p.userId]);
      for (const [i, [start, status]] of ([[at(10, 0), "completed"], [at(16, 0), "scheduled"]] as const).entries()) {
        const id = randomUUID();
        await c.query(
          `INSERT INTO meetings (id, lead_id, owner_id, source, external_id, matched_by, title, starts_at, ends_at, status, created_at)
           VALUES ($1, $2, $3, 'calendly', $1, 'calendly', $4, $5, $5 + interval '30 minutes', $6, $5 - interval '2 days')`,
          [id, L[2 + i]!, p.userId, MEETING_TITLES[i]!, start, status]);
      }
      await c.query("SELECT set_config('lume.user_id', $1, true)", [SYSTEM]);
      // For someone who sees everything: three new leads with no one yet.
      if (p.scope === "all") {
        const src = (await c.query<{ id: string }>("SELECT id FROM lead_sources WHERE name = 'Instagram ads' LIMIT 1")).rows[0]?.id ?? null;
        for (const [i, t] of [at(8, 50), at(9, 55), at(10, 30)].entries())
          await c.query(
            `INSERT INTO leads (id, pipeline_id, stage_id, stage_entered_at, owner_id, name, email, phone_status, source_id, created_at, updated_at, last_activity_at)
             VALUES ($1, $2, $3, $4, NULL, $5, $6, 'needs_country', $7, $4, $4, $4)`,
            [randomUUID(), leads[0]!.pipeline_id, openIds[0], t, ["Ira Menon", "Kunal Bhat", "Tara Dsouza"][i], `new.${i}.${today}@example.com`, src]);
      }
    }
    await c.query("INSERT INTO activities (id, lead_id, type, occurred_at, body) SELECT $1, id, 'note_added', $2, $3 FROM leads LIMIT 1", [randomUUID(), o.now, `live-day:${today}`]);
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
```

Before running, check every column used against the migrations (`activities` has `body`? — `grep -n "CREATE TABLE activities" -A15 packages/db/migrations/*.sql`; if the marker can't be a note, use a row in `settings`-free table such as a dedicated `UPDATE settings SET ... ` is NOT allowed — instead detect "already planted" as `SELECT 1 FROM tasks WHERE auto_rule_id = $1 AND title = 'No contact for 3 days' AND due_at::date = …`). The fix is the smallest one that keeps "refuses the same day twice" true; record it as a ruling. Likewise check the `leads` insert's required columns (`phone_e164` nullable with `needs_country`, `custom` default) and the count triggers (`lead_counts_now` updates via triggers on leads — no manual work).

- [ ] **Step 4: Run to see it pass**

Run: `bash scratchpad/vt.sh apps/api/src/demo/`
Expected: PASS (live-day.test 6/6; seed.test, consistency.test unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/demo/live-day.ts apps/api/src/demo/live-day.test.ts
git commit -m "feat(demo): a working day on Today — overdue, soon, done, calls, replies and a win, for the website's captures"
```

### Task 3: WebP output and the capture helpers

**Files:**
- Modify: `apps/web/package.json` (devDependency `sharp`)
- Create: `apps/web/e2e/site/capture.ts`
- Test: `apps/web/e2e/site/capture.test.ts` (vitest, node environment)

**Interfaces:**
- Produces:
  - `toWebp(png: Buffer, out: string, quality?: number): Promise<{ width: number; height: number; bytes: number }>`
  - `rectsOf(page: Page, selectors: Record<string, string>): Promise<Record<string, { x: number; y: number; w: number; h: number }>>` — CSS-pixel boxes relative to the viewport, rounded.
  - `checkStory(page: Page, rules: StoryRule[]): Promise<string[]>` — returns the broken rules' descriptions (empty = fine). `type StoryRule = { what: string; check: (page: Page) => Promise<boolean> }`.

- [ ] **Step 1: Failing test** (toWebp)

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { toWebp } from "./capture";

describe("captures as WebP", () => {
  it("keeps the size and writes a WebP", async () => {
    const png = await sharp({ create: { width: 2880, height: 1800, channels: 3, background: "#07080b" } }).png().toBuffer();
    const out = path.join(mkdtempSync(path.join(tmpdir(), "cap-")), "x.webp");
    const r = await toWebp(png, out);
    expect([r.width, r.height]).toEqual([2880, 1800]);
    expect(readFileSync(out).subarray(8, 12).toString()).toBe("WEBP");
  });
});
```

- [ ] **Step 2: Run** `bash scratchpad/vt.sh apps/web/e2e/site/capture.test.ts` — Expected: FAIL (module missing). If the web vitest config doesn't include `e2e/**`, add `e2e/site/**/*.test.ts` to its `include` with `environment: "node"` via a per-file `// @vitest-environment node` comment.

- [ ] **Step 3: Implement `capture.ts`**

```ts
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import sharp from "sharp";

/** A capture as WebP, same pixels, quality 86 (text stays crisp at 2×). */
export async function toWebp(png: Buffer, out: string, quality = 86) {
  mkdirSync(path.dirname(out), { recursive: true });
  const info = await sharp(png).webp({ quality, effort: 5, smartSubsample: true }).toFile(out);
  return { width: info.width, height: info.height, bytes: info.size };
}

export type Rect = { x: number; y: number; w: number; h: number };
/** Each selector's first match, as a viewport box in CSS px (the hero cuts its tiles from the capture by these). */
export async function rectsOf(page: Page, selectors: Record<string, string>): Promise<Record<string, Rect>> {
  const out: Record<string, Rect> = {};
  for (const [name, sel] of Object.entries(selectors)) {
    const b = await page.locator(sel).first().boundingBox();
    if (!b) throw new Error(`no box for ${name} (${sel})`);
    out[name] = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
  }
  return out;
}

export type StoryRule = { what: string; check: (page: Page) => Promise<boolean> };
/** The rules a capture must meet before it's taken (spec §4.1): the broken ones, in words. */
export async function checkStory(page: Page, rules: StoryRule[]): Promise<string[]> {
  const broken: string[] = [];
  for (const r of rules) if (!(await r.check(page).catch(() => false))) broken.push(r.what);
  return broken;
}
```

- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "test(site): captures as WebP, tile boxes and story checks"`

### Task 4: The `site-captures` run

**Files:**
- Create: `apps/web/e2e/site/site-captures.review.ts`
- Modify: `apps/web/playwright.config.ts` (a `site-captures` project beside `design-review`, under `LUME_REVIEW`)
- Modify: `apps/web/.gitignore` (`e2e/__site__/`)

**Interfaces:**
- Consumes: `seedDemoBusiness(..., { trajectory: "growing", demoMode: true })` (Task 1), `seedLiveDay` (Task 2), `toWebp`, `rectsOf`, `checkStory` (Task 3); `stateFile`, `PEOPLE`, `openApp`, `settle` from e2e fixtures.
- Produces: `apps/web/e2e/__site__/<screen>-<light|dark>[-phone].webp`, `today-<theme>[-phone].rects.json`, `manifest.json` (`{ screens: { name, theme, phone, width, height, bytes }[] , capturedAt }`).

Shots (desktop unless marked; each in light and dark):

| name | as | path | then |
|---|---|---|---|
| today | owner | /today | — (rects, named as W3's hero uses them: `greeting` = the `main h1`'s header row, `day` = the "Your day" section, `work` = the section holding the "Up next" list, and the six tiles in `[aria-label="How it's going"] > a` in order as `leads`, `revenue`, `pipeline`, `calendar`, `team`, `replies`) |
| today-rep | seller | /today | — |
| me | seller | /analytics | the "My numbers" tab |
| team | owner | /analytics?tab=team | — |
| overview | owner | /analytics | — |
| caught-no-touch | owner | /today | the Overdue tab (shows "No contact for 3 days") |
| caught-needs-you | owner | /today | click "Needs you" |
| caught-source | owner | /analytics?tab=sources | scroll the Webinars row/insight into view |
| caught-goal | seller | /analytics | goal pace card in view |
| leads | owner | /leads | Columns → hide Phone |
| action-whatsapp | owner | /leads | open first row, press `w` |
| action-call | owner | /leads | open first row, press `c` |
| action-follow-up | owner | /leads | open first row, press `f` |
| action-won | owner | /leads | open first row, click Won, choose package, fill value — popover open, not saved |
| action-bulk | owner | /leads | select all that match, open Assign, pick a person — confirm button showing, not clicked |
| action-queue | owner | /leads | select 50, Message, choose a template — the run's first card, not sent |
| pipeline | owner | /pipeline | — |
| action-search | owner | /leads | Ctrl+K, type "an" |
| action-drill | owner | /analytics | click the "Won" tile number — drill sheet open |
| security | owner | /settings/security | — |
| trace | owner | /settings/security/exports | — |
| calendar | owner | /calendar | — |
| today (phone) | owner | /today | phone; rects as above |
| leads (phone) | owner | /leads | phone |
| drawer (phone) | owner | /leads | phone, first row |

Story rules checked before the run shoots anything (fail the test with the list if any break):

```ts
const STORY: StoryRule[] = [
  { what: "Today shows overdue, due-soon and done work", check: async (p) => (await p.getByRole("list", { name: "Up next" }).getByRole("listitem").count()) >= 5 },
  { what: "Today's month tile is up on the same days of last month", check: async (p) => (await p.locator('[aria-label^="Revenue"]').getAttribute("aria-label"))?.includes("up") ?? false },
  { what: "Analytics' headline reads as a good month", check: async (p) => !/harder|fewer|down/i.test(await p.getByRole("heading", { level: 2 }).first().innerText()) },
  { what: "at least 8 of Analytics' tiles improved", check: async (p) => (await p.locator('[data-trend="good"]').count()) >= 8 },
];
```

Before relying on `data-trend` or the aria wording, read `apps/web/src/components/analytics/Overview.tsx` and `today/Tiles.tsx` for the attributes they actually render and use those (add a `data-trend={good ? "good" : "bad"}` attribute to the Overview tile if none exists — one line, with a test in Overview.test).

- [ ] **Step 1: Write the run**

```ts
import { writeFileSync } from "node:fs";
import pg from "pg";
import type { Page } from "@playwright/test";
import { roleUrl } from "@lume/db";
import { seedDemoBusiness } from "../../../api/src/demo/seed";
import { seedLiveDay } from "../../../api/src/demo/live-day";
import { openApp, PEOPLE, stateFile, test } from "../fixtures";
import { settle } from "../settle";
import { checkStory, rectsOf, toWebp, type StoryRule } from "./capture";

/**
 * The website's captures (spec §6): the demo business doing well, a working morning at 10:45, every screen and
 * action state the site shows, both themes, desktop at 2× and phone. On request only:
 * LUME_REVIEW=1 playwright test --project site-captures. Output in e2e/__site__/, handed to the website repo.
 */
const OUT = "e2e/__site__";
const AT = new Date(); // replaced below by today's 10:45 in Kolkata
```

(the full file: the seeding block below, the SHOTS table above as code in the `design-review` style — `{ name, as: "owner" | "seller", path, phone?, then?, rects? }` — the story check on `/today` and `/analytics` before the loop, and per shot: `openApp`, `networkidle`, `then`, wait for `[aria-busy="true"]` to be gone, `settle`, `page.screenshot({ animations: "disabled" })` → `toWebp`, rects → JSON, manifest at the end.)

Seeding block:

```ts
test.describe("site captures", () => {
  test.setTimeout(3_600_000);
  test("every screen the website shows", async ({ browser }) => {
    const pool = new pg.Pool({ connectionString: roleUrl("lume_owner", "lume_e2e") });
    const now = kolkata1045();
    try {
      await pool.query("UPDATE settings SET timezone = 'Asia/Kolkata', currency = 'INR', business_name = 'Brightpath Studio' WHERE id = 1");
      await pool.query("UPDATE users SET timezone = NULL WHERE email = ANY($1)", [[PEOPLE.owner.email, PEOPLE.seller.email]]);
      await seedDemoBusiness(pool, { now, seed: 7, demoMode: true, trajectory: "growing" });
      const ids = await pool.query<{ id: string; email: string }>("SELECT id, email FROM users WHERE email = ANY($1)", [[PEOPLE.owner.email, PEOPLE.seller.email]]);
      const id = (e: string) => ids.rows.find((r) => r.email === e)!.id;
      await seedLiveDay(pool, { now, people: [{ userId: id(PEOPLE.owner.email), scope: "all" }, { userId: id(PEOPLE.seller.email), scope: "own" }] });
    } finally {
      await pool.end();
    }
    // … the browser contexts use `now` through the API's clock (see Step 2) …
  });
});

/** Today at 10:45 in Kolkata (the captures' moment). */
function kolkata1045(): Date {
  const d = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  return new Date(`${d}T10:45:00+05:30`);
}
```

- [ ] **Step 2: The clock.** The e2e API runs on the real clock. Run the capture between 10:30 and 11:00 IST, or — preferred — start the e2e API with the clock override the e2e server already supports (check `apps/web/e2e/api-server.mjs` for a `LUME_TEST_NOW`/clock variable; if none exists, add `LUME_FAKE_NOW` read by the API's `d.clock` only when `NODE_ENV=test`, with a test in apps/api proving production ignores it). Record which was used as a ruling. The browser's clock: `page.clock.setFixedTime(now)` per context so "just now" and greetings agree.

- [ ] **Step 3: Run it**

Run: `bash scripts/dev.sh run bash -c "cd apps/web && LUME_REVIEW=1 pnpm exec playwright test --project site-captures --reporter=line"`, then fetch `apps/web/e2e/__site__/` (`ssh lumedev "cd /root/lume-dev/src/apps/web/e2e/__site__ && tar cf - ." | tar xf - -C apps/web/e2e/__site__`).
Expected: passes; the manifest lists every shot × 2 themes; no story rule broken.

- [ ] **Step 4: Look at every capture** (Read each WebP). Each must show work in progress, positive trends, and every problem beside its fix; no skeletons, no empty states, no Phone column, ₹ everywhere. Fix and rerun until true; list the rerun reasons in the ledger.

- [ ] **Step 5: Commit** (the run, the config, `.gitignore`; captures are not committed to the LUME repo)

```bash
git add apps/web/e2e/site apps/web/playwright.config.ts apps/web/.gitignore
git commit -m "feat(site): the website's captures — a good month, a working morning, every action, both themes and phone"
```

### Task 5: Hand the captures to the website

**Files:** none in the LUME repo; the website repo's `public/screens/` (W3 Task 2 consumes them).

- [ ] Copy `apps/web/e2e/__site__/*` to `lume-landing-page-/public/screens/` (W3 owns the commit). Sizes: each desktop WebP ≤ 260 KB, phone ≤ 120 KB; if larger, lower quality to 80 for that file only and note it.
