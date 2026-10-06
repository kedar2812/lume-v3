# Today — control centre: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkboxes.

**Goal:** rebuild Today as the approved control centre (canvas P7w9C2GFBNVvdn3ANBLt9N, v3). Every number on it is true and has a reason to be there.

**Architecture:**
- A new `GET /api/v1/today/tiles` reads every tile at the viewer's reach. It uses rollups, lead_counts_now and indexed live reads.
- `/today` gains the done-today follow-ups and the age of the oldest unassigned lead.
- The web Today becomes four parts: a header (LUME speaks), Your day, Up next, and six tiles. Pure helpers (the sentence, the day line, the hour buckets) are unit-tested.

**Tech:** Fastify + drizzle sql (apps/api), Next.js + CSS modules + motion/react (apps/web).

**Spec:** docs/superpowers/specs/2026-10-05-today-control-centre-design.md. The spec is binding: every number's definition comes from its tile table.

## Global constraints

- Every number matches its definition in the spec and its counterpart elsewhere in LUME. Nothing is shown that the spec doesn't define.
- Copy speaks as LUME. People are named, never gendered. Dates follow the house style ("October 5, Monday").
- No client names. No stage names in code. Integrations are optional.
- Obsidian and Porcelain both flawless. One accent blue, #2A5BFF. Reduced motion respected. Every data area has skeletons and the loading bar.
- Volatile numbers are marked `data-volatile`.
- Scale: the tiles read stays within Today's budget at 1M leads (scale.test.ts).

## Review focus

1. A viewer with own scope sees only their own leads, calls and tasks in every tile, never the business's.
2. A business with one day of data shows no "usual" bars, no misleading comparison, and no goal bar without a goal.
3. A day with leads dated today but imported at another hour: the bars still add up to the big number.
4. Snoozed and repeating follow-ups don't break the streak's definition.
5. Time zones: the user's zone for their day and calls; the business zone for arrivals (as in Analytics).

---

### Task 1: the tiles API

**Files:**
- Create: `apps/api/src/modules/today/tiles.ts`, `tiles.test.ts`
- Modify: `apps/api/src/modules/tasks/routes.ts` (route), the probes list if routes are enumerated

**Produces:** `GET /api/v1/today/tiles` →
```ts
{
  leads?: { today: number; lastWeek: number; hours: number[24]; usual: number[24] | null; reached: number; medianMinutes: number | null };
  month?: { label: string; money: boolean; value: number; previous: number; vsLabel: string;
            goal: { target: number; value: number; elapsed: number; pace: number | null; daysLeft: number; scope: string } | null };
  pipeline?: { name: string; many: boolean; open: number; stages: { id: string; name: string; kind: string; n: number }[]; wonThisMonth: number; forecast: number | null };
  calendar: { today: number; held: number; week: number[7]; weekStart: string; connected: boolean };
  team?: { overdue: number; people: { id: string; name: string; n: number }[]; onTime: number | null };
  streak?: { days: number; best: number; dueToday: number; doneToday: number; last7: ("ok" | "missed")[] };
  replies?: { rate: number | null; previous: number | null; series: (number | null)[]; best: { name: string; rate: number } | null };
}
```

Tests (TDD, one `it` per spec rule):
- [ ] Leads:
  - arrivals today by the Analytics definition (enquiry date, else entered today, business time zone);
  - the hours add up to `today`, and a dated lead imported at 23:00 the day before falls in bucket 0;
  - `lastWeek` counts only leads in by this time last week;
  - `usual` is null with fewer than 2 past weekdays of data, otherwise the average of the last 4;
  - own scope sees only own leads;
  - `reached` and the median come from lead_firsts.
- [ ] Month:
  - revenue for analytics.revenue, deals won otherwise;
  - compared with the same days of last month;
  - the goal is picked as own → team → business (business only for reach all);
  - no goal gives null.
- [ ] Pipeline:
  - the default pipeline's stages in order, from lead_counts_now, within leads.view reach;
  - `many` when there is more than one pipeline;
  - forecast only with money and a win probability.
- [ ] Calendar:
  - own meetings, not cancelled or rescheduled;
  - the week runs Monday to Sunday in the user's time zone;
  - held means completed.
- [ ] Team or streak:
  - team only with reach team or all, and overdue within reach;
  - on-time is null under 10 tasks done;
  - streak: days with nothing due are skipped, a missed day ends it, and today joins once everything due today is done.
- [ ] Replies:
  - the glance's reply rate and its 7-day series;
  - the best template over 30 days, among those sent at least 10 times.
- [ ] Permissions: each tile is left out without its permission.

### Task 2: /today additions

- [ ] Add `doneToday` (the viewer's follow-ups done today, with dueAt) and `needsYou.unassignedOldest` (an ISO time or null; uses the leads_unowned index). Test both.

### Task 3: web helpers

**Files:** `apps/web/src/lib/today/{client.ts,types.ts,brief.ts,brief.test.ts,dayline.ts,dayline.test.ts}`

- [ ] `brief(view, now, tz)` returns the sentence parts, following the spec's four rules in order, with names only. Tested.
- [ ] `dayline(view, now, tz)` returns the span (8–21, widened to fit any item), positions and states. Tested.

### Task 4: Today, rebuilt

**Files:**
- Rewrite: `components/today/Today.tsx`, `today.module.css`
- Create: `TodayHeader.tsx`, `DayTile.tsx`, `WorkTile.tsx`, `NeedsYou.tsx`
- Delete: `TodayGlance.tsx` (moved into the tiles)

Keep every behaviour Today has now:
- tick done (with sound);
- the once-a-day all-clear celebration;
- WhatsApp send;
- snooze;
- logging a call's outcome;
- resuming the send queue.

Adapt Today.test.tsx and TodayCalls tests.

### Task 5: the tiles

**Files:** `components/today/Tiles.tsx`, `tiles.module.css`, `Tiles.test.tsx`

- [ ] One component per tile, each built to the spec table: its question, its number, its comparison, its empty state.
- [ ] Tests check that each number is the API's number, that each empty state reads as written, and that a tile isn't shown without its data.

### Task 6: finish

- [ ] Phone layout, both themes, reduced motion.
- [ ] e2e: update the Today specs and baselines, axe, and the design-review captures.
- [ ] Add the tiles read to scale.test.ts and check it at 1M leads.
- [ ] Lint, typecheck, all suites, e2e, commit, push, CI, deploy. Then show the owner the screenshots.
