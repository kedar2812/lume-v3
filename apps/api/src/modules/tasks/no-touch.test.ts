import { ALL_GRANTS, NO_TOUCH_RULE_ID, newId, type Grant } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";
import { noTouch } from "./no-touch";

let h: Harness;
let owner: string;
let ownerClient: AuthedClient;
const repGrants: Grant[] = (["leads.view", "leads.edit"] as const).map((key) => ({
  key,
  scope: "own" as const,
}));

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  await h.seedUser({ grants: ALL_GRANTS, totp: true });
  const o = await h.seedUser({
    grants: [...repGrants, { key: "messages.send", scope: "own" }, { key: "leads.create", scope: "own" }],
    totp: true,
  });
  owner = o.id;
  ownerClient = await h.signIn(o);
  await h.ownerPool.query(
    `UPDATE settings SET working_hours = '{"days":[0,1,2,3,4,5,6],"start":"00:00","end":"23:59"}' WHERE id = 1`,
  );
});
afterAll(() => h.close());
beforeEach(() => turn(false, 7));

const turn = (enabled: boolean, days: number) =>
  h.ownerPool.query(
    `UPDATE settings SET follow_ups = follow_ups || jsonb_build_object('noTouch', jsonb_build_object('enabled', $1::boolean, 'days', $2::int)) WHERE id = 1`,
    [enabled, days],
  );
const run = () => noTouch({ app: h.app, pool: h.pool });
/** A lead nobody has touched for this many days. */
async function quiet(days: number, o: { stage?: string; ownerId?: string; name?: string } = {}) {
  const id = await h.seedLead({ ownerId: o.ownerId ?? owner, name: o.name ?? "Gone Quiet", stage: o.stage });
  await h.queryAll("UPDATE leads SET last_activity_at = now() - make_interval(days => $2) WHERE id = $1", [
    id,
    days,
  ]);
  return id;
}
const tasksOf = (leadId: string) =>
  h.queryAll<{ id: string; title: string; assignee_id: string; auto_rule_id: string | null; status: string }>(
    "SELECT id, title, assignee_id, auto_rule_id, status FROM tasks WHERE lead_id = $1",
    [leadId],
  );

