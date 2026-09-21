# LUME — Frontend Design Spec

**Date:** 2026-09-21 · **Status:** approved in brainstorming, awaiting written-spec review
**Scope:** everything visual and interactive in `apps/web`. This implements Section 16 of `docs/LUME_PROJECT_REPORT.md` ("visuals are Claude Code's call"). The report still governs behaviour, data, security and permissions. Where the two touch (masking, absent-not-disabled UI, honest WhatsApp UX), the report wins.

**Reference prototypes** (approved, interactive; open in a browser): `docs/design/prototypes/`

| File | What it settles |
|---|---|
| `today-prototype.html` | Overall look, both themes, Today screen, toasts, sound, celebration |
| `motion-prototype.html` | Page transitions, nav pill, analytics motion |
| `customise-prototype.html` | Settings: pipeline & stages, fields, roles & access; custom scrollbars |
| `key-screens.html` | Sign-in + 2FA, lead drawer, phone layout, notification centre (panel + full screen) |

The prototypes are the visual source of truth. Their code is throwaway: rebuild it properly in `apps/web`, don't copy it. Box and text alignment polish was deliberately deferred and happens during the build.

---

## 1. Design principles

1. **Premium through restraint.** Neutral surfaces, hairline borders, one accent. Richness comes from typography, motion and detail, not decoration.
2. **Colour always means something.** The UI never uses colour decoratively (Section 3.3).
3. **Every screen answers "what do I do next?"** The most urgent item is always the most visible one.
4. **Reward accomplishment.** Completing things feels good: a tick that draws itself, a soft chime, progress that fills. Nothing else makes noise.
5. **Motion is physical and never a toll.** Springs, interruptible, velocity-aware. Choreography plays once, then gets out of the way.
6. **Simple for Tasneem.** Plain language, live previews, guardrails. No jargon, no hidden modes.
7. **Absent, not locked.** What a role can't do isn't rendered at all (report 16.2).

---

## 2. Brand and logo

- Asset: `public/lume-mark.png` (6-petal blue rosette). Also produce an SVG trace plus 16/32/180/512 px PNG exports for favicon, apple-touch-icon and PWA manifest.
- **Sidebar lockup:** mark (28 px, soft blue drop-shadow) + **LUME** on top (bold 760, tracking +0.06em, 15 px) + the **client name** beneath (11.5 px, tertiary text). The client name comes from `settings.business_name`.
- **Sign-in page:** the mark is the hero (76 px) with a "bloom" entrance (Section 5.4). Below it: LUME wordmark (30 px, 780, tracking +0.14em) and the client name.
- **Favicon:** the mark. The tab title carries the unread count: `(3) LUME`.
- **Celebrations and empty states:** the mark appears in "All clear" (Today), "You're all caught up" (notifications), and the six-petal burst when a deal is won.

---

## 3. Themes and colour

### 3.1 Themes
Two themes, both first-class:
- **Porcelain** (light).
- **Obsidian** (dark).

Default is `system` (`prefers-color-scheme`). The user can override it in their profile: System / Porcelain / Obsidian, persisted server-side per user. Theme switches cross-fade background and colour over 400 ms, never an abrupt flip.

### 3.2 Tokens
All colour is expressed as CSS custom properties on `[data-theme]`. Components never use raw hex.

