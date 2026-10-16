# Feedback from a client's LUME — design

**Status:** sections 1–4 approved by the owner in chat, 2026-10-16; screens on canvas next (awaiting approval).
First of Project B's five parts (owner, 2026-10-16: feedback, run the fleet, control each client, get paid, win
clients; each its own spec, in that order). Builds on the licensing design
(`2026-09-30-licensing-deployment-design.md`) and product key activation (`2026-10-15-product-key-activation-design.md`).

**Goal.** Anyone in a client's team can tell LUME's makers what broke, what confused them, or what they wish it did,
with screenshots, from inside their LUME. Each report lands in a **Feedback** inbox on license.lumecrm.in, where the
owner works it through to the release that fixes it. LUME is not perfect yet; its clients help perfect it.

**Owner's rulings (chat, 2026-10-16):**
- **Send and forget.** One-way: the reporter sees "Sent — thank you"; no replies or statuses inside LUME.
- **Everyone, no switch.** Every signed-in person can send; there is no setting to turn it off.
- **Name, email and role** travel with each report, so the owner can follow up outside LUME.
- **Straight through.** The client's server forwards the report at once and keeps no copy; if the licence server
  can't be reached, the person tries again (the form keeps everything).

**Out of scope:** replies, statuses shown to the client, a copy on the client's server, an off switch, feedback
from the demo (it has no product key to send under).

## 1. In a client's LUME

### 1.1 Where it lives
- **Send feedback** in the profile menu (top right), above Sign out, and a command palette entry ("Send feedback").
- Shown only when the install holds a product key (`.env` or stored). With none (the demo, development, a LUME not
  set up yet) the menu item and palette entry are absent — not disabled. A paused or read-only LUME still shows it.

### 1.2 The sheet
A sheet over the whole window (full-window scrim: dims and blurs the sidebar and top bar too), titled **Send
feedback**.
- **What happened?** — required textarea, 1–4000 characters after trimming, placeholder "What you did, what you
  expected, what LUME did instead." Character count appears from 3500.
- **Kind** — a segmented control: **Something's broken** (default) · **An idea** · **Something's confusing**
  (`bug` · `idea` · `confusing`).
- **Screenshots** — up to 5. Paste (Ctrl/⌘ V anywhere in the sheet), drag and drop, or **Choose images**. Plus
  **Capture this screen** where `navigator.mediaDevices.getDisplayMedia` exists: the browser asks, the sheet steps
  out of view for the capture, one frame of the current tab is taken, the stream is stopped at once, and the sheet
  returns with the image added. Refused or cancelled: nothing changes, no error. The button is absent where the API
  is missing (iOS Safari, most phones).
