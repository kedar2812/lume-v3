import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SALES_GRANTS } from "../../../test/grants";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../../../test/harness";

let h: Harness;
let admin: AuthedClient;
let repUser: SeededUser;
let rep: AuthedClient;
const SALES = [
  { key: "leads.view", scope: "own" },
  { key: "leads.edit", scope: "own" },
  { key: "leads.change_stage", scope: "own" },
  { key: "leads.contact.reveal", scope: "own" },
  { key: "leads.create", scope: null },
] as const;

beforeAll(async () => {
  h = await createHarness({ preset: "coaching" });
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
  repUser = await h.seedUser({ grants: [...SALES] });
  rep = await h.signIn(repUser);
});
afterAll(async () => h.close());

const create = (c: AuthedClient, body: object) =>
  c.inject({ method: "POST", url: "/api/v1/leads", payload: body });

describe("creating leads (report §8.3)", () => {
  it("normalises the phone, defaults the pipeline/stage, and a rep's lead is theirs", async () => {
    const r = await create(rep, { name: "Asha", phone: "050 123 4567", email: "Asha@Example.com" });
    expect(r.statusCode).toBe(201);
    const { lead } = r.json();
    const cfg = await h.config();
    expect(lead).toMatchObject({
      name: "Asha",
      pipelineId: cfg.pipelineId,
      stageId: cfg.stages.New,
      ownerId: repUser.id,
      version: 1,
    });
    // A Sales rep sees their own lead's contacts masked (reveal, not full).
    expect(lead.phone).toEqual({ display: "+971 50 ••• ••67", masked: true, status: "valid" });
    expect(lead.email.display).toBe("a•••@example.com");
    expect(lead.contactMasked).toBe(true);
    const full = (await admin.inject({ method: "GET", url: `/api/v1/leads/${lead.id}` })).json().lead;
    expect(full.phone).toEqual({ display: "+971 50 123 4567", masked: false, status: "valid" });
    expect(full.email.display).toBe("asha@example.com");
  });

  it("validates custom fields against the live definitions", async () => {
    const cfg = await h.config();
    const bad = await create(admin, { name: "X", custom: { struggles: ["not-an-option"] } });
    expect(bad.statusCode).toBe(400);
    const opt = (
      await h.ownerPool.query("SELECT options->0->>'id' AS id FROM field_definitions WHERE id = $1", [
        cfg.fields.struggles,
      ])
    ).rows[0].id;
    const ok = await create(admin, { name: "Y", custom: { struggles: [opt], handled_by: repUser.id } });
    expect(ok.json().lead.custom).toEqual({ struggles: [opt], handled_by: repUser.id });
    const ghost = await create(admin, {
      name: "Z",
      custom: { handled_by: "0190e0c0-0000-7000-8000-00000000dead" },
    });
    expect(ghost.json().error.code).toBe("UNKNOWN_USER");
  });

  it("a rep can't create a lead for someone else; an admin can", async () => {
    const other = await h.seedUser({ grants: [] });
    expect((await create(rep, { name: "Nope", ownerId: other.id })).statusCode).toBe(403);
    expect((await create(admin, { name: "Handed", ownerId: other.id })).json().lead.ownerId).toBe(other.id);
  });

  it("warns about duplicates, naming the owner only when the caller can see the lead", async () => {
    const other = await h.seedUser({ grants: [], name: "Priya" });
    await h.seedLead({ ownerId: other.id, phone: "+971509998877" });
    const r = await create(rep, { name: "Dup", phone: "+971 50 999 8877" });
    expect(r.statusCode).toBe(201);
    expect(r.json().duplicates).toEqual([{ visible: false, matchedOn: ["phone"] }]);
    const a = (
      await admin.inject({ method: "GET", url: "/api/v1/leads/duplicates?phone=%2B971509998877" })
    ).json().duplicates;
    // The admin sees every match (Priya's lead and the rep's new one), with owners named.
    expect(a).toContainEqual(
      expect.objectContaining({ visible: true, ownerName: "Priya", matchedOn: ["phone"] }),
    );
    expect(a.every((d: { visible: boolean }) => d.visible)).toBe(true);
  });
});

