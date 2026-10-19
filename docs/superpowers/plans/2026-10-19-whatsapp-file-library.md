# WhatsApp W3b-1: the file library and file links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A business keeps its brochures, price lists and work photos once in LUME, sends them on WhatsApp from the reply box without uploading again, and shares them by a link that can be switched off when WhatsApp isn't connected.

**Architecture:** Library files are rows in `message_files` that point at the content-addressed store W1 built (`whatsapp_files`, `/var/lib/lume/files`), so a file kept in the library is stored, backed up and pruned exactly like a WhatsApp attachment, once. The reply box (W3a) attaches a library file by making the same draft it makes for an upload, with no bytes moved. A link is a 128-bit token, sealed in the row for showing again and hashed for lookup, served by one public route that answers the same 404 for unknown, off and archived.

**Tech Stack:** Fastify, Drizzle, Postgres (FORCE RLS), Next.js, Vitest, Playwright, the fake Meta.

**Spec:** `docs/superpowers/specs/2026-10-18-whatsapp-replies-ai-design.md` §4.3 (file library; the link for clients without WhatsApp connected). W3b-2 (`2026-10-19-whatsapp-templates.md`, next) adds approved media templates and the send route beyond 24 hours.

## Global Constraints

- Meta's sizes, as W3a enforces them (`apps/api/src/modules/whatsapp/sniff.ts` `LIMITS`): a file's type is read from its bytes, never its name.
- Nothing client-specific: no file names, kinds or wording for one business (CLAUDE.md).
- Copy speaks as LUME, with no em dashes (`scripts/check-copy.mjs` runs in lint).
- Scale bar: 1,000 people; a library of 1,000 files lists in one query; a link opened by 10,000 people serves from disk with a range request.
- Every new route is in the route × role access matrix (`apps/api/test/matrix.test.ts`); `message_files` is business configuration (no RLS, named in `apps/api/test/rls-coverage.test.ts` with why).
- TDD: each step's test is run and seen to fail before the code is written. Commit after each task.

## Review Focus

1. A file that is in the library and also attached to a lead's message, then archived in the library: the message's file must still open (refs count both).
2. A link switched off while someone has it: the next open is 404, with no hint the file exists.
3. The same brochure uploaded twice by two people: one copy on disk, two library rows refused as a duplicate name only when the names match.
4. The disk at 95% when a file is uploaded to the library: refused in words, nothing half-written.
5. A rep who may send but not manage templates: sees and attaches library files, can't upload, rename, archive or switch links.

---

### Task 1: The library table and its references

**Files:**
- Create: `packages/db/migrations/0077_message_files.sql`
- Modify: `packages/db/src/schema/whatsapp.ts` (add `messageFiles`), `apps/api/test/rls-coverage.test.ts` (WITHOUT_RLS entry)
- Test: `packages/db/src/schema.test.ts`

**Interfaces:**
- Produces: table `message_files (id uuid pk, sha256 text not null references whatsapp_files(sha256), name text not null check (char_length(name) between 1 and 120), mime text not null, kind text not null check (kind in ('image','video','audio','document')), size bigint not null check (size > 0), link_hash text unique, link_enc bytea, link_on boolean not null default false, opens integer not null default 0, created_by uuid references users(id), created_at timestamptz not null default now(), archived_at timestamptz)`, unique `(lower(name)) where archived_at is null`; trigger `message_files_file_refs` (the existing `lume_whatsapp_file_refs()`); Drizzle `schema.messageFiles`.

