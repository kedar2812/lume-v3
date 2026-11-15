# Your day: hover to focus, and a full-screen day — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Your day card brings any item forward on hover with one shared details panel, and a click on the card
opens a full-screen day (Timeline with drag, zoom and no overlaps, or List), for today or any other day, filtered by
kind.

**Architecture:** One pure model in `apps/web/src/lib/today/day-items.ts` turns Today's data (or another day's) into
`DayItem`s of a few **kinds**; everything on screen (card, timeline, list, panel, Show) reads that model, so a kind
added later appears everywhere. Timeline maths (packing, zoom anchoring, momentum, rubber band, ticks) is pure in
`timeline-math.ts`. One new read route `GET /api/v1/your-day?date=` serves other days, sharing the meetings query with
`/api/v1/today`. Screens live in `apps/web/src/components/today/day/`.

**Tech Stack:** TypeScript, Fastify + Zod, Drizzle/Postgres (FORCE RLS, `req.db`), Next.js App Router, React 19,
CSS modules with LUME tokens, Motion (`motion/react`) where a spring is needed, Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-15-your-day-full-screen-design.md` (approved by the owner 2026-11-15). Read
it with this plan; it holds the owner's decisions and anti-goals.

## Global Constraints

- **Look:** LUME's own font, type scale, tokens and components only (Button, Scrim, `useModalFocus`, IconButton).
  Banned: coloured all-caps labels, glow, frosted glass on small panels, overshoot/bounce, "Click to…" copy,
  gradients. Porcelain and Obsidian both. The owner judges the look in the app; expect a polish round.
- **Motion:** hover/focus 240 ms `cubic-bezier(.2,.8,.2,1)`, no overshoot. Blur on the others: `blur(2px)`, opacity
  0.3. Item grows: call 1.06×, dot 1.4×. Panel grace period 120 ms. Full screen grows from the card in 440 ms with the
  same easing; contents fade in after ~120 ms. Reduced motion: cross-fades only (≤150 ms), no growing, no blur.
- **Copy (exact):** "Your day", "Open Your day full screen", "Previous day", "Next day", "Today", Show: "All",
  "Calls", "Follow-ups"; "Timeline", "List"; "Zoom out", "Zoom in", "Fit day", "Close"; buttons "Join", "Open lead";
  states "Overdue", "Due soon", "Later today", "Planned", "Done"; list groups "Overdue", "Coming up", "Done" (today),
  "Not done", "Done" (past day), "Planned" (future day); group panel heading "{n} follow-ups around {time}"; pile
  "{n} from before"; empty "Nothing planned for this day", with "Add a follow-up from any lead" on today and future
  days. Dates in `longDate` ("November 15, Sunday"). No em dashes in UI copy.
- **Numbers:** drag threshold 6 px; pack gap 8 px; row pitch 38 px; zoom step ×1.35; zoom range from Fit day to
  400 px per hour (15 min per 100 px); ticks every 2 h below 70 px/h, every 30 min above 260 px/h, else hourly;
  momentum projection `v/1000 * 0.998 / (1 - 0.998)`; rubber band `(o*d*0.55)/(d + 0.55*|o|)`; day span 8 am–9 pm
  widened to fit (the card's rule); date range ±366 days from the person's today.
- **Preferences:** `localStorage["lume.yourDay"] = {view: "timeline"|"list", show: "all"|kind, pph: number}`, every
  read/write in try/catch; the full screen always opens on today.
- **Data rules:** follow-ups = the person's own (`assignee_id = me`), open or done, due in the day; calls = the
  person's own meetings (`owner_id = me`), not cancelled or rescheduled, starting in the day; permission `auth.self`
  like `/api/v1/today`. Queries on `req.db` only.
- **Release:** goes into CHANGELOG "Unreleased" (with live sheets). Deploy to app.lumecrm.in only, after the full
  gate (owner 2026-11-15). Not Nupuur, not demo.

## Review Focus

1. **A daylight-saving day** (Europe/London 2026-10-25, 25 hours): items sit at their wall-clock time, the ruler shows
   one "1 am" per real hour, and `/your-day` bounds are midnight to midnight local. → Task 1 test
   `wall clock on a DST day`, Task 2 test `London's 25-hour day`.
2. **A huge day** (300 follow-ups at the same minute): packing stays linear-ish and the timeline stays usable. → Task 1
   test `packs 300 in under 30 ms`, Task 6 test `300 items render and pack`.
3. **Touch, no hover:** the first tap shows the panel, a second tap or the panel's button opens. → Task 3 test
   `touch: first tap peeks`.