- **Each screenshot** is a thumbnail with Remove and **Blur**. Blur opens it larger: drag rectangles over anything
  private; Undo removes the last; Done burns the blur into the pixels (a heavy box blur plus pixelation, so text
  under it can't be recovered). Only the burned image is kept; the original never leaves the browser.
- **Before upload, in the browser**, every image is drawn to a canvas: long edge ≤ 2400 px, encoded `image/webp`
  at quality 0.85, or `image/jpeg` 0.85 where the browser can't encode WebP (Safari). Over 1.5 MB after that:
  re-encoded at 0.7, then scaled down by 0.8 until it fits. This also drops any metadata (EXIF, location).
- **The plain line above Send:** "This goes to the team that makes LUME, with your name, email and role, the page
  you were on and your LUME version. Screenshots show whatever is on them — blur anything private first."
- **Send** — disabled with the inline hint "Tell LUME what happened" while the text is empty; reads "Sending…"
  while in flight (the sheet can't be closed meanwhile, but can after a failure).
- **Sent:** the sheet closes and a toast says "Sent — thank you. LUME's team reads every report." No sound
  (sound policy: achievements only).
- **Not sent:** the sheet stays, everything in it intact, with one message under the text (§4.1).
- Closing the sheet with content asks "Discard this report?" (Discard / Keep writing). The draft lives only in
  the sheet's state.
- Phone: the sheet is full-height; Choose images opens the photo picker; Capture is absent.
- Copy speaks as LUME (voice rule); no founder promises.

### 1.3 What travels with it (filled in, not asked)
- **Page:** the path the sheet was opened from, with query string and hash removed (search text could hold a
  lead's name). Path segments that are ids stay (they mean nothing outside the client's server).
- **LUME version**, **browser** (the user-agent string, ≤ 300 characters), **screen** (`innerWidth × innerHeight`
  and device pixel ratio), **theme** (Porcelain / Obsidian).
- **Reporter:** name, email and role name, taken by the client's server from the session — never from the browser.

### 1.4 The client's API: `POST /api/v1/feedback`
- Any signed-in person; normal CSRF and idempotency rules. Body limit 12 MB on this route only (the API stays at
  1 MB elsewhere); five 1.5 MB images are 10 MB once base64-encoded.
- Body: `{ kind, text, page, theme, screen, images: [{ type, data(base64) }] }`. Validated: kind in the three,
  text 1–4000 after trim, page a path starting `/` (≤ 300; query and hash stripped again here), ≤ 5 images.
- **Images** checked byte by byte (`checkFeedbackImage` in `@lume/core`, alongside `checkAvatarImage`): a real
  WebP or JPEG by structure, ≤ 1.5 MB, dimensions ≤ 2400 on the long edge read from the header. Refused images
  name their index: 422 `FEEDBACK_IMAGE_REFUSED` with `{ index }`.
- **Limit:** 10 reports per person per hour; 429 `FEEDBACK_LIMITED` with
  `retryAfterS`.
- No key on the install: 409 `NO_LICENCE_KEY` (the menu item is hidden, so only a stale tab sees it).
- Forwards to the licence server's `POST /v1/feedback` with the install's credentials (instance id, key, install
  id — as a check-in sends them), the reporter, LUME version, user-agent from the request, and the body's fields.
  Timeout 10 s.
- Keeps no copy of the report or images. One audit row `feedback.sent` with `{ kind, images: n }` — never the text,
  never the images.
- Maps the licence server's answer (§4.1) and returns `{ ok: true }` on 201.

## 2. The licence server

### 2.1 `POST /v1/feedback`
- JSON: `{ instanceId, licenseKey, installId, appVersion, kind, text, page, browser, screen, theme, reporter:
  { name, email, role }, images: [{ type, data }] }`. Re-validated in full (same limits as §1.4; reporter name ≤ 120,
  email ≤ 254, role ≤ 60; screen ≤ 40 characters).
- **Who may send:** the install the licence's key is bound to (`licences.install_id = installId` and the key
  matches), or the holder of a rotated key within its 7-day overlap (`retired_keys.reason = 'rotated'`,
  `install_id` matches, `retired_at` within `ROTATE_OVERLAP_MS`). A suspended (paused) licence may send.
- **Refused:** unknown instance or key → 401; key bound to another install, or released → 409 `KEY_IN_USE`; key
  decommissioned (dead, or retired by decommission) → 403 `KEY_DECOMMISSIONED`; client decommissioned → 403
  `KEY_DECOMMISSIONED`. Never binds a key (feedback is not an activation).
- **Images** re-checked with the same checker before anything is written; a bad one refuses the whole report
  (422 `FEEDBACK_IMAGE_REFUSED`, `{ index }`).
- **Limits** (the in-memory `Limiter`): 30 per install per hour, 60 per address per hour → 429 with `Retry-After`.
- One transaction: the report, its images, and a client event `feedback_received` (`{ id, kind }`). Answers 201
  `{ id }`.
- Route body read capped at 12 MB (a larger body is refused 413 before parsing).

### 2.2 Storage — migration `0005_feedback.sql`
```sql
CREATE TABLE feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients ON DELETE CASCADE,
  received_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind IN ('bug', 'idea', 'confusing')),
  text text NOT NULL CHECK (length(btrim(text)) BETWEEN 1 AND 4000),
  reporter_name text NOT NULL CHECK (length(reporter_name) <= 120),
  reporter_email text NOT NULL CHECK (length(reporter_email) <= 254),
  reporter_role text NOT NULL CHECK (length(reporter_role) <= 60),
  page text NOT NULL CHECK (length(page) <= 300),
  app_version text NOT NULL,
  browser text NOT NULL CHECK (length(browser) <= 300),
  screen text NOT NULL CHECK (length(screen) <= 40),
  theme text NOT NULL CHECK (theme IN ('porcelain', 'obsidian')),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'seen', 'fixing', 'fixed', 'not_a_bug')),
  fixed_in text CHECK (fixed_in IS NULL OR fixed_in ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  closed_at timestamptz,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  images_removed_at timestamptz,
  CHECK ((status = 'fixed') = (fixed_in IS NOT NULL)),
  CHECK ((status IN ('fixed', 'not_a_bug')) = (closed_at IS NOT NULL))
);
CREATE INDEX feedback_received ON feedback (received_at DESC);
CREATE INDEX feedback_client ON feedback (client_id, received_at DESC);
CREATE INDEX feedback_open ON feedback (status) WHERE status IN ('new', 'seen', 'fixing');

CREATE TABLE feedback_images (
  feedback_id uuid NOT NULL REFERENCES feedback ON DELETE CASCADE,
  n smallint NOT NULL CHECK (n BETWEEN 0 AND 4),
  type text NOT NULL CHECK (type IN ('image/webp', 'image/jpeg')),
  width integer NOT NULL,
  height integer NOT NULL,
  bytes bytea NOT NULL CHECK (length(bytes) <= 1572864),
  PRIMARY KEY (feedback_id, n)
);
```
- In the licence database, so the nightly `pg_dump` keeps it; deleting a client deletes its feedback.
- **Clean-up:** the licence server's existing daily prune also deletes `feedback_images` of reports closed 90+ days
  ago and stamps `images_removed_at`. Text and details stay.

### 2.3 nginx
The licence site gains `location = /v1/feedback { client_max_body_size 12m; proxy_pass …; }` with the same proxy
headers; every other path keeps `client_max_body_size 64k`. `infra/licence/go-public.sh` and
`docs/runbooks/licence-server.md` are updated, and the live site is edited by the same rule (`nginx -t`, reload).

### 2.4 Older installs
They never call `/v1/feedback`. Nothing else in the check or activate contracts changes.

## 3. The dashboard

### 3.1 Navigation
**Feedback** between Enquiries and Analytics, with a soft badge counting `new` reports (as Enquiries does). Not in
the bell.

### 3.2 The list (`/feedback`)
- Tabs: **New** · **Fixing** (seen + fixing) · **Fixed** (fixed + not a bug) · **All**; default New when any are
  new, else Fixing. Filters: kind, client. Search over the text, reporter name and email.
- A row: kind dot (red broken, blue idea, amber confusing — no violet), the first line of the text (one line,
  ellipsis), client, reporter · role, page, relative age ("3 h", then the date "October 14, Wednesday"), a
  screenshot count with a small image glyph. `new` rows are bold.
- Loading bar and skeleton rows while loading (dashboard rule); an empty state per tab ("No new feedback.").
- Paged 50 at a time, newest first.

### 3.3 One report (`/feedback/[id]`)
- Opening a `new` report sets it to `seen` (a client event `feedback_status`).
- **The text** in full (line breaks kept, links not auto-linked).
- **Details:** client (link to their page), reporter (name · role, email as a `mailto:` link), page, LUME version
  (amber "behind" pill if older than the latest release), browser (parsed to "Chrome 141 on Windows" with the raw
  string in a title), screen, theme, received.
- **Screenshots:** thumbnails; one opens full-size in a viewer over the whole window (full-window scrim), with
  previous/next, fit/100% zoom, Download, and Esc to close. Removed: "Screenshots removed 90 days after this was
  closed."
- **Status:** a control — Seen · Fixing · **Fixed in …** · Not a bug (and back to Seen to reopen). Fixed in asks
  for a version, prefilled with the latest release, any `x.y.z` accepted. Every change writes a client event
  `feedback_status` (`{ id, from, to, fixedIn? }`), shown in the client's History as "Feedback marked Fixed in
  1.4.0" etc.
- **Your note:** private, ≤ 2000 characters, saved on pause (debounced 600 ms) with a quiet "Saved".
- **Copy as bug report:** Markdown to the clipboard —
  title (kind + first line), the text, then a details list (client, reporter role, page, version, browser, screen,
  theme, received) and "N screenshots (download from the dashboard)". No reporter email in it.

### 3.4 Elsewhere
- **A client's page:** a **Feedback** card — the latest 3 reports (dot, first line, status) and "All N from
  {client}" → `/feedback?client=<id>`. Hidden when the client has none.
- **Releases:** under each version, "Fixed N reports" linked to `/feedback?fixedIn=<version>` (hidden at 0).
- History labels: `feedback_received` "Feedback received: {kind}"; `feedback_status` as above.

### 3.5 Admin API (session + CSRF, as the rest)
- `GET /api/feedback?tab=&kind=&client=&fixedIn=&q=&before=` → `{ items, next, counts: { new, fixing, fixed, all } }`.
- `GET /api/feedback/:id` → the report, image metadata, latest release.
- `GET /api/feedback/:id/images/:n` → the bytes, `content-type` from the row, `cache-control: private, max-age=3600`,
  `content-disposition` inline (Download uses an `attachment` variant `?download=1`).
- `PATCH /api/feedback/:id` → `{ status?, fixedIn?, note? }`, validated against §2.2's checks.

## 4. Errors, security, testing

### 4.1 What the person sees when it doesn't send
The sheet keeps the text, kind and every image in all cases.

| Cause | Message under the text |
|---|---|
| Licence server unreachable, timed out, or 5xx | "LUME couldn't reach its team just now. Your report is still here — try again in a minute." |
| 429 from either server | "That's a lot of reports in an hour — thank you. Try again in N minutes." |
| 422 image refused | That thumbnail is marked "LUME can't send this one — choose it again"; the others stay. |
| 401, `KEY_IN_USE`, `KEY_DECOMMISSIONED`, `NO_LICENCE_KEY` | "This LUME's licence can't send feedback right now. Your report is still here." |
| Capture refused or unsupported | Nothing (button absent when unsupported). |

### 4.2 Security and privacy
- Lead data leaves the client's server only when a person writes or attaches it and presses Send, after the plain
  line in §1.2 tells them where it goes; blur is offered on every image; page search text is stripped twice.
- Reporter identity comes from the session; the browser can't speak for someone else.
- Images: structure-checked on both servers, re-encoded in the browser (metadata gone), served by the dashboard
  only to the signed-in admin with their real `content-type` and `x-content-type-options: nosniff`.
- The product key is sent server to server only, as in a check-in; never to the browser, never logged; the audit
  row holds kind and image count only.
- Text is rendered as text on the dashboard (no HTML, no Markdown rendering, no auto-links).

### 4.3 Testing (written first)
- **Core:** `checkFeedbackImage` — real WebP/JPEG pass; fake extension, truncated WebP, oversize bytes, over-size
  dimensions, PNG, SVG refused.
- **Client's API:** reporter from the session (a body `reporter` is ignored); query/hash stripped; validation edges
  (0 / 4000 / 4001 characters, 6 images); 10/hour limit; each licence answer mapped (§4.1); nothing written but
  the audit row, which has no text; 409 with no key; body over 12 MB refused.
- **Web:** the sheet from the profile menu and the palette; hidden without a key; paste, drop, choose; blur burns
  pixels (the sent image differs under the rectangle); capture absent when unsupported; Send disabled when empty;
  failure keeps everything; discard prompt; toast on success.
- **Licence server:** who may send (bound install, rotate overlap, paused) and who may not (wrong install,
  released, decommissioned, retired by decommission, unknown); never binds; images re-checked; both limits; 413 over 12 MB;
  migration 0005; status transitions and their checks; History lines; note save; image clean-up at
  90 days; Copy as bug report text; list tabs, filters, search, paging, counts.
- **E2E:** web — send from the profile menu with a pasted, blurred image against a fake licence server, and the
  kept-on-failure path, in Porcelain, Obsidian and a phone, with axe. Licence — list, a report, the viewer, Fixed
  in, the client card link and the Releases link, with axe.
- **Live walk** on a throwaway install against a throwaway licence server; then the real deploy: `pg_dump`,
  migration 0005, licence server image, nginx location, `/healthz` and a 64k-cap check on another path.

### 4.4 Screens (canvas, for approval before the plan)
1. The profile menu with Send feedback. 2. The sheet, empty and filled (Porcelain, Obsidian). 3. Blur editor.
4. Not sent (kept). 5. Phone sheet. 6. Dashboard Feedback list. 7. One report (with status control and note).
8. Screenshot viewer. 9. Client page Feedback card and Releases "Fixed N reports".
