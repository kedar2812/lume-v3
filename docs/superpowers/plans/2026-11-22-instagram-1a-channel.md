# Instagram 1A: the channel (connect, receive, reply) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A business connects its Instagram professional account to its LUME; every DM, comment, story reply, story
mention and ad click reaches the right lead (or Not a lead yet); people reply from LUME inside Meta's rules.

**Architecture:** Instagram API with Instagram Login. The relay (connect.lumecrm.in) holds the Instagram app secret,
runs the OAuth, keeps a routing table of account → client server, splits Meta's batches and forwards each part signed
with that server's token. The client's LUME keeps each event once (encrypted while waiting), a pg-boss queue in the
api process puts it on a thread and lead, and an outbox + sender queue sends replies, re-checking Meta's window just
before Meta. Mirrors WhatsApp's module file for file where the behaviour is the same.

**Tech stack:** TypeScript, Fastify 5, Zod 4, Drizzle + SQL migrations, pg-boss, Vitest with real Postgres.

**Spec:** `docs/NEW_FEATURES_PLAN.md` §4.1–4.4, §4.6 (reply parts), §5.1, §6, §7. Flows are plan 1B; screens 1C.

## Global constraints

- No `tenant_id`; single-tenant instance. No client names in code, fixtures or copy (`scripts/check-client-names.mjs`).
- Copy speaks as LUME, no em dashes (`scripts/check-copy.mjs`), no over-promising.
- Every `/api/v1` route declares a permission; every new table has RLS or is listed exempt in `rls-coverage.test.ts`.
- Migrations are new files `0118_…` onward, never edits; Drizzle schema matches (`schema.drift.test.ts`).
- Instagram is **off by default** (`settings.integrations.instagram.enabled`), needs the relay and the plan module.
- Meta's numbers (read 2026-11-22): message text ≤ **1000 bytes** UTF-8; quick replies ≤ **13**, title ≤ **20**
  chars; private reply: **one** per comment within **7 days** of the comment; window **24 h** after the person's last
  message, reaction or tap; **7 days** after a first message from an ad click; `human_agent` tag: people only, within
  **7 days** of the person's last message; Send API **100/s** text and **10/s** audio/video per account; private replies
  **750/h** per account; Conversations API **2/s**. Host `graph.instagram.com`, version default `v27.0`.
- Tokens: long-lived 60 days, refreshable once ≥ 24 h old, with `GET /refresh_access_token?grant_type=ig_refresh_token`
  (no app secret). LUME refreshes at 30 days.
- Instagram handles are contact data: masked for people without `leads.contact.full` everywhere they appear.

## Review focus

1. **One client's events reaching another client's server.** A batch with entries for accounts on two servers is split;
   each server gets only its own entries; an account with no route is dropped. Test in Task 2.
2. **Sending outside the window or twice.** The sender re-checks the window, do not contact and take-over in the same
   transaction that claims the row; a row "sending" over 10 minutes fails with words, never resent. Tests in Task 6.
3. **A masked rep seeing a handle.** Thread and Not a lead yet views run the lead serializer's masking. Test in Task 5.
4. **Events out of order or late.** A reply's postback before the message it answers, an echo before the outbox row's
   `mid` is stored, a webhook for a disconnected account, the same event twice. Tests in Task 5.
5. **Token trouble.** Refresh refused (190), Meta down at refresh, a revoked token mid-send: the account goes to
   "needs attention", admins told once, nothing sent with a dead token. Tests in Tasks 4 and 6.

---

### Task 1: Core rules (pure)

**Files:**
- Create: `packages/core/src/instagram/webhook.ts`, `window.ts`, `limits.ts`, `keywords.ts`, `outbound.ts`, `index.ts`,
  `fixtures.ts`
- Tests: `webhook.test.ts`, `window.test.ts`, `limits.test.ts`, `keywords.test.ts`, `outbound.test.ts` beside them
- Modify: `packages/core/src/index.ts` (export `./instagram`)

