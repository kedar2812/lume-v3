# Phase 8: Analytics (design)

**Status:** written 2026-10-04 overnight under the owner's authority ("make sure the analytics architecture and
logic … do justice to the app"). The canvas https://claude.ai/artifact/6X1u5VivMqy438qemCsPRH was approved
2026-10-03. The owner reviews this in the morning; build goes ahead on these definitions.

**Sources:** report §13 (Analytics) and §16.1 #7. The report calls this Phase 7; our Phase 7 became scale and bulk.

## 1. What it must do

Analytics answers, at a glance:
- Is the funnel healthy?
- Is the team following up?
- Where does revenue come from, and where are we losing it?

Every number:
1. has one written definition (this document, §4), used by its tile, its chart, its drill-down list and the weekly email alike;
2. opens the exact leads behind it, filtered by the viewer's access;
3. follows the viewer's scope (`analytics.view` own / team / all); revenue needs `analytics.revenue`;
4. is computed in the business's timezone (`settings.timezone`).

Every sentence LUME says about the numbers ("LUME noticed") comes from a written detector (§6). A detector has:
- a minimum amount of data;
- a statistical test;
- a minimum effect worth saying;
- its own hand-written sentences.

LUME never says a tip it can't back with the numbers shown. It never predicts with false certainty: every estimate says so ("at this pace", "expected").

## 2. Principles

- **One catalogue.** `packages/core/src/analytics/metrics.ts` declares each metric: id, words, basis, formula, unit, good direction (for the trend rule), the drill-down filter, and the permission. The API, the rollups, the drill-downs and the weekly email all read it. A test fails if a metric has no drill-down, no words, or no fixture expectation.
- **Two bases, said plainly.**
  - Cohort metrics follow the leads that arrived in the range: new leads, contacted, reply rate, the funnel, win rate, speed to lead, conversion by source or segment.
  - Event metrics count what happened in the range: won, revenue won, calls booked and held, lost, follow-ups due. The info tooltip on each says which.
- **Credit to who owned the lead when it happened.** Won and revenue go to the owner at the moment of winning (from `lead_assignment_history`), not to whoever owns it today. Cohort metrics go to the owner at arrival, or the first owner if the lead arrived unassigned.
- **The owner's trend rule, exactly** (memory `lume-licensing-parked`, 2026-09-29). It is `trend(now, before, { kind: pct|pts|abs, good: up|down })`:
  - decided on the rounded number shown;
  - zero shows as grey "No change";
  - a previous 0 shows as "New";
  - every change is signed (+ or −);
  - the arrow follows direction, the colour follows good or bad.

  It lives in `@lume/core` so the screens and the weekly email share it.
- **Honest when data is thin.**
  - A chart cell or group below its minimum sample is drawn hatched, as "too few to say".
  - A metric with no data says what would fill it ("No calls booked yet. Connect a calendar or Calendly to count them.").
  - Insights wait until a detector's minimum is met.
- **Fast at scale.** Dashboards read rollups (§5), refreshed every 10 minutes for today and yesterday and recomputed nightly for the last 7 days. Drill-downs read live tables. The budget is 300 ms for any dashboard request at 1,000,000 leads; it is measured in the scale test.

## 3. The data: what exists, what's added

**Exists (verified 2026-10-04):**
- `leads`: arrival (`lead_created_at`, else `created_at`), `owner_id`, `source_id`, `stage_id`, `value`, `product_id`, `won_at`, `lost_at`, `lost_reason_id`, `stage_entered_at`, `phone_status`, custom fields;
- `lead_stage_history`: every stage change, with who and when;
- `lead_assignment_history`: every owner change, with the reason;
- `activities`: `whatsapp_opened`, `whatsapp_confirmed_sent` (with template version), `whatsapp_not_sent`, `reply_logged`, `meeting_booked`, `follow_up_set`/`done`/`changed`/`cancelled`, `stage_changed`, `reopened`, `assigned`, `contact_revealed`, `automation`;
- `tasks`: `due_at`, `done_at`, status, assignee;
- `meetings`: status `scheduled`, `completed`, `no_show`, `cancelled`, `rescheduled`, plus start, owner and source;
- `stages`: `kind`, `win_probability`, `sla_hours`;
- `lead_sources`, `message_templates`/`template_versions`, `lost_reasons`, `products`, `audit_log`, `imports`.