| Token | Porcelain | Obsidian | Use |
|---|---|---|---|
| `--canvas` | `#EEF0F3` | `#060708` | Window behind the sheet; sidebar |
| `--sheet` | `#FFFFFF` | `#0E0F12` | Main content surface |
| `--raised` | `#FFFFFF` | `#15171B` | Popovers, segmented thumbs, buttons |
| `--sunk` | `#F6F7F9` | `#0A0B0D` | Inputs, table headers, tracks |
| `--line` / `--line-2` | `rgba(12,18,32,.075/.12)` | `rgba(255,255,255,.065/.11)` | Hairlines (0.5 px) |
| `--text` / `-2` / `-3` | `#0A0C11` / `#5A606D` / `#9398A3` | `#EEF0F3` / `#9CA1AB` / `#626772` | Primary / secondary / tertiary |
| `--accent` | `#2A5BFF` | `#5B84FF` | Brand, primary actions, selection |
| `--danger` | `#E5484D` (ink `#C3272D`) | `#FF5C61` (ink `#FF8A8E`) | Overdue, errors, lost, high risk |
| `--warn` | `#F2A20C` (ink `#946100`) | `#FFB224` (ink `#FFC75C`) | Due soon, live now, needs attention |
| `--meet` | `#6E56CF` | `#9582FF` | Meetings and calls |
| `--ok` | `#18A566` (ink `#0E7F4B`) | `#2FD08A` (ink `#5FE0A8`) | Done, won, growth |
| `--cyan` | `#0EA5B7` | `#22C3D6` | "Replied" stage |
| `--wa` | `#1FAF5A` | `#25C366` | WhatsApp actions only |
| `--glass` | `rgba(255,255,255,.72–.8)` | `rgba(22,24,29,.72)` | Translucent panels |
| `--hud` | `rgba(22,24,30,.88)` | `rgba(38,41,48,.86)` | Toasts, save bar |

Each semantic colour also has a `-soft` tint for pill and badge backgrounds and an `-ink` variant that meets 4.5:1 contrast on the sheet. Dark shadows are heavier and use an inner top highlight (`inset 0 1px 0 rgba(255,255,255,.03–.08)`).

### 3.3 Colour meaning (fixed vocabulary)
- **Red:** overdue, error, lost, high risk, security alert.
- **Amber:** due soon, happening now, needs attention (e.g. needs a country code, sync paused).
- **Violet:** meetings.
- **Green:** done, won, growth, confirmed.
- **Blue:** LUME, primary action, selection, informational updates.
- **WhatsApp green:** only on WhatsApp send actions.
- **Grey:** neutral, later, archived.

Admin-chosen stage, tag and option colours come from a curated 10-swatch palette tuned for both themes. They are never free hex.

### 3.4 Special surfaces
- **Notification centre in Obsidian:** deep black (`rgba(4,4,5,.94)`), not blue-grey. It has a soft cool radial glow from the top-right (where the bell is), a 1 px light line along the top edge, and a faint outer halo (`0 0 90px -14px rgba(120,150,255,.34)`). In Porcelain it is frosted white glass.
- **Sign-in:** two large blurred blue blobs taken from the logo gradient sit behind a glass card. They are static after the fade-in (no looping motion).

---

## 4. Typography, layout, surfaces

### 4.1 Type
- **Font:** Inter variable, self-hosted WOFF2 in `apps/web/public/fonts` (the CSP forbids Google Fonts). `font-optical-sizing: auto`. Fallback: `Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`.
- `tabular-nums` on every number: tables, KPIs, times, phones, money.

| Role | Size / weight / tracking / leading |
|---|---|
| Hero greeting | 34 / 680 / −0.032em / 1.08 |
| Page title | 26–30 / 680 / −0.03em / 1.1 |
| Drawer title | 23 / 680 / −0.028em |
| KPI value | 25–26 / 660 / −0.03em / 1.0 |
| Section heading | 14.5–15 / 650 / −0.015em |
| Body / row title | 13.5–14 / 560–580 / −0.01em |
| Meta | 12.5 / 400–520 |
| Label / caption | 11–12 / 600, small caps-like labels +0.02em |

Sizes are in `rem` in code so they scale with the user's text setting.

### 4.2 Shell
- **Desktop:** a 244 px sidebar on the canvas, plus the main **sheet** inset 8 px with a 16 px radius, the sheet shadow and a 56 px top bar with a 0.5 px bottom hairline. Content max-width ~1160 px, padding 34–36 px.
- **Sidebar:** lockup, main nav (Today, Leads, Pipeline, Calendar, Templates, Analytics), "Views" (saved views with coloured markers and counts), Settings and the user at the bottom. Nav items only appear if the role can use them.
- **Top bar:** page title (crumb), global search (Ctrl/Cmd+K), bell, profile.
- **Radii:** sheet 16, cards 14, rows 12, controls 9–10, chips 7–8, pills 99.
- **Hairlines:** 0.5 px `--line-2` box-shadows, never 1 px borders.

