# Your day: hover to focus, and a full-screen day

Owner, 2026-11-15. Status: **design, awaiting the owner's approval.** Nothing is built yet.
Mockups (throwaway, for the feel only): `.superpowers/brainstorm/1323-1794749515/content/card-hover.html`, `your-day-v2.html`.

## Why

On a full day the Your day card on Today clogs: calls overlap, follow-up dots crowd into numbered markers, and nothing
can be read. The owner wants two things:

1. **On the card itself**, a way to read any one thing without leaving Today.
2. **A full-screen day** where everything is laid out neatly, can be read in full, and is easy to move around.

Success, in the owner's words: easy to use and easy to understand. The owner approved the hover-and-click behaviour in
the first mockup without changes ("exactly what I had in mind").

## Anti-goals

- **Anything that looks AI-made.** The owner called the mockups' styling "AI sloppish" twice. No coloured all-caps
  labels, no glow, no frosted glass on small panels, no bouncy overshoot, no "Click to…" lines, no gradients. Build with
  LUME's own font, type scale, tokens and components (Button, Dialog/Scrim, Popover), in Porcelain and Obsidian, so it
  reads as part of the app. The owner will judge the look in the app itself; expect a polish round after that.
- **A second Calendar.** This is one person's day, read and opened from. Planning (dragging things to new times,
  creating events) belongs to Calendar and the follow-up sheet, not here.
- **New sources of truth.** Everything shown already exists in LUME; this only lays it out.

## Part 1: the card

### Hover (owner's idea, approved)

- Hovering a call or a follow-up dot brings it forward: it grows a little (calls ~1.06×, dots ~1.4×) and a small panel
  opens beneath it with the full heading.
- Everything else on the line (other calls, dots, hour labels, the now marker) blurs (~2 px) and fades (~30 %) until
  the pointer leaves. Short ease-out with no overshoot (critically damped; hover is not a momentum gesture).
- The panel stays open while the pointer is over it, so its buttons can be clicked. A short grace period (~120 ms)
  means moving from the dot to the panel doesn't close it.
- **One panel, everywhere (owner, 2026-11-15):** the card and the full-screen timeline use the same panel component,
  showing the same details and the same buttons for the same item. Nothing is added or left out in either view.
- **Follow-up panel:** the task's own words first (semibold), then the lead's name, the due time, and the state on the
  right in its colour: Overdue (danger), Due soon (warn), Later today (accent), Done (ok); button **Open lead**.
