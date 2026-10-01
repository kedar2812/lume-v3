import { ALL_GRANTS, newId, type StageRule } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createHarness,
  type AuthedClient,
  type Harness,
  type HarnessConfig,
  type SeededUser,
} from "../../../test/harness";

let h: Harness;
let cfg: HarnessConfig;
let me: SeededUser;
let admin: AuthedClient;
let templateId: string;
const H = 3_600_000;

beforeAll(async () => {
  h = await createHarness({ preset: "coaching" });
  me = await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Maya Kapoor" });
  admin = await h.signIn(me);
  cfg = await h.config();
  const t = await admin.inject({
    method: "POST",
    url: "/api/v1/templates",
    payload: {
      name: "See you soon",
      category: "reminder",
      body: "Hi {{lead.first_name}}, see you {{meeting.time}}",
    },
  });
  expect(t.statusCode).toBe(201);
  templateId = t.json().id;
});
afterAll(() => h.close());
beforeEach(async () => {
  await h.ownerPool.query("UPDATE stages SET on_enter = '{}' WHERE id = $1", [cfg.stages["Call booked"]]);
});

const rule = (o: Partial<Extract<StageRule, { type: "remind_before_meeting" }>> = {}): StageRule => ({
  id: newId(),
  type: "remind_before_meeting",
  hoursBefore: 2,
  templateId,
  ...o,
});
const setRule = (r: StageRule) =>
  admin.inject({
    method: "PATCH",
    url: `/api/v1/stages/${cfg.stages["Call booked"]}`,
    payload: { onEnter: { rules: [r] } },
  });
const move = (lead: string) =>
  admin.inject({
    method: "POST",
    url: `/api/v1/leads/${lead}/stage`,
    payload: { stageId: cfg.stages["Call booked"] },
  });
async function meeting(lead: string, inHours: number, title = "Discovery call") {
  const c = await h.ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', 'all', true)", [
      me.id,
    ]);
    const starts = new Date(Date.now() + inHours * H);
    await c.query(
      `INSERT INTO meetings (id, lead_id, owner_id, source, external_id, title, starts_at, ends_at, matched_by)
       VALUES ($1, $2, $3, 'google', $4, $5, $6, $6, 'attendee')`,
      [newId(), lead, me.id, `ev-${newId()}`, title, starts],
    );
    await c.query("COMMIT");
    return starts;
  } finally {
    c.release();
  }
}
const tasksOf = (lead: string) =>
  h.queryAll<{ type: string; template_id: string | null; title: string; due_at: Date; assignee_id: string }>(
    "SELECT type, template_id, title, due_at, assignee_id FROM tasks WHERE lead_id = $1",
    [lead],
  );
const said = async (lead: string) =>
  (
    await h.queryAll<{ payload: { result: string; reason?: string } }>(
      "SELECT payload FROM activities WHERE lead_id = $1 AND type = 'automation' ORDER BY id",
      [lead],
    )
  ).map((a) => a.payload);

describe("remind the lead before their meeting (5C Task 8)", () => {
  it("entering the stage sets the owner a WhatsApp follow-up with the template, due that long before the meeting", async () => {
    expect((await setRule(rule())).statusCode).toBe(200);
    const lead = await h.seedLead({ ownerId: me.id, name: "Dana Lead" });
    const starts = await meeting(lead, 30);
    expect((await move(lead)).statusCode).toBe(200);
    const [t] = await tasksOf(lead);
    expect(t).toMatchObject({
      type: "whatsapp",
      template_id: templateId,
      title: "Remind Dana Lead about Discovery call",
      assignee_id: me.id,
    });
    expect(t!.due_at.getTime()).toBe(starts.getTime() - 2 * H);
    expect((await said(lead)).at(-1)).toMatchObject({ result: "done" });
    // the follow-up says what it is, for the screen to open the send sheet with its template
    const view = (await admin.inject({ method: "GET", url: `/api/v1/leads/${lead}/tasks` })).json();
    expect(JSON.stringify(view)).toContain(`"templateId":"${templateId}"`);
    expect(JSON.stringify(view)).toContain('"type":"whatsapp"');
  });

  it("does nothing, and says why: no meeting to come, too late, the template gone, no owner", async () => {
    await setRule(rule());
    const none = await h.seedLead({ ownerId: me.id, name: "No Meeting" });
    await move(none);
    const soon = await h.seedLead({ ownerId: me.id, name: "Too Soon" });
    await meeting(soon, 1); // 2 hours before is already past
    await move(soon);
    const ownerless = await h.seedLead({ ownerId: null, name: "Nobody's" });
    await meeting(ownerless, 30);
    await move(ownerless);
    for (const [lead, reason] of [
      [none, "no_meeting"],
      [soon, "too_late"],
      [ownerless, "no_owner"],
    ] as const) {
      expect(await tasksOf(lead)).toEqual([]);
      expect((await said(lead)).at(-1)).toMatchObject({ result: "skipped", reason });
    }
    await h.ownerPool.query("UPDATE message_templates SET archived_at = now() WHERE id = $1", [templateId]);
    try {
      const gone = await h.seedLead({ ownerId: me.id, name: "Template Gone" });
      await meeting(gone, 30);
      await move(gone);
      expect(await tasksOf(gone)).toEqual([]);
      expect((await said(gone)).at(-1)).toMatchObject({ result: "skipped", reason: "no_template" });
    } finally {
      await h.ownerPool.query("UPDATE message_templates SET archived_at = NULL WHERE id = $1", [templateId]);
    }
  });
});
