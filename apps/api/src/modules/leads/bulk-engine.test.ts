import { ALL_GRANTS, newId, type Grant } from "@lume/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../../../test/harness";
import { setChunkForTests, setInlineMaxForTests } from "./bulk-runs";

// Phase 7B Task 2: queued runs, chunk by chunk — set-based where it can be, each lead still checked on its own.
let h: Harness;
let admin: AuthedClient;
let adminUser: SeededUser;
let cfg: Awaited<ReturnType<Harness["config"]>>;
beforeAll(async () => {
  h = await createHarness({ preset: "coaching" });
  cfg = await h.config();
  adminUser = await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Maya Kapoor" });
  admin = await h.signIn(adminUser);
});
afterAll(() => h.close());
beforeEach(() => {
  setInlineMaxForTests(0); // everything queues
  setChunkForTests(3);
});
afterEach(() => {
  setInlineMaxForTests(null);
  setChunkForTests(null);
});

const start = async (c: AuthedClient, ids: string[], action: object) => {
  const r = await c.inject({
    method: "POST",
    url: "/api/v1/leads/bulk-runs",
    payload: { selection: { ids }, action },
  });
  expect(r.statusCode, r.body).toBe(202);
  return r.json().run.id as string;
};
const read = async (c: AuthedClient, id: string) =>
  (await c.inject({ method: "GET", url: `/api/v1/leads/bulk-runs/${id}` })).json().run;
const seven = async (ownerId: string | null = null) => {
  const ids: string[] = [];
  for (let i = 0; i < 7; i++) ids.push(await h.seedLead({ ownerId, name: `Run Lead ${i}` }));
  return ids;
};
const count = async (sql: string, params: unknown[]) => (await h.queryAll<{ n: number }>(sql, params))[0]!.n;

