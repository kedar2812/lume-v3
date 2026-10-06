# Today — the control centre (design)

Approved canvas: https://claude.ai/artifact/P7w9C2GFBNVvdn3ANBLt9N, v3. The owner approved it on 2026-10-05 ("okay perfect, go ahead and build this").

The owner's rule for this page (2026-10-05): "every kpi on the today page has a logical reason for showing what it shows, we dont want to throw around random info that does not hold any value or is not true".

Every number on Today therefore has five things written down here:
1. the question it answers;
2. exactly how it is counted;
3. what it is compared with, and why;
4. who sees it;
5. what shows instead when there isn't enough data.

A number that can't meet all five is not on the page. Each one also matches the number the same thing has elsewhere in LUME (Analytics, Calendar, Leads), because it is counted the same way.

## Layout

1. **Header.** The LUME mark, a greeting, and one sentence from LUME about where to start. On the right: the date, "Live", and (for anyone who can act on them) **Needs you**.
2. **A 4 × 3 grid of tiles.** Each tile is a link to its page.
   - Left half: **Your day** (2 × 1), then **Up next** (2 × 2).
   - Right half: six tiles in two columns. Each has an icon and label, one big number, one small picture, and one line.
   - Tiles the viewer may not see are left out. The rest close up in order.
3. **Phone (below 860 px).** One column: header, then Your day, Up next, and the tiles two to a row.

The mark (the logo file, unchanged):
- blooms in when Today opens;
- turns 60° for each follow-up ticked;
- spins while Today loads;
- twirls and bursts its petals when the day is all clear (the existing once-a-day celebration, with its sound).

## The header sentence

Built from the same data as Up next. The first rule that applies wins:
1. A call starts within 30 minutes: "Neha Joshi's call is in 20 minutes", then the first overdue follow-up or the next one.
2. Something is overdue: "Start with Kenji Sato, waiting since Saturday", then the next call.
3. Nothing is overdue: "Nothing overdue. Next up, X at 2:30 pm", then the next call.
4. Nothing is left: "All clear…"

People are named, never "he" or "she" (pronouns.test.ts). Times are in the viewer's time zone.

## Needs you (owner / admin)

A count, and a popover with one action per row. Each row shows only when it is true and the viewer can act on it.

| Row | Counted as | Shown to | Action |
|---|---|---|---|
| New leads with no one yet | Open-stage leads with no owner (lead_counts_now), plus how long ago the oldest arrived (leads_unowned index) | leads.view all + leads.assign | Assign (opens Leads filtered to Nobody) |
| A source needs attention | lead_sources.status = 'needs_attention' (existing) | settings.manage | Fix (opens that source) |
| Security alerts | Open security_alerts (existing) | security.manage | Review |
| Send queue paused | The viewer's own paused queue (existing ResumeRun) | messages.send_queue | Resume |

With nothing to show, the button reads "All good" with no count. It is never a fake zero.

## The tiles

**Your day**
- Question: what does my day look like, and what is next?
- Counted as:
  - the viewer's follow-ups due today (open, plus those done today) and older overdue ones, from /today;
  - the viewer's calls today that are not cancelled or rescheduled;
  - on one line from 8 am to 9 pm, stretched to any item outside those hours.
- Below the line: the next call (name, purpose, time, Join).
- Comparison: none. It is the plan.
- Shown to: everyone.
- Empty: "No calls left today" / "Nothing planned yet".

