# LUME new features: the plan

Answer to `LUME_NEW_FEATURES_PROMPT.md` §10. Written 2026-11-22 after reading the repository at `271f9d78`, the
project report, the runbooks, the pricing PDF and Meta's own developer pages. Every claim about Meta below was read on
Meta's pages that day; anything Meta's pages didn't state is marked **verify on the test account**.

The brief is good on what to build. In several places it is wrong about LUME as it is today, or about the platforms'
rules, and building it word for word would add bugs, cost or legal risk. Section 1 says where and what to do instead.
The rest of the plan follows that section.

---

## 1. Where this plan disagrees with the brief, and why

| # | The brief says | What's true | So the plan does |
|---|---|---|---|
| 1 | Every new table carries `tenant_id`; tests prove cross-tenant access is impossible; one webhook "routed per tenant". | LUME is **single-tenant**: one server and one database per client (project report §3: "Do not add `tenant_id` columns"). The only shared pieces are the relay (`connect.lumecrm.in`) and the licence server. | No `tenant_id`. Isolation is physical. The one place a mix-up could happen is the relay, which routes Meta's deliveries, so the cross-client tests live there: an event for client A's Instagram account never reaches client B's server. |
| 2 | Pick BullMQ/Redis or a Postgres queue. | LUME already runs **pg-boss** in `apps/worker`, with jobs enqueued in the same transaction as the data change. Redis would be a new service to secure, back up and fit in 8 GB. | pg-boss for every new queue. No new infrastructure. |
| 3 | Build a central `entitlements` service with `can()` and `consume()`. | It mostly exists. The signed licence plan carries the tier (`packages/core/src/licence/tiers.ts`: `tierAllows(plan, feature)`); AI leads are metered in `ai_lead_months` with 80%/100% notices, top-ups and upgrade asks. | Extend `TierFeature` and wrap it in a thin `entitlements.can(feature)` so every new route checks one function. `consume()` arrives in Phase 4, when there's a second thing to meter (enrichment credits). Nothing parallel to the licence. |
| 4 | Tier numbers configurable in the DB. | AI-lead numbers already come from the licence server (owner sets them on Plan limits). Which **feature** is in which tier is code (`FIRST_TIER`), because code enforces it. | Keep the map in code for now. Later: a signed `features` list in the licence claim (`plan7`), so the owner can move a feature between tiers without a release. Flagged, not built in Phase 1. |
| 5 | Pro gets "LUME AI inbound qualification". | Today Pro **cannot** reply to leads: replies are Max and Enterprise only (pricing PDF p.3–5; `repliesLocked()`). Inbound qualification is replying. | Open question Q1. Until answered, inbound qualification follows replies: Max and up. |
| 6 | "Unlimited user seats on all tiers." | Already true in the pricing PDF. | Nothing to build; Team Chat must hold up at 1,000 people (the scale bar). |
| 7 | One webhook endpoint, routed by account/page ID. | For WhatsApp, Meta lets each business account have its **own** callback (`override_callback_uri`), so the relay keeps no list. For **Instagram API with Instagram Login there is one callback for the whole app**: "You cannot select fields for each app user account." Nothing on Meta's pages offers a per-account override. | The relay gets a small **routing table**: Instagram account ID → client server. No message is stored there. The table is written at connect, removed at disconnect, persisted to one file, and rebuilt from the client servers on start. Each Meta batch is split by account and forwarded separately. Section 4.2. |
| 8 | Comment → DM, then the flow carries on. | A comment does **not** open the 24-hour window. LUME may send **one** private reply to the commenter, within **7 days** of the comment, and nothing more until the person answers. A tap on a button or quick reply is the person answering. | The engine models a private-reply allowance (one per comment, 7 days) separate from the window. Every comment template starts with a private reply that asks for a tap ("Send me the guide"). Section 4.4. |
| 9 | Human agent tag "up to 7 days". | True, but `human_agent` is a separate feature in App Review, for **people only**, and only after the person wrote. | Ask for it in the same App Review. The engine never uses it for an automated send; only a person's reply from LUME can, and only within 7 days of the person's last message. |
| 10 | "Respect Meta rate limits." | Meta publishes them: Send API 100 calls/s per account for text (10/s for audio or video), private replies 750/hour per account, Conversations API 2/s. A message is at most **1,000 bytes** of UTF-8, not 1,000 characters. Quick replies: at most 13, titles 20 characters. Generic template: 10 cards, 80-character titles, 3 buttons each. | A token bucket per account and per kind in the sender, below Meta's numbers. Byte-exact length checks in the builder and again at send. |
| 11 | Visual node builder, "a vertical step list is fine". | Agreed. A canvas is weeks of UI and invites loops a person can't read. | A vertical step list with **branches as nested lists** (a Condition step holds a "yes" list and an "otherwise" list). No jumps back, so a flow can't loop forever. |
| 12 | First interaction creates or matches a lead. | Agreed for comments, story replies and ad clicks. For **any** DM, it would turn friends, suppliers and spam into leads and fill reps' lists. | Setting per Instagram account: **New people who DM become leads** (default on, as the brief asks) or **wait in Not a lead yet** (LUME's existing triage for WhatsApp strangers). Flow triggers always create the lead. |
| 13 | Reps see conversations for leads assigned to them. | That's already row-level security on `leads`. But LUME also **masks Instagram handles** for roles without "See full contact details" (`leads.contact.full`). A raw inbox would leak the handle. | Instagram threads go through the same lead serializer and masking. A rep without full contact sees the name and a masked handle, never the profile link. Tested in the permission matrix. |
| 14 | Keep ManyChat working; tenants can use either. | ManyChat and LUME on the **same** Instagram account both receive every DM and both may answer: the lead gets two replies. | Allowed, with a warning on connect and a per-keyword check. Recommended setup: one automation tool per account. The migration helper maps ManyChat fields (Phase 1, Task 9). |
| 15 | "LUME-blue gradients". | LUME's design system is Porcelain and Obsidian with one accent, #2A5BFF, and no gradient grounds (owner's rulings). | The existing design system wins. New screens are designed on a canvas for the owner first, as every phase has been. |
| 16 | Feature B: sourcing from Google Places API. | Google's Places policies let you store the **place ID only**. Names and phone numbers may not be kept outside the user's session: a stored lead list built from Places breaks Google's terms. | Places can **enrich** a lead the business already has (look up a website from a business name on view, keep only the place ID). It can't be a sourcing database. Phase 4 asks the owner to choose licensed providers (Q6). |
| 17 | Resell provider data as LUME credits. | Apollo's API terms forbid sublicensing or reselling without a separate reseller agreement; others are similar. | Phase 4 starts **bring your own key**: the client connects their own provider account, their contract, their bill, no LUME margin and no resale risk. LUME credits come once LUME has a reseller agreement (Q7). |
| 18 | Phase 5: cold email outbound by the agent. | India's DPDP Rules were notified on 13 Nov 2025; consent and notice duties start **13 May 2027**, and the Act has no "legitimate interest" ground for marketing. GDPR needs legitimate interest plus ePrivacy rules per country. Sending as a client's Google Workspace needs Gmail's restricted `gmail.send` scope, which needs an annual third-party security assessment. | Phase 5 waits for a lawyer's opinion (Q8) and sends over the client's own SMTP or a sending provider, never Gmail's API. The suppression list, unsubscribe and caps are built in Phase 4 anyway, because enrichment needs them. |
| 19 | Phase 6: evaluate Meta's Ads MCP / Ads CLI as the integration layer. | Both launched 29 Apr 2026 in beta. They're built for one advertiser driving their own account from an AI assistant, through the advertiser's own sign-in. They aren't a way for a product to manage many businesses' ads. | Phase 6 calls the **Marketing API** directly (`ads_management`, `ads_read`, `business_management`, its own App Review). Spend caps are enforced twice: in LUME's code and as Meta-side `spend_cap` on the campaign and account, so a LUME bug still can't overspend. |
| 20 | Phase 3 builds an agent with an approval queue, autonomy, handoff, guards and a kill switch. | Most of that **exists** for WhatsApp: Autopilot runs with Go ahead / Ask me / Never per action, Ready for you and Needs you queues, take over and hand back, guards against invented prices, files, times and stages, do-not-contact in any language, the eval, and LUME AI booking calls inside allowed times. | Phase 3 is mostly "Autopilot speaks Instagram" plus the Agent Brief wizard, auto-starting on new inbound leads, and the handoff note in Team Chat. Much smaller than the brief implies. |