### 4.3 Materials
- **Translucent layers** (`backdrop-filter: blur(20–34px) saturate(180%)`): notification centre, drill-down sheet, phone tab bar and nav bar, sign-in card, popovers.
- **HUD (dark glass, in both themes):** toasts and the unsaved-changes bar.
- `prefers-reduced-transparency` makes these near-solid. `prefers-contrast: more` adds solid borders.

### 4.4 Scrollbars
There are no default browser scrollbars anywhere:
- **Style:** 11 px gutter, 3 px transparent border, rounded thumb in `--sb` (Porcelain `rgba(12,18,32,.16)`, Obsidian `rgba(255,255,255,.14)`). No track and no arrow buttons.
- **Visibility:** hidden until the container is hovered or scrolling (an `is-scrolling` class for 900 ms). The thumb darkens on hover and active.
- **Firefox:** `scrollbar-width: thin` with the same colours.
- **Phone:** scrollbars are hidden.

---

## 5. Motion system

### 5.1 Springs (Apple damping + response)
Springs are defined once in `apps/web/lib/motion.ts` and exported both as Motion (motion.dev) spring configs and as CSS `linear()` easings generated from the same function.

| Token | Damping (bounce) | Response | Use |
|---|---|---|---|
| `spring.default` | 1.0 (0) | 0.38 s | Most UI: popovers, rows, pills, crumbs |
| `spring.soft` | 1.0 (0) | 0.70 s | Page entry, chart morphs, rings, FLIP |
| `spring.bounce` | 0.7 (0.3) | 0.42 s | Toasts, check pop, toggles, arrivals |
| `spring.drawer` | 0.8 (0.2) | 0.30 s | Drawers and sheets opening |

Bounce is reserved for momentum and celebration. Menus and fades never overshoot.

### 5.2 Rules
- Everything is **interruptible**. It animates from the current on-screen value, and a new navigation cancels the old one.
- Animate only `transform`, `opacity` and `filter`, except deliberate height collapses on list removal.
- **Symmetric paths.** A drawer enters from the right and leaves to the right. Popovers scale from their trigger.
- Gestures track the pointer 1:1, respect the grab offset, rubber-band at limits, and use **momentum projection** (`v/1000 · d/(1−d)`, d = 0.998) to decide commit.
- **Choreography once.** Analytics' build-up plays on the first visit per session only. Later visits render straight away.
- **Reduced motion:** cross-fades only, no slides, bounces or bursts. Colour and opacity feedback stays.

### 5.3 Catalogue

| Moment | Behaviour |
|---|---|
| Nav selection | A shared highlight pill springs to the new item and stretches up to 18 % along the travel axis mid-flight |
| Page switch | Outgoing page recedes 140 ms (fade, −8 px against travel direction, 2 px blur). Incoming sections stagger in reading order (38 ms apart, `spring.soft`) from +16 px in the travel direction (down the nav = rises from below). The crumb title slides out and in |
| Loading | Skeletons mirror the real layout (shimmer 1.4 s). They show only if data takes >150 ms, then cross-fade into content with a 70 ms stagger |
| Numbers | KPIs count up on first render. Later changes **roll like an odometer** per digit (right-to-left stagger 35 ms) |
| Lists | Completed rows: tick draws itself, then the row collapses (`spring.default`) and group counts update. Undo re-inserts with a drop-in |
| Toasts | HUD pill rises from the bottom centre with `spring.bounce` + blur-in, 4.2 s life with a thin countdown line, max 3 stacked, Undo where the action is reversible |
| Drawers / sheets | `spring.drawer` from the edge, content staggers 28 ms, scrim fades with it |
| Popovers / palette | Materialise: scale 0.96→1 + blur 6→0 + fade, origin at the trigger |
| Reorder | FLIP (leaderboard re-rank, board columns, stage list) |
| Celebration | All follow-ups cleared: the logo rotates in with the win chord. Deal won: 12 petals burst from the Won button in LUME blues and green |
| Theme change | 400 ms colour cross-fade |

