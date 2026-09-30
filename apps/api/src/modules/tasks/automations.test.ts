import { ALL_GRANTS, DEFAULT_RULES, newId, type Grant, type Mapping, type StageRule } from "@lume/core";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness, type HarnessConfig } from "../../../test/harness";
import { sealWebhook, signFor } from "../webhooks/secret";

let h: Harness;
let cfg: HarnessConfig;
let admin: AuthedClient;
let adminId: string;
let repId: string;
let rep: AuthedClient;
let riya: string; // a rep who sees only her own leads
const repGrants: Grant[] = (
  ["leads.view", "leads.create", "leads.edit", "leads.change_stage", "leads.bulk_edit"] as const
).map((key) => ({ key, scope: "own" as const }));
const H = 3_600_000;

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  const a = await h.seedUser({ grants: ALL_GRANTS, totp: true });
  adminId = a.id;
  admin = await h.signIn(a);
  const r = await h.seedUser({ grants: repGrants, totp: true });
  repId = r.id;
  rep = await h.signIn(r);
  riya = (await h.seedUser({ grants: repGrants, totp: true })).id;
  cfg = await h.config();
  // Working hours around the clock unless a test says otherwise, so due times are exact.
  await h.ownerPool.query(
    `UPDATE settings SET working_hours = '{"days":[0,1,2,3,4,5,6],"start":"00:00","end":"23:59"}' WHERE id = 1`,
  );
});
afterAll(() => h.close());
beforeEach(async () => {
  for (const id of Object.values(cfg.stages))
    await h.ownerPool.query("UPDATE stages SET on_enter = '{}' WHERE id = $1", [id]);
});

const rid = () => newId();
const followUp = (o: Partial<Extract<StageRule, { type: "create_task" }>> = {}): StageRule => ({
  id: rid(),
  type: "create_task",
  title: "Send the plan",
  dueIn: { n: 2, unit: "day" },
  assignee: "lead_owner",
  ...o,
});
const setRules = (stage: string, rules: StageRule[]) =>
  admin.inject({
    method: "PATCH",
    url: `/api/v1/stages/${cfg.stages[stage]}`,
    payload: { onEnter: { rules } },
  });
const move = (c: AuthedClient, leadId: string, stage: string, extra: Record<string, unknown> = {}) =>
  c.inject({
    method: "POST",
    url: `/api/v1/leads/${leadId}/stage`,
    payload: { stageId: cfg.stages[stage], ...extra },
  });
const openTasks = (leadId: string) =>
  h.queryAll<{ id: string; title: string; assignee_id: string; due_at: Date; auto_rule_id: string | null }>(
    "SELECT id, title, assignee_id, due_at, auto_rule_id FROM tasks WHERE lead_id = $1 AND status = 'open' ORDER BY created_at",
    [leadId],
  );
const automationLines = (leadId: string) =>
  h.queryAll<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM activities WHERE lead_id = $1 AND type = 'automation' ORDER BY id",
    [leadId],
  );
async function inbox(userId: string) {
  const c: pg.PoolClient = await h.ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true)", [userId]);
    return (
      await c.query<{ kind: string; title: string }>("SELECT kind, title FROM notifications ORDER BY id")
    ).rows;
  } finally {
    await c.query("COMMIT");
    c.release();
  }
}
const settle = () => new Promise((r) => setTimeout(r, 100));