**Up next**
- Question: what should I do, in what order?
- Counted as: the existing /today list (overdue oldest first, then by time), calls included. Tabs: All, Overdue, Calls.
- The ring: follow-ups done today out of those due today (the existing done / total).
- Shown to: everyone.
- Empty: all clear (celebration plus tomorrow's first item), or day one (the setup checklist).

**Leads** ("Your leads" for someone who sees only their own)
- Question: are leads coming in as usual today?
- Counted as: leads arriving today, by the Analytics definition:
  - the enquiry date is today; or
  - there is no enquiry date and the lead entered LUME today;
  - in the business time zone;
  - within leads.view reach (row-level security).
- Hourly bars, 24 one-hour buckets: leads that arrived today, by the hour they entered LUME. The bars add up to the big number. A lead dated today but entered at another time goes in the first or last bucket.
- Comparison: "vs last Monday at this time". That is, leads that arrived on the same weekday last week and had entered LUME by this time of day.
  - Why: the same weekday removes the weekly rhythm, and "by this time" stops a half-finished day reading as a fall.
- Faint bars: the average for this weekday over the last four weeks. They show only when LUME has at least two of those weeks; otherwise there are no faint bars.
- Footer:
  - with leads.assign: "N with no one yet · Assign";
  - otherwise: "Reached N of them", from lead_firsts. With at least 3 reached, it adds "half within X min" (the median).
- Shown to: leads.view.

**October** (the one lit tile)
- Question: how much have we won this month, and are we on track?
- Counted as: the analytics.revenue holder sees revenue won month to date; anyone else sees deals won.
  - Rollups at analytics reach, the same as the Analytics tile (the glance rollup).
- Comparison: the same days of last month ("vs Sep 1–5").
  - Why: a part month against a whole month is false.
- Goal bar: shows only if a goal exists for the viewer's scope this month.
  - Which goal: revenue (or won) for the viewer's own user goal; else their team's; else the business goal when reach is all.
  - The bar is progress. The tick is where an even pace would be today (the elapsed share of the month).
  - Footer: "At this pace ₹X by October 31". This is listGoals' pace, an estimate worded as one.
- No goal: footer "No goal for October" plus "Set one" for settings.manage.
- Shown to: analytics.view.

**Pipeline** ("Your pipeline")
- Question: where do my open leads stand right now?
- Counted as: open leads in the default pipeline, by stage, from lead_counts_now (exact at every moment), within leads.view reach.
  - The bar shows the business's own stages in their order.
  - The keys are the last two open stages (closest to a decision) and Won this month. No stage name is ever hard-coded.
  - If there is more than one pipeline, the label names the pipeline.
- Footer: with money and at least one stage with a win probability, "₹X forecast" (forecastNow, the Analytics forecast). Otherwise "N open across all pipelines" when there are several, or nothing.
- Comparison: none. It is a snapshot.
- Shown to: leads.view.

**Calendar**
- Question: how busy are my calls today and this week?
- Counted as: the viewer's own meetings that are not cancelled or rescheduled.
  - Today's count matches Your day.
  - Seven columns, Monday to Sunday of this week in the viewer's time zone. Today's column is highlighted; past days are dimmed.
- Footer: "N held · M this week". Held means status completed.
- Shown to: everyone.
- Empty: footer "Connect Calendly or Google Calendar" when no calendar is connected; otherwise "No calls this week".

**Team** (analytics reach team or all)
- Question: whose follow-ups are slipping right now?
- Counted as: open follow-ups due before now, within reach (overdueNow, the Overview's own number). The top three people by count are listed with bars.
- Comparison: none. A past "overdue at this time yesterday" can't be counted truthfully, because snoozing changes a task's due time.
- Footer: "X% on time this month": tasks_on_time / tasks_done from the rollups, the same definition as the On time goal. It is left out until 10 tasks are done.

**On time** (instead of Team, for someone who sees only their own numbers)
- Question: am I keeping my promises day after day?
- Counted as: days in a row, back from yesterday, on which every follow-up due that day (viewer's, in their time zone) was done that same day.
  - Days with nothing due are skipped. They neither break nor extend the streak.
  - Today joins the streak once everything due today is done.
- Seven dots: the last seven days that had something due.
- Footer: "Finish today's N to make it M", or "M days, a new best" when today extends the longest streak in the last 60 days.
- Shown to: everyone without team reach.
- Empty: "Starts with your first follow-up".

**Replies**
- Question: are our messages getting answers?
- Counted as: the reply rate of leads that arrived in the last 7 days and were contacted (replied / contacted, rollups). This is the Overview's "Reply rate", with the sparkline of its daily values.
- Comparison: the 7 days before, in percentage points.
- Footer: the best template of the last 30 days among those sent at least 10 times, and its reply rate within 72 hours (the Templates board's definition). Nothing if none qualifies.
- Shown to: analytics.view.

## Freshness

- Up next and Your day refresh on the live stream (as now).
- The tiles refresh every 60 seconds and on any stream event, at most once every 15 seconds.
- "Live" therefore means within a minute. It is left out if the stream is down.
- Every number is marked data-volatile for screenshots.

## API

`GET /api/v1/today/tiles` reads every tile in one call: leads, month, pipeline, calendar, team or streak, replies. It:
- checks each tile's permission;
- runs each part's reads in parallel;
- leaves out what isn't allowed.

/today gains:
- `doneToday: {id, title, dueAt, leadName}[]` for the dots on Your day;
- `needsYou.unassignedOldest`.

Budgets: within the scale suite's Today budget (≤ 150 ms p95 at 1M leads). The reads are:
- index scans on leads (enquiry day, created_at undated), tasks_mine, meetings_owner;
- lead_counts_now;
- rollups.

## Out of scope

- The team and live-feed boards from v1.
- New notification types.
- Any number not listed above.

## Rulings made while building (2026-10-05)

- **The send queue isn't a Needs you row.** A run left open shows its own card above the tiles, saying why it paused (the daily cap, say), only while one is open, and only for messages.send_queue. The top bar's Resume pill stays as well. The e2e queue spec showed that the reason would otherwise be lost.
- **Team has no "vs yesterday".** Snoozing moves a follow-up's due time, so "overdue at this time yesterday" can't be rebuilt truthfully. The tile shows who holds the overdue follow-ups instead.
- **No percentage against nothing.** The Leads chip appears only when last week had leads by this time; otherwise the tile says "None by now last Monday". The same applies to the month: no chip when the same days of last month are zero.
- **The Calendar week starts on the business's own first day** (Settings → Business), not always Monday.
- **The setup steps don't show ticks.** "Get LUME ready" lists links (Import, Connect, Invite, Set goal) without ticked states, because nothing on the page can say truthfully which are done. They show only to settings.manage, on a day with no leads, wins or work.
- **"Live"** means Today follows the stream and refreshes its numbers every minute. Its tooltip says so.
