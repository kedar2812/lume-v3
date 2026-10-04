# Phase 8D: Analytics to the canvas (design)

**Status:** written 2026-10-04 for the owner's review. It adds to `2026-10-04-phase-8-analytics-design.md` (the Phase 8 spec), whose definitions (§4), rollups (§5) and detectors (§6) stand. This document covers what 8C left short of the approved canvas (https://claude.ai/artifact/6X1u5VivMqy438qemCsPRH), and how we prove it's right.

**The owner (2026-10-04):** "analytics are a key selling point it has to be perfect". On the three screens the canvas doesn't draw, they chose the recommended path: artboards for approval first, built after approval, with everything else going ahead meanwhile.

## 1. Where 8C stands (the audit, 2026-10-04)

- **The engine (8A/8B) is sound:**
  - one definition per metric;
  - rollups under 300 ms at 1,000,000 leads;
  - a 400-lead reference fixture that every tile matches;
  - drill tokens;
  - 14 detectors with tests;
  - goals with pace;
  - the weekly email.
- **The screens are a first pass:**
  - Overview: close to the canvas, but its chart ticks are uneven (10, 8, 5, 3), sparklines break on short series, the headline over-claims on thin data ("A steady month" for 8 leads), the funnel's first row is hatched while showing 100%, and the Average deal tile breaks the row's baseline.
  - The six other boards: each a table or two, where the canvas has three to five cards.
  - The rep's view isn't built.
- **Missing everywhere:**
  - the Filters button and panel;
  - Custom range;
  - the Compare switch;
  - aggregate Export CSV;
  - odometers;
  - chart hover;
  - the drill sheet's "Open these N in Leads" and Export CSV.
- **No realistic data to judge the design with.** The e2e run has 8 leads, and the fixture is deliberately patterned. A board can look right empty and wrong full.

## 2. What "perfect" means here (acceptance)

1. **Every board matches its canvas board**, card for card. Wording differs only where the engine words it more honestly (Phase 8 spec §8), and each such difference is listed in the ledger.
2. **Every number is proven:**
   - each new metric has a reference calculation in the fixture, and the engine matches it for an admin and a rep;
   - every drill opens exactly as many leads as its number;
   - the 1M gate stays under 300 ms for every new module.
3. **Every board is reviewed full and empty, in Porcelain and Obsidian,** at 1440 × 900 and 1366 × 800, with the demo business (§3) and with a fresh install. Each screenshot is looked at; a design flaw is a finding like a bug.
4. **Accessibility:**
   - axe finds no violations;
   - every chart has a text equivalent (a table or a described summary) and keyboard focus;
   - reduced motion turns odometers, morphs and rings into fades.
5. **Honest when thin:** a fresh install and a 20-lead business read as calm and true ("Early days"), never as fake trends.
6. **A fresh opus reviewer** at the end of each plan, and one fix pass.

## 3. A realistic demo business (the seed)

**What:** `apps/api/src/demo/seed.ts`, `seedDemoBusiness(db, { now, seed, months })`.

It writes a made-up business called "Brightpath Studio":
- 8 people in 2 teams;
- 5 sources (Instagram, Website, Referrals, Webinars, Walk-in);
- 6 stages;
- 3 products;
- about 3,000 leads over 6 months, ending at `now`.

**How it behaves:**
- **Deterministic:** a seeded random-number generator, so screenshots are stable.
- **Natural rhythms:**
  - a weekly cycle with quiet Sundays;
  - an evening arrival peak;
  - steady growth;
  - one slow month;
  - per-person differences, including one person whose follow-ups slip on Mondays;
  - one source that punches above its weight, and one that costs more than it returns;
  - a few win-backs.

  These are there so the detectors have something real to find.
- **Realistic records:** contacts, replies, stage moves, meetings with outcomes, follow-ups on time and late, losses with reasons, goals, source spend and template sends. All of it goes through the same tables LUME's own writers use. The rollups are then computed for every day.

**Fictional only:**
- names come from a small generic list;
- emails use `@example.com`;
- phones use reserved fictional ranges;
- no client data, ever (the CLAUDE.md rules).

**Where it runs:**
- **The e2e review project** `analytics-review`: it seeds the e2e database, then screenshots every board, the drill sheet, hover states and the rep view, in both themes, into `e2e/__review__/analytics-full`. These are review copies, not baselines; the existing empty-state baselines stay.
- **Later, demo mode** (`LUME_DEMO_MODE`, memory `lume-demo-plan`): the same function seeds demo.lumecrm.in nightly.
- **Refusal:** the CLI refuses a database that has any lead, unless demo mode is on. A client's data can never be mixed with it.

## 4. Engine additions (API)

Every addition reads rollups where it can, follows the viewer's scope and revenue permission (Phase 8 spec §4.1), and has a fixture reference, drill tokens and a 1M timing. Module routes follow `GET /api/v1/analytics/:module`.