**Added in 8A:**
- **`leads.first_contact_at`, `leads.first_reply_at`**, kept by a trigger on `activities` insert. First contact is the first `whatsapp_opened`, `call_logged` or `meeting_booked`; first reply is the first `reply_logged`. Both are backfilled. Cohort contact and reply metrics become indexed column reads, not activity scans.
- **`call_logged` activity:** "Log a call" on the lead drawer (outcome: talked, no answer, left a message). A phone call counts as first contact.
- **`lead_sources.monthly_spend`** (numeric, nullable, business currency), set in Settings → Sources. Spend is prorated by days to the range.
- **`goals`:**
  - `id`, `scope` (user | team | business), `scope_id`, `metric` (won | revenue | calls_held | new_leads | ontime), `period` (month | quarter), `period_start`, `target`;
  - unique on (scope, scope_id, metric, period, period_start);
  - set by admins in Settings → Goals; a rep sees their own.
- **Rollup tables** (§5), and `analytics_insight_seen` (cooldowns, §6.4).

## 4. The metric catalogue

The range P runs from its start to its end in business time. The compare period is the same length, immediately before. "Arrived" means the arrival time. Leads that are deleted are excluded from every number and every drill-down.

| Id | Words | Basis | Definition | Unit / good | Drill-down |
|---|---|---|---|---|---|
| `new_leads` | New leads | cohort | leads that arrived in P | count / up | those leads |
| `contacted` | Contacted | cohort | share of new leads with `first_contact_at` set (as of now) | pct (pts) / up | contacted ones |
| `reply_rate` | Reply rate | cohort | of new leads contacted, share with `first_reply_at` set | pct (pts) / up | replied ones |
| `speed_to_lead` | Speed to lead (median) | cohort | median of `first_contact_at − max(arrival, first assignment)` over contacted new leads; "within 1 h" and "within 24 h" shares alongside; not-yet-contacted counted apart | duration / down | slowest first |
| `calls_booked` | Calls booked | event | meetings with a lead whose row was created in P (each external meeting counted once; a reschedule isn't a new booking) | count / up | their leads |
| `calls_held` | Calls held | event | meetings that started in P with status `completed` | count / up | " |
| `no_show_rate` | No-show rate | event | `no_show` ÷ (completed + no_show), meetings that started in P | pct / down | no-shows |
| `won` | Won | event | leads with `won_at` in P | count / up | those leads |
| `win_rate` | Win rate | cohort | of new leads, share won so far | pct (pts) / up | won ones |
| `revenue_won` | Revenue won | event | Σ value of leads won in P; leads won with no value counted apart ("12 won without a value") | money / up | won, by value |
| `avg_deal` | Average deal | event | revenue won ÷ won leads that have a value | money / up | " |
| `overdue_now` | Follow-ups overdue now | now | open tasks with `due_at` < now | count / down | the tasks' leads |
| `ontime` | Follow-ups on time | event | of tasks due in P now done or cancelled-by-move, share done at or before `due_at` (+5 min grace) | pct (pts) / up | late ones |
| `lateness` | Average lateness | event | mean (done − due) over late tasks due in P | duration / down | " |
| `forecast` | Pipeline forecast | now | Σ over open leads (stage kind open) of value × the stage's `win_probability`; by expected month (§4.2) | money / up | open leads by expected value |
| `cycle` | Days to win (median) | event | median of `won_at − arrival` over leads won in P | days / down | won, slowest first |
| `velocity` | Pipeline velocity | now | open leads × win rate (90-day closed cohort) × avg deal (90 d) ÷ median cycle (90 d), per day | money / up | — |
| `funnel` | The funnel | cohort | for each stage in pipeline order (open stages, then won), the share of new leads that ever reached it or a later stage (`lead_stage_history`, so skipped stages count) | pct | leads that stopped there |
| `time_in_stage` | Time in stage | event | for stays that ended in P, the median and P75 of exit − enter, per stage; stuck = open leads whose current stay exceeds the stage's `sla_hours` | duration | stuck leads |
| `lost` | Lost | event | leads with `lost_at` in P, by reason, by the stage they left (the stage before lost in history), by owner, by source | count | " |
| `won_back` | Won back | event | leads reopened in P (`reopened` activity) after being lost, then won in P; their revenue | count, money | " |
| `source_*` | Sources | cohort + event | leads that arrived per source; conversion (cohort win rate); revenue won from that source's leads (event); spend prorated; cost per lead = spend ÷ leads; revenue per ₹1 = revenue ÷ spend | mixed | per source |
| `segment` | What converts | cohort | win rate by the value of a chosen select, multi-select or boolean custom field | pct | per value |
| `heat_arrivals` | When leads arrive | cohort | new leads by day of week × hour (business tz) | count | that slot |
| `heat_replies` | When leads reply | event | of messages confirmed sent in P, the share with a `reply_logged` within 72 h, by the send's day × hour; a cell under 10 sends is "too few" | pct | " |
| `heat_slots` | Best booking slots | event | calls held ÷ booked by the meeting's start slot; a cell under 5 is "too few" | pct | " |
| `template_*` | Templates | event | per template: sends confirmed in P; replies (a `reply_logged` within 72 h, before the next send to that lead); reply rate; wins attributed (won within 30 days after a send, credited to the last template sent before the win) | mixed | per template |
| `quality_*` | Data quality | now | phone `needs_country` and `invalid` counts; duplicates merged in P; import rows rejected in P per source; leads without an owner, by how long they've waited | count | each list |
| `goal_progress` | Goals | event | value of the goal's metric over the goal's period ÷ target; pace = value ÷ elapsed share of the period, labelled "at this pace" | pct | the metric's drill-down |

### 4.1 Scope and permissions
- **own:** facts credited to the viewer.
- **team:** to the viewer and their team.
- **all:** everything.
- The leaderboard and the "Each person" table show only with team or all.
- Revenue fields (`revenue_won`, `avg_deal`, `forecast`, `velocity`, source revenue, template wins' value) are absent without `analytics.revenue`; the tiles reflow.
- Drill-downs run through the leads list with row-level security and masking, so a drill-down never shows more than the Leads screen would.

### 4.2 Expected month (forecast)
For each open stage, the median days from entering that stage to winning, over leads won in the last 180 days. A lead's expected win date is its `stage_entered_at` plus that median, or today when that date has already passed.

With fewer than 10 wins through a stage, the pipeline's median cycle minus the median days already spent before that stage is used. The chart's legend says "Expected, from how long wins have taken".

### 4.3 Compare and the trend rule
Each tile shows `trend(current, previous)` with its kind and good direction from the catalogue. Compare off hides the chips.

The previous period for "This month (October 1 – 3)" is September 1 – 3, the same days, not all of September.

## 5. Architecture

### 5.1 Rollups (migration 0053)

Rollups are written by the API's own queue (pg-boss, as imports are), every 10 minutes for today and yesterday, and nightly at 02:30 business time for the last 7 days. Recomputing a day is idempotent: delete the day, then insert it again. They are kept in business-timezone days.

- **`analytics_daily_cohort`:**
  - keyed by (day, credited user or null, source, pipeline);
  - holds arrived, contacted, replied, won_so_far, contact_minutes_sum, contacted_within_1h, contacted_within_24h, and a speed histogram (12 log-spaced buckets, so the median and P75 can be read from rollups).

  Cohort days older than 7 are refreshed weekly; contacts and wins that come later move them.
- **`analytics_daily_event`:** keyed by (day, credited user, source, pipeline); holds won, won_value, won_no_value, lost, booked, held, no_show, cancelled, tasks_due, tasks_on_time, late_minutes_sum, late_count, sends, replies72.
- **`analytics_daily_stage`:** keyed by (day, pipeline, stage); holds entered, exited, stay histogram, open_count, open_value.
- **`analytics_daily_slot`:** keyed by (day, kind arrivals|sends|replies|booked|held, dow, hour, credited user).

Every rollup has row-level security like `lead_counts` (0048): a row is seen when its credited user is visible to the viewer's scope (`lume_sees_owner`). A rep's analytics can't read past their scope, even by a crafted request.

### 5.2 The API (`/api/v1/analytics/...`, permission `analytics.view`)

- `GET /analytics/:module?from&to&compare=1&filters…&groupBy=` returns `{ tiles, series, totals, previousTotals, groups, drill }`. The modules are overview, funnel, team, revenue, sources, lost, segments, timing, meetings, templates and quality.
  - Filters: pipeline, owner, team, source, tag, and any select, multi-select or boolean custom field.
  - Filters that rollups don't carry (a tag, a custom field) switch that request to live queries. Those requests are bounded: ranges up to 92 days live, larger ranges refused with "Narrow the range to use that filter".
- `drill` holds signed tokens: HMAC over the exact filter, the scope and an expiry of 15 minutes. `GET /analytics/drilldown/:token?cursor` returns the leads, through the leads list (row-level security and masking).
- `GET /analytics/insights?from&to` returns up to 3 insights (§6).
- `GET/PUT /settings/goals`, plus `PUT /settings/sources/:id/spend`.
- CSV export of an aggregate (with `leads.export`) gives the numbers only, never contact details.

### 5.3 The weekly email (§13.8)
On Mondays at 09:00 business time, to users with `analytics.view` at 'all' who haven't switched it off:
- last week's tiles, against the week before, using the same trend rule as text (for example "Won 44 (+19%)");
- the top person by wins;
- the biggest drop-off stage;
- overdue follow-ups;
- the top insight, if any.

It carries aggregates only, never contact details. It goes out through the existing mailer and digest scheduling.

## 6. The insight engine ("LUME noticed")

### 6.1 How a detector decides
Each detector is a pure function over rollup data: `(ctx) → Insight | null`. An `Insight` holds a detector id, a subject (a source, a person, a slot…), a magnitude, an impact score, its sentences, and a drill.

A detector speaks only when:
1. **There is enough data:** each compared group meets its minimum n (below).
2. **The difference is real:**
   - for proportions, a two-proportion z-test at p < 0.05, with a Wilson interval for small groups;
   - for medians, a Mann-Whitney check at p < 0.05.
3. **The difference is worth saying:** at least the detector's minimum effect (relative and absolute; both must hold).

Insights are ranked by impact: an estimate of extra wins, or revenue, if the gap closed. Ties go to the most recent change. At most three show, never two from the same detector.

### 6.2 The detectors and their words
Numbers are formatted as the tiles format them. Lists of names become "Dev's and Leo's" (two) or "Dev's, Leo's and one other's" (three or more). Each case's sentence is fixed text with slots.

| Detector | Minimum data | Test and effect | Title → body |
|---|---|---|---|
| `speed_pays` | ≥30 leads contacted within 1 h and ≥30 later, among new leads in the last 90 days that are 30+ days old | win rates differ, p<0.05; ratio ≥1.5 | **Speed pays off** → "Leads contacted within an hour were won {ratio} times as often. Your median first contact is {median}." When median > 1 h: "…is {median}, so most leads miss that hour." |
| `source_over` | source with ≥10 wins; ≥5% of leads | revenue share ≥1.5× its lead share | **{Source} punches above its weight** → "It brings {leadShare} of leads and {revShare} of revenue won." |
| `source_under` | source with ≥100 leads and spend set | its win rate below the rest, p<0.05; relative −40% | **{Source} costs more than it returns** → "{cpl} a lead, and its leads are won {a} of the time, against {b} for the rest." |
| `reply_window` | the 2-hour weekday window with ≥40 sends; the rest ≥200 | window rate above the rest, p<0.05; +10 pts | **{Day} {window} get the most replies** → "Messages sent then got an answer {a} of the time, against {b} at other times." |
| `followups_slip` | ≥50 tasks due in each period | on time fell, p<0.05; −8 pts; ≥10 overdue now | **Follow-ups are slipping** → "On time fell from {before} to {now}. {overdue} are overdue now{, most of them {names}}." |
| `rep_support` (team/all only) | person with ≥30 tasks due; team ≥100 | their on-time rate below the team's, p<0.05; −10 pts | **{Name} may need a hand with follow-ups** → "{Name}'s are on time {a} of the time, against {b} for the team." |
| `weekday_late` | person with ≥8 late tasks in P | ≥60% of late ones due on one weekday | **{Name}'s follow-ups slip on {Day}s** → "{k} of {pronoun-free: their} {m} late follow-ups were due on a {Day}." (written "{k} of {Name}'s {m} late follow-ups …") |
| `stage_drop` | stage reached by ≥50 new leads | its stop rate the highest, and above the previous period's, p<0.05 | **Most leads stop at {Stage}** → "{x} of leads that reached {Stage} went no further." |
| `lost_reason_up` | ≥20 lost in each period | the reason's share rose, p<0.05; +10 pts | **"{Reason}" is rising** → "It's behind {now} of leads lost, up from {before}." |
| `template_best` | template with ≥50 sends; others ≥150 | rate above the others, p<0.05; +10 pts | **"{Template}" gets the most replies** → "{a} of its messages got an answer, against {b} for your other messages." |
| `won_back` | ≥3 won back in P | a fact, no test | **LUME helped win back {n} lost leads** → "Worth {revenue}, from leads once marked lost." |
| `evening_arrivals` | ≥200 new leads | ≥30% arrive outside working hours; the next-morning contact effect shown only if speed_pays-style evidence holds | **{share} of leads arrive after hours** → "They come in after {time}." Plus, only with evidence: "Contacting them before {time2} the next morning wins more of them." |
| `goal_pace` | a goal set for this period; ≥20% of the period gone | an estimate, labelled | **At this pace, {Month} ends at {pct} of the {metric} goal** → "{value} so far, with {days} days to go." |
| `slot_noshow` | slot with ≥20 booked; the rest ≥80 | no-show rate above, p<0.05; +10 pts | **Calls on {Day} {window} are missed more often** → "{a} of them were no-shows, against {b} at other times." |

The rep's own view uses the same detectors over their own data. The rest are worded for one person: "Your Tuesdays are your best".

### 6.3 Not enough data
Before any detector can speak, the card says: "LUME needs a little more to go on. Suggestions start once there are about 200 leads and a month of follow-ups." It also shows a quiet progress line, "{n} of 200 leads".

### 6.4 Cooldown
The same detector and subject isn't shown to the same person again for 14 days unless its magnitude moved by 50% or more. `analytics_insight_seen` stores (user, detector, subject, magnitude, shown_at).

### 6.5 Tested like the numbers
Every detector has fixture tests:
- a case that must speak, with its exact sentence;
- a case just under each minimum (must stay quiet);
- a case with a large but insignificant gap (must stay quiet);
- the cooldown.

The statistics helpers (z-test, Wilson, Mann-Whitney, medians from histograms) are tested against known values.

## 7. Correctness: the fixture

`apps/api/test/fixtures/analytics.ts` builds a small, fully known business over 8 weeks:
- 6 people, 4 sources and 6 stages;
- about 400 leads with scripted arrivals, contacts, replies, stage moves, wins, losses, meetings and follow-ups;
- each event at a fixed time, in Asia/Kolkata.

A spreadsheet-style table in the test file lists the hand-computed answer for every metric, in both ranges, for an admin and for a rep. The engine must match them to the unit. More checks:
- every tile's drill-down returns exactly as many leads as the tile counts;
- a rep's numbers equal the admin's numbers filtered to that rep;
- rollups equal live computation for the same range (the nightly recompute's own check);
- timezone edges: a lead arriving at 23:30 IST belongs to that IST day;
- daylight-saving zones are tested with a UTC−5/−4 fixture copy.

## 8. Screens (8C)
Built to the canvas boards: Main (Overview), Funnel, Team, Revenue & sources, Lost, Timing & meetings, Templates & data, and the rep's view. Honest wording replaces the canvas's made-up examples wherever the engine words it differently. Each card shows loading (skeletons with the shared sweep), "too few to say" hatching, and its empty state.

## 9. Plans
- **8A: data and engine.**
  - Migrations 0051–0053: first contact and reply, call logged; spend and goals; rollups (0050 is the profile photo, built in 7C).
  - The metric catalogue in core, the rollup jobs, the analytics API with drill-down tokens, the fixture tests, and the scale gate.
- **8B: insights, goals and the weekly email.** The statistics helpers, the detectors, cooldowns, Settings → Goals and Sources spend, and the weekly email.
- **8C: the screens.**

Each plan: TDD, a fresh opus reviewer at the end, and one fix pass.
