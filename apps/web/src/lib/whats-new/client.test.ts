import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetCsrfForTests } from "../api";
import { whatsNewClient } from "./client";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  resetCsrfForTests();
  vi.restoreAllMocks();
});

describe("whatsNewClient", () => {
  it("PUTs the patch to the person's own record and returns their state", async () => {
    const state = { seen: null, used: ["1.2.0:calls"], pillGone: null };
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/auth/csrf")) return json(200, { token: "t" });
      expect(String(url)).toBe("/api/v1/me/whats-new");
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual({ used: "calls" });
      return json(200, { whatsNew: state });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await whatsNewClient.save({ used: "calls" })).toEqual(state);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a failed save never interrupts: it answers null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        String(url).endsWith("/auth/csrf")
          ? json(200, { token: "t" })
          : json(409, { error: { code: "STALE_VERSION", message: "LUME has been updated." } }),
      ),
    );
    expect(await whatsNewClient.save({ seen: "1.2.0" })).toBeNull();
  });
});
