import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const compose = readFileSync(path.join(ROOT, "infra/docker-compose.yml"), "utf8");
/** One service's block of the compose file (its indented lines). */
const service = (name: string) => {
  // Under services: a network may share a service's name (render).
  const at = compose.indexOf(`\n  ${name}:\n`, compose.indexOf("\nservices:\n"));
  expect(at).toBeGreaterThan(-1);
  const rest = compose.slice(at + 1);
  const end = rest.slice(1).search(/\n {2}[a-z]+:\n/);
  return end === -1 ? rest : rest.slice(0, end + 1);
};

describe("what a client's server passes to LUME", () => {
  it("Connect with Google's relay reaches the API (without it Sheets' Connect and Calendar can't be switched on)", () => {
    const api = service("api");
    expect(api).toMatch(/GOOGLE_OAUTH_RELAY_URL: \$\{GOOGLE_OAUTH_RELAY_URL:-\}/);
    expect(api).toMatch(/GOOGLE_OAUTH_RELAY_TOKEN: \$\{GOOGLE_OAUTH_RELAY_TOKEN:-\}/);
  });

  it("LUME AI's provider, model and key reach the API (without them LUME AI can't be switched on)", () => {
    const api = service("api");
    for (const k of ["LUME_AI_PROVIDER", "LUME_AI_MODEL", "LUME_AI_KEY"])
      expect(api).toContain(`${k}: \${${k}:-}`);
  });

  it("WhatsApp's files live on their own volume: the API writes it, the worker only reads it for the off-site copy", () => {
    const volumes = compose.slice(compose.indexOf("\nvolumes:\n"), compose.indexOf("\nsecrets:\n"));
    expect(volumes).toContain("\n  files: {}\n");
    expect(service("api")).toContain("      - files:/var/lib/lume/files\n");
    expect(service("worker")).toContain("      - files:/var/lib/lume/files:ro\n");
  });
});

describe("LUME's render service (plan 2026-10-20-media-tab, Task 2)", () => {
  it("is on a network of its own that only the API shares, with no way out", () => {
    const networks = compose.slice(compose.indexOf("\nnetworks:\n"), compose.indexOf("\nvolumes:\n"));
    expect(networks).toMatch(/\n {2}render:\n {4}internal: true\n/);
    expect(service("render")).toMatch(/\n {4}networks: \[render\]\n/);
    expect(service("api")).toMatch(/\n {4}networks: \[frontend, backend, render\]\n/);
    for (const other of ["db", "worker", "web", "caddy"])
      expect(service(other)).not.toMatch(/networks: \[[^\]]*render/);
  });

  it("runs read-only, with no capabilities, a bounded /tmp, memory and processes", () => {
    const render = service("render");
    expect(render).toContain("    image: ${LUME_IMAGE_PREFIX:-lume}/render:${LUME_TAG:-dev}\n");
    expect(render).toContain("    read_only: true\n");
    expect(render).toContain('    cap_drop: ["ALL"]\n');
    expect(render).toContain('    tmpfs: ["/tmp:size=768m"]\n');
    expect(render).toContain("    mem_limit: 1g\n");
    expect(render).toContain("    pids_limit: 128\n");
    expect(render).toContain("    <<: *base\n"); // no-new-privileges, restart, log limits
  });

  it("the API finds it by default, and a server can switch it off with an empty LUME_RENDER_URL", () => {
    expect(service("api")).toContain("      LUME_RENDER_URL: ${LUME_RENDER_URL-http://render:3020}\n");
  });
});