**Interfaces (produces):**
- `readInstagramWebhook(body: unknown): IgEvent[]` — never throws; drops what it can't read.
  `IgEvent` = discriminated union on `kind`:
  `message` {accountId, igsid, mid, at, text, attachments: IgAttachment[], replyToStory: {id,url}|null,
  storyMention: {url}|null, quickReply: string|null, referral: IgReferral|null, isEcho: boolean}
  · `postback` {accountId, igsid, mid, at, title, payload, referral}
  · `referral` {accountId, igsid, at, referral} (`messaging_referral` without a message)
  · `reaction` {accountId, igsid, mid, at, action: "react"|"unreact", emoji|null}
  · `seen` {accountId, igsid, mid, at}
  · `comment` {accountId, commentId, mediaId, mediaType|null, parentId|null, fromIgsid, fromUsername, text, at,
    adId|null, live: boolean}.
  For echoes `igsid` is always the **other** person (recipient), never the account. `IgReferral` = {source, type, adId,
  ref, adTitle}. `IgAttachment` = {type: "image"|"video"|"audio"|"file"|"share"|"story_mention"|"ig_reel"|"reel"|
  "unsupported", url|null}.
  `eventKey(e: IgEvent): string` — the dedupe key: `m:<mid>` for message, `p:<mid>`, `r:<mid>:<action>`,
  `s:<mid>`, `c:<commentId>`, `ref:<igsid>:<at>`.
- `instagramWindow(t: { lastInAt: Date|null; adWindowUntil: Date|null }, now: Date): IgWindow` where
  `IgWindow = { state: "open"; until: Date } | { state: "human"; until: Date } | { state: "closed"; since: Date|null }`.
  Open = within 24 h of `lastInAt` or before `adWindowUntil`; human = within 7 days of `lastInAt`.
- `privateReplyOpen(c: { at: Date; privateReply: "none"|"queued"|"sent"|"failed" }, now: Date): boolean` — true only
  for `none` or `failed` and `now < at + 7 days`.
- `IG_LIMITS = { textBytes: 1000, quickReplies: 13, quickReplyChars: 20, genericCards: 10, cardTitleChars: 80,
  cardButtons: 3, buttonTextChars: 640 }`; `textBytes(s: string): number`; `messageProblems(m: IgOutMessage):
  string[]` (words, empty = fine).
- `IgOutMessage = { text: string|null; mediaUrl?: string|null; mediaKind?: "image"|"video"|"audio"|"file";
  quickReplies?: { title: string; payload: string }[]; buttons?: { title: string; url: string }[] }`.
- `outboundBody(to: { igsid: string } | { commentId: string }, m: IgOutMessage, tag?: "HUMAN_AGENT"): object` — the
  Send API JSON (quick replies as `content_type: "text"`; buttons as a button template).
- `refusalOfIg(status: number, err: unknown): { code: string; words: string; retry: boolean; token: boolean }` —
  maps Meta's errors: 190/OAuth → token; 4, 17, 32, 613, 80002 → retry (rate); code 10 / 2534022 / 551 → outside the
  window or person unavailable (no retry); 100 invalid recipient (no retry); 5xx/network → retry.
- `matchKeyword(text: string, keywords: string[], mode: "word"|"exact"|"any"): string|null` — the keyword that matched,
  folded (NFKD, accents off, lower case), whole words in any script (Devanagari, Arabic, emoji keywords match as
  substrings), `any` matches every non-empty text.

