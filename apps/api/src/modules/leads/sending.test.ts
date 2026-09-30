import { ALL_GRANTS, type Grant } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness, type HarnessConfig } from "../../../test/harness";

let h: Harness;
let cfg: HarnessConfig;
let admin: AuthedClient;
let rep: AuthedClient;
let repId: string;
// A masked rep: sends and edits their own leads, never sees a full number.
const repGrants: Grant[] = [
  ...(["leads.view", "leads.edit", "leads.change_stage", "messages.send"] as const).map((key) => ({
    key,
    scope: "own" as const,
  })),
  { key: "templates.use", scope: null },
];
const NUMBER = "+971507654321";

beforeAll(async () => {
  h = await createHarness({ preset: "coaching" });
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
  const r = await h.seedUser({ grants: repGrants, totp: true, name: "Riya Sharma" });
  repId = r.id;
  rep = await h.signIn(r);
  cfg = await h.config();
});
afterAll(() => h.close());

const post = (c: AuthedClient, url: string, payload?: unknown) =>
  c.inject({ method: "POST", url, ...(payload !== undefined ? { payload: payload as object } : {}) });
const template = async (name: string) =>
  (
    await h.queryAll<{ id: string; version: string }>(
      "SELECT id, current_version_id AS version FROM message_templates WHERE name = $1",
      [name],
    )
  )[0]!;
const activities = (lead: string, type: string) =>
  h.queryAll<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM activities WHERE lead_id = $1 AND type = $2 ORDER BY id",
    [lead, type],
  );
const stageOf = async (lead: string) =>
  (await h.queryAll<{ stage_id: string }>("SELECT stage_id FROM leads WHERE id = $1", [lead]))[0]!.stage_id;
const sendAndConfirm = async (c: AuthedClient, lead: string, body: Record<string, unknown> = {}) => {
  expect((await post(c, `/api/v1/leads/${lead}/messages/prepare`, { text: "Hi", ...body })).statusCode).toBe(
    200,
  );
  return post(c, `/api/v1/leads/${lead}/messages/confirm`, { sent: true, ...body });
};

