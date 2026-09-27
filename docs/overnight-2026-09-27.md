# Overnight build — 27→28 September 2026

You approved this before bed: finish phase 2, then phase 3, deciding things myself and recording each decision for you to review. This page is that record. It is updated as work lands.

## At a glance

| Piece | State |
|---|---|
| **2B-1: Google Sheets, Refresh, and the arrival glow** | ✅ Built, reviewed and fixed. Green in CI and on the dev box, except the steps that need a real Google key. |
| **2A: CSV import** | ✅ Now **fully** accepted live, including the steps that were waiting. |
| 2B-2: Connect with Google (behind its switch) | Planned (`docs/superpowers/plans/2026-09-28-phase-2b2-connect-with-google.md`) |
| 2C: Webhooks (Website, Zapier, Make; ManyChat hidden until verified) | Spec and plan written (`docs/superpowers/specs/2026-09-28-phase-2c-webhooks-design.md`, `…/plans/2026-09-28-phase-2c-webhooks.md`) |
| Phase 3: tasks, follow-ups, notifications | Not started yet |

## What you can try

**Settings → Integrations** is a new area:
- Google Sheets is one card, off by default.
- Switch it on and share a sheet with the email shown. **Add a sheet** takes it through the same Columns → Rules → Preview steps as a CSV import.
- Choose "every row already there" or "only rows from now on", and how often LUME looks.
- Each sheet has its own page: health, recent syncs in words, problem rows (retry, dismiss, download), Pause, Edit columns, and Remove. Leads stay when a sheet is removed.

**On Leads (and the Board)**, once a sheet is connected, **Refresh** (or the **R** key) plays the approved v5 moment:
- the button lifts into a glass pill, then opens into the card;
- the card shows the official Sheets mark → rows drifting → the LUME mark, with the blue bar filling with real progress;
- the real count arrives ("3 new leads", or "1 new lead for you" for a rep);
- it settles back into the button, which says "✓ 3 new".

New rows slide in and glow for 5 seconds. Whatever arrived since your last visit glows the same way when you open Leads. When more than 20 arrived, a line says "37 new since yesterday · Show only these". No sound. Reduce Motion gets a still card.

## What I need from you

1. **A Google service account**, to try Sheets for real:
   - Google Cloud → a project → enable the **Google Sheets API** and **Google Drive API** → create a service account → add a JSON key.
   - Put the file on the dev box at `/root/lume-dev/secrets/google-sa.json` (mode 600).
   - Share a test sheet with the service account's email, as a Viewer.

   With that, the live steps finish: `docs/runbooks/acceptance.md` → Phase 2B-1.
2. **Your dev demo account was replaced.** You'd OK'd resetting the dev DB, and the acceptance runs now leave the fictional "Brightpath Studio" workspace there. Before you wake, I'll reset it once more so you can run setup fresh; the setup token will be in my last message to you (it's not written into the repo, which is public).
3. **To verify ManyChat** (when we get to 2C): a ManyChat Pro account.

## Decisions I made for you (2B-1)

These are all in the spec's §14 amendments, or in the plan ledger:

- **A1. Setting up a sheet reuses the CSV import's draft** (Columns, Rules, Preview). Connecting a sheet therefore needs both Manage integrations and Import leads.
- **A2. A sheet runs as the person who last saved it.** If they lose access, the sheet pauses with a clear message until an admin saves it again.
- **A3. "Only rows from now on"** records what's already there on the first sync, recognised by content (not position), and creates nothing.
- **A4.** LUME notices rows moved or inserted anywhere (the header, the first row and the last row read), and re-reads the whole sheet at least hourly while it keeps changing.
- **A6. A row is recognised** by its date cell (time included) plus its phone, email and Instagram. Editing a name doesn't make it a new enquiry. Without a date column, a repeat enquiry from the same person can't be told apart, and the Columns step says so.
- **A8.** The "last seen Leads" marker uses the server's clock.
- **A9.** Pressing Refresh twice within 3 s is one refresh. Presses join syncs already running. A sync from the last 10 s is reused.
- **A10.** The Board gets Refresh; the glow is table-only.
- **A12. Remove archives the sheet;** its leads keep saying where they came from.
- **A13.** Integrations use the existing **Manage integrations** permission (not Settings).
- **After the review:**
  - A row typed into the sheet over two syncs (a name first, the phone a minute later) **fills in the same lead** ("Filled in from the sheet") instead of making a second one.
  - This happens only when it's clearly the same row: the row made its lead within the last 30 minutes, and its old version is gone from the whole sheet.
- **Webhooks-era rulings** (for 2C, not built yet): rate limits are kept in memory (one API per instance), and a paused webhook answers 503 so senders retry later.

## Found and fixed tonight

**End to end:**
- A brand-new form sheet with only its header couldn't be connected.
- Settings → Integrations kept saying "Checking now".
- The sheet list ran queries in parallel on one connection.

**The fresh reviewer's findings** (all fixed, each with a failing test first):
- **Critical:** editing which columns recognise a row would have re-imported the whole sheet (thousands of "Enquired again" entries).
- A lead typed into a gap in the middle of a sheet could be missed for ever.
- A paused, removed or restarted sync held its lock for 15 minutes.
- Pause and Remove didn't stop a sync already running.
- Google's rate limits looked like "LUME lost access".
- A row typed over two syncs made two leads.
- Changing how the date column looks made every row look new.
- The problem-rows download ignored contact masking.
- Editing columns reset the check interval to 2 minutes.

**Also:**
- CI's screenshot tests had been failing since Task 12: the sheets tests left leads behind that later screenshots saw. The sheets tests now clean up after themselves.
- Two old 2A acceptance checks were wrong, and are fixed.

## Deferred (small; your call)

- The "needs attention" link on the Refresh result card can't be reached by keyboard and is gone in 1.3 s. It belongs in the announcement or the banner.
- Every Refresh failure is titled "Couldn't reach Google", even when you're offline or Sheets is off. "Try again in 2 minutes" is fixed text.
- A failed action on a sheet's page replaces the page with one error line; a failed Remove says nothing.
- After a few failed syncs, the sheet's page blames Google even when the failure was LUME's.
- The row limit's final check also counts blank rows.
- A sheet's draft could be started as a one-off CSV import through the API (not the UI).
- A problem row dismissed at the very moment its retry fails can come back.
- A renamed tab keeps its old name on the sheet's page.
- One sync runs at a time across all sheets.
- Two multi-sheet Refreshes could, rarely, deadlock (sheets aren't locked in a fixed order).
- Reads are 5,000 rows at a time, where the spec said 1,000 (harmless).
