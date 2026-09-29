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

describe("pipelines & stages (report §6)", () => {
  it("setup's preset is visible to anyone who can see leads, in stage order", async () => {
    const rep = await h.signIn(await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] }));
    const { pipelines } = (await rep.inject({ method: "GET", url: "/api/v1/pipelines" })).json();
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0]).toMatchObject({ name: "Coaching sales", isDefault: true });
    expect(pipelines[0].stages.map((s: { name: string }) => s.name)).toEqual([
      "New",
      "Message sent",
      "Replied",
      "Call booked",
      "Call done",
      "Follow-up later",
      "Won",
      "Lost",
    ]);
  });

  it("a new pipeline starts with New / Won / Lost; stages can be added, recoloured and reordered", async () => {
    const p = (
      await admin.inject({ method: "POST", url: "/api/v1/pipelines", payload: { name: "Corporate" } })
    ).json().pipeline;
    expect(p.stages.map((s: { kind: string }) => s.kind)).toEqual(["open", "won", "lost"]);
    const s = (
      await admin.inject({
        method: "POST",
        url: `/api/v1/pipelines/${p.id}/stages`,
        payload: { name: "Pitched", kind: "open", color: "warn", winProbability: 50 },
      })
    ).json().stage;
    expect(s).toMatchObject({ name: "Pitched", position: 3, color: "warn", winProbability: 50 });
    const order = [s.id, ...p.stages.map((x: { id: string }) => x.id)];
    const re = (
      await admin.inject({
        method: "PUT",
        url: `/api/v1/pipelines/${p.id}/stage-order`,
        payload: { stageIds: order },
      })
    ).json().pipeline;
    expect(re.stages.map((x: { id: string }) => x.id)).toEqual(order);
    expect(
      (
        await admin.inject({
          method: "PUT",
          url: `/api/v1/pipelines/${p.id}/stage-order`,
          payload: { stageIds: order.slice(1) },
        })
      ).json().error.code,
    ).toBe("STAGE_ORDER_INCOMPLETE");
  });

  it("keeps at least one won and one lost stage", async () => {
    const p = (
      await admin.inject({ method: "POST", url: "/api/v1/pipelines", payload: { name: "Tiny" } })
    ).json().pipeline;
    const won = p.stages.find((s: { kind: string }) => s.kind === "won");
    expect(
      (await admin.inject({ method: "POST", url: `/api/v1/stages/${won.id}/archive`, payload: {} })).json()
        .error.code,
    ).toBe("STAGE_KINDS_REQUIRED");
    expect(
      (
        await admin.inject({ method: "PATCH", url: `/api/v1/stages/${won.id}`, payload: { kind: "open" } })
      ).json().error.code,
    ).toBe("STAGE_KINDS_REQUIRED");
  });

  it("archiving a stage with leads moves them to an open stage, with history", async () => {
    const cfg = await h.config();
    const owner = await h.seedUser({ grants: [] });
    const lead = await h.seedLead({ ownerId: owner.id, stage: "Replied" });
    const noTarget = await admin.inject({
      method: "POST",
      url: `/api/v1/stages/${cfg.stages.Replied}/archive`,
      payload: {},
    });
    expect(noTarget.json().error.code).toBe("MOVE_TARGET_REQUIRED");
    const toWon = await admin.inject({
      method: "POST",
      url: `/api/v1/stages/${cfg.stages.Replied}/archive`,
      payload: { moveToStageId: cfg.stages.Won },
    });
    expect(toWon.json().error.code).toBe("MOVE_TARGET_INVALID");
    const ok = await admin.inject({
      method: "POST",
      url: `/api/v1/stages/${cfg.stages.Replied}/archive`,
      payload: { moveToStageId: cfg.stages["Message sent"] },
    });
    expect(ok.statusCode).toBe(204);
    const { rows } = await h.ownerPool.query(
      "SELECT 1 FROM stages WHERE id = $1 AND archived_at IS NOT NULL",
      [cfg.stages.Replied],
    );
    expect(rows).toHaveLength(1);
    const moved = await admin.inject({ method: "GET", url: `/api/v1/leads/${lead}` });
    expect(moved.json().lead.stageId).toBe(cfg.stages["Message sent"]);
  });

  it("archive needs full lead visibility, so a partial view can't hide leads", async () => {
    const cfg = await h.config();
    const pm = await h.signIn(
      await h.seedUser({
        grants: [
          { key: "pipelines.manage", scope: null },
          { key: "leads.view", scope: "own" },
        ],
      }),
    );
    const r = await pm.inject({
      method: "POST",
      url: `/api/v1/stages/${cfg.stages["Call done"]}/archive`,
      payload: { moveToStageId: cfg.stages.New },
    });
    expect(r.json().error.code).toBe("NEEDS_FULL_VISIBILITY");
  });

  it("the default pipeline can't be archived; an empty non-default one can", async () => {
    const cfg = await h.config();
    expect(
      (await admin.inject({ method: "POST", url: `/api/v1/pipelines/${cfg.pipelineId}/archive` })).json()
        .error.code,
    ).toBe("DEFAULT_PIPELINE");
    const p = (
      await admin.inject({ method: "POST", url: "/api/v1/pipelines", payload: { name: "Temp" } })
    ).json().pipeline;
    expect(
      (await admin.inject({ method: "POST", url: `/api/v1/pipelines/${p.id}/archive` })).statusCode,
    ).toBe(204);
  });
});

