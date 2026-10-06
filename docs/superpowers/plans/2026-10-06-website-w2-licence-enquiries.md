# Website W2 — Enquiries in the licence dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enquiries from lumecrm.in land in license.lumecrm.in, where the owner reads them, sets their status and keeps notes.

**Architecture:** A new `enquiries` table; a token-guarded public intake `POST /v1/enquiries` (its own Next route, like `/v1/check`), rate-limited and size-capped, folding repeats; admin API routes in `server/api.ts` (list, one, patch); a panel screen pair (list + detail) and a sidebar entry with the count of new ones.

**Tech Stack:** Next.js route handlers, pg (raw SQL), zod 4, Vitest, the licence panel's own CSS.

**Spec:** `docs/superpowers/specs/2026-10-06-lumecrm-website-design.md` (§7)

## Global Constraints

- Table `enquiries`: id, created_at, name, business, whatsapp, email (nullable), team_size, how (nullable), source ('website'), status ('new' | 'contacted' | 'demo_booked' | 'won' | 'not_a_fit'), notes, updated_at. Migration `0003_enquiries.sql`.
- Intake: bearer `ENQUIRY_TOKEN` (licence secrets + the website's Vercel env; generated on the server, never printed); zod, size-capped; rate-limited by IP and globally; same WhatsApp within 10 minutes folded into one; 201 with the id.
- Copy speaks as LUME; no client names; secrets never in the repo or logs.
- The panel's existing session, CSRF and same-origin rules apply to every admin route.

## Review Focus

- Intake with no `ENQUIRY_TOKEN` configured → 503 "not set up", never accepts unauthenticated writes (Task 1 test).
- A token compared with `===` leaks timing → constant-time compare (Task 1 test asserts a wrong token of equal length is refused; the implementation uses `timingSafeEqual`).
- Unicode / emoji / RTL in names and very long fields → stored as typed within limits, refused beyond (Task 1 test with a 121-char name).
- A flood of enquiries from many IPs → the global limiter refuses past 200 an hour, the panel stays usable (Task 1 test).
- Notes edited in two tabs → the later save wins with `updated_at`; the PATCH sends `expectedUpdatedAt` and a stale one is refused with "Changed elsewhere — reload" (Task 2 test).

---

### Task 1: Table and intake

**Files:**
- Create: `apps/licence/migrations/0003_enquiries.sql`
- Create: `apps/licence/src/server/enquiries.ts`
- Create: `apps/licence/src/app/v1/enquiries/route.ts`
- Modify: `apps/licence/src/server/context.ts` (Ctx: `enquiryToken: string | null`; `limits.enquiryIp`, `limits.enquiryAll`)
- Modify: `apps/licence/src/server/testing.ts` (`testCtx` gives `enquiryToken: "test-enquiry-token-0123456789abcdef"` and the two limiters)
- Test: `apps/licence/src/server/enquiries.test.ts`

**Interfaces:**
- Produces: `handleEnquiry(req: Request, ctx: Ctx): Promise<Response>`; `enquirySchema` (zod); `type Enquiry = { id: string; createdAt: string; name: string; business: string; whatsapp: string; email: string | null; teamSize: string; how: string | null; source: "website"; status: Status; notes: string; updatedAt: string }`; `type Status = "new" | "contacted" | "demo_booked" | "won" | "not_a_fit"`.

- [ ] **Step 1: Migration**

```sql
-- Enquiries from lumecrm.in (website spec §7): who asked for a demo, and where the owner has got to with them.
CREATE TABLE enquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  business text NOT NULL CHECK (length(btrim(business)) BETWEEN 1 AND 160),
  whatsapp text NOT NULL CHECK (whatsapp ~ '^\+[1-9][0-9]{6,14}$'),
  email text CHECK (email IS NULL OR (length(email) <= 254 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  team_size text NOT NULL CHECK (team_size IN ('1', '2-5', '6-20', '21+')),
  how text CHECK (how IS NULL OR length(how) <= 500),
  source text NOT NULL DEFAULT 'website' CHECK (source IN ('website')),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'demo_booked', 'won', 'not_a_fit')),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 5000),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX enquiries_new ON enquiries (created_at DESC);
CREATE INDEX enquiries_whatsapp_recent ON enquiries (whatsapp, created_at DESC);
```

- [ ] **Step 2: Failing tests** (`enquiries.test.ts`)

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Limiter } from "@/lib/limit";
import type { Ctx } from "./context";
import { handleEnquiry } from "./enquiries";
import { licenceDb, testCtx, type LicenceTestDb } from "./testing";