- [ ] **Step 1: Write the failing tests** in `schema.test.ts`: `it("a library file holds its stored file: refs go up with the row and down when it's deleted")` (insert a `whatsapp_files` row, insert `message_files`, expect `refs = 1`; delete, expect `refs = 0`); `it("two live library files can't share a name, an archived one can")`; `it("lume_worker can't read the library; the backup role can")`.
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'npx vitest run packages/db/src/schema.test.ts -t "library"'`. Expected: FAIL (`relation "message_files" does not exist`).
- [ ] **Step 3: Write the migration** with the table above, the trigger `AFTER INSERT OR DELETE OR UPDATE OF sha256 ON message_files FOR EACH ROW EXECUTE FUNCTION lume_whatsapp_file_refs()`, `REVOKE ALL ON message_files FROM lume_worker`, a `backup_read` grant as 0075 does; add `messageFiles` to the Drizzle schema; add `message_files: "Business configuration"` to WITHOUT_RLS.
- [ ] **Step 4: Run** the step 2 command and `npx vitest run packages/db/src/schema.drift.test.ts apps/api/test/rls-coverage.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(db): the file library, holding its files in the shared store`.

### Task 2: One way to keep bytes, and the library's routes

**Files:**
- Create: `apps/api/src/modules/whatsapp/library.ts`, `apps/api/src/modules/whatsapp/library.test.ts`
- Modify: `apps/api/src/modules/whatsapp/files.ts` (add `keepBytes`), `apps/api/src/modules/whatsapp/send.ts` (`attachFile` uses `keepBytes`), `apps/api/src/modules/whatsapp/routes.ts`, `apps/api/test/matrix.test.ts`

**Interfaces:**
- Consumes: `schema.messageFiles` (Task 1); `sniffType`, `LIMITS` (sniff.ts); `fileStore`, `sha256Of`, `usedShare`, `DISK_STOP`.
- Produces:
  - `keepBytes(req: FastifyRequest, d: AppDeps, bytes: Buffer): Promise<string>` (sha256) in files.ts: the disk check, the `whatsapp_files` upsert touching `last_ref_at`, the `whatsapp_files_gone` delete and the store write, exactly as `attachFile` does today (moved, not copied); `HttpError(507, "DISK_FULL", …)` as today.
  - `LibraryFile = { id: string; name: string; kind: Sniffed["kind"]; mime: string; size: number; link: { on: boolean; url: string | null; opens: number }; createdAt: string; archived: boolean }`.
  - Routes (all JSON unless said): `GET /api/v1/files` (`templates.use` or `messages.send`; live files, name order; `?archived=1` for `templates.manage`); `POST /api/v1/files` (`templates.manage`; body `application/octet-stream`, header `x-file-name`; 201 `{ file: LibraryFile }`); `PATCH /api/v1/files/:id` `{ name }` (`templates.manage`); `POST /api/v1/files/:id/archive` and `/restore` (`templates.manage`); `PUT /api/v1/files/:id/link` `{ on: boolean }` (`templates.manage`; turning on the first time makes the token).

- [ ] **Step 1: Write the failing tests** in `library.test.ts` (harness, fake files store as files.test.ts uses): uploads a PDF and lists it with kind `document`; the same bytes uploaded under a second name is a second row with one stored file (`whatsapp_files.refs = 2`); an HTML page named `.pdf` is 415 `FILE_TYPE`; a video over `LIMITS.video` is 413; the disk at 95% is 507 with nothing written; a duplicate live name is 409 `NAME_TAKEN` "A file called “Brochure.pdf” is already in your files."; rename, archive and restore round-trip, and archiving keeps the stored file (`whatsapp_files.refs` unchanged, so a message that sent it still opens); a rep with only `messages.send` lists but gets 403 on POST/PATCH/archive/link; the link turned on returns `url` ending `/f/<43 base64url chars>`, off returns `url: null` and on again returns the same url.
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'npx vitest run apps/api/src/modules/whatsapp/library.test.ts apps/api/src/modules/whatsapp/send.test.ts'`. Expected: library tests FAIL (404), send tests PASS.
- [ ] **Step 3: Move** the bytes-keeping block of `attachFile` into `keepBytes`; call it from `attachFile`.
- [ ] **Step 4: Run** `send.test.ts` alone. Expected: PASS (behaviour unchanged).
- [ ] **Step 5: Implement** `library.ts` and its routes; the token is `randomBytes(32).toString("base64url")`, kept sealed in `link_enc` with the instance keyring (`sealConfig` pattern, context `message-file-link:<id>`) and as `sha256` hex in `link_hash`; `url` is `${publicUrl}/f/<token>`; every write is audited (`file.uploaded`, `file.renamed`, `file.archived`, `file.link_on`, `file.link_off`); add each route to the access matrix.
- [ ] **Step 6: Run** the step 2 command and `npx vitest run apps/api/test/matrix.test.ts`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(whatsapp): the file library, kept once with WhatsApp's files`.

