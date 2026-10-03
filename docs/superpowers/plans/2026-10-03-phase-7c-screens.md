# Phase 7C: the screens for scale and bulk (implementation plan)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (Native). Steps use checkboxes (`- [ ]`).

**Goal:** build the approved Phase 7 canvas (https://claude.ai/artifact/UDLBDBtjTkf58yzyjB3zeb, approved 2026-10-03) into the web app:
- the bulk island: selection, pickers, run, done, undo, tuck;
- "select all that match", the rail and the stack;
- Recent bulk actions;
- search at scale;
- loading everywhere;
- one full-window scrim for every popup;
- the profile photo.

**Architecture:**
- The island replaces `BulkBar`. It drives the 7B API (`/api/v1/leads/bulk-runs`): it creates a run, polls the run every second while it is queued or running, then shows its result, Undo and Stop.
- Selection becomes a model: picked ids, or "all that match" minus exceptions, held in `LeadsScreen` and sent as `{ selection }`.
- Loading is a shared `useLoading` signal. A top progress bar reads it, and the table shows skeletons that share one sweep (CSS `@property --sweep`).
- Popups move onto one `Scrim` component, rendered through a portal at `document.body`, fixed to the whole window.
- The profile photo adds `users.avatar_*` and an upload/crop API. The cropper keeps only the circle; the server stores a 256 px WebP.

**Tech stack:** Next.js app router, React, motion/react, CSS modules, Vitest + Testing Library, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-03-phase-7-scale-design.md` §7B. The canvas is the visual reference: read each board back with the Artifact tool (`read`, path `project/<Board>.dc.html`) and build to it.

## Global constraints

- The canvas is the reference; owner rules apply:
  - one blue (#2A5BFF);
  - switches are green when on;
  - copy speaks as LUME;
  - dates read "October 1, Thursday";
  - no violet;
  - real chrome (top bar: crumb, global Ctrl K search, theme switch, bell);
  - the lead search stays first in the filter row.
- Every popup's scrim (dim plus blur) covers the whole window, sidebar and top bar included.
- Every data screen shows loading: a top bar, plus skeletons on a first load.
- Reduced motion and reduced transparency are honoured.
- No client names; made-up data in tests; e2e visual baselines are reviewed before they're accepted.
- Bulk copy is honest:
  - Undo runs for 24 hours;
  - "each lead goes back only if nobody changed it since";
  - automations a stage already ran stay done.

## Review focus

1. Polling stops when a run finishes, and on unmount; there are no stray timers when the page or island closes.
2. "All that match" never sends ids: it sends `{ filters, except, expected }`. A filter change clears the selection.
3. The scrim really covers the window, rendered in a portal (not inside a transformed or overflow-hidden parent). Focus is trapped and restored. Esc closes.
4. Undo and Stop answer the 7B refusals (`UNDO_EXPIRED`, `ALREADY_UNDONE`, `RUN_FINISHED`, `NOT_UNDOABLE`) in words, never as a raw code.
5. The profile photo upload refuses non-images, files over 10 MB and decompression bombs. Only the cropped circle is stored, and only the owner can change their own photo.

---

### Task 1: The client, the selection model and the island (selection, pickers, run, done)

**Files:**
- `apps/web/src/lib/leads/bulk-runs.ts` (+ test): the client, the reason words and the polling hook `useBulkRun(id)`;
- `apps/web/src/components/leads/island/*` (Island, panes, layers, CSS): replaces BulkBar;
- `LeadsScreen.tsx`: the selection model `{ mode: 'ids'|'all', ids, except }`.

Tests (Testing Library, `fetch` mocked):
- picking rows shows the island with the count;
- "Select all N that match" sends `{ filters, except, expected }`;
- a run answered 200 shows done at once;
- a 202 polls until done, and stops polling;
- Stop calls cancel;
- Undo calls undo and shows "N put back · M changed since";
- each refusal shows its words;
- the skipped reasons pane lists the codes in words.

### Task 2: "Select all that match", the rail, the stack; tuck into the top bar

- `LeadsTable`: the banner, the stack under the rows, and the rail. The rail shows the selection fraction while selecting, and the done fraction and batches during a run.
- The island's Hide tucks it into a top-bar pill. The shell gets a slot: AppShell context `useTopBarSlot`. A finished run tucked away turns its pill green.
- Tests: the banner text and its counts; the tucked pill shows the percentage and opens the island again.

### Task 3: Recent bulk actions (drawer)

- The history icon on the toolbar opens a right drawer, on the full-window scrim: the runs from the last 7 days, Mine/Everyone's (for `bulk_edit` 'all'), and expandable rows (split bar, reasons, facts, Undo with its window ring, Cancel while running).
- Tests: the list, expanding, Undo from the drawer, Everyone's absent for a rep.

### Task 4: Search at scale

- The FilterBar field shows the search mode inside itself: "One more letter", "Names starting with", "Names, emails, numbers", or "Names only" for masked roles. The 1-character tip appears as a glass hint.
- A capped list shows the horizon banner. Export of a capped search shows LUME's refusal with a shake. A capped selection in the island refuses, using the API's words.
- Tests: the mode text for each term length; the banner on `searchCapped`; the export refusal.

### Task 5: Loading everywhere

- `useLoading()` (context): the list, counts and drawers register their loads.
- `TopProgress`: the bar under the top bar, which leaps, creeps and completes.
- `SkeletonRows`: one shared sweep. A refetch dims stale rows, and they become skeletons after 1.2 s. "Taking longer than usual" appears after 3 s. The offline error card retries on a countdown. Load more appends skeleton rows.
- Tests: the timers (fake), the stale → skeleton switch, the countdown retry.

### Task 6: One scrim for every popup

- `components/ui/Scrim.tsx` (portal, fixed full window, `--scrim` plus a blur token, reduced-transparency fallback, focus trap, Esc).
- Move Dialog, the lead drawer, ImportSheet, licence screens, the queue run, the security drawer, the command palette, the calendar phone sheet and onboarding onto it.
- Tests: rendered under `document.body`; covers the window (style); Esc closes; focus returns.

### Task 7: Profile photo (initials or a photo, lined up)

- **Migration 0050:** `users.avatar_color` (palette key or null = automatic), `users.avatar_image` (bytea, WebP 256 px, ≤ 200 KB) and `users.avatar_version`.
- **API:**
  - `PUT /api/v1/me/avatar` takes a colour, or an image with a crop `{ x, y, zoom, turn }`, as multipart.
  - The server decodes with sharp, checking the size before decoding, applies the crop, writes a circle-ready square of 256 px as WebP, and keeps nothing else.
  - `DELETE /api/v1/me/avatar` removes it.
  - `GET /api/v1/users/:id/avatar?v=` serves it, cached immutably, to anyone signed in.
- **Web:**
  - Settings → My account → Profile: the initials swatches, and the cropper: thirds grid, magnetic centre, rubber-band edges, momentum, wheel and slider zoom, turn, live previews.
  - `Avatar` shows the photo wherever it appears.
- Tests: the API (formats, size, the bomb guard, own-only, the crop maths); the cropper maths (rubber band, projection, clamp); the Avatar fallback.

### Task 8: e2e, baselines, docs, review

- e2e specs:
  - bulk over a filter (queued → done → undo);
  - the drawer;
  - search modes;
  - the loading skeleton;
  - the scrim covers the sidebar (a screenshot);
  - the profile crop.
- Baselines reviewed. Docs (acceptance runbook, changelog). One fresh opus reviewer, a fix pass, and the ledger closed.
