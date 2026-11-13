# LUME AI

LUME AI reads a call note or a note into a suggested next step (the stage, a follow-up and tags, applied only with a
tap), and catches someone up on a lead in two or three lines when they ask. Spec:
`docs/superpowers/specs/2026-10-18-whatsapp-replies-ai-design.md` §2 and §5.

It is **off by default** on every LUME, and it stays off unless three things are true:

1. the server is set up with a provider (`.env`, below);
2. the client's plan includes the `ai` module (the licence dashboard; a plan without it shows "Not in this LUME's
   plan");
3. an admin switches it on in Settings → Integrations → LUME AI.

## What leaves the client's server

Only with the switch on, and only for a read someone asked for: the lead's first name, its stage, the business's own
stage names, lost reasons and tags, the lead's custom field labels and values, its recent history (newest 20 items,
4,000 characters at most) and the note being read. Never a phone number, email, Instagram handle or web address. The
reply is checked against a fixed shape and cleaned (ids only from the business's own lists, a follow-up only after
now) before anyone sees it.

Use paid API tiers only. A free tier may train on what it's sent.

## 1. Choose the model (once, with the owner)

No model ships without passing the eval. The eval sets live in `evals/ai/` (50 call notes, 20 lead histories,
written fresh: English, Hinglish, Telugu-English, Marathi-English; no client data). The runner sends every case
exactly as the API does, cleans the answers with LUME's own cleaner, and scores them.

```sh
# Proves the runner (no network, no cost). The fake model doesn't pass the marks; that's expected.
node scripts/ai-eval.mjs --provider fake

# A real model. It spends money: run it only after the owner approves the spend.
LUME_AI_KEY=… node scripts/ai-eval.mjs --provider anthropic --model <model id> --yes \
  --price-in <usd per 1M input tokens> --price-out <usd per 1M output tokens> --out ai-eval.json
```

**The marks** (all on the cleaned answers, which is what a person sees):

| | Mark |
|---|---|
| Stage right | at least 90% |
| Follow-up day right | at least 90% |
| A follow-up in the past | none, ever |
| An id the business doesn't have | none, ever |
| Catch-up lines | each one checked by hand against its history; the runner flags any number the history doesn't have |

The runner exits 0 only when the next-step marks pass. Record each paid run below.

### Results

| Date | Provider · model | Stage | Follow-up | Lost reason | Tags | Catch-up (by hand) | Tokens in / out | Cost |
|---|---|---|---|---|---|---|---|---|
| — | not run yet: waiting for the owner's approval of the spend | | | | | | | |

**Chosen model:** not chosen yet (spec §6.2: the owner picks after the eval; switching later is a setting).

## 2. Set a client up

1. **Its own provider key.** Make a separate workspace (Anthropic) or project (Google Cloud) named after the client,
   and a key in it. One key per client means one client's use never shows up on another's bill, and a key can be
   revoked alone.
2. **A hard monthly spend cap** on that workspace or project, at the provider:
   - Anthropic: the workspace's spend limit in the Console.
   - Google: a billing budget on the project, plus a quota cap on the Generative Language API requests per day.
   The cap is the backstop. The everyday limit is the plan's (step 3).
3. **The plan's limits**, on the licence dashboard (client → Plan): LUME AI reads an hour and a week. Defaults: a team
   plan 100 an hour and 750 a week; a solo plan 40 and 250. Empty means no limit. The week resets Monday 12 am on the
   business's clock; the hour is a rolling 60 minutes. Admins hear once at 75% and 90% of the week and when either
   limit is reached.
