import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";

let h: Harness;
let admin: AuthedClient;
beforeAll(async () => {
  h = await createHarness({ preset: "coaching" });
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
});
afterAll(async () => h.close());

describe("field definitions (report §6)", () => {
  it("creates a custom field with stable option ids and bumps the definitions version", async () => {
    const v0 = (await h.pool.query("SELECT field_defs_version v FROM settings")).rows[0].v;
    const f = (
      await admin.inject({
        method: "POST",
        url: "/api/v1/fields",
        payload: {
          key: "budget_band",
          label: "Budget band",
          type: "select",
          options: [{ label: "Low" }, { label: "High", color: "ok" }],
        },
      })
    ).json().field;
    expect(f).toMatchObject({ key: "budget_band", type: "select", isCore: false });
    expect(f.options).toHaveLength(2);
    expect((await h.pool.query("SELECT field_defs_version v FROM settings")).rows[0].v).toBe(v0 + 1);

    // Renaming an option keeps its id; dropping one from the list archives it instead of deleting it.
    const [low, high] = f.options;
    const patched = (
      await admin.inject({
        method: "PATCH",
        url: `/api/v1/fields/${f.id}`,
        payload: { options: [{ id: low.id, label: "Small" }, { label: "Medium" }] },
      })
    ).json().field;
    expect(patched.options.find((o: { id: string }) => o.id === low.id).label).toBe("Small");
    expect(patched.options.find((o: { id: string }) => o.id === high.id).archived).toBe(true);
    expect(patched.options).toHaveLength(3);
  });

  it("refuses core keys, duplicates, type changes and archiving core fields", async () => {
    expect(
      (
        await admin.inject({
          method: "POST",
          url: "/api/v1/fields",
          payload: { key: "phone", label: "x", type: "text" },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await admin.inject({
          method: "POST",
          url: "/api/v1/fields",
          payload: { key: "struggles", label: "x", type: "text" },
        })
      ).statusCode,
    ).toBe(409);
    const cfg = await h.config();
    expect(
      (
        await admin.inject({
          method: "PATCH",
          url: `/api/v1/fields/${cfg.fields.struggles}`,
          payload: { type: "text" },
        })
      ).json().error.code,
    ).toBe("TYPE_IMMUTABLE");
    expect(
      (await admin.inject({ method: "POST", url: `/api/v1/fields/${cfg.fields.phone}/archive` })).json().error
        .code,
    ).toBe("CORE_FIELD");
    expect(
      (
        await admin.inject({
          method: "PATCH",
          url: `/api/v1/fields/${cfg.fields.phone}`,
          payload: { label: "Mobile" },
        })
      ).json().field.label,
    ).toBe("Mobile");
  });

  it("hides fields a role can't see from that role's field list", async () => {
    const cfg = await h.config();
    const rep = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] });
    const {
      rows: [role],
    } = await h.pool.query("SELECT role_id FROM user_roles WHERE user_id = $1", [rep.id]);
    const put = await admin.inject({
      method: "PUT",
      url: `/api/v1/roles/${role.role_id}/field-access`,
      payload: {
        entries: [
          { fieldId: cfg.fields.struggles, access: "hidden" },
          { fieldId: cfg.fields.phone, access: "view" },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    await h.waitForRbacNotify();
    const list = (await (await h.signIn(rep)).inject({ method: "GET", url: "/api/v1/fields" })).json().fields;
    expect(list.some((f: { key: string }) => f.key === "struggles")).toBe(false);
    expect(list.find((f: { key: string }) => f.key === "phone").access).toBe("view");
  });

  it("nobody can grant field access they don't hold themselves", async () => {
    const cfg = await h.config();
    const rm = await h.seedUser({ grants: [{ key: "roles.manage", scope: null }], totp: true });
    const {
      rows: [own],
    } = await h.pool.query("SELECT role_id FROM user_roles WHERE user_id = $1", [rm.id]);
    await admin.inject({
      method: "PUT",
      url: `/api/v1/roles/${own.role_id}/field-access`,
      payload: { entries: [{ fieldId: cfg.fields.handled_by, access: "view" }] },
    });
    await h.waitForRbacNotify();
    const {
      rows: [target],
    } = await h.pool.query("INSERT INTO roles (id, name) VALUES (gen_random_uuid(), 'Target') RETURNING id");
    const c = await h.signIn(rm);
    const r = await c.inject({
      method: "PUT",
      url: `/api/v1/roles/${target.id}/field-access`,
      payload: { entries: [{ fieldId: cfg.fields.handled_by, access: "edit" }] },
    });
    // "edit" is the default, so granting it to Target = no row; but rm itself only has view → still escalation
    expect(r.json().error.code).toBe("ESCALATION");
  });
});