### 5.4 Signature moments
- **Sign-in bloom:** the mark goes from scale 0.35, −120° and 8 px blur to rest over 1.3 s (`spring.bounce`). The wordmark de-tracks into place (+350 ms), then the card rises (+560 ms). On success the mark spins out and the card dissolves into the app.
- **Analytics build (first visit):** skeleton → line chart draws left-to-right with an area fade → funnel bars grow in sequence (90 ms) with drop-off labels → heatmap cells pop in a diagonal wave → donut segments sweep in → team bars grow. Changing the range: numbers roll, the line **morphs** point-by-point (no redraw), and the funnel and heatmap re-tint. Compare mode fades in a dashed previous-period line. Chart hover snaps to data points and the tooltip glides after them on a spring.
- **Notification full screen:** the panel FLIP-grows from its side rect to the window. Children counter-fade so text never looks stretched.

---

## 6. Feedback and sound

### 6.1 Feedback kinds
Every action gets one of four kinds of feedback:
- **status** (spinners in buttons, live dots)
- **completion** (tick, toast)
- **warning** (amber inline note)
- **error** (red inline message + shake for rejected input)

Validation is inline, never on submit only. Reversible actions use Undo toasts. Only irreversible ones get a confirmation (report 16.2).

### 6.2 Sound policy (approved)
Sounds play **only when the user accomplishes something**. They are soft, short and warm, synthesised with Web Audio (no files, CSP-safe) and unlocked on the first user gesture.

| Sound | When | Character |
|---|---|---|
| `done` | Follow-up/task completed, field created, settings saved, outcome "Held" logged, number fixed | Rising fifth, A5→E6, gain ≤ 0.028 |
| `sent` | WhatsApp confirmed sent, reply logged | Three-note airy lift, G5→C6→G6 |
| `won` | Deal won | Five-note arpeggio, C5→E6 |
| `cleared` | Last follow-up of the day done | Gentle four-note arpeggio |

**Always silent:** clicks, hover, navigation, toggles, theme change, opening panels or WhatsApp, snooze, undo, sign-in, incoming notifications, errors.

Users can turn sounds off (profile + top-bar toggle). Sound is never the only signal.

---

## 7. Component inventory

Built on **Radix UI primitives** (unstyled; for focus, keyboard and ARIA), styled with our tokens. Icons: **Lucide**, 1.8 stroke.

Components: Button (primary / secondary / ghost / WhatsApp / danger), IconButton, SegmentedControl (sliding thumb, re-measured after font load and resize), Switch (bouncy knob), Checkbox-circle (draw-on tick), Input / Select / Combobox, CountryPicker (report 8.4), Chip / Pill / StagePill, Avatar, Kbd, Card, Table (sticky header, inline edit, column picker), Kanban board, Drawer, Sheet (mobile, gesture-driven), Popover, Menu, CommandPalette, Toast / HUD, SaveBar, Skeleton, EmptyState, ProgressRing, Odometer number, Sparkline, and charts (line/area with scrub + morph, funnel, heatmap, donut, bars, leaderboard).

**Charts:** custom SVG components on `d3-scale` + `d3-shape` (no chart library), so we fully control the morph, draw and scrub motion.

---

## 8. Screens

For every screen, the report's permission rules apply: hidden fields are absent, contact data is masked per role.

### 8.1 Sign in / 2FA / first-run
- **Sign in:** glass card with email + password.
- **Errors:** generic ("That email and password don't match") with a card shake and red input ring.
- **2FA:** 6 boxes that auto-advance, accept a pasted code and backspace to the previous box, plus a recovery-code link.
- **Footer:** "Private workspace. Invite only."
- **First-run wizard** and **invite acceptance** reuse this surface.

### 8.2 Today
- **Hero:** date, greeting, and a one-line brief naming the most urgent person. A progress ring shows "n / N cleared today".
- **KPI strip:** 4 KPIs with deltas and sparklines.
- **"Up next" list:** grouped Overdue / Due soon / Later today, with inline WhatsApp and Snooze on hover.
- **Right column:** today's calls (live "in 12 min" dot) and a pipeline mini-funnel.
- **Admins also see:** unassigned leads, sync issues and security alerts.
- **All clear:** the celebration plays.

