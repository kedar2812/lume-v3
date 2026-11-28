# LUME's icons

Owner, 2026-11-25, on the ready-made flows board: "make sure we follow this exact icon system across lume i love it its
very professional". This is that system. Every screen follows it; a screen that doesn't is a bug.

## The rules

1. **Lucide, as drawn.** Icons come from `lucide-react` (already a dependency): the 24 grid, a stroke of 2, round ends
   and joins, `currentColor`. Never redrawn, never re-weighted, never mixed with another set.
2. **An icon says what the thing does.** A link is a chain link, a booking is a calendar with a tick, a giveaway is a
   gift. Never a generic shape, a coloured dot or a letter standing in for meaning, and never an emoji.
3. **One meaning, one icon, everywhere.** The same action or idea uses the same icon on every screen. The registry is
   `apps/web/src/components/ui/icons.tsx`: take the icon from there; add a meaning there before using it anywhere.
4. **Colour comes from where it sits, not from the icon.** Icons are the text's colour. A tile behind an icon is
   neutral (`--sunk`, a hairline); the chosen or active one is the accent with a white icon. No tinted blobs, no
   rainbow of categories.
5. **Sizes**, beside text of each size: 14 (small labels, chips), 16 (buttons, rows, cards), 18 (tiles, headers).
   The stroke stays 2 at every size.
6. **A button that is only an icon has a name** (`aria-label`), and the icon itself is `aria-hidden`.

## The only exceptions

- LUME AI's Loop and Live sheets' mark (`components/shell/icons.tsx`): LUME's own, drawn in the same line style.
- Another company's own logo (Instagram, WhatsApp, Google, Calendly): its official file, unmodified, from
  `public/brand`.

## The registry today

| Group | Meaning → icon |
|---|---|
| What starts a flow | comment → MessageCircleMore, DM → MessageSquare, story reply → CircleDot, story mention → AtSign, ad → Megaphone, first message → MessageSquarePlus |
| Flow steps | message → MessageSquare, ask → MessageCircleQuestionMark, check → GitBranch, split test → Split, wait → Timer, update the lead → UserPen, tell my team → BellRing, go to another flow → Forward, hand over → Handshake, book a call → CalendarCheck, ends → CircleStop |
| Ready-made flows | link → Link, freebie → FileDown, story reply → Reply, story mention → AtSign, ad greeting → Megaphone, welcome → Hand, price → Tag, qualify and book → CalendarCheck, discount → Percent, waitlist → Hourglass, common questions → MessageCircleQuestionMark, appointment → Clock, feedback → Star, event → Ticket, giveaway → Gift |
| Calendar (2026-11-28) | agenda → List, week → CalendarRange, log how a call went → ClipboardCheck, no-show → UserX, rescheduled → CalendarClock, a lead → UserRound, add as a lead → UserRoundPlus, link to a lead → Link (the existing link), copy → Copy (the existing copy), read but never kept → EyeClosed |
| The sidebar | Today → Sun, Leads → Users, Who replied → MessageCircle, Chat → MessagesSquare, LUME AI → the Loop, Flows → Workflow, Pipeline → Columns3, Live sheets → its mark, Calendar → CalendarDays, Templates → Mail, Media → Image, Analytics → BarChart3, Settings → Settings (`components/shell/icons.tsx`) |
| Everywhere | close → X, back → ChevronLeft, versions → History, test/play → Play, done → Check, messages arriving → Inbox, kept private → Lock, inside a platform's rules → ShieldCheck, watch out → TriangleAlert, leaves LUME → ArrowUpRight, make a new one → Plus, search → Search, good to know → Info (`UI_ICONS`) |

## Moving the rest of LUME onto it

About 150 files still draw their own SVGs (several grids and stroke weights). They move over screen by screen, each
reviewed against its screenshots: the flow builder first (done 2026-11-25), then the Instagram screens as they are
built, then the shell, Leads and the lead drawer, Today, Pipeline, Calendar, Settings, Analytics, and the rest.
