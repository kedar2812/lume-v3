# Instagram screens (1C Part D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every approved Instagram screen in LUME, wired to the 1A/1B/1C API: connecting an account, the conversation on the lead, flows and the ready-made ones, Not a lead yet, Who replied and Analytics.

**Architecture:** Each screen mirrors its WhatsApp twin where one exists (`WhatsAppCard`, `WhatsAppConnected`, `WhatsAppThread`/`WhatsAppComposer`), so a person who knows one knows the other. A typed `instagramClient` in `apps/web/src/lib/instagram/` is the only way the screens talk to the API. Icons come only from `components/ui/icons.tsx` (docs/design/icons.md).

**Tech Stack:** Next.js, React, CSS modules, lucide-react, vitest + Testing Library, Playwright + axe; Fastify/zod/Postgres where an API gap is closed.

**Spec:** Canvas https://claude.ai/artifact/KJJDFJ7wddubXwRuked4m9 (boards Main, Connect, Thread, ThreadDark, Phone, Replies, NotYet, Analytics, Flows, NewFlow; all approved); `docs/superpowers/specs/2026-11-22-instagram-lume-ai-design.md` §4; the flow builder plan `2026-11-23-flow-builder.md` (Part D, D7 table); owner 2026-11-25: "finish team chat then build the instagram screens ... the connection will happen via settings -> integrations -> instagram".

## Global Constraints

