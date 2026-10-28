# LUME AI page: the approved redesign

**Design:** canvas https://claude.ai/artifact/WUN8J8wBCaLfYyerbFoJLy, approved by the owner on 2026-10-28 ("build it
perfectly"). Five artboards: 1 a run going live, 2 a lead that needs you, 3 on a phone, 4 first visit, 5 LUME AI is off.

**Goal:** the Autopilot screen (`/autopilot`, named LUME AI) becomes two plain panes, like Mail. On the left, the leads,
filtered Needs you / Ready / All. On the right, the conversation, with LUME AI's "Why" line and, where a person is
needed, one bar with what to do. The run's header says where things stand in one line. The first visit shows the work
that's waiting instead of a pitch. No backend change: every number and action already exists.

**Rules from the owner's feedback:** no stat tiles, no coloured avatars, no chips row, no glows, no numbered steps,
no third column. One blue; amber only for Needs you. The Loop draws itself only where LUME AI is working (the status
line while it works, the reply being written); still elsewhere; grey and slow on the "off" page.

## Edge-case sheet (docs/QUALITY_PROCESS.md §1)

- People: the person who started the run or an admin controls it (`canControl`); others watch. A rep sees only their
  own leads (the API already scopes). Someone who may not message a lead gets no Take over.
- Time: "when" words on the business's clock (`whenWords`); a run paused by Esc, by the month, quality, number, paid.
- Concurrency: an ask approved after the lead moved on answers 409 ASK_GONE (A3): said in words, the list refreshes.
- Outside world: the stream (`useAutopilot`) refreshes the run; a failed read says so with the run still shown.
- Data: no runs; one run; many runs (switcher); a run with every lead skipped; 0 in a filter ("Nobody needs you").
- Screens: 375 px phone (list, then the conversation with Back); Porcelain and Obsidian; reduced motion (the Loop
  rests drawn); keyboard (filters as a segmented control, rows as buttons, Esc pauses outside boxes); loading
  skeletons; error line; screen reader names on every control.
- Copy: speaks as LUME, no em dashes, no promises the product can't keep.

## Tasks

1. **Words** (`lib/autopilot/words.ts`): `leadLine(lead, ask, when)` → `{ text, dot }` for each state;
   `filterOf(state)` and `leadsIn(filter)`; the header line `runLine(detail)`. Pure, unit tested.
2. **Leads pane** (`LeadPane.tsx`, replacing `LeadList`): the filter (Needs you n · Ready n · All n; opens on Needs you
   when anyone needs you), rows with neutral initials, name, when, dot and one line; the one LUME AI is on marked;
   skipped folded at the end with why. Tested.
3. **Conversation pane** (`LiveConversation.tsx` refit): header with name, one line of context, Open lead, Take over
   while LUME AI works; the thread; "Why" at the foot while it works; the action bar: an ask (its message, Send it /
   I'll reply), a lead that needs you (why, Reply yourself, and Let LUME AI carry on in quiet text), a ready lead (the
   headline, Take over). Arrival toasts move from `ReadyColumn` to the screen. Tested.
4. **Header** (`RunHeader.tsx`, replacing `RunBar`): run name, status line (Loop drawing while it works), "Following up
   with N leads · M messaged · R replied" or the pause/done words, Pause all (Esc) / Resume, End run (asks first), New
   run (to Leads), the run switcher when there's more than one. Tested.
5. **Screen** (`AutopilotScreen.tsx`): header + one card of two panes; a phone shows the list, a tap opens the
   conversation with Back; the paused veil stays. Tested.
6. **First visit** (`WaitingWork.tsx`): which leads (No reply 3+ days, New today, All open, from the starter views'
   filters), the first 8 with their stage and when last heard, untick to leave out, "N more", the first message the top
   lead would get (`templateState`), what LUME AI may do (the standing choices), and "Follow up with these N", which
   opens the start sheet with that selection. When LUME AI isn't ready (no number, no templates), it says why with the
   fix. Tested.
7. **Off** (artboard 5): the grey Loop drawing slowly (`AiGlyph tone="muted"`), the admin's switch and the
   non-admin's line. Tested.
8. **Styles** (`live.module.css`): tokens only, both themes, phone width, reduced motion.
9. **Gate**: e2e `autopilot.spec.ts` follows the new screen; a11y in both themes; the layout sweep; visual baselines
   reviewed and refreshed; full gate; push.
