# Phase 1C-2 — Leads Screens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every role the screens to work leads: a fast table with filters and inline edit, a Kanban board with drag and keyboard moves, the approved lead drawer (stage track, Reveal, WhatsApp hand-off, won/lost, notes and history), a create sheet with live duplicate warnings, and bulk actions. A masked role never sees a contact column.

**Architecture:** The pages are server components. They fetch the lead catalog (pipelines, fields, tags, lost reasons, products, people, business currency) and the first page of leads through `apiGet` with the visitor's cookie, then hand them to client screens that do everything else through the browser `api` client (CSRF, Idempotency-Key, If-Match). The server stays the single source of truth for permissions: each serialized lead carries a `can` block (edit, move, reveal, assign, delete, message) computed with the same `canOnRecord` as the routes, so the UI never guesses about team scope. Filters live in the URL, so a filtered view can be linked and survives a reload. The drawer is `?lead=<id>` on the same URL.

**Tech Stack:** Next.js 16 App Router, React 19, motion 12 (springs from `lib/motion.ts`), CSS modules on the Porcelain/Obsidian tokens, Fastify 5 + Zod 4 + Drizzle for the four small API additions, Vitest + Testing Library, Playwright + axe against the real stack (the 1C-1 harness).

**Spec:** `docs/superpowers/specs/2026-09-24-phase-1c-screens-design.md` §6 (Leads), §8 (quality bars), §2 (1C-2 acceptance row). Visual source of truth: `docs/design/prototypes/key-screens.html` (lead list and drawer) and `customise-prototype.html` (board columns). The report's click-to-send flow (`docs/LUME_PROJECT_REPORT.md` §11.2) defines the WhatsApp hand-off.

## Global Constraints

- Cursor-paged: **never more than 100 rows per request**; the table asks for 50 at a time.
- A masked role (a role whose `leads.contact.full` scope is narrower than its `leads.view` scope, and never the owner) gets **no contact columns at all**, no contact filters, name-only search, and no export control. The API refuses these requests anyway.
- Board: one column per stage of the chosen pipeline, a count per column, drag with the approved spring. A stage with required fields opens a small form; a `lost` stage asks for the reason. **Keyboard equivalent:** select a card, `Space` picks it up, `←`/`→` move it, `Enter` drops, `Escape` cancels.
- Drawer: opens over the list (620px glass-edged sheet, top bar with close, previous `K`, next `J`, "n of m"). On phones (< 720px) it is a full page. Reveal sits next to the masked contact and says plainly that it was recorded.
- Duplicate warning while the phone or email is typed; it names the owner only when the caller may see that lead, otherwise "a lead with this phone already exists".
- Bulk result reports what was skipped and why, for example "3 moved, 1 skipped: needs a lost reason".
- Empty, loading and error states for every surface, including "no leads yet" with a create button and "nothing matches these filters" with a clear-filters action.
- The WhatsApp hand-off is a link only (report §11.2): the server builds `https://wa.me/<digits>?text=…`, the page opens it at once and never shows it; the full number never appears on screen for a masked role.
- Sounds only for achievements: the **won** chime (`sound.play("won")`), nothing on clicks, moves or reveals.
- No hand-written vendor prefixes in CSS (a test enforces it); no `-webkit-backdrop-filter`.
- Web code imports only `@lume/core/shared` (lint enforces it).
- Every form has `method="post"`; every navigation in e2e waits for hydration (1C-1 fixtures).
- Every commit passes the strict gate (lint, typecheck, all tests, and the web production build), and CI is watched after every push. `$SCRATCH/gate.sh` is the session scratchpad's strict gate script: `set -o pipefail`, `pnpm lint`, `typecheck`, `test`, `pnpm --filter @lume/web build`, and a non-zero exit on any failure.

## Review Focus

These are the inputs and failure modes the spec implies but a happy-path test would never meet, most likely to bite first. Each one has a test in the owning task.

