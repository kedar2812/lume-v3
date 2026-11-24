import { describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { flowsClient, type FlowTrigger } from "./client";

/** The flows client (plan 2026-11-23-flow-builder, review 2026-11-24): what it sends is what the API accepts. */
vi.mock("@/lib/api", () => ({ api: { put: vi.fn(async () => ({ ok: true, status: 200, data: {} })) } }));

describe("the flows client", () => {
  it("ways in go without the server's ids: its schema is strict, and the ids are new on every save", async () => {
    const t: FlowTrigger = {
      id: "t-1",
      kind: "comment",
      accountId: null,
      keywords: ["guide"],
      mode: "word",
      mediaIds: [],
      adIds: [],
      publicReplies: [],
      cooldownHours: 24,
      enabled: true,
    };
    await flowsClient.setTriggers("f1", 3, [t]);
    const { id: _drop, ...sent } = t;
    void _drop;
    expect(api.put).toHaveBeenCalledWith("/api/v1/instagram/flows/f1/triggers", { rev: 3, triggers: [sent] });
    expect(vi.mocked(api.put).mock.calls[0]![1]).toEqual({
      rev: 3,
      triggers: [expect.not.objectContaining({ id: "t-1" })],
    });
  });
});
