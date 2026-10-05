# Phase 9: hardening, scale and polish — plan

> **For agentic workers:** superpowers:executing-plans, inline on main. Every fix is RED→GREEN; every screen change
> is checked in both themes beside its approved design; the full suite + e2e run before each push, CI checked after.

**Goal (the owner, 2026-10-05):** test everything phase by phase, backend and frontend, against the approved designs;
fix what's wrong; make the backend strong enough for large numbers of users and leads without errors or fatal
issues ("enterprise grade"); polish the app for daily use, with freedom to refine the design.

**Authority:** the owner's overnight brief ([[lume-overnight-2026-10-05]]): decide and record; ask only for the
irreversible, the security-sensitive, or what reaches outside this repo and the dev box.

## Global constraints

- LUME is a licensed product for many clients: no client names, every integration optional (CLAUDE.md).
- Copy speaks as LUME, never guesses a person's gender, never over-promises (works 100% or isn't there).
- Porcelain and Obsidian both flawless; one accent blue; meetings blue + sky; switches green; full-window scrims.
- The dev box hosts a client's live site: Docker only, 127.0.0.1 ports, CPU-capped load tests.

## Tasks

1. **Design audit, phase by phase.** For each approved canvas (Phase 5 Calendar, Phase 6 Security, Phase 7 bulk +
   screens, Phase 8 Analytics) and the earlier screens (Leads, drawer, Pipeline, Today, Templates, Settings):
   capture every screen in both themes at 1440 and 1366 (a `design-review` Playwright project like
   analytics-review), set each beside its board, and list every discrepancy in the ledger. Fix them, worst first.
2. **Shared-primitive override audit.** Find every caller class that overrides a shared primitive's size or colour
   at equal specificity (the sign-in button bug class); make each override explicit; a lint-style test that fails
   on a new one.
3. **Scale: measure, then fix.** On a CPU-capped stack with 1M leads, 300 people, 50 teams: list + search +
   filters, the drawer, bulk actions on 50k, a 100k-row import, Today, every Analytics board, goals, exports.
   Budgets: p95 ≤ 300 ms for reads, live tag filters ≤ 2.5 s, bulk/import progress never stalls. EXPLAIN every
   miss; index or rewrite; record before/after in docs/runbooks/scale.md.
4. **Robustness.** Every API error mapped to LUME's words (no raw 500s reach a screen); worker jobs idempotent and
   retried with backoff; DB pool and statement timeouts; request size limits; graceful shutdown; readiness vs
   liveness; the backup + restore runbook proved on the dev stack.
5. **Security pass.** RLS policies reviewed table by table; dependency audit; security headers; rate limits on
   every sign-in and token route; secrets never logged.
6. **Polish for daily use.** The backlog (Settings back arrows, font sizes), keyboard paths on every screen
   (roving focus for radio groups and tabs), axe clean on every screen, empty and error states everywhere, the
   deferred minors from Phases 5–8 that a user would notice.
7. **Review.** A fresh reviewer over the whole phase; one fix pass; summary with every ruling and deferred minor.