describe("sending (4A Task 4)", () => {
  it("renders a template in the lead's words, or the variables in your own text", async () => {
    const lead = await h.seedLead({ ownerId: repId, name: "Aisha Khan", phone: NUMBER });
    const t = await template("First hello");
    const r = await post(rep, `/api/v1/leads/${lead}/messages/render`, { templateId: t.id });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ versionId: t.version, missing: [] });
    expect(r.json().text).toMatch(/^Hi Aisha, this is Riya from /);
    const own = (
      await post(rep, `/api/v1/leads/${lead}/messages/render`, {
        text: "Hey {{lead.first_name}} {{meeting.time}}",
      })
    ).json();
    expect(own).toEqual({ text: "Hey Aisha {{meeting.time}}", missing: ["meeting.time"] });
  });

  it("the preview's context: names and non-contact fields only", async () => {
    const lead = await h.seedLead({
      ownerId: repId,
      name: "Context Lead",
      phone: NUMBER,
      email: "ctx@leads.test",
    });
    const r = await rep.inject({ method: "GET", url: `/api/v1/leads/${lead}/messages/context` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ lead: { name: "Context Lead" }, owner: { name: "Riya Sharma" } });
    expect(JSON.stringify(r.json())).not.toMatch(/7654321|ctx@leads/);
  });

  it("Review Focus 1: a version shown before an edit still sends, and the send remembers which", async () => {
    const lead = await h.seedLead({ ownerId: repId, name: "Old Words", phone: NUMBER });
    const t = await template("Gentle nudge");
    await admin.inject({ method: "PATCH", url: `/api/v1/templates/${t.id}`, payload: { body: "New words" } });
    const r = await post(rep, `/api/v1/leads/${lead}/messages/prepare`, {
      text: "Hi",
      templateVersionId: t.version,
    });
    expect(r.statusCode).toBe(200);
    expect((await activities(lead, "whatsapp_opened"))[0]!.payload).toMatchObject({
      templateVersionId: t.version,
    });
    // History says which template it was, by the name it had when sent; a later rename doesn't rewrite it.
    await post(rep, `/api/v1/leads/${lead}/messages/confirm`, { sent: true });
    await admin.inject({ method: "PATCH", url: `/api/v1/templates/${t.id}`, payload: { name: "Renamed" } });
    expect((await activities(lead, "whatsapp_confirmed_sent"))[0]!.payload).toMatchObject({
      templateVersionId: t.version,
      template: "Gentle nudge",
    });
  });

  it("Review Focus 2: a masked rep never gets the number back, except in the WhatsApp link", async () => {
    const lead = await h.seedLead({ ownerId: repId, name: "Masked Lead", phone: NUMBER });
    const bodies: string[] = [];
    const t = await template("First hello");
    bodies.push((await post(rep, `/api/v1/leads/${lead}/messages/render`, { templateId: t.id })).body);
    bodies.push((await post(rep, `/api/v1/leads/${lead}/messages/render`, { text: "x".repeat(5000) })).body);
    bodies.push((await sendAndConfirm(rep, lead)).body);
    bodies.push((await post(rep, `/api/v1/leads/${lead}/replied`)).body);
    for (const b of bodies) expect(b).not.toMatch(/7654321/);
    const link = (await post(rep, `/api/v1/leads/${lead}/messages/prepare`, { text: "Hi" })).json().url;
    expect(link).toMatch(/^https:\/\/wa\.me\/971507654321\?text=/);
  });

  it("Review Focus 3: a field that was archived is simply missing", async () => {
    const f = (
      await admin.inject({
        method: "POST",
        url: "/api/v1/fields",
        payload: { key: "package", label: "Package", type: "text" },
      })
    ).json().field;
    const lead = await h.seedLead({ ownerId: repId, name: "No Package", phone: NUMBER });
    await admin.inject({ method: "POST", url: `/api/v1/fields/${f.id}/archive` });
    const r = await post(rep, `/api/v1/leads/${lead}/messages/render`, {
      text: `On {{lead.custom.${f.key}}}`,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().missing).toEqual([`lead.custom.${f.key}`]);
  });

  it("Sent: once, the follow-up done once, the lead moved once (Review Focus 4)", async () => {
    const lead = await h.seedLead({ ownerId: repId, name: "Sent Twice", phone: NUMBER });
    const task = (
      await post(rep, `/api/v1/leads/${lead}/tasks`, {
        title: "Send the plan",
        due: { at: new Date(Date.now() + 3_600_000).toISOString() },
      })
    ).json();
    const [before] = await h.queryAll("SELECT stage_id FROM leads WHERE id = $1", [lead]);
    const first = await sendAndConfirm(rep, lead, { taskId: task.id });
    expect(first.json()).toMatchObject({ moved: { stageName: "Message sent" } });
    // Where it came from, so the prompt's Undo can move it back.
    expect(first.json().moved.fromStageId).toBe(before!.stage_id);
    const again = await post(rep, `/api/v1/leads/${lead}/messages/confirm`, { sent: true, taskId: task.id });
    expect(again.json()).toEqual({ moved: null });
    expect(await activities(lead, "whatsapp_confirmed_sent")).toHaveLength(1);
    expect(await activities(lead, "follow_up_done")).toHaveLength(1);
    expect(await stageOf(lead)).toBe(cfg.stages["Message sent"]);
    const [l] = await h.queryAll<{ last_message_at: Date | null }>(
      "SELECT last_message_at FROM leads WHERE id = $1",
      [lead],
    );
    expect(l!.last_message_at).not.toBeNull();
  });

  it("Review Focus 5: a move that needs a field the lead lacks leaves it where it is, and says why", async () => {
    const f = (
      await admin.inject({
        method: "POST",
        url: "/api/v1/fields",
        payload: { key: "goal", label: "Goal", type: "text" },
      })
    ).json().field;
    await admin.inject({
      method: "PATCH",
      url: `/api/v1/stages/${cfg.stages["Message sent"]}`,
      payload: { requiredFieldIds: [f.id] },
    });
    try {
      const lead = await h.seedLead({ ownerId: repId, name: "Needs A Goal", phone: NUMBER });
      const r = await sendAndConfirm(rep, lead);
      expect(r.json()).toMatchObject({ moved: null, notMoved: { code: "REQUIRED_FIELDS" } });
      // In LUME's words: where it stays, and what the stage needs (4A review, Important 3).
      expect(r.json().notMoved.message).toBe("It stays in New: Message sent needs Goal");
      expect(await stageOf(lead)).toBe(cfg.stages["New"]);
      expect(await activities(lead, "whatsapp_confirmed_sent")).toHaveLength(1);
    } finally {
      await admin.inject({
        method: "PATCH",
        url: `/api/v1/stages/${cfg.stages["Message sent"]}`,
        payload: { requiredFieldIds: [] },
      });
    }
  });

  it("4A review, Important 3: someone who may send but not move a lead hears why it stayed", async () => {
    const u = await h.seedUser({
      grants: [
        ...(["leads.view", "messages.send"] as const).map((key) => ({ key, scope: "own" as const })),
        { key: "templates.use", scope: null },
      ],
      totp: true,
    });
    const sender = await h.signIn(u);
    const lead = await h.seedLead({ ownerId: u.id, name: "Stays Put", phone: NUMBER });
    const r = await sendAndConfirm(sender, lead);
    expect(r.json().notMoved.message).toBe("It stays in New: moving leads on isn't part of your role");
  });

  it("4A review, Important 1: two answers at once (a double-tap) log the send once and move it once", async () => {
    const lead = await h.seedLead({ ownerId: repId, name: "Double Tap", phone: NUMBER });
    expect((await post(rep, `/api/v1/leads/${lead}/messages/prepare`, { text: "Hi" })).statusCode).toBe(200);
    const both = await Promise.all([
      post(rep, `/api/v1/leads/${lead}/messages/confirm`, { sent: true }),
      post(rep, `/api/v1/leads/${lead}/messages/confirm`, { sent: true }),
    ]);
    expect(both.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(await activities(lead, "whatsapp_confirmed_sent")).toHaveLength(1);
    expect(both.filter((r) => r.json().moved).length).toBe(1);
  });

  it("4A review, Important 5: Undo is offered only when moving back undoes it — no stage automations either side", async () => {
    const plain = await h.seedLead({ ownerId: repId, name: "Plain Move", phone: NUMBER });
    expect((await sendAndConfirm(rep, plain)).json().moved).toMatchObject({ undoable: true });
    await admin.inject({
      method: "PATCH",
      url: `/api/v1/stages/${cfg.stages["Message sent"]}`,
      payload: {
        onEnter: { rules: [{ id: "0192f0a0-0000-7000-8000-00000000f001", type: "cancel_open_tasks" }] },
      },
    });
    try {
      const ruled = await h.seedLead({ ownerId: repId, name: "Ruled Move", phone: NUMBER });
      expect((await sendAndConfirm(rep, ruled)).json().moved).toMatchObject({ undoable: false });
    } finally {
      await admin.inject({
        method: "PATCH",
        url: `/api/v1/stages/${cfg.stages["Message sent"]}`,
        payload: { onEnter: { rules: [] } },
      });
    }
  });

  it("They replied: logged, moved, and an 'until they reply' repeat stops", async () => {
    const lead = await h.seedLead({ ownerId: repId, name: "Replies", stage: "Message sent", phone: NUMBER });
    await post(rep, `/api/v1/leads/${lead}/tasks`, {
      title: "Chase",
      due: { at: new Date(Date.now() + 3_600_000).toISOString() },
      recurrence: { every: 1, unit: "day", until: null, stopOn: ["reply_logged"] },
    });
    const r = await post(rep, `/api/v1/leads/${lead}/replied`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ moved: { stageName: "Replied" } });
    expect(await activities(lead, "reply_logged")).toHaveLength(1);
    const [t] = await h.queryAll<{ id: string }>(
      "SELECT id FROM tasks WHERE lead_id = $1 AND status = 'open'",
      [lead],
    );
    await post(rep, `/api/v1/tasks/${t!.id}/done`);
    expect(
      await h.queryAll("SELECT 1 FROM tasks WHERE lead_id = $1 AND status = 'open'", [lead]),
    ).toHaveLength(0);
  });

  it("a lost lead moved back to an open stage is reopened, from wherever it's moved", async () => {
    const lead = await h.seedLead({ ownerId: repId, name: "Came Back", stage: "Lost", phone: NUMBER });
    await admin.inject({
      method: "POST",
      url: `/api/v1/leads/${lead}/stage`,
      payload: { stageId: cfg.stages["New"] },
    });
    expect((await activities(lead, "reopened"))[0]!.payload).toMatchObject({ to: cfg.stages["New"] });
  });

  it("a template the caller's role may not use is refused in words", async () => {
    const t = (
      await admin.inject({
        method: "POST",
        url: "/api/v1/templates",
        payload: { name: "Admins only", category: "custom", body: "Hi", allowedRoleIds: [await otherRole()] },
      })
    ).json();
    const lead = await h.seedLead({ ownerId: repId, name: "Not For You", phone: NUMBER });
    const r = await post(rep, `/api/v1/leads/${lead}/messages/render`, { templateId: t.id });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.message).toBe("That template isn't one your role can use");
  });

  it("a role that can't see who owns a lead doesn't get the owner's name for a message", async () => {
    const lead = await h.seedLead({ ownerId: repId, name: "Hidden Owner", phone: NUMBER });
    const [f] = await h.queryAll<{ id: string }>("SELECT id FROM field_definitions WHERE key = 'owner'");
    const [r] = await h.queryAll<{ role_id: string }>("SELECT role_id FROM user_roles WHERE user_id = $1", [
      repId,
    ]);
    // As an admin does it in Settings → Roles (so everyone's access is read again).
    const access = (a: "hidden" | "edit") =>
      admin.inject({
        method: "PUT",
        url: `/api/v1/roles/${r!.role_id}/field-access`,
        payload: { entries: [{ fieldId: f!.id, access: a }] },
      });
    expect((await access("hidden")).statusCode).toBe(200);
    try {
      const ctx = (await rep.inject({ method: "GET", url: `/api/v1/leads/${lead}/messages/context` })).json();
      expect(ctx.owner).toBeNull();
      const own = (
        await post(rep, `/api/v1/leads/${lead}/messages/render`, { text: "From {{owner.first_name}}" })
      ).json();
      expect(own.text).not.toContain("Riya");
    } finally {
      await access("edit");
    }
  });

  it("a follow-up from another lead is refused, whether preparing or answering Sent", async () => {
    const a = await h.seedLead({ ownerId: repId, name: "Lead Here", phone: NUMBER });
    const b = await h.seedLead({ ownerId: repId, name: "Lead Elsewhere", phone: NUMBER });
    const made = await admin.inject({
      method: "POST",
      url: `/api/v1/leads/${b}/tasks`,
      payload: { title: "Call", due: { at: new Date(Date.now() + 3_600_000).toISOString() } },
    });
    const taskId = (made.json().task?.id ?? made.json().id) as string;
    const prep = await post(rep, `/api/v1/leads/${a}/messages/prepare`, { text: "Hi", taskId });
    expect(prep.statusCode).toBe(400);
    expect(prep.json().error.code).toBe("TASK_NOT_THIS_LEAD");
    expect((await post(rep, `/api/v1/leads/${a}/messages/prepare`, { text: "Hi" })).statusCode).toBe(200);
    const conf = await post(rep, `/api/v1/leads/${a}/messages/confirm`, { sent: true, taskId });
    expect(conf.statusCode).toBe(400);
    expect(
      (await h.queryAll<{ status: string }>("SELECT status FROM tasks WHERE id = $1", [taskId]))[0]!.status,
    ).toBe("open");
  });
});

/** A role the rep doesn't have. */
async function otherRole(): Promise<string> {
  const id = crypto.randomUUID();
  await h.ownerPool.query("INSERT INTO roles (id, name) VALUES ($1, 'Someone else')", [id]);
  return id;
}