4. **The client's inputs**, `deploy/clients/<slug>.env` (never the server's `.env` by hand: `provision.sh` writes that
   file whole, so a line added there by hand is gone on the next run):

   ```sh
   LUME_AI_PROVIDER=anthropic   # or google
   LUME_AI_MODEL=<the chosen model id>
   LUME_AI_KEY=<the client's key>
   ```

   Optional, and recommended (measured 2026-11-12, `lume-ai-costs.md`): run the high-volume reads that pass the eval on
   Haiku, and price every model so the ring shows the month's spend:

   ```sh
   LUME_AI_TASK_MODELS=reply_meaning=claude-haiku-5-5,autopilot_first=claude-haiku-5-5
   LUME_AI_PRICES=claude-sonnet-5-5=2/10/2.5/0.1,claude-haiku-5-5=0.1/0.5/0.125/0.01
   LUME_AI_MONTHLY_CAP=<the cap set in the provider's console, USD>
   ```

   - `LUME_AI_TASK_MODELS` is `action=model` pairs; every other action runs on `LUME_AI_MODEL`. Actions:
     `next_step`, `catch_up`, `reply_meaning`, `autopilot_first` (Autopilot's template choice and Recommended),
     `autopilot_reply`, `template_draft`. Same provider and key for all of them.
   - `LUME_AI_PRICES` is `model=input/output/cache write/cache read`, USD per million tokens, from the provider's
     pricing page (all four, always). With prices set, every model LUME AI can use needs one.
   - A list that doesn't read, an action LUME doesn't have, or a model without a price stops the API at start with a
     line naming it (`docker compose logs api`): fix the inputs and provision again.
   - Never move an action to another model without its eval passing first (section 1).

   Then run `scripts/provision.sh <slug>` again (it changes nothing else) and restart the API on the server:
   `cd /opt/lume && docker compose up -d api`.

   Without these three, LUME AI says "isn't set up on this server yet" and can't be switched on.
5. Tell the client's admin it's ready: Settings → Integrations → LUME AI → switch on. The card says what is sent and
   where.

## 3. Switch it off

- **One client, at once:** the admin switches it off in Settings → Integrations, or remove `ai` from the client's
  plan on the licence dashboard (it applies at the next check-in).
- **The provider key:** revoke it in the provider's console, then take the three `LUME_AI_` lines out of the client's
  inputs, run `scripts/provision.sh <slug>` and restart the API. Reads
  fail quietly ("LUME couldn't read this note just now"), and nothing else in LUME changes.

Notes, calls and follow-ups keep working the whole time: LUME AI only ever suggests.

## 4. Check it

- `GET /api/v1/ai` (signed in): `on`, this hour's and this week's reads and limits, and a pause if one is in force.
- Every read is one row in `ai_reads` (task, the model that served it, tokens with the cache's apart, whether it was
  applied or dismissed); no note text is kept there. A failed read keeps the tokens it was billed (0 when the provider
  never answered).

## The month, the ring and top-ups (Autopilot A1, 2026-10-20)

- From a licence server that signs **LUME AI a month** (`plan4`), every AI call counts against one monthly allowance
  on the business's clock (from the 1st, 00:00), plus any top-ups for that month; the week no longer applies, the hour
  still does. Admins hear once at 75% and 90% of the month and once at the limit. An older licence keeps the week.
- **Spend (2026-11-12):** set `LUME_AI_PRICES` (above) and `LUME_AI_MONTHLY_CAP` (the hard cap set in the
  provider's console) in the client's inputs. The ring then shows the month's spend against the cap: every model at
  its own prices, the prompt cache's writes and reads at theirs, and **failed reads included** (the provider billed
  them; they still don't use up the client's allowance). Unset, it shows no money at all; nothing is guessed. If the
  month has tokens from a model with no price (one removed from the list mid-month), the spend line hides rather than
  show part of it: keep a model in `LUME_AI_PRICES` until the month it was last used is over.
  The older `LUME_AI_PRICE_IN` / `LUME_AI_PRICE_OUT` pair still prices `LUME_AI_MODEL` alone, its cache at
  Anthropic's standard 1.25x and 0.1x of input (an upper bound); move to `LUME_AI_PRICES` when you next touch a client.
- **Prompt caching (2026-11-12):** every read marks its instructions for Anthropic's 5-minute cache; a read within 5
  minutes of another with the same instructions pays the cache price for them (about 5% of input on Sonnet 5.5).
  Nothing to set. `ai_reads.cache_write_tokens` and `cache_read_tokens` show it working.
- **Top-ups:** an admin presses Ask for a top-up (the ring's panel); the request reaches the licence dashboard as an
  alert. Add a top-up there; it reaches their LUME at its next check-in and AI carries on by itself.

## AI leads (2026-11-12)

The allowance a client buys is **AI leads a month**, not AI calls. From a licence server that signs them (`plan5`):

- **What counts.** A lead counts once a calendar month on the business's clock (from the 1st, 00:00), the first time
  Autopilot starts on it (its first message, whether or not choosing the template needed a read) or it gets an
  Autopilot reply, a Suggest next step or a Catch me up. Choosing a template (Autopilot's and Recommended in the reply
  box), reading a reply's meaning and drafting a template never count and are never refused for AI leads. A failed
  read doesn't count its lead (its tokens stay in the spend). A lead AI never touches doesn't count. The same lead
  counts again next month.
- **Where it's kept.** `ai_lead_months` (one row per lead per month; migration 0106), written only by the counting
  functions under the same lock as the reads (`lume_ai_reserve`, `lume_ai_start_lead`); the app's roles can't read or
  write it. A deleted lead keeps its place for the month. Each counted read carries its month in
  `ai_reads.lead_month`. The ledger is written whatever the licence, so moving to AI leads mid-month counts the month
  from what already happened (0106 filled in the month it was installed).
- **At 80% and 100%.** Admins hear once at 80% and once when they're all used (again after a top-up raises the
  allowance). At 100% no new lead can start: next step and catch-up say why, Autopilot holds leads it hasn't started
  (`up_next`, reason "This month's AI leads are used up…", woken on the 1st or as soon as a top-up makes room); leads
  already counted keep full AI. The ring shows "X of Y AI leads used this month", amber from 80%, and at 100% Ask for a
  top-up of 100 AI leads and Ask about a bigger plan (both reach the licence dashboard as the top-up request).
- **Per lead.** At most 20 counted reads a lead a month. After the 20th, a lead Autopilot is working goes to Waiting
  for you, and its rep is told (and the run's starter), once a month; the 21st next step or catch-up is refused until
  the 1st. A licence with no AI leads limit has no per-lead limit either.
- **Safety net (hidden).** The hour (`aiReadsHourly`) and the month's reads still stop LUME AI if ever reached:
  the owner's own monthly number on the licence, else 30 for each of the month's AI leads (at least 1,000). Never shown
  as numbers; at the month's, LUME AI says it's paused for the rest of the month. Autopilot's daily send limit is
  unchanged.
- **Base (0 AI leads).** No lead can start; template choice and reply meaning still run while LUME AI is on. Switch
  the LUME AI module off on the licence to stop all AI.
- **Older licence servers.** A `plan4` answer counts AI calls a month as before; the ring then shows the month's reads.

## Autopilot (A2, 2026-10-23)

LUME AI talking to leads on WhatsApp by itself, in runs: `docs/runbooks/autopilot.md`. Starting on a lead counts it as
one of the month's AI leads; every read it makes still counts against the hidden hour and month.

## Recommended by LUME AI (2026-10-31)

Outside WhatsApp's 24 hours, the reply box offers the business's approved templates. With LUME AI on, it first asks
LUME AI which one fits this lead (`POST /api/v1/leads/:id/whatsapp/templates/recommend`, for anyone who may message
the lead). It's Autopilot's first-message read (`autopilot_first`), outside a run: the speaker is the person, the goal
"get a reply".

- **What's sent:** the same as a run's first message: the business's words from Settings → LUME AI, the lead's first
  name, stage and filled fields, the last 30 WhatsApp messages' words, and each template that has every value it
  needs, in this lead's words. Never a phone number or email.
- **What comes back:** one template's id and why, in one line. The id must be one of the templates offered
  (`guardFirst`); anything else is no recommendation, and the list shows as before.
- **Cost:** one read against the month and hour. The screen remembers the pick for the session, so opening the lead
  again asks nothing new. Dismiss hides it for that lead for the session.

## Write with LUME AI (2026-10-31)

On Templates, whoever manages templates can describe a template and get two or three drafts
(`POST /api/v1/templates/draft`, task `template_draft`).

- **What's sent:** the request, the business's name, its words from Settings → LUME AI (about, questions and answers,
  price list, voice), the variables a template may use, and the names of its templates. Nothing about any lead: this
  is the one read that belongs to no lead (migration 0097, and only this task may).
- **What's kept from the answer** (`cleanTemplateDrafts`): drafts LUME could submit as written. Dropped: a variable
  LUME doesn't have; anything WhatsApp turns down (`templateProblems`: a variable first or last, two together, over
  1,024 characters); an amount not in the price list; a discount or offer; a copy of another draft. A name already in
  the list gets a number. None left: the person is told to say it another way.
- **Nothing is saved by drafting.** Use this opens the editor; the person saves it and submits it for WhatsApp's
  approval as any template.
- **Cost:** one read against the month and hour, like every read.