---

## 2. Repository audit (what exists and is reused)

### 2.1 Shape

- **Monorepo** (pnpm): `apps/api` (Fastify 5 + Zod), `apps/worker` (pg-boss consumers and cron), `apps/web` (Next.js,
  never touches Postgres), `apps/connect` (the relay at connect.lumecrm.in), `apps/licence` (licence server, its own
  Postgres), `apps/render` (media previews); `packages/core` (domain logic), `packages/db` (Drizzle schema and 117 SQL
  migrations, the latest `0117_export_takes_view_scope.sql`), `packages/config` (env, fail fast).
- **One client = one server** (Hostinger KVM 2: 2 vCPU, 8 GB), same image for all; client differences live in `.env`
  and settings rows. Caddy in front; `/api/*`, `/whatsapp/in`, `/webhooks/*`, `/f/*` go to the API.
- **Security model**: route guard (every `/api/v1` route declares a permission, the boot fails otherwise), service-level
  scope, and Postgres **FORCE RLS** as the `lume_app` role with `SET LOCAL lume.user_id / lume.lead_scope`. A permission
  matrix test enumerates every route.
- **Quality**: `docs/QUALITY_PROCESS.md` (edge-case sheet, test first, mutation checks, full gate on the build box,
  review). Fakes for Meta, the AI provider, the licence server and render.

