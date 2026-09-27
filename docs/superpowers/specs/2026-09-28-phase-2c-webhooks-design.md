# Phase 2C — Inbound webhooks, with ready-made presets

Status: written 2026-09-28 under the owner's standing approval for the overnight run ("you decide, I review later"). Every decision below is the owner's to overturn.
Parent spec: `2026-09-27-phase-2-intake-design.md` §13 (this document replaces that outline). It follows the 2B pattern (`2026-09-27-phase-2b-google-sheets-design.md`, amendments A1–A13).

## 1. What this is for

Some leads arrive the moment someone fills in a form, and nothing in between keeps a spreadsheet. Examples:
- a website form;
- an Instagram DM flow in ManyChat;
- a Zapier or Make scenario from any of thousands of apps.

A webhook source gives each of these a private address. Anything posted there becomes a lead within seconds, through the same engine as CSV and Sheets: column matching, value rules, duplicate merging and phone handling.

**Success:**
- An admin creates a webhook source, copies its address (and secret), and sends a test.
- LUME shows what arrived and matches its fields, as with a sheet.
- From then on, every post becomes a lead or merges, within seconds.
- Nothing is lost when LUME is busy.
- Nothing forged gets in.

## 2. Decisions

| Question | Decision |
|---|---|
| Module | Optional, per instance: **Webhooks** in Settings → Integrations, off by default. It is managed with `integrations.manage` (2B A13). |
| Address | `POST /webhooks/in/:sourceId` answers `202 Accepted` at once, and the lead is written by a queued job. `:sourceId` is the source's uuid. Sources can't be enumerated: an unknown id gets the same answer as a bad secret, `401`, with no timing difference worth measuring. |
| Security | **One mode per source, chosen at creation:**<br>• **Signed** (default): `X-Lume-Signature: sha256=<hex HMAC-SHA256 of the raw body>` and `X-Lume-Timestamp: <unix seconds>` within 5 minutes; the HMAC covers `<timestamp>.<body>`. For Zapier, Make and website code.<br>• **Secret token:** `X-Lume-Token: <token>`, compared in constant time. For tools that can send a fixed header but can't sign, such as ManyChat's External Request.<br>Secrets are 32 random bytes (base64url), shown **once** at creation or rotation, and stored encrypted (keyring, bound to the source). |
| Replay | `X-Lume-Event-Id` if sent (up to 200 characters), else a sha256 of the body. A key seen before for this source is accepted (`202`, `"duplicate": true`) and not processed twice. |
| Rate | 60 requests a minute per source, and 600 a minute per instance: a burst gets `429` with `Retry-After`. The body limit is 64 KB. |
| Shape | JSON only (`application/json`), plus `application/x-www-form-urlencoded` for plain HTML forms. A form body is read as a flat object. |
| Mapping | JSON **paths** play the part of columns. On the first test post, LUME lists every path in the payload (`name`, `contact.phone`, `custom_fields.budget`, `tags[]`) as the "headers". Setup then uses the 2A draft (Columns, Rules, Preview), with the test payload as its one row. This is the same approach as 2B A1. |
| Nested values | A path reads one value. Arrays of scalars join with ", " (so a `tags[]` path fills the tags field). Objects and arrays of objects aren't mappable; they are listed, greyed, as "not a single value". |
| New fields later | A post with paths the mapping doesn't know is processed normally. Those paths are offered on the source page ("2 new fields seen: Map them?"), like a sheet's new columns. |
| Failures | A post that can't become a lead (mapRow problems, or no name and no contact) is kept as a problem event with the reasons, listed on the source page. It can be retried after the rules change, and dismissed. A post that fails the security check is counted, never stored. |
| Presets | Website form, Zapier, Make and ManyChat. Choosing one pre-fills the mapping for its usual shape and shows copy-paste setup steps. **ManyChat is hidden** (owner, 2026-09-27) until it has been verified against a real ManyChat Pro account. It is built and tested against ManyChat's documented External Request format, behind the flag `LUME_MANYCHAT_PRESET=on`. |
| Arrival | Webhook leads glow on Leads like a sheet's (2B §8.3): the arrivals rule counts `webhook` sources as arriving. Refresh doesn't apply, because webhooks are already instant. |
| Health | For each source: status, last event, events today and all time, leads created and merged, problems, rejected (bad signature, stale timestamp, bad token, too big, not JSON, rate-limited) with the last reason, and the address, its mode, and rotate. |

