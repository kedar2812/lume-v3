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