describe("stage automations (3C Task 3)", () => {
  it("setting a follow-up: for the lead's owner, due when the rule says, and its history in words", async () => {
    const rule = followUp();
    expect((await setRules("Contacted", [rule])).statusCode).toBe(200);
    const lead = await h.seedLead({ ownerId: repId, name: "Aisha Khan" });
    const before = Date.now();
    expect((await move(rep, lead, "Contacted")).statusCode).toBe(200);
    const [t] = await openTasks(lead);
    expect(t).toMatchObject({ title: "Send the plan", assignee_id: repId, auto_rule_id: rule.id });
    expect(t!.due_at.getTime() - before).toBeGreaterThanOrEqual(48 * H - 5_000);
    expect(t!.due_at.getTime() - before).toBeLessThan(48 * H + 60_000);
    const [line] = await automationLines(lead);
    expect(line!.payload).toMatchObject({
      ruleId: rule.id,
      rule: "create_task",
      result: "done",
      taskId: t!.id,
    });
    const pending = await h.queryAll(
      "SELECT 1 FROM scheduled_notifications WHERE task_id = $1 AND status = 'pending'",
      [t!.id],
    );
    expect(pending).toHaveLength(1);
  });

  it("Review Focus 1: a bulk move makes one follow-up per lead; again, none; out and back while open, none", async () => {
    await setRules("Contacted", [followUp()]);
    // 100 at once, in one statement (one by one is too slow for the per-package test timeout in CI).
    const ids = (
      await h.queryAll<{ id: string }>(
        `INSERT INTO leads (id, pipeline_id, stage_id, owner_id, name, phone_status)
         SELECT gen_random_uuid(), $1, $2, $3, 'Bulk ' || i, 'missing' FROM generate_series(1, 100) i RETURNING id`,
        [cfg.pipelineId, cfg.stages["New"], repId],
      )
    ).map((r) => r.id);
    const bulk = (stage: string) =>
      rep.inject({
        method: "POST",
        url: "/api/v1/leads/bulk",
        payload: { ids, action: { type: "stage", stageId: cfg.stages[stage] } },
      });
    expect((await bulk("Contacted")).statusCode).toBe(200);
    const count = async () =>
      Number(
        (
          await h.queryAll<{ n: string }>(
            "SELECT count(*) AS n FROM tasks WHERE lead_id = ANY($1::uuid[]) AND status = 'open'",
            [ids],
          )
        )[0]!.n,
      );
    expect(await count()).toBe(100);
    await bulk("Contacted"); // already there: nothing moves, nothing is made
    expect(await count()).toBe(100);
    await bulk("New");
    await bulk("Contacted"); // back in while the first is open: none
    expect(await count()).toBe(100);
    await h.queryAll("UPDATE tasks SET status = 'done' WHERE lead_id = $1", [ids[0]]);
    await move(rep, ids[0]!, "New");
    await move(rep, ids[0]!, "Contacted"); // the first one done: another
    expect(await openTasks(ids[0]!)).toHaveLength(1);
  }, 60_000);

  it("Review Focus 3: a person who can't take it hands it to the owner; with no owner, nothing, and the move still works", async () => {
    // Riya can't see the rep's leads; a disabled person can't take anything.
    const gone = (await h.seedUser({ grants: ALL_GRANTS, totp: true })).id;
    await h.ownerPool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [gone]);
    await setRules("Contacted", [followUp({ assignee: { userId: riya } })]);
    const a = await h.seedLead({ ownerId: repId, name: "Owner Takes It" });
    expect((await move(rep, a, "Contacted")).statusCode).toBe(200);
    expect((await openTasks(a))[0]!.assignee_id).toBe(repId);
    await h.ownerPool.query(
      "UPDATE stages SET on_enter = jsonb_build_object('rules', jsonb_build_array(jsonb_build_object('id', $2::text, 'type', 'create_task', 'title', 'Call', 'dueIn', '{\"n\":1,\"unit\":\"hour\"}'::jsonb, 'assignee', jsonb_build_object('userId', $3::text)))) WHERE id = $1",
      [cfg.stages["Qualified"], rid(), gone],
    );
    const b = await h.seedLead({ ownerId: null, name: "Nobody Yet" });
    expect((await move(admin, b, "Qualified")).statusCode).toBe(200);
    expect(await openTasks(b)).toHaveLength(0);
    expect((await automationLines(b))[0]!.payload).toMatchObject({ result: "skipped", reason: "no_owner" });
  });

  it("Review Focus 2: LUME's own follow-up lands inside working hours, unless that's switched off", async () => {
    await h.ownerPool.query(
      `UPDATE settings SET timezone = 'Asia/Dubai', working_hours = '{"days":[1,2,3,4,5],"start":"09:00","end":"18:00"}' WHERE id = 1`,
    );
    await setRules("Contacted", [followUp({ dueIn: { n: 1, unit: "hour" } })]);
    const wh = async () => {
      const lead = await h.seedLead({ ownerId: repId, name: "Shifted" });
      await move(rep, lead, "Contacted");
      return (await openTasks(lead))[0]!.due_at;
    };
    const due = await wh();
    const dubai = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Dubai",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(due);
    const hh = Number(dubai.find((p) => p.type === "hour")!.value);
    const wd = dubai.find((p) => p.type === "weekday")!.value;
    expect(["Sat", "Sun"]).not.toContain(wd);
    expect(hh >= 9 && hh < 18).toBe(true);
    await admin.inject({
      method: "PUT",
      url: "/api/v1/settings/follow-ups",
      payload: { shiftToWorkingHours: false },
    });
    const before = Date.now();
    const plain = await wh();
    expect(plain.getTime() - before).toBeLessThan(H + 60_000);
    await admin.inject({
      method: "PUT",
      url: "/api/v1/settings/follow-ups",
      payload: { shiftToWorkingHours: true },
    });
    await h.ownerPool.query(
      `UPDATE settings SET working_hours = '{"days":[0,1,2,3,4,5,6],"start":"00:00","end":"23:59"}' WHERE id = 1`,
    );
  });

  it("clearing on a win: open follow-ups and their reminders are cancelled, and the lead's next date goes", async () => {
    await setRules("Won", [{ id: rid(), type: "cancel_open_tasks" }]);
    const lead = await h.seedLead({ ownerId: repId, name: "Big Win" });
    for (const title of ["Call", "Send"])
      await rep.inject({
        method: "POST",
        url: `/api/v1/leads/${lead}/tasks`,
        payload: { title, due: { at: new Date(Date.now() + H).toISOString() } },
      });
    expect(await openTasks(lead)).toHaveLength(2);
    expect((await move(rep, lead, "Won")).statusCode).toBe(200);
    expect(await openTasks(lead)).toHaveLength(0);
    const pending = await h.queryAll(
      "SELECT 1 FROM scheduled_notifications s JOIN tasks t ON t.id = s.task_id WHERE t.lead_id = $1 AND s.status = 'pending'",
      [lead],
    );
    expect(pending).toHaveLength(0);
    const [l] = await h.queryAll<{ next_task_due_at: Date | null }>(
      "SELECT next_task_due_at FROM leads WHERE id = $1",
      [lead],
    );
    expect(l!.next_task_due_at).toBeNull();
    expect((await automationLines(lead))[0]!.payload).toMatchObject({
      rule: "cancel_open_tasks",
      cancelled: 2,
    });
  });

  it("telling someone: the owner hears, never the one who moved it, never someone who can't see it; names only", async () => {
    await setRules("Proposal", [
      { id: rid(), type: "notify", to: ["lead_owner", { userId: riya }, { userId: adminId }] },
    ]);
    const lead = await h.seedLead({ ownerId: repId, name: "Told Lead", phone: "+971507654321" });
    await move(admin, lead, "Proposal");
    await settle();
    const mine = (await inbox(repId)).filter((n) => n.kind === "lead_stage");
    expect(mine.map((n) => n.title)).toEqual(["Told Lead moved to Proposal"]);
    expect((await inbox(riya)).some((n) => n.kind === "lead_stage")).toBe(false); // can't see it
    expect((await inbox(adminId)).some((n) => n.kind === "lead_stage")).toBe(false); // moved it
    expect(JSON.stringify(mine)).not.toMatch(/7654321/);
  });

  it("a rule's own work never moves a stage, so nothing loops", async () => {
    await setRules("Contacted", [followUp()]);
    const lead = await h.seedLead({ ownerId: repId, name: "No Loop" });
    await move(rep, lead, "Contacted");
    const [t] = await openTasks(lead);
    await rep.inject({ method: "POST", url: `/api/v1/tasks/${t!.id}/done` });
    const [l] = await h.queryAll<{ stage_id: string }>("SELECT stage_id FROM leads WHERE id = $1", [lead]);
    expect(l!.stage_id).toBe(cfg.stages["Contacted"]);
    expect(await openTasks(lead)).toHaveLength(0);
  });

  it("a lead someone adds arrives in its first stage, and that stage's rules run", async () => {
    await setRules("New", [followUp({ title: "Call within the hour", dueIn: { n: 1, unit: "hour" } })]);
    const r = await rep.inject({ method: "POST", url: "/api/v1/leads", payload: { name: "Fresh One" } });
    expect(r.statusCode).toBe(201);
    const [t] = await openTasks(r.json().lead.id);
    expect(t).toMatchObject({ title: "Call within the hour", assignee_id: repId });
  });

  it("saving a stage: a person who doesn't exist is refused; six rules are refused", async () => {
    expect((await setRules("Contacted", [followUp({ assignee: { userId: newId() } })])).statusCode).toBe(400);
    const six = Array.from({ length: 6 }, () => followUp());
    expect((await setRules("Contacted", six)).statusCode).toBe(400);
    const r = await admin.inject({ method: "GET", url: "/api/v1/pipelines" });
    expect(JSON.stringify(r.json())).toContain('"onEnter"');
  });
});

