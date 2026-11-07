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

  it("lets a thousand people share one office address: the address's ceiling is a setting, 12,000 a minute unless set", () => {
    const zone = /zone per_ip \{[\s\S]*?events ([^\n]+)/.exec(caddy)?.[1]?.trim();
    expect(zone).toBe("{$LUME_EDGE_ADDRESS_PER_MIN:12000}");
    const compose = readFileSync(
      path.resolve(import.meta.dirname, "../../../infra/docker-compose.yml"),
      "utf8",
    );
    expect(compose).toContain("LUME_EDGE_ADDRESS_PER_MIN: ${LUME_EDGE_ADDRESS_PER_MIN:-12000}");
  });

  it("keeps each person's own allowance at 600 a minute", () => {
    expect(/zone per_client \{[\s\S]*?events ([^\n]+)/.exec(caddy)?.[1]?.trim()).toBe("600");
  });

  it("gives the edge room for a thousand open live streams (about 70 KB each, both sides): 256 MB", () => {
    const compose = readFileSync(
      path.resolve(import.meta.dirname, "../../../infra/docker-compose.yml"),
      "utf8",
    );
    const edge = /\n {2}caddy:\n[\s\S]*?mem_limit: (\S+)/.exec(compose)?.[1];
    expect(edge).toBe("256m");
  });
});