4. **An item at 11:30 pm** whose chip runs past the day's end: the canvas widens to its right edge, nothing is cut
   off. → Task 6 test `a late chip widens the canvas`.
5. **A tab left open over midnight:** the open view stays on the day it showed; the now line leaves it; Today on the
   card moves on. → Task 5 test `midnight doesn't jump days`.

---

### Task 1: The day model and timeline maths

**Files:**
- Create: `apps/web/src/lib/today/day-items.ts`, `apps/web/src/lib/today/timeline-math.ts`
- Test: `apps/web/src/lib/today/day-items.test.ts`, `apps/web/src/lib/today/timeline-math.test.ts`

**Interfaces:**
- Produces:
  - `type DayKind = "call" | "follow_up"`; `const KINDS: { kind: DayKind; label: "Calls" | "Follow-ups" }[]` (order =
    row order and Show order).
  - `type DayState = "over" | "soon" | "later" | "planned" | "done"`.
  - `type DayItem = { id: string; kind: DayKind; at: string; endsAt: string | null; title: string;
    lead: { id: string; name: string } | null; state: DayState; link: string | null; before: boolean }`
    (`before` = a follow-up due before the shown day, today only).
  - `type DayData = { followUps: TaskView[]; doneFollowUps: { id; title; dueAt; leadId; leadName }[];
    meetings: TodayMeeting[] }`; `fromToday(v: TodayView): DayData`.
  - `dayItems(d: DayData, day: string /*YYYY-MM-DD*/, now: Date, tz: string): DayItem[]` sorted by `at`.
    State: done → "done"; open and `at < now` → "over"; within 2 h → "soon"; later on today → "later"; any open item
    on a future day → "planned". Calls: ended (`endsAt <= now` or completed) → "done", else by the same clock.
  - `daySpan(items: DayItem[], tz: string): { from: number; to: number }` minutes, 8:00–21:00 widened to whole hours
    (ignores `before` items).
  - `minuteOf(iso: string, tz: string): number` (wall clock; move the private one out of `dayline.ts` and import it
    there).
  - `panelOf(item: DayItem, now: Date, tz: string): { heading: string; who: string | null; time: string;
    state: { label: string; tone: "danger" | "warn" | "accent" | "ok" | "quiet" } | null;
    actions: ("join" | "open")[] }` — the one source for every panel. Follow-up: heading = title, actions ["open"]
    when it has a lead. Call: heading = title, who = lead name, time "3:30 pm – 4:00 pm", state null, actions
    ["join"] when `link` and not ended, plus ["open"] when it has a lead.
  - `openOf(item: DayItem, now: Date): { href: string; external: boolean }` — call upcoming with link → link
    (external); else lead → `/leads?lead=<id>`; else `/calendar?m=<id>`; follow-up → `/leads?lead=<leadId>`.
  - `listGroups(items: DayItem[], mode: "today" | "past" | "future"): { name: string; items: DayItem[] }[]`, empty
    groups left out, names per Global Constraints.
  - `timeline-math.ts`: `packRows(spans: { x: number; w: number }[], gap = 8): number[]` (row per span, input in
    start order); `tickStep(pph: number): 30 | 60 | 120` (minutes); `clampPph(pph, fitPph): number` (fitPph–400);
    `zoomScroll(o: { scrollLeft: number; anchorX: number; pad: number; pph: number; next: number }): number`
    (new scrollLeft keeping the time under `anchorX` fixed); `project(v: number, rate = 0.998): number`;
    `rubberband(over: number, dim: number, c = 0.55): number`.

- [ ] **Step 1: Write the failing tests.** `day-items.test.ts` (Kolkata, now 2026-10-05 11:40 local, as `DayTile.test`):
  `states on today` (−1 h over, +1 h soon, +5 h later, done done); `planned on a future day`; `a call that ended is
  done and loses Join`; `before-today follow-ups are flagged before and left out of the span`; `span widens to 7 am
  and 11 pm`; `wall clock on a DST day` (Europe/London, day 2026-10-25: an item at 02:30 local sits at minute 150);
  `panelOf is the same object for the same item` (deep-equal from two calls) and its Join/Open rules; `openOf` three
  call cases; `listGroups` today/past/future names and order, no empty group; `a meeting with no lead has no Open
  lead`. `timeline-math.test.ts`: `packRows` (three spans at x 0, 10, 300 with w 100 → rows [0,1,0]); `respects the
  gap` (end 100, next x 105 → new row; x 108 → same row); `packs 300 in under 30 ms`; `tickStep` at 60/140/300;
  `zoomScroll keeps the anchored time` (time under x=400 identical before and after); `project(1000) ≈ 499`;
  `rubberband grows slower than the drag and never past dim*0.55`.
