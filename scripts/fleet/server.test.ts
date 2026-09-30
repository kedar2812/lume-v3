import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./harness";

const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
/** One service's block from the production compose file. */
function service(name: string): string {
  const text = read("infra/docker-compose.yml");
  const start = text.indexOf(`\n  ${name}:\n`);
  const rest = text.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[a-z][a-z-]*:\n/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

describe("a client's server, as the fleet scripts set it up (L-C Task 3)", () => {
  it("the API is given its licence: this installation's ID and key, from .env", () => {
    const api = service("api");
    // Optional here (the dev stack shares this file); provision.sh refuses to run without them.
    expect(api).toMatch(/LUME_INSTANCE_ID: \$\{LUME_INSTANCE_ID:-\}/);
    expect(api).toMatch(/LUME_LICENSE_KEY: \$\{LUME_LICENSE_KEY:-\}/);
    // A release enforces by itself; nothing in .env may switch that off.
    expect(api).not.toMatch(/LUME_LICENSE_MODE/);
  });
  it("hardening makes the spec's deploy user and LUME's directory: lume-deploy, /opt/lume", () => {
    const b = read("infra/scripts/bootstrap-server.sh");
    expect(b).toMatch(/DEPLOY_USER=lume-deploy/);
    expect(b).toMatch(/install -d -m 750 -o "\$DEPLOY_USER" -g "\$DEPLOY_USER" \/opt\/lume/);
    expect(b).not.toMatch(/\/srv\/lume/);
    expect(b).not.toMatch(/\bid deploy\b|usermod -aG (sudo|docker) deploy\b/);
  });
});
