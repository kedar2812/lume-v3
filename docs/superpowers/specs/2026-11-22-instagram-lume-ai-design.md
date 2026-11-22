# Instagram, flows and LUME AI: one way of working (design)

Status: proposed 2026-11-22, written under the owner's go-ahead ("figure out a way to round all of this up so that
LUME AI can be applied on it and our platform stays clean and usable easily, keep working and refine anything you
want"). Builds on `docs/NEW_FEATURES_PLAN.md` §4 (Instagram), `2026-10-19-lume-ai-autopilot-design.md` (LUME AI) and
the 1C canvas (https://claude.ai/artifact/KJJDFJ7wddubXwRuked4m9).

## 0. The problem

Instagram brings a third thing that can answer a person: a **flow** (scripted, instant, free), next to **LUME AI**
(conversational, metered) and **your team**. Without one rule, two of them answer the same person, nobody knows who
is "on" a conversation, and Instagram grows its own corner of the app (its own inbox, its own AI settings, its own
numbers). That is the failure this design exists to prevent.

## 1. Principles

1. **Instagram is a channel of a lead, not a place.** Everything LUME already does gains Instagram where it already
   lives: the lead drawer (an Instagram tab beside WhatsApp), Who replied, LUME AI runs, Analytics, Not a lead yet.
   No Instagram inbox, no second AI settings page.
2. **One driver per conversation.** At any moment exactly one of *a flow*, *LUME AI* or *a person* is answering a
   conversation, and the conversation header says which, with one button to change it.
3. **A person always wins.** Typing in a conversation takes it over from a flow or LUME AI, at once, with nothing
   sent after. Hand back returns it.
4. **Scripted first, then smart.** A flow answers the keyword or ad it was made for; LUME AI picks up where a script
   ends (a "Hand to LUME AI" step) or answers DMs no flow claims. The business sees where each one starts and stops.
5. **New surfaces only where nothing exists:** the Instagram card in Settings → Integrations, the Flows page (shown
   only while Instagram is on), and an Instagram tab in Analytics. Nothing else is new.

## 2. Who answers: the rule

A message arrives on a connected account. In order:

| # | When | Who answers |
|---|---|---|
| 1 | Someone on the team has taken this conversation over | that person; nothing automated |
| 2 | A LUME AI run already holds this lead | LUME AI (one run per lead, as today) |
| 3 | A flow is running for this person | that flow, until it ends or hands over |
| 4 | The message matches a live flow's trigger (keyword, story reply, ad, first DM) | that flow starts |
| 5 | The account's **"Who answers new DMs"** is LUME AI, and the person's 24 hours are open | LUME AI starts, with the account's standing goal |
| 6 | Otherwise | your team: the conversation lands in Who replied (and Not a lead yet if the account is set to wait) |

A keyword always belongs to one flow (the editor refuses a second, as the canvas shows for "Spring batch"). A flow
step **Hand to LUME AI** ends the flow and starts LUME AI on that lead with the step's goal (row 2 from then on).
A flow step **Hand to a person** ends it and passes the lead to row 6, telling whoever owns the lead.

## 3. Instagram's rules for LUME AI (Meta enforces them)

- LUME AI writes only inside the 24 hours after the person's last message (7 days after an ad click's first
  message). Meta's 7-day **human agent** tag is for people only: LUME AI never uses it. When the 24 hours end with a
  question unanswered, LUME AI hands the lead to a person (Needs you) and says why: "Instagram's 24 hours ran out. A
  person can still answer until November 30, 4:21 pm."
- LUME AI never starts a conversation on Instagram (Meta allows none) and never sends a private reply to a comment
  (flows do that, one per comment, within 7 days).
- Messages up to 1,000 bytes, quick replies up to 13 with 20-character titles: LUME AI's writer is held to them, the
  same guards as WhatsApp (no invented prices, dates, files or promises; "stop" means stop).
- "Are you a bot?" and every LUME AI standing choice apply unchanged (Settings → LUME AI).

## 4. What changes on each existing screen

- **Settings → Integrations → Instagram card:** one new row per account, **Who answers new DMs**: *Your team* (the
  default) · *LUME AI* (off with the reason when LUME AI is off or the plan has no replies). Flows are not in this
  choice: a flow answers only what it was made for, whatever this says. The card links to Flows.
- **Settings → LUME AI:** "Where LUME AI works" lists WhatsApp and Instagram. Instagram gets one **standing goal for
  new DMs** (the same goal picker as a run: a goal stage or a written goal) and uses the business's standing
  permissions. No second page.
- **Lead drawer:** the Instagram tab (beside WhatsApp) has the driver chip in its header: *Flow: Lead magnet* ·
  *LUME AI* · *You* · *Your team*, with **Take over** / **Hand back**. LUME AI's messages show "LUME AI for Maya", as
  on WhatsApp. The window line under the composer says what Instagram allows now.
- **Who replied:** Instagram replies join the same groups by meaning (the reply-meaning model reads them), with a
  WhatsApp · Instagram filter and one new group, **A flow passed these to you**. "Let LUME AI handle these" works on
  Instagram leads whose 24 hours are open, and says how many it skipped and why.
- **LUME AI page (Autopilot):** runs show each lead's channel. Instagram leads started by a flow or by "Who answers
  new DMs" appear in the run list as **New DMs on @account**: one standing run per account, pausable like any run.
- **Flows:** the step list gains **Hand to LUME AI** (goal picker inline). The flow's numbers count what happened
  after the hand-off ("Handed to LUME AI · 41 · 12 became leads").
- **Analytics → Instagram:** tiles and charts across the whole channel, with one card that answers "is the AI worth
  it": **Who answered** (flows, LUME AI, your team), each with conversations, leads, calls booked, won and the median
  first answer.
- **Usage:** a LUME AI conversation on Instagram counts toward the same monthly AI leads allowance as WhatsApp. The
  ring and limits are unchanged; at the limit, "Who answers new DMs: LUME AI" falls back to your team and says so.

## 5. Plans (unchanged rules, stated)

Flows need the Instagram module (plan7). LUME AI on Instagram needs what LUME AI on WhatsApp needs: replies (Max and
up today; owner question Q1 about Pro still open) and an AI allowance. A plan without them shows the choice off with
the reason, never hidden.

## 6. Non-goals

- LUME AI writing flows for the business (later: "Draft this flow with LUME AI").
- LUME AI replying publicly to comments.
- Any Instagram-only AI settings, inbox, or usage meter.

## 7. My calls (the owner can overrule)

- Default for "Who answers new DMs" is *Your team*: LUME AI is never switched on by connecting an account.
- A person typing takes over at once, even mid-flow; the flow does not resume by itself (Hand back resumes LUME AI or
  leaves the lead with the team; a flow never restarts mid-way).
- One standing run per Instagram account, so pausing "New DMs on @account" is one click and visible on the LUME AI page.

## 8. Tests that pin it (written first, per QUALITY_PROCESS)

The rule table row by row (each row wins over the ones below it); a keyword claimed twice refused; Hand to LUME AI
starts exactly one run; take over mid-flow and mid-AI sends nothing more; LUME AI never sends after the 24 hours and
hands over with the reason; never the human agent tag from LUME AI; the allowance limit falls back to the team;
Who replied filter and the new group; the driver chip in every state, both themes, at phone width.
