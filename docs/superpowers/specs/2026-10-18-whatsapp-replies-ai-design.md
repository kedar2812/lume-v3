# WhatsApp replies in LUME, and LUME's first AI (design)

Status: APPROVED to build, 2026-10-18. The owner: "lets assume all scenarios while building, also keep the ui super
simple, follow the industry standard ui design specifics so that everything is predictable and accessible for the
user". Decision 2 (sending from LUME) is taken as yes, since files need it. Decision 1 (the relay route) follows the
recommendation and is only built in part D, so the owner can still change it before then. Items marked *my call* stand
unless the owner changes them.

## 0. What it's for

A studio owner sends a template to 150 leads from LUME, then opens WhatsApp to see who replied and what they said,
then comes back to LUME to type in what happened to whom. He called it "tiring and not worth it". The first client
to ask has a team of six to eight on WhatsApp; many LUME clients will look the same.

This release makes the round trip disappear:

1. A lead's WhatsApp reply arrives in LUME by itself, on that lead, within seconds.
2. LUME says what the reply means ("Interested — wants a site visit Saturday") and offers the next step as one tap.
3. After a call, the rep's messy note becomes a suggested stage, follow-up and reason, accepted with one tap.
4. A lead picked up by someone new gets a three-line catch-up.

Success: after a send to 150 leads, the owner opens Today, sees "38 replied", works through them in one screen with
one tap each, and never opens WhatsApp to find out who said what.

### Rules that bind (from the product, unchanged)

- **A person always sends.** No message ever leaves without a person tapping send. No AI chatbot answers leads.
- **Manual stays the default.** With every switch off, LUME works exactly as today (wa.me links, "Sent?").
- **No client names or client logic in code.** Everything here is a module a client switches on.
- **Lead data leaves the client's server only for integrations the client enabled** (see §3.3 for the one new hop).
- **No over-promising.** Nothing ships as "AI" unless it works on real-style messages (§6.4 test set).
- LUME's voice, LUME's look (Porcelain + Obsidian, one accent blue), and the full-window scrim for sheets.

### UI rule (owner, 2026-10-18)

Super simple and predictable: the patterns people already know from WhatsApp, Gmail and every mainstream CRM, in
LUME's look. A chat thread reads like a chat (newest at the bottom, bubbles left/right, a composer with an attach
button and Send); a suggestion is one card with one primary button ("Apply") and a quiet "Dismiss"; a file picker is
the system's own; lists group under plain headings with counts. No new gestures, no hidden actions, nothing that only
appears on hover. Every control keyboard-reachable with a visible focus ring, labelled for screen readers, 4.5:1
contrast in Porcelain and Obsidian, 44 px touch targets, reduced motion respected. A canvas is drawn for the new
screens before they're built, as every phase.

### Non-goals (this release)

- Bulk-sending templates through Meta's API (it costs about ₹0.86 + GST per marketing message; text templates stay on
  the phone). Single paid media templates are in, under a cost guard (§4.3).
- AI-written follow-up drafts (second release, once reply reading has proven accurate).
- Voice-note transcription (the audio is kept and playable; reading it waits for the model decision, §6.2).
- Broadcasts, chatbots, auto-replies, Instagram DMs.

## 1. The pieces

| Piece | Where it runs | Needs Meta approval |
|---|---|---|
| A. AI foundation: one provider plug, hourly and weekly limits, audit | client's LUME | no |
| B. Call notes → pipeline suggestion | client's LUME | no |
| C. Catch-up summary | client's LUME | no |
| D. WhatsApp connection (Embedded Signup, coexistence) | connect relay + client's LUME | yes (live); test numbers before |
| E. Replies on the lead + "who replied" board | client's LUME | yes (live) |
| F. Reply reading: meaning, dates, stop requests | client's LUME | needs E |

**Build order** (*my call*): A → B → C ship first (no Meta wait; the owner can sell AI now), D → E → F built against
Meta's test numbers while verification runs, released when Meta approves.

## 2. AI foundation (A)

### 2.1 One plug, any provider

- `packages/core/src/ai/` defines `AiProvider`: one call, `read(task, input) → structured result`, where each task
  (`reply_meaning`, `call_note`, `catch_up`) has its own fixed instructions and an output schema (zod). The provider
  returns JSON that must validate against the task's schema; anything else counts as "LUME couldn't read this" and the
  person sees no suggestion (never a half-suggestion).