describe("templates and stage moves for new installs (4A Task 2)", () => {
  it("a new install starts with six templates at version 1, and its preset's moves", async () => {
    const t = await h.queryAll<{ name: string; category: string; body: string }>(
      `SELECT m.name, m.category, v.body FROM message_templates m
         JOIN template_versions v ON v.id = m.current_version_id ORDER BY m.position`,
    );
    expect(t).toHaveLength(6);
    expect(t[0]).toMatchObject({ name: "First hello", category: "first_touch" });
    expect(t.every((x) => x.body.includes("{{lead.first_name}}"))).toBe(true);
    const moves = await h.queryAll<{ name: string; sent: string | null; reply: string | null }>(
      `SELECT s.name, a.name AS sent, r.name AS reply FROM stages s
         LEFT JOIN stages a ON a.id = s.after_sent_stage_id LEFT JOIN stages r ON r.id = s.after_reply_stage_id
        WHERE s.archived_at IS NULL AND (s.after_sent_stage_id IS NOT NULL OR s.after_reply_stage_id IS NOT NULL)
        ORDER BY s.position`,
    );
    // The preset's other move (Message sent → Replied after a reply) went when a test above archived
    // Replied: a stage that's gone is no longer anyone's move (4A review, Important 4).
    expect(moves).toEqual([{ name: "New", sent: "Message sent", reply: null }]);
  });

  it("a stage's moves: a stage of the same pipeline, or none; never another pipeline's", async () => {
    const { pipelines } = (await admin.inject({ method: "GET", url: "/api/v1/pipelines" })).json();
    const [a, b] = pipelines[0].stages as { id: string }[];
    const ok = await admin.inject({
      method: "PATCH",
      url: `/api/v1/stages/${b!.id}`,
      payload: { afterSentStageId: a!.id, afterReplyStageId: null },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().stage).toMatchObject({ afterSentStageId: a!.id, afterReplyStageId: null });
    const other = (
      await admin.inject({ method: "POST", url: "/api/v1/pipelines", payload: { name: "Partners" } })
    ).json().pipeline;
    const refused = await admin.inject({
      method: "PATCH",
      url: `/api/v1/stages/${b!.id}`,
      payload: { afterReplyStageId: other.stages[0].id },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toBe("Pick a stage in this pipeline");
    await admin.inject({
      method: "PATCH",
      url: `/api/v1/stages/${b!.id}`,
      payload: { afterSentStageId: null },
    });
  });

  it("4A review, Important 4: a move never points at Lost, and a stage archived or turned Lost stops being one", async () => {
    const p = (
      await admin.inject({ method: "POST", url: "/api/v1/pipelines", payload: { name: "Moves check" } })
    ).json().pipeline as { id: string; stages: { id: string; kind: string }[] };
    const add = async (name: string) =>
      (
        await admin.inject({
          method: "POST",
          url: `/api/v1/pipelines/${p.id}/stages`,
          payload: { name, kind: "open" },
        })
      ).json().stage.id as string;
    const [from, to, later] = [await add("From here"), await add("To here"), await add("Later lost")];
    const lost = p.stages.find((s) => s.kind === "lost")!.id;
    const patch = (id: string, payload: object) =>
      admin.inject({ method: "PATCH", url: `/api/v1/stages/${id}`, payload });

    const toLost = await patch(from, { afterReplyStageId: lost });
    expect(toLost.statusCode).toBe(400);
    expect(toLost.json().error.message).toBe(
      "A lead can't move to a Lost stage after a message or a reply: Lost needs a reason",
    );

    expect((await patch(from, { afterSentStageId: to, afterReplyStageId: later })).statusCode).toBe(200);
    expect(
      (await admin.inject({ method: "POST", url: `/api/v1/stages/${to}/archive`, payload: {} })).statusCode,
    ).toBeLessThan(300);
    expect((await patch(later, { kind: "lost" })).statusCode).toBe(200);
    const [row] = await h.queryAll<{ sent: string | null; reply: string | null }>(
      "SELECT after_sent_stage_id AS sent, after_reply_stage_id AS reply FROM stages WHERE id = $1",
      [from],
    );
    expect(row).toEqual({ sent: null, reply: null });
  });
});
