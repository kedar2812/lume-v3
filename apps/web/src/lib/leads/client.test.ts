import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCsrfForTests } from "@/lib/api";
import { leadsClient } from "./client";
import { EMPTY_FILTERS } from "./filters";

const calls: { url: string; init: RequestInit }[] = [];
beforeEach(() => {
  resetCsrfForTests();
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url.endsWith("/auth/csrf")) return new Response(JSON.stringify({ token: "t" }));
      return new Response(JSON.stringify({ lead: { id: "l1", version: 4 } }), { status: 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("leads client", () => {
  it("sends the version it edited, so a concurrent change is detected instead of overwritten", async () => {
    await leadsClient.patch("l1", 3, { name: "Aisha K" });
    const req = calls.find((c) => c.url === "/api/v1/leads/l1")!;
    expect(new Headers(req.init.headers).get("if-match")).toBe('"3"');
    expect(req.init.method).toBe("PATCH");
  });

  it("asks for at most 50 rows at a time and passes the cursor through", async () => {
    await leadsClient.list({ ...EMPTY_FILTERS, q: "ai" }, "c1");
    const url = new URL(calls.at(-1)!.url, "http://x");
    expect(url.pathname).toBe("/api/v1/leads");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("cursor")).toBe("c1");
    expect(url.searchParams.get("q")).toBe("ai");
  });

  it("asks the board counts without a sort", async () => {
    await leadsClient.counts({ ...EMPTY_FILTERS, pipelineId: "p1" });
    const url = new URL(calls.at(-1)!.url, "http://x");
    expect(url.pathname).toBe("/api/v1/leads/counts");
    expect(url.searchParams.get("pipelineId")).toBe("p1");
    expect(url.searchParams.has("sort")).toBe(false);
  });
});