**Funnel module** (extends `funnel`):
- `split=source|owner`: the cohort funnel per group, top 5 plus "Everyone else".
- **In each stage now:** open leads per open stage, their value, their average age in the stage. This is a snapshot, independent of the range.
- **Time in stage:** every open stage is listed, not only those with exits in the range. Each gets the median, P75 and the stage's allowed time (`sla_hours`), plus a stuck count. A stage with fewer than 5 exits shows "too few".
- **Velocity** (§4 `velocity`): its four parts, the result, and its trend.
- **Forecast by expected month** (§4.2): the next 3 months plus "later", split by stage group (the two latest open stages by name, and "Earlier stages").

**Revenue module** (new, `analytics.revenue` only):
- **This month:** revenue won by day, cumulative; the goal line; and "at this pace" for the month's end, labelled an estimate.
- **By month:** the last 12 months, against goals where set.
- **By product:** deals, revenue and share. A "won without a product" row shows when any exist.
- **One fact line** when it holds: the top product's share of deals beside its share of revenue. It's a fact, not a suggestion, so it needs no test.

**Sources:** stays as built, plus `kind` (manual, sheet, Calendly, webhook…) for the source chip. "Add spend" links to Settings → Sources spend.

**Lost module** (extends `lost`):
- **Reason × source matrix:** counts, with a cell under 3 drawn hatched.
- **The stage they left at:** from history; this already exists, now exposed per stage.
- **Won back flow:** lost in range → reopened → won, with revenue recovered and its trend.
- **What converts** (`segment`): win rate by each value of a chosen select, multi-select or boolean custom field. The cohort is read live; a range over 92 days is refused with "Narrow the range to use that field". A group under 10 leads shows "too few".

**Team** (extends `team`):
- the leaderboard by Won, Revenue (with permission), Speed, On time or Replies, with each person's previous rank, so the row can show its move;
- follow-up discipline: overall on time, overdue now, and the same per person;
- the "Each person" table: assigned, contacted, median speed, within 1 h, reply rate, held, won, revenue, and goal progress.

**Timing** (extends `timing`):
- **Heatmaps:** 7 days × 15 hours, 07:00 to 21:59 business time. Outside that window goes into one "Before 7 / after 10" strip, so nothing is hidden. The best cell is marked only when its n meets the minimum (Phase 8 spec §4: 10 sends, 5 booked).
- **Meetings:**
  - KPIs: booked, held, held rate, no-show rate, cancelled;
  - an outcome flow: booked → held / no-show / cancelled / rescheduled / still upcoming;
  - per person: held, no-shows, cancelled.

**Quality** (extends `quality`):
- readable phone share;
- needs country, can't be read and duplicates merged, each with a link to the Leads view that fixes it;
- unowned leads by wait (under 1 h, 1–24 h, 1–7 days, over 7 days);
- imports per source with rejected rows.

**The rep's view:** `GET /analytics/me`, own scope only:
- the hero: goals as rings, if set;
- own KPIs (revenue only with `analytics.revenue`);
- follow-ups due now and next;
- own funnel;
- best reply days by weekday.

The business's win rate shows beside the rep's own as one aggregate number, only when the business has 50 or more cohort leads. It names nobody.

**Filters** (all modules):
- `pipeline`, `owner`, `team`, `source` read rollups.
- `tag` and `field:<id>=<value>` switch the request to live queries, bounded to 92 days, as Phase 8 spec §5.2 says. This needs one live path per module that has a tag-and-field form; modules without one say "This board can't be filtered by tags yet" rather than ignore the filter.

**Export:**
- `GET /analytics/:module.csv`, with `leads.export`: the module's numbers only, never contact details. It goes through the 6B export watch, so it's counted and audited like any export.
- The drill sheet's Export CSV uses the existing leads export with the drill's filter.

**Open in Leads:** `/leads?drill=<token>` shows the drill's leads in the Leads list, with a "From Analytics: {title} · {range}" banner and Clear. It goes through the same row-level security and masking.

