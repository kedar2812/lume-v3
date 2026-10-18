# LUME AI

LUME AI reads a call note or a note into a suggested next step (the stage, a follow-up and tags, applied only with a
tap), and catches someone up on a lead in three lines when they ask. Spec:
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
- Every read is one row in `ai_reads` (task, model, tokens, how long it took, whether it was applied or dismissed); no
  note text is kept there.
