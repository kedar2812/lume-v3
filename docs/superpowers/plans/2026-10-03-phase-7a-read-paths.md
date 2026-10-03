# Phase 7A — Read paths at scale — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (Native). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every list, filter, search and count path answers in at most 150 ms at 200,000 leads on the dev box's
scale database (1 CPU, 1 GB). Measured today: 1.5–7 s for seven paths.

**Architecture:**
- Rewrite the `leads` row-level security policies so the request settings are evaluated once per query (scalar
  subqueries), not per row through a non-inlinable function.
- Add the actor's scope to `leadFilters` as a plannable condition, plus three indexes (name sort, my newest, a
  covering index for counts).
- Keep `tag_ids` on the lead (trigger-maintained from `lead_tags`) for the tag filter and serialisation.
- Make search build a capped candidate set from the trigram indexes first.

**Tech Stack:** PostgreSQL 17 (pg_trgm, GIN, transition-table triggers), Fastify + Drizzle, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-03-phase-7-scale-design.md` (§7A, "The gate", Review Focus 1–2).

## Global Constraints

- Row-level security keeps its meaning exactly: 'all' sees every lead; own sees `owner_id = user` and never
  unassigned; team sees `owner_id = ANY(team)` and only with a user set; a hand-off sees its one lead; no scope sees
  nothing.
- Migrations are forward-only and additive. Each new index and trigger is listed in `CHANGELOG.md` under
  Migrations (they're built with the app stopped).
- No client names; made-up data only (generic names, `example.com`, +9715… numbers).
- Tests run on the dev box: `bash scripts/dev.sh run <cmd>`. The scale test needs `bash scripts/dev.sh test-db
  scale-up` first and `scale-down` after, and is never run while another box job runs.
- **Edge cases, as many as possible (owner, 2026-10-03):** every task's tests cover, where they apply:
  - empty sets;
  - one row;
  - exactly the cap and the cap + 1;
  - every scope (all, team, team with no members, own, none, hand-off);
  - unassigned and soft-deleted leads;
  - odd input: `%`, `_`, `\`, quotes, emoji, accents, 200-character names, whitespace-only terms;
  - many rows changed in one statement;
  - concurrency where two writers can meet.
- Budgets are proven by `LUME_SCALE=200000 pnpm exec vitest run apps/api/test/scale` and recorded in the ledger
  for each task that changes a read path.

## Review Focus

1. **The new policies match the old ones row for row,** for every scope and the hand-off; with no settings
   (fails closed): nothing. (Task 1 test.)
2. **`tag_ids` never drifts from `lead_tags`:** single edit, bulk tag, import merge, a tag deleted (cascade), a
   lead soft-deleted, many rows in one statement. (Task 3 tests.)
3. **Search never shows a lead the person can't see,** and a masked role still searches names only. (Task 4 test.)
4. **A team lead whose team is empty sees only their own leads,** and the explicit scope condition never widens
   what RLS allows (e.g. an empty team array). (Task 2 test.)
5. **The search cap says so:** past 10,000 candidates the list carries `searchCapped: true` and the screen's API
   consumers can say "narrow the search". (Task 4 test.)

---

### Task 1: Row-level security, evaluated once per query

**Files:**
- Create: `packages/db/migrations/0045_leads_rls_inline.sql`
- Test: `packages/db/src/rls.test.ts` (new tests in the "RLS on leads" describe)

**Interfaces:**
- Produces: the policies `leads_read`, `leads_create`, `leads_update` (same names), whose plans never show
  `lume_can_see_owner(` in a filter.

- [ ] **Step 1: Write the failing tests** (in `rls.test.ts`, inside `describe("RLS on leads, by raw SQL as lume_app")`):

```ts
  it("7A: the policy reads the request settings once per query, never a function per row", async () => {
    await as("lume_app", { scope: "own", user: U.rep }, async (c) => {
      const plan = (await c.query("EXPLAIN (FORMAT JSON) SELECT id FROM leads WHERE deleted_at IS NULL")).rows[0]["QUERY PLAN"];
      const text = JSON.stringify(plan);
      expect(text).not.toContain("lume_can_see_owner");
      expect(text).toContain("InitPlan");
    });
  });

  it("7A: every scope sees exactly what it saw before (own, team, all, none, hand-off)", async () => {
    const ids = async (ctx: Parameters<typeof as>[1]) =>
      as("lume_app", ctx, async (c) => (await c.query("SELECT id FROM leads ORDER BY id")).rows.map((r) => r.id));
    expect(await ids({ scope: "own", user: U.rep })).toEqual([L.rep]);
    expect(await ids({ scope: "team", user: U.rep, team: [U.mate] })).toEqual([L.rep, L.mate].sort());
    expect(await ids({ scope: "team", user: U.rep, team: [] })).toEqual([L.rep]);
    expect(await ids({ scope: "all", user: U.rep })).toEqual([L.rep, L.mate, L.other, L.none].sort());
    expect(await ids({ scope: "own", user: undefined })).toEqual([]);
    expect(await ids({})).toEqual([]);
    expect(await ids({ scope: "own", user: U.rep, handoff: L.other })).toEqual([L.rep, L.other].sort());
  });
```

(Read the `as` helper at the top of the file first. If it doesn't take `team` or `handoff`, extend it to set
`lume.team_member_ids` (`{a,b}`) and `lume.handoff_lead`, exactly as `applyRequestScope` does.)

- [ ] **Step 2: Run them to see the first fail**

Run: `bash scripts/dev.sh run pnpm exec vitest run packages/db/src/rls.test.ts`
Expected: the first test FAILS (the plan contains `lume_can_see_owner`). The second may already pass: it pins the
meaning before the rewrite.

- [ ] **Step 3: Write the migration**

```sql
-- Phase 7A (spec 2026-10-03-phase-7-scale-design): the same visibility rules, with each request setting read
-- once per query (a scalar subquery is an InitPlan) instead of a non-inlinable function per row. At 200,000
-- leads the old form spent 1.4 s of a 1.6 s count in lume_can_see_owner. Meaning unchanged: 'all' sees every
-- lead; own sees its owner's (never unassigned); team adds the team; a hand-off sees its one lead; no scope,
-- nothing.
DROP POLICY leads_read ON leads;
DROP POLICY leads_create ON leads;
DROP POLICY leads_update ON leads;

CREATE POLICY leads_read ON leads FOR SELECT USING (
  (SELECT lume_scope()) = 'all'
  OR (owner_id IS NOT NULL AND (SELECT lume_user()) IS NOT NULL AND (
        owner_id = (SELECT lume_user())
        OR ((SELECT lume_scope()) = 'team' AND owner_id = ANY ((SELECT lume_team_members())))))
  OR id = (SELECT lume_handoff_lead())
);
CREATE POLICY leads_create ON leads FOR INSERT WITH CHECK (
  (SELECT lume_scope()) = 'all'
  OR (owner_id IS NOT NULL AND (SELECT lume_user()) IS NOT NULL AND (
        owner_id = (SELECT lume_user())
        OR ((SELECT lume_scope()) = 'team' AND owner_id = ANY ((SELECT lume_team_members())))))
);
CREATE POLICY leads_update ON leads FOR UPDATE USING (
  (SELECT lume_scope()) = 'all'
  OR (owner_id IS NOT NULL AND (SELECT lume_user()) IS NOT NULL AND (
        owner_id = (SELECT lume_user())
        OR ((SELECT lume_scope()) = 'team' AND owner_id = ANY ((SELECT lume_team_members())))))
) WITH CHECK ((SELECT lume_user()) IS NOT NULL);
```

Before writing it, check the old `leads_update` and `leads_create` in `0010_lead_rls.sql` and any later migration
that redefined them (`grep -n "POLICY leads_" packages/db/migrations/*.sql`). Copy the latest meaning: if a
later migration changed one, keep that change.

- [ ] **Step 4: Run to green, then the whole suite** (every API test exercises RLS)

Run: `bash scripts/dev.sh run pnpm exec vitest run packages/db/src/rls.test.ts`, then the full `pnpm exec vitest run`.
Expected: PASS; full suite green.

- [ ] **Step 5: Scale check and commit**

Run the scale test at 200,000 (scale-up first). Record the before/after for counts and searches in the ledger.
Commit: `perf(db): leads row-level security reads its settings once per query (0045)`.

---

### Task 2: The scope as a plannable condition, and the indexes

**Files:**
- Modify: `apps/api/src/modules/leads/query.ts` (`leadFilters`)
- Create: `packages/db/migrations/0046_leads_read_indexes.sql`
- Test: `apps/api/src/modules/leads/filters.test.ts`

**Interfaces:**
- Consumes: `leadScope(actor)` from `@lume/core` (`'all' | 'team' | 'own' | null`) and `actor.teamMemberIds`.
- Produces: `scopeCondition(req): SQL | undefined`, exported from `query.ts`, used by `leadFilters` (so the list,
  the counts and exports all get it).

- [ ] **Step 1: Write the failing tests** (filters.test.ts, with the file's existing harness)

```ts
describe("7A: the actor's scope as a plain condition", () => {
  it("own scope: the condition names the person, and the rows are exactly theirs", async () => {
    // seed: rep with 2 leads, someone else with 1 (use h.seedUser / h.seedLead as the file does)
    const r = await repClient.inject({ method: "GET", url: "/api/v1/leads?limit=50" });
    expect(r.json().items.map((l: { id: string }) => l.id).sort()).toEqual(repLeads.sort());
    expect(scopeCondition(fakeReq(repActor))).toBeDefined();
  });
  it("team scope with an empty team sees only their own leads (never wider than RLS) (Review Focus 4)", async () => {
    // a team lead (scope team) who leads no team: their own lead only
  });
  it("all scope adds no condition", () => {
    expect(scopeCondition(fakeReq(adminActor))).toBeUndefined();
  });
});
```

`fakeReq(actor)` is `{ actor } as FastifyRequest`. Build actors with `h.actorOf(userId)`.

- [ ] **Step 2: Run to see them fail**

Run: `bash scripts/dev.sh run pnpm exec vitest run apps/api/src/modules/leads/filters.test.ts`
Expected: FAIL: `scopeCondition` is not exported.

- [ ] **Step 3: Implement**

```ts
/**
 * The person's own lead scope as an ordinary condition (7A). Row-level security already enforces it; this lets
 * the planner use the owner index. Never wider than RLS: a team scope with no team is just the person's own.
 */
export function scopeCondition(req: FastifyRequest): SQL | undefined {
  const actor = req.actor!;
  const scope = leadScope(actor);
  if (scope === "all") return undefined;
  if (scope === "team") {
    const ids = [...new Set([actor.userId, ...actor.teamMemberIds])];
    return inArray(L.ownerId, ids);
  }
  return eq(L.ownerId, actor.userId);
}
```

In `leadFilters`, push it right after `isNull(L.deletedAt)`: `const scoped = scopeCondition(req); if (scoped)
where.push(scoped);`.

Check how `leadScope` handles a missing grant (`null`). With null, row-level security shows nothing, so return
`sql\`false\`` to match.

Hand-off: a lead being handed away is read through `visibleLead`, not `leadFilters`, so the hand-off allowance is
untouched.

- [ ] **Step 4: The indexes**

```sql
-- Phase 7A: the read paths' indexes (spec §7A.3), built with the app stopped as every migration is.
-- Sort by name: ORDER BY lower(name), id.
CREATE INDEX leads_name_sort ON leads (lower(name), id) WHERE deleted_at IS NULL;
-- "My leads, newest first": a rep's list and a team's.
CREATE INDEX leads_owner_newest ON leads (owner_id, id DESC) WHERE deleted_at IS NULL;
-- Counts read the index, not the table: the stage strip and the board.
CREATE INDEX leads_counts ON leads (pipeline_id, stage_id) INCLUDE (owner_id, value) WHERE deleted_at IS NULL;
CREATE INDEX leads_owner_counts ON leads (owner_id, pipeline_id, stage_id) INCLUDE (value) WHERE deleted_at IS NULL;
```

- [ ] **Step 5: Green, suite, scale check, commit**

Run filters.test.ts, the leads tests, then the full suite. Run the scale test at 200,000 and record the ms for
sort by name, rep list/counts/search and team lead list/counts.
Commit: `perf(leads): the scope as a plannable condition, and read-path indexes (0046)`.

---

### Task 3: Tags on the lead

**Files:**
- Create: `packages/db/migrations/0047_leads_tag_ids.sql`
- Modify: `packages/db/src/schema/leads.ts` (`tagIds: uuid("tag_ids").array().notNull().default(sql\`'{}'\`)`)
- Modify: `apps/api/src/modules/leads/query.ts` (tag filter; `listLeads` reads `tagIds` from the row, no tags
  query)
- Modify: `apps/api/src/modules/lead-exports/make.ts` (use `r.tagIds`; drop its tags query)
- Test: `packages/db/src/tags.test.ts` (new), `apps/api/src/modules/leads/filters.test.ts`

**Interfaces:**
- Produces: `leads.tag_ids uuid[]`, always equal to the lead's `lead_tags` rows (sorted by tag id).

- [ ] **Step 1: Write the failing tests** (packages/db/src/tags.test.ts, the rls.test.ts setup pattern: a test
  database, migrate, rows inserted as lume_owner with scope 'all')

```ts
describe("0047: tag_ids follows lead_tags (Review Focus 2)", () => {
  it("adding, removing, and many rows in one statement keep tag_ids equal to lead_tags", async () => {
    // insert lead L, tags A B C; INSERT INTO lead_tags VALUES (L,A),(L,B) → tag_ids = sorted [A,B]
    // DELETE FROM lead_tags WHERE lead_id = L AND tag_id = A → [B]
    // INSERT 3 leads' tags in one INSERT … SELECT → each lead's tag_ids right
  });
  it("deleting a tag removes it from every lead's tag_ids (cascade), even leads the deleter can't see", async () => {
    // as an own-scope user, DELETE FROM tags WHERE id = B → lead of someone else has tag_ids without B
  });
  it("the backfill sets tag_ids for leads that already had tags", async () => {
    // migrate to 0046, insert lead_tags, migrate to 0047 → tag_ids filled
  });
});
```

And in filters.test.ts: the tag filter still returns exactly the tagged leads.

- [ ] **Step 2: Run to see them fail** (column missing). Expected: FAIL.

- [ ] **Step 3: The migration**

```sql
-- Phase 7A (spec §7A.4): each lead carries its tags, so the tag filter is an index probe on the lead (no join,
-- no second row-level-security check) and a page needs no tags query. lead_tags stays the source of truth; these
-- triggers keep tag_ids equal to it, statement by statement, whoever's scope the change ran in.
ALTER TABLE leads ADD COLUMN tag_ids uuid[] NOT NULL DEFAULT '{}';

CREATE FUNCTION lead_tags_sync(lead_ids uuid[]) RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE saved text := current_setting('lume.lead_scope', true);
BEGIN
  -- LUME's own bookkeeping across every lead (a tag deleted by someone who can't see every lead); scope restored.
  PERFORM set_config('lume.lead_scope', 'all', true);
  UPDATE leads l SET tag_ids = coalesce((SELECT array_agg(t.tag_id ORDER BY t.tag_id) FROM lead_tags t WHERE t.lead_id = l.id), '{}')
   WHERE l.id = ANY(lead_ids);
  PERFORM set_config('lume.lead_scope', coalesce(saved, ''), true);
END $$;

CREATE FUNCTION lead_tags_after_insert() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN PERFORM lead_tags_sync(ARRAY(SELECT DISTINCT lead_id FROM new_rows)); RETURN NULL; END $$;
CREATE FUNCTION lead_tags_after_delete() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN PERFORM lead_tags_sync(ARRAY(SELECT DISTINCT lead_id FROM old_rows)); RETURN NULL; END $$;

CREATE TRIGGER lead_tags_synced_insert AFTER INSERT ON lead_tags REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION lead_tags_after_insert();
CREATE TRIGGER lead_tags_synced_delete AFTER DELETE ON lead_tags REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION lead_tags_after_delete();

-- The backfill, as the table owner with every lead in scope.
SELECT set_config('lume.lead_scope', 'all', true);
UPDATE leads l SET tag_ids = s.ids
  FROM (SELECT lead_id, array_agg(tag_id ORDER BY tag_id) AS ids FROM lead_tags GROUP BY lead_id) s
 WHERE s.lead_id = l.id;

CREATE INDEX leads_tag_ids ON leads USING gin (tag_ids) WHERE deleted_at IS NULL;
```

The update must pass `leads_update`'s USING (scope 'all' does) and WITH CHECK (a user must be set). If a
cascade runs with no `lume.user_id`, WITH CHECK fails, so set `lume.user_id` as well when it's empty and restore
it. Write the test for a cascade from a session without a user first, to see which applies.

- [ ] **Step 4: Use it**
  - The tag filter: `sql\`${L.tagIds} @> ARRAY[${q.tagId}]::uuid[]\``.
  - `listLeads` and `readView`: `tagIds: r.tagIds` (delete their `lead_tags` queries).
  - `serializeLead` already takes `tagIds` from the caller.

- [ ] **Step 5: Green, suite, scale check, commit**

Record the tag filter ms. Commit: `perf(leads): tags on the lead, kept by trigger, for the tag filter (0047)`.

---

### Task 4: Search through its indexes

**Files:**
- Modify: `apps/api/src/modules/leads/query.ts` (the `q` branch of `leadFilters`; `listLeads` returns
  `searchCapped`)
- Test: `apps/api/src/modules/leads/filters.test.ts`

**Interfaces:**
- Produces: `setSearchCapForTests(n: number | null)`; the list response gains `searchCapped: boolean` (true when
  the term matched more candidates than the cap).

- [ ] **Step 1: Write the failing tests**

```ts
describe("7A: search through its indexes", () => {
  it("finds by name, email, phone digits as before", async () => { /* three leads, three searches */ });
  it("a one-letter term doesn't search: the list answers as if there were no term", async () => {});
  it("past the cap the list says so (Review Focus 5)", async () => {
    setSearchCapForTests(2);
    try { /* 3 leads named "Sam …"; q=Sam → 2 items, searchCapped: true */ } finally { setSearchCapForTests(null); }
  });
  it("never shows a lead the person can't see, and a masked role searches names only (Review Focus 3)", async () => {});
});
```

- [ ] **Step 2: Run to see them fail.** Expected: FAIL (no `searchCapped`; a one-letter term filters).

- [ ] **Step 3: Implement.** Candidates come first, as an array computed once (an InitPlan):

```ts
const DEFAULT_SEARCH_CAP = 10_000;
let searchCap = DEFAULT_SEARCH_CAP;
export function setSearchCapForTests(n: number | null): void { searchCap = n ?? DEFAULT_SEARCH_CAP; }

// in leadFilters, replacing the `if (q.q)` block:
const term = q.q?.trim() ?? "";
if (term.length >= 2) {
  const like = `%${likeEscape(term)}%`;
  const terms: SQL[] = [sql`c.name ILIKE ${like}`];
  if (seesFullContacts(req.actor!)) {
    if (isFieldVisible(ctx, "email")) terms.push(sql`c.email::text ILIKE ${like}`);
    if (isFieldVisible(ctx, "instagram")) terms.push(sql`c.instagram_handle::text ILIKE ${like}`);
    const digits = term.replace(/\D/g, "");
    if (digits.length >= 4 && isFieldVisible(ctx, "phone")) terms.push(sql`c.phone_digits LIKE ${`%${digits}%`}`);
  }
  where.push(sql`${L.id} = ANY(ARRAY(SELECT c.id FROM leads c WHERE c.deleted_at IS NULL AND (${or(...terms)}) LIMIT ${searchCap + 1}))`);
}
```

`listLeads` works out `searchCapped` with one extra cheap query, only when a term is present:
`SELECT count(*) > cap FROM (SELECT 1 FROM leads c WHERE … LIMIT cap + 1)`. Or `leadFilters` exposes the
candidate SQL so the list can reuse it. Pick whichever is simpler and ledger it.

Look at the plan in the scale test (`LUME_SCALE_EXPLAIN=1`). If the candidate query still walks the primary key
for a rare term, route each term through its own index: a `UNION` of single-column scans. Ledger whichever plan
wins.

- [ ] **Step 4: Green, suite, scale check, commit**

Record the ms for the four searches and the rep's search. Commit:
`perf(leads): search through its trigram indexes, capped, and says when it is`.

---

### Task 5: The gate, and the docs

**Files:**
- Modify: `apps/api/test/scale/scale.test.ts`: assert the budgets (`expect(ms).toBeLessThanOrEqual(150)` for
  every list/filter/search/count path), keeping the table print;
- Modify: `CHANGELOG.md` (Unreleased: "Faster at volume (Phase 7A)…"; Migrations 0045–0047);
- Create: `docs/runbooks/performance.md`: how to run the scale test, the budgets, and the last measured table;
- Modify: `docs/superpowers/specs/2026-10-03-phase-7-scale-design.md`: none unless counts need the fallback.

- [ ] **Step 1:** Add the budget assertions; run at 200,000. Expected: every path ≤ 150 ms. A miss blocks the task:
  find the cause (`LUME_SCALE_EXPLAIN=1`), fix it with a test, and re-run.
- [ ] **Step 2: Counts decision.** If admin counts exceed 150 ms at 200,000, or extrapolate past 300 ms at 2,000,000
  (run once at 1,000,000 if disk allows), build the spec's fallback count table as Task 5b, test-first. Otherwise
  ledger the ruling "no count table: measured N ms".
- [ ] **Step 3:** Write the runbook and changelog, with the before/after table.
- [ ] **Step 4:** Full suite, lint, typecheck, the e2e leads/board/security specs, commit, push, CI.
- [ ] **Step 5:** One fresh reviewer (opus) over the 7A diff against this plan and the spec; one fix pass; close the
  ledger.