### 8.3 Leads
- **Table** with filter chips, saved views and bulk actions.
- Masked phones for masked roles. "Needs country code" is shown in amber.
- Kanban toggle, with drag-to-move and required-field/lost-reason prompts.

### 8.4 Lead drawer (and full page)
- **Opening:** from the right, with J/K to move between leads.
- **Header:** avatar, name, source, age, owner.
- **Actions:** WhatsApp (primary, W), They replied, Follow-up (F), Won, Lost.
- **Stage track:** click a segment to move. It fills in sequence and logs to the timeline.
- **Contact box:** masked values with **Reveal**. Reveal blurs into the real value and tells the user it's audited.
- **Next follow-up** with a tick.
- **Details:** custom fields.
- **Activity:** note composer (N) and a colour-coded timeline.
- **Won:** asks for value + package, then plays the petal burst and `won` sound.
- **Lost:** asks for a reason (chips) + note, then closes open tasks and joins the re-engage view.

### 8.5 Notification centre (primary action surface)
- **Where it lives:** a glass slide-over anchored to the bell. The page behind stays usable (no scrim).
- **Groups:** Overdue / Due now / Later today / Updates (sticky, collapsible).
- **Filters:** All / Needs you / Updates.
- **Unread:** blue dot. Hovering 600 ms marks an item read. Mark all read.
- **Item anatomy:**
  - type icon tile + lead avatar
  - title + time
  - one meta line with the urgency word coloured
  - optional chips and message preview
  - inline actions
- **Actions per type:**

  | Type | Actions |
  |---|---|
  | Follow-up | WhatsApp template · Done · Snooze |
  | Reminder message | Preview + Send on WhatsApp · Snooze · Skip |
  | Meeting ended | Held / No-show / Rescheduled |
  | New lead | Fix number (country suggestions inline) · Open |
  | Escalation | Reassign · Remind rep |
  | Sync paused | Fix mapping |
  | Security | Review · End sessions |

- **WhatsApp:** always follows up with "Did it go out? Yes, sent / Not sent".
- **Snooze menu:** 15 min, 1 hour, this evening, tomorrow morning, pick a time.
- **Arrivals:** slide in at the top of their group with a highlight fade. The bell swings and the badge bumps (silent).
- **Full screen:** a button beside mark-all-read, or **F**. It becomes a centred reading column with the same actions. Esc exits full screen, then closes.
- **Keyboard:** `.` toggle, J/K move, E done, S snooze, Enter open, F full screen.
- **Empty state:** the mark + "You're all caught up".

### 8.6 Calendar
Not prototyped. Day / week / month / agenda of lead meetings only, violet event blocks, a live amber "now" line, and click → lead drawer. After a meeting ends, a "Log outcome" item goes to the notification centre.

### 8.7 Send queue
Not prototyped. A focused full-screen mode showing one lead at a time: rendered message, then Send → WhatsApp → "Sent?" → next lead slides in. It has a progress bar, skip / edit / pause, and caps shown plainly. Finishing a queue plays `cleared`.

### 8.8 Analytics
- **Controls:** range 7D / 30D / 90D / custom and a "Compare to previous" switch.
- **Content:** 5-KPI strip (odometer), leads-over-time line with scrub, clickable funnel → glass drill-down sheet listing the leads, best-time heatmap, lost-reasons donut, and a team leaderboard (Revenue / On-time / Win rate) with FLIP re-rank.
- Every number drills down. Revenue widgets are absent without `analytics.revenue`.

### 8.9 Templates
Not prototyped. Library grouped by category. Editor with variable picker, live WhatsApp-style preview against a real lead, and a character count.