describe("7B: the engine", () => {
  it("every action over 7 leads in chunks of 3: each lead changed once, with the history a single edit leaves", async () => {
    const sam = await h.seedUser({ grants: [], name: "Sam Reid" });
    const ids = await seven();
    // assign
    const a = await start(admin, ids, { type: "assign", ownerId: sam.id });
    await h.runBulk();
    expect(await read(admin, a)).toMatchObject({ status: "done", done: 7, skipped: 0 });
    expect(
      await count("SELECT count(*)::int AS n FROM leads WHERE id = ANY($1::uuid[]) AND owner_id = $2", [
        ids,
        sam.id,
      ]),
    ).toBe(7);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM lead_assignment_history WHERE lead_id = ANY($1::uuid[]) AND to_user_id = $2 AND reason = 'bulk'",
        [ids, sam.id],
      ),
    ).toBe(7);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM activities WHERE lead_id = ANY($1::uuid[]) AND type = 'assigned'",
        [ids],
      ),
    ).toBe(7);
    // tags
    const tag = (
      await admin.inject({
        method: "POST",
        url: "/api/v1/tags",
        payload: { label: `T ${newId().slice(-6)}` },
      })
    ).json().tag.id;
    await start(admin, ids, { type: "tags", add: [tag] });
    await h.runBulk();
    expect(await count("SELECT count(*)::int AS n FROM lead_tags WHERE tag_id = $1", [tag])).toBe(7);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM activities WHERE lead_id = ANY($1::uuid[]) AND type = 'field_changed'",
        [ids],
      ),
    ).toBe(7);
    // stage (per lead: its history and automations)
    await start(admin, ids, { type: "stage", stageId: cfg.stages.Replied });
    await h.runBulk();
    expect(
      await count("SELECT count(*)::int AS n FROM leads WHERE id = ANY($1::uuid[]) AND stage_id = $2", [
        ids,
        cfg.stages.Replied,
      ]),
    ).toBe(7);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM lead_stage_history WHERE lead_id = ANY($1::uuid[]) AND to_stage_id = $2",
        [ids, cfg.stages.Replied],
      ),
    ).toBe(7);
    // delete: their open follow-ups stop with them
    await h.queryAll(
      `INSERT INTO tasks (id, lead_id, assignee_id, title, due_at, status, series_id)
       VALUES ($1, $2, $3, 'Call back', now() + interval '1 day', 'open', $1)`,
      [newId(), ids[0], adminUser.id],
    );
    const d = await start(admin, ids, { type: "delete" });
    await h.runBulk();
    expect(await read(admin, d)).toMatchObject({ status: "done", done: 7 });
    expect(
      await count(
        "SELECT count(*)::int AS n FROM leads WHERE id = ANY($1::uuid[]) AND deleted_at IS NOT NULL",
        [ids],
      ),
    ).toBe(7);
    expect(
      await count("SELECT count(*)::int AS n FROM tasks WHERE lead_id = $1 AND status = 'open'", [ids[0]]),
    ).toBe(0);
  });

  it("skips what the person may not touch, with the reason, and counts each reason", async () => {
    const repUser = await h.seedUser({
      grants: [
        { key: "leads.view", scope: "own" },
        { key: "leads.bulk_edit", scope: "own" },
        { key: "leads.assign", scope: "own" },
        { key: "leads.edit", scope: "own" },
        { key: "leads.change_stage", scope: "own" },
      ] satisfies Grant[],
    });
    const rep = await h.signIn(repUser);
    const other = await h.seedUser({ grants: [] });
    const mine = [await h.seedLead({ ownerId: repUser.id }), await h.seedLead({ ownerId: repUser.id })];
    const theirs = await h.seedLead({ ownerId: other.id });
    const ghost = newId();
    const r = await start(rep, [...mine, theirs, ghost], { type: "assign", ownerId: repUser.id });
    await h.runBulk();
    expect(await read(rep, r)).toMatchObject({
      status: "done",
      done: 2,
      skipped: 2,
      skippedBy: { LEAD_NOT_FOUND: 2 },
    });
    // phone: a number LUME can already read is left alone, with its reason
    const valid = await h.seedLead({ ownerId: repUser.id, phone: "+971509998888" });
    const fix = await h.seedLead({
      ownerId: repUser.id,
      phoneRaw: "0501234567",
      phoneStatus: "needs_country",
    });
    const p = await start(rep, [valid, fix], { type: "set_phone_country", country: "AE" });
    await h.runBulk();
    expect(await read(rep, p)).toMatchObject({ done: 1, skipped: 1, skippedBy: { ALREADY_VALID: 1 } });
    // lost without a reason: each lead is skipped with its code (POST /leads/bulk has always answered so)
    const l = await start(admin, mine, { type: "stage", stageId: cfg.stages.Lost });
    await h.runBulk();
    expect(await read(admin, l)).toMatchObject({
      done: 0,
      skipped: 2,
      skippedBy: { LOST_REASON_REQUIRED: 2 },
    });
  });

  it("a crash between chunks, or inside one, carries on from the last commit: no chunk twice, none skipped (Review Focus 2)", async () => {
    const sam = await h.seedUser({ grants: [] });
    for (const where of ["between", "inside"] as const) {
      const ids = await seven();
      const id = await start(admin, ids, { type: "assign", ownerId: sam.id });
      await h.runBulk({
        afterChunk: (n) => {
          if (where === "between" && n === 1) throw new Error("test crash");
        },
        midChunk: (n, i) => {
          if (where === "inside" && n === 1 && i === 1) throw new Error("test crash");
        },
      });
      expect(h.bulkQueue).toEqual([id]); // the queue would run it again
      await h.runBulk();
      expect(await read(admin, id)).toMatchObject({ status: "done", done: 7 });
      expect(
        await count(
          "SELECT count(*)::int AS n FROM lead_assignment_history WHERE lead_id = ANY($1::uuid[])",
          [ids],
        ),
      ).toBe(7);
      expect(
        await count(
          "SELECT count(*)::int AS n FROM activities WHERE lead_id = ANY($1::uuid[]) AND type = 'assigned'",
          [ids],
        ),
      ).toBe(7);
    }
  });

  it("cancel stops after the chunk it's on; done stays done, the rest are skipped as cancelled", async () => {
    const sam = await h.seedUser({ grants: [] });
    const ids = await seven();
    const id = await start(admin, ids, { type: "assign", ownerId: sam.id });
    await h.runBulk({
      afterChunk: async (n) => {
        if (n === 0)
          expect(
            (await admin.inject({ method: "POST", url: `/api/v1/leads/bulk-runs/${id}/cancel` })).statusCode,
          ).toBe(200);
      },
    });
    expect(await read(admin, id)).toMatchObject({
      status: "cancelled",
      done: 3,
      skipped: 4,
      skippedBy: { CANCELLED: 4 },
    });
    expect(
      await count("SELECT count(*)::int AS n FROM leads WHERE id = ANY($1::uuid[]) AND owner_id = $2", [
        ids,
        sam.id,
      ]),
    ).toBe(3);
    // Someone else can't cancel your run; a finished run can't be cancelled.
    const other = await h.signIn(await h.seedUser({ grants: [{ key: "leads.bulk_edit", scope: "own" }] }));
    expect(
      (await other.inject({ method: "POST", url: `/api/v1/leads/bulk-runs/${id}/cancel` })).statusCode,
    ).toBe(404);
    expect(
      (await admin.inject({ method: "POST", url: `/api/v1/leads/bulk-runs/${id}/cancel` })).statusCode,
    ).toBe(409);
  });

  it("access lost mid-run ends it as failed at the next chunk; what was done stays (Review Focus 4)", async () => {
    const maker = await h.seedUser({ grants: ALL_GRANTS, totp: true });
    const c = await h.signIn(maker);
    const sam = await h.seedUser({ grants: [] });
    const ids = await seven();
    const id = await start(c, ids, { type: "assign", ownerId: sam.id });
    await h.runBulk({
      afterChunk: async (n) => {
        if (n === 0)
          await h.ownerPool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [maker.id]);
      },
    });
    const [row] = await h.queryAll<{ status: string; done: number; error: string }>(
      "SELECT status, done, error FROM bulk_runs WHERE id = $1",
      [id],
    );
    expect(row).toEqual({ status: "failed", done: 3, error: "Their access changed" });
  });

  it("one notice to each new owner and one to the maker, one audit entry, none per lead (Review Focus 5)", async () => {
    const sam = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], name: "Sam Reid" });
    const ids = await seven();
    const id = await start(admin, ids, { type: "assign", ownerId: sam.id });
    await h.runBulk();
    // Notices are each recipient's own (row-level security): read them as that person.
    const inbox = async (userId: string) => {
      const c = await h.ownerPool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('lume.user_id', $1, true)", [userId]);
        return (
          await c.query<{ kind: string; title: string }>("SELECT kind, title FROM notifications ORDER BY id")
        ).rows;
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    };
    expect(await inbox(sam.id)).toEqual([
      { kind: "lead_assigned", title: "7 leads were assigned to you by Maya" },
    ]);
    expect((await inbox(adminUser.id)).filter((n) => n.kind === "bulk_done").map((n) => n.title)).toContain(
      "LUME assigned 7 leads to Sam Reid.",
    );
    expect(
      await count(
        "SELECT count(*)::int AS n FROM audit_log WHERE action = 'lead.bulk' AND diff->>'run' = $1::text",
        [id],
      ),
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM audit_log WHERE action = 'lead.assign' AND entity_id = ANY($1::text[])",
        [ids],
      ),
    ).toBe(0);
  });

  it("a lead edited after the snapshot is acted on as it is, and its before-value is taken at its chunk", async () => {
    const sam = await h.seedUser({ grants: [] });
    const dev = await h.seedUser({ grants: [] });
    const ids = await seven();
    const id = await start(admin, ids, { type: "assign", ownerId: sam.id });
    await h.queryAll("UPDATE leads SET owner_id = $1, version = version + 1 WHERE id = $2", [dev.id, ids[6]]);
    await h.runBulk();
    const [item] = await h.queryAll<{ before: { ownerId: string } }>(
      "SELECT before FROM bulk_run_items WHERE run_id = $1 AND lead_id = $2",
      [id, ids[6]],
    );
    expect(item!.before).toEqual({ ownerId: dev.id });
    const [lead] = await h.queryAll<{ owner_id: string }>("SELECT owner_id FROM leads WHERE id = $1", [
      ids[6],
    ]);
    expect(lead!.owner_id).toBe(sam.id);
  });

  it("a stage move over many leads does what a single move does: required fields, reopened, the stage's automations, no per-lead audit", async () => {
    // A required field on Replied: only the lead that has a value moves.
    await h.ownerPool.query("UPDATE stages SET required_field_ids = ARRAY[$1]::uuid[] WHERE id = $2", [
      cfg.fields.value,
      cfg.stages.Replied,
    ]);
    try {
      const ids = [
        await h.seedLead({ ownerId: adminUser.id }),
        await h.seedLead({ ownerId: adminUser.id }),
        await h.seedLead({ ownerId: adminUser.id }),
      ];
      await h.queryAll("UPDATE leads SET value = 1000 WHERE id = $1", [ids[0]]);
      const r = await start(admin, ids, { type: "stage", stageId: cfg.stages.Replied });
      await h.runBulk();
      expect(await read(admin, r)).toMatchObject({ done: 1, skipped: 2, skippedBy: { REQUIRED_FIELDS: 2 } });
    } finally {
      await h.ownerPool.query("UPDATE stages SET required_field_ids = '{}' WHERE id = $1", [
        cfg.stages.Replied,
      ]);
    }
    // A lost lead moved back to an open stage is reopened; the stage's rule makes each lead its follow-up.
    await h.ownerPool.query(
      `UPDATE settings SET working_hours = '{"days":[0,1,2,3,4,5,6],"start":"00:00","end":"23:59"}' WHERE id = 1`,
    );
    const rule = {
      id: newId(),
      type: "create_task",
      title: "Bulk follow-up",
      dueIn: { n: 1, unit: "day" },
      assignee: "lead_owner",
    };
    expect(
      (
        await admin.inject({
          method: "PATCH",
          url: `/api/v1/stages/${cfg.stages["Message sent"]}`,
          payload: { onEnter: { rules: [rule] } },
        })
      ).statusCode,
    ).toBeLessThan(300);
    try {
      const ids = [
        await h.seedLead({ ownerId: adminUser.id }),
        await h.seedLead({ ownerId: adminUser.id }),
        await h.seedLead({ ownerId: adminUser.id }),
      ];
      await h.queryAll("UPDATE leads SET stage_id = $1, lost_at = now() WHERE id = $2", [
        cfg.stages.Lost,
        ids[0],
      ]);
      await start(admin, ids, { type: "stage", stageId: cfg.stages["Message sent"] });
      await h.runBulk();
      expect(
        await count("SELECT count(*)::int AS n FROM activities WHERE lead_id = $1 AND type = 'reopened'", [
          ids[0],
        ]),
      ).toBe(1);
      expect(
        await count(
          "SELECT count(*)::int AS n FROM tasks WHERE lead_id = ANY($1::uuid[]) AND title = 'Bulk follow-up' AND status = 'open'",
          [ids],
        ),
      ).toBe(3);
      expect(
        await count("SELECT count(*)::int AS n FROM leads WHERE id = $1 AND lost_at IS NULL", [ids[0]]),
      ).toBe(1);
      expect(
        await count(
          "SELECT count(*)::int AS n FROM audit_log WHERE action = 'lead.stage' AND entity_id = ANY($1::text[])",
          [ids],
        ),
      ).toBe(0);
    } finally {
      await h.ownerPool.query("UPDATE stages SET on_enter = '{}' WHERE id = $1", [
        cfg.stages["Message sent"],
      ]);
    }
  });
});
