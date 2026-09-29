# Phase 4 — WhatsApp templates, sending, saved views and the send queue

Status: designed with the owner on 2026-09-29 (sections 4A, 4B and 4C approved in conversation). Written for the owner's review.
Sources: the project report §11 (click-to-send and templates), §5 (`message_templates`), §17 (Phase 4), and the frontend design spec §8.4 (lead drawer), §8.7 (send queue) and §8.9 (templates).

## 1. What this is for

A lead is won or lost on the next message. Phase 4 makes the message fast and consistent, without LUME ever holding a WhatsApp account:
- a **template** is the business's best wording, with the lead's details filled in;
- **sending** is two taps from anywhere a lead appears, and LUME knows it went out and when they replied;
- **saved views** name the groups of leads worth messaging ("No reply 3+ days", "Lost — re-engage");
- the **send queue** makes messaging forty leads a focused, fast run instead of forty drawers.

**Success (report §17):** messages render correctly with every variable type, and a masked user can send without the raw number ever reaching their browser.

**The design bar (owner, 2026-09-29):** every new screen must stand up to what's already built.
- Clean, calm layouts, with components placed where the action is.
- Interruptible spring motion, with reduced-motion equivalents.
- The apple-design skill applies throughout.
- Every new screen is shown to the owner as full, unmasked screenshots in both themes before it's called done.

**Not in Phase 4:**
- Meeting variables (`{{meeting.date}}`, `{{meeting.time}}`, `{{meeting.link}}`) need calendars (Phase 5). The picker shows them as "needs Calendar".
- The WhatsApp Cloud API (report §11.4): the `MessageChannel` interface stays, with only click-to-send implemented.
- Template analytics (sends, reply rate, wins) are Phase 7. This phase records what they need.

## 2. How it's split

| Part | What | Why this order |
|---|---|---|
| **4A** | Templates (data, versions, rendering, library and editor), the send sheet, "Sent?" completing follow-ups, **They replied**, per-stage moves after a send or a reply, starter templates | Everything else sends through it |
| **4B** | Saved views: personal or shared, sidebar with live counts, the filters they need, seeded views | The queue starts from a view |
| **4C** | The send queue (focused mode, resumable, caps), Settings → Messages, re-engagement (Reopen, the `reopened` event) | Built on 4A's sending and 4B's views |

Each part has its own plan, its own fresh final review, and its own acceptance.

## 3. Decisions

