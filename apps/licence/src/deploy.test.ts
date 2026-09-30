import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { secretFrom } from "@/server/context";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
/** One service's block of the compose file (its indented lines). */
const service = (compose: string, name: string) => {
  const at = compose.indexOf(`\n  ${name}:\n`);
  expect(at).toBeGreaterThan(-1);
  const rest = compose.slice(at + 1);
  const end = rest.slice(1).search(/\n {2}[a-z]+:\n/);
  return end === -1 ? rest : rest.slice(0, end + 1);
};

describe("how the licence server is packed and run", () => {
  it("the build context never carries secrets: .env files, keys, client inputs", () => {
    const ignore = read(".dockerignore").split(/\r?\n/);
    expect(ignore).toEqual(expect.arrayContaining(["**/.env*", "**/*.pem", "deploy/clients"]));
  });

  it("the app and its migration run with no capabilities and a read-only filesystem", () => {
    const compose = read("infra/licence/docker-compose.yml");
    const base = compose.slice(compose.indexOf("x-base: &base"), compose.indexOf("\nnetworks:"));
    for (const name of ["app", "migrate"]) {
      const own = service(compose, name);
      const s = own.includes("<<: *base") ? own + base : own;
      expect(s).toMatch(/cap_drop: \[ALL\]/);
      expect(s).toMatch(/read_only: true/);
      expect(s).toMatch(/no-new-privileges/);
    }
  });

  it("the master key reaches the app as a file, not an environment variable", () => {
    const app = service(read("infra/licence/docker-compose.yml"), "app");
    expect(app).not.toMatch(/LICENCE_MASTER_KEY:/);
    expect(app).toMatch(/LICENCE_MASTER_KEY_FILE: \/run\/secrets\/master\.key/);
    expect(app).toMatch(/\.\/secrets\/master\.key:\/run\/secrets\/master\.key:ro/);
  });

  it("a secret is read from its _FILE when given, else from the variable, trimmed", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lume-secret-"));
    const f = path.join(dir, "master.key");
    writeFileSync(f, "c2VjcmV0\n");
    expect(
      secretFrom({ LICENCE_MASTER_KEY_FILE: f, LICENCE_MASTER_KEY: "other" }, "LICENCE_MASTER_KEY"),
    ).toBe("c2VjcmV0");
    expect(secretFrom({ LICENCE_MASTER_KEY: "abc" }, "LICENCE_MASTER_KEY")).toBe("abc");
    expect(secretFrom({}, "LICENCE_MASTER_KEY")).toBeNull();
  });
});