- [ ] **Step 2: Run them, see them fail.** `cd apps/web && pnpm exec vitest run src/lib/today` (on the box via
  `bash scripts/dev.sh run bash -c "cd apps/web && pnpm exec vitest run src/lib/today"`). Expected: FAIL, modules not
  found.
- [ ] **Step 3: Implement both files** to the signatures above; `dayline.ts` imports `minuteOf` from `day-items.ts`.
- [ ] **Step 4: Run them, see them pass**, plus `DayTile.test.tsx` and `dayline` users still green.
- [ ] **Step 5: Commit** `feat(today): the day model and timeline maths for Your day`.

### Task 2: Another day's items: `GET /api/v1/your-day`

**Files:**
- Create: `apps/api/src/modules/tasks/your-day.ts`, `apps/api/src/modules/tasks/meetings-between.ts`
- Modify: `apps/api/src/modules/tasks/today.ts` (use `meetingsBetween`), `apps/api/src/modules/tasks/routes.ts`,
  `apps/web/src/lib/tasks/client.ts`, `apps/web/src/lib/tasks/types.ts`
- Test: `apps/api/src/modules/tasks/your-day.test.ts`

**Interfaces:**
- Produces: `meetingsBetween(req, userId: string, start: Date, end: Date): Promise<TodayMeeting[]>` (the query now in
  `today.ts`, moved as is); route `GET /api/v1/your-day?date=YYYY-MM-DD` (Zod `/^\d{4}-\d{2}-\d{2}$/`, real date,
  within ±366 days of the person's local today, else 400 `{ error: "bad_date" }`), permission `auth.self`, returns
  `YourDay = { date: string; followUps: TaskView[]; meetings: TodayMeeting[] }` (follow-ups: `assignee_id = me`,
  status open or done, `due_at` in `dayBounds(date, tz)`, ordered by `due_at`, through `viewsOf`, limit 500);
  `tasksClient.day(date: string): Promise<YourDay>`.

- [ ] **Step 1: Write the failing tests** with the harness, as `today.test.ts` does: `a day in Dubai and in Kolkata`
  (the same instant lands on different dates); `open and done, not cancelled`; `someone else's follow-ups and calls
  never show`; `a follow-up on a lead the person can't see is left out` (RLS through `req.db`); `cancelled and
  rescheduled calls left out`; `London's 25-hour day` (2026-10-25: items at 00:30 and 23:30 local both in);
  `bad dates are 400` (`2026-02-30`, `20261015`, 367 days ahead); `/api/v1/today still returns the same meetings`
  (existing `today-meetings.test.ts` stays green).
- [ ] **Step 2: Run, see them fail.** `pnpm exec vitest run --project @lume/api apps/api/src/modules/tasks` — FAIL
  (404).
- [ ] **Step 3: Implement** `meetingsBetween`, `yourDay`, the route and the client.
- [ ] **Step 4: Run, see them pass**, with the whole `tasks` folder.
- [ ] **Step 5: Commit** `feat(api): another day's follow-ups and calls for Your day`.

### Task 3: One details panel and the focus behaviour

**Files:**
- Create: `apps/web/src/components/today/day/ItemPanel.tsx`, `apps/web/src/components/today/day/useItemFocus.ts`,
  `apps/web/src/components/today/day/day.module.css`
- Test: `apps/web/src/components/today/day/ItemPanel.test.tsx`

**Interfaces:**
- Consumes: `panelOf`, `openOf`, `DayItem` (Task 1).
- Produces:
  - `<ItemPanel item={DayItem} now tz onOpen={(i: DayItem) => void} />` and
    `<GroupPanel items={DayItem[]} now tz onOpen />` (heading "{n} follow-ups around {time}", one row per item).
  - `useItemFocus(container: RefObject<HTMLElement>)` →
    `{ focused: string | null; bind(id: string): { onPointerEnter, onPointerLeave, onFocus, onBlur, onPointerDown,
    onClick }; panelBind: { onPointerEnter, onPointerLeave }; close(): void }`. Pointer leave closes after 120 ms
    unless the panel is entered; Esc closes; for `pointerType === "touch"` the first tap only focuses (the click is
    prevented) and a second tap passes through.
  - CSS: `.focusing` on the container blurs/fades every `[data-day-item]` but the one with `data-on`.

- [ ] **Step 1: Write the failing tests:** `follow-up panel: words, lead, time, state, Open lead`; `call panel: Join
  only before it ends and with a link`; `group panel lists each with its own Open`; `the card and the timeline render
  the same panel` (render `ItemPanel` for one item twice, compare `innerHTML`); `touch: first tap peeks` (first
  pointerdown/click with `pointerType: "touch"` doesn't call `onOpen`, the second does); `Esc closes`; `120 ms grace
  into the panel` (fake timers).
- [ ] **Step 2: Run, see them fail.** `cd apps/web && pnpm exec vitest run src/components/today/day`.
- [ ] **Step 3: Implement**, panel styled per Global Constraints (task words semibold first; lead · time beneath;
  state in its tone on the right; buttons LUME `Button` small).
- [ ] **Step 4: Run, see them pass.**
- [ ] **Step 5: Commit** `feat(today): one details panel for Your day, with hover and tap focus`.

### Task 4: The card: focus, group lists, click to open

**Files:**
- Modify: `apps/web/src/components/today/DayTile.tsx`, `apps/web/src/components/today/today.module.css`
- Test: `apps/web/src/components/today/DayTile.test.tsx`

**Interfaces:**
- Consumes: Task 1 (`dayItems`, `fromToday`), Task 3 (`ItemPanel`, `GroupPanel`, `useItemFocus`).
- Produces: `DayTile` gains `onOpenFull: () => void`; an expand `IconButton` labelled "Open Your day full screen" in
  the header; the card's root gets `data-your-day`.

- [ ] **Step 1: Write the failing tests (update the existing ones):** `hovering a dot brings it forward and opens its
  panel` (`data-on`, container `.focusing`, panel text); `a group marker opens its list, not a lead` (replaces the
  old "opening the one that needs you most" assertion: ledger it as `Ruling: owner-approved change, spec Part 1`);
  `a click on empty card space opens the full screen`; `a click on a dot, a call, the panel or Join doesn't`;
  `the expand button opens it and has its name`; `keyboard: Tab to a dot opens its panel, Enter opens the lead`.
- [ ] **Step 2: Run, see them fail.** `cd apps/web && pnpm exec vitest run src/components/today/DayTile.test.tsx`.
- [ ] **Step 3: Implement.** Card-level `onClick` opens unless the event came from `[data-day-item]`, the panel, a
  link or a button. Keep the existing clustering (24 px) and the next-call row.
- [ ] **Step 4: Run, see them pass.**
- [ ] **Step 5: Commit** `feat(today): Your day card brings an item forward and opens full screen`.

### Task 5: The full-screen shell: open, close, days, Show, view, preferences

**Files:**
- Create: `apps/web/src/components/today/day/DayFull.tsx`, `apps/web/src/components/today/day/useDayData.ts`,
  `apps/web/src/components/today/day/prefs.ts`
- Test: `apps/web/src/components/today/day/DayFull.test.tsx`

**Interfaces:**
- Consumes: Tasks 1–3; `tasksClient.day`; `Scrim`, `useModalFocus`, `longDate`.
- Produces: `<DayFull open v={TodayView} now tz from={RefObject<HTMLElement>} onClose />`;
  `useDayData(day: string, today: string, v: TodayView): { state: "loading" | "ready" | "error"; data: DayData | null;
  retry(): void }` (today → `fromToday(v)`, live; other days → `tasksClient.day`, the previous day kept faded while
  loading); `readPrefs()/writePrefs()` (try/catch, defaults `{view: "timeline", show: "all", pph: 0}`, 0 = Fit day).

- [ ] **Step 1: Write the failing tests:** `opens as a dialog named Your day with today's date`; `Esc, × and the scrim
  close it and focus returns to the opener`; `Previous day loads /api/v1/your-day?date=2026-10-04 and shows its date`;
  `Today shows only on another day and comes back`; `Show Calls hides the follow-ups row and their list rows, and the
  count says so`; `Timeline/List and Show are remembered; it still opens on today`; `storage that throws doesn't break
  it`; `an error has Try again, and the day buttons still work`; `midnight doesn't jump days` (fake timers past
  midnight: header date unchanged); `reduced motion: no transform animation` (matchMedia stub).
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.** Grow from `from.current.getBoundingClientRect()` to the panel's rect with a transform
  animation (Web Animations API or `motion/react`), reverse on close, then unmount. Header layout per spec.
- [ ] **Step 4: Run, see them pass.**
- [ ] **Step 5: Commit** `feat(today): Your day full screen: days, Show, Timeline or List`.

### Task 6: Timeline: rows without overlaps, drag, zoom

**Files:**
- Create: `apps/web/src/components/today/day/DayTimeline.tsx`, `apps/web/src/components/today/day/usePanZoom.ts`
- Test: `apps/web/src/components/today/day/DayTimeline.test.tsx`

**Interfaces:**
- Consumes: Task 1 maths and model; Task 3 focus and panel.
- Produces: `<DayTimeline items show now tz isToday pph onPph onOpen />`; `usePanZoom(scroller, { fitPph, pph,
  onPph })` handling pointer drag (threshold 6 px, `setPointerCapture`, velocity from the last ~100 ms, momentum via
  `project`, `rubberband` past the ends, `cursor: grab/grabbing`), Ctrl+wheel and trackpad pinch (`wheel` with
  `ctrlKey`) anchored by `zoomScroll`, two-finger touch pinch, − / + / Fit day.

- [ ] **Step 1: Write the failing tests:** `one row per shown kind, labelled`; `items that would touch stack onto the
  next line, none overlap` (jsdom: stub `offsetWidth` per chip; assert `top` values from `packRows`); `300 items render
  and pack`; `a late chip widens the canvas`; `the now line only on today`; `opens with now a third of the way in`;
  `another day opens at its first item`; `a drag of 10 px moves and doesn't open; a 3 px wobble still clicks`;
  `Ctrl+wheel zooms around the pointer` (scrollLeft from `zoomScroll`); `− / + step ×1.35 within limits; Fit day sets
  the fit`; `ticks thin out when far out`; `hover blurs the others and shows the shared panel`; `today's "N from
  before" sits at the start of Follow-ups and opens its list; no pile on other days`; `the now line moves each
  minute`.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.** Measure chip widths once per zoom step (one hidden measuring pass), pack per row, position
  with `transform: translateX` for drag smoothness; sticky ruler and row labels; `requestAnimationFrame` for momentum.
- [ ] **Step 4: Run, see them pass.**
- [ ] **Step 5: Commit** `feat(today): Your day timeline: no overlaps, drag to move, zoom`.

### Task 7: List

**Files:**
- Create: `apps/web/src/components/today/day/DayList.tsx`
- Test: `apps/web/src/components/today/day/DayList.test.tsx`

**Interfaces:**
- Consumes: `listGroups`, `panelOf`, `openOf` (Task 1).
- Produces: `<DayList items mode show now tz onOpen />`.

- [ ] **Step 1: Write the failing tests:** `today: Overdue, Coming up, Done with counts in time order`; `past and future
  day group names`; `a before-today follow-up shows its date`; `Join only on an upcoming call with a link and it
  doesn't also open the lead`; `empty day copy, with the add hint only on today and future days`; `rows are links
  with names a screen reader reads`.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, see them pass.**
- [ ] **Step 5: Commit** `feat(today): Your day list`.

### Task 8: Wire into Today, end to end, changelog

**Files:**
- Modify: `apps/web/src/components/today/Today.tsx`, `CHANGELOG.md`
- Create: `apps/web/e2e/your-day.spec.ts`
- Test: e2e + updated visual baselines (`today`, both themes) from a full run only

- [ ] **Step 1: Write the failing e2e** (`openApp(page, "/today")`, follow-ups made through the API in the test):
  `hover a dot: panel with its words, the rest blurred`; `click the card: full screen, Esc closes back`; `a packed day
  (12 follow-ups within 30 min, 4 calls): no two items overlap` (bounding boxes); `drag moves the timeline`; `List
  groups`; `Previous day and Today`; `Show Calls`; `axe: no violations in the full screen` (the a11y spec's helper);
  `phone width 375: opens, List readable, no page sideways scroll`.
- [ ] **Step 2: Run, see them fail** (on the box, this spec only, `--cpus` limits as usual).
- [ ] **Step 3: Implement** the wiring (`DayTile onOpenFull` → `DayFull open`), and a CHANGELOG "Unreleased" entry.
- [ ] **Step 4: Run, see them pass.**
- [ ] **Step 5: Commit** `feat(today): Your day full screen on Today`.

### Task 9: Gate, review, deploy to app.lumecrm.in

- [ ] **Step 1:** Mutation check on each guard (drag threshold, card-click exclusion, date range, assignee filter):
  break it, see a test fail, restore. Ledger each.
- [ ] **Step 2:** Full gate on the box (typecheck, `pnpm lint`, `prettier --check .`, unit, e2e full run; refresh
  baselines only from the full run). Expected: all green but known flakes, each named.
- [ ] **Step 3:** Whole-branch review (fresh reviewer if the owner allows one; else self-review, ledgered); fix
  Critical/Important test-first.
- [ ] **Step 4:** Push; CI green on the pushed commit.
- [ ] **Step 5:** Deploy to app.lumecrm.in (backup dump, `prev-` tags, `git log -1` check, `dev.sh up`), then walk it
  in the owner's Chrome by page text: hover, card click, full screen, drag, zoom, days, Show, List.
