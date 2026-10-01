import { ALL_GRANTS, newId } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";

let h: Harness;
let admin: AuthedClient;
type Pipeline = {
  id: string;
  bookingStageId: string | null;
  stages: { id: string; name: string; kind: string }[];
};

beforeAll(async () => {
  h = await createHarness({ preset: "coaching" });
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
});
afterAll(async () => h.close());

const pipelines = async (): Promise<Pipeline[]> =>
  (await admin.inject({ method: "GET", url: "/api/v1/pipelines" })).json().pipelines;
const patch = (id: string, bookingStageId: string | null) =>
  admin.inject({ method: "PATCH", url: `/api/v1/pipelines/${id}`, payload: { bookingStageId } });

describe("a pipeline's 'on booking' stage (5B)", () => {
  it("none until an admin picks one of its open stages; shown with the pipeline; cleared with null", async () => {
    const [p] = await pipelines();
    expect(p!.bookingStageId).toBeNull();
    const booked = p!.stages.find((s) => s.name === "Call booked")!;
    const r = await patch(p!.id, booked.id);
    expect(r.statusCode).toBe(200);
    expect(r.json().pipeline.bookingStageId).toBe(booked.id);
    expect((await pipelines())[0]!.bookingStageId).toBe(booked.id);
    expect((await patch(p!.id, null)).json().pipeline.bookingStageId).toBeNull();
  });

  it("refuses another pipeline's stage, a won or lost stage, and a stage that doesn't exist", async () => {
    const [p] = await pipelines();
    const other = (
      await admin.inject({ method: "POST", url: "/api/v1/pipelines", payload: { name: "Corporate" } })
    ).json().pipeline as Pipeline;
    const won = p!.stages.find((s) => s.kind === "won")!;
    for (const bad of [other.stages[0]!.id, won.id, newId()]) {
      const r = await patch(p!.id, bad);
      expect([r.statusCode, r.json().error.code], bad).toEqual([400, "UNKNOWN_STAGE"]);
    }
  });

  it("archiving the stage leaves the pipeline with no booking stage", async () => {
    const [p] = await pipelines();
    const added = (
      await admin.inject({
        method: "POST",
        url: `/api/v1/pipelines/${p!.id}/stages`,
        payload: { name: "Booked online", kind: "open", color: "accent" },
      })
    ).json();
    const stageId: string =
      added.stage?.id ?? added.pipeline.stages.find((s: { name: string }) => s.name === "Booked online").id;
    expect((await patch(p!.id, stageId)).statusCode).toBe(200);
    const a = await admin.inject({ method: "POST", url: `/api/v1/stages/${stageId}/archive`, payload: {} });
    expect(a.statusCode).toBe(204);
    expect((await pipelines())[0]!.bookingStageId).toBeNull();
  });
});

describe("Calendly as a lead source (5B)", () => {
  it("is a source type the database takes", async () => {
    const id = newId();
    await h.ownerPool.query(
      "INSERT INTO lead_sources (id, type, name, status) VALUES ($1, 'calendly', 'Calendly', 'active')",
      [id],
    );
    expect((await h.ownerPool.query("SELECT type FROM lead_sources WHERE id = $1", [id])).rows).toEqual([
      { type: "calendly" },
    ]);
  });
});
