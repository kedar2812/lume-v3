import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** What the edge sends to the API on a client's server (infra/Caddyfile). */
const caddy = readFileSync(path.resolve(import.meta.dirname, "../../../infra/Caddyfile"), "utf8");
const apiPaths = (/@api path ([^\n]+)/.exec(caddy)?.[1] ?? "").trim().split(/\s+/);

describe("the Caddyfile", () => {
  it("sends the API its routes, the posts from outside, and WhatsApp's deliveries from the relay (spec 2026-10-18 §3.3)", () => {
    expect(apiPaths).toEqual(
      expect.arrayContaining(["/api/*", "/webhooks/*", "/whatsapp/in", "/healthz", "/readyz"]),
    );
  });
});