## 3. Data (migration `0019_webhooks.sql`)

**`lead_sources`**, `type = 'webhook'`:
- `config_enc` holds `{ mode: "signed" | "token", secret, preset }`.
- It reuses `headers` (the known paths), `mapping`, `rules`, `column_settings`, `run_as`, `new_columns`, `rr_cursor` and `config_version` from 2B.
- New: `rejected int NOT NULL DEFAULT 0`, `last_rejected_reason text`, `last_event_at timestamptz`.

**`webhook_events`**, one row per accepted post:
- `id bigserial`, `source_id` (cascade), `event_key text`, `payload_enc bytea` (keyring, bound to the source and key), `received_at`;
- `status` (`queued | done | error | dismissed | duplicate`);
- `result` (`created | merged | skipped | null`), `lead_id`, `problems jsonb`, `processed_at`;
- `UNIQUE (source_id, event_key)`.

**Retention:** `payload_enc` is cleared 30 days after processing for `done` events. Problem events keep theirs until dismissed or fixed. Events are deleted after 90 days. The worker gets only the sweep grants.

## 4. Receiving

`POST /webhooks/in/:id`:
- a public route, with `csrf: false` and no session;
- `bodyLimit` 64 KB;
- a raw-body parser for JSON and form bodies.

In order, with every refusal counted on the source (`rejected`, `last_rejected_reason`) when the source exists:
1. **Rate:** per source and per instance (`429`).
2. **Source:** it must be an active webhook source with the module on, else `401`. Paused sources answer `503` with `Retry-After: 3600`, so senders that retry will try again later.
3. **Auth:** by mode. Signed: header format, timestamp within ±300 s, then HMAC over `timestamp.body` in constant time. Token: a constant-time compare. Either failure gives `401`.
4. **Parse:** JSON (the top level must be an object), or form-encoded. Anything else gets `415`, or `400` for bad JSON.
5. **Replay:** the event key goes through `INSERT … ON CONFLICT DO NOTHING`. A duplicate gets `202 { "accepted": true, "duplicate": true }`.
6. **Accept:** store the encrypted payload, enqueue `webhooks.process` with the event id, and answer `202 { "accepted": true }`.

The response never echoes the payload, never says which check failed beyond the status code, and never names the source.

## 5. Processing

The `webhooks.process` job (pg-boss, in the API process as `lume_app`, like 2B) runs one event:
1. Flatten the payload into cells in the order of the source's `headers` (paths). A path missing from this payload is `""`.
2. Run it as the source's `run_as` person (2B A2): `writeRow` with `origin: { sourceId, webhook: name, event: id }`, so the lead's history reads "Imported from {name}".
3. Record the result on the event and update `last_event_at`.
4. Paths not in `headers` are added to `new_columns`, if not already there.

A job that throws for a data reason records a problem (`ROW_NOT_SAVED`, as 2A). Any other throw retries through pg-boss, up to 5 times.

The source's person losing access pauses the source (needs attention, `RUN_AS_ACCESS`). Events that arrive meanwhile are accepted and queued, and they process when it's fixed. The sender is never told.

## 6. Screens

**Settings → Integrations → Webhooks card.** It has:
- an official-mark-free generic "webhook" glyph;
- an On/Off switch and a one-line description;
- the list of webhook sources with their health line;
- an **Add a webhook** button.

