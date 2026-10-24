# LUME quality process

Every change to LUME goes through this process, whoever makes it. It exists so that a bug is caught on the build box,
not by a client. Owner, 2026-10-24: "i want absolutely no bugs, establish a systematic process for development and
testing so that all edge cases and real time possibilities are considered".

The process has seven gates. A change that skips one is not done.

## 1. Before code: the edge-case sheet

Before writing a plan task (or a fix), go through the sheet below for the feature and write down which lines apply.
Each line that applies becomes a named test in the task. A line that does not apply gets one word ("n/a") so it is a
decision, not an omission. Plans keep these in their **Review Focus** section.

**People and access**
- Each role (owner, admin, manager, rep, viewer) and a person whose role changes mid-session.
- A person who leaves the team, or loses access to a lead, while something runs for them.
- Row-level security: the query runs as the person (FORCE RLS), never on the bare pool by accident.

**Time**
- The business's time zone, not the server's; a business east and west of UTC.
- Midnight, month end, the 1st of the month, a leap day, daylight-saving changes (zones that have them).
- The test clock only moves forward (licence check-ins refuse older tokens).
- Working hours: before, during and after them, and a day with none.

**Concurrency and repetition**
- Two people doing the same thing at once (two tabs, two devices).
- A double click, a retried request and a job run twice: idempotent keys, `ON CONFLICT`, `FOR UPDATE`.
- A pause, stop or delete landing between a commit and the job that acts on it.
- A worker restarting mid-job: nothing is sent twice and nothing is lost.

**The outside world**
- An integration that is off, half set up, slow, down, rate-limited or answering with an error (Meta, Google, Calendly,
  the licence server, the AI provider).
- A webhook arriving twice, out of order, late or for something already deleted.
- Meta's rules: the 24-hour window, approved templates only, opt-out and stop words, quality and tier limits.
- The licence: no key, expired, read-only, a plan without the feature.

**Data**
- Empty, one, many, and the scale bar (thousands of leads a day, a million rows for read paths).
- Unicode, emoji, right-to-left text, very long names, blank and whitespace-only values.
- Phone numbers (digits only, by rule), currencies (one per business), files (large, unsupported, corrupt).
- Data written by an older version of LUME (migrations never edit a committed file).

**Screens**
- Phone width (375 px) and desktop; touch and pointer; keyboard only; a screen reader name on every control.
- Porcelain and Obsidian; reduced motion; reduced transparency.
- Loading (bar and skeletons), empty, error and offline states; a slow network.
- Back and forward, a refresh mid-flow, a stale tab coming back after hours, an expired session.
- Copy: speaks as LUME, no em dashes, no over-promising, a new user understands it without a call.

## 2. Test first

- Write the test, run it, and watch it fail for the right reason before writing the code. A test that passes at once is a
  finding about the test.
- Bugs: the failing test reproduces the bug before the fix.
- Assert on behaviour a person sees (rows, messages, screen text), not on mocks.
- Use the fakes (fake Meta, fake AI with scripted replies, render-fake, licence-fake). Never call a real paid service
  from a test, never send real email.

## 3. Prove the test can fail (mutation check)

For every guard that protects people or money (permissions, do not contact, pause, limits, idempotency, Meta's rules),
break the guard on purpose, run the test, see it go red, then restore it. Write the result in the ledger.

## 4. The full gate, on the build box

All of these, judged by exit code (`echo X=$?`), never by how the output looks:

| Check | Command (inside `bash scripts/dev.sh run bash -c '…'`) |
| --- | --- |
| Types | `pnpm typecheck` |
| Lint | `npx eslint . --ignore-pattern "social media/**"` |
| Format | `pnpm exec prettier --check apps packages infra scripts docs` |
| Names and copy | `node scripts/check-client-names.mjs && node scripts/check-copy.mjs` (and their `node --test` files) |
| Unit and database | `npx vitest run` (every package, the licence server included) |
| Screens | `cd apps/web && pnpm exec playwright test` (the full run; baselines only from a full run) |

A test that fails once and passes on a rerun is not "flaky" until its cause is found and written in the ledger.

## 5. Review before pushing

- Read the whole diff as a reviewer would, against the spec and the edge-case sheet.
- Every finding that affects a person is fixed with a failing test first; the rest go in the ledger as deferred.
- Screens: look at every changed screenshot, in both themes and at phone width.

## 6. Push

- Commit to main only after gate 4 is green; format on the box and copy the files back in the same step, before the
  commit.
- One ledger line per finished task, in `.superpowers/sdd/<plan>/progress.md`, with the commits and the test results.

## 7. Before any deploy

- Never to a client or the demo without the owner's go-ahead.
- Walk the client's real flows on a private staging copy of their data with the exact images first (lumestage).
- Keep a rollback (the previous image and a database dump) and write the deploy in the memory and the runbook.