### 2.2 Reused as is, or extended

| Need in the brief | What LUME already has | Where |
|---|---|---|
| Meta connection, app secret kept off client servers | The relay: Embedded Signup, code exchange, token refresh, signed hand-off to the instance, webhook signature checks | `apps/connect/src/whatsapp.ts`, `relay.ts`; `packages/core/src/relay` |
| Webhook dedupe and replay protection | `whatsapp_events` (each delivery once, encrypted while waiting), relay signature with timestamp | `packages/db/src/schema/whatsapp.ts`; `core/whatsapp/sign.ts` |
| A message on the lead's timeline | WhatsApp messages are `activities` on the lead; live updates over `pg_notify('lume_whatsapp')` → the SSE stream | migrations 0098; `api/modules/notifications/routes.ts` |
| Unknown senders | **Not a lead yet** (14 days, make a lead / ignore) | `whatsapp_inbox`, `whatsapp_ignored`, `modules/whatsapp/inbox.ts` |
| Sending, never twice, within Meta's window | `whatsapp_outbox` + `whatsapp.send` queue (8 workers, in the **api** process): client key per person, one message at a time per lead in order, "sending > 10 min = failed with words, never resent", 8 tries with backoff, 30/min and 600/h per person, statuses only move forward | `modules/whatsapp/send.ts`, `sender.ts`, `core/whatsapp/outbound.ts` |
| The plan's modules | `PLAN_MODULES` (googleSheets, webhooks, googleCalendar, calendly, ai, whatsapp) in the signed claim; `assertModule()` answers 409 `PLAN_MODULE`; the admin's switch lives in `settings.integrations` | `core/licence/fleet.ts`, `api/licence/plan.ts` |
| Lead sources and assignment | `lead_sources` (type, `rules` jsonb: pipeline, stage, owner = a person or round robin with `rr_cursor`, match on phone/email/instagram) and `writeRow()` | `modules/imports/row.ts`, `core/intake/mapping.ts` |
| Files and media | Content-addressed `files` volume, off-site backup, keep-for setting, safe serving | `modules/whatsapp/media.ts`, `keep.ts`, `library.ts` |
| Lead creation, dedupe, assignment | The intake engine (sheets, CSV, webhooks, Calendly), contact keys for dedupe (`lead_contact_keys` has an `instagram` kind) | `core/intake`, `modules/imports`, `modules/webhooks` |
| ManyChat | A webhook preset (hidden until verified) mapping `ig_username` → the Instagram field | `modules/webhooks/presets.ts` |
| Realtime | SSE stream with Last-Event-ID, backpressure, LISTEN/NOTIFY | `modules/notifications/routes.ts`, `hub.ts` |
| Notifications and digest | `notifications`, the bell, email digest | `modules/notifications`, `schema/tasks.ts` |
| Tasks | Tasks with reminders, recurrence, `tasks.manage_others` | `modules/tasks` |
| Audit | Append-only `audit_log`, audit screens and export | `modules/audit` |
| Plans and metering | Signed tiers, AI-lead ledger, top-ups, upgrade asks | `core/licence/tiers.ts`, `ai_lead_months` |
| AI | Provider abstraction, per-task models (`LUME_AI_TASK_MODELS`, Haiku for cheap tasks), prompt caching, cost engine, Autopilot engine with guards, books calls | `core/ai`, `modules/ai`, `modules/autopilot` |
| Do not contact | Stop words in many languages, before any AI call; holds for every sender | `modules/leads/dnc.ts` |
| Booking | Calendly and Google Calendar connections, meetings matched to leads | `modules/calendar`, `modules/calendly`, `modules/meetings` |

### 2.3 Not there yet

- No Instagram messaging code at all: only the `instagram` lead field (citext, indexed, hashed into
  `lead_contact_keys`, masked like phone and email).
- No channel abstraction: WhatsApp is named in its tables, activity types (`whatsapp_received`, `whatsapp_sent`) and
  plan module. The only `MessageChannel` is click-to-send. Phase 1 adds Instagram beside it rather than inventing a
  general channel layer first; the shared parts (outbox rules, window, thread view) are pulled into one place where
  both channels use them, and nowhere else.
- Leads made from WhatsApp's Not a lead yet have no lead source (`sourceId` null). Instagram leads will have one.
- No team-wide inbox page: conversations live on each lead (drawer) and in Not a lead yet.
- No team chat, channels or direct messages; notes on leads exist (activities `note`), mentions don't.
- No flow engine, no enrichment, no outbound email sequencing, no ads.

---

## 3. Phase order

The brief's order stands, with two changes in what each phase holds:

1. **Instagram Auto-DM** (Feature A): connect, receive, inbox, reply, flows, lead capture, analytics, ManyChat helper.
2. **Team Chat** (Feature C).
3. **LUME AI on Instagram + Agent Brief** (Feature D, inbound): small, because Autopilot exists (§1 row 20).
4. **Suppression, consent and audit tooling first, then enrichment** (Feature B) with bring-your-own-key providers.
   The suppression list, retention and source-per-field come **before** any provider, because outreach needs them too.