1. **Two people edit the same lead.** The second save must not silently overwrite the first. Expect a clear "changed by someone else" message and fresh values, never a lost edit (Task 4: a 409 from If-Match reloads the lead and says so).
2. **A lead is reassigned away mid-view.** After an assignment that the caller can no longer see (`visible: false`), the row and the drawer must go away with an explanation, not show a 404 error screen (Task 5).
3. **A drop is refused.** Dragging onto a stage with missing required fields, or onto `lost` with the prompt cancelled, must put the card back in its column with no stale count (Task 7).
4. **Filters from a pasted or old URL.** An unknown stage id, a bad date or a deleted tag in the query string must fall back to "no filter", not break the page. A paging cursor is never trusted from the URL (Task 2: `parseFilters` drops anything it can't validate).
5. **A lead with no phone, an invalid phone, or a phone that needs a country.** Message must be unavailable with the reason ("no WhatsApp number" or "number needs a country code"), and Reveal must still work for the email (Tasks 1 and 5).

## File map

API (Task 1)
- `packages/core/src/leads/contact-access.ts` (new): `seesFullContacts(actor)`, the one rule for "may this role see full contacts", used by the API's search and by the web table.
- `apps/api/src/modules/leads/serialize.ts`: adds the `can` block.
- `apps/api/src/modules/leads/query.ts`: the filter-building is extracted as `leadFilters`; adds `countLeads`.
- `apps/api/src/modules/leads/routes.ts`: `GET /leads/counts`, `POST /leads/:id/messages/prepare`, `POST /leads/:id/messages/confirm`.
- `apps/api/src/messaging/channel.ts` (new): the `MessageChannel` interface and `ClickToSendChannel` (report §11.4).
- `apps/api/src/modules/leads/messages.ts` (new): prepare/confirm, activities and audit.
- `apps/api/src/modules/people/routes.ts` (new): `GET /people`, names for everyone who works leads.
- `apps/api/src/modules/leads/write.ts`: `stage_changed` records `lostReasonId`.

Web data (Task 2)
- `apps/web/src/lib/leads/types.ts`, `client.ts`, `filters.ts`, `format.ts`, `columns.ts` (all pure or thin, and all tested)
- `apps/web/src/server/leads.ts`: server-side loader for the catalog and the first page
- `apps/web/src/components/leads/CatalogProvider.tsx`

Screens (Tasks 3–8)
- `apps/web/src/app/(app)/leads/page.tsx`, `apps/web/src/app/(app)/pipeline/page.tsx`
- `apps/web/src/components/leads/`: `LeadsScreen`, `FilterBar`, `LeadsTable`, `ColumnPicker`, `cells.tsx`, `fields/FieldValue.tsx`, `fields/FieldEditor.tsx`, `useLeadEditor.ts`, `drawer/{LeadDrawer,StageTrack,ContactBox,Timeline,OutcomePopover,AssignMenu,MessageButton}.tsx`, `StageMoveDialog.tsx`, `NewLeadSheet.tsx`, `BulkBar.tsx`, `leads.module.css`, `drawer/drawer.module.css`
- `apps/web/src/components/board/`: `Board.tsx`, `BoardColumn.tsx`, `BoardCard.tsx`, `boardKeys.ts`, `board.module.css`

Tests (Task 9)
- `apps/web/e2e/leads.spec.ts`, `board.spec.ts`, and additions to `a11y.spec.ts`, `visual.spec.ts`, `seed.setup.ts`

---

### Task 1: API — per-lead permissions, people, board counts, WhatsApp hand-off

**Files:**
- Create: `packages/core/src/leads/contact-access.ts`, `apps/api/src/messaging/channel.ts`, `apps/api/src/modules/leads/messages.ts`, `apps/api/src/modules/leads/messages.test.ts`, `apps/api/src/modules/people/routes.ts`, `apps/api/src/modules/people/people.test.ts`
- Modify: `packages/core/src/shared.ts`, `apps/api/src/modules/leads/{serialize,query,routes,write}.ts`, `apps/api/src/modules/leads/leads.test.ts`, `apps/api/src/app.ts` (register people routes), `apps/api/test/probes.ts`, `packages/core/src/users/users.test.ts` (or a new `contact-access.test.ts`)

**Interfaces:**
- Produces:
  - `seesFullContacts(actor: Actor): boolean` from `@lume/core/shared`
  - Every `LeadView` gains `can: { edit: boolean; move: boolean; reveal: boolean; assign: boolean; delete: boolean; message: boolean }`
  - `GET /api/v1/people` (`leads.view`) → `{ people: { id: string; name: string; active: boolean }[] }`
  - `GET /api/v1/leads/counts` (`leads.view`, same filters as the list minus `cursor/limit/sort`, `pipelineId` required) → `{ counts: Record<stageId, number>, total: number }`
  - `POST /api/v1/leads/:id/messages/prepare` (`messages.send`, `{ text?: string }` ≤ 4096) → `{ url: string }`, or 422 `NO_WHATSAPP_NUMBER` / `PHONE_NEEDS_COUNTRY`
  - `POST /api/v1/leads/:id/messages/confirm` (`messages.send`, `{ sent: boolean }`) → `204`
  - Activity `stage_changed` payload gains `lostReasonId?: string`

- [ ] **Step 1: Write the failing tests**

`packages/core/src/leads/contact-access.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { effectivePermissions } from "../rbac/engine";
import { seesFullContacts } from "./contact-access";

const actor = (grants: { key: string; scope: "own" | "team" | "all" | null }[], isOwner = false) => ({
  userId: "u",
  isOwner,
  perms: effectivePermissions(grants as never),
  teamMemberIds: [],
  twoFactorEnabled: true,
  roleIds: [],
});

describe("seesFullContacts", () => {
  it("is true for the owner and for full contacts at least as wide as what they can view", () => {
    expect(seesFullContacts(actor([], true))).toBe(true);
    expect(seesFullContacts(actor([{ key: "leads.view", scope: "all" }, { key: "leads.contact.full", scope: "all" }]))).toBe(true);
    expect(seesFullContacts(actor([{ key: "leads.view", scope: "own" }, { key: "leads.contact.full", scope: "team" }]))).toBe(true);
  });

  it("is false for a masked role, and for full contacts narrower than the view", () => {
    expect(seesFullContacts(actor([{ key: "leads.view", scope: "own" }, { key: "leads.contact.reveal", scope: "own" }]))).toBe(false);
    expect(seesFullContacts(actor([{ key: "leads.view", scope: "all" }, { key: "leads.contact.full", scope: "own" }]))).toBe(false);
    expect(seesFullContacts(actor([]))).toBe(false);
  });
});
```

Add to `apps/api/src/modules/leads/leads.test.ts` (inside the existing `describe`; import `SALES_GRANTS` from `../../../test/grants` and `ALL_GRANTS` from `@lume/core`):
```ts
  it("tells the caller what they may do with each lead, computed on the server", async () => {
    const rep = await h.seedUser({ grants: SALES_GRANTS });
    const other = await h.seedUser({ grants: SALES_GRANTS });
    const mine = await h.seedLead({ ownerId: rep.id });
    const c = await h.signIn(rep);
    const { lead } = (await c.inject({ method: "GET", url: `/api/v1/leads/${mine}` })).json();
    expect(lead.can).toEqual({ edit: true, move: true, reveal: true, assign: false, delete: false, message: true });
    // An admin can do everything to anyone's lead.
    const admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
    const theirs = await h.seedLead({ ownerId: other.id });
    const seen = (await admin.inject({ method: "GET", url: `/api/v1/leads/${theirs}` })).json().lead;
    expect(Object.values(seen.can).every(Boolean)).toBe(true);
  });

  it("counts leads per stage with the same filters as the list, and only what the caller may see", async () => {
    const rep = await h.seedUser({ grants: SALES_GRANTS });
    const other = await h.seedUser({ grants: SALES_GRANTS });
    const { pipelineId, stages } = await h.config();
    await h.seedLead({ ownerId: rep.id, stage: "New" });
    await h.seedLead({ ownerId: rep.id, stage: "New" });
    await h.seedLead({ ownerId: rep.id, stage: "Message sent" });
    await h.seedLead({ ownerId: other.id, stage: "Message sent" }); // invisible to rep
    const c = await h.signIn(rep);
    const res = (await c.inject({ method: "GET", url: `/api/v1/leads/counts?pipelineId=${pipelineId}` })).json();
    expect(res.counts[stages["New"]!]).toBe(2);
    expect(res.counts[stages["Message sent"]!]).toBe(1);
    expect(res.total).toBe(3);
    const filtered = (
      await c.inject({
        method: "GET",
        url: `/api/v1/leads/counts?pipelineId=${pipelineId}&stageId=${stages["Message sent"]}`,
      })
    ).json();
    expect(filtered.total).toBe(1);
  });

  it("records the lost reason with the stage change, so history can say why", async () => {
    const admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
    const { stages, lostReasons } = await h.config();
    const lostStageId = stages["Lost"]!;
    const lostReasonId = lostReasons[0]!;
    const id = await h.seedLead({ ownerId: null });
    await admin.inject({ method: "POST", url: `/api/v1/leads/${id}/stage`, payload: { stageId: lostStageId, lostReasonId } });
    const acts = (await admin.inject({ method: "GET", url: `/api/v1/leads/${id}/activities` })).json().items;
    expect(acts.find((a: { type: string }) => a.type === "stage_changed").payload).toMatchObject({
      to: lostStageId,
      lostReasonId,
    });
  });
```
(`h.config()` returns the default pipeline's stages by name, from the Coaching preset: `New`, `Message sent`, …, `Won`, `Lost`, and the lost reason ids in order.)

`apps/api/src/modules/people/people.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";

let h: Harness;
beforeAll(async () => (h = await createHarness()));
afterAll(async () => h.close());

describe("people", () => {
  it("gives anyone who works leads the names of everyone, disabled people marked, and nothing else", async () => {
    const rep = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], name: "Riya" });
    const gone = await h.seedUser({ grants: [], name: "Old Rep" });
    await h.pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [gone.id]);
    const c = await h.signIn(rep);
    const res = await c.inject({ method: "GET", url: "/api/v1/people" });
    expect(res.statusCode).toBe(200);
    const people = res.json().people as { id: string; name: string; active: boolean }[];
    expect(people.find((p) => p.id === rep.id)).toEqual({ id: rep.id, name: "Riya", active: true });
    expect(people.find((p) => p.id === gone.id)?.active).toBe(false);
    expect(Object.keys(people[0]!).sort()).toEqual(["active", "id", "name"]); // no emails, no roles
  });

  it("is refused to someone who can't see leads", async () => {
    const c = await h.signIn(await h.seedUser({ grants: [] }));
    expect((await c.inject({ method: "GET", url: "/api/v1/people" })).statusCode).toBe(403);
  });
});
```
(`h.seedUser` already accepts `name`.)

`apps/api/src/modules/leads/messages.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SALES_GRANTS } from "../../../test/grants";
import { createHarness, type Harness } from "../../../test/harness";

let h: Harness;
beforeAll(async () => (h = await createHarness()));
afterAll(async () => h.close());

describe("WhatsApp hand-off (report §11.2)", () => {
  it("builds a wa.me link server-side, logs it, and never needs the caller to see the number", async () => {
    const rep = await h.seedUser({ grants: SALES_GRANTS });
    const id = await h.seedLead({ ownerId: rep.id, phone: "+971501234567" });
    const c = await h.signIn(rep);
    const res = await c.inject({
      method: "POST",
      url: `/api/v1/leads/${id}/messages/prepare`,
      payload: { text: "Hi Aisha & team — 20% off?" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json().url).toBe("https://wa.me/971501234567?text=Hi%20Aisha%20%26%20team%20%E2%80%94%2020%25%20off%3F");
    const acts = (await c.inject({ method: "GET", url: `/api/v1/leads/${id}/activities` })).json().items;
    expect(acts[0]).toMatchObject({ type: "whatsapp_opened", payload: { text: "Hi Aisha & team — 20% off?" } });
    const audit = await h.pool.query("SELECT 1 FROM audit_log WHERE action = 'lead.whatsapp.prepare' AND entity_id = $1", [id]);
    expect(audit.rowCount).toBe(1);
  });

  it("explains a lead without a usable number", async () => {
    const rep = await h.seedUser({ grants: SALES_GRANTS });
    const c = await h.signIn(rep);
    const none = await h.seedLead({ ownerId: rep.id, phone: null });
    const local = await h.seedLead({ ownerId: rep.id, phoneRaw: "0501234567", phoneStatus: "needs_country" });
    expect((await c.inject({ method: "POST", url: `/api/v1/leads/${none}/messages/prepare`, payload: {} })).json().error.code).toBe(
      "NO_WHATSAPP_NUMBER",
    );
    expect((await c.inject({ method: "POST", url: `/api/v1/leads/${local}/messages/prepare`, payload: {} })).json().error.code).toBe(
      "PHONE_NEEDS_COUNTRY",
    );
  });

  it("is refused on someone else's lead, and records the Sent? answer", async () => {
    const rep = await h.seedUser({ grants: SALES_GRANTS });
    const other = await h.seedUser({ grants: SALES_GRANTS });
    const c = await h.signIn(rep);
    const theirs = await h.seedLead({ ownerId: other.id, phone: "+971501234567" });
    expect((await c.inject({ method: "POST", url: `/api/v1/leads/${theirs}/messages/prepare`, payload: {} })).statusCode).toBe(404);
    const mine = await h.seedLead({ ownerId: rep.id, phone: "+971501234567" });
    const r = await c.inject({ method: "POST", url: `/api/v1/leads/${mine}/messages/confirm`, payload: { sent: true } });
    expect(r.statusCode).toBe(204);
    const acts = (await c.inject({ method: "GET", url: `/api/v1/leads/${mine}/activities` })).json().items;
    expect(acts[0].type).toBe("whatsapp_confirmed_sent");
  });
});
```
Supporting harness changes:
- `apps/api/test/grants.ts` (new): `export const SALES_GRANTS = DEFAULT_ROLES.find((r) => r.name === "Sales")!.grants;` (import `DEFAULT_ROLES` from `@lume/core`). `leads.test.ts` and `write.test.ts` keep their local `SALES` arrays; the new tests use the shared constant, so they track the real role.
- `seedLead` gains `phoneRaw?: string` and `phoneStatus?: "valid" | "needs_country" | "invalid" | "missing"`: the insert writes `phone_raw` too, and `phone_status` is `o.phoneStatus ?? (o.phone ? "valid" : "missing")`.

Add probes to `apps/api/test/probes.ts` (so the access matrix covers the new routes):
```ts
  "GET /api/v1/people": { access: "leads.view" },
  "GET /api/v1/leads/counts": { access: "leads.view", query: `pipelineId=${uuid}` },
  "POST /api/v1/leads/:id/messages/prepare": {
    access: "messages.send",
    path: (f) => `/api/v1/leads/${f.leadId}/messages/prepare`,
    body: () => ({}),
  },
  "POST /api/v1/leads/:id/messages/confirm": {
    access: "messages.send",
    path: (f) => `/api/v1/leads/${f.leadId}/messages/confirm`,
    body: () => ({ sent: false }),
  },
```

- [ ] **Step 2: Run to verify they fail**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run packages/core/src/leads apps/api/src/modules/leads apps/api/src/modules/people apps/api/test'`
Expected: FAIL, because `contact-access` and `messages` don't exist, `can` is missing, `/people` and `/leads/counts` are 404, and the matrix reports the new probes without routes.

- [ ] **Step 3: Implement**

`packages/core/src/leads/contact-access.ts`:
```ts
import { SCOPE_RANK } from "../rbac/catalog";
import { scopeOf, type Actor } from "../rbac/engine";

/**
 * Report §12.2 #4: may this role see full contact details on every lead it can see? Masked roles get no
 * contact columns, no contact filters and name-only search. One rule, used by the API and the web table.
 */
export function seesFullContacts(actor: Actor): boolean {
  if (actor.isOwner) return true;
  const full = scopeOf(actor, "leads.contact.full");
  const view = scopeOf(actor, "leads.view");
  return full !== null && view !== null && SCOPE_RANK[full] >= SCOPE_RANK[view];
}
```
Export it from `packages/core/src/shared.ts` (`export * from "./leads/contact-access";`). In `query.ts` delete `canSearchContacts` and use `seesFullContacts(req.actor!)` (the API's `ActorRecord` extends `Actor`).

`serialize.ts`: add the `can` block after `contactMasked` (the phone must be `valid` for Message to make sense, which the prepare route re-checks):
```ts
    can: {
      edit: canOnRecord(ctx.actor, "leads.edit", row.ownerId),
      move: canOnRecord(ctx.actor, "leads.change_stage", row.ownerId),
      reveal:
        !full &&
        (canOnRecord(ctx.actor, "leads.contact.reveal", row.ownerId) ||
          canOnRecord(ctx.actor, "leads.contact.full", row.ownerId)),
      assign: canOnRecord(ctx.actor, "leads.assign", row.ownerId),
      delete: canOnRecord(ctx.actor, "leads.delete", row.ownerId),
      message: canOnRecord(ctx.actor, "messages.send", row.ownerId),
    },
```
and extend `LeadView` with `can: Record<"edit" | "move" | "reveal" | "assign" | "delete" | "message", boolean>`.

`query.ts`: move everything from `const where: (SQL | undefined)[] = [isNull(L.deletedAt)]` through the custom-filter block into
```ts
export async function leadFilters(req: FastifyRequest, q: Omit<ListQuery, "cursor" | "limit" | "sort">, fields: FieldRegistry): Promise<(SQL | undefined)[]>
```
(no cursor condition; `listLeads` adds `cursorWhere` itself) and add:
```ts
export async function countLeads(req: FastifyRequest, q: Omit<ListQuery, "cursor" | "limit" | "sort"> & { pipelineId: string }) {
  const fields = await loadFieldRegistry(req);
  const where = await leadFilters(req, q, fields);
  const rows = await req.db
    .select({ stageId: L.stageId, n: sql<number>`count(*)::int` })
    .from(L)
    .where(and(...where))
    .groupBy(L.stageId);
  const counts = Object.fromEntries(rows.map((r) => [r.stageId, r.n]));
  return { counts, total: rows.reduce((s, r) => s + r.n, 0) };
}
```
Route (in `routes.ts`, registered **before** `/api/v1/leads/:id` so the static path wins, although `:id` is uuid-validated anyway):
```ts
  r.get(
    "/api/v1/leads/counts",
    {
      config: { permission: "leads.view" },
      schema: { querystring: listQuery.omit({ cursor: true, limit: true, sort: true }).extend({ pipelineId: z.uuid() }) },
    },
    (req) => countLeads(req, req.query),
  );
```

`apps/api/src/messaging/channel.ts`:
```ts
/**
 * Report §11.4: how a message leaves LUME. v1 has one channel, click-to-send (a wa.me link the person
 * opens themselves); the Cloud API can implement this interface later without touching callers.
 */
export type PreparedMessage = { url: string };
export interface MessageChannel {
  readonly name: string;
  prepare(to: { e164: string }, text: string): PreparedMessage;
}

export const clickToSend: MessageChannel = {
  name: "click_to_send",
  prepare(to, text) {
    const digits = to.e164.replace(/\D/g, "");
    return { url: `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ""}` };
  },
};
```

`apps/api/src/modules/leads/messages.ts`:
```ts
import type { FastifyRequest } from "fastify";
import { canOnRecord } from "@lume/core";
import { audit } from "../../audit/audit";
import { HttpError, forbidden } from "../../http/errors";
import { clickToSend } from "../../messaging/channel";
import { recordActivity, visibleLead } from "./service";

/** Report §11.2 steps 2 and 4. The link is built here, opened by the page, and never listed or shown. */
export async function prepareMessage(req: FastifyRequest, id: string, text: string) {
  const lead = await visibleLead(req, id);
  if (!canOnRecord(req.actor!, "messages.send", lead.ownerId)) throw forbidden();
  if (lead.phoneStatus === "needs_country")
    throw new HttpError(422, "PHONE_NEEDS_COUNTRY", "This number needs a country code before WhatsApp can open it");
  if (!lead.phoneE164 || lead.phoneStatus !== "valid")
    throw new HttpError(422, "NO_WHATSAPP_NUMBER", "This lead has no WhatsApp number");
  const prepared = clickToSend.prepare({ e164: lead.phoneE164 }, text);
  await recordActivity(req, id, "whatsapp_opened", { text, channel: clickToSend.name });
  await audit(req, { action: "lead.whatsapp.prepare", entityType: "lead", entityId: id });
  return prepared;
}

export async function confirmMessage(req: FastifyRequest, id: string, sent: boolean) {
  const lead = await visibleLead(req, id);
  if (!canOnRecord(req.actor!, "messages.send", lead.ownerId)) throw forbidden();
  await recordActivity(req, id, sent ? "whatsapp_confirmed_sent" : "whatsapp_not_sent");
}
```
Routes:
```ts
  r.post(
    "/api/v1/leads/:id/messages/prepare",
    {
      config: { permission: "messages.send" },
      schema: { params, body: z.object({ text: z.string().max(4096).default("") }) },
    },
    async (req, reply) => {
      void reply.header("cache-control", "no-store");
      return prepareMessage(req, req.params.id, req.body.text);
    },
  );
  r.post(
    "/api/v1/leads/:id/messages/confirm",
    { config: { permission: "messages.send" }, schema: { params, body: z.object({ sent: z.boolean() }) } },
    async (req, reply) => {
      await confirmMessage(req, req.params.id, req.body.sent);
      return reply.code(204).send();
    },
  );
```

`apps/api/src/modules/people/routes.ts`:
```ts
import { asc } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { schema } from "@lume/db";

/**
 * Names for everyone who works leads: owners on rows, the owner filter, the assign picker. Names only;
 * emails, roles and status details stay behind users.manage. Disabled people stay listed (their old
 * leads still show who handled them) and are marked inactive so pickers can leave them out.
 */
export async function peopleRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/people", { config: { permission: "leads.view" } }, async (req) => {
    const rows = await req.db
      .select({ id: schema.users.id, name: schema.users.name, status: schema.users.status })
      .from(schema.users)
      .orderBy(asc(schema.users.name));
    return { people: rows.filter((r) => r.status !== "invited").map((r) => ({ id: r.id, name: r.name, active: r.status === "active" })) };
  });
}
```
Register it in `apps/api/src/app.ts` next to the other module routes (same scope, so the route guard and db context apply).

`write.ts` `moveStage`: `recordActivity(req, lead.id, "stage_changed", { from: lead.stageId, to: target.id, ...(input.lostReasonId && target.kind === "lost" ? { lostReasonId: input.lostReasonId } : {}) });`

- [ ] **Step 4: Run to verify they pass**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run packages/core apps/api'`
Expected: all green, including the access matrix with the four new probes.

- [ ] **Step 5: Strict gate, commit, push**

```bash
bash "$SCRATCH/gate.sh" && git add -A && git commit -m "feat(api): per-lead permissions, people names, filter-aware board counts, WhatsApp click-to-send hand-off

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git push origin main
```

---

### Task 2: Web data layer — types, API client, URL filters, formatting, columns

**Files:**
- Create: `apps/web/src/lib/leads/{types,client,filters,format,columns}.ts` and `filters.test.ts`, `format.test.ts`, `columns.test.ts`, `client.test.ts`
- Create: `apps/web/src/server/leads.ts` (server loader), `apps/web/src/components/leads/CatalogProvider.tsx`

**Interfaces:**
- Consumes: Task 1's `can` block, `/people`, `/leads/counts`, `/messages/prepare|confirm`; `api` (browser client, `lib/api.ts`); `apiGet` (server, `server/api.ts`); `seesFullContacts` (`@lume/core/shared`).
- Produces (later tasks rely on these exact names):
  - Types: `Lead`, `LeadCan`, `ContactView`, `Stage`, `Pipeline`, `FieldDefView`, `Person`, `Tag`, `LostReason`, `Product`, `Catalog`, `Activity`, `LeadPage`
  - `leadsClient`: `list(f: ListFilters, cursor?: string)`, `counts(f: ListFilters & { pipelineId: string })`, `get(id)`, `create(input)`, `patch(id, version, patch)`, `move(id, stageId, extra?)`, `assign(id, ownerId)`, `note(id, body)`, `activities(id, cursor?)`, `reveal(id)`, `bulk(ids, action)`, `duplicates(c)`, `prepareMessage(id, text)`, `confirmMessage(id, sent)`, each returning `ApiResult<…>`
  - `ListFilters` = `{ q?: string; stageIds: string[]; owner?: "me" | "none" | string; tagId?: string; phoneStatus?: PhoneStatus; from?: string; to?: string; sort: Sort; pipelineId?: string }`, `parseFilters(params: URLSearchParams, catalog: Catalog): ListFilters`, `filtersToParams(f): URLSearchParams`, `apiQuery(f): string`, `activeFilterCount(f): number`, `EMPTY_FILTERS`
  - `formatMoney(value, currency)`, `relativeTime(iso, now?)`, `fieldText(value, def, catalog)`, `stageOf(catalog, id)`, `personName(catalog, id)`
  - `COLUMN_IDS`, `availableColumns(catalog, contactsVisible: boolean): ColumnDef[]`, `resolveColumns(saved: string[] | null, available: ColumnDef[]): ColumnDef[]`, `loadColumnChoice(userId)`, `saveColumnChoice(userId, ids)`
  - `loadLeadsPage(params)` (server) → `{ catalog: Catalog; first: LeadPage; filters: ListFilters }`
  - `<CatalogProvider catalog>`, `useCatalog(): Catalog`

- [ ] **Step 1: Write the failing tests**

`apps/web/src/lib/leads/filters.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { EMPTY_FILTERS, activeFilterCount, apiQuery, filtersToParams, parseFilters } from "./filters";
import { testCatalog } from "./test-catalog";

const cat = testCatalog();
const [s1, s2] = cat.pipelines[0]!.stages;

describe("lead filters in the URL", () => {
  it("round-trips every filter through the address bar", () => {
    const f = { ...EMPTY_FILTERS, q: "aisha", stageIds: [s1!.id, s2!.id], owner: "me", tagId: cat.tags[0]!.id,
      phoneStatus: "needs_country" as const, from: "2026-09-01", to: "2026-09-30", sort: "updated" as const };
    expect(parseFilters(filtersToParams(f), cat)).toEqual(f);
  });

  it("drops anything it can't vouch for, instead of breaking the page", () => {
    const junk = new URLSearchParams({
      stage: `${s1!.id},not-a-stage,${"0".repeat(36)}`,
      owner: "someone-deleted",
      tag: "nope",
      phone: "weird",
      from: "2026-13-45",
      to: "yesterday",
      sort: "chaos",
      cursor: "should-never-be-trusted",
    });
    expect(parseFilters(junk, cat)).toEqual({ ...EMPTY_FILTERS, stageIds: [s1!.id] });
  });

  it("builds the API query, never with more than one owner meaning", () => {
    const q = apiQuery({ ...EMPTY_FILTERS, stageIds: [s1!.id], owner: "none", q: "  riya  " });
    expect(new URLSearchParams(q).get("ownerId")).toBe("none");
    expect(new URLSearchParams(q).get("q")).toBe("riya");
    expect(new URLSearchParams(q).get("stageId")).toBe(s1!.id);
    expect(new URLSearchParams(q).has("cursor")).toBe(false);
  });

  it("counts what the person has narrowed, so the bar can say so", () => {
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...EMPTY_FILTERS, q: "x", stageIds: [s1!.id, s2!.id], owner: "me" })).toBe(3);
  });
});
```

`apps/web/src/lib/leads/format.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { fieldText, formatMoney, relativeTime } from "./format";
import { testCatalog } from "./test-catalog";

describe("formatting", () => {
  it("shows money the way the business counts it", () => {
    expect(formatMoney(4500, "AED")).toBe("AED 4,500");
    expect(formatMoney(4500.5, "AED")).toBe("AED 4,500.50");
    expect(formatMoney(null, "AED")).toBe("");
  });

  it("says how long ago in words, falling back to a date after a week", () => {
    const now = new Date("2026-09-25T12:00:00Z");
    expect(relativeTime("2026-09-25T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-09-25T09:00:00Z", now)).toBe("3h ago");
    expect(relativeTime("2026-09-23T12:00:00Z", now)).toBe("2d ago");
    expect(relativeTime("2026-09-01T12:00:00Z", now)).toBe("1 Sep");
    expect(relativeTime("2025-09-01T12:00:00Z", now)).toBe("1 Sep 2025");
  });

  it("turns any field value into text, options by label and people by name", () => {
    const cat = testCatalog();
    const struggles = cat.fields.find((f) => f.key === "struggles")!;
    expect(fieldText([struggles.options[0]!.id], struggles, cat)).toBe(struggles.options[0]!.label);
    const handled = cat.fields.find((f) => f.type === "user")!;
    expect(fieldText(cat.people[0]!.id, handled, cat)).toBe(cat.people[0]!.name);
    expect(fieldText(true, { ...handled, type: "boolean" }, cat)).toBe("Yes");
    expect(fieldText(undefined, handled, cat)).toBe("");
  });
});
```

`apps/web/src/lib/leads/columns.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { availableColumns, resolveColumns } from "./columns";
import { testCatalog } from "./test-catalog";

describe("table columns", () => {
  it("never offers a contact column to a masked role (report §12.2 #4)", () => {
    const ids = availableColumns(testCatalog(), false).map((c) => c.id);
    expect(ids).not.toContain("phone");
    expect(ids).not.toContain("email");
    expect(ids).not.toContain("instagram");
    expect(ids).toContain("name");
  });

  it("offers contacts to a full-contact role, and custom fields the caller can see", () => {
    const cat = testCatalog();
    const ids = availableColumns(cat, true).map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["name", "phone", "email", "stage", "owner", "value", "custom:struggles"]));
    const hidden = { ...cat, fields: cat.fields.map((f) => (f.key === "struggles" ? { ...f, access: "hidden" as const } : f)) };
    expect(availableColumns(hidden, true).map((c) => c.id)).not.toContain("custom:struggles");
  });

  it("keeps a saved order, drops columns that no longer exist, and always keeps the name first", () => {
    const available = availableColumns(testCatalog(), true);
    const cols = resolveColumns(["owner", "gone:field", "stage"], available).map((c) => c.id);
    expect(cols).toEqual(["name", "owner", "stage"]);
    expect(resolveColumns(null, available).map((c) => c.id)).toEqual(["name", "stage", "owner", "phone", "value", "updated"]);
  });
});
```

`apps/web/src/lib/leads/client.test.ts` (checks the If-Match and query wiring; `fetch` is stubbed):
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCsrfForTests } from "@/lib/api";
import { leadsClient } from "./client";
import { EMPTY_FILTERS } from "./filters";

const calls: { url: string; init: RequestInit }[] = [];
beforeEach(() => {
  resetCsrfForTests();
  calls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/auth/csrf")) return new Response(JSON.stringify({ token: "t" }));
    return new Response(JSON.stringify({ lead: { id: "l1", version: 4 } }), { status: 200 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("leads client", () => {
  it("sends the version it edited, so a concurrent change is detected instead of overwritten", async () => {
    await leadsClient.patch("l1", 3, { name: "Aisha K" });
    const req = calls.find((c) => c.url === "/api/v1/leads/l1")!;
    expect(new Headers(req.init.headers).get("if-match")).toBe('"3"');
    expect(req.init.method).toBe("PATCH");
  });

  it("asks for at most 50 rows at a time and passes the cursor through", async () => {
    await leadsClient.list({ ...EMPTY_FILTERS, q: "ai" }, "c1");
    const url = new URL(calls.at(-1)!.url, "http://x");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("cursor")).toBe("c1");
    expect(url.searchParams.get("q")).toBe("ai");
  });
});
```
This needs `send` in `lib/api.ts` to accept extra headers. Add an optional `headers?: Record<string, string>` parameter to `send` and expose `api.patchIf(path, version, body)` that sets `if-match: "<version>"`.

`apps/web/src/lib/leads/test-catalog.ts` (fixtures shared by the tests in Tasks 2–8; only tests import it, so it never ships. Test files never import each other, because that would register their tests twice):
```ts
import type { Catalog, Lead } from "./types";

/** A lead as a masked sales rep receives it; override what a test cares about. */
export const testLead = (over: Partial<Lead> = {}): Lead => ({
  id: "l1",
  version: 1,
  pipelineId: "p1",
  stageId: "s-new",
  ownerId: "u-riya",
  name: "Aisha Khan",
  phone: { display: "+971 50 ••• ••67", masked: true, status: "valid" },
  email: null,
  instagram: null,
  value: 4500,
  currency: "AED",
  createdAt: "2026-09-20T10:00:00Z",
  updatedAt: "2026-09-24T10:00:00Z",
  tagIds: [],
  custom: {},
  contactMasked: true,
  can: { edit: true, move: true, reveal: true, assign: false, delete: false, message: true },
  ...over,
});

/** A small, realistic catalog: the Coaching preset's stages, a few fields, two people, tags, reasons. */
export function testCatalog(over: Partial<Catalog> = {}): Catalog {
  const stages = [
    ["s-new", "New", "accent", "open"],
    ["s-sent", "Message sent", "cyan", "open"],
    ["s-booked", "Call booked", "warn", "open"],
    ["s-won", "Won", "ok", "won"],
    ["s-lost", "Lost", "danger", "lost"],
  ].map(([id, name, color, kind], position) => ({ id: id!, name: name!, color: color!, kind: kind as "open", position, requiredFieldIds: [] as string[] }));
  return {
    pipelines: [{ id: "p1", name: "Coaching sales", isDefault: true, stages }],
    fields: [
      { id: "f-name", key: "name", label: "Name", type: "text", options: [], isCore: true, isRequired: true, archived: false, access: "edit" },
      { id: "f-phone", key: "phone", label: "Phone", type: "phone", options: [], isCore: true, isRequired: false, archived: false, access: "edit" },
      { id: "f-email", key: "email", label: "Email", type: "email", options: [], isCore: true, isRequired: false, archived: false, access: "edit" },
      { id: "f-value", key: "value", label: "Deal value", type: "currency", options: [], isCore: true, isRequired: false, archived: false, access: "edit" },
      {
        id: "f-str", key: "struggles", label: "Struggles", type: "multi_select", isCore: false, isRequired: false, archived: false, access: "edit",
        options: [{ id: "o1", label: "Confidence" }, { id: "o2", label: "Career switch" }],
      },
      { id: "f-hb", key: "handled_by", label: "Handled by", type: "user", options: [], isCore: false, isRequired: false, archived: false, access: "edit" },
    ],
    people: [
      { id: "u-riya", name: "Riya Sharma", active: true },
      { id: "u-tas", name: "Tasneem Shaikh", active: true },
    ],
    tags: [{ id: "t-hot", label: "Hot", color: "danger" }],
    lostReasons: [{ id: "r-price", label: "Price", position: 0 }],
    products: [{ id: "pr-sig", name: "Signature 12-week", defaultValue: 4500, currency: "AED" }],
    currency: "AED",
    ...over,
  };
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `scripts/dev.sh run pnpm vitest run apps/web/src/lib/leads`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`apps/web/src/lib/leads/types.ts`:
```ts
import type { FieldOption, FieldType, PhoneStatus } from "@lume/core/shared";

export type ContactView = { display: string; masked: boolean; status?: PhoneStatus };
export type LeadCan = { edit: boolean; move: boolean; reveal: boolean; assign: boolean; delete: boolean; message: boolean };
/** A lead as the API serializes it for this caller: hidden fields are absent, contacts may be masked. */
export type Lead = {
  id: string;
  version: number;
  pipelineId: string;
  stageId?: string;
  ownerId?: string | null;
  name?: string;
  phone?: ContactView | null;
  email?: ContactView | null;
  instagram?: ContactView | null;
  value?: number | null;
  currency?: string | null;
  productId?: string | null;
  lostReasonId?: string | null;
  lostNote?: string | null;
  wonAt?: string | null;
  lostAt?: string | null;
  leadCreatedAt?: string | null;
  lastActivityAt?: string | null;
  stageEnteredAt?: string;
  createdAt: string;
  updatedAt: string;
  tagIds: string[];
  custom: Record<string, unknown>;
  contactMasked: boolean;
  can: LeadCan;
};
export type LeadPage = { items: Lead[]; nextCursor: string | null };
export type Stage = { id: string; name: string; color: string; position: number; kind: "open" | "won" | "lost"; requiredFieldIds: string[] };
export type Pipeline = { id: string; name: string; isDefault: boolean; stages: Stage[] };
export type FieldDefView = {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  options: FieldOption[];
  isCore: boolean;
  isRequired: boolean;
  archived: boolean;
  access: "edit" | "view" | "hidden";
};
export type Person = { id: string; name: string; active: boolean };
export type Tag = { id: string; label: string; color: string };
export type LostReason = { id: string; label: string; position: number };
export type Product = { id: string; name: string; defaultValue: number | null; currency: string | null };
export type Catalog = {
  pipelines: Pipeline[];
  fields: FieldDefView[];
  people: Person[];
  tags: Tag[];
  lostReasons: LostReason[];
  products: Product[];
  /** The business currency (settings), the default for new values. */
  currency: string;
};
export type Activity = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  user: { id: string; name: string } | null;
};
export type Duplicate =
  | { visible: true; leadId: string; name: string; ownerName: string | null; matchedOn: ("phone" | "email" | "instagram")[] }
  | { visible: false; matchedOn: ("phone" | "email" | "instagram")[] };
export type BulkAction =
  | { type: "stage"; stageId: string; lostReasonId?: string }
  | { type: "assign"; ownerId: string | null }
  | { type: "tags"; add?: string[]; remove?: string[] }
  | { type: "delete" };
export type BulkResult = { updated: string[]; skipped: { id: string; code: string }[] };
```

`apps/web/src/lib/leads/filters.ts`:
```ts
import type { PhoneStatus } from "@lume/core/shared";
import type { Catalog } from "./types";

export type Sort = "newest" | "oldest" | "updated" | "name";
export type ListFilters = {
  q?: string;
  stageIds: string[];
  owner?: "me" | "none" | string;
  tagId?: string;
  phoneStatus?: PhoneStatus;
  from?: string;
  to?: string;
  sort: Sort;
  pipelineId?: string;
};
export const EMPTY_FILTERS: ListFilters = { stageIds: [], sort: "newest" };

const SORTS: Sort[] = ["newest", "oldest", "updated", "name"];
const PHONE: PhoneStatus[] = ["valid", "needs_country", "invalid", "missing"];
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const realDate = (s: string | null) => (s && DATE.test(s) && !Number.isNaN(Date.parse(s)) ? s : undefined);

/**
 * The address bar is input like any other: a pasted or stale link must never break the page. Anything
 * that doesn't name something in the catalog (a deleted stage or tag, a person who left) is dropped.
 * The paging cursor is never read from the URL.
 */
export function parseFilters(p: URLSearchParams, cat: Catalog): ListFilters {
  const stages = new Set(cat.pipelines.flatMap((pl) => pl.stages.map((s) => s.id)));
  const people = new Set(cat.people.map((x) => x.id));
  const q = p.get("q")?.trim().slice(0, 100) || undefined;
  const owner = p.get("owner");
  const tag = p.get("tag");
  const phone = p.get("phone") as PhoneStatus | null;
  const sort = p.get("sort") as Sort | null;
  const pipeline = p.get("pipeline");
  return {
    ...(q ? { q } : {}),
    stageIds: (p.get("stage") ?? "").split(",").filter((id) => stages.has(id)).slice(0, 20),
    ...(owner === "me" || owner === "none" || (owner && people.has(owner)) ? { owner } : {}),
    ...(tag && cat.tags.some((t) => t.id === tag) ? { tagId: tag } : {}),
    ...(phone && PHONE.includes(phone) ? { phoneStatus: phone } : {}),
    ...(realDate(p.get("from")) ? { from: realDate(p.get("from")) } : {}),
    ...(realDate(p.get("to")) ? { to: realDate(p.get("to")) } : {}),
    sort: sort && SORTS.includes(sort) ? sort : "newest",
    ...(pipeline && cat.pipelines.some((x) => x.id === pipeline) ? { pipelineId: pipeline } : {}),
  };
}

export function filtersToParams(f: ListFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.stageIds.length) p.set("stage", f.stageIds.join(","));
  if (f.owner) p.set("owner", f.owner);
  if (f.tagId) p.set("tag", f.tagId);
  if (f.phoneStatus) p.set("phone", f.phoneStatus);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.sort !== "newest") p.set("sort", f.sort);
  if (f.pipelineId) p.set("pipeline", f.pipelineId);
  return p;
}

/** The API's query string for these filters (the list adds cursor and limit itself). */
export function apiQuery(f: ListFilters): string {
  const p = new URLSearchParams();
  if (f.q?.trim()) p.set("q", f.q.trim());
  if (f.stageIds.length) p.set("stageId", f.stageIds.join(","));
  if (f.owner) p.set("ownerId", f.owner);
  if (f.tagId) p.set("tagId", f.tagId);
  if (f.phoneStatus) p.set("phoneStatus", f.phoneStatus);
  if (f.from) p.set("createdFrom", f.from);
  if (f.to) p.set("createdTo", f.to);
  if (f.pipelineId) p.set("pipelineId", f.pipelineId);
  p.set("sort", f.sort);
  return p.toString();
}

export const activeFilterCount = (f: ListFilters): number =>
  [f.q, f.stageIds.length ? 1 : undefined, f.owner, f.tagId, f.phoneStatus, f.from || f.to].filter(Boolean).length;
```

`apps/web/src/lib/leads/format.ts`:
```ts
import type { Catalog, FieldDefView } from "./types";

export function formatMoney(value: number | null | undefined, currency: string): string {
  if (value === null || value === undefined) return "";
  const whole = Number.isInteger(value);
  const n = new Intl.NumberFormat("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(value);
  return `${currency} ${n}`;
}

export function relativeTime(iso: string, now: Date = new Date()): string {
  const t = new Date(iso);
  const s = Math.round((now.getTime() - t.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  const sameYear = t.getUTCFullYear() === now.getUTCFullYear();
  return t.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" });
}

export const stageOf = (cat: Catalog, id: string | undefined) =>
  cat.pipelines.flatMap((p) => p.stages).find((s) => s.id === id);
export const personName = (cat: Catalog, id: string | null | undefined) =>
  id ? (cat.people.find((p) => p.id === id)?.name ?? "Someone who left") : "Unassigned";

/** Any field value as the text a person reads: options by label, people by name, Yes/No, dates in words. */
export function fieldText(value: unknown, def: FieldDefView, cat: Catalog): string {
  if (value === null || value === undefined || value === "") return "";
  const label = (id: unknown) => def.options.find((o) => o.id === id)?.label ?? "";
  switch (def.type) {
    case "select":
      return label(value);
    case "multi_select":
      return Array.isArray(value) ? value.map(label).filter(Boolean).join(", ") : "";
    case "boolean":
      return value ? "Yes" : "No";
    case "user":
      return personName(cat, String(value));
    case "currency":
      return formatMoney(Number(value), cat.currency);
    case "date":
      return new Date(`${String(value)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    default:
      return String(value);
  }
}
```

`apps/web/src/lib/leads/columns.ts`:
```ts
import type { Catalog, Lead } from "./types";

export type ColumnDef = { id: string; label: string; width: number; fieldKey?: string; sortable?: "name" | "updated" };
const CORE: ColumnDef[] = [
  { id: "name", label: "Name", width: 240, fieldKey: "name", sortable: "name" },
  { id: "stage", label: "Stage", width: 150 },
  { id: "owner", label: "Owner", width: 160 },
  { id: "phone", label: "Phone", width: 170, fieldKey: "phone" },
  { id: "email", label: "Email", width: 220, fieldKey: "email" },
  { id: "instagram", label: "Instagram", width: 150, fieldKey: "instagram" },
  { id: "value", label: "Value", width: 120, fieldKey: "value" },
  { id: "tags", label: "Tags", width: 160 },
  { id: "created", label: "Enquiry date", width: 130 },
  { id: "updated", label: "Last activity", width: 130, sortable: "updated" },
];
const CONTACT = new Set(["phone", "email", "instagram"]);
export const DEFAULT_COLUMNS = ["name", "stage", "owner", "phone", "value", "updated"];

/**
 * What this person may add to their table. A masked role gets no contact column at all (report §12.2 #4),
 * and nobody gets a column for a field hidden from them.
 */
export function availableColumns(cat: Catalog, contactsVisible: boolean): ColumnDef[] {
  const visible = (key?: string) => !key || cat.fields.find((f) => f.key === key)?.access !== "hidden";
  const core = CORE.filter((c) => (contactsVisible || !CONTACT.has(c.id)) && visible(c.fieldKey));
  const custom = cat.fields
    .filter((f) => !f.isCore && !f.archived && f.access !== "hidden")
    .map((f) => ({ id: `custom:${f.key}`, label: f.label, width: 160, fieldKey: f.key }));
  return [...core, ...custom];
}

/** Saved order first, unknown ids dropped, and the name always the first column. */
export function resolveColumns(saved: string[] | null, available: ColumnDef[]): ColumnDef[] {
  const byId = new Map(available.map((c) => [c.id, c]));
  const ids = (saved ?? DEFAULT_COLUMNS).filter((id) => byId.has(id) && id !== "name");
  return [byId.get("name")!, ...ids.map((id) => byId.get(id)!)].filter(Boolean);
}

const KEY = (userId: string) => `lume.leads.columns.${userId}`;
/** A per-person convenience kept in this browser; losing it only means the default columns come back. */
export function loadColumnChoice(userId: string): string[] | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY(userId)) ?? "null");
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null;
  } catch {
    return null;
  }
}
export function saveColumnChoice(userId: string, ids: string[]): void {
  try {
    localStorage.setItem(KEY(userId), JSON.stringify(ids));
  } catch {
    /* private mode: the choice lasts until reload */
  }
}

