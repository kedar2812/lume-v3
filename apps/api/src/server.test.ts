import { describe, expect, it } from "vitest";
import { RouteDeclarationError } from "./route-guard";
import { buildServer } from "./server";

const ok = async () => undefined;
const fail = async () => {
  throw new Error("password=hunter2 connection refused");
};

describe("health", () => {
  it("GET /healthz is 200 without touching dependencies", async () => {
    const app = await buildServer({ checks: { database: fail } });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("GET /healthz is public, so it never says which version runs (an unpatched one would show)", async () => {
    const app = await buildServer({ checks: {} });
    expect((await app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("GET /readyz is 200 when every check passes", async () => {
    const app = await buildServer({ checks: { database: ok, queue: ok } });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", checks: { database: "ok", queue: "ok" } });
    await app.close();
  });

  it("GET /readyz is 503 on failure and never leaks the error text", async () => {
    const app = await buildServer({ checks: { database: fail, queue: ok } });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "unavailable", checks: { database: "fail", queue: "ok" } });
    expect(res.body).not.toContain("hunter2");
    await app.close();
  });

  it("GET /readyz treats a hanging check as failed", async () => {
    const hang = () => new Promise(() => undefined);
    const app = await buildServer({ checks: { database: hang }, readinessTimeoutMs: 50 });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

describe("route declarations (report §7.4)", () => {
  it("boot fails if any route lacks a permission or public declaration", async () => {
    await expect(
      buildServer({ checks: {}, register: (app) => void app.get("/api/v1/leads", async () => []) }),
    ).rejects.toThrow(RouteDeclarationError);
  });

  it("routes that declare a permission are accepted", async () => {
    const app = await buildServer({
      checks: {},
      register: (a) => void a.get("/api/v1/leads", { config: { permission: "leads.view" } }, async () => []),
    });
    await app.close();
  });
});

describe("errors (report §4.4)", () => {
  it("unknown routes return the standard error shape", async () => {
    const app = await buildServer({ checks: {} });
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } });
    await app.close();
  });

  it("unexpected errors are 500 with no internals", async () => {
    const app = await buildServer({
      checks: {},
      register: (a) =>
        void a.get("/boom", { config: { public: true } }, async () => {
          throw new Error("SELECT * FROM secret_table");
        }),
    });
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: "INTERNAL_ERROR", message: "Something went wrong" } });
    expect(res.body).not.toContain("secret_table");
    await app.close();
  });

  it("a query the database stopped for taking too long is a 503 in LUME's words, not a crash (Phase 9 Task 4)", async () => {
    const app = await buildServer({
      checks: {},
      register: async (scope) => {
        scope.get("/slow", { config: { public: true } }, async () => {
          throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
        });
        // How a query through the app's drizzle client actually fails: drizzle wraps pg's error, its code in .cause.
        scope.get("/slow-wrapped", { config: { public: true } }, async () => {
          const pgErr = Object.assign(new Error("canceling statement due to statement timeout"), {
            code: "57014",
          });
          throw new Error("Failed query: select pg_sleep(60)", { cause: pgErr });
        });
        scope.get("/busy", { config: { public: true } }, async () => {
          throw new Error("timeout exceeded when trying to connect");
        });
      },
    });
    const slow = await app.inject({ method: "GET", url: "/slow" });
    expect(slow.statusCode).toBe(503);
    expect(slow.headers["retry-after"]).toBe("5");
    expect(slow.json()).toEqual({
      error: { code: "TOO_SLOW", message: "LUME took too long to answer that. Try again in a moment." },
    });
    const wrapped = await app.inject({ method: "GET", url: "/slow-wrapped" });
    expect(wrapped.statusCode).toBe(503);
    expect(wrapped.json().error.code).toBe("TOO_SLOW");
    const busy = await app.inject({ method: "GET", url: "/busy" });
    expect(busy.statusCode).toBe(503);
    expect(busy.json()).toEqual({
      error: { code: "BUSY", message: "LUME is busy right now. Try again in a moment." },
    });
    await app.close();
  });

  it("two changes that collided (a deadlock, a clash, a duplicate) are a 409 in words, not a crash (QA 2026-11-13)", async () => {
    const pg = (code: string) =>
      new Error("Failed query: update …", { cause: Object.assign(new Error("deadlock detected"), { code }) });
    const app = await buildServer({
      checks: {},
      register: async (scope) => {
        scope.get("/deadlock", { config: { public: true } }, async () => {
          throw pg("40P01");
        });
        scope.get("/clash", { config: { public: true } }, async () => {
          throw pg("40001");
        });
        scope.get("/twice", { config: { public: true } }, async () => {
          throw pg("23505");
        });
      },
    });
    for (const url of ["/deadlock", "/clash"]) {
      const r = await app.inject({ method: "GET", url });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({
        error: {
          code: "CHANGED_AT_ONCE",
          message: "Someone else changed this at the same moment. Look again, then try once more.",
        },
      });
    }
    const twice = await app.inject({ method: "GET", url: "/twice" });
    expect(twice.statusCode).toBe(409);
    expect(twice.json()).toEqual({
      error: { code: "ALREADY_EXISTS", message: "That's already there. Look again before adding it." },
    });
    await app.close();
  });
});