describe("reading leads (report §4.4, §7.4)", () => {
  it("an out-of-scope lead is a 404, exactly like a missing one", async () => {
    const other = await h.seedUser({ grants: [] });
    const theirs = await h.seedLead({ ownerId: other.id });
    const a = await rep.inject({ method: "GET", url: `/api/v1/leads/${theirs}` });
    const b = await rep.inject({ method: "GET", url: "/api/v1/leads/0190e0c0-0000-7000-8000-00000000beef" });
    expect(a.statusCode).toBe(404);
    expect(a.json()).toEqual(b.json());
  });

  it("hidden fields vanish from responses; view-only fields can't be written", async () => {
    const cfg = await h.config();
    const u = await h.seedUser({ grants: [...SALES] });
    const {
      rows: [role],
    } = await h.pool.query("SELECT role_id FROM user_roles WHERE user_id = $1", [u.id]);
    await admin.inject({
      method: "PUT",
      url: `/api/v1/roles/${role.role_id}/field-access`,
      payload: {
        entries: [
          { fieldId: cfg.fields.phone, access: "hidden" },
          { fieldId: cfg.fields.email, access: "view" },
        ],
      },
    });
    await h.waitForRbacNotify();
    const c = await h.signIn(u);
    const lead = (await create(c, { name: "Hidden phone" })).json().lead;
    expect("phone" in lead).toBe(false);
    expect("email" in lead).toBe(true);
    const w = await c.inject({
      method: "PATCH",
      url: `/api/v1/leads/${lead.id}`,
      headers: { "if-match": String(lead.version) },
      payload: { email: "x@y.com" },
    });
    expect(w.json().error.code).toBe("FIELD_NOT_EDITABLE");
    expect((await create(c, { name: "Sneaky", phone: "+971501112233" })).json().error.code).toBe(
      "FIELD_NOT_EDITABLE",
    );
  });
});

describe("listing and search (report §14, §12.2)", () => {
  it("returns only in-scope leads, pages with a cursor, and never more than 100", async () => {
    const u = await h.seedUser({ grants: [...SALES] });
    const c = await h.signIn(u);
    for (let i = 0; i < 5; i++) await h.seedLead({ ownerId: u.id, name: `Paged ${i}` });
    const p1 = (await c.inject({ method: "GET", url: "/api/v1/leads?limit=3" })).json();
    expect(p1.items).toHaveLength(3);
    const p2 = (
      await c.inject({ method: "GET", url: `/api/v1/leads?limit=3&cursor=${p1.nextCursor}` })
    ).json();
    expect(p2.items).toHaveLength(2);
    expect(p2.nextCursor).toBeNull();
    expect([...p1.items, ...p2.items].every((l: { ownerId: string }) => l.ownerId === u.id)).toBe(true);
    expect((await c.inject({ method: "GET", url: "/api/v1/leads?limit=101" })).statusCode).toBe(400);
  });

  it("filters by stage and owner, and searches names", async () => {
    const cfg = await h.config();
    const u = await h.seedUser({ grants: [] });
    await h.seedLead({ ownerId: u.id, name: "Zoya Findme", stage: "Call booked" });
    const byStage = (
      await admin.inject({
        method: "GET",
        url: `/api/v1/leads?stageId=${cfg.stages["Call booked"]}&ownerId=${u.id}`,
      })
    ).json().items;
    expect(byStage.map((l: { name: string }) => l.name)).toEqual(["Zoya Findme"]);
    const found = (await admin.inject({ method: "GET", url: "/api/v1/leads?q=findme" })).json().items;
    expect(found.map((l: { name: string }) => l.name)).toContain("Zoya Findme");
  });

  it("masked roles cannot search by phone or email (no enumeration)", async () => {
    await create(rep, { name: "Contact Search", phone: "+971501239999", email: "hunt@example.com" });
    expect((await rep.inject({ method: "GET", url: "/api/v1/leads?q=1239999" })).json().items).toHaveLength(
      0,
    );
    expect(
      (await rep.inject({ method: "GET", url: "/api/v1/leads?q=hunt%40example" })).json().items,
    ).toHaveLength(0);
    expect(
      (await admin.inject({ method: "GET", url: "/api/v1/leads?q=1239999" }))
        .json()
        .items.map((l: { name: string }) => l.name),
    ).toContain("Contact Search");
  });
});