/** The value a column shows for a lead, before formatting (used by the table and by sorting tests). */
export const columnValue = (lead: Lead, col: ColumnDef): unknown =>
  col.id.startsWith("custom:") ? lead.custom[col.fieldKey!] : (lead as Record<string, unknown>)[col.fieldKey ?? col.id];
```

`apps/web/src/lib/leads/client.ts`:
```ts
"use client";
import { api } from "@/lib/api";
import { apiQuery, type ListFilters } from "./filters";
import type { Activity, BulkAction, BulkResult, Duplicate, Lead, LeadPage } from "./types";

export const PAGE_SIZE = 50;
const enc = encodeURIComponent;

/** Every lead call the screens make. Each returns ApiResult, so callers handle refusal explicitly. */
export const leadsClient = {
  list: (f: ListFilters, cursor?: string) =>
    api.get<LeadPage>(`/api/v1/leads?${apiQuery(f)}&limit=${PAGE_SIZE}${cursor ? `&cursor=${enc(cursor)}` : ""}`),
  counts: (f: ListFilters & { pipelineId: string }) => {
    const q = new URLSearchParams(apiQuery(f));
    q.delete("sort");
    return api.get<{ counts: Record<string, number>; total: number }>(`/api/v1/leads/counts?${q}`);
  },
  get: (id: string) => api.get<{ lead: Lead }>(`/api/v1/leads/${id}`),
  create: (input: Record<string, unknown>) => api.post<{ lead: Lead; duplicates: Duplicate[] }>("/api/v1/leads", input),
  patch: (id: string, version: number, patch: Record<string, unknown>) => api.patchIf<{ lead: Lead }>(`/api/v1/leads/${id}`, version, patch),
  move: (id: string, stageId: string, extra: { lostReasonId?: string; lostNote?: string } = {}) =>
    api.post<{ lead: Lead }>(`/api/v1/leads/${id}/stage`, { stageId, ...extra }),
  assign: (id: string, ownerId: string | null) =>
    api.post<{ id: string; ownerId: string | null; visible: boolean }>(`/api/v1/leads/${id}/assign`, { ownerId }),
  note: (id: string, body: string) => api.post<{ activity: Activity }>(`/api/v1/leads/${id}/notes`, { body }),
  activities: (id: string, cursor?: string) =>
    api.get<{ items: Activity[]; nextCursor: string | null }>(`/api/v1/leads/${id}/activities${cursor ? `?cursor=${cursor}` : ""}`),
  reveal: (id: string) => api.post<{ phone: string | null; email: string | null; instagram: string | null }>(`/api/v1/leads/${id}/contact/reveal`),
  bulk: (ids: string[], action: BulkAction) => api.post<BulkResult>("/api/v1/leads/bulk", { ids, action }),
  duplicates: (c: { phone?: string; email?: string }) => {
    const q = new URLSearchParams(Object.entries(c).filter(([, v]) => v) as [string, string][]);
    return api.get<{ duplicates: Duplicate[] }>(`/api/v1/leads/duplicates?${q}`);
  },
  prepareMessage: (id: string, text: string) => api.post<{ url: string }>(`/api/v1/leads/${id}/messages/prepare`, { text }),
  confirmMessage: (id: string, sent: boolean) => api.post<null>(`/api/v1/leads/${id}/messages/confirm`, { sent }),
  remove: (id: string) => api.del<null>(`/api/v1/leads/${id}`),
};
```
In `lib/api.ts`: `send(method, path, body?, retry = true, extra: Record<string, string> = {})` merges `extra` into headers (and passes it on the CSRF retry), and
```ts
  patchIf: <T>(path: string, version: number, body?: unknown) => send<T>("PATCH", path, body, true, { "if-match": `"${version}"` }),
```

`apps/web/src/server/leads.ts`:
```ts
import { seesFullContacts } from "@lume/core/shared";
import { parseFilters, apiQuery, type ListFilters } from "@/lib/leads/filters";
import type { Catalog, FieldDefView, LeadPage, LostReason, Person, Pipeline, Product, Tag } from "@/lib/leads/types";
import { apiGet } from "./api";
import type { Session } from "./session";

/**
 * Everything the leads screens need for their first paint, fetched in parallel on the server with the
 * visitor's cookie: the catalog, and the first page for the filters in the URL. A catalog list the caller
 * can't read (403) is simply empty; the screens then leave that control out.
 */
export async function loadLeadsPage(session: Session, search: URLSearchParams): Promise<{ catalog: Catalog; filters: ListFilters; first: LeadPage | null; contactsVisible: boolean }> {
  const [pipelines, fields, people, tags, reasons, products, settings] = await Promise.all([
    apiGet<{ pipelines: Pipeline[] }>("/api/v1/pipelines"),
    apiGet<{ fields: FieldDefView[] }>("/api/v1/fields"),
    apiGet<{ people: Person[] }>("/api/v1/people"),
    apiGet<{ tags: Tag[] }>("/api/v1/tags"),
    apiGet<{ lostReasons: LostReason[] }>("/api/v1/lost-reasons"),
    apiGet<{ products: Product[] }>("/api/v1/products"),
    apiGet<{ currency: string }>("/api/v1/settings"),
  ]);
  const catalog: Catalog = {
    pipelines: pipelines.data?.pipelines ?? [],
    fields: fields.data?.fields ?? [],
    people: people.data?.people ?? [],
    tags: tags.data?.tags ?? [],
    lostReasons: reasons.data?.lostReasons ?? [],
    products: products.data?.products ?? [],
    currency: settings.data?.currency ?? "AED",
  };
  const filters = parseFilters(search, catalog);
  const first = await apiGet<LeadPage>(`/api/v1/leads?${apiQuery(filters)}&limit=50`);
  return { catalog, filters, first: first.data, contactsVisible: seesFullContacts(session.actor) };
}
```

`apps/web/src/components/leads/CatalogProvider.tsx`:
```tsx
"use client";
import { createContext, useContext, type ReactNode } from "react";
import type { Catalog } from "@/lib/leads/types";