### Task 3: The public link

**Files:**
- Create: `apps/api/src/modules/whatsapp/link.ts`, `apps/api/src/modules/whatsapp/link.test.ts`
- Modify: `apps/api/src/app.ts` (register outside `/api`), `infra/Caddyfile` (route `/f/*` to the API)

**Interfaces:**
- Consumes: `message_files` (link_hash, link_on, archived_at, sha256, mime, name); `byteRange` (media.ts); the files store.
- Produces: `GET|HEAD /f/:token` (no sign-in): 200 with `content-type` from the row, `content-disposition: inline; filename*=UTF-8''<name>`, `x-content-type-options: nosniff`, `content-security-policy: sandbox`, `cache-control: private, max-age=300`, `accept-ranges: bytes` (206 for a range); 404 `Not found` for a malformed, unknown, off or archived token alike; 429 past 60 opens a minute per address; `opens` +1 per full GET (not per range or HEAD).

- [ ] **Step 1: Write the failing tests:** an on link serves the bytes with the headers above; switching it off makes the same URL 404 with the exact body of an unknown token; an archived file's link is 404; a 2-byte range is 206 `content-range: bytes 0-1/<size>`; a token of the wrong length never reaches the database (spy on the query count); the 61st open in a minute from one address is 429; `opens` counts 3 after 3 GETs and a HEAD.
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'npx vitest run apps/api/src/modules/whatsapp/link.test.ts'`. Expected: FAIL (404 for the on link).
- [ ] **Step 3: Implement** the route (lookup by `sha256(token)` through the owner pool, as media serving reads files; constant 404; the per-address limiter as `sendLimiter`'s shape), register it, and add `handle /f/* { reverse_proxy api:3001 }` beside `/api/*` in the Caddyfile.
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(whatsapp): a file's link, served while it's on, the same 404 when it isn't`.

### Task 4: Attaching a library file in the reply box

**Files:**
- Modify: `apps/api/src/modules/whatsapp/send.ts` (add `attachLibraryFile`), `apps/api/src/modules/whatsapp/routes.ts`, `apps/api/src/modules/whatsapp/send.test.ts`, `apps/web/src/lib/whatsapp/client.ts`, `apps/web/src/components/leads/drawer/WhatsAppComposer.tsx` and its test
- Create: `apps/web/src/components/whatsapp/FilePicker.tsx`, `FilePicker.test.tsx`

**Interfaces:**
- Consumes: `mayReply` (send.ts); `LibraryFile` (Task 2).
- Produces: `attachLibraryFile(req, d, leadId: string, fileId: string): Promise<{ media: WaAttached }>` and `POST /api/v1/leads/:id/whatsapp/files/library { fileId }` (`messages.send`): the same draft `attachFile` makes, from the library row (no bytes read; `whatsapp_files.last_ref_at` touched); 404 for an archived or unknown file. Web: `whatsappClient.attachFromLibrary(leadId, fileId)`; `<FilePicker kinds?: Sniffed["kind"][] onPick(file: LibraryFile) />` (a searchable list by name, kind icon, size; empty: "No files yet. An admin adds them in Settings, under Files.").

- [ ] **Step 1: Write the failing tests:** API: attaching a library file makes a draft with the file's sha, kind, mime and name, and the reply sends it through the fake Meta exactly as an upload does (`/__fake/sent` has a `document` with the name); an archived file is 404; the 24-hour and permission checks of `mayReply` apply (a closed window is 409 `WINDOW_CLOSED`). Web: the composer's Attach menu offers "From your files" and "From this device"; picking a file shows it ready to send, as an upload does.
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'npx vitest run apps/api/src/modules/whatsapp/send.test.ts -t library; cd apps/web && npx vitest run src/components/leads/drawer/WhatsAppComposer.test.tsx src/components/whatsapp/FilePicker.test.tsx'`. Expected: FAIL.
- [ ] **Step 3: Implement** `attachLibraryFile` (one `INSERT … SELECT` from `message_files` into `whatsapp_media` with `draft = true`), its route, the client call, `FilePicker` and the composer menu.
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(whatsapp): attach a file from the library, with nothing uploaded again`.

### Task 5: Settings → Files

**Files:**
- Create: `apps/web/src/app/(app)/settings/files/page.tsx`, `apps/web/src/components/settings/FileLibrary.tsx`, `FileLibrary.test.tsx`, `apps/web/src/lib/files/client.ts`
- Modify: `apps/web/src/lib/settings/areas.ts` (a "Files" area beside Messages, `anyOf: ["templates.manage"]`), `apps/web/src/components/settings/settings.module.css`

**Interfaces:**
- Consumes: the Task 2 routes.
- Produces: the page (gate `templates.manage`), titled "Files", description "Brochures, price lists and photos, kept once and sent from any lead."

- [ ] **Step 1: Write the failing tests** (`FileLibrary.test.tsx`): drop or choose files, each shows uploading, then its row (name, kind, size in words via `bytesText`); a refused file says LUME's reason under its name and keeps the others; rename in place (Enter saves, Escape keeps); "Share by link" switch turns on and shows the link with Copy, off hides it and says "Anyone with the old link now sees nothing."; Archive with Undo in the toast; the opens count reads "Opened 3 times".
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'cd apps/web && npx vitest run src/components/settings/FileLibrary.test.tsx'`. Expected: FAIL.
- [ ] **Step 3: Implement** the page and component in LUME's settings style (SettingsPage, a list sheet like Sources, the Switch component, the toast with Undo).
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): Settings → Files, the business's library`.

### Task 6: A file's link in a tap-to-send message (WhatsApp not connected)

**Files:**
- Modify: `apps/web/src/components/messages/SendSheet.tsx` and its test, `apps/web/src/lib/messages/*` (as the sheet's text is built)

**Interfaces:**
- Consumes: `GET /api/v1/files` (files with `link.on`), `FilePicker` (Task 4).
- Produces: the send sheet's "Add a file" (shown only when the business has a file with its link on): picks one, appends `\n\n<name>: <url>` to the message once, removable like any text.

- [ ] **Step 1: Write the failing test:** with a shared file, "Add a file" appends "Brochure.pdf: https://…/f/…" to the message; with no shared file the button isn't there; the WhatsApp link the sheet opens carries the text with the link.
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'cd apps/web && npx vitest run src/components/messages/SendSheet.test.tsx'`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): send a file's link from the send sheet`.

### Task 7: End to end, and the runbook

**Files:**
- Modify: `apps/web/e2e/whatsapp.spec.ts`, `docs/runbooks/whatsapp.md`

- [ ] **Step 1: Write the e2e:** an admin uploads a PDF in Settings → Files, switches its link on, opens the link in a new context (bytes served), switches it off (404); a rep attaches it from the reply box and it reaches the fake Meta as a document; the composer and the page pass axe in both themes.
- [ ] **Step 2: Run** `timeout 3000 bash scripts/dev.sh run bash -c "cd apps/web && pnpm exec playwright test e2e/whatsapp.spec.ts"`. Expected: the new test FAILS before Task 5's page is in, PASSES after (run once each way).
- [ ] **Step 3: Runbook:** the library shares the `files` volume and its backup; `/f/*` must reach the API in a client's proxy; what an admin does when a link leaked (switch it off).
- [ ] **Step 4: Full suites** (unit, typecheck, lint, full e2e with `--update-snapshots=changed`, review changed images). Expected: all green.
- [ ] **Step 5: Commit** `test(e2e): the file library end to end; runbook`.
