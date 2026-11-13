import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const at = vi.hoisted(() => ({ path: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => [] }),
  headers: async () => new Headers(at.path ? { "x-lume-path": at.path } : {}),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { to });
  }),
}));

const { requireSession } = await import("./session");

const answer = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  vi.clearAllMocks();
  at.path = null;
});
afterEach(() => vi.unstubAllGlobals());

/** Where requireSession sent them, or the error it raised instead. */
async function outcome(): Promise<{ to?: string; error?: string }> {
  try {
    await requireSession();
    return {};
  } catch (e) {
    const to = (e as { to?: string }).to;
    return to ? { to } : { error: (e as Error).message };
  }
}

describe("requireSession (night QA 2026-11-13)", () => {
  it("signed out: to the sign-in page", async () => {
    vi.stubGlobal("fetch", answer(401, { error: { code: "UNAUTHENTICATED" } }));
    expect(await outcome()).toEqual({ to: "/sign-in" });
  });

  it("signed out on a page (an expired session on a bookmarked lead): back to that page after signing in", async () => {
    vi.stubGlobal("fetch", answer(401, { error: { code: "UNAUTHENTICATED" } }));
    at.path = "/leads/0190e0c0-0000-7000-8000-0000000000a1";
    expect(await outcome()).toEqual({ to: "/sign-in?next=%2Fleads%2F0190e0c0-0000-7000-8000-0000000000a1" });
    at.path = "/";
    expect(await outcome()).toEqual({ to: "/sign-in" });
  });

  it("paused: to the paused card", async () => {
    vi.stubGlobal("fetch", answer(403, { error: { code: "SUSPENDED" } }));
    expect(await outcome()).toEqual({ to: "/sign-in?paused=1" });
  });

  it("LUME's server not answering (restarting, overloaded): an error to try again from, never signed out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    expect(await outcome()).toEqual({ error: expect.stringMatching(/didn.t answer/) });
    vi.stubGlobal("fetch", answer(503, { error: { code: "BUSY" } }));
    expect(await outcome()).toEqual({ error: expect.stringMatching(/didn.t answer/) });
  });
});
