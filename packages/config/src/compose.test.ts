import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const compose = readFileSync(path.join(ROOT, "infra/docker-compose.yml"), "utf8");
/** One service's block of the compose file (its indented lines). */
const service = (name: string) => {
  const at = compose.indexOf(`\n  ${name}:\n`);
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
});