let t: LicenceTestDb;
let now = new Date("2026-10-07T05:00:00Z");
let ctx: Ctx;
const TOKEN = "test-enquiry-token-0123456789abcdef";
const BODY = { name: "Ananya Rao", business: "Petal & Plate Studio", whatsapp: "+919812345678", email: "ananya@example.com", teamSize: "2-5", how: "Instagram DMs and a Google Form" };
const post = (body: unknown, o: { token?: string | null; ip?: string } = {}) =>
  handleEnquiry(
    new Request("https://licence.test/v1/enquiries", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-real-ip": o.ip ?? "198.51.100.7",
        ...(o.token === null ? {} : { authorization: `Bearer ${o.token ?? TOKEN}` }),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    ctx,
  );

beforeAll(async () => {
  t = await licenceDb();
  ctx = testCtx(t.pool, () => now);
});
afterAll(async () => t.close());

describe("enquiries from the website (spec §7)", () => {
  it("files one and answers 201 with its id", async () => {
    const r = await post(BODY);
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    const row = (await t.pool.query("SELECT name, business, whatsapp, team_size, status, source FROM enquiries WHERE id = $1", [id])).rows[0];
    expect(row).toEqual({ name: "Ananya Rao", business: "Petal & Plate Studio", whatsapp: "+919812345678", team_size: "2-5", status: "new", source: "website" });
  });
  it("refuses without the token, or a wrong one of the same length", async () => {
    expect((await post(BODY, { token: null })).status).toBe(401);
    expect((await post(BODY, { token: TOKEN.replace(/.$/, "x") })).status).toBe(401);
  });
  it("is closed until the token is set up", async () => {
    const off = testCtx(t.pool, () => now, { enquiryToken: null });
    const r = await handleEnquiry(new Request("https://licence.test/v1/enquiries", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(BODY) }), off);
    expect(r.status).toBe(503);
  });
  it("folds the same WhatsApp number within ten minutes into one", async () => {
    const a = (await (await post({ ...BODY, whatsapp: "+919800000001" })).json()) as { id: string };
    now = new Date(now.getTime() + 5 * 60_000);
    const b = (await (await post({ ...BODY, whatsapp: "+919800000001", how: "Walk-ins too" })).json()) as { id: string };
    expect(b.id).toBe(a.id);
    const row = (await t.pool.query("SELECT how FROM enquiries WHERE id = $1", [a.id])).rows[0];
    expect(row.how).toBe("Walk-ins too");
  });
  it("keeps names as typed, refuses what's too long, and refuses what isn't an enquiry", async () => {
    expect((await post({ ...BODY, whatsapp: "+919800000002", name: "Zoë D’Souza ✨" })).status).toBe(201);
    expect((await post({ ...BODY, whatsapp: "+919800000003", name: "x".repeat(121) })).status).toBe(400);
    expect((await post({ ...BODY, whatsapp: "98123" })).status).toBe(400);
    expect((await post({ ...BODY, extra: 1 })).status).toBe(400);
    expect((await post("{not json")).status).toBe(400);
    expect((await post({ ...BODY, how: "y".repeat(20_000) })).status).toBe(413);
  });
  it("limits one address, and everyone together", async () => {
    ctx = testCtx(t.pool, () => now, { limits: { ...ctx.limits, enquiryIp: new Limiter(3, 3_600_000), enquiryAll: new Limiter(5, 3_600_000) } });
    for (let i = 0; i < 3; i++) expect((await post({ ...BODY, whatsapp: `+91990000010${i}` }, { ip: "203.0.113.9" })).status).toBe(201);
    expect((await post({ ...BODY, whatsapp: "+919900000109" }, { ip: "203.0.113.9" })).status).toBe(429);
    expect((await post({ ...BODY, whatsapp: "+919900000110" }, { ip: "203.0.113.10" })).status).toBe(201);
    expect((await post({ ...BODY, whatsapp: "+919900000111" }, { ip: "203.0.113.11" })).status).toBe(201);
    expect((await post({ ...BODY, whatsapp: "+919900000112" }, { ip: "203.0.113.12" })).status).toBe(429);
  });
});
```

- [ ] **Step 3: Run** `bash scratchpad/vt.sh apps/licence/src/server/enquiries.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 4: Implement** `context.ts` additions:

