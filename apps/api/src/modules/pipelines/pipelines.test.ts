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
