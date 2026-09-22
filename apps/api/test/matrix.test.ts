import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_GRANTS, PERMISSIONS, can, effectivePermissions, newId, type Grant } from "@lume/core";
import { createHarness, type Harness, type SeededUser } from "./harness";
import { PROBES, type Access, type Fixtures } from "./probes";

/**
 * Report §7.5: every /api/v1 route is called as every kind of actor, and the answer must match the
 * route's declaration. "Denied" means exactly: 401 for the signed-out caller, 403 FORBIDDEN for a
 * signed-in one. Any other outcome (200, 400, 404, 409, a business 403 such as OWNER_PROTECTED or
 * ESCALATION) proves the request got past the access check, which is what "allowed" means here.
 */
type Who = { name: string; grants: Grant[] | null; owner?: boolean };

// A deterministic, arbitrary slice of the catalog (every third permission, narrowest scope).
const sparse: Grant[] = PERMISSIONS.filter((_, i) => i % 3 === 0).map((p) => ({
  key: p.key,
  scope: p.scoped ? "own" : null,
}));
const ACTORS: Who[] = [
  { name: "signed-out", grants: null },
  { name: "no-permissions", grants: [] },
  {
    name: "sales",
    grants: [
      { key: "leads.view", scope: "own" },
      { key: "templates.use", scope: null },
    ],
  },
  { name: "sparse-role", grants: sparse },
  { name: "admin", grants: ALL_GRANTS },
  { name: "owner", grants: [], owner: true },
];

let h: Harness;
let fx: Fixtures;
const users = new Map<string, SeededUser>();

beforeAll(async () => {
  h = await createHarness();
  const target = await h.seedUser({ grants: [] });
  const { rows } = await h.pool.query<{ id: string }>(
    "INSERT INTO roles (id, name) VALUES (gen_random_uuid(), 'Matrix role') RETURNING id",
  );
  fx = {
    userId: target.id,
    roleId: rows[0]!.id,
    teamId: await h.seedTeam(target.id, []),
    inviteToken: "y".repeat(43),
    ...(await configFixtures(target.id)),
  };
  for (const a of ACTORS) {
    // Everyone who could need two-step sign-in has it, so the 2FA gate never masks the permission check.
    if (a.grants !== null)
      users.set(a.name, await h.seedUser({ grants: a.grants, owner: a.owner, totp: true }));
  }
});
afterAll(async () => h.close());

/** Phase 1B fixtures, written straight to the configuration tables (no RLS there) and via seedLead. */
async function configFixtures(ownerId: string) {
  const cfg = await h.config();
  const q = async (sql: string, params: unknown[]) =>
    (await h.ownerPool.query<{ id: string }>(sql, params)).rows[0]!.id;
  const pipeline = async (name: string) => {
    const id = await q("INSERT INTO pipelines (id, name) VALUES ($1, $2) RETURNING id", [newId(), name]);
    for (const [i, [n, kind]] of [
      ["New", "open"],
      ["Won", "won"],
      ["Lost", "lost"],
    ].entries()) {
      await h.ownerPool.query(
        "INSERT INTO stages (id, pipeline_id, name, kind, position) VALUES ($1, $2, $3, $4, $5)",
        [newId(), id, n, kind, i],
      );
    }
    return id;
  };
  const pipelineId = await pipeline("Matrix P2");
  const field = (key: string) =>
    q(
      "INSERT INTO field_definitions (id, key, label, type, position) VALUES ($1, $2, $2, 'text', 90) RETURNING id",
      [newId(), key],
    );
  return {
    leadId: await h.seedLead({ ownerId }),
    leadToDelete: await h.seedLead({ ownerId }),
    pipelineId,
    pipelineToArchive: await pipeline("Matrix P3"),
    stageId: cfg.stages.New!,
    stageToArchive: await q(
      "INSERT INTO stages (id, pipeline_id, name, kind, position) VALUES ($1, $2, 'Doomed', 'open', 9) RETURNING id",
      [newId(), pipelineId],
    ),
    fieldId: await field("matrix_field"),
    fieldToArchive: await field("matrix_doomed"),
    lostReasonId: cfg.lostReasons[0]!,
    lostReasonToArchive: await q(
      "INSERT INTO lost_reasons (id, label) VALUES ($1, 'Matrix doomed') RETURNING id",
      [newId()],
    ),
    tagId: await q("INSERT INTO tags (id, label) VALUES ($1, 'Matrix') RETURNING id", [newId()]),
    tagToDelete: await q("INSERT INTO tags (id, label) VALUES ($1, 'Matrix doomed') RETURNING id", [newId()]),
    productId: await q("INSERT INTO products (id, name) VALUES ($1, 'Matrix product') RETURNING id", [
      newId(),
    ]),
    productToArchive: await q("INSERT INTO products (id, name) VALUES ($1, 'Matrix doomed') RETURNING id", [
      newId(),
    ]),
  };
}

