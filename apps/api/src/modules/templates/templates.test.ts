import { ALL_GRANTS, newId, type Grant } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";

let h: Harness;
let manager: AuthedClient;
let rep: AuthedClient;
let repRole: string;
const repGrants: Grant[] = [
  { key: "leads.view", scope: "own" },
  { key: "templates.use", scope: null },
];

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  manager = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
  const r = await h.seedUser({ grants: repGrants, totp: true });
  rep = await h.signIn(r);
  repRole = (
    await h.queryAll<{ role_id: string }>("SELECT role_id FROM user_roles WHERE user_id = $1", [r.id])
  )[0]!.role_id;
});
afterAll(() => h.close());

const list = async (c: AuthedClient) =>
  (await c.inject({ method: "GET", url: "/api/v1/templates" })).json().templates as {
    id: string;
    name: string;
    category: string;
    body: string;
    versionId: string;
    allowedRoleIds: string[];
    usable: boolean;
  }[];
const create = (body: Record<string, unknown>) =>
  manager.inject({ method: "POST", url: "/api/v1/templates", payload: body });

describe("templates (4A Task 3)", () => {
  it("the starters are there for everyone who can use templates", async () => {
    const t = await list(rep);
    expect(t).toHaveLength(6);
    expect(t[0]).toMatchObject({ name: "First hello", category: "first_touch", usable: true });
  });

  it("a template for one role is seen by that role and by managers, and not by others", async () => {
    const other = newId();
    await h.ownerPool.query("INSERT INTO roles (id, name) VALUES ($1, 'Partners')", [other]);
    const r = await create({
      name: "Partners only",
      category: "custom",
      body: "Hi {{lead.first_name}}",
      allowedRoleIds: [other],
    });
    expect(r.statusCode).toBe(201);
    expect((await list(rep)).some((x) => x.name === "Partners only")).toBe(false);
    expect((await list(manager)).find((x) => x.name === "Partners only")).toMatchObject({
      allowedRoleIds: [other],
    });
    const mine = await create({
      name: "Reps only",
      category: "custom",
      body: "Hello",
      allowedRoleIds: [repRole],
    });
    expect(mine.statusCode).toBe(201);
    expect((await list(rep)).some((x) => x.name === "Reps only")).toBe(true);
  });

  it("an edit to the words is a new version; the old one still reads", async () => {
    const t = (await create({ name: "Versioned", category: "follow_up", body: "Version one" })).json();
    const r = await manager.inject({
      method: "PATCH",
      url: `/api/v1/templates/${t.id}`,
      payload: { body: "Version two" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ body: "Version two" });
    expect(r.json().versionId).not.toBe(t.versionId);
    const [old] = await h.queryAll<{ body: string }>("SELECT body FROM template_versions WHERE id = $1", [
      t.versionId,
    ]);
    expect(old!.body).toBe("Version one");
    const renamed = await manager.inject({
      method: "PATCH",
      url: `/api/v1/templates/${t.id}`,
      payload: { name: "Renamed" },
    });
    expect(renamed.json().versionId).toBe(r.json().versionId); // a name change isn't a new version
  });

  it("archived templates leave the list; their versions stay", async () => {
    const t = (await create({ name: "Short lived", category: "custom", body: "Bye" })).json();
    expect(
      (await manager.inject({ method: "POST", url: `/api/v1/templates/${t.id}/archive` })).statusCode,
    ).toBe(200);
    expect((await list(manager)).some((x) => x.id === t.id)).toBe(false);
    expect(await h.queryAll("SELECT 1 FROM template_versions WHERE id = $1", [t.versionId])).toHaveLength(1);
    expect((await create({ name: "Short lived", category: "custom", body: "Again" })).statusCode).toBe(201); // name free again
  });

  it("the order is the manager's", async () => {
    const ids = (await list(manager)).map((x) => x.id).reverse();
    expect(
      (await manager.inject({ method: "PUT", url: "/api/v1/templates/order", payload: { ids } })).statusCode,
    ).toBe(200);
    expect((await list(manager)).map((x) => x.id)).toEqual(ids);
  });

  it("refused in words: a name taken, an empty body, a role that doesn't exist; and only managers write", async () => {
    const msg = async (body: Record<string, unknown>) => (await create(body)).json().error?.message;
    expect(await msg({ name: "First hello", category: "custom", body: "x" })).toBe(
      "A template with that name already exists",
    );
    expect((await create({ name: "Empty", category: "custom", body: "" })).statusCode).toBe(400);
    expect(await msg({ name: "Ghost", category: "custom", body: "x", allowedRoleIds: [newId()] })).toBe(
      "One of those roles doesn't exist",
    );
    expect(
      (
        await rep.inject({
          method: "POST",
          url: "/api/v1/templates",
          payload: { name: "Mine", category: "custom", body: "x" },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("each change is in the audit log", async () => {
    const actions = (
      await h.queryAll<{ action: string }>(
        "SELECT DISTINCT action FROM audit_log WHERE action LIKE 'template.%'",
      )
    )
      .map((a) => a.action)
      .sort();
    expect(actions).toEqual([
      "template.archived",
      "template.created",
      "template.reordered",
      "template.updated",
    ]);
  });
});

describe("templates: what the screens need (4A Task 5)", () => {
  it("each template says which version it's on", async () => {
    const t = (await create({ name: "Counted", category: "custom", body: "One" })).json();
    expect(t.version).toBe(1);
    const r = await manager.inject({
      method: "PATCH",
      url: `/api/v1/templates/${t.id}`,
      payload: { body: "Two" },
    });
    expect(r.json().version).toBe(2);
  });

  it("an archived template can be put back (Archive has an undo)", async () => {
    const t = (await create({ name: "Undo me", category: "custom", body: "Hi" })).json();
    await manager.inject({ method: "POST", url: `/api/v1/templates/${t.id}/archive` });
    const r = await manager.inject({ method: "POST", url: `/api/v1/templates/${t.id}/restore` });
    expect(r.statusCode).toBe(200);
    expect((await list(manager)).some((x) => x.id === t.id)).toBe(true);
    await create({ name: "Taken now", category: "custom", body: "x" });
    const t2 = (await create({ name: "Taken later", category: "custom", body: "x" })).json();
    await manager.inject({ method: "POST", url: `/api/v1/templates/${t2.id}/archive` });
    await manager.inject({
      method: "PATCH",
      url: `/api/v1/templates/${t.id}`,
      payload: { name: "Taken later" },
    });
    const clash = await manager.inject({ method: "POST", url: `/api/v1/templates/${t2.id}/restore` });
    expect(clash.json().error.message).toBe("A template with that name already exists");
  });

  it("managers get the roles to choose from; people who only use templates don't", async () => {
    const m = (await manager.inject({ method: "GET", url: "/api/v1/templates" })).json();
    expect(m.roles.length).toBeGreaterThan(0);
    expect(m.roles[0]).toEqual({ id: expect.any(String), name: expect.any(String) });
    expect((await rep.inject({ method: "GET", url: "/api/v1/templates" })).json().roles).toBeUndefined();
  });

  it("two at once with the same name: one is made, the other is told the name is taken (never a 500)", async () => {
    const body = { name: "Twin", category: "follow_up", body: "Hello" };
    const [x, y] = await Promise.all([create(body), create(body)]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([201, 409]);
    const twin = (await list(manager)).find((t) => t.name === "Twin")!;
    await manager.inject({ method: "POST", url: `/api/v1/templates/${twin.id}/archive` });
    await create(body);
    const [p, q] = await Promise.all([
      manager.inject({ method: "POST", url: `/api/v1/templates/${twin.id}/restore` }),
      manager.inject({ method: "POST", url: `/api/v1/templates/${twin.id}/restore` }),
    ]);
    expect([p.statusCode, q.statusCode]).toEqual([409, 409]);
  });

  it("reorder: a template added meanwhile keeps its place at the end; two at once never mix", async () => {
    const before = (await list(manager)).map((t) => t.id);
    const added = (await create({ name: "Added Meanwhile", category: "follow_up", body: "Hi" })).json()
      .id as string;
    const put = (ids: string[]) =>
      manager.inject({ method: "PUT", url: "/api/v1/templates/order", payload: { ids } });
    const r = await put([...before].reverse());
    expect(r.statusCode).toBe(200);
    expect((await list(manager)).map((t) => t.id)).toEqual([...[...before].reverse(), added]);
    const all = (await list(manager)).map((t) => t.id);
    const one = [...all].reverse();
    const two = [...all.slice(1), all[0]!];
    await Promise.all([put(one), put(two)]);
    const final = (await list(manager)).map((t) => t.id);
    expect([JSON.stringify(one), JSON.stringify(two)]).toContain(JSON.stringify(final));
  });
});
