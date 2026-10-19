# WhatsApp W3a: Reply from LUME — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person replies to a lead on WhatsApp from the lead's WhatsApp tab in LUME, with text and files. The message goes from the client's connected number, shows on the phone too, and its sent, delivered, read or failed status comes back by itself.

**Architecture:**
- **The request.** The route checks everything a person can be told at once: the admin switch, permission, the 24-hour window, the number, the limits and idempotency. It writes a `whatsapp_outbox` row and a `whatsapp_sent` activity (status `queued`) in one transaction, then queues `whatsapp.send`.
- **The job.** It runs as the sender (`withJobRequest` with their actor). It uploads a file to Meta once per number and content, sends, stores the `wamid`, and then does what a send means in LUME: the lead's last message time, the follow-up marked done, the stage's move.
- **Status.** Meta's `statuses` webhooks move the outbox status forward only.
- **The thread.** It shows each message LUME sent with who sent it and its ticks.

**Tech Stack:** Fastify + Drizzle + Postgres RLS, pg-boss, Next.js, Vitest, Playwright, the fake Meta (`apps/api/test/meta-fake.ts`, `apps/web/e2e/meta-fake.ts`).

**Spec:** `docs/superpowers/specs/2026-10-18-whatsapp-replies-ai-design.md` §3.4 (Decision 2: yes) and §4.3, the "lead wrote within 24 hours" route. The owner asked again on 2026-10-19 ("why not add the feature of sending messages via lume itself"), and added: every edge case and security case listed with its fix; strong for 100–1,000 people.

## Global Constraints