describe("leads gone quiet (3C Task 4)", () => {
  it("off unless switched on", async () => {
    const lead = await quiet(30);
    await run();
    expect(await tasksOf(lead)).toHaveLength(0);
  });

  it("a quiet lead comes back to its owner, once, with its history in words and a reminder armed", async () => {
    await turn(true, 7);
    const lead = await quiet(10);
    await run();
    await run();
    const tasks = await tasksOf(lead);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      title: "No contact for 7 days",
      assignee_id: owner,
      auto_rule_id: NO_TOUCH_RULE_ID,
      status: "open",
    });
    const [line] = await h.queryAll<{ payload: Record<string, unknown>; user_id: string | null }>(
      "SELECT payload, user_id FROM activities WHERE lead_id = $1 AND type = 'automation'",
      [lead],
    );
    expect(line).toMatchObject({ user_id: null, payload: { rule: "no_touch", result: "done", days: 7 } });
    const armed = await h.queryAll(
      "SELECT 1 FROM scheduled_notifications WHERE task_id = $1 AND status = 'pending'",
      [tasks[0]!.id],
    );
    expect(armed).toHaveLength(1);
    const [l] = await h.queryAll<{ next_task_due_at: Date | null }>(
      "SELECT next_task_due_at FROM leads WHERE id = $1",
      [lead],
    );
    expect(l!.next_task_due_at).not.toBeNull();
  });

  it("not for a lead with any open follow-up, a closed lead, a disabled owner, or one touched lately", async () => {
    await turn(true, 7);
    const busy = await quiet(10, { name: "Has One" });
    const t = newId();
    await h.queryAll(
      "INSERT INTO tasks (id, lead_id, assignee_id, title, due_at, series_id) VALUES ($1, $2, $3, 'Call', now() + interval '1 day', $1)",
      [t, busy, owner],
    );
    const won = await quiet(10, { stage: "Won", name: "Won Already" });
    const gone = (await h.seedUser({ grants: repGrants, totp: true })).id;
    await h.ownerPool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [gone]);
    const orphan = await quiet(10, { ownerId: gone, name: "Owner Gone" });
    const recent = await quiet(3, { name: "Touched Lately" });
    await run();
    expect(await tasksOf(busy)).toHaveLength(1); // only its own
    for (const id of [won, orphan, recent]) expect(await tasksOf(id)).toHaveLength(0);
  });

  it("after its own follow-up is done, not again until another quiet window has passed", async () => {
    await turn(true, 7);
    const lead = await quiet(10, { name: "Done Once" });
    await run();
    await h.queryAll("UPDATE tasks SET status = 'done' WHERE lead_id = $1", [lead]);
    await run();
    expect(await tasksOf(lead)).toHaveLength(1);
    await h.queryAll("UPDATE tasks SET created_at = now() - interval '8 days' WHERE lead_id = $1", [lead]);
    await run();
    expect(await tasksOf(lead)).toHaveLength(2);
  });

  it("Review Focus 5: 500 a run, and two runs at once make one each", async () => {
    await turn(true, 7);
    await h.queryAll("UPDATE leads SET last_activity_at = now() WHERE deleted_at IS NULL"); // earlier tests' leads rest
    // 600 at once, in one statement (one by one is too slow for the per-package test timeout).
    const cfg = await h.config();
    const ids = (
      await h.queryAll<{ id: string }>(
        `INSERT INTO leads (id, pipeline_id, stage_id, owner_id, name, phone_status, last_activity_at)
         SELECT gen_random_uuid(), $1, $2, $3, 'Quiet ' || i, 'missing', now() - interval '20 days'
           FROM generate_series(1, 600) i RETURNING id`,
        [cfg.pipelineId, cfg.stages["New"], owner],
      )
    ).map((r) => r.id);
    const made = async () =>
      Number(
        (
          await h.queryAll<{ n: string }>("SELECT count(*) AS n FROM tasks WHERE lead_id = ANY($1::uuid[])", [
            ids,
          ])
        )[0]!.n,
      );
    const [a, b] = await Promise.all([run(), run()]);
    // One run holds the lock and the other steps aside (or, if the first already finished, takes the rest):
    // never 500 twice over, and never two for a lead.
    expect(Math.max(a, b)).toBe(500);
    expect(await made()).toBe(a + b);
    await run();
    expect(await made()).toBe(600);
    const doubled = await h.queryAll(
      "SELECT lead_id FROM tasks WHERE lead_id = ANY($1::uuid[]) GROUP BY lead_id HAVING count(*) > 1",
      [ids],
    );
    expect(doubled).toHaveLength(0);
  }, 60_000);

  it("its follow-up lands inside working hours", async () => {
    await turn(true, 7);
    await h.queryAll("UPDATE leads SET last_activity_at = now() WHERE deleted_at IS NULL");
    await h.ownerPool.query(
      `UPDATE settings SET timezone = 'Asia/Dubai', working_hours = '{"days":[1,2,3,4,5],"start":"09:00","end":"18:00"}' WHERE id = 1`,
    );
    const lead = await quiet(10, { name: "In Hours" });
    await run();
    const [t] = await h.queryAll<{ due_at: Date }>("SELECT due_at FROM tasks WHERE lead_id = $1", [lead]);
    const p = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Dubai",
      weekday: "short",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(t!.due_at);
    const hour = Number(p.find((x) => x.type === "hour")!.value);
    expect(["Sat", "Sun"]).not.toContain(p.find((x) => x.type === "weekday")!.value);
    expect(hour >= 9 && hour < 18).toBe(true);
    const ev = await h.queryAll<{ detail: { created: number } }>(
      "SELECT detail FROM ops_events WHERE kind = 'tasks.no_touch' ORDER BY id DESC LIMIT 1",
    );
    expect(ev[0]!.detail.created).toBeGreaterThanOrEqual(1);
  });
});

describe("leads gone quiet: 3C final review", () => {
  it("Important 3: finishing a follow-up, or opening WhatsApp, is touching the lead", async () => {
    await turn(true, 7);
    const done = await quiet(30, { name: "Called Yesterday" });
    const t = (
      await ownerClient.inject({
        method: "POST",
        url: `/api/v1/leads/${done}/tasks`,
        payload: { title: "Call her", due: { at: new Date(Date.now() - 60_000).toISOString() } },
      })
    ).json();
    await ownerClient.inject({ method: "POST", url: `/api/v1/tasks/${t.id}/done` });
    const messaged = await h.seedLead({ ownerId: owner, name: "Messaged Today", phone: "+971507770001" });
    await h.queryAll("UPDATE leads SET last_activity_at = now() - interval '30 days' WHERE id = $1", [
      messaged,
    ]);
    const r = await ownerClient.inject({
      method: "POST",
      url: `/api/v1/leads/${messaged}/messages/prepare`,
      payload: { text: "Hi" },
    });
    expect(r.statusCode).toBe(200);
    await run();
    expect((await tasksOf(done)).filter((x) => x.status === "open")).toHaveLength(0);
    expect(await tasksOf(messaged)).toHaveLength(0);
  });
});
