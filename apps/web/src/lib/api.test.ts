import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, resetCsrfForTests } from "./api";

const csrfResponse = () =>
  new Response(JSON.stringify({ token: "csrf-token-value" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("browser API client", () => {
  beforeEach(() => {
    resetCsrfForTests();
    vi.restoreAllMocks();
  });

  it("sends the CSRF token, an Idempotency-Key and same-origin credentials", async () => {
    const fetchMock = vi.fn(async (url: string | URL) =>
      String(url).endsWith("/auth/csrf") ? csrfResponse() : json(201, { lead: { id: "l1" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await api.post<{ lead: { id: string } }>("/api/v1/leads", { name: "Asha" });
    expect(r).toEqual({ ok: true, status: 201, data: { lead: { id: "l1" } } });
    // The second argument is the RequestInit the client built.
    const [, init] = fetchMock.mock.calls[1]! as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("x-csrf-token")).toBe("csrf-token-value");
    expect(headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(init.credentials).toBe("same-origin");
  });

  it("fetches the CSRF token once and reuses it", async () => {
    const fetchMock = vi.fn(async (url: string | URL) =>
      String(url).endsWith("/auth/csrf") ? csrfResponse() : json(200, {}),
    );
    vi.stubGlobal("fetch", fetchMock);
    await api.post("/api/v1/a");
    await api.post("/api/v1/b");
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/auth/csrf"))).toHaveLength(1);
  });

  it("returns the API's error code and message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        String(url).endsWith("/auth/csrf")
          ? csrfResponse()
          : json(409, {
              error: {
                code: "VERSION_CONFLICT",
                message: "Someone else changed this lead.",
                details: { currentVersion: 4 },
              },
            }),
      ),
    );
    const r = await api.patch("/api/v1/leads/x", { name: "n" });
    expect(r).toEqual({
      ok: false,
      status: 409,
      code: "VERSION_CONFLICT",
      message: "Someone else changed this lead.",
      details: { currentVersion: 4 },
    });
  });

  it("turns an unreachable API into a plain message, never a crash", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network");
      }),
    );
    const r = await api.post("/api/v1/leads", {});
    expect(r).toMatchObject({ ok: false, status: 0, code: "OFFLINE" });
    expect(r.ok === false && r.message.length).toBeGreaterThan(10);
  });

  it("retries once with a fresh token when the CSRF cookie has expired", async () => {
    let csrfCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/auth/csrf")) {
        csrfCalls++;
        return csrfResponse();
      }
      return csrfCalls < 2 ? json(403, { error: { code: "CSRF", message: "no" } }) : json(200, { ok: 1 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await api.post("/api/v1/x");
    expect(r.ok).toBe(true);
    expect(csrfCalls).toBe(2);
  });

  it("handles an empty 204 body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        String(url).endsWith("/auth/csrf") ? csrfResponse() : new Response(null, { status: 204 }),
      ),
    );
    const r = await api.del("/api/v1/me/sessions/abc");
    expect(r).toEqual({ ok: true, status: 204, data: null });
  });

  it("waits out a busy edge once for a read, then carries on", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (String(url).endsWith("/auth/csrf")) return csrfResponse();
        calls++;
        return calls === 1
          ? new Response("", { status: 429, headers: { "retry-after": "0" } })
          : json(200, { ok: 1 });
      }),
    );
    expect(await api.get("/api/v1/leads")).toEqual({ ok: true, status: 200, data: { ok: 1 } });
    expect(calls).toBe(2);
  });

  it("says plainly when the network is sending too much, instead of blaming the connection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        String(url).endsWith("/auth/csrf")
          ? csrfResponse()
          : new Response("", { status: 429, headers: { "retry-after": "0" } }),
      ),
    );
    const r = await api.get("/api/v1/leads");
    expect(r).toMatchObject({ ok: false, status: 429, code: "RATE_LIMITED" });
    expect(!r.ok && r.message).toMatch(/too many requests/i);
    // A write is never repeated on its own.
    const w = await api.post("/api/v1/leads", { name: "A" });
    expect(w).toMatchObject({ ok: false, code: "RATE_LIMITED" });
  });

  it("survives an error page that isn't JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        String(url).endsWith("/auth/csrf")
          ? csrfResponse()
          : new Response("<html>502 Bad Gateway</html>", { status: 502 }),
      ),
    );
    expect(await api.get("/api/v1/leads")).toMatchObject({ ok: false, status: 502, code: "UNKNOWN" });
  });
});