```ts
  /** ENQUIRY_TOKEN: the website's key to POST /v1/enquiries; null until set up (the intake answers 503). */
  enquiryToken: string | null;
```
in `limits`: `enquiryIp: Limiter; enquiryAll: Limiter;` and in `context()`:
```ts
    enquiryToken: secretFrom(env, "ENQUIRY_TOKEN"),
```
```ts
      enquiryIp: new Limiter(10, HOUR),
      enquiryAll: new Limiter(200, HOUR),
```
and the same three in `testCtx` (`enquiryToken: "test-enquiry-token-0123456789abcdef"`, `enquiryIp: new Limiter(10, HOUR)`, `enquiryAll: new Limiter(200, HOUR)`).

`enquiries.ts`:

```ts
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Ctx } from "./context";
import { clientIp, json, readCapped } from "./http";

export type Status = "new" | "contacted" | "demo_booked" | "won" | "not_a_fit";
export const STATUSES: Status[] = ["new", "contacted", "demo_booked", "won", "not_a_fit"];

const trimmed = (max: number) => z.string().trim().min(1).max(max);
export const enquirySchema = z
  .object({
    name: trimmed(120),
    business: trimmed(160),
    whatsapp: z.string().regex(/^\+[1-9][0-9]{6,14}$/, "A WhatsApp number with its country code."),
    email: z.email().max(254).nullish(),
    teamSize: z.enum(["1", "2-5", "6-20", "21+"]),
    how: z.string().trim().max(500).nullish(),
  })
  .strict();
const MAX_BODY = 8192;
const FOLD_MS = 10 * 60_000;

/** The same token, compared in constant time (hashes first, so lengths never matter). */
function tokenOk(given: string | null, want: string): boolean {
  if (!given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(want).digest();
  return timingSafeEqual(a, b);
}

/** POST /v1/enquiries (website spec §7): the website files an enquiry; the same number within ten minutes folds. */
export async function handleEnquiry(req: Request, ctx: Ctx): Promise<Response> {
  if (!ctx.enquiryToken)
    return json(503, { error: { code: "NOT_SET_UP", message: "Enquiries aren't set up on this server yet." } });
  const bearer = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? null;
  if (!tokenOk(bearer, ctx.enquiryToken))
    return json(401, { error: { code: "UNAUTHORIZED", message: "Not the website." } });
  const nowMs = ctx.now().getTime();
  for (const take of [ctx.limits.enquiryIp.take(clientIp(req), nowMs), ctx.limits.enquiryAll.take("all", nowMs)])
    if (!take.ok)
      return json(429, { error: { code: "LIMITED", message: "Too many enquiries just now." } }, { "retry-after": String(take.retryAfterS) });
  const text = await readCapped(req, MAX_BODY);
  if (text === null) return json(413, { error: { code: "TOO_LARGE", message: "Too large." } });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return json(400, { error: { code: "BAD_REQUEST", message: "Not JSON." } });
  }
  const p = enquirySchema.safeParse(raw);
  if (!p.success) return json(400, { error: { code: "BAD_REQUEST", message: p.error.issues[0]?.message ?? "Not an enquiry." } });
  const b = p.data;
  const now = new Date(nowMs);
  const recent = await ctx.db.query<{ id: string }>(
    "SELECT id FROM enquiries WHERE whatsapp = $1 AND created_at > $2 ORDER BY created_at DESC LIMIT 1",
    [b.whatsapp, new Date(nowMs - FOLD_MS)],
  );
  if (recent.rows[0]) {
    await ctx.db.query(
      `UPDATE enquiries SET name = $2, business = $3, email = $4, team_size = $5, how = coalesce($6, how), updated_at = $7 WHERE id = $1`,
      [recent.rows[0].id, b.name, b.business, b.email ?? null, b.teamSize, b.how || null, now],
    );
    return json(201, { id: recent.rows[0].id, folded: true });
  }
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO enquiries (name, business, whatsapp, email, team_size, how, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
    [b.name, b.business, b.whatsapp, b.email ?? null, b.teamSize, b.how || null, now],
  );
  return json(201, { id: rows[0]!.id });
}
```

