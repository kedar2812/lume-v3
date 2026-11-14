# Live sheets: LUME keeps a Google Sheet of the leads you choose

Owner, 2026-11-14. Status: **design, second draft with the owner's changes, awaiting approval.** Nothing is built yet.

## Why

The person who runs a client's Meta ads wants the leads that qualified, or became clients, in a Google Sheet, so he
can upload them to Meta as an audience (a customer list, and lookalikes built from it). Today someone would export by
hand, again and again, and the list would always be out of date.

A **live sheet** is a Google Sheet that LUME makes in the client's own Google Drive and keeps up to date by itself:
the leads that match a rule the client sets (which stage, which source, and so on), with the columns the client
picks. It's a feature for every LUME client, not for one: an agency, a coach or a clinic can each keep "Won this
month", "Qualified from Instagram" or "Every lead in Follow-up" as sheets.

Every live sheet carries LUME's mark, so whoever opens it (an ad agency, a partner) sees that LUME made it.

## Goals

- Make a live sheet in one short form, from the Leads page, the Pipeline page or the new Live sheets page.
- **A Live sheets page:** the one place that lists every sheet LUME keeps, with its link to copy, its status, and
  ways to make, edit, pause, update and delete.
- A Meta audience preset whose columns are what Meta's customer list upload expects.
- The sheet fills with the matching leads, then stays right on the same rhythm as LUME's lead fetching, and at once
  on Refresh.
- A real progress bar from "making your sheet" to "3,000 of 3,000 leads written", then a plain status that stays
  true (Live, Updating, Paused and why).
- The person decides what happens to edits made by hand in the sheet: kept, or put back to LUME's.
- LUME's mark on every sheet.
- Screens, form, progress and motion to LUME's design standard: beautiful, smooth, flawless in Porcelain and Obsidian
  and at phone width.

## Non-goals

- Sending leads to Meta directly (Meta's Custom Audiences or Conversions API). A better route later; it needs Meta's
  approval of LUME's app first. The person uploads the sheet to Meta themselves, and LUME doesn't explain how.
- Reading hand edits back into LUME. A live sheet goes out of LUME only; edits in it never change leads in LUME.
- Any spreadsheet other than Google Sheets.

## Anti-goals (it fails even if it "works" when…)

- A sheet quietly goes stale: a lead qualifies and never appears, and nothing in LUME says the sheet stopped.
- A lead deleted in LUME (for example on that person's request) stays in a Google Sheet.
- Someone who isn't allowed to export leads gets every phone number and email out through a sheet.
- LUME touches any file in the person's Drive that it didn't make, or a tab or column in its own sheet that a person
  added.
- A person chose to keep their edits, and LUME wrote over one.
- The progress bar jumps, stalls without words, or says "done" before Google has the rows.
- The first fill of a big business (13,000+ leads) runs into Google's limits and leaves a half-written sheet with no
  way on.

## Constraints

- **Google permission:** LUME's Google connection already asks only for `drive.file`, which lets an app create
  spreadsheets and touch only the files it created or that the person picked. No new Google scope, so no new Google
  review. Connecting goes through the existing relay (connect.lumecrm.in), as Sheets import and Calendar do.
- **Optional module** (CLAUDE.md): part of Google Sheets on Integrations. With Google Sheets off, the buttons and the
  page say how to switch it on, and nothing runs.
- **Lead data leaves the server only to an integration the client enabled** (CLAUDE.md): the client connects their
  own Google account and makes each sheet themselves.
- **Google Sheets API limits:** about 60 write requests a minute per person and 300 per project, 10 million cells per
  spreadsheet. Writes are batched (hundreds of rows a request), queued, and backed off as lead fetching is.
- **Plans: Pro and up** (owner 2026-11-14). A new tier feature `live_sheets`, first in Pro
  (`packages/core/src/licence/tiers.ts`); Pro's lines gain "Live sheets for Meta audiences". With no tier set, every
  client has it. The owner's Plans and pricing PDF needs the same line (the owner updates it; it's never committed).
- **Quality process** (`docs/QUALITY_PROCESS.md`): edge-case sheet, tests first, a mutation check on every guard,
  the full gate, review. The fake Google (`apps/api/test/google-fake.ts`) learns to create, read and write sheets,
  including developer metadata; no test calls the real Google.
- **Design:** the apple-design skill for every screen and motion; full-window scrim for the form; copy that speaks as
  LUME, no em dashes, no over-promising; every data screen has a loading bar and skeletons.

## The parts the owner decided

- **What it's for:** Meta audiences first (qualified leads and won clients), and sorting leads into sheets in general.
- **Where it starts:** a **Create a live sheet** button on the Leads page and on the Pipeline page, opening the form;
  and a new **Live sheets** page in LUME's sidebar, the one source of truth for every sheet.
- **The sheet's link shows in LUME**, ready to copy and use anywhere.
- **The form asks** which leads go in (by pipeline stage, and more) and which of their data goes along.
- **Leads with missing details are never dropped silently:** the person chooses, in the form, whether to include them.
  Included, their empty cells are shaded.
- **Hand edits:** the form asks whether edits made in the sheet are kept or wiped.
- **The sync runs like lead fetching** (every couple of minutes, not nightly), and **the Refresh button updates live
  sheets too.**
- **A progress bar** for the first fill and every big update.
- **The logo goes on a second tab**, "Made with LUME", leaving the first tab clean for Meta. No steps for uploading
  to Meta anywhere.
- **Plans:** Pro and up.
- **Built fully and properly**, beautiful and flawless.

## How it works

### 1. The Live sheets page

A new page in the sidebar (under Leads and Pipeline), at `/live-sheets`, for people with **Make live sheets**.

- **Empty:** a short line on what a live sheet is, a quiet picture of a sheet filling, and **Create a live sheet**.
- **The list:** one card per sheet, newest first:
  - its name, and its rule in words ("Leads that reached Qualified, from Instagram");
  - its status (Live, Updating with its own bar, Paused with the reason and the fix);
  - how many leads it holds and when it last updated;
  - **the link**: the sheet's address, with **Copy link** (a tick and "Copied" in place, announced to screen
    readers) and **Open in Google Sheets**;
  - **Edit**, **Update now**, **Pause** or **Resume**, and **Delete**.
