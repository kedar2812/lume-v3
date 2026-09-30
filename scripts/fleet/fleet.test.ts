import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inventory, ROOT, run, tempDir } from "./harness";

const INV = path.join(ROOT, "scripts/fleet/inventory.mjs");
const inv = (file: string, ...args: string[]) =>
  execFileSync(process.execPath, [INV, ...args], {
    encoding: "utf8",
    env: { ...process.env, LUME_INVENTORY: file },
  }).trim();
const invFails = (file: string, ...args: string[]) => {
  try {
    inv(file, ...args);
  } catch (e) {
    return String((e as { stderr?: string }).stderr);
  }
  throw new Error("expected it to fail");
};
const HARBOUR = {
  slug: "harbour-clinic",
  host: "203.0.113.10",
  user: "lume-deploy",
  version: "1.0.0",
  licence: "subscription",
  instance: "LUME-H4RB-8C2L",
  status: "active",
};
const OAK = {
  ...HARBOUR,
  slug: "oakline",
  host: "203.0.113.11",
  instance: "LUME-0AK1-NE00",
  version: "0.9.0",
};

describe("the inventory, deploy/clients.yml (L-C Task 2)", () => {
  it("reads a client's field, and lists the live clients", () => {
    const f = inventory(tempDir(), [
      HARBOUR,
      OAK,
      { ...OAK, slug: "bluebell", host: "203.0.113.12", status: "decommissioned" },
    ]);
    expect(inv(f, "get", "harbour-clinic", "host")).toBe("203.0.113.10");
    expect(inv(f, "list")).toBe("harbour-clinic\noakline");
  });
  it("sets a field and keeps the file's comments and order", () => {
    const f = inventory(tempDir(), [HARBOUR, OAK]);
    inv(f, "set", "oakline", "version", "1.0.0");
    expect(inv(f, "get", "oakline", "version")).toBe("1.0.0");
    expect(inv(f, "get", "harbour-clinic", "version")).toBe("1.0.0");
    const text = readFileSync(f, "utf8");
    expect(text.startsWith("# test fleet\n")).toBe(true);
    expect(text.indexOf("harbour-clinic")).toBeLessThan(text.indexOf("oakline"));
  });
  it("an empty fleet is fine: nothing to list", () => {
    const f = inventory(tempDir(), []);
    expect(inv(f, "list")).toBe("");
  });
  it("refuses an unknown client, an unknown field, and a value that doesn't fit", () => {
    const f = inventory(tempDir(), [HARBOUR]);
    expect(invFails(f, "get", "nobody", "host")).toMatch(/no client "nobody"/);
    expect(invFails(f, "get", "harbour-clinic", "password")).toMatch(/unknown field/);
    expect(invFails(f, "set", "harbour-clinic", "version", "latest")).toMatch(/version/);
    expect(invFails(f, "set", "harbour-clinic", "status", "gone")).toMatch(/status/);
  });
  it("refuses a malformed file rather than guess", () => {
    const d = tempDir();
    const f = path.join(d, "clients.yml");
    writeFileSync(f, "clients:\n  - slug: Bad Slug\n    host: x\n");
    expect(invFails(f, "list")).toMatch(/slug/);
    writeFileSync(f, "clients:\n  - slug: ok\n    host: 1.2.3.4\n    secret: nope\n");
    expect(invFails(f, "list")).toMatch(/unknown field "secret"/);
  });
});

describe("the fleet library and its stubs", () => {
  it("refuses the build host (a client's live server), whatever the inventory says", () => {
    const d = tempDir();
    inventory(d, [{ ...HARBOUR, host: "200.97.166.16" }]);
    const r = run("scripts/fleet/selftest.sh", ["harbour-clinic"], {
      dir: d,
      env: { LUME_INVENTORY: path.join(d, "clients.yml") },
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/build host/);
    expect(r.calls).toEqual([]);
  });
  it("runs each remote step over ssh as the deploy user, in order, and --dry-run calls nothing", () => {
    const d = tempDir();
    inventory(d, [HARBOUR]);
    const env = { LUME_INVENTORY: path.join(d, "clients.yml") };
    const r = run("scripts/fleet/selftest.sh", ["harbour-clinic"], {
      dir: d,
      env,
      answers: [{ match: /uptime/, out: "up 3 days" }],
    });
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([
      "ssh -o BatchMode=yes -o ConnectTimeout=15 lume-deploy@203.0.113.10 uptime",
      "ssh -o BatchMode=yes -o ConnectTimeout=15 lume-deploy@203.0.113.10 docker ps",
    ]);
    expect(r.stdout).toContain("up 3 days");
    const dry = run("scripts/fleet/selftest.sh", ["harbour-clinic", "--dry-run"], { dir: d, env });
    expect(dry.calls).toEqual([]);
    expect(dry.stdout).toMatch(/\[dry-run\] ssh .* uptime/);
  });
  it("a failing remote step stops the script with its exit code", () => {
    const d = tempDir();
    inventory(d, [HARBOUR]);
    const r = run("scripts/fleet/selftest.sh", ["harbour-clinic"], {
      dir: d,
      env: { LUME_INVENTORY: path.join(d, "clients.yml") },
      answers: [{ match: /uptime/, code: 255, out: "no route" }],
    });
    expect(r.code).toBe(255);
    expect(r.calls).toHaveLength(1);
  });
});