`app/v1/enquiries/route.ts`:

```ts
import { handleEnquiry } from "@/server/enquiries";
import { context } from "@/server/context";

export const dynamic = "force-dynamic";

/** The website's enquiries (website spec §7). */
export function POST(req: Request): Promise<Response> {
  return handleEnquiry(req, context());
}
```

Check `testCtx` takes `over.limits` as a whole replacement (it spreads `...over` after `limits`), as the test passes the full `limits` object.

- [ ] **Step 5: Run** — Expected: PASS 6/6; then `bash scratchpad/vt.sh apps/licence` — the whole licence suite still passes (the migration test, if one lists tables, gains `enquiries`).
- [ ] **Step 6: Commit** `git commit -m "feat(licence): enquiries from the website — a token-guarded intake, limited, folding repeats"`

### Task 2: Reading and working enquiries in the panel

**Files:**
- Modify: `apps/licence/src/server/enquiries.ts` (`listEnquiries`, `getEnquiry`, `patchEnquiry`, `patchEnquirySchema`, `newCount`)
- Modify: `apps/licence/src/server/api.ts` (routes)
- Create: `apps/licence/src/components/EnquiriesScreen.tsx`, `apps/licence/src/components/EnquiryScreen.tsx`
- Create: `apps/licence/src/app/(panel)/enquiries/page.tsx`, `apps/licence/src/app/(panel)/enquiries/[id]/page.tsx`
- Modify: `apps/licence/src/components/Shell.tsx` (NAV entry "Enquiries" with icon, first after Clients; a count badge of new ones)
- Test: `apps/licence/src/server/enquiries.test.ts` (API), `apps/licence/src/components/panel.test.tsx` (screens)

**Interfaces:**
- Consumes: Task 1's table and types.
- Produces: `GET /api/enquiries?status=<Status|all>` → `{ enquiries: Enquiry[]; newCount: number }`; `GET /api/enquiries/:id` → `{ enquiry: Enquiry }`; `PATCH /api/enquiries/:id` body `{ status?: Status; notes?: string; expectedUpdatedAt: string }` → `{ enquiry: Enquiry }` or 409 `{ error: { code: "CHANGED", message: "Changed elsewhere — reload to see it." } }`.

