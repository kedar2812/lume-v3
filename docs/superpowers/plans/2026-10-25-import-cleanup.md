# Import cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans.

**Goal:** A lead ads export (2026-10-22: form questions came in as raw labels, an empty column became a field, a budget
came in as text) imports cleanly for every business, without AI.

**Architecture:** The server reads every row of each column into a profile (`packages/core/src/intake/profile.ts`):
how many rows fill it, the kind of values (empty, number, money, date, yes/no, email, link, phone, a choice, text) and the
type a new field from it should start as. The draft carries the profiles; the Columns step says "Empty in every row" and
offers no New field for such a column, and a new field starts as the suggested type. A new One choice / Several choices
field is created with the column's own values as its options (before this, every row with a value failed: 0 created,
30 errors). Readable names from snake_case headers shipped earlier (5bdd56c2).

**Spec:** `docs/superpowers/specs/2026-09-27-phase-2-intake-design.md` (§5 mapping, §9 Columns step).

## Review Focus (edge-case sheet, lines that apply)

- Data: a column empty in every row (blocked as a new field, NEW_FIELD_EMPTY); values only past the first five rows; a
  choice value longer than 60 characters (NEW_FIELD_CHOICE_TOO_LONG); more than 100 different values for a choice
  (NEW_FIELD_TOO_MANY_CHOICES); one value in three spellings (one option, first spelling); several values in a cell
  ("Kitchen, Bedroom"); 0/1 columns (numbers, not yes or no); Indian grouping (15,00,000); an amount in another
  currency (still refused per row, as before); future dates (a profile only asks whether a value reads as a date).
- People: only someone who manages fields sees New field (unchanged).
- Sources: CSV, Google Sheets and webhooks share the one draft builder.
- n/a: time zones, Meta, concurrency.

### Task 1: profiles, the empty-column guard, choice options, the Columns step

- [x] Tests first: core `profile.test.ts`, API `imports/new-fields.test.ts` (RED: 3 failed; the choice field made 0 leads
  and 30 errors), web `ColumnsStep.test.tsx` (two new).
- [x] Implement; GREEN; 12 mutants killed.
