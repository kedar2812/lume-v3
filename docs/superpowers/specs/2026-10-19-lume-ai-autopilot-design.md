# LUME AI Autopilot (design)

2026-10-19. Owner's brainstorm, with live mockups (`.superpowers/brainstorm/881-1792422345/content/`:
`autopilot-live-v3.html`, `autopilot-start-v4.html`). Builds on `2026-10-18-whatsapp-replies-ai-design.md` (W1 replies
in LUME, W3a reply from LUME, LUME AI's foundation) and keeps every rule there unless this document says otherwise.

## 0. What it's for

A business picks a set of leads and lets LUME AI work them on WhatsApp: the first message, the follow-ups, and the
conversation once a lead replies, written as one of the team, towards a goal the business chose. It works in the open.
The person watches it type and send, lead by lead, can pause everything with one key and can take over any lead by
starting to type, the way you interrupt Claude Code in auto mode. When a lead reaches the goal, or needs a person,
LUME AI brings them to "Ready for you" and asks: take over, or let LUME AI carry on?

The owner, in their words:

- "let ai send messages to these 50 leads by itself and follow up on them as well"
- "if someone wants to send auto dms then why not, simplifies the job and pays the money too"
- "do it live so that the user can interrupt in between if required, like claude code's auto mode, the ai will keep
  talking to leads as a human after the lead replies as well, and inform the owner that these leads have converted do
  you want to take over?"
- "it should ask the user what all can the ai do on their behalf, based on that it will work not by itself"
- "everything to be flexible… not custom built for a single business, the message patterns, the pipeline questions
  they all will be flexible and different for businesses"
- "i dont want to be embarrassed in front of a client again"

It is a paid capability: each client buys a LUME AI allowance from the owner as part of their plan.

### Goals

1. Start a run on any selection of leads in under a minute, with the goal, the voice and exactly what LUME AI may do.
2. Watch it live: the lead it's on, what it's reading, the message being typed, the send, the next lead.
3. Interrupt at any moment: pause all, end the run, or take over one lead; nothing is ever sent after a pause.
4. Hand converted and stuck leads to a person with the deal at a glance.
5. Every business's own setup drives it: their pipeline, fields, meeting types, templates, people, hours, wording.
6. As clean on a phone as on a computer.
7. Usage shown plainly in a small ring, limits from the plan, never a surprise bill.

### Non-goals (this release)

- Instagram or any channel other than WhatsApp (Meta's API allows Instagram DMs only after the person writes first;
  a later release can add comment-keyword replies).
- Voice calls, emails.
- Writing new WhatsApp templates (approved templates are made and approved in the W3b template work).
- Runs across several businesses, or one run spanning two pipelines.

### Anti-goals (would make it a failure even if it works)

- A message sent that the person didn't allow, or after they pressed Pause.
- Anything that gets a client's WhatsApp number restricted or banned (see §6).
- A price, discount, date or promise LUME AI invented.
- A lead who said stop hearing from the business again.
- Anything shaped around one client (CLAUDE.md): no hard-coded interiors words, stages, questions or wording.
- A screen that looks or behaves broken in front of a client: every flow here ships with an end-to-end test and a
  walkthrough on a staging copy (§9).

## 1. Starting a run

From Leads (or the board), a selection shows "Let LUME AI handle these" in the selection island. It opens a sheet
(right side on a computer, bottom sheet on a phone) titled "Let LUME AI handle N leads".

### 1.1 The goal

- Two or three ready-made goals **from the business's own pipeline** ("Ready-made goals come from your pipeline"): one
  per open stage the business marks as a goal in Settings → LUME AI, named after the stage ("Book a site visit" for a
  stage "Site visit booked"), plus "Get a reply". *My call:* a goal stage is reached when the lead moves into it; the
  defaults are the first stage after the first reply and the stage just before Won.
- **"+ Write your own":** a box (600 characters) with a hint ("A good brief says the outcome, the offer and the tone")
  and "Use an example". **Confirm** locks it in: the box becomes a locked card ("Your goal is locked in. LUME AI writes
  from this.") with Edit. With "Write your own" chosen, **Start the run stays off until the goal is confirmed**
  ("Confirm your goal to start the run"). Confirm is off for under 15 characters.
- The goal is the brief for every message LUME AI writes in this run. For a written goal, LUME AI judges when it's
  reached and shows the evidence (the lead's own words) on the Ready card; the person confirms by taking over.

### 1.2 Who it speaks as, and when

- **Speaks as:** one of the business's people (their name in the messages; "Priya from Sutra Interiors"). Default: the
  person starting the run. Only people who may message those leads are offered.
- **When:** the business's working hours and days (Settings → Follow-ups) and a daily cap ("up to 40 a day"), both
  editable here. Default cap: Meta's current messaging tier for the number, minus what the team already sent today.

### 1.3 What LUME AI may do: permissions

The heart of it ("what can LUME AI do for you?"). Each action has three settings: **Go ahead** (does it), **Ask me**
(prepares it and waits for one tap; other leads keep moving), **Never** (won't, and hands the lead over if it comes
up). The list is built from the business's setup, so it names their things:

| Group | Action | Named from |
|---|---|---|
| Messages | Send first messages | their approved templates |
| | Follow up when there's no reply | their follow-up days (default day 2 and day 5, then stop) |
| | Reply and keep the conversation going | their knowledge (§5) |
| | Send files | their file library (brochures, past work, price sheets) |
| Pipeline | Book meetings | their meeting types and free calendar slots |
| | Move leads along the pipeline | their stages |
| | Set follow-up reminders | for the speaker or the lead's rep |
| | Fill in lead details | their fields ("Budget, Size, Timeline") |
| Careful | Answer price questions | only from the price list in Settings → LUME AI |
| | Mark a lead lost | with one of their lost reasons |
| | Hand a lead to a rep | their assignment rules |

An action the business can't do (no calendar connected, no price list, no files) shows off with the reason and a link
to set it up.

**Presets** set every row at once, like Claude Code's modes: **Careful** (asks before anything that changes a lead),
**Balanced** (talks and books, asks about the rest; the default), **Hands-off** (does all of it; you step in when you
want). Changing a row by hand leaves the presets unpressed.

**Always on, not switchable:** "Stop" means stop (LUME AI apologises once and marks the lead do not contact; nobody in
LUME can message them again without an admin lifting it). It never invents a price, discount, date or promise it
wasn't given.

**Use these every time:** a switch that saves this run's goal settings and permissions as the business's standing
choices. They are always editable in Settings → LUME AI (admins), and the sheet opens with them.

### 1.4 Before Start

A line of plain numbers: "50 first messages · about ₹43 to Meta · uses about 6% of this month's LUME AI". Start shows
the mark drawing once, closes the sheet, and the island says "LUME AI is on 1 of 50. Watch it live."

## 2. Watching it work (Autopilot)

A new page, **Autopilot** in the sidebar (with a "Live" pill while a run is going). On a computer, three columns
(mockup `autopilot-live-v3.html`):

- **Run bar:** the LUME AI mark drawing itself like a pen while it works (resting, fully drawn, when paused or done),
  the run's name, "LUME AI is working" / "Paused" / "Waiting for replies", the goal and voice in one line, a progress
  ring, counts (Messaged, Replied, Ready for you, Stopped) that bump when they change, **Pause (Esc)** and **End run**.
- **The leads:** every lead in the run with its state: Up next, Writing, Sent, Replied, Talking, Ready for you, Needs
  you, Stopped, With you. The lead LUME AI is on has the blue rail. Clicking any lead shows its conversation while
  LUME AI carries on elsewhere; "Back to LUME AI's lead" returns to following it.
- **Live conversation:** the WhatsApp thread, a one-line "what LUME AI is thinking" ("Reading Rohan's form: 1,500 sq ft
  office, ₹10–20 lakh. First message, so an approved template."), and the composer where LUME AI types character by
  character, template variables highlighted. The text lifts into the thread as a bubble; ticks follow (sent,
  delivered, read). A template message shows "Approved template · First hello".
- **Ready for you:** grouped **Converted** and **Needs you**, each with a count; a badge on the heading. Each card: the
  lead, the deal in one large line ("Site visit booked · Saturday, October 24 · 4:00 pm" / "Asked about price · 1,200
  sq ft clinic · ₹20–30 lakh"), the lead's own words as a quote, and two full-width buttons: **Take over** and **Let
  LUME AI confirm / answer**. A new card arrives with a short ring of its colour and a dark-glass toast ("Meera booked
  a site visit for Saturday at 4 pm. Want to take over?"). The run's rules fold away below.

### 2.1 Interrupting

- **Pause (Esc, or the button):** the run stops at once; a message being typed freezes where it is and is never sent
  half-written; the veil says "Paused. Nothing is sent until you resume." Resume carries on from the same place.
- **End run:** nothing more is sent; every lead keeps its conversation and state.
- **Take over a lead:** clicking into that lead's composer (or Take over on a card) hands it to the person at once,
  even mid-sentence: LUME AI's half-typed text is left in the box for them to edit or clear, the lead shows "With
  you", and the run carries on with the others. **Hand back to LUME AI** returns it.
- **"Ask me" items** collect as a small queue on the run bar ("3 waiting for you"); approving one sends or applies it
  at once.

### 2.2 The run lives on the server

The run is a server job, not the browser tab: it carries on when the screen is closed, the laptop sleeps or the person
is on their phone, within the business's hours and caps. The live view is a window onto it (server-sent events, the
same stream LUME already uses). Pausing from any device pauses it everywhere. People with access to the leads can
watch; only the person who started it and admins can pause, end or change it.

### 2.3 On a phone

- Starting a run: the same sheet as a bottom sheet; the three-way switches go full width under each action; presets
  as three compact buttons; Confirm and Start within thumb reach.
- The live run: a run card (mark, name, "LUME AI is on 7 of 50", **Pause**), the four counts, the current lead's
  conversation with LUME AI typing, a bottom bar with **Live** and **Ready** (with its count). A converted lead drops
  in as a banner from the top with Take over.

## 3. How LUME AI behaves in a conversation

- **Inside WhatsApp's 24 hours** (the lead wrote recently): LUME AI writes freely from the goal, the knowledge (§5) and
  the conversation, as the speaker, in the business's tone.
- **Outside the 24 hours** (first messages, follow-ups to silence): only the business's approved templates. LUME AI
  picks the template that fits and fills its variables per lead (a highlighted variable is never left blank or
  invented; a lead missing a value gets a template that doesn't need it, or is skipped with the reason).
- **Hands over** (Needs you) when the lead: asks something an "Ask me"/"Never" action covers, complains, is upset,
  asks for a person, or says anything LUME AI isn't confident about.
- **Responsible and lawful** (owner: "lume ai will abide to the laws and be a responsible ai, should be contextual to
  avoid risks"): it reads the context and steps back from anything risky (legal, medical or financial advice, threats,
  minors, anything sensitive) by handing over.
- **"Are you a bot?"** is a business setting (owner, 2026-10-19), with two choices: **Say so honestly** ("I'm LUME AI,
  writing for Priya at Sutra Interiors"; the default) or **Hand over to a person**. Denying it is AI is never offered
  (the law in several markets, and the owner's rule above).
- **Outside working hours** is a business setting (owner: "a business decision"): **Reply any time** or **Wait for
  working hours** for answers to a lead who just wrote. First messages and follow-ups always keep to working hours.
- **Converted** when the goal is reached: a stage move into the goal stage, a meeting booked, or, for a written goal,
  LUME AI's judgement with the lead's words as evidence.
- **Stop:** any opt-out ("stop", "not interested", "don't message me", in any language the model reads) → one short
  apology, do not contact, Stopped. Never debated.
- Every message LUME AI sends is recorded on the lead as sent by LUME AI for the speaker (`via: "ai_autopilot"`, the run
  id), counts as a send (W3a: last message, first contact, follow-up done, stage moves), and shows in the thread.
- One run per lead at a time. A lead already in a run is shown as such and skipped by a new one. A rep messaging a lead
  by hand (in LUME or WhatsApp on their phone, seen via W1 echoes) takes that lead out of the run (With you).

## 4. Usage, limits and the ring

- **Paid as part of the plan:** each client's plan includes a LUME AI allowance, metered by the licence (Control's plan
  modules; the 2026-10-18 design §2.2). The AI runs on LUME's provider account per client, with a hard monthly spend
  cap at the provider so one busy client can never surprise the owner.
- **Monthly, and generous** (owner, 2026-10-19: "switch to monthly usage, we can keep it a bit generous"): one monthly
  allowance per plan, resetting on the plan's monthly date, plus the existing hourly safety limit (2026-10-18 §2.2) so a
  runaway run can't drain a month in an afternoon. Each AI call LUME AI makes counts. This replaces the weekly allowance
  of the 2026-10-18 design for every LUME AI feature, so a business sees one number.
- **The ring:** a small progress ring in the top bar, beside the bell, filling with the month's use and turning amber
  past 80%. Clicking opens a panel: the percentage used, "about N days left at this pace", this month's and this hour's
  use, spend against the cap, when it resets, a link to Settings. Admins get one notice at 75% and 90%.
- **At a limit:** runs pause by themselves, saying which limit ("LUME AI has reached this hour's limit. It carries on at
  3:40 pm." / "…this month's allowance."). Nothing half-sent; replies still arrive and save.
- **Top-up (owner, 2026-10-19):** at the monthly limit a run stays paused **until the admin asks for a top-up**: the
  ring's panel and the paused run show **Ask for a top-up**, which sends the request to the owner (the licence
  dashboard's client page, and the owner's alert). The owner adds the top-up to the client's plan; runs resume by
  themselves. No self-serve payment in LUME.

## 5. Settings → LUME AI

Admins only. Sections: **Standing choices** (including "Are you a bot?" and replies outside working hours) (the goal stages, default permissions, presets, speaker, caps, the "use
these every time" set); **What LUME AI knows** (a service description, FAQs, the price list, files it may send, things
it must never say), all the business's own words; **Voice** (tone, language, signing off); **Usage** (the meter, the
history of runs). The business switch for LUME AI (2026-10-18 design §2.2) gates all of it; off by default; LUME works
in full without it.

## 6. WhatsApp's rules (non-negotiable; Meta enforces them)

- Approved templates outside the 24-hour window; free text only inside it.
- Opt-outs honoured for good.
- Paced sending: spread across the business's hours; never more than the number's Meta tier; new numbers start slow.
- The number's quality rating is watched (Meta's webhooks); a drop to yellow pauses every run on that number and tells
  the admins why. A ban is the failure this design exists to avoid.
- Each send to a new lead costs a Meta template fee; the estimate (§1.4) says so before Start.

## 7. Flexible by construction

Nothing in code names a client's stages, fields, meeting types, products, questions, wording or industry. Every list in
§1–§5 is read from that business's configuration; the sample words in the mockups (interiors, "site visit", Priya) are
fictional demo data. Ready-made goals, permissions' wording, the template choice and the knowledge are all per
business. Copy speaks as LUME, with no em dashes.

## 8. Depends on

- **W3b, templates beyond 24 hours** (approved templates, with media, chosen and filled per lead): required for first
  messages and follow-ups. Not built yet.
- **WhatsApp connected through Meta** for the business (W1); the owner's Meta business verification is still pending.
- **LUME AI's provider and model** (2026-10-18 design §2.1 and §6): the paid eval and the model choice wait on the
  owner's spend approval.
- **Plan allowance in the licence** (Control's plan modules, `aiReadsHourly`, `aiReadsWeekly`).

## 9. Testing and release (the owner's bar: never embarrassed in front of a client)

- Unit and route tests for the run engine (pause mid-message sends nothing; takeover mid-sentence stops only that lead;
  stop is permanent; caps, hours, tier pacing, limits; one run per lead; permission enforcement on the server, never
  only in the screen; RLS on every new table).
- A fake Meta (exists) and a **fake AI provider** with scripted replies, so every flow runs end to end without cost.
- End-to-end specs for every flow in §1–§4 on desktop and phone width, both themes, with accessibility checks; each
  that covers a path a person takes is proven to fail without its code.
- The AI's quality gate: the 2026-10-18 §6.4 test set extended with autopilot conversations (stop detection, handover,
  never inventing a price, template choice, conversion judgement), scored before release.
- Before any client sees it: the walkthrough on a staging copy of that client's data with the exact images to ship.

## 10. Owner's answers (2026-10-19)

1. **Usage:** monthly, generous (§4).
2. **Out of allowance:** the run pauses until the admin asks the owner for a top-up (§4).
3. **"Are you a bot?":** a business setting: say so honestly, or hand over; never deny (§3).
4. **Replies outside working hours:** a business setting (§3).

## 11. My calls (settled in writing this; the owner can overrule)

- **"Ask me" when nobody is watching:** besides the run bar's "N waiting for you", each waiting item sends one bell
  notification to the person who started the run (so it reaches their phone).
- **Never inventing a price:** the price list (§5) is structured (item, price, unit, notes), not free text. Before any
  message goes, every amount and every date in it is checked against the price list, the knowledge and the calendar;
  a message with an amount or date that isn't there is not sent and the lead goes to Needs you ("LUME AI wanted to
  quote a price that isn't in your price list").
- **Several runs at once:** allowed on different leads; they share the number's daily cap and Meta tier.
- **The speaker leaves** (offboarded or disabled): their runs pause and the admins are told to pick a new speaker.
- **Goal stages default** as in §1.1; **daily cap default** as in §1.2.

## 12. Left to the builder

The run engine's internals (queueing on pg-boss like the send queue, resumable state per lead), the event stream's
shape, the exact typing cadence on screen (the real text arrives from the model; the screen reveals it at reading
speed), animation timings within LUME's spring tokens, and the empty and error states of every screen, all in LUME's
existing patterns.