- [ ] **Step 1: Failing API tests** (append; use the file's `Jar` admin session like clients.test.ts)

```ts
describe("the panel's enquiries", () => {
  it("lists newest first with the count of new ones, filters by status", async () => {
    const r = await admin.call("GET", "/api/enquiries?status=all");
    expect(r.status).toBe(200);
    const d = r.data as { enquiries: { createdAt: string; status: string }[]; newCount: number };
    expect(d.enquiries.map((e) => e.createdAt)).toEqual([...d.enquiries.map((e) => e.createdAt)].sort().reverse());
    expect(d.newCount).toBe(d.enquiries.filter((e) => e.status === "new").length);
    const onlyNew = (await admin.call("GET", "/api/enquiries?status=new")).data as { enquiries: { status: string }[] };
    expect(onlyNew.enquiries.every((e) => e.status === "new")).toBe(true);
  });
  it("sets a status and notes; a stale save is refused in words", async () => {
    const list = (await admin.call("GET", "/api/enquiries?status=all")).data as { enquiries: { id: string; updatedAt: string }[] };
    const e = list.enquiries[0]!;
    const ok = await admin.call("PATCH", `/api/enquiries/${e.id}`, { status: "contacted", notes: "Called, demo Thursday", expectedUpdatedAt: e.updatedAt });
    expect(ok.status).toBe(200);
    const stale = await admin.call("PATCH", `/api/enquiries/${e.id}`, { status: "won", expectedUpdatedAt: e.updatedAt });
    expect(stale.status).toBe(409);
    expect((stale.data as { error: { code: string } }).error.code).toBe("CHANGED");
  });
  it("is the admin's alone", async () => {
    const r = await handleApi(new Request("https://licence.test/api/enquiries"), ctx);
    expect(r.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL (404s).

- [ ] **Step 3: Implement** in `enquiries.ts`:

```ts
type Row = { id: string; created_at: Date; name: string; business: string; whatsapp: string; email: string | null; team_size: string; how: string | null; source: "website"; status: Status; notes: string; updated_at: Date };
const view = (r: Row): Enquiry => ({ id: r.id, createdAt: r.created_at.toISOString(), name: r.name, business: r.business, whatsapp: r.whatsapp, email: r.email, teamSize: r.team_size, how: r.how, source: r.source, status: r.status, notes: r.notes, updatedAt: r.updated_at.toISOString() });

export async function listEnquiries(ctx: Ctx, status: Status | "all") {
  const { rows } = await ctx.db.query<Row>(
    `SELECT * FROM enquiries WHERE ($1 = 'all' OR status = $1) ORDER BY created_at DESC LIMIT 500`, [status]);
  const n = await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM enquiries WHERE status = 'new'");
  return { enquiries: rows.map(view), newCount: n.rows[0]!.n };
}
export async function getEnquiry(ctx: Ctx, id: string) {
  const { rows } = await ctx.db.query<Row>("SELECT * FROM enquiries WHERE id = $1", [id]);
  if (!rows[0]) throw new Refusal(404, "No such enquiry.");
  return { enquiry: view(rows[0]) };
}
export const patchEnquirySchema = z
  .object({ status: z.enum(STATUSES).optional(), notes: z.string().max(5000).optional(), expectedUpdatedAt: z.iso.datetime() })
  .strict();
export async function patchEnquiry(ctx: Ctx, id: string, p: z.infer<typeof patchEnquirySchema>) {
  const { rows } = await ctx.db.query<Row>(
    `UPDATE enquiries SET status = coalesce($2, status), notes = coalesce($3, notes), updated_at = $4
      WHERE id = $1 AND updated_at = $5 RETURNING *`,
    [id, p.status ?? null, p.notes ?? null, ctx.now(), p.expectedUpdatedAt]);
  if (rows[0]) return { enquiry: view(rows[0]) };
  await getEnquiry(ctx, id); // 404 if it's gone
  throw new Refusal(409, "Changed elsewhere — reload to see it.", "CHANGED");
}
```

(Check `Refusal`'s constructor in `clients.ts`; if it takes no code, add an optional third `code` parameter defaulting to its current code — one line, with the existing tests unchanged.) Import `Refusal` from `./clients` and `type Enquiry` from this file.

Routes in `api.ts` (beside payments):

```ts
route("GET", "/api/enquiries", ({ ctx, url }) => {
  const s = url.searchParams.get("status") ?? "all";
  if (s !== "all" && !STATUSES.includes(s as Status)) throw new Refusal(400, "Not a status.");
  return listEnquiries(ctx, s as Status | "all");
});
route("GET", "/api/enquiries/:id", ({ ctx, params }) => getEnquiry(ctx, params.id!));
route("PATCH", "/api/enquiries/:id", ({ ctx, params, body }) => patchEnquiry(ctx, params.id!, parse(patchEnquirySchema, body)));
```

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Failing screen test** (panel.test.tsx, the file's existing fetch-mock pattern)

```tsx
it("Enquiries: newest first, the status in words, and WhatsApp opens the owner's own app", async () => {
  mockApi({ "/api/enquiries?status=all": { enquiries: [ENQ], newCount: 1 } });
  render(<EnquiriesScreen />);
  expect(await screen.findByRole("link", { name: /Ananya Rao/ })).toHaveAttribute("href", `/enquiries/${ENQ.id}`);
  expect(screen.getByText("New")).toBeInTheDocument();
  expect(screen.getByText("Petal & Plate Studio")).toBeInTheDocument();
});
it("an enquiry: set the status, keep notes, message on WhatsApp", async () => {
  mockApi({ [`/api/enquiries/${ENQ.id}`]: { enquiry: ENQ } });
  render(<EnquiryScreen id={ENQ.id} />);
  expect(await screen.findByRole("link", { name: "WhatsApp" })).toHaveAttribute("href", "https://wa.me/919812345678");
  await userEvent.click(screen.getByRole("radio", { name: "Contacted" }));
  expect(lastPatch()).toMatchObject({ status: "contacted", expectedUpdatedAt: ENQ.updatedAt });
});
```

(`ENQ` = the Task 1 body as an `Enquiry` with `status: "new"`; `mockApi`/`lastPatch` follow the helpers already in panel.test.tsx — reuse them, or add small ones beside them.)

- [ ] **Step 6: Implement the screens** — follow `PaymentsScreen.tsx` exactly for structure (`Head` with title and sub, `.body`, `.card`, `table.list`), and `ClientScreen.tsx` for a detail page:
  - **EnquiriesScreen:** Head "Enquiries", sub "Who asked for a demo on lumecrm.in, newest first."; a status filter as a radio group (All, New, Contacted, Demo booked, Won, Not a fit — `roving()` keyboard like LUME's); table columns: When (`day()`), Name (link), Business, Team, WhatsApp, Status (a pill: New blue, Contacted sky, Demo booked LUME blue — the panel's existing pill tokens, never violet, Won green, Not a fit grey); empty state "No enquiries yet. They arrive here from lumecrm.in."
  - **EnquiryScreen:** name as title, business as sub; details (WhatsApp, email, team, how, when); the status radio group (saves at once, `expectedUpdatedAt`; on 409 shows the message and a Reload button); Notes textarea saving on blur with "Saved" toast; buttons: WhatsApp (`https://wa.me/<digits>`), Email (`mailto:`), both `<a>` styled as the panel's buttons.
  - **Shell:** NAV gains `["enquiries", "Enquiries"]` after Clients, icon an envelope (`<path d="M2 4.5h12v8H2zM2 4.5l6 4.5 6-4.5" />`); the link shows the new count from `GET /api/enquiries?status=new` (refreshed on the panel's `CHANGED` event).
  - Pages: `export const metadata = { title: "Enquiries · LUME Licences" }` and the detail page passes `params.id`.

- [ ] **Step 7: Run** `bash scratchpad/vt.sh apps/licence` — Expected: PASS; then `pnpm lint` and `pnpm -r typecheck` (exit 0).
- [ ] **Step 8: Commit** `git commit -m "feat(licence): Enquiries — newest first, a status and notes, WhatsApp and email one tap away"`

### Task 3: Turn it on at license.lumecrm.in

**Files:**
- Modify: `infra/licence/docker-compose.yml` (app: `ENQUIRY_TOKEN_FILE: /run/secrets/enquiry.token`, volume `./secrets/enquiry.token:/run/secrets/enquiry.token:ro`)
- Modify: `docs/runbooks/licence-server.md` (a section "Enquiries from the website": the token file, rotating it, where it goes in Vercel)

- [ ] **Step 1:** Compose + runbook edits; commit `git commit -m "ops(licence): the enquiry token, mounted like the other secrets"`.
- [ ] **Step 2: Generate the token on the server, never printed:**
  `ssh lumedev 'umask 077; test -s /root/lume-licence/secrets/enquiry.token || openssl rand -hex 32 > /root/lume-licence/secrets/enquiry.token; wc -c < /root/lume-licence/secrets/enquiry.token'` — Expected: `65`.
- [ ] **Step 3: Rebuild and restart the licence server** the way the runbook's "Upgrading" section says (image from this commit; `docker compose run --rm migrate` applies 0003), then verify: `curl -s -o /dev/null -w '%{http_code}' -X POST https://license.lumecrm.in/v1/enquiries` → `401`; `https://license.lumecrm.in/healthz` → 200; the client's site `127.0.0.1:3000` → 200.
- [ ] **Step 4:** The website's Vercel env gets the token in W3 Task 9 — piped from the server file straight into `vercel env add ENQUIRY_TOKEN production` without being printed.