const Ctx = createContext<Catalog | null>(null);
export function CatalogProvider({ catalog, children }: { catalog: Catalog; children: ReactNode }) {
  return <Ctx.Provider value={catalog}>{children}</Ctx.Provider>;
}
export function useCatalog(): Catalog {
  const c = useContext(Ctx);
  if (!c) throw new Error("useCatalog outside CatalogProvider");
  return c;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `scripts/dev.sh run pnpm vitest run apps/web/src/lib`
Expected: filters (4), format (3), columns (3), client (2) green, with the existing lib tests still passing.

- [ ] **Step 5: Strict gate, commit, push**

```bash
bash "$SCRATCH/gate.sh" && git add -A && git commit -m "feat(web): leads data layer — typed client with If-Match, URL filters that survive bad links, formatting and column rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git push origin main
```

---

### Task 3: The leads table — filters in the URL, chosen columns, sort, paging, every state

**Files:**
- Modify: `apps/web/src/app/(app)/leads/page.tsx`
- Create: `apps/web/src/components/leads/{LeadsScreen,FilterBar,LeadsTable,ColumnPicker,cells}.tsx`, `leads.module.css`, `LeadsScreen.test.tsx`, `apps/web/src/components/ui/Popover.tsx` (+ `Popover.module.css`)

**Interfaces:**
- Consumes: Task 2 (`loadLeadsPage`, `leadsClient`, `parseFilters`, `filtersToParams`, `activeFilterCount`, `availableColumns`, `resolveColumns`, `load/saveColumnChoice`, `CatalogProvider`, `useCatalog`, formatters); `Session` (`requireSession`), `can` from `@lume/core/shared`.
- Produces:
  - `<LeadsScreen session catalog contactsVisible initialFilters first />` which owns the list state and opens `<LeadDrawer>` (Task 5) from `?lead=`
  - `<FilterBar session filters onChange contactsVisible hideStage? />`
  - `<Popover trigger label>` (anchored to its trigger, closes on Escape and outside click, returns focus), reused by Tasks 4–8
  - `useLeadList(filters)` inside `LeadsScreen.tsx`: `{ rows, loading, error, hasMore, loadMore, replace(lead), removeRow(id), reload() }`
  - Test hooks: `data-testid="lead-row"` on each row, `data-lead-id` on rows

- [ ] **Step 1: Write the failing tests**

`apps/web/src/components/leads/LeadsScreen.test.tsx` (Next's router is mocked; `leadsClient` is mocked module-wide):
```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leadsClient } from "@/lib/leads/client";
import { EMPTY_FILTERS } from "@/lib/leads/filters";
import { testCatalog, testLead } from "@/lib/leads/test-catalog";
import { fakeSession } from "@/server/session";
import { LeadsScreen } from "./LeadsScreen";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/leads",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/leads/client", () => ({ leadsClient: { list: vi.fn(), get: vi.fn() }, PAGE_SIZE: 50 }));

const lead = testLead;

const rep = () => fakeSession({ permissions: [{ key: "leads.view", scope: "own" }, { key: "leads.edit", scope: "own" }] });
const admin = () =>
  fakeSession({
    permissions: [
      { key: "leads.view", scope: "all" }, { key: "leads.create", scope: null }, { key: "leads.contact.full", scope: "all" },
      { key: "leads.bulk_edit", scope: "all" },
    ],
  });

beforeEach(() => {
  vi.mocked(leadsClient.list).mockReset();
  replace.mockReset();
  localStorage.clear();
});

const view = (props: Partial<Parameters<typeof LeadsScreen>[0]> = {}) =>
  render(
    <LeadsScreen
      session={rep()}
      catalog={testCatalog()}
      contactsVisible={false}
      initialFilters={EMPTY_FILTERS}
      first={{ items: [lead()], nextCursor: null }}
      {...props}
    />,
  );

describe("LeadsScreen", () => {
  it("shows the first page straight away, with a masked role's table carrying no contact column at all", () => {
    view();
    expect(screen.getByRole("button", { name: "Open Aisha Khan" })).toBeInTheDocument();
    const header = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(header).toEqual(expect.arrayContaining(["Name", "Stage", "Owner"]));
    expect(header.join(" ")).not.toMatch(/Phone|Email|Instagram/);
    expect(screen.queryByRole("button", { name: /export/i })).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox")).toHaveAttribute("placeholder", "Search by name");
  });

  it("gives a full-contact role the phone column and contact search", () => {
    view({ session: admin(), contactsVisible: true, first: { items: [lead({ contactMasked: false, phone: { display: "+971 50 123 4567", masked: false } })], nextCursor: null } });
    expect(screen.getByRole("columnheader", { name: "Phone" })).toBeInTheDocument();
    expect(screen.getByText("+971 50 123 4567")).toBeInTheDocument();
    expect(screen.getByRole("searchbox")).toHaveAttribute("placeholder", "Search name, phone or email");
  });

  it("puts a filter into the address bar and fetches the matching page", async () => {
    vi.mocked(leadsClient.list).mockResolvedValue({ ok: true, status: 200, data: { items: [], nextCursor: null } });
    view();
    await userEvent.type(screen.getByRole("searchbox"), "zz");
    await vi.waitFor(() => expect(leadsClient.list).toHaveBeenCalledWith(expect.objectContaining({ q: "zz" }), undefined));
    expect(replace).toHaveBeenLastCalledWith("/leads?q=zz", { scroll: false });
    expect(await screen.findByText("Nothing matches these filters")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(replace).toHaveBeenLastCalledWith("/leads", { scroll: false });
  });

  it("says so when there are no leads at all, and offers to create one only to those who may", () => {
    view({ first: { items: [], nextCursor: null } });
    expect(screen.getByText("No leads yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New lead" })).not.toBeInTheDocument();
    view({ session: admin(), first: { items: [], nextCursor: null } });
    expect(screen.getAllByRole("button", { name: "New lead" }).length).toBeGreaterThan(0);
  });

  it("loads the next page when asked, and keeps what it had", async () => {
    vi.mocked(leadsClient.list).mockResolvedValue({ ok: true, status: 200, data: { items: [lead({ id: "l2", name: "Riya's lead" })], nextCursor: null } });
    view({ first: { items: [lead()], nextCursor: "c1" } });
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(leadsClient.list).toHaveBeenCalledWith(expect.anything(), "c1");
    expect(await screen.findByRole("button", { name: "Open Riya's lead" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Aisha Khan" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("explains a failed load and retries", async () => {
    vi.mocked(leadsClient.list)
      .mockResolvedValueOnce({ ok: false, status: 0, code: "OFFLINE", message: "offline" })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { items: [lead()], nextCursor: null } });
    view();
    await userEvent.type(screen.getByRole("searchbox"), "a");
    expect(await screen.findByText(/can’t load leads/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Open Aisha Khan" })).toBeInTheDocument();
  });

  it("ignores a slow answer to an old search once a newer one has arrived", async () => {
    let first!: (v: unknown) => void;
    vi.mocked(leadsClient.list)
      .mockImplementationOnce(() => new Promise((r) => (first = r)) as never)
      .mockResolvedValueOnce({ ok: true, status: 200, data: { items: [lead({ id: "new", name: "Newer answer" })], nextCursor: null } });
    view();
    await userEvent.type(screen.getByRole("searchbox"), "a");
    await vi.waitFor(() => expect(leadsClient.list).toHaveBeenCalledTimes(1));
    await userEvent.type(screen.getByRole("searchbox"), "b");
    expect(await screen.findByRole("button", { name: "Open Newer answer" })).toBeInTheDocument();
    first({ ok: true, status: 200, data: { items: [lead({ id: "old", name: "Stale answer" })], nextCursor: null } });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("Stale answer")).not.toBeInTheDocument();
  });

  it("lets a person choose and reorder columns, and remembers it", async () => {
    view({ session: admin(), contactsVisible: true });
    await userEvent.click(screen.getByRole("button", { name: "Columns" }));
    const menu = screen.getByRole("dialog", { name: "Columns" });
    await userEvent.click(within(menu).getByRole("checkbox", { name: "Email" }));
    await userEvent.click(within(menu).getByRole("button", { name: "Move Email up" }));
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers.indexOf("Email")).toBeLessThan(headers.indexOf("Last activity"));
    expect(JSON.parse(localStorage.getItem(`lume.leads.columns.${admin().user.id}`)!)).toContain("email");
  });
});
```
(`LeadDrawer` doesn't exist until Task 5. In this task `LeadsScreen` renders nothing for `?lead=`; Task 5 adds the drawer and its tests.)

- [ ] **Step 2: Run to verify it fails**

Run: `scripts/dev.sh run pnpm vitest run apps/web/src/components/leads`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`apps/web/src/app/(app)/leads/page.tsx`:
```tsx
import { LeadsScreen } from "@/components/leads/LeadsScreen";
import { loadLeadsPage } from "@/server/leads";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Leads · LUME" };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[]>> }) {
  const session = await requirePermission("leads.view");
  const raw = await searchParams;
  const params = new URLSearchParams(Object.entries(raw).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]])));
  const { catalog, filters, first, contactsVisible } = await loadLeadsPage(session, params);
  return <LeadsScreen session={session} catalog={catalog} contactsVisible={contactsVisible} initialFilters={filters} first={first} />;
}
```

`LeadsScreen.tsx` owns list state. Its core is the list hook, written so a stale response can never win:
```tsx
function useLeadList(filters: ListFilters, first: LeadPage | null) {
  const [rows, setRows] = useState<Lead[]>(first?.items ?? []);
  const [cursor, setCursor] = useState<string | null>(first?.nextCursor ?? null);
  const [loading, setLoading] = useState(first === null);
  const [error, setError] = useState<string | null>(first === null ? "load" : null);
  const generation = useRef(0); // every new filter set bumps this; answers for older ones are dropped
  const firstRender = useRef(true);

  const fetchPage = useCallback(async (after?: string) => {
    const gen = after ? generation.current : ++generation.current;
    setLoading(true);
    setError(null);
    const r = await leadsClient.list(filters, after);
    if (gen !== generation.current) return;
    setLoading(false);
    if (!r.ok) return setError(r.code === "OFFLINE" ? "offline" : "load");
    setRows((prev) => (after ? [...prev, ...r.data.items.filter((x) => !prev.some((p) => p.id === x.id))] : r.data.items));
    setCursor(r.data.nextCursor);
  }, [filters]);

  useEffect(() => {
    if (firstRender.current && first) return void (firstRender.current = false); // the server already sent page one
    firstRender.current = false;
    const t = setTimeout(() => void fetchPage(), filters.q ? 250 : 0); // typing waits a beat
    return () => clearTimeout(t);
  }, [fetchPage, filters, first]);

  return {
    rows, loading, error, hasMore: cursor !== null,
    loadMore: () => cursor && !loading && void fetchPage(cursor),
    reload: () => void fetchPage(),
    replace: (lead: Lead) => setRows((prev) => prev.map((x) => (x.id === lead.id ? lead : x))),
    removeRow: (id: string) => setRows((prev) => prev.filter((x) => x.id !== id)),
    prepend: (lead: Lead) => setRows((prev) => [lead, ...prev.filter((x) => x.id !== lead.id)]),
  };
}
```
The screen keeps `filters` in state (initialised from `initialFilters`). Every change calls `router.replace(pathname + (qs ? "?" + qs : ""), { scroll: false })` with `filtersToParams(next)`, keeping `?lead=` when a drawer is open. The layout top to bottom:

1. A toolbar: `FilterBar` (search, Stage, Owner, Tag, Phone, Enquiry dates, "Clear · n"), then on the right a sort `select` (Newest, Oldest, Last activity, Name), the `ColumnPicker`, the Table/Board `SegmentedControl` (links to `/leads` and `/pipeline` with the same filters), and **New lead** (only if `can(session.actor, "leads.create")`; wired in Task 6).
2. The table.
3. A "Load more" button with an `IntersectionObserver` sentinel above it that calls `loadMore` when it scrolls into view. The button stays for keyboard and screen-reader users.

States:
- **Loading with no rows:** 8 skeleton rows (`Skeleton` in each cell), `aria-busy="true"` on the table.
- **Loading with rows:** the rows stay, dimmed to 0.6 with `aria-busy="true"`.
- **Error:** `ErrorState` with the title "LUME can’t load leads right now", the detail "Check your connection, then try again.", and a **Try again** button calling `reload`.
- **No rows and `activeFilterCount(filters) === 0`:** `EmptyState` with the title "No leads yet", the body "New leads from your forms, or ones you add, will appear here.", and **New lead** when allowed.
- **No rows with filters:** `EmptyState` with the title "Nothing matches these filters", the body "Try fewer filters, or clear them.", and **Clear filters**.

`FilterBar.tsx`:
- **Search:** `type="search"`. The placeholder is `contactsVisible ? "Search name, phone or email" : "Search by name"`, maxLength 100, and `/` focuses it when focus isn't in an input.
- **Stage:** a `Popover` with a checkbox per stage of the current pipeline (the default one when none is chosen), each showing its colour dot.
- **Owner:** a `select` with "Anyone", "Me", then "Unassigned" (only when `scopeOf(actor, "leads.view") === "all"`: a narrower scope can never see unassigned leads, report §7.1), then active people by name. Omitted when the caller's view scope is `own`, where every visible lead is theirs.
- **Tag:** a `select` over `catalog.tags`, omitted when there are none.
- **Phone:** a `select` (Any, Valid, Needs country, Invalid, Missing), shown only when the phone field isn't hidden from the caller.
- **Enquiry date:** two `input type="date"` in a Popover.
- **More filters:** a Popover with one control per custom field the caller can see whose type the API can filter (`select`, `multi_select`, `boolean`, `user`). It is kept in `ListFilters.custom: Record<string, string | boolean>`, in the URL as `cf.<key>=<value>` (unknown keys and options are dropped by `parseFilters`, like any other filter), and sent as `custom=<JSON>`. Add `custom` to `ListFilters`, `parseFilters`, `filtersToParams`, `apiQuery` and `activeFilterCount` in this task, with a test in `filters.test.ts`: a `cf.struggles=o1` round-trips, and `cf.struggles=deleted-option` is dropped.
- **`hideStage` prop:** leaves out the Stage control (the board, where columns are the stages).
- **Clear · n:** shown when `activeFilterCount > 0`.

Every control has a visible or `aria-label` label.

`LeadsTable.tsx` renders a real `<table>`: a sticky header, `<th scope="col">` for each chosen column (sortable ones are buttons that set the sort and show ▲/▼ with `aria-sort`), and one `<tr data-testid="lead-row" data-lead-id>` per lead. The Name cell holds `<button className={s.open} aria-label={"Open " + name}>` with the `Avatar` and name; clicking anywhere on the row opens it too (except on interactive children). Cells come from `cells.tsx`:
- `StagePill`: the dot in the stage colour plus the name, the prototype's `.stg`.
- `OwnerCell`: avatar and name, or "Unassigned" in `--text-3`.
- `ContactCell`: tabular numbers; when masked, a small lock icon with `title="Masked for your role"`.
- `ValueCell`: `formatMoney`, right-aligned.
- `TagsCell`: up to 2 `Chip`s, then "+n".
- `DateCell`: `relativeTime`, with `title` holding the full date.
- A custom field cell: `fieldText`.

Row styling follows the prototype `.lrow`: 50px rows, hover `--hover`, and the open lead's row in `--accent-soft`. The table scrolls sideways inside its sheet with the app's blended scrollbars, and the header stays put.

`ColumnPicker.tsx` is a `Popover` (`role="dialog"`, `aria-label="Columns"`). It shows a checkbox for every `availableColumns(catalog, contactsVisible)` entry except Name, which is always on, and **Move X up** / **Move X down** icon buttons. Changes apply at once and are saved with `saveColumnChoice(session.user.id, ids)`. A "Reset" link restores `DEFAULT_COLUMNS`.

`Popover.tsx`: a trigger button (`aria-expanded`, `aria-controls`) and a panel positioned under the trigger (flipped above near the bottom edge). The panel is glass with `--shadow-pop` and scales in from its trigger (`transform-origin` at the trigger, spring). Escape and outside pointerdown close it and return focus to the trigger. On open, focus goes to the first focusable element in the panel.

`leads.module.css` carries the prototype's sizes: `.toolbar` (gap 8px, wraps under 900px), `.table` (`border-collapse: separate; border-spacing: 0`), `th` (sticky top 0, background `--sheet`, 11.5px 620-weight `--text-3`, a 0.5px bottom line), `tr` (50px), `.stg` pill, the dimmed-while-loading row state, and phone-width rules (under 720px only Name, Stage and Owner remain and the toolbar collapses into a Filters popover).

- [ ] **Step 4: Run to verify it passes**

Run: `scripts/dev.sh run pnpm vitest run apps/web/src/components/leads apps/web/src/lib/leads`
Expected: LeadsScreen (8) green.

- [ ] **Step 5: Strict gate, commit, push**

```bash
bash "$SCRATCH/gate.sh" && git add -A && git commit -m "feat(web): leads table — URL filters, chosen and reordered columns, sort, cursor paging, masked roles see no contact column

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git push origin main
```

---

### Task 4: Inline edit — field editors per type, field access, and no lost edits

**Files:**
- Create: `apps/web/src/components/leads/fields/{FieldValue,FieldEditor}.tsx`, `fields/fields.module.css`, `fields/FieldEditor.test.tsx`, `apps/web/src/components/leads/useLeadEditor.ts`, `useLeadEditor.test.ts`
- Modify: `apps/web/src/components/leads/LeadsTable.tsx` (editable cells)

**Interfaces:**
- Consumes: `leadsClient.patch/get`, `useCatalog`, `fieldText`, `useToast`.
- Produces:
  - `<FieldValue lead def />`: read-only display for any field
  - `<FieldEditor def value onCommit(value) onCancel autoFocus />` for every `FieldType`
  - `patchFor(def: FieldDefView, value: unknown): Record<string, unknown>`: the PATCH body for one field (core keys at the top level, custom under `custom`, `null` to clear)
  - `useLeadEditor(onUpdated: (lead: Lead) => void)` → `{ save(lead, def, value): Promise<"ok" | "conflict" | "invalid" | "failed">; saving: string | null; error: { leadId; key; message } | null }`
  - `editable(lead, def)`: `lead.can.edit && def.access === "edit" && !def.archived`, plus contact fields only when `!lead.contactMasked`

- [ ] **Step 1: Write the failing tests**

`apps/web/src/components/leads/useLeadEditor.test.ts`:
```ts
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leadsClient } from "@/lib/leads/client";
import { testCatalog, testLead as lead } from "@/lib/leads/test-catalog";
import { editable, patchFor, useLeadEditor } from "./useLeadEditor";

vi.mock("@/lib/leads/client", () => ({ leadsClient: { patch: vi.fn(), get: vi.fn() } }));
const toast = vi.fn();
vi.mock("@/components/feedback/ToastProvider", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));
const cat = testCatalog();
const field = (key: string) => cat.fields.find((f) => f.key === key)!;

beforeEach(() => {
  vi.mocked(leadsClient.patch).mockReset();
  vi.mocked(leadsClient.get).mockReset();
  toast.mockReset();
});

describe("patchFor", () => {
  it("puts core fields at the top level and custom fields under custom, with null clearing", () => {
    expect(patchFor(field("name"), "Aisha K")).toEqual({ name: "Aisha K" });
    expect(patchFor(field("value"), 5000)).toEqual({ value: 5000 });
    expect(patchFor(field("struggles"), ["o1"])).toEqual({ custom: { struggles: ["o1"] } });
    expect(patchFor(field("struggles"), [])).toEqual({ custom: { struggles: null } });
    expect(patchFor(field("email"), "")).toEqual({ email: null });
  });
});

describe("editable", () => {
  it("needs the lead's edit right, edit access to the field, and a visible contact for contact fields", () => {
    expect(editable(lead(), field("name"))).toBe(true);
    expect(editable(lead({ can: { ...lead().can, edit: false } }), field("name"))).toBe(false);
    expect(editable(lead(), { ...field("name"), access: "view" })).toBe(false);
    expect(editable(lead({ contactMasked: true }), field("phone"))).toBe(false);
    expect(editable(lead({ contactMasked: false }), field("phone"))).toBe(true);
  });
});

describe("useLeadEditor", () => {
  it("saves with the version it saw and hands back the new lead", async () => {
    const onUpdated = vi.fn();
    vi.mocked(leadsClient.patch).mockResolvedValue({ ok: true, status: 200, data: { lead: lead({ name: "Aisha K", version: 2 }) } });
    const { result } = renderHook(() => useLeadEditor(onUpdated));
    await act(async () => expect(await result.current.save(lead(), field("name"), "Aisha K")).toBe("ok"));
    expect(leadsClient.patch).toHaveBeenCalledWith("l1", 1, { name: "Aisha K" });
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ name: "Aisha K", version: 2 }));
  });

  it("never overwrites someone else's change: reloads the lead and says so", async () => {
    const onUpdated = vi.fn();
    vi.mocked(leadsClient.patch).mockResolvedValue({ ok: false, status: 409, code: "VERSION_CONFLICT", message: "x" });
    vi.mocked(leadsClient.get).mockResolvedValue({ ok: true, status: 200, data: { lead: lead({ name: "Aisha (by Tasneem)", version: 5 }) } });
    const { result } = renderHook(() => useLeadEditor(onUpdated));
    await act(async () => expect(await result.current.save(lead(), field("name"), "Mine")).toBe("conflict"));
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ name: "Aisha (by Tasneem)", version: 5 }));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/changed by someone else/i) }));
  });

  it("keeps the editor open with the reason when the value is refused", async () => {
    vi.mocked(leadsClient.patch).mockResolvedValue({
      ok: false, status: 400, code: "VALIDATION", message: "Enter a valid email",
      details: { issues: [{ path: ["email"], message: "Invalid email" }] },
    });
    const { result } = renderHook(() => useLeadEditor(vi.fn()));
    await act(async () => expect(await result.current.save(lead(), field("email"), "nope")).toBe("invalid"));
    expect(result.current.error).toEqual({ leadId: "l1", key: "email", message: "Enter a valid email" });
  });
});
```

`apps/web/src/components/leads/fields/FieldEditor.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { testCatalog } from "@/lib/leads/test-catalog";
import { CatalogProvider } from "../CatalogProvider";
import { FieldEditor } from "./FieldEditor";

const cat = testCatalog();
const def = (key: string) => cat.fields.find((f) => f.key === key)!;
const edit = (key: string, value: unknown) => {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  render(
    <CatalogProvider catalog={cat}>
      <FieldEditor def={def(key)} value={value} onCommit={onCommit} onCancel={onCancel} autoFocus />
    </CatalogProvider>,
  );
  return { onCommit, onCancel };
};

describe("FieldEditor", () => {
  it("commits text on Enter and cancels on Escape without saving", async () => {
    const a = edit("name", "Aisha");
    await userEvent.clear(screen.getByRole("textbox", { name: "Name" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "Aisha K{Enter}");
    expect(a.onCommit).toHaveBeenCalledWith("Aisha K");
    const b = edit("name", "Aisha");
    await userEvent.type(screen.getAllByRole("textbox", { name: "Name" }).at(-1)!, "zz{Escape}");
    expect(b.onCancel).toHaveBeenCalled();
    expect(b.onCommit).not.toHaveBeenCalled();
  });

  it("edits money as a number, refusing text", async () => {
    const a = edit("value", 4500);
    const box = screen.getByRole("textbox", { name: "Deal value" });
    await userEvent.clear(box);
    await userEvent.type(box, "4,750.50{Enter}");
    expect(a.onCommit).toHaveBeenCalledWith(4750.5);
    const b = edit("value", 4500);
    const box2 = screen.getAllByRole("textbox", { name: "Deal value" }).at(-1)!;
    await userEvent.clear(box2);
    await userEvent.type(box2, "lots{Enter}");
    expect(b.onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/number/i);
  });

  it("picks several options and commits them as ids", async () => {
    const a = edit("struggles", []);
    await userEvent.click(screen.getByRole("checkbox", { name: "Confidence" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Career switch" }));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(a.onCommit).toHaveBeenCalledWith(["o1", "o2"]);
  });

  it("offers only active people for a person field", async () => {
    render(
      <CatalogProvider catalog={{ ...cat, people: [...cat.people, { id: "u-old", name: "Old Rep", active: false }] }}>
        <FieldEditor def={def("handled_by")} value={null} onCommit={vi.fn()} onCancel={vi.fn()} />
      </CatalogProvider>,
    );
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toContain("Riya Sharma");
    expect(options).not.toContain("Old Rep");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `scripts/dev.sh run pnpm vitest run apps/web/src/components/leads`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`useLeadEditor.ts`:
```ts
"use client";
import { useCallback, useState } from "react";
import { useToast } from "@/components/feedback/ToastProvider";
import { leadsClient } from "@/lib/leads/client";
import type { FieldDefView, Lead } from "@/lib/leads/types";

const CORE_KEYS: Record<string, string> = { name: "name", phone: "phone", email: "email", instagram: "instagram", value: "value", lead_created_at: "leadCreatedAt", product: "productId" };
const CONTACT = new Set(["phone", "email", "instagram"]);
const empty = (v: unknown) => v === "" || v === undefined || v === null || (Array.isArray(v) && v.length === 0);

export function patchFor(def: FieldDefView, value: unknown): Record<string, unknown> {
  const v = empty(value) ? null : value;
  const core = CORE_KEYS[def.key];
  return core && def.isCore ? { [core]: v } : { custom: { [def.key]: v } };
}

export const editable = (lead: Lead, def: FieldDefView): boolean =>
  lead.can.edit && def.access === "edit" && !def.archived && !(CONTACT.has(def.key) && lead.contactMasked);

type Outcome = "ok" | "conflict" | "invalid" | "failed";

/** Saves one field at a time with If-Match, so two people editing the same lead can never lose work. */
export function useLeadEditor(onUpdated: (lead: Lead) => void) {
  const { toast } = useToast();
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<{ leadId: string; key: string; message: string } | null>(null);

  const save = useCallback(async (lead: Lead, def: FieldDefView, value: unknown): Promise<Outcome> => {
    setSaving(`${lead.id}:${def.key}`);
    setError(null);
    const r = await leadsClient.patch(lead.id, lead.version, patchFor(def, value));
    setSaving(null);
    if (r.ok) {
      onUpdated(r.data.lead);
      return "ok";
    }
    if (r.status === 409) {
      const fresh = await leadsClient.get(lead.id);
      if (fresh.ok) onUpdated(fresh.data.lead);
      toast({ tone: "warn", title: `${lead.name ?? "This lead"} was changed by someone else`, detail: "Showing the latest. Make your change again if it's still needed." });
      return "conflict";
    }
    if (r.status === 400 || r.status === 422) {
      setError({ leadId: lead.id, key: def.key, message: r.message });
      return "invalid";
    }
    toast({ tone: "danger", title: "That change didn't save", detail: r.message });
    return "failed";
  }, [onUpdated, toast]);

  return { save, saving, error, clearError: () => setError(null) };
}
```

`FieldEditor.tsx` renders one control per `def.type`, and every control carries `aria-label={def.label}`:
- **`text`, `url`, `instagram`, `email`, `phone`:** `<input>` with the matching `type` (`url`, `email`, `tel`) and `inputMode`; commits the trimmed value on Enter or blur.
- **`long_text`:** `<textarea>`; ⌘/Ctrl+Enter commits and Enter adds a line.
- **`number`, `currency`:** a text input with `inputMode="decimal"`. On commit it strips `,` and spaces, parses with `Number`, and shows `role="alert"` "Enter a number" when the result is `NaN`. `currency` also refuses negatives and more than 2 decimals.
- **`date`:** `<input type="date">`. **`datetime`:** `<input type="datetime-local">`, converted to ISO with the browser's offset.
- **`boolean`:** a `Switch` that commits immediately.
- **`select`:** `<select>` with an empty "—" option and the live (non-archived) options; commits on change.
- **`multi_select`:** a checkbox list of the live options plus a **Done** button that commits the ids in option order.
- **`user`:** `<select>` over `catalog.people.filter((p) => p.active)`, plus "Nobody".

Escape always calls `onCancel`. A blur caused by clicking inside the editor never commits.

`FieldValue.tsx`: `fieldText(value, def, catalog)` for every type. Contact fields show `lead[key].display`; `select`/`multi_select` show `Chip`s coloured by the option's `color`; empty values show "—" in `--text-3`.

In `LeadsTable.tsx`, an editable cell shows a subtle pencil on hover. Enter or double-click swaps in a `FieldEditor` sized to the cell. Commit calls `save`; a `"ok"` or `"conflict"` result closes the editor, `"invalid"` keeps it open with `error.message` under it (`role="alert"`), and `"failed"` closes it with the toast. Focus returns to the cell. The row updates through `replace(lead)` from `useLeadList`.

- [ ] **Step 4: Run to verify they pass**

Run: `scripts/dev.sh run pnpm vitest run apps/web/src/components/leads`
Expected: useLeadEditor (4), FieldEditor (4), LeadsScreen (8) green.

- [ ] **Step 5: Strict gate, commit, push**

```bash
bash "$SCRATCH/gate.sh" && git add -A && git commit -m "feat(web): inline edit in the leads table — an editor per field type, field access respected, concurrent changes never overwritten

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git push origin main
```

---

### Task 5: The lead drawer — stage track, Reveal, WhatsApp hand-off, won/lost, assign, notes and history

**Files:**
- Create: `apps/web/src/components/leads/drawer/{LeadDrawer,StageTrack,ContactBox,Timeline,OutcomePopover,AssignMenu,MessageButton,PetalBurst}.tsx`, `drawer/drawer.module.css`, `drawer/LeadDrawer.test.tsx`, `apps/web/src/components/leads/useStageMove.tsx`, `useStageMove.test.tsx`, `apps/web/src/lib/leads/history.ts`, `history.test.ts`
- Modify: `LeadsScreen.tsx` (open the drawer from `?lead=`; J/K through the loaded rows; update or remove rows)

**Interfaces:**
- Consumes: Task 2 client and types, Task 4 `FieldEditor`, `useLeadEditor`, `editable`, `patchFor`; `useSound`, `useToast`; `scopeOf` from `@lume/core/shared`.
- Produces:
  - `useStageMove()` → `{ request(lead: Lead, stage: Stage): Promise<Lead | null>; ui: ReactNode }`. It resolves the moved lead, or `null` if the person cancelled or the move was refused (so the board can put a card back). It asks for the lost reason for a `lost` stage, and for missing required fields on `422 REQUIRED_FIELDS`, then retries once.
  - `<LeadDrawer id neighbours onClose onStep onChanged onGone />`, where `neighbours: string[]` holds the ids in list order for J/K, `onChanged(lead)` updates the row, and `onGone(id, reason)` removes it
  - `describeActivity(a: Activity, cat: Catalog): { title: string; detail?: string; tone: string; quote?: string }`

- [ ] **Step 1: Write the failing tests**

`apps/web/src/lib/leads/history.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { describeActivity } from "./history";
import { testCatalog } from "./test-catalog";

const cat = testCatalog();
const a = (type: string, payload: Record<string, unknown> = {}) => ({ id: "a", type, payload, occurredAt: "2026-09-24T10:00:00Z", user: { id: "u-tas", name: "Tasneem Shaikh" } });

describe("describeActivity", () => {
  it("tells each kind of event in plain words, with who did it", () => {
    expect(describeActivity(a("stage_changed", { from: "s-new", to: "s-sent" }), cat)).toMatchObject({ title: "Moved to Message sent", detail: "by Tasneem Shaikh" });
    expect(describeActivity(a("stage_changed", { to: "s-lost", lostReasonId: "r-price" }), cat)).toMatchObject({ title: "Marked as lost", detail: "Price · by Tasneem Shaikh", tone: "danger" });
    expect(describeActivity(a("assigned", { from: "u-riya", to: "u-tas" }), cat).title).toBe("Handed to Tasneem Shaikh");
    expect(describeActivity(a("assigned", { from: "u-riya", to: null }), cat).title).toBe("Unassigned");
    expect(describeActivity(a("contact_revealed"), cat).title).toBe("Contact revealed");
    expect(describeActivity(a("whatsapp_opened", { text: "Hi Aisha" }), cat)).toMatchObject({ title: "WhatsApp opened", quote: "Hi Aisha" });
    expect(describeActivity(a("whatsapp_confirmed_sent"), cat).title).toBe("WhatsApp sent");
    expect(describeActivity(a("field_changed", { fields: ["name", "custom.struggles"] }), cat).title).toBe("Edited Name, Struggles");
    expect(describeActivity(a("lead_created", { source: "manual" }), cat).title).toBe("Lead added");
  });

  it("never throws on an event type it doesn't know yet", () => {
    expect(describeActivity(a("something_new"), cat).title).toBe("Updated");
  });
});
```

`apps/web/src/components/leads/useStageMove.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leadsClient } from "@/lib/leads/client";
import { testCatalog, testLead } from "@/lib/leads/test-catalog";
import type { Lead } from "@/lib/leads/types";
import { CatalogProvider } from "./CatalogProvider";
import { useStageMove } from "./useStageMove";

vi.mock("@/lib/leads/client", () => ({ leadsClient: { move: vi.fn(), patch: vi.fn() } }));
const cat = testCatalog();
const stage = (id: string) => cat.pipelines[0]!.stages.find((s) => s.id === id)!;

function Harness({ target, onResult }: { target: string; onResult: (l: Lead | null) => void }) {
  const { request, ui } = useStageMove();
  const [lead] = useState(testLead());
  return (
    <>
      <button onClick={async () => onResult(await request(lead, stage(target)))}>go</button>
      {ui}
    </>
  );
}
const run = (target: string) => {
  const onResult = vi.fn();
  render(<CatalogProvider catalog={cat}><Harness target={target} onResult={onResult} /></CatalogProvider>);
  return onResult;
};

beforeEach(() => {
  vi.mocked(leadsClient.move).mockReset();
  vi.mocked(leadsClient.patch).mockReset();
});

describe("useStageMove", () => {
  it("moves straight away when nothing is needed", async () => {
    vi.mocked(leadsClient.move).mockResolvedValue({ ok: true, status: 200, data: { lead: testLead({ stageId: "s-sent" }) } });
    const onResult = run("s-sent");
    await userEvent.click(screen.getByRole("button", { name: "go" }));
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ stageId: "s-sent" })));
  });

  it("asks why before moving to Lost, and cancelling changes nothing", async () => {
    const onResult = run("s-lost");
    await userEvent.click(screen.getByRole("button", { name: "go" }));
    const dialog = await screen.findByRole("dialog", { name: /why was aisha lost/i });
    expect(dialog).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onResult).toHaveBeenCalledWith(null);
    expect(leadsClient.move).not.toHaveBeenCalled();
  });

  it("sends the chosen reason and note", async () => {
    vi.mocked(leadsClient.move).mockResolvedValue({ ok: true, status: 200, data: { lead: testLead({ stageId: "s-lost" }) } });
    run("s-lost");
    await userEvent.click(screen.getByRole("button", { name: "go" }));
    await userEvent.click(await screen.findByRole("radio", { name: "Price" }));
    await userEvent.type(screen.getByLabelText("Note (optional)"), "Budget next quarter");
    await userEvent.click(screen.getByRole("button", { name: "Mark as lost" }));
    expect(leadsClient.move).toHaveBeenCalledWith("l1", "s-lost", { lostReasonId: "r-price", lostNote: "Budget next quarter" });
  });

  it("asks for missing required fields, saves them, then moves", async () => {
    vi.mocked(leadsClient.move)
      .mockResolvedValueOnce({ ok: false, status: 422, code: "REQUIRED_FIELDS", message: "Fill these in", details: { fields: ["struggles"] } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { lead: testLead({ stageId: "s-booked" }) } });
    vi.mocked(leadsClient.patch).mockResolvedValue({ ok: true, status: 200, data: { lead: testLead({ version: 2, custom: { struggles: ["o1"] } }) } });
    const onResult = run("s-booked");
    await userEvent.click(screen.getByRole("button", { name: "go" }));
    const dialog = await screen.findByRole("dialog", { name: /before moving to call booked/i });
    await userEvent.click(screen.getByRole("checkbox", { name: "Confidence" }));
    await userEvent.click(screen.getByRole("button", { name: "Save and move" }));
    expect(leadsClient.patch).toHaveBeenCalledWith("l1", 1, { custom: { struggles: ["o1"] } });
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ stageId: "s-booked" })));
    expect(dialog).not.toBeInTheDocument();
  });

  it("resolves null with the reason when the move is refused", async () => {
    vi.mocked(leadsClient.move).mockResolvedValue({ ok: false, status: 403, code: "FORBIDDEN", message: "You can't do that" });
    const onResult = run("s-sent");
    await userEvent.click(screen.getByRole("button", { name: "go" }));
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith(null));
  });
});
```

`apps/web/src/components/leads/drawer/LeadDrawer.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leadsClient } from "@/lib/leads/client";
import { testCatalog, testLead } from "@/lib/leads/test-catalog";
import type { Lead } from "@/lib/leads/types";
import { fakeSession } from "@/server/session";
import { CatalogProvider } from "../CatalogProvider";
import { LeadDrawer } from "./LeadDrawer";