### 8.10 Settings (customisation)
- **Layout:** a sub-nav grouped Workspace / Your funnel / People / Connections / Security.
- **Pipeline & stages:**
  - drag-reorder (1:1, rubber-band, neighbours spring aside)
  - colour popover and inline rename
  - Open / Won / Lost segmented control with guardrails (the last Won or Lost stage can't be changed or archived; the row shakes and explains why)
  - automation summary line
  - "Add a stage"
  - live board preview (FLIP on reorder)
- **Fields:** table of fields showing where each one works (Table, Filters, Templates, Analytics). "New field": a type gallery of 13 plain-language types, then a slide-in config (name, options with colours, required-at-stage, show-in-table) with a live lead-card preview. On create: `done` sound, highlighted row, toast.
- **Roles & access:**
  - role chips
  - plain-English permission rows with a switch and an Own / Team / All reach control
  - **Contact details** as three visual choices: Full / Masked with reveal / Hidden
  - HIGH RISK tags, and an auto-appearing "needs two-step login" note
  - **"What this role sees"** live preview (nav items appear and vanish, masking and lead count change)
  - an unsaved-changes HUD bar ("takes effect on their next click")

### 8.11 Phone (reps on the go)
- **Layout:** large-title pages that fold into a translucent nav bar on scroll, and a translucent bottom tab bar (Today, Leads, Calendar, Inbox) with a badge.
- **Gestures on Today rows:** swipe right = done (green reveal, `done`), swipe left = snooze (amber). The commit decision uses momentum projection, with axis-lock hysteresis of 10 px.
- **Tap a row:** opens a bottom sheet (78 % height) with WhatsApp / Replied / Later / Stage and key info. Drag or flick it down to dismiss. The scrim tracks the sheet.
- **Notification centre:** becomes the Inbox tab (full screen by default).
- **Touch targets:** at least 44 px.

---

## 9. Customisation UX principles
1. Plain language only. Never show a slug, JSON or a permission key to an admin (slugs appear small and monospaced only as secondary info).
2. A live preview beside every editor that changes what people see.
3. Anything added (field, stage, template variable) works everywhere automatically, and the UI says so.
4. Guardrails with explanations instead of disabled controls (last Won/Lost, stages with leads, owner lockout).
5. Archive, never delete. History and analytics survive renames and recolours, and the UI says this plainly.
6. Changes to access take effect on the next request, and the save bar says so.

---

## 10. Accessibility and quality bars
- **Standard:** WCAG 2.2 AA.
  - Text contrast 4.5:1 via `-ink` tokens.
  - Focus rings (`0 0 0 4px var(--accent-soft)` + a 1.5 px accent inset) on every control.
  - Full keyboard paths for every mouse or gesture action (swipes have button equivalents).
  - Radix handles ARIA.
- **Colour and sound:** colour is never the only signal (words like "Overdue" accompany red), and sound never is either.
- **Motion:** respect reduced motion, reduced transparency and increased contrast.
- **Performance:** 60 fps on the Hostinger-served build on a mid-range laptop and phone. INP < 200 ms. Animations stay compositor-only.
- **Testing:**
  - Playwright visual snapshots of key screens in both themes (with reduced motion on, to make them deterministic)
  - axe checks in CI
  - a manual motion review in slow motion before each phase demo

---

## 11. Implementation notes (`apps/web`)
- **Styling:** CSS variables for tokens (`styles/tokens.css`, one block per theme) consumed by **CSS Modules**. No Tailwind: the design relies on fine-grained values (0.5 px hairlines, per-size tracking, layered shadows) that read more clearly as plain CSS.
- **Libraries:**
  - **Motion** (motion.dev) for springs, gestures, layout/FLIP and `AnimatePresence`
  - the generated `linear()` easings for pure-CSS transitions
  - Radix UI, Lucide, d3-scale / d3-shape, Inter WOFF2
  - everything bundled; no CDN (strict CSP)
- **Sound:** `lib/sound.ts` with the four synthesised cues. It respects the user setting and only plays after a gesture.
- **Theme:** resolved server-side from the user profile to avoid a flash. `system` resolves on the client with a blocking inline-nonce script.

---

## 12. Out of scope / later
- Box and text alignment polish across prototypes (deferred by the owner, done during build).
- Visual design of Calendar, Send queue, Templates editor and the remaining Settings pages follows this system and will be designed during their build phases, each shown to the owner before it's final.
- Final sound tuning on real devices.