- **Call panel:** the call's title, the lead's name (or who it's with), start and end times; buttons **Join** (only
  for a call that hasn't ended and has a meeting link) and **Open lead** (when it has a lead).
- **Group marker** (several follow-ups at about the same time, today's numbered dot): the panel is a short list of all
  of them, "N follow-ups around 4:30 pm", each row with its state colour, words, lead and time. Each row opens its lead.
  Today the marker opens only the most urgent one.

### Click (owner's idea, approved)

- A follow-up dot opens its lead (as today).
- A call opens its meeting link if it's upcoming and has one, else its lead, else the meeting in Calendar (as today).
- A group marker opens its list (the same as hovering it), for touch screens and keyboards.

### Keyboard and touch

- Tabbing onto an item does what hover does, and Enter does what click does. Esc closes the panel.
- On touch, the first tap on a single item opens its panel; a tap on the panel's button or a second tap on the item
  opens it. (My call: a direct tap that jumps away would make the panel unreachable on a phone.)

### Opening the full screen

- An expand button at the card's top right (where the count is today), labelled "Open Your day full screen".
  (My call: the card's own clicks already mean "open this lead", so the card doesn't also open full screen on a click
  anywhere.)

## Part 2: the full-screen day

### Opening and closing

- It grows out of the card: the window starts at the card's exact size and place and expands to fill the screen with
  a small margin, the rest of LUME dimmed and blurred behind it (LUME's full-window scrim, sidebar and top bar
  included). Contents fade in once it has nearly arrived.
- Esc, the × button, or a click on the scrim shrinks it back into the card along the same path. Focus returns to the
  expand button.
- Reduced motion: a short cross-fade, no growing.
- It is a dialog: focus stays inside while open; the page behind doesn't scroll.

### Header

- "Your day", and the date beneath in LUME's date style ("November 15, Sunday").
- **Day controls (owner asked):** ‹ previous day, › next day, and **Today** (shown only when another day is open).
  The date and the count follow the open day. The card on the Today page always stays on today.
- **Show (owner asked):** All · Calls · Follow-ups. With one kind chosen, the other kind's row and items are hidden in
  both Timeline and List, and the count says what's shown. Built from the list of kinds (below), so a new kind adds
  itself here.
- **Timeline | List** switch.
- Zoom controls (Timeline only): −, the zoom level, +, and **Fit day**.
- ×.

### Timeline

- Hours run left to right, with a ruler that stays at the top while the rows scroll. One row per kind (Calls,
  Follow-ups), labelled at the left edge, with the label staying visible while scrolling sideways.
- **Nothing overlaps:** items that would touch are stacked onto the next line within their row (greedy packing by
  start time and the item's real width at the current zoom). A row grows as tall as it needs. If the rows are taller
  than the window, they scroll up and down.
- Each item shows its time and full heading:
  - Call: an icon, start time, "Lead name · call title". Upcoming calls are filled accent; calls that have ended are
    quiet grey with a tick.
  - Follow-up: a state dot, due time, the task's words, then "· lead name" in quiet text. Done ones are greyed.
- The now line (today only) runs down through all rows, with the time on a small tag that stays at the top.
- On open, today scrolls so now sits about a third of the way in; another day opens at its first item (or 9 am when
  empty).
- **Hover and click** work exactly as on the card: the item comes forward, the rest blurs, the same panel as the card's
  shows the same details and buttons, and a click opens it.
- **Drag to move (owner asked):** press on the timeline and drag to move it sideways (and up and down when the rows
  scroll). It tracks the pointer 1:1, carries the flick's speed when let go and slows to a stop, and resists softly past
  the start and end of the day instead of stopping dead. The cursor is a hand while over empty space and a closed hand
  while dragging. A press on an item that moves more than ~6 px becomes a drag, not a click. Trackpad and mouse-wheel
  scrolling still move it too.
- **Zoom:** − / + step it; Ctrl + scroll and a trackpad pinch zoom around the pointer (the time under the pointer stays
  put); on touch, a two-finger pinch. **Fit day** sets the zoom so the whole day fits the window. Limits: from Fit day
  out to about 15 minutes per 100 px. As the zoom changes, items are re-packed and the ruler's ticks thin out or fill in
  (every 2 hours when far out, every half hour when close in).
- **The day's span:** 8 am to 9 pm, widened to take in anything earlier or later that day (the card's rule).
- Follow-ups from before today (today only) sit at the very start as one "N from before" item in the Follow-ups row,
  opening a list like a group marker. On other days there is no such pile.

### List

- Today: three groups, **Overdue**, **Coming up**, **Done**, each with its count, items in time order within each.
- Other days: past days group as **Not done** and **Done**; future days are one group, **Planned**.
- Each row: time, kind icon (call icon, or the follow-up's state dot), the heading, the lead's name in quiet text, the
  state in its colour, and Join for an upcoming call with a link. A click on a row opens it as on the timeline.
- Follow-ups from before today appear in Overdue with their dates ("Nov 13, 4:00 pm").

### Empty and other states

- A day with nothing: "Nothing planned for this day", plus "Add a follow-up from any lead" on today and future days.
- Loading another day: LUME's loading bar and skeleton rows; the previous day stays faded until the new one arrives.
- An error loading a day: LUME's error state with Try again; the header still lets you move to another day.
- Changes made elsewhere (a follow-up done in a lead, a call booked) show up the same way they do on the card today.
  The now line moves every minute. Passing midnight while the view is open doesn't jump days.

### What it remembers

- Timeline or List, the Show choice and the zoom, per person on this device. (My call: browser storage, as other
  per-view preferences in LUME. It's a convenience, not shared data.) It always opens on today.

## Kinds of thing on the day (owner: keep the other things in mind)

The timeline, the list, the Show choice and the hover panel all work from one list of **kinds**. Each kind gives:
its row name, its icon or dot, how one item reads (time, heading, lead, state), its panel, and what a click opens.
Version 1 has two kinds:

| Kind       | From                                                                     | Who sees it                               |
| ---------- | ------------------------------------------------------------------------ | ----------------------------------------- |
| Calls      | meetings, scheduled or completed (as the card: held/cancelled left out)  | the same people and rules as the card now |
| Follow-ups | the person's own follow-ups, open and done, due that day                 | the person they're assigned to            |

Kinds that may be added later, each a small addition once the list exists (not in version 1 unless the owner says so):

- **LUME AI's next messages:** when Autopilot plans to message a lead next (`autopilot_leads.next_at`). Only where
  LUME AI is on.
- **Call reminders:** when LUME will remind the person or the lead about a call (`meetings.reminder`).
- **New leads that came in:** when each lead arrived today, as a light trace on the past part of the day.

## Data

- **Today** uses what the Today page already loads (no new call).
- **Another day** needs one new read: `GET /api/v1/your-day?date=YYYY-MM-DD` returning that day's items in the
  person's time zone: their follow-ups due that day (open and done, with the same fields as Today's), and that day's
  calls under the same rules and permission (`calendar.view`) the card uses today. Without `calendar.view` there is no
  Calls row and no Calls choice in Show. It reads only; it changes nothing. The same visibility rules as Today: a
  follow-up is seen exactly when its lead is.
- Dates are limited to a sensible range (my call: a year either side of today) and a bad date is a 400.

## Left to the builder

- Exact sizes, spacing and timings, within LUME's tokens and the anti-goals above.
- How the stacking measures widths (measure once per zoom step; avoid layout thrash with hundreds of items).
- Whether the full screen is a route or an overlay on Today (the owner's need: it opens from the card and closes back
  into it; Back in the browser closing it is welcome but not required).
- Performance target: a day with 200 items stays smooth (60 fps) while dragging and zooming on a mid-range laptop.