- First adapters: Anthropic (Claude) and Google (Gemini). Which one, and which model, is a setting on the instance
  (`.env`: `LUME_AI_PROVIDER`, `LUME_AI_MODEL`, `LUME_AI_KEY`), chosen by the §6.4 test, not in code.
- The same shape as `MessageChannel` (`apps/api/src/messaging/channel.ts`): callers never know which provider runs.

### 2.2 Switches and limits

- **Business switch:** Settings → Integrations → "LUME AI", off by default, admin only. Copy says plainly that the text
  of notes and replies is sent to the AI provider to be read, and isn't used to train it.
- **Plan modules:** `ai` and `whatsapp` join `PLAN_MODULES` (Control each client). A plan can leave them out. The plan
  claim's schema is strict, so a LUME from before this release would refuse the new keys: they're signed only for a
  LUME that lists a new capability (`accepts: ["plan2"]`); an older licence server sends none and both count as
  included (the existing "absent = included" rule).
- **Limits, Claude-style (owner, 2026-10-18: "follow claude's ai allowance, the weekly and hourly limit type design and
  notify the user about the limits"):** each AI call counts one read, per business. Two limits from the plan:
  - **hourly** (`aiReadsHourly`): a rolling 60 minutes; at the limit AI pauses until the oldest read in the window is
    an hour old;
  - **weekly** (`aiReadsWeekly`): resets every Monday 00:00 on the business's clock.
  null = no limit. *My call* defaults: team plan 100 an hour / 750 a week; solo plan 40 / 250.
  - **Telling people:** a meter in Settings → Integrations → LUME AI ("This week: 640 of 750 · resets Monday 12:00
    am"; "This hour: 12 of 100"); admins get one bell notice at 75% and one at 90% of the week, and one when either
    limit is reached; where a suggestion would appear, everyone sees "LUME AI has reached this hour's limit. It's back
    at 3:40 pm." / "…this week's limit. It's back Monday." Coming back says nothing; it just works. Replies and notes
    keep arriving and saving throughout.
- **Spend cap at the provider:** each client gets its own provider key in its own workspace/project with a hard monthly
  spend limit, so one busy client can never surprise the owner's bill. Set at provisioning (runbook).

### 2.3 What's kept

- Every AI call writes one row: task, lead id, model, input/output token counts, cost estimate, accepted/edited/
  dismissed, latency. No message text in that row (the text already lives on the lead). Feeds the allowance and the
  licence dashboard's per-client AI cost (health check-in: counts only, never text).
- A suggestion is never applied without a tap. Accepting writes the normal activity (stage move, follow-up) with
  `via: "ai_suggestion"` so analytics can tell them apart.

## 3. WhatsApp connection (D)

### 3.1 Owner's one-time setup (runbook, not code)

Udyam registration in the name LUME → Meta Business portfolio verified → one Meta app "LUME" with WhatsApp →
Embedded Signup configured for **existing WhatsApp Business app numbers (coexistence)** → app review for
`whatsapp_business_management` and `whatsapp_business_messaging` → Tech Provider. The app secret lives only on the
connect relay (connect.lumecrm.in), like Google's client secret.

### 3.2 A client connects (Settings → Integrations → WhatsApp)

1. Admin switches the WhatsApp module on, taps **Connect a WhatsApp number**. LUME opens the relay's signed start
   (same pattern as Connect with Google, `apps/connect/src/relay.ts`), which opens Meta's Embedded Signup.
2. The admin logs in to Facebook, picks "connect my existing WhatsApp Business app number", scans the QR code with the
   phone that runs the number, and chooses whether to share past chats.
3. The relay exchanges Meta's code for a business token **scoped to that client's WhatsApp account only**, seals it
   with the instance's token and hands it back, as the Google hand-back does. The client's LUME stores it encrypted
   (keyring, bound to the number's id).
4. LUME subscribes the number to: `messages`, `smb_message_echoes`, `history`, `smb_app_state_sync`.
5. Each number belongs to one LUME person ("Anusha's WhatsApp") or to the business ("Studio number"). A team can
   connect several numbers; people who never connect keep today's flow.

Before connecting, the screen says what changes on the phone: broadcast lists stop working, WhatsApp for Windows
stops working (use WhatsApp Web), and the phone must open the app at least every 13 days.

### 3.3 How a message travels — Decision 1: through the relay

Meta signs every webhook with the app secret. Two ways:

- **(Recommended) Through the relay.** Meta → relay (checks Meta's signature, stores nothing, looks up which instance
  owns the number) → the client's LUME through its own signed intake (the existing `/webhooks/in` pattern: per-source
  HMAC, rate limits, dedup). The app secret stays in one place. Message text passes through the relay in memory only.
  The relay's docstring and the privacy policy change: "WhatsApp messages pass through LUME's relay on their way to
  your LUME; they are never stored there."
- **Straight to each client.** Per-number webhook override to the client's own address. Needs the app secret on every
  client server to check signatures; anyone holding it could fake messages into other clients' LUMEs. Not recommended.

To verify while building: that per-number overrides carry `smb_message_echoes` and `history` too, and how Meta signs
routed deliveries.

### 3.4 Replying from inside LUME — Decision 2: yes

Meta allows free replies within 24 hours of the lead's last message (first 1,000 a month per number free; then about
₹0.12 + GST each, reported, to verify). If allowed, the lead's WhatsApp panel in LUME gets a reply box; the message is
sent through Meta with the client's token and also appears on the phone. A person still types and taps send.
It changes LUME's line "your own WhatsApp, no API" (marketing updates it when this ships). Admin switch, off by default.

## 4. Replies on the lead (E)

### 4.1 Matching

- Incoming `messages`: match the sender's number (E.164, the existing normalisation) to a lead the number's owner can
  see, then to any lead in the business. Saved as a `whatsapp_received` activity on the lead (text, media reference,
  WhatsApp message id for dedup, the connected number it came to).
- `smb_message_echoes` (sent from the phone): saved as `whatsapp_sent` on the matched lead. When a "Sent?" question is
  pending for that lead and number, the echo answers it — the person never taps "Yes, sent" again.
- **Unknown numbers** (*my call*): never become leads by themselves (a business number also carries suppliers, family,
  staff). They wait in "Not a lead yet" for 14 days, where a person taps "Make it an enquiry" or "Not a lead". After 14
  days unmatched messages are deleted. AI never reads them.
- **History sync:** past chats are kept only for numbers that match a lead; the rest are dropped on arrival.
- **Media** (photos, voice notes, documents): downloaded with the client's token to the client's server (Meta's links
  expire), shown and playable on the lead. 25 MB per file, *my call*.

### 4.2 Where people see it

- **Lead drawer:** a WhatsApp thread section (newest at the bottom), with the AI meaning under each reply (§5).
- **Today:** a "Replies" tile already exists in the layout; it becomes live: "38 replied since your send", opening the
  board.
- **Who replied board** (from the send-queue run and from Today): replies grouped by meaning — Interested, Asked the
  price, Wants a visit or call, Later, Not interested, Stop messaging, Wrong number, Not sure. Each group has its
  bulk action (move stage, set follow-up, mark lost with reason, do not contact), with Undo, using Phase 7's bulk engine.
- **Notifications:** a reply on your own lead notifies you (respects existing notification preferences).

### 4.3 Sending images and PDFs (every case: new leads and leads already chatting)

- **File library:** Settings → Messaging gains Files: the business uploads brochures, price lists, portfolio photos
  once (kept on the client's server; images ≤ 5 MB, PDFs ≤ 100 MB, video ≤ 16 MB — Meta's limits, to verify). A
  template can carry one file ("First hello + brochure").
- **The send sheet picks the route per lead, and shows it before Send:**
  - lead wrote within 24 hours → the file goes through Meta as a real attachment (free within the service allowance);
  - older than 24 hours → only as a media template Meta has approved (a header image or document), shown with its
    cost (about ₹0.86 + GST for a marketing message), or the sheet suggests waiting for the lead's reply;
  - WhatsApp not connected (manual clients) → LUME adds a short link to the file to the message text, served from the
    client's LUME by an unguessable link that can be switched off — works with today's tap-to-send.
- **Media templates:** created in LUME, submitted to Meta from LUME, status shown (pending / approved / rejected with
  Meta's reason). Only approved ones can be picked.
- **Cost guard:** paid template sends count against a weekly plan limit (like AI reads); at the limit LUME stops offering
  paid sends for the month and says why. A person always picks the file and taps Send.

## 5. Reading replies and notes (F, B, C)

### 5.1 Reply meaning (F)

For each reply on a lead (AI switch on, allowance left), one AI read returns: the meaning (one of the groups above),
a one-line summary, any date or time the lead named, any stop request, and the suggested next step drawn only from
actions LUME has (move to stage X, follow up on date Y, book a meeting, mark lost with a reason from the business's own
list, do not contact). Shown on the lead and on the board; one tap applies.

- **Dates and promises:** "call me after Diwali", "site visit Saturday 11" → a suggested follow-up or meeting at that
  time on the business's clock; vague dates ("after Diwali") are resolved against the calendar year and shown as the
  actual date for the person to confirm.
- **Stop requests:** "don't message me", "remove my number", in any language → the lead is marked do-not-contact at
  once (this one is applied without a tap, *my call*, because it protects the client's number; it's shown and undoable).
  Templates refuse to open for a do-not-contact lead. Do-not-contact is new: a lead flag with who set it, when and why
  (a person, or a stop request), shown on the lead and as a filter, and cleared only by a person.

### 5.2 Call note → pipeline (B)

After Log a call, or on any note, a "Suggest next step" action (and automatically after Log a call when AI is on):
stage, follow-up date, objections (from a fixed list the business can edit), decision-maker named. One tap accepts all,
or each can be untoggled. Text notes only in this release.

### 5.3 Catch-up summary (C)

On a lead that was reassigned or untouched for 14+ days, the drawer offers "Catch me up": three lines from the lead's
history (who they are, where it stands, what was promised). Generated on request only, never in bulk.

### 5.4 The AI's hard rules

- Uses only facts in the lead's record and the business's own settings. Never invents prices, dates, offers or urgency.
- Never writes to a lead. Never applies anything except do-not-contact without a tap.
- Every suggestion says where it came from ("From Sneha's reply at 4:12 pm").
- If the read fails, the screen shows no suggestion and says so once; at a limit it says which limit and when LUME AI is back (§2.2).

## 6. Cost, choice and checks

### 6.1 Expected cost per client per month (busy team, ~3,000 replies)

Meta: ₹0 for incoming replies and phone-sent messages; ₹0–300 for replies sent from LUME (if allowed).
AI at a cheap model: about ₹100 (Claude Haiku 5.5) to about ₹2,400 (Sonnet 5.5) — kept inside the plan's allowance.

### 6.2 Model choice (decided later by the owner, with §6.4's numbers)

Candidates: Claude Haiku 5.5, Gemini Flash-Lite. Gemini can hear voice notes itself; Claude needs a separate
transcription step. The owner picks after the test; switching later is a setting.

### 6.3 Privacy and security

- Lead text goes to the AI provider only with the AI switch on; paid API tiers only (never a free tier that may train
  on data). Privacy policy names the provider.
- WhatsApp tokens sealed with the keyring; never in logs, exports or health check-ins.
- Do-not-contact is enforced server-side (templates, queue runs, and the reply box).
- RLS: WhatsApp activities are lead activities and follow lead visibility; "Not a lead yet" is visible to the number's
  owner and to admins.

### 6.4 The test set (gate before any AI ships)

About 200 realistic replies and 50 call notes, written fresh (no client data): English, Hinglish, Telugu-English,
Marathi-English; prices, visits, dates ("after Diwali", "next Saturday"), refusals, stop requests, wrong numbers, one-
word replies, emojis. Each with the expected meaning and next step. A model ships only above 90% on meaning and 100%
on stop requests. The set lives in the repo and runs as an eval (paid, the owner approves the spend).

## 7. Testing and release

- Unit and integration tests as every phase (TDD). Meta faked in tests (signed webhooks, Embedded Signup hand-back),
  like `google-fake.ts`. AI faked by a provider that returns fixed answers; the real model only in the §6.4 eval.
- e2e: connect (fake), a reply arriving, the board, bulk actions, Sent? answered by an echo, do-not-contact.
- Release: A–C to the demo, then clients who switch AI on. D–F on Meta's test numbers → demo → first client.

## 8. Left to the builder

Table and column names, the exact prompts per task (inside §5.4's rules), retry/backoff for Meta and the provider,
board layout details within LUME's design language (canvas before UI, as every phase), the relay's instance lookup
store, and the wording of every screen in LUME's voice.