const apiRoutes = () => h.app.lumeRoutes.filter((r) => r.url.startsWith("/api/v1/"));
const key = (r: { method: string; url: string }) => `${r.method} ${r.url}`;

/** From the independent access table in probes.ts, never from the route's own declaration. */
function expectedAllowed(access: Access, who: Who): boolean {
  if (access === "public") return true;
  if (who.grants === null) return false;
  if (access === "auth.self") return true;
  const p = access;
  const actor = {
    userId: "x",
    isOwner: Boolean(who.owner),
    perms: effectivePermissions(who.grants),
    teamMemberIds: [],
    twoFactorEnabled: true,
    roleIds: [],
  };
  return can(actor, p);
}

describe("access matrix (report §7.5)", () => {
  it("every /api/v1 route has a probe, and every probe still matches a route", () => {
    const routes = new Set(apiRoutes().map(key));
    expect([...routes].filter((k) => !(k in PROBES))).toEqual([]);
    expect(Object.keys(PROBES).filter((k) => !routes.has(k))).toEqual([]);
  });

  it("every route declares exactly the access the table requires", () => {
    const drift = apiRoutes()
      .map((r) => ({ k: key(r), declared: r.config.public ? "public" : (r.config.permission ?? "(none)") }))
      .filter(({ k, declared }) => PROBES[k] && PROBES[k].access !== declared)
      .map(({ k, declared }) => `${k}: declares ${declared}, table says ${PROBES[k]!.access}`);
    expect(drift).toEqual([]);
  });

  it("every route answers each actor as the table says", async () => {
    const failures: string[] = [];
    for (const route of apiRoutes()) {
      const probe = PROBES[key(route)]!;
      for (const who of ACTORS) {
        const url = (probe.path ? probe.path(fx) : route.url) + (probe.query ? `?${probe.query}` : "");
        const req = {
          method: route.method as "GET",
          url,
          ...(probe.body ? { payload: probe.body(fx) as object } : {}),
        };
        const user = users.get(who.name);
        // A fresh session per call: probing /auth/logout must not sign the actor out of the rest.
        const res = user
          ? await (await h.signIn(user)).inject(req)
          : await h.app.inject({ ...req, ...(await h.csrf()) });
        const code =
          res.statusCode >= 400 ? (res.json() as { error?: { code?: string } }).error?.code : undefined;
        const denied = res.statusCode === 401 || (res.statusCode === 403 && code === "FORBIDDEN");
        const allowed = expectedAllowed(probe.access, who);
        const correct =
          probe.access === "public"
            ? res.statusCode < 500 && code !== "FORBIDDEN" // wrong password/token answers are the route working
            : allowed
              ? !denied
              : who.grants === null
                ? res.statusCode === 401
                : res.statusCode === 403 && code === "FORBIDDEN";
        if (!correct)
          failures.push(
            `${key(route)} as ${who.name} → ${res.statusCode} ${code ?? ""} (expected ${allowed ? "allowed" : "denied"})`,
          );
      }
    }
    expect(failures).toEqual([]);
  });
});
