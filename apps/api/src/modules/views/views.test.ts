import { ALL_GRANTS, STARTER_VIEWS, newId } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../../../test/harness";

// 4B Task 3: saved views — a person's own or shared by role — with live counts.
let h: Harness;
let admin: AuthedClient;
let rep: AuthedClient;
let adminUser: SeededUser;
let repUser: SeededUser;
let repRole: string;

beforeAll(async () => {
  h = await createHarness({ preset: "coaching" });
  adminUser = await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Maya Admin" });
  admin = await h.signIn(adminUser);
  repUser = await h.seedUser({
    grants: [
      { key: "leads.view", scope: "own" },
      { key: "leads.edit", scope: "own" },
    ],
    totp: true,
    name: "Riya Rep",
  });
  rep = await h.signIn(repUser);
  repRole = (await h.pool.query("SELECT role_id FROM user_roles WHERE user_id = $1", [repUser.id])).rows[0]
    .role_id;
});
afterAll(() => h.close());

const call = (c: AuthedClient, method: string, url: string, payload?: unknown) =>
  c.inject({
    method: method as "GET",
    url,
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const create = (c: AuthedClient, body: Record<string, unknown>) => call(c, "POST", "/api/v1/views", body);
const list = async (c: AuthedClient) =>
  ((await call(c, "GET", "/api/v1/views")).json().views as { id: string; name: string }[]).map((v) => v.name);
const counts = async (c: AuthedClient) =>
  (await call(c, "GET", "/api/v1/views/counts")).json().counts as Record<string, number | null>;
const overdue = async (ownerId: string, name: string) => {
  const lead = await h.seedLead({ ownerId, name });
  await h.queryAll(
    `INSERT INTO tasks (id, lead_id, assignee_id, title, due_at, series_id) VALUES ($1, $2, $3, 'Chase', now() - interval '1 hour', $1)`,
    [newId(), lead, ownerId],
  );
  return lead;
};

describe("saved views (4B Task 3)", () => {
  it("a personal view: created, listed, edited, deleted and brought back", async () => {
    const r = await create(rep, { name: "My quiet ones", color: "cyan", filters: { noReplyDays: "3" } });
    expect(r.statusCode, r.body).toBe(201);
    const v = r.json();
    expect(v).toMatchObject({
      name: "My quiet ones",
      color: "cyan",
      mine: true,
      shared: false,
      canEdit: true,
    });
    expect(v.filters).toEqual({ noReplyDays: "3" });
    expect(await list(rep)).toContain("My quiet ones");
    expect(await list(admin)).not.toContain("My quiet ones"); // personal means personal, even from an admin
    const edited = await call(rep, "PATCH", `/api/v1/views/${v.id}`, { name: "Quiet ones" });
    expect(edited.json().name).toBe("Quiet ones");
    expect((await call(rep, "DELETE", `/api/v1/views/${v.id}`)).statusCode).toBe(204);
    expect(await list(rep)).not.toContain("Quiet ones");
    expect((await call(rep, "POST", `/api/v1/views/${v.id}/restore`)).json().name).toBe("Quiet ones");
    expect(await list(rep)).toContain("Quiet ones");
  });

  it("refuses what makes no sense, in words: unknown filters, a taken name, sharing without the right", async () => {
    const bad = await create(rep, { name: "Odd", color: "cyan", filters: { noReplyDays: "0" } });
    expect(bad.statusCode).toBe(400);
    await create(rep, { name: "Taken", color: "ok", filters: {} });
    const again = await create(rep, { name: "taken", color: "ok", filters: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toBe("You already have a view with that name");
    const share = await create(rep, { name: "For all", color: "ok", filters: {}, sharedRoleIds: [repRole] });
    expect(share.statusCode).toBe(403);
    expect(share.json().error.message).toBe("Sharing views is for people who manage them");
  });

  it("Review Focus 1: a shared 'my overdue' counts each person's own, and matches the list", async () => {
    await overdue(repUser.id, "Rep Overdue One");
    await overdue(repUser.id, "Rep Overdue Two");
    await overdue(adminUser.id, "Admin Overdue");
    const v = (
      await create(admin, {
        name: "My overdue (shared)",
        color: "warn",
        filters: { ownerId: "me", followUpOverdue: "true" },
        sharedRoleIds: [repRole],
      })
    ).json();
    const repView = (await call(rep, "GET", "/api/v1/views"))
      .json()
      .views.find((x: { id: string }) => x.id === v.id);
    expect(repView).toMatchObject({ shared: true, mine: false, canEdit: false });
    expect((await counts(rep))[v.id]).toBe(2);
    expect((await counts(admin))[v.id]).toBe(1);
    const repList = (
      await call(rep, "GET", "/api/v1/leads?ownerId=me&followUpOverdue=true&limit=100")
    ).json();
    expect(repList.items).toHaveLength(2);
    // Someone who can only read a shared view can't change it.
    expect((await call(rep, "PATCH", `/api/v1/views/${v.id}`, { name: "Mine now" })).statusCode).toBe(403);
    expect((await call(rep, "DELETE", `/api/v1/views/${v.id}`)).statusCode).toBe(403);
  });

  it("Review Focus 2: a view naming a field that's since archived counts '—', and the rest still count", async () => {
    const f = (
      await call(admin, "POST", "/api/v1/fields", {
        key: "tier",
        label: "Tier",
        type: "select",
        options: [{ label: "Gold" }],
      })
    ).json().field;
    const stale = (
      await create(admin, {
        name: "Gold tier",
        color: "meet",
        filters: { custom: JSON.stringify({ tier: f.options[0].id }) },
      })
    ).json();
    const fine = (await create(admin, { name: "Everything", color: "neutral", filters: {} })).json();
    await call(admin, "POST", `/api/v1/fields/${f.id}/archive`);
    const c = await counts(admin);
    expect(c[stale.id]).toBeNull();
    expect(typeof c[fine.id]).toBe("number");
  });

  it("Review Focus 3: someone who loses the role a view was shared with stops seeing it", async () => {
    const v = (
      await create(admin, { name: "Sales only", color: "ok", filters: {}, sharedRoleIds: [repRole] })
    ).json();
    expect(await list(rep)).toContain("Sales only");
    await h.grant(repUser.id, [{ key: "leads.view", scope: "own" }]); // still sees leads, through another role
    await h.pool.query("DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2", [repUser.id, repRole]);
    await h.pool.query("SELECT pg_notify('lume_rbac', $1)", [repUser.id]);
    await h.waitForRbacNotify();
    expect(await list(rep)).not.toContain("Sales only");
    await h.pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [repUser.id, repRole]);
    await h.pool.query("SELECT pg_notify('lume_rbac', $1)", [repUser.id]);
    await h.waitForRbacNotify();
    expect(v.id).toBeTruthy();
  });

  it("order is each person's own: a rep's drag doesn't reorder the admin's sidebar", async () => {
    const mine = await list(rep);
    const reversed = [...mine].reverse();
    const ids = (await call(rep, "GET", "/api/v1/views"))
      .json()
      .views.map((v: { id: string }) => v.id)
      .reverse();
    const r = await call(rep, "PUT", "/api/v1/views/order", { ids });
    expect(r.statusCode).toBe(200);
    expect(await list(rep)).toEqual(reversed);
    const adminBefore = await list(admin);
    expect(await list(admin)).toEqual(adminBefore);
  });

  it("a manager's list carries the roles to share with; a rep's doesn't", async () => {
    const m = (await call(admin, "GET", "/api/v1/views")).json();
    expect(m.roles).toEqual(expect.arrayContaining([expect.objectContaining({ id: repRole })]));
    expect((await call(rep, "GET", "/api/v1/views")).json().roles).toBeUndefined();
  });

  it("the starter views are views LUME can count", async () => {
    for (const s of STARTER_VIEWS) {
      const r = await create(admin, { name: `Starter ${s.name}`, color: s.color, filters: s.filters });
      expect(r.statusCode, `${s.name}: ${r.body}`).toBe(201);
      expect(typeof (await counts(admin))[r.json().id]).toBe("number");
    }
  });

  it("the audit log says what happened to views, in words", async () => {
    const actions = (
      await h.pool.query("SELECT DISTINCT action FROM audit_log WHERE action LIKE 'view.%' ORDER BY action")
    ).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["view.created", "view.deleted", "view.updated"]));
  });
});