5. **Email sequences** (Feature D.4), after the legal opinion (Q8).
6. **Ads agent** (Feature D.6), with double spend caps.

Each phase follows the process: spec → canvas for any new screen (owner approves) → plan with the edge-case sheet →
test-first tasks → mutation checks → full gate → fresh reviewer → push. No deploys without the owner.

---

## 4. Phase 1 design: Instagram Auto-DM

### 4.1 Which Instagram API

**Instagram API with Instagram Login** (`graph.instagram.com`), not the older Facebook Login route. Coaches and
creators often have no Facebook Page; Instagram Login needs none. Facebook Login comes later, for ads (Phase 6).

Scopes: `instagram_business_basic`, `instagram_business_manage_messages`, `instagram_business_manage_comments`.
Feature: **Human Agent**. Account: professional (Business or Creator). The app must be Live with Advanced Access
(already Live for WhatsApp).

### 4.2 How a message travels

```
Instagram ──► Meta ──► relay /ig/in ──────────────► client's LUME /instagram/in ──► queue ──► lead / Not a lead yet
                       (Meta's signature checked;   (relay's signature checked;
                        batch split by account;      each event kept once;
                        routing table: account →     flows advance)
                        server; nothing stored)
```

- **Connect** (admin, Settings → Integrations → Instagram): LUME asks the relay for a signed start link →
  `instagram.com/oauth/authorize` → the relay exchanges the code with the **Instagram app secret** (relay only), swaps
  the short-lived token for a 60-day one, reads the account (`/me?fields=user_id,username,name,account_type`),
  subscribes it (`POST /<id>/subscribed_apps` with the fields below), records `account → instance` in its table and
  hands the token to the client sealed with the client's relay token (the pattern WhatsApp uses).
- **Webhook fields**: `messages`, `messaging_postbacks`, `messaging_referral`, `messaging_seen`, `message_reactions`,
  `comments`, `live_comments` (ignored in Phase 1, kept for later).
- **Refresh**: `ig_refresh_token` needs no app secret, so each client's LUME refreshes its own token once it's 30 days
  old (Meta allows from 24 hours), daily until it works. A refused refresh puts the account in "needs attention" and
  tells the admins once.
- **Routing table at the relay**: `{ igAccountId: instanceId }` in memory, written through to one JSON file on a volume
  (`RELAY_DATA_DIR`). On start, the relay asks each instance which accounts it holds (`GET /instagram/accounts`, signed)
  and rebuilds the table, so a lost file heals itself. If two servers claim one account (a client moved servers), the
  newest connect wins and the older server is told the account was connected elsewhere.
- **A batch** from Meta (up to 1,000 entries) is split by `entry.id` and each part is re-signed and posted to its
  server. Meta's retry is per batch, so: if every part landed, 200; if a server is down, 503 (Meta retries for up to 36
  hours; the servers that already took their part drop the repeats by message id). If one server has failed for over
  15 minutes, the relay stops holding the batch for it: it answers 200 and writes a **gap note** (account and time
  span, no content). That server, once back, asks the relay for its gaps and catches up from Meta's Conversations API
  (the 20 newest messages per conversation, 2 calls/s). One client's outage never stalls the others.
- **Unknown account** (no route): 200 and dropped, logged without content.

### 4.3 What lands where