- [ ] **Step 1: Write the failing tests.** Fixtures from Meta's example payloads (`fixtures.ts`: `igDm`, `igEcho`,
  `igStoryReply`, `igStoryMention`, `igAdDm`, `igPostback`, `igQuickReply`, `igReaction`, `igSeen`, `igComment`,
  `igAdComment`, `igLiveComment`, `igBatch` with two accounts). Tests (names are the assertions):
  - webhook: each fixture → exactly one event of its kind with its fields; echo's igsid is the recipient; a batch of 2
    accounts keeps `accountId` per entry; `{}`, `null`, `"x"`, a missing `messaging` array, an unknown field → `[]`;
    an entry with 1 good and 1 malformed item → 1 event; `message.text` of 5,000 chars kept whole (no truncation here);
    timestamps in ms become `Date`; `eventKey` is distinct for react vs unreact of one mid.
  - window: 23h59m after `lastInAt` open; 24h00m+1ms human; 7d+1ms closed; `adWindowUntil` in future and lastIn 3
    days ago → open until `adWindowUntil`; both null → closed with since null; clock in UTC+5:30 and UTC−8 gives the
    same answer (pure UTC maths).
  - private reply: none at 6d23h → true; at exactly 7d → false; sent → false; failed at 1h → true; queued → false.
  - limits: "a".repeat(1000) ok; 1001 → problem; 250 × "😀" (4 bytes) ok, 251 → problem; 333 × "क" (3 bytes) ok, 334
    → problem; 14 quick replies → problem; a 21-char title → problem; a quick reply with blank title → problem; a
    button URL not https → problem; text null with no media → problem.
  - outbound: comment target → `recipient: { comment_id }`; quick replies shape; HUMAN_AGENT adds `messaging_type:
    "MESSAGE_TAG", tag: "HUMAN_AGENT"`; buttons → template with `template_type: "button"`.
  - refusal: each code above → its class; unknown JSON → retry once-type `unknown`; HTML error body → retry.
  - keywords: "PRICE" matches "what's the price?" (word); "price" doesn't match "priceless"; "प्राइस" matches in
    Devanagari text; "café" matches "CAFE"; "🔥" matches "love this 🔥🔥"; exact mode "guide" vs "the guide" → null;
    empty keywords → null; whitespace-only text → null; first matching keyword in list order returned.
- [ ] **Step 2: Run** `npx vitest run packages/core/src/instagram` → FAIL (modules missing).
- [ ] **Step 3: Implement** the files above. Parse with Zod `safeParse` per item (as `whatsapp/webhook.ts`).
- [ ] **Step 4: Run** the same → PASS. Mutation check: drop the `+ 7 days` bound in `privateReplyOpen` → a test fails;
  change 1000 to 1001 → a test fails. Record both in the ledger.
- [ ] **Step 5: Commit** `feat(instagram): core rules for Meta's webhooks, window and limits`.

### Task 2: The relay

**Files:**
- Create: `apps/connect/src/instagram.ts`, `apps/connect/src/routes-store.ts`, tests `instagram.test.ts`,
  `routes-store.test.ts`; `apps/api/test/instagram-fake.ts` (Instagram Graph + OAuth fake, real HTTP, as `meta-fake.ts`)
- Modify: `apps/connect/src/relay.ts` (mount at `/ig/`), `main.ts` (env), `README.md`;
  `packages/core/src/relay/protocol.ts` (`Handoff.kind` + `instagram` part)

**Interfaces (produces):**
- Env: `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `INSTAGRAM_VERIFY_TOKEN` (all or none), `RELAY_DATA_DIR` (required
  when they're set), `INSTAGRAM_GRAPH_URL` (default `https://graph.instagram.com`), `INSTAGRAM_OAUTH_URL` (default
  `https://www.instagram.com/oauth/authorize`), `INSTAGRAM_TOKEN_URL` (default
  `https://api.instagram.com/oauth/access_token`), `INSTAGRAM_GRAPH_VERSION` (default `v27.0`).
- `Handoff.instagram = { token: string; expiresIn: number; userId: string; username: string; name: string|null;
  accountType: string|null }`, `kind: "instagram"`.
- `createRouteStore(file: string, now: () => number): RouteStore` with `get(accountId): string|undefined`,
  `set(accountId, instanceId): string|undefined` (returns the instance it replaced), `drop(accountId, instanceId):
  boolean` (only if it's that instance's), `replaceFor(instanceId, accountIds: string[])`, `size()`. Writes are atomic
  (write temp + rename), serialised; a corrupt or missing file starts empty and logs.
