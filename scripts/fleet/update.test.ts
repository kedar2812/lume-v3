import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inventory, run as runScript, tempDir, type Answer } from "./harness";

/** What the running API's image is, asked after each update: by default the new version (a real update). */
const RUNNING: Answer = { match: /compose ps --format/, out: "ghcr.io/kedar2812/lume-v3/api:1.1.0" };
/** Every update run answers the running image last, so a test's own answer to it comes first. */
const run = (script: string, args: string[], o: Parameters<typeof runScript>[2] = {}) =>
  runScript(script, args, { ...o, answers: [...(o.answers ?? []), RUNNING] });

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

/** The release's own edge and compose files (what `git show v<version>:infra/…` gives outside the tests). */
function release(dir: string, o: { caddy?: string; compose?: string } = {}) {
  const rel = path.join(dir, "release");
  mkdirSync(path.join(rel, "infra"), { recursive: true });
  if (o.caddy !== "")
    writeFileSync(path.join(rel, "infra/Caddyfile"), o.caddy ?? "# the release's Caddyfile\n");
  if (o.compose !== "")
    writeFileSync(path.join(rel, "infra/docker-compose.yml"), o.compose ?? "# the release's compose file\n");
  return rel;
}

function fleet(clients = [C("harbour-clinic", "203.0.113.10")]) {
  const dir = tempDir();
  inventory(dir, clients);
  const env = {
    LUME_RELEASE_DIR: release(dir),
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
      // Old update dumps (plain lead data) go after 14 days; this one is named for its moment.
      /find \/opt\/lume\/backups -name 'before-\*\.dump' -mtime \+14 -delete/,
      /exec -T -u postgres db pg_dump -Fc lume > \/opt\/lume\/backups\/before-1\.1\.0-\d{8}T\d{6}\.dump/,
      /sed -i "s\/\^LUME_TAG=\.\*\/LUME_TAG='1\.1\.0'\/" \/opt\/lume\/\.env/,
      /docker compose pull/,
      // The old app stops before migrations: they lock lead tables while they build and backfill (7A review).
      /docker compose stop api worker/,
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

  it("ships the release's Caddyfile and compose file (the old ones kept), checks them against the server's .env, then pulls; the proxy restarts if its file changed", () => {
    const f = fleet();
    writeFileSync(
      path.join(f.env.LUME_RELEASE_DIR, "infra/Caddyfile"),
      "events {$LUME_EDGE_ADDRESS_PER_MIN:12000}\n",
    );
    const r = run("scripts/update.sh", ["1.1.0", "harbour-clinic"], {
      dir: f.dir,
      env: f.env,
      answers: [NOTHING_TO_MIGRATE],
    });
    expect(r.code, r.stderr).toBe(0);
    expect(readFileSync(path.join(r.dir, "uploads", "Caddyfile.next"), "utf8")).toContain("12000");
    expect(readFileSync(path.join(r.dir, "uploads", "docker-compose.yml.next"), "utf8")).toContain(
      "the release's compose file",
    );
    const order = [
      /LUME_TAG='1\.1\.0'/,
      /^scp .*Caddyfile .*:\/opt\/lume\/Caddyfile\.next$/,
      /^scp .*docker-compose\.yml .*:\/opt\/lume\/docker-compose\.yml\.next$/,
      /cp -p Caddyfile Caddyfile\.prev && cp -p docker-compose\.yml docker-compose\.yml\.prev && mv Caddyfile\.next Caddyfile && mv docker-compose\.yml\.next docker-compose\.yml/,
      /docker compose config --quiet/,
      /docker compose pull/,
      /docker compose up -d$/,
      /cmp -s Caddyfile Caddyfile\.prev \|\| docker compose restart caddy/,
    ].map((re) => at(r.calls, re));
    expect(
      order.every((i) => i >= 0),
      JSON.stringify(r.calls, null, 1),
    ).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("the release's compose file doesn't fit this server's .env: the old files and the old version go back, nothing is pulled", () => {
    const f = fleet();
    const r = run("scripts/update.sh", ["1.1.0", "harbour-clinic"], {
      dir: f.dir,
      env: f.env,
      answers: [
        { match: /docker compose config --quiet/, code: 1, out: "required variable LUME_X is missing" },
      ],
    });
    expect(r.code).not.toBe(0);
    expect(at(r.calls, /compose pull/)).toBe(-1);
    expect(
      r.calls.some((c) =>
        /mv Caddyfile\.prev Caddyfile && mv docker-compose\.yml\.prev docker-compose\.yml/.test(c),
      ),
    ).toBe(true);
    expect(r.calls.some((c) => /LUME_TAG='1\.0\.0'/.test(c))).toBe(true);
    expect(r.stdout).toMatch(
      /harbour-clinic\s+1\.0\.0\s+1\.1\.0\s+the release's compose file doesn't fit this server's \.env, nothing changed/,
    );
    expect(f.version("harbour-clinic")).toBe("1.0.0");
  });

  it("a rollback puts the old Caddyfile and compose file back before the old version starts", () => {
    const f = fleet();
    const r = run("scripts/update.sh", ["1.1.0", "harbour-clinic"], {
      dir: f.dir,
      env: f.env,
      answers: [NOTHING_TO_MIGRATE, { match: /^curl /, code: 7, times: 3 }],
    });
    expect(r.code).not.toBe(0);
    const back = at(
      r.calls,
      /mv Caddyfile\.prev Caddyfile && mv docker-compose\.yml\.prev docker-compose\.yml/,
    );
    const firstUp = at(r.calls, /docker compose up -d$/);
    expect(back).toBeGreaterThan(firstUp);
    expect(r.calls.slice(back).some((c) => /docker compose up -d$/.test(c))).toBe(true);
    expect(
      r.calls
        .slice(back)
        .some((c) =>
          /cmp -s Caddyfile Caddyfile\.next \|\| docker compose restart caddy|docker compose restart caddy/.test(
            c,
          ),
        ),
    ).toBe(true);
  });

  it("a release without its Caddyfile or compose file to ship stops before anything changes", () => {
    const f = fleet();
    release(f.dir, { caddy: "", compose: "" });
    const empty = path.join(f.dir, "empty-release");
    mkdirSync(empty);
    const r = run("scripts/update.sh", ["1.1.0", "harbour-clinic"], {
      dir: f.dir,
      env: { ...f.env, LUME_RELEASE_DIR: empty },
    });
    expect(r.code).not.toBe(0);
    expect(r.calls.some((c) => /ops\.backup|LUME_TAG=|compose pull/.test(c))).toBe(false);
    expect(r.stderr).toMatch(/1\.1\.0's Caddyfile and compose file/);
    expect(f.version("harbour-clinic")).toBe("1.0.0");
  });

  it("health fails after migrations ran: back to the previous version, and the pre-update backup restored", () => {
    const f = fleet();
    const r = run("scripts/update.sh", ["1.1.0", "harbour-clinic"], {
      dir: f.dir,
      env: f.env,
      answers: [MIGRATED, { match: /^curl /, code: 7, times: 3 }],
    });
    expect(r.code).not.toBe(0);
    const back = at(r.calls, /sed -i "s\/\^LUME_TAG=\.\*\/LUME_TAG='1\.0\.0'\/" \/opt\/lume\/\.env/);
    // The whole database goes back: dropped and recreated from the dump, so nothing the failed migration made
    // survives (else the fixed release's migration would fail on it, every time).
    const restore = at(
      r.calls,
      /exec -T -u postgres db sh -c 'dropdb --force lume && pg_restore --create -d postgres' < \/opt\/lume\/backups\/before-1\.1\.0-\d{8}T\d{6}\.dump/,
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

  it("pg-boss changed its own schema on the new version's start: that counts as migrated, the backup goes back", () => {
    const f = fleet();
    const r = run("scripts/update.sh", ["1.1.0", "harbour-clinic"], {
      dir: f.dir,
      env: f.env,
      answers: [
        NOTHING_TO_MIGRATE,
        { match: /pgboss\.version/, out: "24", times: 1 },
        { match: /pgboss\.version/, out: "25" },
        { match: /^curl /, code: 7, times: 3 },
      ],
    });
    expect(r.code).not.toBe(0);
    expect(r.calls.some((c) => /pg_restore --create/.test(c))).toBe(true);
    expect(r.stdout).toMatch(/rolled back to 1\.0\.0, backup restored$/m);
  });

  it("pg-boss's version unreadable after the failure (psql blipped) is no change: no restore", () => {
    const f = fleet();
    const r = run("scripts/update.sh", ["1.1.0", "harbour-clinic"], {
      dir: f.dir,
      env: f.env,
      answers: [
        NOTHING_TO_MIGRATE,
        { match: /pgboss\.version/, out: "24", times: 1 },
        { match: /pgboss\.version/, code: 1, out: "" },
        { match: /^curl /, code: 7, times: 3 },
      ],
    });
    expect(r.code).not.toBe(0);
    expect(r.calls.some((c) => /pg_restore/.test(c))).toBe(false);
  });

  it("the old app won't stop: nothing migrates, back to the previous version, no restore (7A review)", () => {
    const f = fleet();
    const r = run("scripts/update.sh", ["1.1.0", "harbour-clinic"], {
      dir: f.dir,
      env: f.env,
      answers: [{ match: /docker compose stop api worker$/, code: 1 }],
    });
    expect(r.code).not.toBe(0);
    expect(r.calls.some((c) => /compose run --rm migrate/.test(c))).toBe(false);
    expect(r.calls.some((c) => /pg_restore/.test(c))).toBe(false);
    expect(r.calls.some((c) => /LUME_TAG='1\.0\.0'/.test(c))).toBe(true);
    expect(f.version("harbour-clinic")).toBe("1.0.0");
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
    expect(r.calls.some((c) => /LUME_TAG='1\.0\.0'/.test(c))).toBe(true);
    expect(r.stdout).toMatch(/rolled back to 1\.0\.0\s*$/m);
  });

  it("if the new version can't be set, nothing is pulled and the client stays as it was", () => {
    const f = fleet();
    const r = run("scripts/update.sh", ["1.1.0", "harbour-clinic"], {
      dir: f.dir,
      env: f.env,
      answers: [{ match: /LUME_TAG='1\.1\.0'/, code: 255, out: "connection reset" }],
    });
    expect(r.code).not.toBe(0);
    expect(at(r.calls, /compose pull/)).toBe(-1);
    expect(r.stdout).toMatch(
      /harbour-clinic\s+1\.0\.0\s+1\.1\.0\s+couldn't set the version, nothing changed/,
    );
    expect(f.version("harbour-clinic")).toBe("1.0.0");
  });

  it("healthy but not on the new version isn't updated: it rolls back, and the inventory keeps the real one", () => {
    const f = fleet();
    const r = run("scripts/update.sh", ["1.1.0", "harbour-clinic"], {
      dir: f.dir,
      env: f.env,
      answers: [MIGRATED, { match: /compose ps --format/, out: "ghcr.io/kedar2812/lume-v3/api:1.0.0" }],
    });
    expect(r.code).not.toBe(0);
    expect(f.version("harbour-clinic")).toBe("1.0.0");
    expect(r.stdout).toMatch(/rolled back to 1\.0\.0/);
  });

  it("all: one client rolls back after migrations, the next still updates", () => {
    const f = fleet([C("harbour-clinic", "203.0.113.10"), C("oakline", "203.0.113.11")]);
    const r = run("scripts/update.sh", ["1.1.0", "all"], {
      dir: f.dir,
      env: f.env,
      answers: [MIGRATED, { match: /^curl .*harbour-clinic/, code: 7, times: 3 }],
    });
    expect(r.code).not.toBe(0);
    expect(f.version("harbour-clinic")).toBe("1.0.0");
    expect(f.version("oakline")).toBe("1.1.0");
    expect(r.stdout).toMatch(
      /harbour-clinic\s+1\.0\.0\s+1\.1\.0\s+rolled back to 1\.0\.0, backup restored$/m,
    );
    expect(r.stdout).toMatch(/oakline\s+1\.0\.0\s+1\.1\.0\s+updated$/m);
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
    expect(r.calls.some((c) => /LUME_TAG='1\.0\.0'/.test(c))).toBe(true);
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