describe("stage automations and intake (3C Task 3)", () => {
  const SECRET = "p".repeat(43);
  const mapping: Mapping = {
    columns: [
      { column: 0, to: "field", field: "name" },
      { column: 1, to: "field", field: "phone" },
    ],
    createMissingTags: false,
  };
  it("a webhook's lead gets its first stage's rules; a CSV import's leads don't", async () => {
    await setRules("New", [followUp({ title: "Call the new enquiry" })]);
    await h.ownerPool.query(
      `UPDATE settings SET integrations = integrations || '{"webhooks":{"enabled":true}}'::jsonb WHERE id = 1`,
    );
    const rules = DEFAULT_RULES({ pipelineId: cfg.pipelineId, stageId: cfg.stages["New"]!, country: "AE" });
    rules.owner = { mode: "user", userId: repId };
    const id = newId();
    await h.pool.query(
      `INSERT INTO lead_sources (id, type, name, status, config_enc, mapping, rules, headers, column_settings, run_as)
       VALUES ($1, 'webhook', 'Site form', 'active', $2, $3, $4, $5, $6, $7)`,
      [
        id,
        sealWebhook(h.keyring, id, { mode: "signed", secret: SECRET, preset: "website" }),
        mapping,
        rules,
        JSON.stringify(["name", "phone"]),
        { dateOrders: {}, decimalMarks: {} },
        adminId,
      ],
    );
    const raw = JSON.stringify({ name: "Web Enquiry", phone: "+971501110001" });
    const ts = String(Math.floor(h.clock.now.getTime() / 1000));
    await h.app.inject({
      method: "POST",
      url: `/webhooks/in/${id}`,
      headers: {
        "content-type": "application/json",
        "x-lume-timestamp": ts,
        "x-lume-signature": signFor(SECRET, ts, Buffer.from(raw)),
      },
      payload: raw,
    });
    await h.runWebhooks();
    const [web] = await h.queryAll<{ id: string }>("SELECT id FROM leads WHERE name = 'Web Enquiry'");
    expect((await openTasks(web!.id)).map((t) => t.title)).toEqual(["Call the new enquiry"]);
    // Its reminder is queued at once, not left for the sweeper (3C minor).
    const pending = await h.queryAll<{ id: string }>(
      `SELECT n.id FROM scheduled_notifications n JOIN tasks t ON t.id = n.task_id
        WHERE t.lead_id = $1 AND n.status = 'pending'`,
      [web!.id],
    );
    expect(pending.length).toBeGreaterThan(0);
    expect(h.reminderQueue.map((r) => Number(r.id))).toEqual(
      expect.arrayContaining(pending.map((p) => Number(p.id))),
    );

    const up = (
      await admin.inject({
        method: "POST",
        url: "/api/v1/imports",
        payload: Buffer.from("Name,Phone\nFrom A File,0502223344\n"),
        headers: { "content-type": "application/octet-stream", "x-file-name": "old.csv" },
      })
    ).json();
    await admin.inject({ method: "POST", url: `/api/v1/imports/${up.id}/start` });
    await h.runImports();
    const [csv] = await h.queryAll<{ id: string }>("SELECT id FROM leads WHERE name = 'From A File'");
    expect(await openTasks(csv!.id)).toHaveLength(0);
  });
});