| Event | LUME does |
|---|---|
| DM from a new person | Match: thread (account + IGSID) → lead whose Instagram handle is the username (leads from ManyChat or sheets) → otherwise create the lead, or Not a lead yet (setting, §1 row 12). Username and name come from the User Profile API, allowed once the person has messaged. |
| DM from a known person | On the lead's timeline; the window opens for 24 hours; flows waiting for an answer advance. |
| Echo (sent from the Instagram app) | On the timeline as sent by the business; like a WhatsApp echo it **takes over** the conversation (pauses automation for that lead). |
| Comment | Kept with post and author. A matching comment trigger starts its flow: the private reply, and optionally a public reply picked at random from the list. Comments by the account itself are ignored (no self-loops). |
| Story reply | A DM with `reply_to.story`: the story trigger. |
| Story mention | A DM with a `story_mention` attachment: the mention trigger. |
| Ad click → first DM | `referral.ad_id`: kept on the thread and lead as its source; the window lasts up to 7 days from that message. |
| Postback / quick reply tap | Advances the waiting flow step by its payload; it also counts as the person answering (opens the window). |
| Seen, reaction | Status on the message; a reaction counts as the person acting (opens the window, per Meta's policy). |

### 4.4 The window, in code

One pure function, `instagramWindow(thread, now)`, used by the composer, the flow engine and the sender (checked again
just before Meta):

| State | When | Who may send |
|---|---|---|
| `open` | within 24 h of the person's last message, reaction or tap; within 7 days of a first message after an ad click | flows, LUME AI, people |
| `human` | after `open`, within 7 days of the person's last message | people only, with the `human_agent` tag |
| `private_reply` | a comment under 7 days old with no private reply yet, and no open window | one private reply, by a flow or a person |
| `closed` | otherwise | nobody; the composer says why and when it reopens |

### 4.5 Flows

- **Triggers**: comment keyword (all posts or chosen posts), DM keyword, story reply, story mention, ad click (all ads
  or chosen ad ids), first message ever (welcome). Keywords match as whole words, case- and accent-insensitive, in any
  script; one comment starts at most one flow (the highest priority, then the oldest). A person in a running flow
  isn't restarted by the same trigger within a cool-down (default 24 h).
- **Steps** (each validated with Meta's limits, in bytes): Send message (text, image, quick replies, link buttons),
  Ask a question → save to a lead field (typed: text, email, phone, number, choice), Condition (field, answer, tag →
  yes list / otherwise list), Add tag, Set stage, Assign (person, round robin over a team, or the source's rule), Wait
  (minutes or hours, never past the window: a Wait that would outlast it ends the flow with why), Hand to LUME AI
  (Phase 3; shown disabled with why until then), Hand to a person (pauses automation and tells the owner), Book a call
  (sends the business's booking link from Calendly or its meeting settings).
- **Versions**: a flow's steps are an immutable version. Editing makes a new version; running conversations finish on
  theirs. Publishing validates the whole tree.
- **A run**: one active run per conversation. A person's message, an echo, Take over or do-not-contact stops it. Every
  step is idempotent (keyed by run, step path and attempt), so a worker restart never sends twice.
- **Policy**: Meta asks automated experiences to say they're automated where the law requires it and to answer every
  input within 30 seconds. Each account has a short automated-reply note on by default, and a flow waiting on a
  question answers anything unexpected with its fallback, or hands to a person.
- **Templates** (fictional copy, generic): Lead magnet delivery, Qualify and book a call, Price question, Webinar
  sign-up.

### 4.6 The inbox

- **On the lead**: the drawer's conversation tab shows WhatsApp and Instagram in one thread, each message marked with
  its channel; the composer picks the channel the person last wrote on.
- **Inbox page** (new): every conversation the person may see (same RLS scope as leads), newest first, filters by
  channel, account, unread, automation state ("LUME is replying", "With a person", "Needs you"). Keyset pagination,
  never unbounded.
- **Take over / hand back**: per conversation; take over stops the flow and any LUME AI run for that lead.

### 4.7 Analytics

`instagram_flow_events` (triggered, private reply sent, DM sent, replied, lead created, call booked) plus wins joined
from `lead_stage_history`. Per flow and per keyword, by day, rolled up nightly like the existing analytics; a board
under Analytics → Instagram.

### 4.8 Who may do what (new permissions)

| Key | Scoped | Meaning |
|---|---|---|
| `instagram.flows.manage` | | Create, edit, publish flows and triggers |
| `inbox.view` | ✓ | Open the Inbox page (conversations of leads in scope) |
| `messages.send` (existing) | ✓ | Reply on Instagram too, within scope |
| `integrations.manage` (existing) | | Connect and disconnect Instagram accounts |

Later phases add `chat.channels.manage`, `enrichment.use`, `agent.approve`, `ads.manage`; `audit.view` exists.

---

## 5. Schema diff

### 5.1 Phase 1 (migrations 0118–0123; new tables only, plus one column)

| Table | Columns (all `id uuid` v7 unless noted) | Notes |
|---|---|---|
| `instagram_accounts` | `ig_user_id text unique`, `username`, `name`, `account_type`, `token_enc bytea`, `token_at`, `status (active/needs_attention/disconnected)`, `problem`, `owner_user_id` (null = the business's), `run_as uuid`, `new_dm_creates_lead bool default true`, `automated_note text`, `connected_at`, `updated_at` | like `whatsapp_numbers` |
| `instagram_events` | `bigserial id`, `account_id`, `event_key text` (mid, or comment id + field), `kind`, `event_enc bytea`, `status (queued/done/error)`, `problem`, `received_at`, `processed_at`; unique (`account_id`, `event_key`) | each delivery once; content encrypted while it waits, cleared after |
| `instagram_threads` | `account_id`, `igsid`, `lead_id` null, `username`, `name`, `last_in_at`, `ad_window_until`, `last_out_at`, `taken_over_by`, `taken_over_at`, `source jsonb` (trigger, keyword, media id, ad id); unique (`account_id`, `igsid`) | the conversation; null lead = Not a lead yet |
| `instagram_comments` | `account_id`, `comment_id unique`, `media_id`, `media_type`, `parent_id`, `from_igsid`, `from_username`, `text`, `ad_id`, `at`, `private_reply (none/queued/sent/failed)`, `private_reply_at`, `public_reply_at`, `flow_id` | the 7-day private-reply allowance lives here |
| `instagram_outbox` | like `whatsapp_outbox`: `thread_id`, `lead_id`, `user_id`, `client_key unique`, `kind (dm/private_reply/public_reply)`, `comment_id`, `text`, `media_id`, `quick_replies jsonb`, `buttons jsonb`, `tag (null/human_agent)`, `flow_run_id`, `step_key`, `status`, `mid`, `problem`, `tries` | never twice: unique (`flow_run_id`, `step_key`) |
| `instagram_flows` | `name`, `status (draft/live/paused/archived)`, `live_version_id`, `priority int`, `created_by`, `updated_at` | |
| `instagram_flow_versions` | `flow_id`, `version int`, `steps jsonb`, `created_by`, `created_at`; unique (`flow_id`, `version`) | immutable (a trigger refuses UPDATE) |
| `instagram_triggers` | `flow_id`, `account_id` null (all), `kind`, `keywords text[]`, `media_ids text[]`, `ad_ids text[]`, `public_replies text[]`, `cooldown_hours`, `enabled` | |
| `instagram_flow_runs` | `version_id`, `thread_id`, `lead_id`, `status (running/waiting/done/handed/stopped/expired/failed)`, `at_step text`, `answers jsonb`, `next_at`, `reason`, `started_by text`; partial unique (`thread_id`) where running/waiting | |
| `instagram_flow_events` | `bigserial`, `flow_id`, `version_id`, `trigger_id`, `keyword`, `kind`, `lead_id`, `at` | analytics source |
| `leads` (+1 column) | `ad_id text` null | ad attribution, indexed; source stays `source_id` |
| `lead_sources` (CHECK) | `type` gains `instagram` | each connected account is a lead source: its `rules` give the pipeline, stage and owner (a person or round robin), so Instagram leads use the same assignment as every other source and show by source in analytics |
| `oauth_connects` (CHECK) | `kind` gains `instagram` | the one-time connect nonce, as WhatsApp's |

**The licence**: a new plan module `instagram` in `PLAN_MODULES`, sent in a new claim version `plan7` (licence server
change, deployed before or with the LUME release, as `plan6` was). A LUME given an older plan, or no plan, treats
Instagram as included, the same "nothing locked until the owner sets it" rule the tiers follow.

RLS: threads, outbox, comments and flow runs carry `lead_id` and use the existing child-table policy (visible when the
lead is); rows with no lead (Not a lead yet) are reachable only through the routes that check `integrations.manage` or
the account owner, as WhatsApp's are. Activities gain types `instagram_in`, `instagram_out` (no schema change).

### 5.2 Later phases (outline, designed in their own specs)

- **Phase 2**: `chat_channels`, `chat_members`, `chat_messages` (thread = lead / channel / DM pair), `chat_mentions`,
  `chat_reads`; lead threads keyed by `lead_id` under lead RLS.
- **Phase 3**: `agent_briefs` (versioned), Autopilot gains `channel`; `autopilot_*` reused.
- **Phase 4**: `suppressions` (hashed contact keys, reason, source, at), `field_provenance` (lead, field, source,
  provider, at), `provider_accounts` (encrypted key, provider), `enrichment_jobs`, `enrichment_cache`, `credit_ledger`,
  `icp_profiles`, `lead_scores`; retention setting.
- **Phase 5**: `mailboxes`, `sequences`, `sequence_steps`, `sequence_enrolments`, `email_events` (bounce, unsubscribe).
- **Phase 6**: `ad_accounts`, `ad_actions` (proposed/approved/applied/refused, with the Graph request and answer),
  `ad_spend_days`, `ad_caps`.

---

## 6. Services and workers

All inside the existing processes: no new container. Like WhatsApp's, Instagram's queues run in the **api** process
(pg-boss), each job keyed by its row id (`singletonKey`) so a job queued twice runs once.

| Queue / job | Phase | What it does | Workers |
|---|---|---|---|
| `instagram.in` | 1 | Takes a stored event: thread, lead, comment, flow trigger; enqueues follow-ups in the same transaction | 4 |
| `instagram.send` | 1 | Sends one outbox row as the person or the flow; re-checks the window, do not contact, take-over and the account's bucket | 8 |
| `instagram.flow.step` | 1 | Advances a run one step | 4 |
| `instagram.profile` | 1 | Reads username and name once the person has messaged | 2 |
| `instagram.media` | 1 | Fetches a received photo or video into the `files` volume (Meta's links expire) | 2 |
| sweep, every minute | 1 | Runs whose Wait is due; outbox rows stuck in sending → failed with words | 1 |
| sweep, daily | 1 | Token refresh at 30 days; health (account still subscribed, token valid) | 1 |
| relay gap catch-up | 1 | After the relay reports a gap: Conversations API within 2 calls/s | 1 |
| nightly rollup | 1 | `instagram_flow_events` → daily per flow and keyword | 1 |
| `chat.notify` | 2 | Mentions → bell + digest | 2 |
| `autopilot.step` (exists) | 3 | Gains the Instagram channel | as today |
| `enrich.run` | 4 | Waterfall per lead, per provider bucket, cache first | 2 |
| `sequence.send` | 5 | Email steps within caps and warm-up schedule | 2 |
| `ads.sync`, `ads.guard` | 6 | Read spend and CPL hourly; pause above the cap | 1 |

Memory: about 30–60 MB more in the worker at peak (queues are Postgres rows). The scale bar (5,000 new leads a day,
1,000 people) is tested with synthetic data on the build box's scale database, as Phase 7 was.

---

## 7. Settings, env vars and Meta

### 7.1 Env vars

| Where | Name | What |
|---|---|---|
| relay | `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` | the Instagram product's own app id and secret (App Dashboard → Instagram → API setup with Instagram login). All or none. |
| relay | `INSTAGRAM_VERIFY_TOKEN` | 16+ random characters for the webhook handshake |
| relay | `RELAY_DATA_DIR` | a volume for the routing table (one small JSON file) |
| relay | `INSTAGRAM_GRAPH_URL`, `INSTAGRAM_GRAPH_VERSION` | defaults `https://graph.instagram.com`, `v27.0` |
| client | none new | Instagram rides the relay connection WhatsApp and Google already use (`GOOGLE_OAUTH_RELAY_URL`, `_TOKEN`). Caddy adds `/instagram/in` → api. |
| client (optional) | `LUME_IG_SEND_PER_SECOND`, `LUME_IG_PRIVATE_REPLIES_PER_HOUR` | defaults 20 and 600, below Meta's 100/s and 750/h |

### 7.2 Meta App Review checklist (Phase 1)

Before submitting:

1. In the LUME Meta app (1437289605181003): add the **Instagram** product → **API setup with Instagram login**. Note
   the Instagram app id and secret for the relay.
2. Business login settings: OAuth redirect `https://connect.lumecrm.in/ig/callback`; deauthorize callback and data
   deletion request URLs (`https://connect.lumecrm.in/ig/deauthorize`, `/ig/delete`, both forwarded to the client's
   server, which removes the account's tokens and, for a deletion request, the person's Instagram data).
3. Webhooks: callback `https://connect.lumecrm.in/ig/in`, the verify token, fields `messages`,
   `messaging_postbacks`, `messaging_referral`, `messaging_seen`, `message_reactions`, `comments`, `live_comments`.
4. Messaging type in the app: **hybrid** (automation with a person behind it).
5. A test Instagram professional account (a fictional business, public, with posts) added as an Instagram tester; a
   second personal account to comment and DM from.
6. app.lumecrm.in on a build with Phase 1, the account connected, a published flow, a reviewer login (admin, no 2FA or
   the code in the notes).
7. Privacy policy at lumecrm.in/privacy updated for Instagram data (what's read, kept on the client's own server,
   deletion).

Permissions to request, each with its own "how LUME uses it" text and a recording (one take each, about 2 minutes):

| Ask | Recording shows |
|---|---|
| `instagram_business_basic` | Connect from Settings → Integrations → Instagram; the account's name and picture in LUME |
| `instagram_business_manage_messages` | A DM arriving on the lead in LUME; a reply from LUME arriving in Instagram; a flow's quick reply tapped and answered |
| `instagram_business_manage_comments` | A keyword comment on a post → the private reply in the commenter's inbox → the tap → the lead in LUME |
| **Human Agent** feature | A conversation past 24 hours: the composer shows "replying as a person, within 7 days" and the message arrives |

Rule from earlier reviews: read every saved field's full text before Submit; no placeholders.

---

## 8. Phase 1 task breakdown

Estimates are build days including tests, the gate and the review for that task. Total about **20 days**, plus the
owner's App Review time (Meta's answer took about two weeks for WhatsApp).

| # | Task | Days | Depends on |
|---|---|---|---|
| 1 | **Core, pure**: Instagram webhook parser (every event in §4.3, never throws), `instagramWindow`, byte-exact message limits, keyword matcher, flow step schema and validator, flow interpreter (pure: state + event → actions) | 3 | – |
| 2 | **Relay**: `/ig/start`, `/ig/callback`, `/ig/in` (verify, split, forward, gap notes), routing table with file and rebuild, `/ig/forget`, `/ig/gaps`, `/ig/deauthorize`, `/ig/delete`; cross-client isolation tests | 2.5 | 1 |
| 3 | **Migrations 0118–0123** with RLS, schema drift test, grants; the `instagram` plan module (`plan7`) in core, the API's module checks and the licence server's Plan limits | 1.5 | – |
| 4 | **Connect on the client**: start, complete, disconnect, accounts view, daily refresh and health, needs-attention notices, audit | 1.5 | 2, 3 |
| 5 | **Receive**: `/instagram/in`, events store, `instagram.in` (threads, lead match/create, Not a lead yet, comments, echoes, referral, postbacks, reactions, seen), profile and media jobs, live updates | 2.5 | 3, 4 |
| 6 | **Send**: outbox, `instagram.send` (window, tag, private reply allowance, buckets, Meta's errors in words, never twice), reply API, take over / hand back | 2 | 5 |
| 7 | **Flow engine on the server**: flows, versions, triggers CRUD with validation; runs; step queue; sweeps; analytics events; templates | 3 | 1, 6 |
| 8 | **Screens** (after the canvas is approved): Settings → Instagram, the unified conversation in the drawer, Inbox page, flow list and step builder, analytics board | 3 | 4–7 + canvas |
| 9 | **ManyChat helper**, demo seed (fictional account and flows), docs (runbook, App Review text), QA checklist, full e2e, fresh review and fix pass | 1.5 | all |

Each task's edge cases (from the process sheet) include at least: a role losing a lead mid-flow; a person whose handle
is masked; the business's time zone for Waits and analytics days; a webhook twice, out of order (a reply before the
comment it answers), late (past the window) and for a disconnected account; Meta down, rate limiting and a revoked
token; do not contact mid-flow; a stop word in Hinglish; emoji and RTL in keywords; a 1,001-byte message; 14 quick
replies; two admins publishing the same flow; a worker restart mid-send; the relay with one client down; the scale
bar (5,000 comments in an hour on one reel).

---

## 9. Open questions for the owner

Most important first. Phase 1 can be built without answers to Q2–Q10; Q1 decides how far Phase 3 reaches.

1. **Pro and inbound replies.** The brief puts LUME AI inbound qualification in Pro, but Pro can't reply to leads today
   (replies are Max and up, in the PDF clients have). Move replies to Pro for inbound only, or keep inbound
   qualification at Max?
2. **New DMs as leads.** Default "every new person who DMs becomes a lead" (as the brief says), or "wait in Not a lead
   yet"? Plan: become leads, with the switch per account.
3. **Base and "basic flows".** What makes a flow basic? Plan: Base gets every step except Hand to LUME AI (which needs
   AI). No other limit.
4. **App Review timing.** The submission needs the owner's recordings and a test Instagram professional account.
   Submit as soon as Phase 1 is on app.lumecrm.in, or wait for Team Chat?
5. **ManyChat on the same account.** Warn only (plan), or refuse to switch on a LUME keyword that ManyChat may also
   answer? LUME can't see ManyChat's keywords, so refusing would need the admin to tell LUME.
6. **Phase 4 providers.** Which licensed providers do the target clients need? Indian small businesses (coaches,
   clinics, studios) are thin in Apollo-type databases. Candidates to evaluate: email finding/verification
   (Hunter, ZeroBounce or similar) and company data (People Data Labs or similar). Google Places only for enrichment
   on view, never a stored list (§1 row 16).
7. **Resale.** Bring-your-own-key first (no resale agreements needed), or negotiate a reseller agreement now so LUME
   can sell credits with a margin?
8. **Cold email (Phase 5).** Get an Indian data-protection lawyer's opinion before building, given DPDP's consent duties
   from 13 May 2027 and no legitimate-interest ground? Until then Phase 5 would cover only leads who gave their email
   to the business.
9. **Usage reporting.** The brief's "our cost vs revenue per client" needs each LUME to report usage (AI cost, credits)
   to the licence server. Today usage isn't reported, by design (data stays on the client's server). Report only
   counts and costs, never lead data?
10. **Ads (Phase 6).** Is the target client running Meta ads today, and who holds the ad account (the client or an
    agency)? That decides whether LUME connects the client's ad account or works through an agency's business
    portfolio.

---

## Sources

- Meta: [Instagram API with Instagram Login](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login),
  [Send Messages](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api.md),
  [Private replies](https://developers.facebook.com/documentation/instagram-platform/private-replies),
  [Webhook fields](https://developers.facebook.com/documentation/instagram-platform/webhooks/fields),
  [Webhook setup](https://developers.facebook.com/documentation/instagram-platform/webhooks/setup),
  [Business Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login),
  [Messaging policy](https://developers.facebook.com/documentation/business-messaging/messenger-platform/policy),
  [Human Agent](https://developers.facebook.com/docs/features-reference/human-agent),
  [Rate limiting](https://developers.facebook.com/docs/graph-api/overview/rate-limiting),
  [Conversations API](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/conversations-api),
  [User Profile API](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api/user-profile).
- Google: [Places API policies](https://developers.google.com/maps/documentation/places/web-service/policies).
- Apollo: [API terms](https://www.apollo.io/terms/api).
- DPDP: [Rules 2025 timeline (AZB & Partners)](https://www.azbpartners.com/bank/indias-digital-personal-data-protection-act-phased-rollout-and-key-compliance-milestones/),
  [Publicly available data exemption (India Briefing)](https://www.india-briefing.com/news/india-dpdp-act-publicly-available-personal-data-46899.html/).
- Meta Ads MCP and CLI: [overview (mcp.directory)](https://mcp.directory/blog/meta-ads-cli-mcp).
