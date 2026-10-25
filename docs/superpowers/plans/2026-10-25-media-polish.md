# Media polish (owner, 2026-10-25) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Six fixes and features the owner asked for in Media: the find boxes' caret, the upload tray (rows clipped,
a progress bar for the whole batch), photos up to 20 MB, uploads that carry on across the app with a ring on the
sidebar's Media item, Photos-app zoom, and deleting a file for good.

**Architecture:** Uploads move from Media's own state to one app-wide store (`lib/media/uploads.ts`,
`useSyncExternalStore`), so leaving Media doesn't stop them; the tray, Media's list and the sidebar all read it. Photos
are kept up to 20 MB; when one over WhatsApp's 5 MB goes out, the sender asks the render service for a copy that fits
(`POST /v1/photo`), and sends the original as a document when it can't. Delete is a new route beside archive.

**Tech Stack:** Next.js 16, motion, Vitest, Playwright; Fastify, Postgres; render service (vips).

**Spec:** the owner's words, 2026-10-25 (in the conversation; quoted per task). Media tab plan:
`docs/superpowers/plans/2026-10-20-media-tab.md`.

## Global Constraints

- Copy speaks as LUME, no em dashes, honest (nothing promised that doesn't happen).
- Every screen right in Porcelain and Obsidian, at 375 px, with reduced motion.
- No client names; nothing here is for one business.
- Quality process: edge-case lines below, test first, mutation check on every guard, the full gate, then push.

## Review Focus (edge-case sheet lines that apply)

1. Leaving Media mid-upload, coming back: the files still arrive, once each, and the list shows them (no reload).
2. Closing or reloading the tab mid-upload: the browser asks first (uploads can't survive a reload).
3. A batch with refused files: the overall % counts only what can go up; a refused file never holds the bar at 99%.
4. A 12 MB photo sent on WhatsApp with the render service off: it goes as a document, not refused and not lost.
5. Deleting a file an approved template uses at its top: refused in words, archive offered; a file LUME AI may send:
   removed from its list too. Two tabs: deleting a file already deleted says so.
6. Zoom: a click that was really a drag never zooms; a trackpad's two-finger scroll pans, a mouse's wheel zooms.
7. Roles: delete needs templates.manage, like archive (viewer and rep get no Delete).

---

### Task 1: The caret, the tray's rows and the batch's progress bar

Owner: "the blinking cursor seems to be cut away by something in the find box, but the full cursor appears when you hit
space once" (cause: the global reset gives inputs no padding, so a caret at x=0 is half outside the box); the tray's rows
are clipped top and bottom with 40 files (cause: the list is a grid in a height-capped box, and rows with
overflow hidden shrink to nothing); "add a progress bar that calculates and shows the collective upload progress of the
whole batch".

- e2e `media.spec.ts`: "every find box leaves the caret room" (Media search, the viewer's Find, the picker: computed
  padding-inline-start ≥ 2px); "forty files: no row is clipped" (each `li` scrollHeight ≤ clientHeight + 1);
  "the batch's bar" (`role=progressbar` named "Adding files", aria-valuenow rises to 100).
- unit `uploads.test.ts`: `batchShare` — bytes-weighted over files not refused; all refused → null.

### Task 2: Uploads carry on across LUME; the ring on Media

Owner: "uploads must continue when leaving the Media tab, with a small progress ring on the sidebar's Media item; hover
shows the overall percentage; when finished it animates into a green tick and the Media tab blinks 3 times smoothly."

- `lib/media/uploads.ts`: store (`add`, `dismiss`, `subscribe`, `snapshot`, `onAdded`), batch kept until everything has
  settled; `beforeunload` asks while anything is going up.
- `UploadTray` mounted in the shell (shows on any screen); MediaScreen subscribes for added files.
- Sidebar Media item: `MediaRing` (ring → tick → 3 blinks; reduced motion: no blinks, a plain tick); link named
  "Media, uploading 34%"; hover label "Uploading 12 of 40 · 34%".
- Tests: store unit tests (order, three at a time, survives an unmounted screen, batch done), Sidebar test (ring,
  name, tick on done), e2e (start 6 slow uploads, go to Leads, come back: all six in the list).

### Task 3: Photos up to 20 MB; WhatsApp gets a copy that fits

- `sniff.ts`: `LIMITS.image` 20 MB (what LUME keeps), `WHATSAPP_PHOTO_MAX` 5 MB (what WhatsApp takes).
- render: `POST /v1/photo` → JPEG, long edge ≤ 2560, stepped down until ≤ 5 MB.
- sender `uploaded()`: an image over 5 MB is sent as the render copy; without render (or it fails), as a document.
- Template headers keep WhatsApp's 5 MB (already said in words by `templateProblems`).
- Copy: Media guide "Photos up to 20 MB"; the size refusal words.

### Task 4: Delete for good

- API `DELETE /api/v1/files/:id` (templates.manage): an approved/pending template header → 409 `FILE_IN_TEMPLATE`
  "A template uses this file at its top. Archive it instead."; removed from LUME AI's files; its preview row removed
  when no other library file shares the bytes; audit `file.deleted`; the bytes stay for messages already sent.
- Web: "Delete" in the tile menu and the viewer; a confirm sheet: "Delete {name}?" body "It leaves Media for good.
  Messages it was already sent in keep it." primary "Delete", secondary "Archive instead".

### Task 5: Zoom like Photos

- Pure helpers `zoom.ts`: `isMouseWheel`, `rubberband`, `project` (Apple's), `zoomAround`.
- A click (moved < 6 px, under 300 ms of press) zooms to 2.5× at the point; a click when zoomed fits; double-click
  removed. Mouse wheel zooms (sprung, smooth), trackpad pinch and touch pinch 1:1 with rubber-band past 1× and 6×, a pan
  rubber-bands at the edges and carries momentum on release. Keys: + − 0.
- Tests: helpers unit; e2e click to zoom and back, wheel zooms.