describe("editing (optimistic concurrency, report §4.4)", () => {
  it("requires If-Match, refuses stale versions, and bumps the version", async () => {
    const lead = (await create(rep, { name: "Versioned" })).json().lead;
    const url = `/api/v1/leads/${lead.id}`;
    expect((await rep.inject({ method: "PATCH", url, payload: { name: "No header" } })).statusCode).toBe(428);
    const ok = await rep.inject({
      method: "PATCH",
      url,
      headers: { "if-match": "1" },
      payload: { name: "V2", phone: "+971 50 000 1111" },
    });
    expect(ok.json().lead).toMatchObject({ name: "V2", version: 2 });
    const stale = await rep.inject({
      method: "PATCH",
      url,
      headers: { "if-match": "1" },
      payload: { name: "Stale" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({ code: "VERSION_CONFLICT", details: { currentVersion: 2 } });
  });

  it("records a field_changed activity without contact values", async () => {
    const lead = (await create(rep, { name: "Audited" })).json().lead;
    await rep.inject({
      method: "PATCH",
      url: `/api/v1/leads/${lead.id}`,
      headers: { "if-match": "1" },
      payload: { phone: "+971501234000" },
    });
    const acts = (await admin.inject({ method: "GET", url: `/api/v1/leads/${lead.id}/activities` })).json()
      .items;
    const changed = acts.find((a: { type: string }) => a.type === "field_changed");
    expect(changed.payload).toEqual({ fields: ["phone"] });
    expect(JSON.stringify(acts)).not.toContain("1234000");
  });

  it("soft-deletes with permission; the lead then 404s", async () => {
    const lead = (await create(admin, { name: "Bin me" })).json().lead;
    expect((await rep.inject({ method: "DELETE", url: `/api/v1/leads/${lead.id}` })).statusCode).toBe(403);
    expect((await admin.inject({ method: "DELETE", url: `/api/v1/leads/${lead.id}` })).statusCode).toBe(204);
    expect((await admin.inject({ method: "GET", url: `/api/v1/leads/${lead.id}` })).statusCode).toBe(404);
  });
});

describe("what the screens need from each lead (Phase 1C-2)", () => {
  it("tells the caller what they may do with each lead, computed on the server", async () => {
    const seller = await h.seedUser({ grants: SALES_GRANTS });
    const other = await h.seedUser({ grants: SALES_GRANTS });
    const mine = await h.seedLead({ ownerId: seller.id });
    const c = await h.signIn(seller);
    const { lead } = (await c.inject({ method: "GET", url: `/api/v1/leads/${mine}` })).json();
    expect(lead.can).toEqual({
      edit: true,
      move: true,
      reveal: true,
      assign: false,
      delete: false,
      message: true,
    });
    const theirs = await h.seedLead({ ownerId: other.id });
    const seen = (await admin.inject({ method: "GET", url: `/api/v1/leads/${theirs}` })).json().lead;
    // Full contacts already: nothing to reveal, everything else allowed.
    expect(seen.can).toEqual({
      edit: true,
      move: true,
      reveal: false,
      assign: true,
      delete: true,
      message: true,
    });
  });

  it("counts leads per stage with the same filters as the list, and only what the caller may see", async () => {
    const seller = await h.seedUser({ grants: SALES_GRANTS });
    const other = await h.seedUser({ grants: SALES_GRANTS });
    const { pipelineId, stages } = await h.config();
    await h.seedLead({ ownerId: seller.id, stage: "New" });
    await h.seedLead({ ownerId: seller.id, stage: "New" });
    await h.seedLead({ ownerId: seller.id, stage: "Message sent" });
    await h.seedLead({ ownerId: other.id, stage: "Message sent" }); // invisible to the seller
    const c = await h.signIn(seller);
    const res = (
      await c.inject({ method: "GET", url: `/api/v1/leads/counts?pipelineId=${pipelineId}` })
    ).json();
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
    const { stages, lostReasons } = await h.config();
    const id = await h.seedLead({ ownerId: null });
    const moved = await admin.inject({
      method: "POST",
      url: `/api/v1/leads/${id}/stage`,
      payload: { stageId: stages["Lost"], lostReasonId: lostReasons[0] },
    });
    expect(moved.statusCode).toBe(200);
    const acts = (await admin.inject({ method: "GET", url: `/api/v1/leads/${id}/activities` })).json().items;
    expect(acts.find((a: { type: string }) => a.type === "stage_changed").payload).toMatchObject({
      to: stages["Lost"],
      lostReasonId: lostReasons[0],
    });
  });
});