- **Create a live sheet** at the top. The page updates live (LUME's stream): a sheet another person makes, or one
  that pauses, shows without a refresh.
- Loading bar and skeleton cards while it loads; an error state that says what happened and offers Try again.

### 2. Making one: the form (a sheet over the whole window)

Four short steps, one screen each, with a back arrow, a step count and smooth movement between steps. It opens
prefilled from wherever it started: from Leads with the filters on screen, from a Pipeline stage with that stage,
from the Live sheets page with nothing.

1. **What it's for**
   - **For a Meta audience:** columns fixed to Meta's customer list format (section 4). Do-not-contact leads are
     left out by default (a switch the person can change), and LUME says why.
   - **My own columns:** any fields, in any order.
   - One line, for the Meta choice: "Upload only people who agreed to hear from you. Meta's terms ask for it."
2. **Which leads**
   - The stage rule: **reached** a stage (any lead that ever got there, even if it moved on) or **in** a stage now (a
     live list of who is there today). One or more stages; Won is a stage like the others. A business with more than
     one pipeline picks stages grouped by pipeline.
   - Optional narrowing: source, tag, owner or team, and "added on or after" a date (on the business's clock).
   - **Leads from before today too?** On by default; off fills only new matches from now on.
   - **Leads missing details:** for the Meta choice, "Include leads with no phone or email" (on by default). For my
     own columns, "Include leads with empty fields" isn't needed: every lead is included and an empty field is a
     shaded cell.
   - A live count as the rule changes: "1,284 leads match today · 40 have no phone or email."
3. **Which columns** (my own columns only): every field the person may see (their role's field access applies),
   including custom fields, stage, owner, source, created, the day it reached the stage, won value, tags. Drag to
   reorder. The Meta choice shows its columns read-only, with a line on what each is.
4. **Name, edits and Google**
   - Sheet name, prefilled ("Qualified leads").
   - **Edits made in the sheet:**
     - **Keep them:** LUME never changes a cell someone edited by hand, and never adds back a row someone deleted.
       New leads still arrive, and a lead deleted from LUME still leaves (always, for privacy).
     - **Put LUME's back:** every update makes LUME's rows and columns match LUME again.
     Either way, columns and tabs a person adds are theirs, and LUME never touches them.
   - The Google account. If Google isn't connected for this, **Connect Google** first. Google's own screen asks for
     permission, and LUME's line beside it says LUME can open only the sheets it makes.
   - **Make the live sheet.** The step becomes the progress view (section 5).

### 3. What's in the Google Sheet

- **File name:** the name given.
- **The first tab** (named after the sheet): row 1 is the header, frozen, in LUME's accent blue (#2A5BFF) with white
  bold text. One row per lead, newest first. Nothing above the header, so it downloads as a CSV exactly as Meta takes
  it. An empty value is an empty cell with a light shaded fill (never "N/A", which Meta would read as a wrong email
  or phone); the shading doesn't travel into a CSV.
- **The "Made with LUME" tab** (second): LUME's mark, the official `lume-mark.png` as-is, shown with Sheets' `IMAGE()`
  from a public address; "Kept up to date by LUME · lumecrm.in"; the rule in words; how many leads; when it last
  updated. Nothing about Meta.
- **Which row is which lead:** each of LUME's rows carries an invisible tag (Sheets' developer metadata) with the
  lead's id. It travels with the row when people sort, filter or insert rows, and never shows in the sheet or its CSV.

### 4. The Meta audience columns

Meta's own customer list names, so Meta can match them up. Checked against Meta's current upload screen and template
during the build, with a real test upload; the plan:

| Column | From LUME |
| --- | --- |
| `email` | the lead's email |
| `phone` | the phone with its country code, digits only (LUME already keeps phones that way) |
| `fn`, `ln` | first and last name, split from the lead's name (a single word goes in `fn`) |
| `country` | two-letter country from the phone number |
| `value` | the won value, for value-based lookalikes (only when the rule includes Won) |

### 5. The progress bar and status

- **While it's being made:** a real bar with words under it, in order: "Making your sheet in Google" → "Writing
  leads: 1,200 of 3,000" → "Live". The count is of rows Google has confirmed, never rows queued. If Google is slow,
  the words say so ("Google is slow right now; LUME will keep going"), and the bar never moves backwards.
- **Done:** a tick that draws itself, "Live · 3,000 leads", the link with **Copy link**, and **Open in Google
  Sheets**.
- The person may close the form at any moment; the work carries on, and the Live sheets page shows the same bar.
- **Afterwards:** Live ("updated 2 minutes ago"), Updating (its bar, for any large write), or Paused with the reason
  and the fix: Google disconnected (Connect again), the sheet was deleted or LUME can no longer open it (Make it
  again), the person who made it left or lost access (Take it over), the plan doesn't include live sheets, or the
  licence isn't active.
- Progress reaches every screen through LUME's existing live stream, so it moves without a reload.

### 6. Keeping it right (the sync)

- **The same rhythm as lead fetching:** every live sheet is checked on the Sheets schedule (every 2 minutes by
  default, `poll_seconds`), with the same back-off when Google fails, and held back the same way when the licence
  locks scheduled syncs.
- **Refresh:** the top bar's Refresh updates live sheets too, now, and its progress counts them in. **Update now** on
  a card does the same for one sheet.
- **Each check** works out which leads belong in the sheet and their values, compares that with what LUME last wrote,
  and writes only the differences, in batches:
  - new matches are added;
  - changed leads are updated (with **Keep them**, cells edited by hand are left alone: LUME reads the sheet first and
    compares it with what it last wrote);
  - leads that stop matching: with a **reached** rule they stay (a record of everyone who got there); with an **in**
    rule they leave;
  - **a lead deleted from LUME always leaves every sheet.**
- Field changes: a renamed field renames its column; an archived field's column stays, empty, until the person removes
  it in **Edit**.
- **Edit** changes the rule, columns, name or the edits choice; the sheet is rewritten with the progress bar.
  **Pause** and **Resume**. **Delete** stops LUME and leaves the file in Google Drive, with a choice to move it to
  Google's bin too (off by default).
- Every live sheet is in the audit log: made, edited, paused, resumed, deleted, taken over, and each first fill
  ("wrote 3,000 leads to 'Qualified leads'").

### 7. Who may

- A new permission **Make live sheets** (group Leads; the Admin preset has it; every role with Export leads gets it
  in the migration). Because a live sheet takes phones and emails out unmasked, it also needs **Export leads**.
- A sheet holds the leads its maker can see (their reach and field access) and runs as them. If they leave or lose
  access, it pauses and tells the admins, and an admin can **Take it over**.
- Up to 20 live sheets per business.

## Left to the builder

- Table design (live sheets, their rule, columns, the Google file id and link, what LUME last wrote per row) and the
  queue shape, as long as a worker restart never loses or doubles a write.
- Batch sizes, back-off, and when one check writes cell ranges or rewrites the tab.
- How `IMAGE()` reaches the mark (the instance's address or lumecrm.in), as long as it's the official file, unaltered.
- Exact copy, within LUME's voice; the motion, within the apple-design skill; the empty-state picture.

## Calls I made (the owner checks these)

- Shaded empty cells rather than "N/A" (Meta would read "N/A" as a wrong value).
- Do-not-contact leads are left out of the Meta choice by default; a switch can include them.
- "Include leads with no phone or email" is on by default.
- **Keep them** also means a row someone deleted by hand stays deleted (until the person chooses Put LUME's back).
- "Reached a stage" and "in a stage now" are both offered; reached is the default for Meta.
- Live sheets need **Make live sheets** and **Export leads** both; 20 per business.
- Deleting a live sheet in LUME leaves the Google file unless the person ticks "move it to Google's bin".
- The Live sheets page sits in the sidebar under Leads and Pipeline.