| Question | Decision |
|---|---|
| Template history | Each edit writes a new immutable `template_versions` row. A send records the version it used. Deleting a template archives it; its versions stay. |
| Variables | `lead.first_name`, `lead.name`, `lead.custom.<key>`, `owner.first_name`, `business.name`; `meeting.*` listed as "needs Calendar". **No phone or email variables** (a message never needs them, and a template can't leak them to a masked rep). |
| Custom field formatting | By field type. Dates in the business timezone ("12 Oct"). Currency in the business currency ("AED 1,200"). Multi-select joined ("Yoga, Pilates"). Booleans as "Yes"/"No". A `user` field shows the person's first name. |
| Rendering | One pure function in `@lume/core`, shared by the server and the screen: `render(body, context) → { text, missing[] }`. Unknown variables render as-is and are listed as missing. The server always renders again from the lead it's allowed to see. |
| Freeform | Anyone with Send messages may write their own message instead of a template (as today). |
| Editing before sending | The rendered text is editable in the sheet and in the queue. The final text goes to `prepare`, which checks it (1–4,096 characters) and builds the wa.me link. |
| Role availability | `allowed_role_ids` (empty means everyone with Use templates). Only Manage templates edits them. |
| After "Sent? Yes" | Logs `whatsapp_confirmed_sent`, sets `leads.last_message_at`, completes the follow-up the send came from (if any), then applies the stage's **After a message is sent, move to** (if set). |
| **They replied** | Logs `reply_logged`, sets `leads.last_reply_at` and `last_activity_at`, then applies the stage's **After a reply, move to** (if set). It also stops "until they reply" repeats (3A). |
| Stage moves from sends and replies | Two new nullable stage settings. They go through `moveStage`, so required fields, the lost reason and stage automations (3C) all apply. A move that's refused (a required field is missing, for example) leaves the lead where it is and says why. |
| Saved views | Personal, or shared with chosen roles. Sharing needs a new permission, **Manage views** (`views.manage`, unscoped, on for admin presets). |
| View counts | One grouped count per sidebar load, under the viewer's own row-level security. It's refreshed when the live stream says leads changed, never polled. |
| Queue size | Per queue: default 50, adjustable 1–200 (Settings → Messages). |
| Daily cap | Per person, queued sends only: default 150 a day in their own timezone, adjustable 1–500. One-off drawer sends don't count. Reaching it pauses the queue with the reason. |
| Queue safety | Each item is checked again at send time (Send messages on that lead, a valid WhatsApp number). A lead that fails is skipped with its reason; the queue never stops for one lead. |
| Reopen | Moving a lost lead to an open stage writes a `reopened` activity (from any path). The drawer offers **Reopen** beside "They replied" on lost leads. |

## 4. Data (migration `0026_messaging.sql`)

**`message_templates`:**
- `id`, `name` (1–80, unique among live ones), `category` (`first_touch | follow_up | reminder | re_engagement | custom`), `allowed_role_ids uuid[]`, `current_version_id`, `position`;
- `created_by`, `created_at`, `updated_at`, `archived_at`.

**`template_versions`:**
- `id`, `template_id`, `body` (1–4,096), `created_by`, `created_at`. Immutable (no UPDATE or DELETE grant).

**`saved_views`:**
- `id`, `name` (1–40), `color`, `filters jsonb` (the Leads query's own parameters), `owner_id`, `shared_role_ids uuid[]` (empty means personal), `position`, `created_at`, `updated_at`.
- Row-level security: read your own and those shared with one of your roles; write your own, or any with Manage views.

**`send_queues`:**
- `id`, `user_id`, `template_version_id` (null for freeform), `source` (`view:<id>` or `selection`), `status` (`active | paused | finished | cancelled`), `created_at`, `finished_at`.

**`send_queue_items`:**
- `queue_id`, `position`, `lead_id`, `status` (`pending | sent | not_sent | skipped`), `reason`, `text_override`, `done_at`.
- Primary key `(queue_id, position)`, and one row per lead per queue.
- Row-level security follows the lead (as `tasks` does).

**Other changes:**
- **`leads`:** `last_message_at`, `last_reply_at` (nullable), with indexes for the new filters.
- **`stages`:** `after_sent_stage_id`, `after_reply_stage_id` (nullable, same pipeline).
- **`settings.messaging jsonb`:** `{ queueSize: 50, dailyCap: 150 }`.
- **Activities:** `whatsapp_opened` gains `templateVersionId` and `queueId` (when so). `reply_logged` and `reopened` are new.
- **Backups:** every new table gets the backup role's read policy (the 3A lesson).

## 5. API

| Route | Permission | Does |
|---|---|---|
| `GET /api/v1/templates` | `templates.use` | Live templates the caller's roles may use (Manage templates sees all) |
| `POST /api/v1/templates` · `PATCH /:id` · `POST /:id/archive` · `PUT /api/v1/templates/order` | `templates.manage` | Create; edit (a new version); archive; reorder |
| `POST /api/v1/leads/:id/messages/render` | `messages.send` | `{ templateId? , text? } → { text, missing[] }` for this lead |
| `POST /api/v1/leads/:id/messages/prepare` | `messages.send` | As today, plus `templateVersionId?`, `taskId?`, `queueItem?` |
| `POST /api/v1/leads/:id/messages/confirm` | `messages.send` | As today, plus completing the follow-up, `last_message_at`, and the after-sent move |
| `POST /api/v1/leads/:id/replied` | `leads.edit` | They replied |
| `GET/POST/PATCH/DELETE /api/v1/views` · `PUT /api/v1/views/order` · `GET /api/v1/views/counts` | `leads.view` (+ `views.manage` to share) | Saved views |
| `POST /api/v1/queues` | `messages.send_queue` | From `{ viewId } \| { leadIds }` + `templateId`: plan, cap, list who's left out and why |
| `GET /api/v1/queues/:id` · `POST /:id/items/:pos/{sent,not-sent,skip}` · `POST /:id/{pause,resume,cancel}` | `messages.send_queue` | Run it |
| `GET/PUT /api/v1/settings/messaging` | `settings.manage` | Queue size and daily cap |

The Leads list gains filters: `lostReasonId`, `lostDaysAgo`, `noReplyDays`, `followUpOverdue`.

## 6. Screens

**Templates** (sidebar):
- **The library:** grouped by category, each card showing the name, the first line and who can use it. Reorder by drag; archive from a menu.
- **The editor:** a two-pane sheet, the body on the left and a live WhatsApp-style bubble preview on the right, against a lead you pick.
  - It has a variable picker (a chip row and a `{{` autocomplete), bold and italic preview, a character count, and who can use it.
  - Saving says "Saved as version 3".

**The send sheet:**
- It opens from the drawer's **WhatsApp**, Today's and the notification centre's WhatsApp actions, and a follow-up.
- It's anchored to its trigger, like the follow-up sheet. Templates come first, with the context's category on top, then "Write your own".
- The rendered text is editable, with missing values underlined in amber and one line saying what's missing. **Open WhatsApp** is the one green button.

**The drawer:**
- **They replied** beside WhatsApp. **Reopen** replaces it on lost leads.
- The history words each new event.

**Pipeline & stages:** each stage gets two quiet selects, "After a message is sent, move to" and "After a reply, move to", beside Needs and Does.

**The Views sidebar section:**
- Coloured dots, names, live counts, drag to reorder.
- On Leads, "Save view" sits beside the filters, with Just me or Share with….
- A saved view arrives in the sidebar with a short spring.

**The send queue** (frontend spec §8.7): full screen over the app.
- **Header:** the template name, "12 of 40", a thin progress bar, today's count against the cap, and Pause.
- **Centre:** one lead card (name, stage, why they're in the queue), the message bubble (editable for this lead), then **Send** (green, Enter) and Skip (S).
- **Coming back from WhatsApp**, a small "Sent?" Yes / Not sent appears over the card. The next lead slides in from the right with a spring, and the done one leaves to the left.
- **Finishing:** the `cleared` sound and a summary.
- **Reduced motion:** cross-fades, no slides.

**Settings → Messages:** the queue size and the daily cap.

**Seeds for new installs** (generic, per industry preset): six starter templates, the two stage moves (first stage → second after a send, second → the "replied" stage where the preset has one), and four views ("My overdue", "New today", "No reply 3+ days", "Lost — re-engage").

## 7. Testing

- **Rendering (core):** every variable type across three timezones; a missing value; unknown variables; formatting marks kept; no phone or email ever rendered.
- **Versions:** an edit makes a new version; an old send still shows its own text.
- **Masking (the report's acceptance):** a masked rep renders, prepares and runs a queue. No response body, error or log line contains the lead's number, apart from the wa.me link `prepare` returns, as today.
- **Sent and replied:** the follow-up is completed; after-sent and after-reply moves (including a refused one); "until they reply" repeats stop.
- **Views:** personal versus shared by role; counts under row-level security (a rep's count is their own); every new filter; the seeded views.
- **Queue:**
  - the run cap and the daily cap (in the person's timezone, across midnight);
  - pause and resume, and two tabs on one queue (one send per item);
  - a lead lost to reassignment mid-queue is skipped with its reason;
  - Send, then Sent? Yes, then the next lead.
- **Reopen:** from the drawer and from any move out of lost.
- **Web:** each screen's states, keyboard paths (Enter, S, Esc, R), reduced motion, axe in both themes, and review copies in both themes.
- **End to end:** write a template, send it from the drawer as a masked rep, They replied, save a view, run a three-lead queue with one skip, reopen a lost lead.

## 8. Out of scope, and later

- Meeting variables and meeting reminder messages (Phase 5).
- The WhatsApp Cloud API.
- Template analytics (Phase 7).
- Scheduled queues.
- Attachments.