- **The admin switch is "Reply from LUME", off by default** (§3.4). It lives in `settings.integrations.whatsapp.replyFromLume`. It's usable only while WhatsApp is on and in the plan.
- **A person still types and taps Send** (§3.4). Nothing is ever sent by itself.
- **Free text and files only within 24 hours of the lead's last message on that number** (§3.4, §4.3). Outside it, the composer says so and offers the phone. Media templates are W3b.
- **File limits, Meta's (§4.3, to verify):**
  - images: JPEG, PNG; ≤ 5 MB;
  - video: MP4, 3GPP; ≤ 16 MB;
  - audio: AAC, MP4, MPEG, AMR, OGG; ≤ 16 MB;
  - documents: PDF, Word, Excel, PowerPoint, TXT; ≤ 25 MB (LUME's own cap, as for files it keeps).
- **Permission is `messages.send` on the lead** (`canOnRecord`, as `sendable` in `leads/sending.ts`).
- **Copy:** speaks as "LUME"; no em dashes in UI copy; months first in dates; names the lead, never "he" or "she".
- **Lead data reaches only Meta**, through the client's own number and token. The relay never sees outgoing messages.
- **1,000 people:**
  - the per-person limit is 30 messages a minute and 600 an hour;
  - the queue has 8 senders;
  - each file is uploaded to Meta once per number and content (cached 25 days);
  - every list and query is indexed and bounded.

## Every outcome, and its fix

The task named in brackets builds and tests each one.

**Who and when**
1. **The switch is off, the person lacks `messages.send`, or can't see the lead.** Off gives 409 with "Replying from LUME is off. An admin can switch it on in Settings → Integrations → WhatsApp." The other two give 403 and 404, as everywhere. [T3]
2. **The lead never wrote on WhatsApp, or the window closed while the person was typing.** It's re-checked on send and gives 409 `WINDOW_CLOSED` with "It's been over 24 hours since {first name}'s last WhatsApp message. Send it from the phone, or wait for {first name} to write again." The composer shows the same words with "Open WhatsApp". [T3, T5]
3. **The lead wrote to two numbers.** It replies from the number of the lead's latest message, and the composer says which ("From +91 90000 00001"). [T3]
4. **That number is disconnected or needs attention.** 409 with its words ("Connect +91 90000 00001 again to reply from LUME."). [T3]
5. **The number is another person's own number.** Allowed: the lead wrote to it. The composer says "From Priya's number". Permission still decides who may send. [T3]

**Sending**
6. **A double click, a retry after a timeout, or two tabs.** `clientKey` (a UUID from the composer) is unique per person, so the same key returns the same message and nothing is sent twice. [T3]
7. **A crash after Meta accepted but before LUME saved the `wamid`.** The job sets `sending` before calling Meta. A job that finds `sending` older than 2 minutes never resends: it marks the message failed with "LUME couldn't tell whether this went. Check the phone before sending it again." [T4]
8. **Meta refuses.** Each code becomes words:
   - 131047 window closed;
   - 131026 not on WhatsApp or can't receive;
   - 131051 type not supported;
   - 131053 file couldn't be read;
   - 130472 Meta held it back;
   - 190 token, which also puts the number in "needs attention";
   - 130429 and 131056 rate limits, which are tried again with backoff (5 tries), then failed.
   A failed message shows its words and "Try again", which makes a new message. [T1, T4]
9. **Meta is slow or down.** Up to 5 tries with backoff, then failed with "WhatsApp didn't take this message. Try again." [T4]
10. **Text:** empty or whitespace only gives 400. Over 4,096 characters gives 400 with "WhatsApp messages can be up to 4,096 characters." It's stored as typed (no trimming inside). [T3]
11. **A caption on a file:** up to 1,024 characters (Meta's limit), and only on images, video and documents (Meta allows no caption on audio). [T1, T3]

**Files**
12. **A file whose name or `content-type` lies** (an `.exe` renamed `.pdf`, HTML sent as an image). The type is read from the first bytes and must agree with the allow-list, or 415 with "LUME can send photos (JPEG, PNG), videos (MP4), voice notes and documents (PDF, Word, Excel, PowerPoint, text)." [T3]
13. **Over the size for its type.** 413 with words naming the limit ("Photos can be up to 5 MB."). [T3]
14. **The same brochure to 150 leads.** It's stored once (the file store). Meta upload cache `whatsapp_meta_uploads(number_id, sha256)` keeps its Meta media id for 25 days (Meta's ids last 30), so it's uploaded once per number. A Meta "media not found" on a cached id drops it and uploads again, once. [T4]
15. **A file attached but never sent** (the person changed their mind). It's a draft (`whatsapp_media.draft`). Drafts over 24 hours old are removed by the hourly sweep, and the file goes when nothing else points at it. [T2, T4]
16. **A file attached to one lead, sent to another** (a crafted request). The send checks the media is a draft of this lead, uploaded by this person. Otherwise 400. [T3]
17. **The disk is full when a file is attached.** 507 with "The server's disk is full. Ask an admin to free space." (the 95% guard). [T3]

**Status**
18. **Statuses out of order** (read before delivered, or a late "sent"). The status only moves forward: queued < sending < sent < delivered < read. `failed` is final unless it arrives after delivered, where it's ignored. [T4]
19. **The same status twice** (Meta retries). Deduplicated in `whatsapp_events` on (`wamid`, `status_<name>`). [T1, T4]
20. **A status for a message LUME didn't send** (from the phone). Ignored. [T4]

**What a send means**
21. **It counts once Meta accepts it, not when it's queued.** That means `lastMessageAt`, a follow-up done (`taskId` optional, from the composer when opened from a follow-up), and the stage's "sent" move, run as the sender. A send that later fails doesn't undo them, because Meta accepted it. [T4]
22. **The sender lost access before the job ran.** Failed with "{name} can't message this lead any more." Nothing is sent. [T4]
23. **The echo.** Meta doesn't echo API sends as `smb_message_echoes`. If it ever does, the dedup on `wamid` in `process.ts` keeps it to one message. [T4 test]

**Scale (1,000 people)**
24. **A rush (100 reps sending at once).** 8 queue workers, and Meta's 80 messages a second per number is respected by backoff on 130429. A message sent with no request in flight still shows as queued. [T4]
25. **The per-person limit:** 30 a minute and 600 an hour, in memory (one API process per client). Over it gives 429 with "That's a lot of messages at once. Wait a minute and send again." [T3]
26. **The thread with many sends.** One query for the outbox status of the messages shown (`WHERE id = ANY`), indexed. [T3]

**Security**
27. **Text is never HTML.** The thread renders it as text, as today. [T5]
28. **No token in logs, errors or responses.** Meta's error bodies are logged only as their code. [T4]
29. **The upload route** takes a raw body only on that route, with `bodyLimit` 25 MB + 1, as the import upload does. [T3]
30. **Every new route goes in the access matrix (`test/probes.ts`), and the outbox has row-level security that follows its lead** (as `whatsapp_media`). [T2, T3]

## Review Focus

- **The window as of now, not the page's load time:** a composer left open overnight must not send. [T3 test "the window closed while typing"]
- **A person who sees the lead through a team but isn't its owner:** `canOnRecord` decides, the same as tap-to-send. [T3 test]
- **The send job's actor is the sender, not the number's `run_as`:** the stage moves as the person who sent. [T4 test]
- **A lead merged or deleted (to the bin) after queueing:** the job fails with "This lead isn't here any more." [T4 test]
- **Two numbers, the newer one disconnected:** LUME doesn't fall back to the older one silently. The composer says to reconnect. [T3 test]

---

### Task 1: Core — delivery statuses, outgoing messages, Meta's refusals in words

**Files:** modify `packages/core/src/whatsapp/{webhook.ts,fixtures.ts,index.ts}`; create `packages/core/src/whatsapp/outbound.ts` (+ test); test `webhook.test.ts`.

**Interfaces — produces:**
- `WaEvent.kind` adds `"status"`, with `status: "sent" | "delivered" | "read" | "failed"` and `error: { code: number } | null` (`text` and `media` null, `peer` = `recipient_id`).
- `outboundBody(to: string, m: { text: string } | { kind: "image" | "video" | "audio" | "document"; mediaId: string; caption?: string; filename?: string }): object`. That's Meta's `/messages` JSON: `messaging_product: "whatsapp"`, `recipient_type: "individual"`, and no caption on audio.
- `refusalOf(code: number | null): { words: string; retry: boolean; token: boolean }`, with the words from outcome 8.
- `STATUS_RANK: Record<"queued" | "sending" | "sent" | "delivered" | "read", number>`.

- [ ] **Step 1:** The tests:
  - `readWebhook(statuses())` gives one `status` event, read;
  - a failed status carries `errors[0].code`;
  - the `outboundBody` text and file shapes, with no caption on audio;
  - `refusalOf` for each code in outcome 8, and for an unknown code.
- [ ] **Step 2:** Run `npx vitest run packages/core/src/whatsapp`. Expected: FAIL.
- [ ] **Step 3:** Implement. Statuses come from `value.statuses[]`; an unknown status value is dropped.
- [ ] **Step 4:** Run it again. Expected: PASS. Commit `feat(core): WhatsApp delivery statuses, outgoing messages, Meta's refusals in words`.

### Task 2: Database — the outbox, the Meta upload cache, drafts, the switch

**Files:** create `packages/db/migrations/0075_whatsapp_outbox.sql`; modify `packages/db/src/schema/whatsapp.ts` and `schema/identity.ts` (the type of `integrations.whatsapp.replyFromLume`); tests in `packages/db/src/rls.test.ts`, `apps/api/test/rls-coverage.test.ts`.

- **`whatsapp_outbox`**, with RLS following its lead (as `whatsapp_media`), `backup_read`, and no worker grants:
  - `id uuid PK`;
  - `lead_id → leads ON DELETE CASCADE`;
  - `number_id → whatsapp_numbers ON DELETE CASCADE`;
  - `user_id → users`;
  - `activity_id uuid`;
  - `client_key uuid NOT NULL`;
  - `text text`;
  - `media_id → whatsapp_media ON DELETE SET NULL`;
  - `task_id uuid`;
  - `status` (`queued|sending|sent|delivered|read|failed`);
  - `wamid text UNIQUE`;
  - `problem text`;
  - `tries int`;
  - `created_at`, `updated_at`;
  - `UNIQUE (user_id, client_key)`;
  - an index on `(status, updated_at) WHERE status IN ('queued','sending')`.
- **`whatsapp_meta_uploads`**: `(number_id → whatsapp_numbers CASCADE, sha256 → whatsapp_files RESTRICT, meta_media_id text, uploaded_at)`, `PK (number_id, sha256)`. No lead data: it goes in the RLS-coverage list with its reason.
- **`whatsapp_media`** adds `draft boolean NOT NULL DEFAULT false`, `uploaded_by uuid`, and a partial index `(created_at) WHERE draft`.
- **Tests:**
  - a rep sees only their leads' outbox rows;
  - the same `(user, client_key)` twice is refused;
  - deleting a number cascades.
- **Commit:** `feat(db): the WhatsApp outbox, Meta upload cache and file drafts`.

### Task 3: API — the switch, attaching a file, sending, and the thread's new parts

**Files:**
- create `apps/api/src/modules/whatsapp/send.ts` (+ `send.test.ts`) and `apps/api/src/modules/whatsapp/sniff.ts` (+ test);
- modify `routes.ts`, `service.ts` (the switch), `thread.ts`, `sheets/service.ts` (the view's `replyFromLume`), `app.ts` (`AppDeps.whatsapp.enqueueSend`), `test/harness.ts` (`whatsappSendQueued`, `runWhatsAppSend`), `test/probes.ts`.

**Interfaces — produces:**
- `PUT /api/v1/integrations/whatsapp` accepts `replyFromLume?: boolean`.
- `POST /api/v1/leads/:id/whatsapp/files`: raw body, `x-file-name`. Gives `201 { media: { id, kind, mime, filename, size } }`.
- `POST /api/v1/leads/:id/whatsapp/messages` `{ clientKey: uuid, text?: string, mediaId?: uuid, caption?: string, taskId?: uuid }`, needing text or mediaId. Gives `202 { message: WaThreadMessage }`.
- `GET /api/v1/leads/:id/whatsapp` adds:
  - `reply: { allowed: boolean, number: { id, display, ownerName } | null, until: string | null, reason: string | null }`;
  - on each `out` message: `sentBy: { id, name } | null`, `status`, `problem`, `outboxId`.
- `sniffType(bytes: Buffer): { mime: string; kind: "image" | "video" | "audio" | "document" } | null`, by magic bytes: JPEG, PNG, MP4/3GPP (`ftyp`), OGG, MP3/ID3, AAC (ADTS), AMR, PDF, OOXML (ZIP holding `[Content_Types].xml`), old Office (OLE), TXT (valid UTF-8, no NUL).

- [ ] **Step 1:** The tests, one per outcome: 1–6, 10–13, 16, 17, 25, 26 and the Review Focus lines 1, 2 and 5. Also a probe entry for each new route.
- [ ] **Step 2:** Run `npx vitest run apps/api/src/modules/whatsapp/send.test.ts apps/api/src/modules/whatsapp/sniff.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. The window and the number come from one query: the lead's newest `whatsapp_received` activity, `payload->>'numberId'`, `occurred_at`. The row, the activity (`whatsapp_sent`, payload `{ text, numberId, outboxId, via: "lume", media? }`) and the enqueue go in the request's transaction, and the enqueue happens after commit.
- [ ] **Step 4:** Run it again, plus `apps/api/test` (the access matrix). Expected: PASS. Commit `feat(whatsapp): reply from LUME: the switch, files, sending, and the thread`.

### Task 4: API — the send job, statuses, and what a send means

**Files:** create `apps/api/src/modules/whatsapp/sender.ts` (+ `sender.test.ts`); modify `meta.ts` (`uploadMedia`, `sendMessage`), `queue.ts` (`whatsapp.send`, 8 workers), `process.ts` (status events), `keep.ts` (the draft sweep), `apps/api/test/meta-fake.ts` (`POST /{pnid}/media`, `POST /{pnid}/messages` with `failNext(code)`, a recorded `sent` list).

**Interfaces:**
- **Consumes:** `outboundBody`, `refusalOf`, `STATUS_RANK` (T1); the outbox (T2); `confirmSend`'s effects. Extract `countSend(req, d, lead, { taskId }): Promise<MoveResult>` out of `confirmSend` in `leads/sending.ts`, so both share it.
- **Produces:** `sendOutbox(o: WhatsAppJobDeps, outboxId: string): Promise<void>`; `applyStatus(req, ev: WaEvent & { kind: "status" }): Promise<void>`.

- [ ] **Step 1:** The tests: outcomes 7–9, 14, 15, 18–24, and Review Focus lines 3 and 4.
- [ ] **Step 2:** Run `npx vitest run apps/api/src/modules/whatsapp/sender.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. A status event goes through the existing intake (dedup key `status_<status>`) into `applyStatus`, which updates only where the rank is higher.
- [ ] **Step 4:** Run the WhatsApp folder and `leads/sending` tests. Expected: PASS. Commit `feat(whatsapp): the send queue, delivery statuses, and a send that counts`.

### Task 5: Canvas, then the composer and the switch

**Files:** the canvas, as a board on a new artifact (the composer: open, closed window, a file attached, sending/sent/delivered/read/failed, the switch). Then create `apps/web/src/components/leads/drawer/WhatsAppComposer.tsx` (+ test); modify `WhatsAppThread.tsx` (ticks, sent by, failed + Try again), `whatsapp.module.css`, `LeadDrawer.tsx`, `lib/whatsapp/{types,client}.ts`, `components/integrations/WhatsAppCard.tsx` (the "Reply from LUME" switch with its words).

**The UI:**
- **Composer:** grows to 6 lines. Enter sends, Shift+Enter makes a new line; on phones, Enter is a new line and the Send button sends.
- **Window line:** "You can reply until 4:12 pm · From +91 90000 00001". When it's closed, the words from outcome 2 with "Open WhatsApp".
- **Attaching:** shows the file's name and size with a remove ✕, and a caption field.
- **Ticks** (aria-labelled): Sending…, Sent, Delivered, Read.
- **Failed:** shown in red with the words and a "Try again" button.
- **Live updates:** the thread polls every 5 s while any message is queued, sending or sent, for up to 2 minutes.

- [ ] **Step 1:** Component tests: Enter and Shift+Enter; the closed window; an attachment rejected for type and size, with the words; a failed message and Try again; no double send on a double click.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Run. Expected: PASS. Commit `feat(web): reply on WhatsApp from the lead`.

### Task 6: End to end, docs, gate

**Files:** `apps/web/e2e/whatsapp.spec.ts` (+ the e2e fake Meta's send, media and status routes), `docs/runbooks/whatsapp.md`, `docs/whatsapp-w3a-2026-10-19.md`.

- **E2E:**
  - an admin switches on Reply from LUME;
  - Sneha writes, the rep replies with text and a PDF;
  - the fake Meta sends delivered then read, and the ticks follow;
  - a closed window shows the words;
  - axe and screenshots in both themes.
- **Gate:** the full unit suite, the full e2e run with refreshed baselines, lint, prettier, and the client-names check. Commit and push.