**Add a webhook** (the Import frame):
1. **Where from:** Website form, Zapier or Make (and ManyChat when on); each shows its mark. Choosing one:
   - sets the security mode (Token for ManyChat, Signed otherwise);
   - names the source;
   - shows the setup steps with copy buttons: the address, the header(s), and for Signed a code sample (JavaScript `fetch`, and the Zapier and Make settings).
   - The secret appears here **once**, with "LUME won't show this again. Copy it now."
2. **Send a test:** "Waiting for the first post…". LUME polls for up to 10 minutes and shows the payload's paths as they arrive. "Use this post" continues. The test post itself is held as the draft's row.
3. **Columns, Rules and Preview:** the 2A steps on the draft.
4. **Save:** the source goes active. The test post is either processed as a real lead or discarded ("It was only a test"), whichever the admin picks.

**A webhook's page** has:
- the same health layout as a sheet's page;
- recent events (time, result, lead link when visible) and problem events with their reasons, Retry and Dismiss;
- rejected counts with the last reason;
- **Rotate secret** (shows the new one once; the old one stops working at once);
- Pause or Resume, Edit fields and rules, and Remove (archive; leads keep it).

**Presets** (the mapping each pre-fills, by path):

| Preset | Paths |
|---|---|
| Website form | `name`, `phone`, `email`, `message` → a notes field if one exists, else ignored |
| Zapier / Make | The same generic names. Their steps tell the admin to send those keys. |
| ManyChat | `first_name` + `last_name` (name parts), `phone`, `email`, `ig_username` → instagram, `custom_fields.*` → matching custom fields. From ManyChat's documented subscriber fields. **Hidden until verified.** |

## 7. API

| Route | Access | Purpose |
|---|---|---|
| `POST /webhooks/in/:id` | public, own auth | Receive |
| `PUT /api/v1/integrations/webhooks` | integrations.manage | Switch the module on or off |
| `POST /api/v1/webhooks/sources` | integrations.manage | Create (preset, name, mode) → the source, the address, and the secret (once) |
| `GET /api/v1/webhooks/sources`, `GET /api/v1/webhooks/sources/:id` | integrations.manage | List, and detail (health, events, problems) |
| `GET /api/v1/webhooks/sources/:id/test` | integrations.manage | The latest test payload's paths, or 204 |
| `POST /api/v1/webhooks/sources/:id/draft` | integrations.manage (+ leads.import) | A draft from the test payload (2A steps) |
| `POST /api/v1/webhooks/sources/:id/save` | integrations.manage | Apply the draft's mapping and rules; go live; keep or drop the test post |
| `PATCH /api/v1/webhooks/sources/:id` | integrations.manage | Name, pause or resume |
| `POST /api/v1/webhooks/sources/:id/rotate` | integrations.manage | A new secret, shown once |
| `POST /api/v1/webhooks/sources/:id/events/:eventId/retry` and `…/dismiss` | integrations.manage | Problem events |
| `DELETE /api/v1/webhooks/sources/:id` | integrations.manage | Archive |

`GET /api/v1/integrations` gains `webhooks: { enabled }`.

## 8. Testing

- **Receive:**
  - signed success, a bad signature, a stale timestamp, a missing header;
  - token success and a bad token;
  - an unknown source is 401 with no difference from a bad secret;
  - a paused source is 503; the module off is 401;
  - rate 429, 64 KB, non-JSON 415;
  - replay by event id and by body hash;
  - form-encoded bodies.
- **Process:** a lead created and merged; problems recorded and retried after a rule change; `RUN_AS_ACCESS`; new paths offered; the arrival glow.
- **Presets:** each preset's mapping against a sample payload, including ManyChat's documented one.
- **e2e:** Settings → Webhooks: create with the Website preset, post a signed test from the test runner, map, save, post again, and see the lead glow on Leads. Screenshots in both themes; axe.

## 9. Out of scope

- Outbound webhooks.
- Per-field transforms beyond the 2A ones.
- Verifying the ManyChat preset (it needs a Pro account; it stays hidden).
- IP allow-lists: signing is the control.