**The two unfed detectors:**
- `slot_noshow`: rollup kind `no_show` is added to `analytics_daily_slot` (by the meeting's start slot), in migration 0056.
- `evening_arrivals`: arrivals by slot, joined with the business's working hours (`DEFAULT_WORKING_HOURS` / settings). The next-morning sentence appears only with `speed_pays`-level evidence.

## 5. The shared controls (web)

**The analytics bar**, the same on every board:
- **Tabs** (the rep sees My numbers / My funnel / My timing).
- **The range button.** Its popover has the presets, Custom… with a month calendar ("Times in {timezone}"), and the Compare switch. The state lives in the URL, so a link opens the same view.
- **Filters:** a count badge, and a panel to the Filters artboard (§7).
- **Export:** shown with `leads.export`.

**Numbers:**
- **Odometers:** digits roll to the new value with a spring.
- **Format:** money in the business currency, with its grouping and short forms (₹ L / Cr; K / M elsewhere).
- **Trend:** the trend rule chip exactly as built.

**Charts:**
- "Nice" ticks (steps of 1, 2 or 5 × 10ⁿ, top tick at or above the maximum).
- A sparkline only with 3 or more points. A series with fewer than 7 days of data shows bars, not an area.
- Hover with a tooltip ("Click to see these leads"); a click opens the drill.
- A range change morphs the shapes, rather than redrawing them.
- The keyboard moves through points; each chart has a visually hidden table.

**Cards:**
- loading with the shared skeleton sweep;
- "too few to say" as hatching with a tooltip;
- an empty state that says what would fill it.

**The headline:** chosen from a fixed table of conditions in `@lume/core` (shared with the weekly email). Under 30 new leads in the range it reads "Early days" with a plain subline; otherwise it's from the won and new-leads trends ("A strong month", "A steady month", "A slower month"). The table is tested.

**The drill sheet:**
- the footer has Open these {n} in Leads, Export CSV (with permission) and "Only what you're allowed to see";
- rows open the lead drawer.

**Motion** follows the apple-design skill: spring timing, interruptible, reduced motion respected.

## 6. The boards (to the canvas)

Each board is built to its canvas artboard, card for card:

- **Overview (Main):** the fixes in §1, odometers, the morphing source bands with a dashed compare line and hover, the funnel with drop ribbons, Needs a look, LUME noticed, and the goals ring.
- **Funnel:**
  - the ribbon, with Split by: Nothing / Source / Owner;
  - In each stage now;
  - Time in each stage (median mark, P75 bar, allowed-time tick);
  - Pipeline velocity as a sum;
  - Forecast by month.
- **Team:**
  - the leaderboard, whose rows slide to their new place when the metric changes;
  - Follow-up discipline (a ring, plus a row per person);
  - LUME noticed for the team detectors;
  - the sortable Each person table, with goals.
- **Revenue & sources:**
  - This month / By month, with the goal and pace line;
  - By package (a donut), with the fact line;
  - the Sources table with spend, cost per lead, revenue per unit spent, and "Add spend".
- **Lost:**
  - the reasons donut;
  - reasons by source (a heatmap);
  - the stage they left at;
  - LUME noticed;
  - the won-back flow;
  - What converts, grouped by any field.
- **Timing & meetings:**
  - the heatmap switch (Replies / Arrivals / Bookings) with the best slot pulsing;
  - LUME noticed;
  - meetings KPIs, the outcome flow, and per person.
- **Templates & data:**
  - templates with the logging caveat;
  - Numbers LUME can read (with Fix / See);
  - Duplicates merged;
  - Nobody yet, by how long;
  - Imports and sources.
- **Rep (My numbers / My funnel / My timing):**
  - the hero with goal rings;
  - own KPIs;
  - Your follow-ups;
  - Your funnel, beside the business's win rate;
  - When your leads reply;
  - the rep's own insights.

  My funnel and My timing are the Funnel and Timing boards in own scope.

## 7. Screens the canvas doesn't draw (artboards first)

Four artboards are added to the Phase 8 canvas, built only after the owner approves them:

1. **Settings → Goals:**
   - goals for the business, teams and people, by metric and month or quarter;
   - a live preview ring;
   - pace shown as it will appear;
   - "a rep sees their own".
2. **Settings → Sources spend:**
   - each source with its monthly spend, in the business currency;
   - what it did last month (leads, cost per lead), so the number means something as it's typed.
3. **Log a call** in the lead drawer: talked / no answer / left a message, an optional note, and an optional follow-up. It counts as first contact.
4. **The Filters panel:** pipeline, owner or team, source, tags and custom fields. It shows which filters are read live, with the 92-day limit said plainly.

## 8. Plans

**8D-1: the seed and the engine.**
- §3, and the §4 additions with their fixture references;
- migration 0056;
- the filters' live paths;
- the 1M gate;
- a fresh reviewer, then a fix pass.

**8D-2: the shared controls and the boards.**
- §5 and §6, with the `analytics-review` e2e project;
- every screenshot reviewed in both themes;
- a fresh reviewer, then a fix pass.

**8D-3: the four artboard screens** (§7), after approval.
- Then the Phase 8 close: ledgers closed, and a summary for the owner with every ruling.

8D-1 and 8D-2 can overlap. Each board is built when its engine part lands. The artboards are drawn first, while 8D-1 starts.

## 9. Out of scope

- Tag analytics beyond filtering: tag as a "What converts" grouping waits.
- Custom dashboards and saved analytics views.
- Scheduled exports.
- Demo mode itself (sign-in buttons, nightly reset). It only reuses §3's seed.