describe("new installs (3C Task 3)", () => {
  it("Won and Lost clear open follow-ups from the start", async () => {
    const fresh = await createHarness({ preset: "general" });
    try {
      const rows = await fresh.queryAll<{ kind: string; on_enter: { rules?: { type: string }[] } }>(
        "SELECT kind, on_enter FROM stages WHERE archived_at IS NULL",
      );
      for (const s of rows)
        expect(s.on_enter.rules?.map((r) => r.type) ?? []).toEqual(
          s.kind === "open" ? [] : ["cancel_open_tasks"],
        );
    } finally {
      await fresh.close();
    }
  });
});

describe("stage automations: 3C final review", () => {
  const SECRET = "q".repeat(43);
  async function webhookFor(runAs: string) {
    await h.ownerPool.query(
      `UPDATE settings SET integrations = integrations || '{"webhooks":{"enabled":true}}'::jsonb WHERE id = 1`,
    );
    const rules = DEFAULT_RULES({ pipelineId: cfg.pipelineId, stageId: cfg.stages["New"]!, country: "AE" });
    rules.owner = { mode: "user", userId: repId };
    const id = newId();
    await h.pool.query(
      `INSERT INTO lead_sources (id, type, name, status, config_enc, mapping, rules, headers, column_settings, run_as)
       VALUES ($1, 'webhook', 'Site form', 'active', $2, $3, $4, $5, $6, $7)`,
      [
        id,
        sealWebhook(h.keyring, id, { mode: "signed", secret: SECRET, preset: "website" }),
        {
          columns: [
            { column: 0, to: "field", field: "name" },
            { column: 1, to: "field", field: "phone" },
          ],
          createMissingTags: false,
        },
        rules,
        JSON.stringify(["name", "phone"]),
        { dateOrders: {}, decimalMarks: {} },
        runAs,
      ],
    );
    return async (body: Record<string, unknown>) => {
      const raw = JSON.stringify(body);
      const ts = String(Math.floor(h.clock.now.getTime() / 1000));
      await h.app.inject({
        method: "POST",
        url: `/webhooks/in/${id}`,
        headers: {
          "content-type": "application/json",
          "x-lume-timestamp": ts,
          "x-lume-signature": signFor(SECRET, ts, Buffer.from(raw)),
        },
        payload: raw,
      });
      await h.runWebhooks();
    };
  }

  it("Important 1: a lead from a webhook tells the person the webhook runs as, and its follow-up has no author", async () => {
    await setRules("New", [
      { id: rid(), type: "notify", to: [{ userId: adminId }] },
      followUp({ title: "Call the enquiry" }),
    ]);
    const post = await webhookFor(adminId);
    await post({ name: "Web Two", phone: "+971501110002" });
    await settle();
    expect((await inbox(adminId)).map((n) => n.title)).toContain("Web Two arrived in New");
    const [lead] = await h.queryAll<{ id: string }>("SELECT id FROM leads WHERE name = 'Web Two'");
    const [t] = await h.queryAll<{ created_by: string | null }>(
      "SELECT created_by FROM tasks WHERE lead_id = $1",
      [lead!.id],
    );
    expect(t!.created_by).toBeNull();
  });

  it("Important 4: a bulk move tells each person once, not once per lead", async () => {
    await setRules("Contacted", [
      followUp({ title: "Chase" }),
      { id: rid(), type: "notify", to: ["lead_owner"] },
    ]);
    const ids = (
      await h.queryAll<{ id: string }>(
        `INSERT INTO leads (id, pipeline_id, stage_id, owner_id, name, phone_status)
         SELECT gen_random_uuid(), $1, $2, $3, 'Batch ' || i, 'missing' FROM generate_series(1, 20) i RETURNING id`,
        [cfg.pipelineId, cfg.stages["New"], repId],
      )
    ).map((r) => r.id);
    const before = (await inbox(repId)).length;
    const r = await admin.inject({
      method: "POST",
      url: "/api/v1/leads/bulk",
      payload: { ids, action: { type: "stage", stageId: cfg.stages["Contacted"] } },
    });
    expect(r.statusCode).toBe(200);
    await settle();
    const fresh = (await inbox(repId)).slice(before);
    expect(fresh.map((n) => n.title).sort()).toEqual([
      "20 leads moved to Contacted",
      "LUME set you 20 follow-ups",
    ]);
  }, 60_000);

  it("Important 5: a rule that fails is rolled back and said; the move, and the next rule, still happen", async () => {
    await h.ownerPool.query(`
      CREATE OR REPLACE FUNCTION test_boom() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'boom'; END $$;
      CREATE TRIGGER test_boom BEFORE INSERT ON tasks FOR EACH ROW WHEN (NEW.title = 'Boom') EXECUTE FUNCTION test_boom();`);
    try {
      await setRules("Proposal", [
        followUp({ title: "Boom" }),
        { id: rid(), type: "notify", to: ["lead_owner"] },
      ]);
      const lead = await h.seedLead({ ownerId: repId, name: "Still Moves" });
      expect((await move(admin, lead, "Proposal")).statusCode).toBe(200);
      const [l] = await h.queryAll<{ stage_id: string }>("SELECT stage_id FROM leads WHERE id = $1", [lead]);
      expect(l!.stage_id).toBe(cfg.stages["Proposal"]);
      expect((await automationLines(lead)).map((a) => a.payload)).toEqual([
        expect.objectContaining({ rule: "create_task", result: "skipped", reason: "failed" }),
        expect.objectContaining({ rule: "notify", result: "done" }),
      ]);
      expect(await openTasks(lead)).toHaveLength(0);
    } finally {
      await h.ownerPool.query(
        "DROP TRIGGER IF EXISTS test_boom ON tasks; DROP FUNCTION IF EXISTS test_boom()",
      );
    }
  });

  it("Important 6: saving a rule for someone no longer active says who, and in which automation", async () => {
    const gone = await h.seedUser({ grants: repGrants, totp: true, name: "Gone Person" });
    await h.ownerPool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [gone.id]);
    const r = await setRules("Contacted", [followUp(), followUp({ assignee: { userId: gone.id } })]);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toBe("Gone Person, in automation 2, is no longer active here");
  });

  it("clearing when there's nothing open writes nothing to the history", async () => {
    await setRules("Won", [{ id: rid(), type: "cancel_open_tasks" }]);
    const lead = await h.seedLead({ ownerId: repId, name: "Nothing Open" });
    await move(rep, lead, "Won");
    expect(await automationLines(lead)).toEqual([]);
  });
});
