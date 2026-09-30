import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inventory, run, tempDir, type Answer } from "./harness";

const C = (slug: string, host: string, version = "1.0.0") => ({
  slug,
  host,
  user: "lume-deploy",
  version,
  licence: "subscription",
  instance: "LUME-H4RB-8C2L",
  status: "active",
});
const MIGRATED: Answer = {
  match: /compose run --rm migrate/,
  out: '{"msg":"migrations complete","applied":["0033_example.sql"]}',
};
const NOTHING_TO_MIGRATE: Answer = {
  match: /compose run --rm migrate/,
  out: '{"msg":"migrations complete","applied":[]}',
};

function fleet(clients = [C("harbour-clinic", "203.0.113.10")]) {
  const dir = tempDir();
  inventory(dir, clients);
  const env = {
    LUME_INVENTORY: path.join(dir, "clients.yml"),
    LUME_WAIT_SECONDS: "0",
    LUME_HEALTH_TRIES: "3",
  };
  const version = (slug: string) =>
    new RegExp(`slug: ${slug}\\n(?:    .*\\n)*?    version: (\\S+)`).exec(
      readFileSync(env.LUME_INVENTORY, "utf8"),
    )?.[1];
  return { dir, env, version };
}
const at = (calls: string[], re: RegExp) => calls.findIndex((c) => re.test(c));

describe("update.sh (L-C Task 4)", () => {
  it("backs up first, then pulls, migrates, restarts and checks health; the inventory and the table say so", () => {
    const f = fleet();
    const r = run("scripts/update.sh", ["1.1.0", "harbour-clinic"], {
      dir: f.dir,
      env: f.env,
      answers: [MIGRATED],
    });
    expect(r.code, r.stderr).toBe(0);
    const order = [
      /run --rm worker node dist\/main\.js run-now ops\.backup/,
      /exec -T -u postgres db pg_dump -Fc lume > \/opt\/lume\/backups\/before-1\.1\.0\.dump/,
      /sed -i 's\/\^LUME_TAG=\.\*\/LUME_TAG=1\.1\.0\/' \/opt\/lume\/\.env/,
      /docker compose pull/,
      /docker compose run --rm migrate/,
      /docker compose up -d/,
      /^curl .*https:\/\/harbour-clinic\.lumecrm\.in\/healthz/,
    ].map((re) => at(r.calls, re));
    expect(
      order.every((i) => i >= 0),
      JSON.stringify(r.calls, null, 1),
    ).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(f.version("harbour-clinic")).toBe("1.1.0");
    expect(r.stdout).toMatch(/harbour-clinic\s+1\.0\.0\s+1\.1\.0\s+updated/);
  });

  it("health fails after migrations ran: back to the previous version, and the pre-update backup restored", () => {
    const f = fleet();
    const r = run("scripts/update.sh", ["1.1.0", "harbour-clinic"], {
      dir: f.dir,
      env: f.env,
      answers: [MIGRATED, { match: /^curl /, code: 7, times: 3 }],
    });
    expect(r.code).not.toBe(0);
    const back = at(r.calls, /sed -i 's\/\^LUME_TAG=\.\*\/LUME_TAG=1\.0\.0\/' \/opt\/lume\/\.env/);
    const restore = at(
      r.calls,
      /exec -T -u postgres db pg_restore -d lume --clean --if-exists < \/opt\/lume\/backups\/before-1\.1\.0\.dump/,
    );
    expect(back).toBeGreaterThan(at(r.calls, /compose up -d/));
    expect(restore).toBeGreaterThan(back);
    expect(r.calls.slice(restore).some((c) => /compose up -d/.test(c))).toBe(true);
    expect(f.version("harbour-clinic")).toBe("1.0.0");
    // Anchored: "…, but NOT HEALTHY" must not pass.
    expect(r.stdout).toMatch(
      /harbour-clinic\s+1\.0\.0\s+1\.1\.0\s+rolled back to 1\.0\.0, backup restored$/m,
    );
  });

  it("health fails with nothing migrated: back to the previous version, no restore", () => {
    const f = fleet();
    const r = run("scripts/update.sh", ["1.1.0", "harbour-clinic"], {
      dir: f.dir,
      env: f.env,
      answers: [NOTHING_TO_MIGRATE, { match: /^curl /, code: 7, times: 3 }],
    });
    expect(r.code).not.toBe(0);
    expect(r.calls.some((c) => /pg_restore/.test(c))).toBe(false);
    expect(r.calls.some((c) => /LUME_TAG=1\.0\.0/.test(c))).toBe(true);
    expect(r.stdout).toMatch(/rolled back to 1\.0\.0\s*$/m);
  });

  it("a pull that fails changes nothing but the tag, which goes back", () => {
    const f = fleet();
    const r = run("scripts/update.sh", ["1.1.0", "harbour-clinic"], {
      dir: f.dir,
      env: f.env,
      answers: [{ match: /compose pull/, code: 1, out: "manifest unknown" }],
    });
    expect(r.code).not.toBe(0);
    expect(at(r.calls, /compose run --rm migrate/)).toBe(-1);
    expect(r.calls.some((c) => /LUME_TAG=1\.0\.0/.test(c))).toBe(true);
    expect(f.version("harbour-clinic")).toBe("1.0.0");
  });

  it("a backup that fails stops that client before anything changes", () => {
    const f = fleet();
    const r = run("scripts/update.sh", ["1.1.0", "harbour-clinic"], {
      dir: f.dir,
      env: f.env,
      answers: [{ match: /run-now ops\.backup/, code: 1 }],
    });
    expect(r.code).not.toBe(0);
    expect(r.calls.some((c) => /LUME_TAG=|compose pull/.test(c))).toBe(false);
    expect(r.stdout).toMatch(/harbour-clinic\s+1\.0\.0\s+1\.1\.0\s+backup failed, nothing changed/);
  });

  it("all: carries on past a failed client, and reports each", () => {
    const f = fleet([
      C("harbour-clinic", "203.0.113.10"),
      C("oakline", "203.0.113.11"),
      C("lotus", "203.0.113.12", "1.1.0"),
    ]);
    const r = run("scripts/update.sh", ["1.1.0", "all"], {
      dir: f.dir,
      env: f.env,
      answers: [{ match: /^ssh .*@203\.0\.113\.10 .*run-now ops\.backup/, code: 1 }, MIGRATED],
    });
    expect(r.code).not.toBe(0);
    expect(f.version("harbour-clinic")).toBe("1.0.0");
    expect(f.version("oakline")).toBe("1.1.0");
    expect(r.stdout).toMatch(/harbour-clinic\s+.*backup failed/);
    expect(r.stdout).toMatch(/oakline\s+1\.0\.0\s+1\.1\.0\s+updated/);
    expect(r.stdout).toMatch(/lotus\s+1\.1\.0\s+1\.1\.0\s+already on it/);
    expect(r.calls.some((c) => c.includes("203.0.113.12"))).toBe(false);
  });

  it("--dry-run calls nothing; a version that isn't one is refused", () => {
    const f = fleet();
    const dry = run("scripts/update.sh", ["1.1.0", "all", "--dry-run"], { dir: f.dir, env: f.env });
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.calls).toEqual([]);
    expect(dry.stdout).toMatch(/\[dry-run\] ssh .* docker compose pull/);
    const bad = run("scripts/update.sh", ["latest", "all"], { dir: f.dir, env: f.env });
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toMatch(/X\.Y\.Z/);
  });
});
