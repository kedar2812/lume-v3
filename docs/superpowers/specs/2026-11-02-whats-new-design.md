# What's new in LUME (owner, 2026-11-02)

The owner: every update should look and feel new to the people using LUME. A big window at their first sign-in after an
update shows each new feature in action, with LUME and LUME AI branding; a "New" beside each feature for at least a
week. Approved mock (v4): https://claude.ai/artifact/BETnYJUaXVV9U13SqDrQLX ("this is sooo good").

## The window

- Once per version per person, at the first page they open after the update (never during a task: not over an open
  sheet, the import flow or setup). Seen or closed, it's gone on every device: kept on the server per person.
- Nearly full screen (3vh/3vw from each edge; 8px on a phone) over the whole app, dimmed and blurred, sidebar and
  top bar included (LUME's full-window scrim).
- Opening: the window unfolds from the centre; LUME's logo (lume-mark.png, as it is) and the version, big, the last
  version rolling to this one ("1.1.0" to "1.2.0"); then the header "What's new in 1.2.0" and the date.
- Left rail: the version's stories (up to four), each with its mark (the LUME AI Loop for LUME AI, the official
  WhatsApp logo, LUME's logo), a progress line while it plays; "Also new" lists the smaller changes in one line each.
- Stage: a kicker (LUME AI with the Loop, WhatsApp, ...), a headline in two short lines, one sentence, "Show me" and
  Next ("Done" on the last), "2 of 3". The right half plays the feature in LUME's own components and tokens: built in
  code (not video), so it's crisp in both themes and in the person's language later.
- Plays by itself (each story 7-9 s); arrows, the rail and Next move; Esc closes. Reduce motion: no roll, no flight,
  each story shows its finished state.

## Show me

The window folds away, LUME opens where the feature lives (a route plus the element to point at), and a spotlight with
a ring sits on that control, with a tip: what it is and what to do, "Got it", "Back to What's new" (the same story).
The tip stays inside the window: below the control, above it when there's no room, never over it. A story whose
place the person can't open (their role) isn't shown to them at all.

## New

A small "New" pill beside each story's place (a sidebar item, a settings section, a button) for 7 days from the
release, or until they've used it. The account menu has What's new: every version's window again, newest first.

## Releases as data

Each version's stories live in the code with the release (version, date, stories: id, title lines, sentence, kicker,
the permission it needs, the route and target for Show me, the demo component), so a deploy carries its own
announcement; the server keeps per person the last version they've seen and which features they've opened.

## No overlap, no glitches (owner)

Every story's demo is laid out for every size LUME supports (1024 to 1920 wide, a phone at 390), checked by the
layout tests that already guard LUME ("nothing spills out of its card"): no text cut, nothing overlapping, the tip
and spotlight inside the window, in both themes. Screenshots of each story's last frame at three sizes, both themes.

## No text cut off, anywhere (owner, 2026-11-02)

The mock's headline reveal cut the bottom of "your" (a mask ending at the baseline): "looks unfinished". Any mask or
box that hides overflow around text reaches past the descenders and accents (and gives the room back), and a new
layout test walks every screen LUME's layout tests visit, both themes: no element that hides its overflow and holds
text may have its text taller or wider than its box, unless it ends in an ellipsis on purpose.

## After the window, and in Settings (owner, 2026-11-02)

- The LUME AI Loop is animated wherever it appears in the window and its tips (AiGlyph "loop"; "pen" while writing).
- X closes the window; a pill stays on the dashboard, "What's new in version 1.2.0" (LUME's logo, the version rolling
  from the last now and then), with its own X. Pressing it opens the window again, the whole opening included; its X
  puts it away for good (for this version).
- Settings → About, under the licence: a "What's new in version 1.2.0" button, inviting (LUME's mark breathing, the
  version rolling, the three stories appearing one by one as small chips, an arrow nudging); it opens the same window
  with the full number roll.

## Calls: what's true (owner question, 2026-11-02)

LUME's Google connection is read-only (calendar.events.owned.readonly, calendar.calendarlist.readonly): LUME AI's
booked calls live in LUME's Calendar, not Google's, and LUME makes no Meet link. The business's own "how the call
happens" (a phone call, a fixed Zoom or Meet link) is what LUME AI says. The owner asked (2026-11-02) to apply for
writing now: "LUME makes the Meet link" (calendar.events.owned, asked only of those who switch it on), then Google's
verification with a recorded demo; its own spec.

## Decisions on completion (2026-11-05, plan docs/superpowers/plans/2026-11-04-whats-new.md)

- **1.2.0's stories:** LUME AI books your calls (Show me: Settings → LUME AI, the calls panel), Your chats, live in LUME
  (Who replied), Templates, written for you (Templates, Write with LUME AI). Also new, one line each: the two-step code
  ready to type, lifting do not contact from LUME AI's chat, deleting your own account, profile photos from every
  browser. The mock's "Two-step, ready to type" story became an Also-new line (its Show me would point at sign-in).
- **Calls: what's true** above is superseded: LUME makes the Meet link (spec 2026-11-03) shipped before 1.2.0, so the
  calls story says so ("if you let it").
- **Who sees it:** only stories whose place their role opens and whose feature is really on here (LUME AI on; WhatsApp
  switched on, set up and a number connected). Not while the agreement, two-step enrolment, onboarding or the tour is
  due; never over a sheet, an open form or menu, setup or an import; once per version, and a tab that was waiting
  doesn't show it after another tab did.
- **Each installation's own day:** the week of "New" and "joined after the update" (people who join after an update
  skip the window) count from the later of the release day and the day this installation first ran the version
  (app_releases, migration 0104), since every client updates on its own day.
- **Ways back:** Today's pill (until its X), Settings → About, the profile menu's What's new. One release, so no
  version select yet.
- **No text cut, nothing spills:** every screen and everything that opens is swept at a laptop's and a phone's width
  (text-fit.spec, opened.spec), and the window at every width (whats-new.spec), both themes.
