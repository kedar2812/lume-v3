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
});