vi.mock("@/lib/leads/client", () => ({
  leadsClient: {
    get: vi.fn(), activities: vi.fn(), reveal: vi.fn(), move: vi.fn(), patch: vi.fn(), assign: vi.fn(),
    note: vi.fn(), prepareMessage: vi.fn(), confirmMessage: vi.fn(), remove: vi.fn(),
  },
}));
const play = vi.fn();
vi.mock("@/components/feedback/SoundProvider", () => ({ useSound: () => ({ play, enabled: true, setEnabled: vi.fn(), volume: 60, setVolume: vi.fn() }) }));
const toast = vi.fn();
vi.mock("@/components/feedback/ToastProvider", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const handlers = () => ({ onClose: vi.fn(), onStep: vi.fn(), onChanged: vi.fn(), onGone: vi.fn() });
const open = (lead: Lead = testLead(), session = fakeSession({ permissions: [{ key: "leads.view", scope: "own" }] })) => {
  vi.mocked(leadsClient.get).mockResolvedValue(ok({ lead }));
  vi.mocked(leadsClient.activities).mockResolvedValue(ok({ items: [], nextCursor: null }));
  const h = handlers();
  render(
    <CatalogProvider catalog={testCatalog()}>
      <LeadDrawer id={lead.id} session={session} neighbours={["l0", lead.id, "l2"]} {...h} />
    </CatalogProvider>,
  );
  return h;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("LeadDrawer", () => {
  it("opens as a labelled dialog with the stage track and the lead's place in the list", async () => {
    open();
    const dialog = await screen.findByRole("dialog", { name: "Aisha Khan" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^New/ })).toHaveAttribute("aria-current", "step");
  });

  it("reveals a masked contact on request and says plainly that it was recorded", async () => {
    vi.mocked(leadsClient.reveal).mockResolvedValue(ok({ phone: "+971 50 123 4567", email: null, instagram: null }));
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Reveal contact" }));
    expect(await screen.findByText("+971 50 123 4567")).toBeInTheDocument();
    expect(screen.getByText(/recorded in the audit log/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reveal contact" })).not.toBeInTheDocument();
  });

  it("leaves out what the person can't do", async () => {
    open(testLead({ can: { edit: false, move: false, reveal: false, assign: false, delete: false, message: false } }));
    await screen.findByRole("dialog", { name: "Aisha Khan" });
    for (const name of ["Reveal contact", "WhatsApp", "Won", "Lost", "Delete lead"])
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^New/ })).toBeDisabled();
  });

  it("marks a lead won with the achievement chime, and only then", async () => {
    vi.mocked(leadsClient.move).mockResolvedValue(ok({ lead: testLead({ stageId: "s-won", wonAt: "2026-09-25T10:00:00Z" }) }));
    const h = open();
    await userEvent.click(await screen.findByRole("button", { name: "Won" }));
    await userEvent.click(await screen.findByRole("button", { name: "Mark as won" }));
    await vi.waitFor(() => expect(leadsClient.move).toHaveBeenCalledWith("l1", "s-won", {}));
    expect(play).toHaveBeenCalledWith("won");
    expect(play).toHaveBeenCalledTimes(1);
    expect(h.onChanged).toHaveBeenCalledWith(expect.objectContaining({ stageId: "s-won" }));
  });

  it("closes itself with an explanation when the lead is handed to someone the person can't see", async () => {
    vi.mocked(leadsClient.assign).mockResolvedValue(ok({ id: "l1", ownerId: "u-tas", visible: false }));
    const h = open(testLead({ can: { ...testLead().can, assign: true } }), fakeSession({ permissions: [{ key: "leads.view", scope: "team" }, { key: "leads.assign", scope: "team" }] }));
    await userEvent.click(await screen.findByRole("button", { name: /owner: riya sharma/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Tasneem Shaikh" }));
    await vi.waitFor(() => expect(h.onGone).toHaveBeenCalledWith("l1", "handed"));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Handed to Tasneem Shaikh" }));
  });

  it("explains a lead that isn't available any more instead of an error screen", async () => {
    vi.mocked(leadsClient.get).mockResolvedValue({ ok: false, status: 404, code: "NOT_FOUND", message: "x" });
    vi.mocked(leadsClient.activities).mockResolvedValue(ok({ items: [], nextCursor: null }));
    render(<CatalogProvider catalog={testCatalog()}><LeadDrawer id="gone" session={fakeSession()} neighbours={[]} {...handlers()} /></CatalogProvider>);
    expect(await screen.findByText(/isn’t available to you/i)).toBeInTheDocument();
  });

  it("steps through the list with J and K, and closes with Escape", async () => {
    const h = open();
    await screen.findByRole("dialog", { name: "Aisha Khan" });
    await userEvent.keyboard("j");
    expect(h.onStep).toHaveBeenCalledWith("l2");
    await userEvent.keyboard("k");
    expect(h.onStep).toHaveBeenCalledWith("l0");
    await userEvent.keyboard("{Escape}");
    expect(h.onClose).toHaveBeenCalled();
  });

  it("opens WhatsApp in a new tab from a server-built link, then asks whether it was sent", async () => {
    const tab = { location: { href: "" }, close: vi.fn(), opener: {} as unknown };
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    vi.mocked(leadsClient.prepareMessage).mockResolvedValue(ok({ url: "https://wa.me/971501234567" }));
    vi.mocked(leadsClient.confirmMessage).mockResolvedValue({ ok: true, status: 204, data: null });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "WhatsApp" }));
    await userEvent.click(screen.getByRole("button", { name: "Open WhatsApp" }));
    await vi.waitFor(() => expect(tab.location.href).toBe("https://wa.me/971501234567"));
    expect(screen.queryByText(/wa\.me/)).not.toBeInTheDocument(); // the link itself is never shown
    window.dispatchEvent(new Event("focus"));
    await userEvent.click(await screen.findByRole("button", { name: "Yes, sent" }));
    expect(leadsClient.confirmMessage).toHaveBeenCalledWith("l1", true);
  });

  it("says why WhatsApp can't open for a number without a country code", async () => {
    open(testLead({ phone: { display: "05• ••• ••67", masked: true, status: "needs_country" } }));
    expect(await screen.findByRole("button", { name: "WhatsApp" })).toBeDisabled();
    expect(screen.getByText(/needs a country code/i)).toBeInTheDocument();
  });

  it("adds a note to the Notes tab", async () => {
    vi.mocked(leadsClient.note).mockResolvedValue(ok({ activity: { id: "n1", type: "note", payload: { body: "Call after 6pm" }, occurredAt: "2026-09-25T10:00:00Z", user: null } }));
    open();
    await userEvent.click(await screen.findByRole("tab", { name: "Notes" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Write a note" }), "Call after 6pm");
    await userEvent.click(screen.getByRole("button", { name: "Add note" }));
    expect(leadsClient.note).toHaveBeenCalledWith("l1", "Call after 6pm");
    expect(await screen.findByText("Call after 6pm")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `scripts/dev.sh run pnpm vitest run apps/web/src/components/leads apps/web/src/lib/leads`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`apps/web/src/lib/leads/history.ts`:
```ts
import { personName, stageOf } from "./format";
import type { Activity, Catalog } from "./types";

export type HistoryLine = { title: string; detail?: string; tone: string; quote?: string };
const by = (a: Activity) => (a.user ? `by ${a.user.name}` : undefined);
const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(" · ") || undefined;

/** One event in plain words. Unknown types still render ("Updated"), so a newer API never breaks the drawer. */
export function describeActivity(a: Activity, cat: Catalog): HistoryLine {
  const p = a.payload as Record<string, unknown>;
  switch (a.type) {
    case "stage_changed": {
      const to = stageOf(cat, p.to as string);
      if (to?.kind === "lost") {
        const reason = cat.lostReasons.find((r) => r.id === p.lostReasonId)?.label;
        return { title: "Marked as lost", detail: join(reason, by(a)), tone: "danger" };
      }
      if (to?.kind === "won") return { title: "Won", detail: by(a), tone: "ok" };
      return { title: `Moved to ${to?.name ?? "another stage"}`, detail: by(a), tone: to?.color ?? "accent" };
    }
    case "assigned":
      return { title: p.to ? `Handed to ${personName(cat, p.to as string)}` : "Unassigned", detail: by(a), tone: "meet" };
    case "contact_revealed":
      return { title: "Contact revealed", detail: by(a), tone: "neutral" };
    case "whatsapp_opened":
      return { title: "WhatsApp opened", detail: by(a), tone: "wa", ...(p.text ? { quote: String(p.text) } : {}) };
    case "whatsapp_confirmed_sent":
      return { title: "WhatsApp sent", detail: by(a), tone: "wa" };
    case "whatsapp_not_sent":
      return { title: "WhatsApp not sent", detail: by(a), tone: "neutral" };
    case "field_changed": {
      const labels = ((p.fields as string[]) ?? []).map((k) => {
        const key = k.replace(/^custom\./, "");
        return key === "tags" ? "Tags" : (cat.fields.find((f) => f.key === key)?.label ?? key);
      });
      return { title: `Edited ${labels.join(", ") || "details"}`, detail: by(a), tone: "neutral" };
    }
    case "lead_created":
      return { title: "Lead added", detail: join(p.source === "sheet" ? "from the Google Sheet" : undefined, by(a)), tone: "accent" };
    case "note":
      return { title: "Note", detail: by(a), tone: "neutral", quote: String(p.body ?? "") };
    default:
      return { title: "Updated", detail: by(a), tone: "neutral" };
  }
}
```

`useStageMove.tsx`: a hook that renders one small dialog (the glass `.pop` from the prototype, centred on phones) and returns a promise per request:
```tsx
"use client";
export function useStageMove() {
  const catalog = useCatalog();
  const [pending, setPending] = useState<null | {
    lead: Lead; stage: Stage; mode: "lost" | "required"; missing: FieldDefView[]; resolve: (l: Lead | null) => void; error?: string;
  }>(null);
  const { toast } = useToast();

  const attempt = async (lead: Lead, stage: Stage, extra: { lostReasonId?: string; lostNote?: string } = {}) => {
    const r = await leadsClient.move(lead.id, stage.id, extra);
    if (r.ok) return { moved: r.data.lead } as const;
    if (r.code === "REQUIRED_FIELDS") {
      const keys = ((r.details as { fields?: string[] }) ?? {}).fields ?? [];
      return { missing: catalog.fields.filter((f) => keys.includes(f.key)) } as const;
    }
    toast({ tone: "danger", title: `Couldn’t move ${lead.name ?? "this lead"}`, detail: r.message });
    return { refused: true } as const;
  };

  const request = (lead: Lead, stage: Stage) =>
    new Promise<Lead | null>((resolve) => {
      if (stage.kind === "lost") return setPending({ lead, stage, mode: "lost", missing: [], resolve });
      void attempt(lead, stage).then((res) => {
        if ("moved" in res) return resolve(res.moved);
        if ("missing" in res && res.missing.length) return setPending({ lead, stage, mode: "required", missing: res.missing, resolve });
        resolve(null);
      });
    });
  // …the dialog:
  //  - mode "lost": role="dialog" aria-label="Why was <first name> lost?", a radiogroup of catalog.lostReasons
  //    (chips styled like the prototype's .chip), "Note (optional)" input (max 1000), buttons Cancel and
  //    "Mark as lost" (disabled until a reason is picked) → attempt(lead, stage, { lostReasonId, lostNote })
  //  - mode "required": aria-label="Before moving to <stage>", one FieldEditor (always open, no commit on blur)
  //    per missing field with its label, buttons Cancel and "Save and move": patch the values with the lead's
  //    version (patchFor per field, merged into one PATCH body), then attempt() again; a second REQUIRED_FIELDS
  //    or a 409 shows the message inline and keeps the dialog open.
  //  Cancel and Escape resolve(null). The dialog traps focus and returns it to where it was.
  return { request, ui: pending ? <MoveDialog … /> : null };
}
```
(Write `MoveDialog` in the same file as a small component; it takes `pending`, `onDone(lead | null)`, and uses `attempt`, `patchFor`.)

`LeadDrawer.tsx`: `role="dialog" aria-modal="true" aria-labelledby` pointing at the name heading. It's positioned like the prototype's `.drawer` (fixed; top/right/bottom 8px; width 620px; radius 18px; `--sheet`; `--shadow-pop`) and slides in from the right with `SPRINGS.drawer` (and out the same way, for spatial consistency), over a `--scrim` that closes it on click. Below 720px it is full screen. The data is `leadsClient.get(id)` and `leadsClient.activities(id)` in parallel, with a skeleton header, track and boxes while loading. A 404 shows "This lead isn’t available to you any more", "It may have been handed to someone else or deleted." and a **Close** button.

Parts, top to bottom, following `key-screens.html`:
- **Top bar:**
  - `IconButton`s: "Close" (Esc), "Previous lead" (K), "Next lead" (J).
  - The position "n of m" from `neighbours`.
  - On the right, "Delete lead" when `can.delete`. It asks for confirmation with a small popover ("Delete Aisha Khan? This can’t be undone from here.") and then calls `remove` and `onGone(id, "deleted")`.
- **Header:**
  - The avatar at 52px and the name in an `h2`. The name is editable in place when `editable(lead, nameField)`.
  - A subline: "Enquiry <relative date> · <OwnerButton>". `OwnerButton` is `AssignMenu` when `can.assign`, otherwise plain text. Its accessible name is "Owner: <name>".
- **Actions:**
  - `MessageButton` when `can.message`.
  - **Won** and **Lost** on the right when `can.move` and the pipeline has those stages. They open `OutcomePopover`:
    - **Won:** "Deal value" prefilled from the lead's value or the chosen product's default value, product chips from `catalog.products`, and **Mark as won**. If the value or product changed, it patches them first (If-Match), then `move(id, wonStage.id, {})`. On success: `sound.play("won")`, a `PetalBurst` from the button (six petals in the stage colours, 700ms, skipped under reduced motion), and a toast "Won · AED 4,500".
    - **Lost:** delegates to `useStageMove().request(lead, lostStage)`.
- **`StageTrack`:** one segment button per open stage of the lead's pipeline, as in the prototype's `.track`. Each segment has `aria-current="step"` when current and `disabled` unless `can.move`. Clicking calls `request(lead, stage)`, and the fill animates forward in sequence (45ms steps) or back in reverse. The line under it reads "In <stage> for <n days>", "Won · <value>" or "Lost · <reason>".
- **Boxes:**
  - `ContactBox`: phone, email and Instagram rows with icons. A masked value gets a **Reveal contact** button when `can.reveal`. Clicking blurs the values (`filter: blur(5px)`, 260ms), calls `reveal(id)`, swaps in the real values, un-blurs them, and replaces the button with the line "Revealed · recorded in the audit log". A lead with nothing to show says "No contact details".
  - **Details:** value, product, enquiry date and every visible custom field, each a `FieldValue` that turns into a `FieldEditor` on click when `editable`, saving through `useLeadEditor` (a conflict refreshes the drawer).
- **Tabs** (`role="tablist"`: Details, Notes, History; Details holds the boxes):
  - **Notes:** a composer (`textarea` labelled "Write a note", ⌘/Ctrl+Enter or **Add note**; `N` focuses it) above the notes, newest first.
  - **History:** the `Timeline` of everything except notes. Each item uses `describeActivity`: an icon dot in the tone colour on the vertical line (prototype `.tl`/`.ti`), the title, the detail, an optional quote block, and a relative time. **Load earlier** pages with the activities cursor.

Keyboard, active only when focus isn't in a field: `Escape` closes (a popover closes first), `J`/`K` step through the list, `W` opens the WhatsApp composer. Focus goes to the heading on open and returns to the row on close; `Tab` stays inside the drawer.

`MessageButton.tsx`:
- **Unavailable:** when `lead.phone?.status` isn't `valid`, the button is disabled and a line under it says why: "No WhatsApp number" for `missing` or `invalid`, "This number needs a country code" for `needs_country`.
- **Composer:** clicking opens a popover with a `textarea` "Message (optional)" (max 4096) and **Open WhatsApp**.
- **Opening:** on that click it first opens a blank tab synchronously, so no popup blocker stops it: `const tab = window.open("", "_blank"); if (tab) tab.opener = null;`. It then awaits `prepareMessage(id, text)` and sets `tab.location.href = url`. On failure it closes the tab and shows `r.message` in the popover.
- **Sent? prompt:** the next time the window regains focus (`window` `focus`, once), a non-blocking inline prompt appears in the drawer: "Sent?" with **Yes, sent** and **Not sent**, each calling `confirmMessage(id, answer)` and reloading the history. The URL is never rendered.

`AssignMenu.tsx`: a `Popover` with `role="menu"`. It lists the active people (`menuitem`s) with a tick on the current owner, plus "Unassigned" only when `scopeOf(actor, "leads.assign") === "all"`. Choosing one calls `assign(id, ownerId)`:
- `visible: false`: toast "Handed to <name>" with the detail "It’s no longer in your list.", then `onGone(id, "handed")`.
- Otherwise: reload the lead, `onChanged(lead)`, and toast "Handed to <name>".

`LeadsScreen.tsx`: reads `lead` from `useSearchParams()`. It renders `<LeadDrawer key={id} id … neighbours={rows.map((r) => r.id)} />`. Opening and closing a row changes `?lead=` with `router.replace` (no history spam) and keeps the filters; `onStep` swaps the id; `onChanged` calls `replace(lead)`; `onGone` calls `removeRow(id)` and closes the drawer. A lead moved out of the current stage filter stays until the next fetch, so the person sees what they just did.

- [ ] **Step 4: Run to verify they pass**

Run: `scripts/dev.sh run pnpm vitest run apps/web/src/components/leads apps/web/src/lib/leads`
Expected: history (2), useStageMove (5), LeadDrawer (10) green with the earlier tasks' tests.

- [ ] **Step 5: Strict gate, commit, push**

```bash
bash "$SCRATCH/gate.sh" && git add -A && git commit -m "feat(web): lead drawer — stage track, audited Reveal, WhatsApp hand-off with Sent?, won and lost, assign, notes and history

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git push origin main
```

---

### Task 6: Create a lead — the sheet, live duplicate warnings, and landing in the new lead

**Files:**
- Create: `apps/web/src/components/leads/NewLeadSheet.tsx`, `NewLeadSheet.test.tsx`, `apps/web/src/components/leads/useDuplicates.ts`
- Modify: `LeadsScreen.tsx` (the New lead buttons open the sheet; the created lead is prepended and opened)

**Interfaces:**
- Consumes: `leadsClient.create/duplicates`, `useCatalog`, `FieldEditor` (Task 4), `can`/`scopeOf` from `@lume/core/shared`.
- Produces: `<NewLeadSheet session onCreated(lead) onClose />`; `useDuplicates({ phone, email })` → `Duplicate[]` (debounced 400ms, keeps only the latest answer)

- [ ] **Step 1: Write the failing test**

`apps/web/src/components/leads/NewLeadSheet.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leadsClient } from "@/lib/leads/client";
import { testCatalog, testLead } from "@/lib/leads/test-catalog";
import { fakeSession } from "@/server/session";
import { CatalogProvider } from "./CatalogProvider";
import { NewLeadSheet } from "./NewLeadSheet";

vi.mock("@/lib/leads/client", () => ({ leadsClient: { create: vi.fn(), duplicates: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const creator = (extra: { key: string; scope: "own" | "team" | "all" | null }[] = []) =>
  fakeSession({ permissions: [{ key: "leads.view", scope: "all" }, { key: "leads.create", scope: null }, ...extra] });
const open = (session = creator()) => {
  const onCreated = vi.fn();
  render(<CatalogProvider catalog={testCatalog()}><NewLeadSheet session={session} onCreated={onCreated} onClose={vi.fn()} /></CatalogProvider>);
  return onCreated;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(leadsClient.duplicates).mockResolvedValue(ok({ duplicates: [] }));
});

describe("NewLeadSheet", () => {
  it("creates a lead with the essentials and hands it back", async () => {
    vi.mocked(leadsClient.create).mockResolvedValue({ ok: true, status: 201, data: { lead: testLead({ id: "new" }), duplicates: [] } });
    const onCreated = open();
    await userEvent.type(screen.getByLabelText("Name"), "Aisha Khan");
    await userEvent.type(screen.getByLabelText("Phone"), "+971501234567");
    await userEvent.click(screen.getByRole("button", { name: "Create lead" }));
    expect(leadsClient.create).toHaveBeenCalledWith(expect.objectContaining({ name: "Aisha Khan", phone: "+971501234567", stageId: "s-new" }));
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "new" }));
  });

  it("warns about a duplicate as the phone is typed, naming the owner only when allowed", async () => {
    vi.mocked(leadsClient.duplicates)
      .mockResolvedValueOnce(ok({ duplicates: [{ visible: true, leadId: "l9", name: "Aisha K", ownerName: "Riya Sharma", matchedOn: ["phone"] }] }));
    open();
    await userEvent.type(screen.getByLabelText("Phone"), "+971501234567");
    expect(await screen.findByRole("status")).toHaveTextContent("Aisha K already has this phone · handled by Riya Sharma");
    expect(screen.getByRole("link", { name: "Open Aisha K" })).toHaveAttribute("href", "/leads?lead=l9");
  });

  it("says only that a lead exists when the caller may not see it", async () => {
    vi.mocked(leadsClient.duplicates).mockResolvedValue(ok({ duplicates: [{ visible: false, matchedOn: ["email"] }] }));
    open();
    await userEvent.type(screen.getByLabelText("Email"), "aisha@example.com");
    expect(await screen.findByRole("status")).toHaveTextContent("A lead with this email already exists");
    expect(screen.queryByRole("link", { name: /open/i })).not.toBeInTheDocument();
  });

  it("needs a name, and shows the API's reason for a bad field next to it", async () => {
    vi.mocked(leadsClient.create).mockResolvedValue({
      ok: false, status: 400, code: "VALIDATION", message: "Check the highlighted fields",
      details: { issues: [{ path: ["email"], message: "Enter a valid email" }] },
    });
    open();
    await userEvent.click(screen.getByRole("button", { name: "Create lead" }));
    expect(screen.getByText("Give the lead a name")).toBeInTheDocument();
    expect(leadsClient.create).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText("Name"), "A");
    await userEvent.type(screen.getByLabelText("Email"), "bad@x");
    await userEvent.click(screen.getByRole("button", { name: "Create lead" }));
    expect(await screen.findByText("Enter a valid email")).toBeInTheDocument();
  });

  it("offers an owner picker only to someone who may assign", () => {
    open();
    expect(screen.queryByLabelText("Owner")).not.toBeInTheDocument();
    open(creator([{ key: "leads.assign", scope: "all" }]));
    expect(screen.getByLabelText("Owner")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `scripts/dev.sh run pnpm vitest run apps/web/src/components/leads/NewLeadSheet.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`useDuplicates.ts`:
```ts
"use client";
import { useEffect, useRef, useState } from "react";
import { leadsClient } from "@/lib/leads/client";
import type { Duplicate } from "@/lib/leads/types";

/** Report §8.3 while typing: waits for a pause, and only the answer to the latest input is shown. */
export function useDuplicates(c: { phone?: string; email?: string }) {
  const [found, setFound] = useState<Duplicate[]>([]);
  const latest = useRef(0);
  const phone = c.phone?.replace(/\s/g, "") ?? "";
  const email = c.email?.trim() ?? "";
  useEffect(() => {
    const usable = phone.replace(/\D/g, "").length >= 7 || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
    if (!usable) return setFound([]);
    const n = ++latest.current;
    const t = setTimeout(async () => {
      const r = await leadsClient.duplicates({ ...(phone ? { phone } : {}), ...(email.includes("@") ? { email } : {}) });
      if (n === latest.current) setFound(r.ok ? r.data.duplicates : []);
    }, 400);
    return () => clearTimeout(t);
  }, [phone, email]);
  return found;
}
```

`NewLeadSheet.tsx`: the same right-hand sheet shell as the drawer (reuse `drawer.module.css`'s `.drawer` and `.scrim`), `role="dialog"`, `aria-labelledby` the title "New lead". It is a `<form method="post" noValidate>` built from `Field`s:
- **Name:** required. An empty submit shows "Give the lead a name" and focuses the field.
- **Phone:** `type="tel"`, hinted "With the country code, or it’s read as <business country>".
- **Email**, and **Instagram** (both only when that field isn't hidden).
- **Stage:** a `select` over the default pipeline's open stages, defaulting to the first.
- **Owner:** a `select` of active people, only when `can(actor, "leads.assign")`, defaulting to the person themselves. "Unassigned" is offered only when `scopeOf(actor, "leads.assign") === "all"`, because the API refuses it otherwise. Without this field the API makes the creator the owner.
- **Deal value:** plus a product `select` that fills the value from its `defaultValue` while the value is untouched.
- **Tags:** toggle chips.
- **Custom fields:** every custom field with `access === "edit"`, each as an always-open `FieldEditor` without its own commit buttons, with values collected on submit.

Under Phone and Email sits one `role="status"` line built from `useDuplicates`:
- A visible match reads "<name> already has this <phone|email> · handled by <owner>", with a `Link` "Open <name>" to `/leads?lead=<id>`.
- An invisible match reads "A lead with this <phone|email> already exists".

It is only a warning; creating is still allowed.

**Create lead** sends only the filled fields, so empty values are left out and custom values go under `custom`. On success it calls `onCreated(lead)`. On a 400 with `issues`, each message goes under its field (`path[0]`, or `custom.<key>`); anything else shows `r.message` above the buttons. The primary button uses `loading` while saving.

In `LeadsScreen`, `onCreated` does `prepend(lead)`, opens the drawer on it (`?lead=<id>`), and toasts "Lead added".

- [ ] **Step 4: Run to verify it passes**

Run: `scripts/dev.sh run pnpm vitest run apps/web/src/components/leads`
Expected: NewLeadSheet (5) green with the rest.

- [ ] **Step 5: Strict gate, commit, push**

```bash
bash "$SCRATCH/gate.sh" && git add -A && git commit -m "feat(web): create a lead — sheet with custom fields, live duplicate warnings that never name a hidden lead's owner

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git push origin main
```

---

### Task 7: The board — columns per stage, counts, drag with the spring, and a full keyboard path

**Files:**
- Modify: `apps/web/src/app/(app)/pipeline/page.tsx`, `apps/web/src/server/leads.ts` (add `loadBoard`)
- Create: `apps/web/src/components/board/{BoardScreen,BoardColumn,BoardCard,boardKeys}.tsx|ts`, `board.module.css`, `boardKeys.test.ts`, `BoardScreen.test.tsx`

**Interfaces:**
- Consumes: `useStageMove` and `LeadDrawer` (Task 5), `FilterBar` (Task 3, with `hideStage`), `leadsClient.list/counts`, `useSound`, `useToast`.
- Produces:
  - `loadBoard(session, params)` → `{ catalog; pipeline: Pipeline; filters; columns: Record<stageId, LeadPage>; counts: Record<stageId, number> }`. The stage filter is ignored on the board, and each column's first 25 cards plus the counts are fetched in parallel.
  - `boardKeys(state, event)`: a pure reducer, where `state` is `{ picked: null | { leadId: string; from: number; to: number } }` and `event` is `{ type: "pick"; leadId; column } | { type: "left" } | { type: "right"; columns: number } | { type: "drop" } | { type: "cancel" }`
  - `data-stage-id` on columns and `data-lead-card` on cards (the drop hit-test and e2e use them)

- [ ] **Step 1: Write the failing tests**

`apps/web/src/components/board/boardKeys.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { boardKeys } from "./boardKeys";

describe("board keyboard moves", () => {
  it("picks up with Space, moves with the arrows inside the board, and drops with Enter", () => {
    let s = boardKeys({ picked: null }, { type: "pick", leadId: "l1", column: 1 });
    expect(s.picked).toEqual({ leadId: "l1", from: 1, to: 1 });
    s = boardKeys(s, { type: "right", columns: 3 });
    s = boardKeys(s, { type: "right", columns: 3 });
    s = boardKeys(s, { type: "right", columns: 3 }); // already at the last column
    expect(s.picked?.to).toBe(2);
    s = boardKeys(s, { type: "left" });
    s = boardKeys(s, { type: "left" });
    s = boardKeys(s, { type: "left" }); // already at the first column
    expect(s.picked?.to).toBe(0);
    expect(boardKeys(s, { type: "drop" }).picked).toBeNull();
  });

  it("Escape puts it back, and arrows without a picked card do nothing", () => {
    const s = boardKeys({ picked: { leadId: "l1", from: 1, to: 2 } }, { type: "cancel" });
    expect(s.picked).toBeNull();
    expect(boardKeys({ picked: null }, { type: "right", columns: 3 })).toEqual({ picked: null });
  });
});
```

`apps/web/src/components/board/BoardScreen.test.tsx`:
```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leadsClient } from "@/lib/leads/client";
import { EMPTY_FILTERS } from "@/lib/leads/filters";
import { testCatalog, testLead } from "@/lib/leads/test-catalog";
import { fakeSession } from "@/server/session";
import { BoardScreen } from "./BoardScreen";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/pipeline",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/leads/client", () => ({ leadsClient: { move: vi.fn(), list: vi.fn(), counts: vi.fn(), get: vi.fn(), activities: vi.fn() } }));
const play = vi.fn();
vi.mock("@/components/feedback/SoundProvider", () => ({ useSound: () => ({ play }) }));

const cat = testCatalog();
const pipeline = cat.pipelines[0]!;
const board = (over: Partial<Parameters<typeof BoardScreen>[0]> = {}) =>
  render(
    <BoardScreen
      session={fakeSession({ permissions: [{ key: "leads.view", scope: "own" }, { key: "leads.change_stage", scope: "own" }] })}
      catalog={cat}
      pipeline={pipeline}
      filters={EMPTY_FILTERS}
      columns={{ "s-new": { items: [testLead()], nextCursor: null }, "s-sent": { items: [], nextCursor: null } }}
      counts={{ "s-new": 1, "s-sent": 0 }}
      {...over}
    />,
  );
const column = (name: string) => screen.getByRole("region", { name: new RegExp(`^${name}`) });

beforeEach(() => vi.clearAllMocks());

describe("BoardScreen", () => {
  it("shows one column per stage with its count", () => {
    board();
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual([
      "New, 1 lead", "Message sent, 0 leads", "Call booked, 0 leads", "Won, 0 leads", "Lost, 0 leads",
    ]);
    expect(within(column("New")).getByRole("button", { name: /Aisha Khan/ })).toBeInTheDocument();
  });

  it("moves a card with the keyboard alone and keeps the counts true", async () => {
    vi.mocked(leadsClient.move).mockResolvedValue({ ok: true, status: 200, data: { lead: testLead({ stageId: "s-sent" }) } });
    board();
    within(column("New")).getByRole("button", { name: /Aisha Khan/ }).focus();
    await userEvent.keyboard(" ");
    expect(screen.getByRole("status")).toHaveTextContent(/picked up aisha khan/i);
    await userEvent.keyboard("{ArrowRight}{Enter}");
    expect(leadsClient.move).toHaveBeenCalledWith("l1", "s-sent", {});
    await vi.waitFor(() => expect(within(column("Message sent")).getByRole("button", { name: /Aisha Khan/ })).toBeInTheDocument());
    expect(column("New")).toHaveAccessibleName("New, 0 leads");
    expect(column("Message sent")).toHaveAccessibleName("Message sent, 1 lead");
  });

  it("puts the card back when the move is refused, with the counts restored", async () => {
    vi.mocked(leadsClient.move).mockResolvedValue({ ok: false, status: 403, code: "FORBIDDEN", message: "no" });
    board();
    within(column("New")).getByRole("button", { name: /Aisha Khan/ }).focus();
    await userEvent.keyboard(" {ArrowRight}{Enter}");
    await vi.waitFor(() => expect(within(column("New")).getByRole("button", { name: /Aisha Khan/ })).toBeInTheDocument());
    expect(column("New")).toHaveAccessibleName("New, 1 lead");
    expect(column("Message sent")).toHaveAccessibleName("Message sent, 0 leads");
  });

  it("asks for the reason when a card is dropped on Lost, and cancelling puts it back", async () => {
    board();
    within(column("New")).getByRole("button", { name: /Aisha Khan/ }).focus();
    await userEvent.keyboard(" {ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{Enter}");
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(within(column("New")).getByRole("button", { name: /Aisha Khan/ })).toBeInTheDocument();
    expect(leadsClient.move).not.toHaveBeenCalled();
  });

  it("plays the win chime only for a move into Won", async () => {
    vi.mocked(leadsClient.move).mockResolvedValue({ ok: true, status: 200, data: { lead: testLead({ stageId: "s-won" }) } });
    board();
    within(column("New")).getByRole("button", { name: /Aisha Khan/ }).focus();
    await userEvent.keyboard(" {ArrowRight}{ArrowRight}{ArrowRight}{Enter}");
    await vi.waitFor(() => expect(play).toHaveBeenCalledWith("won"));
  });

  it("offers no pick-up on a card the person can't move", async () => {
    board({ columns: { "s-new": { items: [testLead({ can: { ...testLead().can, move: false } })], nextCursor: null } } });
    within(column("New")).getByRole("button", { name: /Aisha Khan/ }).focus();
    await userEvent.keyboard(" ");
    expect(screen.queryByText(/picked up/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `scripts/dev.sh run pnpm vitest run apps/web/src/components/board`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`boardKeys.ts`:
```ts
export type BoardKeysState = { picked: null | { leadId: string; from: number; to: number } };
export type BoardKeysEvent =
  | { type: "pick"; leadId: string; column: number }
  | { type: "left" }
  | { type: "right"; columns: number }
  | { type: "drop" }
  | { type: "cancel" };

/** The board without a mouse (spec §6): Space picks up, arrows choose the stage, Enter drops, Escape cancels. */
export function boardKeys(state: BoardKeysState, e: BoardKeysEvent): BoardKeysState {
  if (e.type === "pick") return { picked: { leadId: e.leadId, from: e.column, to: e.column } };
  if (!state.picked) return state;
  switch (e.type) {
    case "left":
      return { picked: { ...state.picked, to: Math.max(0, state.picked.to - 1) } };
    case "right":
      return { picked: { ...state.picked, to: Math.min(e.columns - 1, state.picked.to + 1) } };
    case "drop":
    case "cancel":
      return { picked: null };
  }
}
```

`BoardScreen.tsx` keeps `columns` and `counts` in state and has one `move(lead, fromStage, toStage)` shared by pointer and keyboard:
```tsx
const move = async (lead: Lead, from: Stage, to: Stage) => {
  if (from.id === to.id) return;
  // Optimistic: the card lands at once, then the server decides.
  const before = { columns, counts };
  setColumns((c) => ({ ...c, [from.id]: without(c[from.id], lead.id), [to.id]: withFirst(c[to.id], lead) }));
  setCounts((n) => ({ ...n, [from.id]: (n[from.id] ?? 1) - 1, [to.id]: (n[to.id] ?? 0) + 1 }));
  const moved = await request(lead, to); // useStageMove: lost reason, required fields, refusal toasts
  if (!moved) {
    setColumns(before.columns); // spring back: the card animates to its old place via layout animation
    setCounts(before.counts);
    announce(`${lead.name} stayed in ${from.name}.`);
    return;
  }
  setColumns((c) => ({ ...c, [to.id]: replaceIn(c[to.id], moved) }));
  if (to.kind === "won") {
    sound.play("won");
    toast({ tone: "ok", title: `Won · ${lead.name}`, detail: moved.value ? formatMoney(moved.value, catalog.currency) : undefined });
  }
  announce(`${lead.name} moved to ${to.name}.`);
};
```
(`without`, `withFirst` and `replaceIn` are three-line helpers on `LeadPage` in the same file.)

Layout, following the prototype `.kb`/`.kc`:
- **Toolbar:** a pipeline `select` (when there's more than one), `FilterBar` with `hideStage`, the Table/Board switch, and **New lead**.
- **Columns:** a horizontal scroller of columns. Each is 280px, `--sheet`, radius 14px, with a 0.5px line. It is a `<section role="region" aria-label="<Stage>, <n> lead(s)" data-stage-id>` with a header (the colour dot, name, count in `--text-3`, and the column's total value for won columns) and a vertically scrolling card list. Its **Show more** button fetches the next 25 cards for that stage (`list({ ...filters, stageIds: [stage.id] }, cursor)`).
- **Cards (`BoardCard`):** `<button data-lead-card aria-roledescription="draggable lead" aria-describedby="board-help">` showing the name, the value, the owner avatar and "n d in stage". The left edge is `inset 3px 0 0 <stage colour>`, as in the prototype `.cd`. Clicking opens the drawer (`?lead=`).

Pointer drag, only when `lead.can.move`:
- Uses motion's `drag` with `dragSnapToOrigin`, `dragMomentum={false}`, and `whileDrag={{ scale: 1.03, boxShadow: "var(--shadow-pop)", zIndex: 5 }}`.
- On drag it hit-tests `document.elementsFromPoint(x, y)` for `[data-stage-id]` and highlights that column (`data-over`: accent inset ring and `--accent-soft`).
- On drag end over another column it calls `move`. A 6px movement threshold is needed before a drag starts, so a click still opens the drawer.
- Under reduced motion the card doesn't scale, and the snap-back is instant.

Keyboard:
- On a focused card, `Space` dispatches `pick` (announcing "Picked up <name>. Left and right arrows choose a stage, Enter drops, Escape cancels.").
- `←`/`→` move the target (the target column shows `data-over`, and the live region names the stage).
- `Enter` dispatches `drop` and calls `move(lead, columns[from], columns[to])`. `Escape` cancels.
- A `role="status"` live region (visually hidden) carries every announcement.
- `#board-help` (visually hidden) explains the keys once.

Cards animate between columns with `layout` + `layoutId={lead.id}` (the approved spring, `SPRINGS.default`), so both a drop and a snap-back travel instead of jumping.

`/pipeline/page.tsx`: `requirePermission("leads.view")`, then `loadBoard(session, params)`, then `<BoardScreen …/>`.

`loadBoard` in `server/leads.ts`: take the pipeline from `?pipeline=` or the default one. Fetch `counts` with the filters (minus stages) plus one `list` per stage (`limit=25`, `stageId=<id>`, same filters) in parallel.

The drawer opens over the board exactly as on the table. On `onChanged` it updates the card in its column and moves it if its stage changed.

- [ ] **Step 4: Run to verify they pass**

Run: `scripts/dev.sh run pnpm vitest run apps/web/src/components/board apps/web/src/components/leads`
Expected: boardKeys (2) and BoardScreen (6) green.

- [ ] **Step 5: Strict gate, commit, push**

```bash
bash "$SCRATCH/gate.sh" && git add -A && git commit -m "feat(web): pipeline board — a column per stage with counts, spring drag, Space/arrows/Enter keyboard moves, refused drops spring back

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git push origin main
```

---

### Task 8: Bulk actions — select, act, and a result that says what was skipped and why

**Files:**
- Create: `apps/web/src/components/leads/BulkBar.tsx`, `BulkBar.test.tsx`, `apps/web/src/lib/leads/bulk.ts`, `bulk.test.ts`
- Modify: `LeadsTable.tsx` (selection column), `LeadsScreen.tsx` (selection state, BulkBar, reload after)

**Interfaces:**
- Consumes: `leadsClient.bulk`, `useStageMove`'s lost-reason picker UI (reused as a component `LostReasonPicker`, extracted from `useStageMove.tsx` in this task), `Popover`.
- Produces: `bulkSummary(action: BulkAction, result: BulkResult): string`; `runBulkInChunks(ids, action)` → a merged `BulkResult` (100 ids per request); `<BulkBar session selected onDone(result) onClear />`

- [ ] **Step 1: Write the failing tests**

`apps/web/src/lib/leads/bulk.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { leadsClient } from "./client";
import { bulkSummary, runBulkInChunks } from "./bulk";

vi.mock("./client", () => ({ leadsClient: { bulk: vi.fn() } }));

describe("bulkSummary", () => {
  it("says what happened and why anything was skipped, in plain words", () => {
    expect(bulkSummary({ type: "stage", stageId: "s" }, { updated: ["a", "b", "c"], skipped: [{ id: "d", code: "LOST_REASON_REQUIRED" }] }))
      .toBe("3 moved, 1 skipped: needs a lost reason");
    expect(bulkSummary({ type: "assign", ownerId: "u" }, { updated: ["a"], skipped: [] })).toBe("1 reassigned");
    expect(bulkSummary({ type: "delete" }, { updated: [], skipped: [{ id: "a", code: "FORBIDDEN" }, { id: "b", code: "REQUIRED_FIELDS" }] }))
      .toBe("None deleted, 2 skipped: 1 not yours to change, 1 missing required fields");
    expect(bulkSummary({ type: "tags", add: ["t"] }, { updated: ["a", "b"], skipped: [{ id: "c", code: "SOMETHING_NEW" }] }))
      .toBe("2 updated, 1 skipped: couldn’t be changed");
  });
});

describe("runBulkInChunks", () => {
  it("never sends more than 100 ids in one request, and merges the answers", async () => {
    vi.mocked(leadsClient.bulk).mockImplementation(async (ids) => ({ ok: true, status: 200, data: { updated: ids, skipped: [] } }));
    const ids = Array.from({ length: 230 }, (_, i) => `id${i}`);
    const r = await runBulkInChunks(ids, { type: "delete" });
    expect(vi.mocked(leadsClient.bulk).mock.calls.map(([chunk]) => chunk.length)).toEqual([100, 100, 30]);
    expect(r.updated).toHaveLength(230);
  });
});
```

`apps/web/src/components/leads/BulkBar.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leadsClient } from "@/lib/leads/client";
import { testCatalog } from "@/lib/leads/test-catalog";
import { fakeSession } from "@/server/session";
import { BulkBar } from "./BulkBar";
import { CatalogProvider } from "./CatalogProvider";

vi.mock("@/lib/leads/client", () => ({ leadsClient: { bulk: vi.fn() } }));
const toast = vi.fn();
vi.mock("@/components/feedback/ToastProvider", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));
const admin = fakeSession({ permissions: [{ key: "leads.view", scope: "all" }, { key: "leads.bulk_edit", scope: "all" }, { key: "leads.assign", scope: "all" }, { key: "leads.delete", scope: "all" }, { key: "leads.change_stage", scope: "all" }] });
const bar = (selected = ["a", "b", "c", "d"]) => {
  const onDone = vi.fn();
  render(<CatalogProvider catalog={testCatalog()}><BulkBar session={admin} selected={selected} onDone={onDone} onClear={vi.fn()} /></CatalogProvider>);
  return onDone;
};

beforeEach(() => vi.clearAllMocks());

describe("BulkBar", () => {
  it("moves the selection and reports what was skipped and why", async () => {
    vi.mocked(leadsClient.bulk).mockResolvedValue({ ok: true, status: 200, data: { updated: ["a", "b", "c"], skipped: [{ id: "d", code: "REQUIRED_FIELDS" }] } });
    const onDone = bar();
    expect(screen.getByText("4 selected")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Move to stage" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Message sent" }));
    expect(leadsClient.bulk).toHaveBeenCalledWith(["a", "b", "c", "d"], { type: "stage", stageId: "s-sent" });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "3 moved, 1 skipped: missing required fields" }));
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ skipped: [{ id: "d", code: "REQUIRED_FIELDS" }] }));
  });

  it("asks for a lost reason before a bulk move to Lost", async () => {
    vi.mocked(leadsClient.bulk).mockResolvedValue({ ok: true, status: 200, data: { updated: ["a"], skipped: [] } });
    bar(["a"]);
    await userEvent.click(screen.getByRole("button", { name: "Move to stage" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Lost" }));
    await userEvent.click(await screen.findByRole("radio", { name: "Price" }));
    await userEvent.click(screen.getByRole("button", { name: "Mark 1 as lost" }));
    expect(leadsClient.bulk).toHaveBeenCalledWith(["a"], { type: "stage", stageId: "s-lost", lostReasonId: "r-price" });
  });

  it("makes deleting a deliberate act, naming how many", async () => {
    vi.mocked(leadsClient.bulk).mockResolvedValue({ ok: true, status: 200, data: { updated: ["a", "b"], skipped: [] } });
    bar(["a", "b"]);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(leadsClient.bulk).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Delete 2 leads" }));
    expect(leadsClient.bulk).toHaveBeenCalledWith(["a", "b"], { type: "delete" });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `scripts/dev.sh run pnpm vitest run apps/web/src/lib/leads/bulk.test.ts apps/web/src/components/leads/BulkBar.test.tsx`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`apps/web/src/lib/leads/bulk.ts`:
```ts
"use client";
import { leadsClient } from "./client";
import type { BulkAction, BulkResult } from "./types";

const VERB: Record<BulkAction["type"], string> = { stage: "moved", assign: "reassigned", tags: "updated", delete: "deleted" };
const WHY: Record<string, string> = {
  LOST_REASON_REQUIRED: "needs a lost reason",
  REQUIRED_FIELDS: "missing required fields",
  FORBIDDEN: "not yours to change",
  NOT_FOUND: "no longer visible to you",
  ASSIGN_OUT_OF_SCOPE: "outside who you can assign to",
  UNKNOWN_STAGE: "that stage is gone",
  UNKNOWN_USER: "that person can’t take leads",
};
const why = (code: string) => WHY[code] ?? "couldn’t be changed";

/** "3 moved, 1 skipped: needs a lost reason" — the result of a bulk action, reasons grouped (spec §6). */
export function bulkSummary(action: BulkAction, r: BulkResult): string {
  const done = r.updated.length ? `${r.updated.length} ${VERB[action.type]}` : `None ${VERB[action.type]}`;
  if (!r.skipped.length) return done;
  const groups = new Map<string, number>();
  for (const s of r.skipped) groups.set(why(s.code), (groups.get(why(s.code)) ?? 0) + 1);
  const reasons =
    groups.size === 1 ? [...groups.keys()][0]! : [...groups].map(([reason, n]) => `${n} ${reason}`).join(", ");
  return `${done}, ${r.skipped.length} skipped: ${reasons}`;
}

/** The API takes at most 100 ids per request; bigger selections go in turns and the answers are merged. */
export async function runBulkInChunks(ids: string[], action: BulkAction): Promise<BulkResult> {
  const out: BulkResult = { updated: [], skipped: [] };
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const r = await leadsClient.bulk(chunk, action);
    if (!r.ok) {
      out.skipped.push(...chunk.map((id) => ({ id, code: r.code })));
      continue;
    }
    out.updated.push(...r.data.updated);
    out.skipped.push(...r.data.skipped);
  }
  return out;
}
```

`BulkBar.tsx` is a floating glass bar centred at the bottom of the table sheet. It slides up with `SPRINGS.default` when the selection becomes non-empty and down when it's cleared. Its `role="toolbar"` has `aria-label="Bulk actions"` and holds:
- "n selected", and **Clear**.
- **Move to stage** (when `leads.change_stage`): a `Popover` `menu` over the current pipeline's stages. `Lost` opens the `LostReasonPicker` inside the popover, whose primary button reads "Mark n as lost".
- **Assign** (when `leads.assign`): a `menu` of active people, plus "Unassigned" only at `all` scope.
- **Tags** (when there are tags): add and remove lists.
- **Delete** (when `leads.delete`): an inline confirmation replaces the bar's contents with "Delete n leads? This can’t be undone from here." and **Delete n leads** (danger) / **Cancel**.

Each action runs `runBulkInChunks` and toasts `bulkSummary` (tone `warn` when anything was skipped, `ok` otherwise). `onDone(result)` makes the screen reload the list and keep only the skipped ids selected, so the person can fix and retry them.

`LeadsTable.tsx` gains a first column of checkboxes when `can(actor, "leads.bulk_edit")`:
- Each row's checkbox is labelled "Select <name>".
- The header checkbox is labelled "Select all loaded". It shows `indeterminate` when some rows are selected, and it selects only the loaded rows (the bar's count says so).
- Shift-click selects a range.
- The selection survives paging and is cleared by a filter change.

- [ ] **Step 4: Run to verify they pass**

Run: `scripts/dev.sh run pnpm vitest run apps/web/src`
Expected: bulk (2), BulkBar (3), everything earlier green.

- [ ] **Step 5: Strict gate, commit, push**

```bash
bash "$SCRATCH/gate.sh" && git add -A && git commit -m "feat(web): bulk actions — move, assign, tag and delete in chunks of 100, with a result that says what was skipped and why

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git push origin main
```

---

### Task 9: End to end, accessibility, visual baselines and role snapshots for the leads screens

**Files:**
- Create: `apps/web/e2e/leads.spec.ts`, `apps/web/e2e/board.spec.ts`
- Modify: `apps/web/e2e/seed.setup.ts` (leads and a required field), `apps/web/e2e/a11y.spec.ts`, `apps/web/e2e/visual.spec.ts`, `apps/web/e2e/fixtures.ts` (a `seedLeads` helper)
- Modify: every relative-time element gets `data-volatile` (so screenshots mask it)

**Interfaces:**
- Consumes: the 1C-1 harness (`callApi`, `PEOPLE`, `stateFile`, `openApp`, `hydrated`, `alertIn`), Tasks 1–8.
- Produces: `seedLeads(page, leads: { name; phone?; email?; stage?; owner?: Who; value? }[])` → ids; the seed step leaves eight leads (four owned by Noor, the onboarded sales rep, two by the admin, two unassigned) and makes the Struggles field required for **Call booked**.

- [ ] **Step 1: Seed**

Specs run in file order, so `leads.spec.ts` runs before `onboarding.spec.ts` has taken Riya through onboarding, and a not-yet-onboarded person is sent to `/welcome`. The leads specs therefore use a fifth person, **Noor Ahmed** (Sales), who is invited like the others and has onboarding and the tour marked done through the API. Add to `fixtures.ts`: `PEOPLE.seller = { email: "noor@nupuur.test", name: "Noor Ahmed", password: "sunrise over the creek at five" }` and `"seller"` to `Who`. In `seed.setup.ts`'s invite loop, add `{ ...PEOPLE.seller, role: "Sales", file: stateFile("seller") }`, and right after Noor's invite is accepted (in that browser context, before saving its state):
```ts
    if (who.email === PEOPLE.seller.email) {
      await callApi(p, "PUT", "/api/v1/me/onboarding", { completed: true });
      await callApi(p, "PUT", "/api/v1/me/tour", { skipped: true });
    }
```

At the end of `seed.setup.ts`, still as the owner:
```ts
  // Leads for the 1C-2 specs: Noor (Sales) owns four, the admin two, two are unassigned.
  const people = (await callApi<{ people: { id: string; name: string }[] }>(page, "GET", "/api/v1/people")).data.people;
  const idOf = (name: string) => people.find((p) => p.name === name)!.id;
  const leads = [
    { name: "Aisha Khan", phone: "+971501234567", email: "aisha@example.com", owner: idOf(PEOPLE.seller.name), value: 4500 },
    { name: "Omar Haddad", phone: "+971502223344", owner: idOf(PEOPLE.seller.name) },
    { name: "Sara Nasser", phone: "+971503334455", owner: idOf(PEOPLE.seller.name) },
    { name: "Priya Menon", phone: "+971504445566", owner: idOf(PEOPLE.seller.name) },
    { name: "Karim Aziz", phone: "+971505556677", owner: idOf(PEOPLE.admin.name) },
    { name: "Lina Farah", phone: "+971506667788", owner: idOf(PEOPLE.admin.name) },
    { name: "Unassigned One", phone: "+971507778899", owner: null },
    { name: "Unassigned Two", phone: "+971508889900", owner: null },
  ];
  for (const l of leads) {
    const r = await callApi(page, "POST", "/api/v1/leads", { name: l.name, phone: l.phone, email: l.email, ownerId: l.owner, value: l.value });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
  }
  const { pipelines } = (await callApi<{ pipelines: { stages: { id: string; name: string }[] }[] }>(page, "GET", "/api/v1/pipelines")).data;
  const booked = pipelines[0]!.stages.find((s) => s.name === "Call booked")!;
  const { fields } = (await callApi<{ fields: { id: string; key: string }[] }>(page, "GET", "/api/v1/fields")).data;
  const struggles = fields.find((f) => f.key === "struggles")!;
  expect((await callApi(page, "PATCH", `/api/v1/stages/${booked.id}`, { requiredFieldIds: [struggles.id] })).status).toBe(200);
```

- [ ] **Step 2: Write the specs**

`apps/web/e2e/leads.spec.ts` (runs in the `app` project; the owner by default):
```ts
import { alertIn, callApi, expect, PEOPLE, stateFile, test } from "./fixtures";

test.describe("the owner works leads", () => {
  test("@smoke create a lead, see the duplicate warning, and land in it", async ({ page }) => {
    await page.goto("/leads");
    await page.getByRole("button", { name: "New lead" }).first().click();
    const sheet = page.getByRole("dialog", { name: "New lead" });
    await sheet.getByLabel("Name").fill("Aisha Duplicate");
    await sheet.getByLabel("Phone").fill("+971501234567"); // Aisha Khan's number
    await expect(sheet.getByRole("status")).toContainText("Aisha Khan already has this phone · handled by Noor Ahmed");
    await sheet.getByLabel("Phone").fill("+971509990001");
    await expect(sheet.getByRole("status")).toBeEmpty();
    await sheet.getByRole("button", { name: "Create lead" }).click();
    await expect(page.getByRole("dialog", { name: "Aisha Duplicate" })).toBeVisible();
    await expect(page).toHaveURL(/lead=/);
    await expect(page.getByRole("button", { name: "Open Aisha Duplicate" })).toBeVisible();
  });

  test("@smoke move through stages: required fields prompt, lost reason prompt", async ({ page }) => {
    await page.goto("/leads?q=Omar");
    await page.getByRole("button", { name: "Open Omar Haddad" }).click();
    const drawer = page.getByRole("dialog", { name: "Omar Haddad" });
    await drawer.getByRole("button", { name: /^Message sent/ }).click();
    await expect(drawer.getByRole("button", { name: /^Message sent/ })).toHaveAttribute("aria-current", "step");
    await drawer.getByRole("button", { name: /^Call booked/ }).click();
    const need = page.getByRole("dialog", { name: /before moving to call booked/i });
    await need.getByRole("checkbox", { name: "Confidence" }).check();
    await need.getByRole("button", { name: "Save and move" }).click();
    await expect(drawer.getByRole("button", { name: /^Call booked/ })).toHaveAttribute("aria-current", "step");
    await drawer.getByRole("button", { name: "Lost" }).click();
    const why = page.getByRole("dialog", { name: /why was omar lost/i });
    await why.getByRole("radio").first().check();
    await why.getByRole("button", { name: "Mark as lost" }).click();
    await drawer.getByRole("tab", { name: "History" }).click();
    await expect(drawer.getByText("Marked as lost")).toBeVisible();
    await expect(drawer.getByText("Moved to Call booked")).toBeVisible();
  });

  test("@smoke reassign: the previous rep loses the lead at once", async ({ page, browser }) => {
    await page.goto("/leads?q=Priya");
    await page.getByRole("button", { name: "Open Priya Menon" }).click();
    const url = page.url();
    const drawer = page.getByRole("dialog", { name: "Priya Menon" });
    await drawer.getByRole("button", { name: /owner: noor ahmed/i }).click();
    await page.getByRole("menuitem", { name: PEOPLE.admin.name }).click();
    await expect(drawer.getByRole("button", { name: /owner: tasneem shaikh/i })).toBeVisible();

    const rep = await browser.newContext({ storageState: stateFile("seller") });
    const p = await rep.newPage();
    await p.goto("/leads");
    await p.locator("html[data-hydrated]").waitFor({ state: "attached" });
    await expect(p.getByRole("button", { name: "Open Priya Menon" })).toHaveCount(0);
    await p.goto(url.replace(/^.*?(\/leads)/, "$1"));
    await expect(p.getByText(/isn’t available to you/i)).toBeVisible();
    await rep.close();
  });

  test("@smoke bulk: move three, and hear what was skipped and why", async ({ page }) => {
    await page.goto("/leads?q=Unassigned");
    await page.getByRole("checkbox", { name: "Select all loaded" }).check();
    await page.getByRole("button", { name: "Move to stage" }).click();
    await page.getByRole("menuitem", { name: "Call booked" }).click(); // needs Struggles, which neither has
    await expect(page.getByText("None moved, 2 skipped: missing required fields")).toBeVisible();
    await page.getByRole("button", { name: "Move to stage" }).click();
    await page.getByRole("menuitem", { name: "Message sent" }).click();
    await expect(page.getByText("2 moved")).toBeVisible();
  });
});

test.describe("a masked sales rep", () => {
  test.use({ storageState: stateFile("seller") });

  test("@smoke sees no contact column, no export, name-only search, and can reveal only on request", async ({ page }) => {
    await page.goto("/leads");
    const headers = await page.getByRole("columnheader").allInnerTexts();
    expect(headers.join(" ")).not.toMatch(/Phone|Email|Instagram/);
    await expect(page.getByRole("button", { name: /export/i })).toHaveCount(0);
    await expect(page.getByRole("searchbox")).toHaveAttribute("placeholder", "Search by name");
    await expect(page.getByRole("button", { name: "New lead" })).toHaveCount(0); // Sales can't create
    await expect(page.getByRole("checkbox", { name: "Select all loaded" })).toHaveCount(0); // nor bulk edit

    // The API agrees: contacts arrive masked, and a phone search matches nothing (names only).
    const list = await callApi<{ items: { name: string; phone: { masked: boolean } }[] }>(page, "GET", "/api/v1/leads?q=Aisha");
    expect(list.data.items[0]!.phone.masked).toBe(true);
    const byDigits = await callApi<{ items: unknown[] }>(page, "GET", "/api/v1/leads?q=501234567");
    expect(byDigits.data.items).toHaveLength(0);

    await page.getByRole("button", { name: "Open Aisha Khan" }).click();
    const drawer = page.getByRole("dialog", { name: "Aisha Khan" });
    await expect(drawer.getByText("+971 50 123 4567")).toHaveCount(0);
    await drawer.getByRole("button", { name: "Reveal contact" }).click();
    await expect(drawer.getByText("+971 50 123 4567")).toBeVisible();
    await expect(drawer.getByText(/recorded in the audit log/i)).toBeVisible();
  });

  test("the WhatsApp hand-off opens a tab and never shows the link", async ({ page, context }) => {
    await page.goto("/leads?q=Sara");
    await page.getByRole("button", { name: "Open Sara Nasser" }).click();
    const drawer = page.getByRole("dialog", { name: "Sara Nasser" });
    await drawer.getByRole("button", { name: "WhatsApp" }).click();
    const [tab] = await Promise.all([context.waitForEvent("page"), page.getByRole("button", { name: "Open WhatsApp" }).click()]);
    await tab.waitForURL(/wa\.me\/971503334455/).catch(() => undefined); // the tab may not load wa.me in CI; the request is what counts
    expect(tab.url()).toMatch(/wa\.me|about:blank/);
    await tab.close();
    await expect(page.locator("body")).not.toContainText("wa.me");
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await drawer.getByRole("button", { name: "Yes, sent" }).click();
    await drawer.getByRole("tab", { name: "History" }).click();
    await expect(drawer.getByText("WhatsApp sent")).toBeVisible();
  });
});
```

`apps/web/e2e/board.spec.ts`:
```ts
import { expect, openApp, test } from "./fixtures";

test("@smoke drag a card to the next stage; the count moves and it sticks", async ({ page }) => {
  await openApp(page, "/pipeline");
  const from = page.getByRole("region", { name: /^New,/ });
  const to = page.getByRole("region", { name: /^Message sent,/ });
  const before = { from: await from.getAttribute("aria-label"), to: await to.getAttribute("aria-label") };
  const card = from.locator("[data-lead-card]").filter({ hasText: "Sara Nasser" }).or(from.locator("[data-lead-card]").first());
  const name = (await card.first().innerText()).split("\n")[0]!;
  const a = (await card.first().boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 20, a.y + a.height / 2, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + 120, { steps: 12 });
  await page.mouse.up();
  await expect(to.getByRole("button", { name: new RegExp(name) })).toBeVisible();
  expect(await from.getAttribute("aria-label")).not.toBe(before.from);
  await page.reload();
  await expect(page.getByRole("region", { name: /^Message sent,/ }).getByRole("button", { name: new RegExp(name) })).toBeVisible();
});

test("move a card with the keyboard only; dropping on Lost asks why, and cancelling puts it back", async ({ page }) => {
  await openApp(page, "/pipeline");
  const card = page.getByRole("region", { name: /^Message sent,/ }).locator("[data-lead-card]").first();
  const name = (await card.innerText()).split("\n")[0]!;
  await card.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("status").filter({ hasText: /picked up/i })).toBeVisible();
  for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowRight"); // clamps at the last column: Lost
  await page.keyboard.press("Enter");
  await page.getByRole("dialog", { name: /why was .* lost/i }).getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("region", { name: /^Message sent,/ }).getByRole("button", { name: new RegExp(name) })).toBeVisible();
});
```

Additions to `a11y.spec.ts` `CHECKS` (both themes):
```ts
  { name: "leads", path: "/leads", who: "owner", ready: (p) => p.getByTestId("lead-row").first().waitFor() },
  { name: "leads (sales)", path: "/leads", who: "seller", ready: (p) => p.getByTestId("lead-row").first().waitFor() },
  { name: "lead drawer", path: "/leads?q=Karim", who: "owner", ready: async (p) => { await p.getByRole("button", { name: "Open Karim Aziz" }).click(); await p.getByRole("dialog", { name: "Karim Aziz" }).waitFor(); } },
  { name: "pipeline board", path: "/pipeline", who: "owner", ready: (p) => p.getByRole("region").first().waitFor() },
```
Additions to `visual.spec.ts` `SHOTS` (both themes; mask `[data-volatile]` as well as the existing volatile parts): `leads` (owner, filtered to `?q=Karim` so the rows are fixed), `lead-drawer` (the Karim drawer), `pipeline` (owner). Role snapshots: `toMatchAriaSnapshot` of the leads toolbar and table header for the owner and for Noor (Sales), and of the Karim drawer for the owner and the Aisha drawer for Noor (Sales), so a control can never leak into a rep's screen unnoticed (spec §8).

- [ ] **Step 3: Run the suite and record the new baselines**

Run: `scripts/dev.sh run bash -c 'cd apps/web && pnpm exec playwright test --update-snapshots=missing && pnpm exec playwright test'`
Expected: the first run writes only the new screenshots and role snapshots. The second, non-updating run passes everything. Review every new image before committing it (the 1C-1 rule: a baseline that only matches itself once is worthless). Anything flaky gets debugged to its cause (superpowers:systematic-debugging), never retried past.

- [ ] **Step 4: Strict gate, commit, push, watch CI**

```bash
bash "$SCRATCH/gate.sh" && git add -A && git commit -m "test(web): leads end to end — create with duplicate warning, stage prompts, reveal, reassign, bulk skips, masked role, board drag and keyboard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git push origin main
```

---

### Task 10: Live acceptance on the dev stack, docs and memory

- [ ] **Step 1: Walk it live.** Write `apps/web/e2e-live/acceptance-1c2.mjs` on the 1C-1 script's pattern (real Chromium through Caddy's TLS, screenshots to `docs/runbooks/screenshots-1c2/` with secrets masked). The stack must be set up first, so run `scripts/dev.sh reset-db`, then `acceptance-1c1.mjs`, then `acceptance-1c2.mjs`. The steps are §2's row:
  1. Create a lead and see the duplicate warning.
  2. Move stages, meeting the required-fields prompt and then the lost-reason prompt.
  3. As the rep, reveal a contact (and see it in the audit log as the owner).
  4. Reassign one of the rep's leads to the admin; the rep loses it.
  5. Bulk-change a selection with one skip explained.
  6. Check the masked role: no contact column and no export; name-only search in the UI and the API.

  Then `scripts/dev.sh reset-db` again, so the owner still does the real first run.
- [ ] **Step 2: Record it.** Add a "Phase 1C-2" section to `docs/runbooks/acceptance.md` covering: the checks, the screenshots, the unit and e2e counts, the CI run URL, and the findings fixed along the way. Add Execution notes to this plan for any deviation.
- [ ] **Step 3: Memory.** Update `lume-progress`: 1C-2 done, next 1C-3 (Settings).
- [ ] **Step 4: Commit and push** (`docs: Phase 1C-2 acceptance on the dev stack`), and watch CI to green.

---

## Self-review (2026-09-25)

**Spec coverage (§6 and §2 row 1C-2).**
- Table (cursor-paged, ≤100 per request, chosen and reorderable columns, sort, inline edit by field access, filter bar with stage, owner, tag, dates, phone status and custom fields): Tasks 2–4. Custom-field filters use the API's `custom` JSON, through Task 3's "More filters".
- Masked roles: no contact columns, no export, name-only search, with the API enforcing it too: Tasks 1 (the shared rule), 3 (UI) and 9 (UI and API assertions).
- Board (a column per stage, counts, spring drag, required-fields form, lost reason, keyboard path): Task 7.
- Drawer (over the list, full page on phones, header, Details, Notes, History, Reveal stating it was recorded): Task 5.
- Create sheet with duplicate warnings that name the owner only when visible: Task 6. Bulk (stage, assign, tags, delete, with skipped reasons): Task 8. Empty, loading and error states: Tasks 3, 5 and 7.
- WhatsApp message hand-off (link only, report §11.2, "never show the full number in the URL preview"): Tasks 1 and 5.
- Acceptance flows and quality bars (axe both themes, baselines, role snapshots of Leads and a lead drawer): Tasks 9 and 10.

**Deliberately out (spec §9):** saved views, exports (only the control's absence is tested), templates in the WhatsApp composer (Phase 4), the "They replied" and follow-up actions shown in the prototype (Phases 3 and 4), and CSV import.

**Placeholder scan.** No TBDs. Code steps carry code. Where a step describes a component's layout, it names the exact props, roles, labels, keys, CSS values and behaviours, and the tests pin the behaviour.

**Test order.** Spec files run alphabetically, so the leads specs use Noor, a sales rep onboarded by the seed, and not Riya, whose onboarding `onboarding.spec.ts` tests later.

**Type consistency.** `Lead`, `LeadCan`, `Catalog`, `Stage`, `BulkAction` and `BulkResult` are defined once in Task 2 and used unchanged in Tasks 3–9. `useStageMove().request(lead, stage) → Promise<Lead | null>` is the same in Tasks 5, 7 and 8. `leadsClient` method names match between Task 2 and every later use. The `can` block's keys (`edit, move, reveal, assign, delete, message`) match between Task 1's serializer and Task 2's `LeadCan`.
