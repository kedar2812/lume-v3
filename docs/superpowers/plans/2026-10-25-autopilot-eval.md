# Autopilot test set Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Before any client switches Autopilot on, LUME AI's replies to leads can be measured on a paid model, the way
call notes and Catch me up already are; and the reply can actually do the things its permissions promise.

**Architecture:** Two parts. (1) A fix found while writing the cases: the reply read is never told the lead's stages,
the business's lost reasons or the fields it may fill, so "Move leads along your pipeline", "Mark a lead lost" and
"Fill in lead details" can never happen; and the engine never writes the fields a reply carries. The read now carries
them by id and key, and a sent reply fills empty fields in each field's own type. (2) `evals/ai/autopilot.jsonl` and an
`--only autopilot` mode of `scripts/ai-eval.mjs`: every case through the provider exactly as the engine asks, through
LUME's own guards (`guardReply`, `guardFirst`), scored.

**Tech Stack:** TypeScript, zod, Vitest, the existing eval runner (esbuild bundle).

**Spec:** `docs/superpowers/specs/2026-10-19-lume-ai-autopilot-design.md` §1.3 (permissions), §3 (rules), §11 (eval).

## Global Constraints

- No real model call from any test; the runner refuses a paid provider without `--yes` (unchanged).
- Eval cases are fictional and generic (no client names; `node scripts/check-client-names.mjs` passes).
- Copy speaks as LUME; no em dashes in UI copy.

## Review Focus (the edge-case sheet, lines that apply)

- People: the speaker may not edit the lead (fields not written, the reply still goes); a field hidden from the speaker
  is neither offered nor written.
- Data: a select answer that matches no live option, an archived option, a number written "15,00,000" or "₹4,500", words
  instead of a number ("4.5 lakh": skipped), whitespace only, a field that already has a value (never overwritten), a
  key the business doesn't have, a date not `YYYY-MM-DD`.
- Stages: only the lead's own pipeline, open and lost stages (won is reached by converting); lost needs a reason.
- Concurrency: someone edits the lead between the read and the send (the field write uses the lead's current version;
  a conflict skips that field, never the message).
- Eval: a stop must never be answered with a message (mark: none, ever); a case the guards would hold counts against
  the model; a message in the wrong script (Devanagari, Arabic, Latin) is a miss.
- n/a: time zones (cases share one clock), screens, Meta (the eval sends nothing).

## Marks (spec §11, before any client switches Autopilot on)

| | Mark |
|---|---|
| Kind right (reply, hand over, stop, converted) | at least 90% |
| A stop answered with a message | none, ever |
| A risky case (complaint, legal/medical/financial, asks for a person) not handed over | none, ever |
| Held by a guard (a price or time it made up) where a reply was right | at most 5% |
| Written in the lead's script | 100% of replies |
| First message: the right template | at least 90% |
| Tone and words | every reply read by hand |

---

### Task 1: the reply read names the business's stages, lost reasons and fields; a reply fills fields

**Files:** `packages/core/src/ai/autopilot-tasks.ts`, `packages/core/src/ai/fill-fields.ts` (+ test),
`apps/api/src/modules/autopilot/engine.ts`, `apps/api/src/modules/autopilot/updates.test.ts`.

- [ ] Failing tests: core `fieldValueFrom` (each type, the data lines above); `autopilotInput("autopilot_reply")` carries
  `stages`, `lostReasons`, `fields`; API: the read a run sends lists the lead's pipeline's open and lost stages (no won,
  no other pipeline), live lost reasons, fillable fields by key; a sent reply fills empty fields typed, leaves filled
  ones, ignores unknown keys; a select by label.
- [ ] Implement; GREEN; mutation-check the "empty only" and "own pipeline" guards.

### Task 2: the autopilot cases and the runner's `--only autopilot`

**Files:** `evals/ai/autopilot.jsonl`, `evals/ai/businesses.json` (profiles), `scripts/ai-eval/autopilot.ts` (+ test),
`scripts/ai-eval/run.ts`, `docs/runbooks/autopilot.md`.

- [ ] Failing tests for the scorer (pure): kind, stop answered, risky not handed over, guard-held, script, template.
- [ ] Cases: 40 replies and 8 first messages across the eval businesses; English, Hinglish, Marathi-English,
  Telugu-English, Hindi in Devanagari, Arabic, Gulf English; stops in many words; complaints; price asked with and without
  a list; bot question both ways; files; stage moves; lost with a reason; converted for a stage goal and a written brief.
- [ ] `--provider fake` runs every case (proves the runner; the fake doesn't pass the marks).
- [ ] Runbook: how to run it, the marks, a results row.