- Routes:
  - `GET /ig/start?i&n&s` — signed `${n}.instagram` by the instance → 302 to Instagram's authorize URL with scopes
    `instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments`, redirect
    `<public>/ig/callback`, packed state (`k: "instagram"`, 10 min).
  - `GET /ig/callback?code&state` — `error=access_denied` → words page; exchange code (short-lived) → long-lived
    (`ig_exchange_token`, secret) → `GET /me?fields=user_id,username,name,account_type` → `POST
    /<user_id>/subscribed_apps?subscribed_fields=messages,messaging_postbacks,messaging_referral,messaging_seen,message_reactions,comments,live_comments`
    → routes.set → if it replaced another instance, POST that instance `/instagram/moved` (signed, best effort) →
    seal Handoff → 302 `<inst>/settings/integrations/instagram/connected?p&s`. Any Meta failure: words page, no route
    written. A personal (non-professional) account: words page "Instagram only lets LUME connect a professional
    account…".
  - `GET /ig/in` — handshake with `INSTAGRAM_VERIFY_TOKEN`.
  - `POST /ig/in` — body ≤ 3 MB; signature checked with `INSTAGRAM_APP_SECRET` (and, while unverified, also the Meta app
    secret if set: whichever Meta uses for Instagram Login is logged once at info, then the other is removed after the
    test-account check); parse `{object:"instagram", entry:[…]}`; group entries by route; per instance, POST
    `{object, entry:[its entries]}` re-serialised to `/instagram/in` with `x-lume-timestamp`/`x-lume-signature`
    (10 s timeout). Answer: 200 when every group got 2xx or was dropped (no route); 503 when any group failed **and**
    that instance's first failure in this streak is < 15 minutes old; otherwise 200 and a gap note
    `{instanceId, accountIds, from, to}` appended to the store (no content).
  - `POST /ig/forget` (Bearer instance token, `{accountId}`) → `drop` → 200 `{dropped}`.
  - `GET /ig/gaps` (Bearer) → that instance's gap notes; `POST /ig/gaps/clear` (Bearer, `{upTo}`) clears them.
  - `POST /ig/deauthorize`, `POST /ig/delete` (Meta's signed_request, HMAC-SHA256 with the app secret) → forward to
    the instance owning `user_id` at `/instagram/deauthorize` / `/instagram/delete`; answer delete with Meta's JSON
    `{url, confirmation_code}`.
  - On start: for each instance, `GET <inst>/instagram/accounts` (signed) → `replaceFor` (an instance that doesn't
    answer keeps its stored routes).

- [ ] **Step 1: Failing tests** (`instagram.test.ts`, with two fake instances A and B and the fake Graph):
  start refuses a bad signature, a sheet's signature, an unknown instance; callback happy path seals a hand-back only A
  can open, subscribes with exactly those fields, writes the route; denied consent → words, no route; Meta 500 on
  exchange / long-lived / me / subscribe → words, no route, no hand-back; personal account → words; reconnect of an
  account A holds onto B → route moves to B and A is told `/instagram/moved`; batch with entries for A's and B's
  accounts → A receives only its entry, B only its, each signed with its own token and verifiable with `relayCheck`;
  unknown account entry → dropped, 200; bad Meta signature → 401 and nothing forwarded; B down for < 15 min → 503, A
  still forwarded; B down > 15 min → 200 and a gap note for B; `/ig/gaps` with A's token never shows B's gaps;
  `/ig/forget` by B for A's account → not dropped; body 3 MB + 1 → 413; deauthorize with a forged signed_request →
  400; restart rebuilds routes from instances. `routes-store.test.ts`: write → new store reads it; corrupt JSON →
  empty, no throw; concurrent `set`s all persist; temp file never left behind.
- [ ] **Step 2: Run** `npx vitest run apps/connect` → FAIL.
- [ ] **Step 3: Implement.** Keep `whatsapp.ts` untouched apart from shared helpers moved to `apps/connect/src/http.ts`
  (rawBody, HARDENED) if both use them.
- [ ] **Step 4: Run** → PASS. Mutation: forward the whole batch to every instance → the isolation test fails; skip the
  signature check → the 401 test fails. Ledger.
- [ ] **Step 5: Commit** `feat(relay): Instagram connect, routing table and per-client forwarding`.

### Task 3: Tables, the plan module, settings

**Files:**
- Create: `packages/db/migrations/0118_instagram.sql`, `packages/db/src/schema/instagram.ts`
- Modify: `packages/db/src/schema/index.ts`, `identity.ts` (integrations type gains `instagram?: { enabled?: boolean }`),
  `intake.ts` (source type), `packages/core/src/licence/fleet.ts` (`PLAN_MODULES` + `instagram`, schema
  `instagram: z.boolean().optional()`, `ACCEPTS` + `plan7`, `PLAN_V2_MODULES` = the six before), `apps/licence/src/server/plan.ts`
  (`v7` sends `instagram`; older get the six), `check.ts` (`v7` flag), `MODULE_WORDS`, licence screens' module list;
  `apps/api/src/licence/plan.ts` `MODULE_NAMES`; `apps/api/test/rls-coverage.test.ts` if exemptions are needed.
- Tests: `packages/db/src/instagram.test.ts`, `packages/core/src/licence/plan.test.ts`, `apps/licence` plan tests.

**Interfaces (produces):** tables exactly as `NEW_FEATURES_PLAN.md` §5.1 for `instagram_accounts`, `instagram_events`,
`instagram_threads`, `instagram_comments`, `instagram_outbox` (flows' tables come in plan 1B), plus
`instagram_media` (as `whatsapp_media`: thread, outbox-or-event, url, status waiting/kept/gone, file hash), plus
`instagram_ignored` (account, igsid). `lead_sources.type` CHECK gains `instagram`; `lead_sources.instagram_account_id`
uuid null unique. `oauth_connects.kind` gains `instagram`. `leads.ad_id text` with a partial index. RLS: threads,
outbox and media `USING (lead_id IS NULL AND lume_scope() = 'all' OR EXISTS (lead visible))`; accounts, events,
comments, ignored exempt as intake tables (like `whatsapp_events`), reached only by routes that check
`integrations.manage` or by jobs. Live triggers: `pg_notify('lume_instagram', {lead, kind:'in'|'out'|'status'})` on
`activities` of type `instagram_received`/`instagram_sent` and on outbox status, never with words.

- [ ] **Step 1: Failing tests:** migrate a fresh DB; insert the same `(account_id, event_key)` twice → one row; two
  threads same `(account_id, igsid)` → unique violation; a rep (`own` scope) can't select another rep's lead's thread;
  a Not-a-lead-yet thread (lead null) is invisible to `own` and visible to `all`; `instagram_outbox` same
  `(user_id, client_key)` twice → violation; notify fires with no text in its payload. Licence: `ACCEPTS` ends with
  `plan7`; a plan7 claim with `instagram:false` → `moduleIncluded(plan,"instagram") === false`; a plan6 claim (no key)
  → true; licence server: `planOf(row,{v2,…,v6:true})` has no `instagram` key; with `v7:true` it has it, false when
  the owner left it out.
- [ ] **Step 2–4:** run → FAIL; write the migration and schema; run → PASS; `schema.drift.test.ts` and
  `rls-coverage.test.ts` pass. Mutation: remove the RLS policy on `instagram_threads` → the rep test fails.
- [ ] **Step 5: Commit** `feat(instagram): tables, the plan module (plan7) and the settings switch`.

### Task 4: Connecting an account (client side)

**Files:**
- Create: `apps/api/src/modules/instagram/` `routes.ts`, `service.ts`, `graph.ts` (the Graph client: `me`, `profile`,
  `send`, `privateReply`, `publicReply`, `refresh`, `subscribe`, `unsubscribe`, `conversations`, `download`),
  `token-refresh.ts`, `health.ts`; tests `connect.test.ts`, `token.test.ts`; `apps/api/test/instagram.ts` (helpers:
  `seedAccount`, `deliverIg`)
- Modify: `apps/api/src/app.ts` (register routes; `AppDeps.instagram` queue handle; `d.instagramGraph` config),
  `apps/api/src/main.ts`, `packages/config/src/schema.ts` (`LUME_IG_SEND_PER_SECOND` default 20,
  `LUME_IG_PRIVATE_REPLIES_PER_HOUR` default 600, `INSTAGRAM_GRAPH_URL`/`_VERSION` for e2e), `apps/api/test/probes.ts`,
  `packages/core/src/audit/words.ts` (`instagram.connected|reconnected|disconnected|moved|owner|settings`).

**Interfaces (produces):**
- `PUT /api/v1/integrations/instagram` `{enabled?: boolean, newDmCreatesLead?: {accountId, value}}`
  (`integrations.manage`); enabling needs the relay and `assertModule(req,"instagram")`.
- `POST /api/v1/instagram/connect` → `{url}`; `POST /api/v1/instagram/connect/complete {p,s}` → accounts view;
  `GET /api/v1/instagram/accounts`; `PATCH /api/v1/instagram/accounts/:id {ownerId?, newDmCreatesLead?,
  sourceRules?}`; `DELETE /api/v1/instagram/accounts/:id`.
- Public, relay-signed: `POST /instagram/in` (Task 5), `GET /instagram/accounts` (relay rebuild: `{accountIds}`),
  `POST /instagram/moved`, `/instagram/deauthorize`, `/instagram/delete`.
- Completing a connect creates (or revives) the account's `lead_sources` row (`type: "instagram"`, name "Instagram
  @username", rules: default pipeline's first open stage, owner = the account owner or round robin as set).
- `instagramOn(req): Promise<boolean>`, `igTokenContext(id) = "instagram-account:<id>"`.
- `sweepInstagramTokens(pool, d)`: tokens ≥ 30 days old refreshed; 190 → `needs_attention` + admins told once
  ("Instagram stopped letting LUME in. Connect @x again."); network error → tried next hour.

- [ ] **Step 1: Failing tests:** enable without relay → 409 `NOT_CONFIGURED`; without module → 409 `PLAN_MODULE`; a rep
  → 403; start writes one nonce; complete with tampered `p` → 400; expired → 400; another admin's nonce → 404; used
  twice → 404; happy path stores the token encrypted (never in any API answer, never in logs), creates the lead
  source, audits; reconnecting the same account keeps its id, threads and source; `/instagram/moved` (signed) marks it
  disconnected with "Connected to another LUME" and tells admins; disconnect calls the relay's forget and Meta's
  unsubscribe, drops the token, keeps leads' history, removes Not a lead yet threads; disconnect when Meta refuses →
  still disconnected; token at 29 days → untouched; at 30 → refreshed and `token_at` moved; refusal 190 → needs
  attention and one notice even when the sweep runs twice; relay `GET /instagram/accounts` lists active accounts only.
- [ ] **Step 2–4:** red → implement → green. Mutation: skip the nonce owner check → the "another admin" test fails.
- [ ] **Step 5: Commit** `feat(instagram): connect, disconnect and token refresh`.

### Task 5: Receiving

**Files:**
- Create: `apps/api/src/modules/instagram/receive.ts`, `process.ts`, `inbox.ts`, `profile.ts`, `media.ts`, `queue.ts`,
  `thread.ts`; tests `receive.test.ts`, `process.test.ts`, `inbox.test.ts`, `thread.test.ts`
- Modify: `apps/api/src/modules/notifications/hub.ts` + `routes.ts` (`lume_instagram` → `event: instagram`),
  `packages/core/src/queues.ts` (`instagram.process`, `instagram.media`, `instagram.profile`, `instagram.send`),
  `infra/Caddyfile` (`/instagram/*` → api), `apps/api/src/licence/enforce.ts` (exempt `/instagram/in`)

**Interfaces (produces):**
- `POST /instagram/in`: relay check + replay guard as WhatsApp's; 200 when locked, off, out of plan, or unknown
  account; each event inserted once into `instagram_events` (encrypted, `igEventContext(key)`), queued.
- `processInstagramEvent(d, eventId)`: runs as the account's `run_as` with all-leads scope.
  - message (not echo): thread upsert (`last_in_at` = event time if newer; `ad_window_until` = at + 7 d when the
    message carries an ad referral and it's the thread's first message); lead = thread's lead → else a lead whose
    `lead_contact_keys` instagram hash = username (once the profile is read) → else create via the account's lead
    source (if `new_dm_creates_lead`) or leave in Not a lead yet; activity `instagram_received` `{mid, accountId,
    text, attachments, story, referral, quickReply}`; `leads.last_reply_at`; stop word → do not contact (existing
    `isStop`, `setDoNotContact`); notify the lead's owner (deduped 10 min, existing `notify` kind `lead_replied`);
    Autopilot hooks are **not** called (plan 3).
  - echo: thread `last_out_at`; if an outbox row has this `mid`, nothing new; else activity `instagram_sent` `{mid,
    via:"echo"}` and the thread is **taken over** by the account owner (or the lead's owner).
  - postback / quick reply / reaction / referral-only: thread `last_in_at` (opens the window); activity for
    postback/quick reply (`instagram_received` with `tap`); reaction updates the outbox row's `reaction`.
  - seen: outbox rows with `mid` ≤ seen → status `read` (forward only).
  - comment: `instagram_comments` upsert; the account's own comments ignored; comment kept for flows (1B); creates the
    thread with `lead` per the same rules once a flow runs (1B), not on the comment alone.
  - A message for a thread whose lead was deleted → treated as a new person (lead deleted ≠ person gone).
- `instagram.profile`: `GET /<igsid>?fields=name,username,profile_pic,is_user_follow_business` once per thread a day,
  only after the person messaged; consent error → retried never.
- `instagram.media`: downloads attachment URLs only from Meta's hosts (`*.cdninstagram.com`, `*.fbcdn.net`,
  `lookaside.fbsbx.com`) into the `files` volume via the existing keep path, 25 MB cap, type sniffed from bytes.
- Not a lead yet: `GET /api/v1/instagram/inbox` (account owners and `integrations.manage`), `POST
  /api/v1/instagram/inbox/:threadId/lead`, `POST …/ignore`; 14-day sweep.
- `GET /api/v1/leads/:id/instagram` (`leads.view`): the thread(s), newest 500 messages, window state per thread, the
  handle masked by the lead serializer's rules.

- [ ] **Step 1: Failing tests:** every `IgEvent` kind lands as described; the same delivery twice → one activity; the
  postback arriving before its message → both kept, order by Meta's time; echo before the outbox `mid` stored → one
  message, not two (the sender stores `mid` in the same transaction it marks sent; the echo path checks by `mid`
  again after a 30 s delay job); a DM to a disconnected account → nothing kept; Instagram off → 200, nothing kept;
  `new_dm_creates_lead=false` → Not a lead yet, then "Make a lead" moves the messages; username matching a lead
  imported from ManyChat (`instagram_handle` "@Priya.Fit" vs username "priya.fit") → that lead; two leads with that
  handle → the account owner's, else the most recently active; "STOP" and "band karo" → do not contact before
  anything else; a rep without `contact.full` reading the thread sees `@p•••.fit`; a rep without the lead → 404;
  media from a non-Meta host → not fetched; 5,000 events in one minute → all kept, queue drains within the test's
  budget (scale bar), no N+1 (query count per event bounded).
- [ ] **Step 2–4:** red → implement → green. Mutation: drop the `onConflictDoNothing` → the duplicate test fails; skip
  masking in the thread view → the rep test fails.
- [ ] **Step 5: Commit** `feat(instagram): receive DMs, comments, story replies, mentions and ad clicks`.

### Task 6: Replying

**Files:**
- Create: `apps/api/src/modules/instagram/send.ts`, `sender.ts`, `takeover.ts`; tests `send.test.ts`, `sender.test.ts`,
  `takeover.test.ts`
- Modify: `routes.ts`, `queue.ts`

**Interfaces (produces):**
- `POST /api/v1/leads/:id/instagram/messages` (`messages.send`, scoped) `{clientKey: uuid, threadId: uuid, text?,
  mediaId?, quickReplies?, retryOf?}` → 202 `{message}`. Window from `instagramWindow`; `human` sends with the tag and
  says so; `closed` → 409 `WINDOW_CLOSED` with when it reopens (never); do not contact → 409 `DO_NOT_CONTACT`; limits
  30/min, 600/h per person (shared limiter with WhatsApp's `sendLimiter`).
- `POST /api/v1/instagram/comments/:id/private-reply` (`messages.send`) — once per comment within 7 days; the
  comment's author must map to a lead the person can see, or the person has `integrations.manage`.
- `POST /api/v1/instagram/threads/:id/take-over`, `/hand-back` (`messages.send`, scoped by the lead).
- `sendInstagramOutbox(d, id)`: claims `queued → sending` only when no older row for the thread is queued/sending;
  in the same transaction re-checks the window (with the tag allowance only when `user_id` is a person and the row
  isn't from a flow), do not contact, the account active; per-account token bucket (`LUME_IG_SEND_PER_SECOND`, 10/s
  for audio/video, `LUME_IG_PRIVATE_REPLIES_PER_HOUR` for private replies) — over the bucket → delay job, not failure;
  Meta answer → `sent` with `mid`; refusal → `refusalOfIg` words; token → account `needs_attention`; stuck `sending`
  > 10 min → failed "LUME couldn't tell whether this went. Check Instagram before sending it again."; 8 tries.

- [ ] **Step 1: Failing tests:** send inside 24 h → Meta got exactly `outboundBody` and the outbox is `sent` with `mid`;
  the same `clientKey` twice → one message; two tabs racing → one; at 24h+1ms by a person → sent with HUMAN_AGENT and
  marked; at 7d+1ms → 409 and nothing queued; a window that closes between queue and send → failed with words, not
  sent; do not contact set between queue and send → cancelled, not sent; take-over then the person sends → allowed;
  1,001-byte text → 400 with words; Meta answers 613 twice then 200 → sent once, three calls; a lost answer
  (`takeThenLose`) → after 10 min failed with words, never a second call; token 190 → account needs attention, admins
  told once, the next queued row not attempted; private reply twice on one comment → second 409; at day 7 → 409;
  bucket of 20/s: 50 sends queued at once → Meta sees ≤ 20 in any second; a rep sending on another rep's lead → 404.
- [ ] **Step 2–4:** red → implement → green. Mutation: remove the in-transaction window re-check → the "closes between"
  test fails; remove the private-reply guard → the "twice" test fails.
- [ ] **Step 5: Commit** `feat(instagram): reply from LUME inside Meta's window`.

### Task 7: Catching up after a gap, deletion requests, the gate

**Files:**
- Create: `apps/api/src/modules/instagram/catch-up.ts`, `privacy.ts`; tests `catch-up.test.ts`, `privacy.test.ts`
- Modify: `queue.ts` (hourly: `GET /ig/gaps`; per gap, Conversations API for the account at ≤ 2 calls/s, messages
  newer than the gap's start, each through the same insert-once path; then `POST /ig/gaps/clear`),
  `docs/runbooks/instagram.md` (new), `docs/NEW_FEATURES_PLAN.md` (status line)

**Interfaces:** `catchUp(d, gap)`; `/instagram/deauthorize` → account `disconnected` with "Instagram said LUME may no
longer use @x"; `/instagram/delete` `{userId}` → the person's Instagram threads, messages' words and media removed
from leads (activities kept as "Instagram message removed at the person's request"), confirmation code returned.

- [ ] **Step 1: Failing tests:** a 2-hour gap with 3 conversations → missed messages land once, already-kept ones not
  repeated; Conversations API 429 → waits and resumes; a gap older than 30 days → only what Meta still returns;
  delete request → words gone, lead stays; deauthorize → no further sends.
- [ ] **Step 2–4:** red → implement → green.
- [ ] **Step 5: The full gate on the build box** (`docs/QUALITY_PROCESS.md` §4), judged by exit codes; a fresh
  reviewer over the whole 1A diff; fixes test-first; push; ledger line per task in
  `.superpowers/sdd/2026-11-22-instagram-1a/progress.md`.