- The connection lives in Settings → Integrations → Instagram (owner 2026-11-25). The relay hands back to `/settings/integrations/instagram/connected?p=&s=` (apps/connect/src/instagram.ts:342).
- Instagram's rules as the API enforces them: a business answers within 24 hours of the person's last message (7 days after an ad click), a person (never a flow or LUME AI) up to 7 days with the human agent tag, one private reply per comment within 7 days, 1,000 characters, nobody messaged first.
- No over-promising (memory): **LUME AI answering Instagram is not built yet** (a flow's "Hand to LUME AI" only tells a person). The "Who answers new DMs: LUME AI" choice, the LUME AI chip and its explainer stay off these screens until Part E builds it; the board's other copy ships as approved.
- No ManyChat names, look or copy (flow builder plan, Global Constraints). The Connect warning about ManyChat on the same account ships as approved (it names a product the business may use; it doesn't copy it).
- Icons: Lucide from the registry; other companies' logos only from `public/brand`, unmodified.
- Copy speaks as LUME, no em dashes, no "we", no guessed pronouns; a handle shows masked exactly as the API masks it.
- Nothing overflows at 375/768/1280/1440 in Porcelain and Obsidian (owner: no overflow).

## Review Focus

The edge-case sheet (docs/QUALITY_PROCESS.md §1), line by line; each "yes" is a named test in its task.

1. **A connect that comes back wrong**: the hand-back opened twice, a refresh on it, its link expired, signed for another LUME, a personal account, the sign-in cancelled, or someone without `integrations.manage` landing on it. Each says what happened and how to fix it, completes at most once, and never leaves `?p=` in the address.
2. **Masking and access**: a rep without `leads.contact.full` sees `@pr•••` in the drawer, Who replied and Not a lead yet, never the whole handle; someone who can't send sees the conversation without a composer; a person without `integrations.manage` never sees the card's controls.
3. **The window**: open, under an hour left, closed for flows but open for a person (human agent, up to 7 days), closed for everyone, and an ad's 7 days. The composer says which, and Send is refused with the reason, never sent and failed.
4. **Two people on one conversation**: one takes over while the other is typing; a flow or reply lands while the composer has text; a send retried after a dropped connection goes once (clientKey).
5. **Many and long**: 10 accounts, a 2,000-message thread, names and handles at Instagram's 30/150-character limits, emoji and right-to-left names, a card on a 375 px phone.

Lines that don't apply: Time zones and midnight (the API returns instants; screens use the person's zone, as WhatsApp's): n/a beyond existing helpers. The licence: covered by `inPlan` exactly as WhatsApp's card is (tested in D1).

---

### Task D1: Settings → Integrations → Instagram (boards Main, Connect)

**Files:**
- Create: `apps/web/src/lib/instagram/client.ts`, `apps/web/src/lib/instagram/types.ts`
- Create: `apps/web/src/components/integrations/InstagramCard.tsx` (+ `.test.tsx`), `InstagramConnected.tsx` (+ `.test.tsx`)
- Create: `apps/web/src/app/(app)/settings/integrations/instagram/connected/page.tsx`
- Modify: `Integrations.tsx` (render the card), `integrations.module.css`, `apps/web/src/lib/sheets/types.ts` (`instagram` on IntegrationsView), `apps/web/src/lib/first-run.ts` (the connected page is not a first-run page)
- Test: `apps/web/e2e/instagram.spec.ts` (new)

**Interfaces:**
- Produces: `instagramClient.{setEnabled(enabled), connect(): {url}, complete({p,s}): {accounts}, accounts(): {accounts}, setAccount(id, {ownerId?, newDmCreatesLead?}), disconnect(id)}`; `IgAccount = {id, username, name, owner: {id,name}|null, status: "active"|"needs_attention", problem: string|null, newDmCreatesLead: boolean, limits, sourceId, connectedAt}`.

Behaviour, as the boards say it:
- Card head: the Instagram logo (`public/brand`), "Instagram", the summary ("Not connected yet", "1 account connected", "2 accounts connected"), the switch. Not in plan / relay not set up: said as WhatsApp's card says it, switch off and still.
- On, none connected: "Turn Instagram comments and DMs into leads" + Connect an Instagram account.
- Connect sheet (board Connect, "before"): the three points and the ManyChat warning, Cancel / Continue to Instagram (same window, as WhatsApp: no pop-up for a blocker to eat; my call). The "waiting" board state becomes the connected page's "Finishing connecting…".
- Each account: `@username`, its name, "Connected <date>", Whose account (The business / a person), New people who write (Become leads / Wait in Not a lead yet, with the board's note), Disconnect (confirm sheet: what stops, what stays). `needs_attention`: the problem and Connect again.
- Foot: Connect another account, Not a lead yet, Flows (`/instagram/flows`).
- "Who answers what": items 1 and 2 as approved; item 3 reads "Your team, for everything else" (Part E adds LUME AI).

- [ ] **Step 1: Failing tests** `InstagramCard.test.tsx`: summary for 0/1/2 accounts; not in plan says so and the switch is disabled; switching on calls `setEnabled(true)` and shows the empty state; Connect sheet shows the three points and goes to the returned url; Whose account sends `ownerId: null` for The business; New people sends `newDmCreatesLead: false` and the note changes; Disconnect asks first and Cancel sends nothing; `needs_attention` shows the problem and Connect again; a failed load says so with Try again; no LUME AI choice is on the card. `InstagramConnected.test.tsx`: completes once under React strict double effects; strips `?p=&s=`; toasts "Instagram connected" with `@username`; CONNECT_EXPIRED / CONNECT_INVALID / no params each say how to start again.
- [ ] **Step 2: Run them, watch them fail** (`npx vitest run apps/web/src/components/integrations/Instagram`).
- [ ] **Step 3: Build the client, card, connected page.**
- [ ] **Step 4: Tests pass; mutation: drop the `once` guard → "completes once" goes red; drop the `inPlan` check → "not in plan" goes red.**
- [ ] **Step 5: e2e** `instagram.spec.ts`: the card off/on/connected (fake relay hand-back signed by the test relay token, as whatsapp.spec does), axe, no overflow at 375 and 1440, both themes, screenshots reviewed.

### Task D2: The lead drawer's Instagram tab (boards Thread, ThreadDark, Phone)

**Files:** Create `components/leads/drawer/InstagramThread.tsx`, `InstagramComposer.tsx`, `instagram.module.css` (+ tests); modify `LeadDrawer.tsx` (tab beside WhatsApp, shown when the lead has threads), `lib/instagram/client.ts` (`leadThreads(id)`, `send(id, body)`, `privateReply(commentId, body)`, `takeOver(threadId)`, `handBack(threadId)`).

Behaviour: messages by day; in/out bubbles as WhatsApp's; what came with a message (story reply's thumb, ad referral, comment it answered, a flow's buttons and quick replies, "Unsent"); the driver chip (Flow: <name> · You · Your team) with Take over / Hand back; the window line ("Open for 23 hours", "Only a person can answer, until <date>", "Instagram's 24 hours ended"); composer up to 1,000 characters with Enter to send, refused with the reason when closed; a comment with no reply yet offers its one private reply. Several accounts: one thread per account, a switcher.

Tests (named for the Review Focus lines): masked handle; no composer without `messages.send`; window states 3a–3e; take over while typing keeps the text; retry sends the same clientKey; a 2,000-message thread renders the latest page; 375 px no overflow.

### Task D3: Flows list (board Flows) at `/instagram/flows`

Files: `app/(app)/instagram/flows/page.tsx`, `components/flows/FlowsList.tsx` (+ test), sidebar item under Instagram's module. Each flow: name, trigger (TRIGGER_ICONS), live/draft/off, last 7 days' numbers from `flow-stats`, open → builder. Empty: "No flows yet" + New flow. Tests: each state; a flow with no runs shows dashes, never NaN; archive asks first.

### Task D4: Ready-made flows and the New flow sheet (plan 2026-11-23 Task D7, board NewFlow)

Files: `packages/core/src/instagram/templates.ts` (+ test), `flow-routes.ts` (`/flows/templates` returns them), `components/flows/NewFlowSheet.tsx` (+ test). The 15 templates as graphs; tests exactly as Task D7 lists them (valid graph, publish refused until links filled, each runs end to end, Meta's limits hold); the sheet's search, groups, preview and Use this flow.

### Task D5: Not a lead yet with Instagram (board NotYet)

Files: `components/leads/not-yet/*` (Instagram rows beside WhatsApp's from `/instagram/inbox`), Make a lead / Ignore, paging by `before`. Tests: masking, empty, paging, a person made a lead elsewhere meanwhile (404 → removed with a note).

### Task D6: Who replied and Analytics with Instagram (boards Replies, Analytics, and the Flows board's charts)

**Split (2026-11-25, my call):** D6a Who replied (meaning reads, `replyBoard` channel + `flow_passed`, the screen;
migration 0133) and D6b Analytics (the endpoint, the Instagram tab, the Flows page's charts), each gated and pushed on
its own. Calls made in D6a: a reply said to a flow still running or waiting on that conversation (or the keyword that
started it) is the flow's: marked `inFlow` on the activity at receive, never read by LUME AI and not listed (a lead
whose newest reply was the flow's is the flow's); a tap on a button is never read; the meaning queue keeps its name
(`whatsapp.meaning`, in-flight jobs survive an update) and reads either channel; the board's empty copy says "No replies
since" for All. After the fresh review: a quick-reply tap is never read either (a button's words); Instagram's history
for a read includes what LUME sent (the outbox's words, through `instagram_confirmed_sent`); a lead who asks to stop
after a hand-off is under Stop messaging, not passed; "until" in a row says the time ("until today at 3:30 pm"). The box's first run: the
`inFlow` mark is written with the activity, after the flow has had the message (activities are append-only; an
UPDATE failed and held every message a flow took). D6a and D6b went out as one commit (one gate). Calls made in D6b: a
conversation is a thread started in the range; what started it is kept when an ad click comes later
(`source.start`); "new leads" are leads made from the conversation; leads, calls, wins and money count each lead once;
the funnel follows the new leads (no "answered in time" step: only conversations on a lead can be timed); a viewer
whose leads.view is narrower than their analytics reach is refused in words; Who answered has no "became leads"
column (an answer needs a lead); no drill-downs, notes or Flows page charts yet (D6b-2).

**API first.**

- `apps/api/src/modules/whatsapp/meaning.ts` → a channel-neutral `readMeaning(activityId)`: the reply and the last 12
  messages of ITS channel (`whatsapp_received/_sent` or `instagram_received/_sent`), run as the account's `run_as` /
  the number's. Instagram's receive (`process.ts`) enqueues it for a lead's DM with words, exactly as WhatsApp's does:
  never for a lead in a LUME AI run, never twice (the `ai_reads` row), never for an echo or an unsend. It costs AI
  reads like WhatsApp's; LUME AI off means none are read and every reply is Not sure (as today).
- `replies.ts` `replyBoard(req, since, channel: "all" | "whatsapp" | "instagram")`: each lead's latest reply on either
  channel, with `channel`, its window now (`instagramWindow` / WhatsApp's 24 hours: `{ state, until }`), the owner's
  name and where the lead came from. One new group, **`flow_passed`**, before the meanings: a lead whose latest
  Instagram run ended `handed` after their latest reply and whom no person has answered since (no `instagram_sent`
  by a person, no take-over after it), while a person may still answer. `REPLY_MEANINGS` stays as it is; the new group
  is the board's, not the model's.
- Analytics: `GET /api/v1/analytics/instagram?days|from&to` (the business's days, `statsRange` rules): conversations
  started by trigger kind per day (the chart), the totals of the Flows board's tiles (finished, first answer median
  from `instagram_received.at` to the first `instagram_sent` after it, passed to your team, your team's answer
  median, 24 hours ran out, asked to stop), where people stop (each flow's step counts, its biggest drop), and the
  posts and ads that started them (`media_id`/`ad_id` with counts; titles only where LUME has them). One query per
  part, each over the `(flow_id, kind, at)` and activity indexes. Scale test at 1M events on the scale box.

**Screens.**

- Who replied: the channel filter (All · WhatsApp · Instagram) and each row's channel mark and "N hours left to
  answer" / "Instagram's 24 hours ended · a person can answer until …"; the group "A flow passed these to you" with
  the flow's name and why. "Let LUME AI handle these" stays WhatsApp-only until Part E.
- Analytics → an **Instagram** tab (board Analytics) without the "Who answered: LUME AI" row until Part E; the Flows
  page gains the board's chart, funnel, posts and notes from the same endpoint.

**Tests (named for the Review Focus):** a lead with replies on both channels is listed once, under its newest; the
channel filter; masking of handles in rows; the flow_passed group: in, then out once a person answers or takes over,
and never after the 7 days; meaning never read for a lead in a LUME AI run; the analytics medians with an empty range
(dashes, never 0 or NaN); the business's day boundary in a zone east and west of UTC; 1M-event scale reads under the
bar.

## Part E (its own plan, next): LUME AI answering Instagram

Who answers new DMs (team | LUME AI), the standing run per account, Hand to LUME AI starting exactly one run, never after 24 hours, never the human agent tag, the allowance falling back to the team. Then the LUME AI pieces of D1, D2 and D6 switch on.

## Finish

- [ ] Each task: full gate (`dev.sh test-db clean`, no stale toolbox first), fresh reviewer, fixes, push on its own.
