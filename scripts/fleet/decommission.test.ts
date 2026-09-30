import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inventory, run, tempDir, type Answer } from "./harness";

const CLIENT = {
  slug: "bluebell",
  host: "203.0.113.12",
  user: "lume-deploy",
  version: "1.0.0",
  licence: "subscription",
  instance: "LUME-BLUE-BE11",
  status: "active",
};
/** An installation's stored licence token (its signature isn't checked here: the state is only a guard). */
const token = (state: string) =>
  `${Buffer.from(JSON.stringify({ v: 1, kid: "lume-1", instanceId: "LUME-BLUE-BE11", state })).toString("base64url")}.c2lnbmF0dXJl`;
const says = (state: string): Answer => ({ match: /SELECT token FROM licence_state/, out: token(state) });

function fleet() {
  const dir = tempDir();
  inventory(dir, [CLIENT]);
  const clients = path.join(dir, "clients");
  mkdirSync(clients, { recursive: true });
  writeFileSync(
    path.join(clients, "bluebell.env"),
    "GHCR_USER=lume-pull-bluebell\nGHCR_TOKEN=ghp_x\nLUME_MASTER_KEY=abc\n",
  );
  const env = { LUME_INVENTORY: path.join(dir, "clients.yml"), LUME_CLIENTS_DIR: clients };
  return { dir, env, clients };
}
const at = (calls: string[], re: RegExp) => calls.findIndex((c) => re.test(c));

describe("decommission.sh (L-C Task 5)", () => {
  it("refuses without --export-confirmed, and touches nothing", () => {
    const f = fleet();
    const r = run("scripts/decommission.sh", ["bluebell"], {
      dir: f.dir,
      env: f.env,
      answers: [says("suspended")],
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/--export-confirmed/);
    expect(r.calls).toEqual([]);
  });

  it("refuses unless the installation's licence says suspended (it only reads it)", () => {
    for (const state of ["active", "grace", "read_only"]) {
      const f = fleet();
      const r = run("scripts/decommission.sh", ["bluebell", "--export-confirmed"], {
        dir: f.dir,
        env: f.env,
        answers: [says(state)],
      });
      expect(r.code, state).not.toBe(0);
      expect(r.stderr).toMatch(new RegExp(`licence is ${state}, not suspended`));
      expect(r.calls).toHaveLength(1);
    }
    const none = fleet();
    const r = run("scripts/decommission.sh", ["bluebell", "--export-confirmed"], {
      dir: none.dir,
      env: none.env,
      answers: [{ match: /SELECT token/, out: "" }],
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/no licence token/);
  });

  it("removes the stack, its images and volumes, /opt/lume with its backups, the registry login, then the deploy key", () => {
    const f = fleet();
    const r = run("scripts/decommission.sh", ["bluebell", "--export-confirmed"], {
      dir: f.dir,
      env: f.env,
      answers: [says("suspended")],
    });
    expect(r.code, r.stderr).toBe(0);
    const order = [
      /SELECT token FROM licence_state/,
      /cd \/opt\/lume && docker compose down --volumes --rmi all --remove-orphans/,
      /sudo rm -rf \/opt\/lume/,
      /docker logout ghcr\.io/,
      /rm -f ~\/\.ssh\/authorized_keys/,
    ].map((re) => at(r.calls, re));
    expect(
      order.every((i) => i >= 0),
      JSON.stringify(r.calls, null, 1),
    ).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The key goes last: nothing can run after it.
    expect(order.at(-1)).toBe(r.calls.length - 1);
  });

  it("then says what's left for a person: the registry token to revoke and the DNS record to remove", () => {
    const f = fleet();
    const r = run("scripts/decommission.sh", ["bluebell", "--export-confirmed"], {
      dir: f.dir,
      env: f.env,
      answers: [says("suspended")],
    });
    expect(r.stdout).toMatch(/revoke the registry token for lume-pull-bluebell/i);
    expect(r.stdout).toMatch(/bluebell\.lumecrm\.in \(A 203\.0\.113\.12\)/);
    expect(r.stdout).not.toContain("ghp_x");
  });

  it("marks the client decommissioned, and deletes its local secrets (they open nothing now)", () => {
    const f = fleet();
    run("scripts/decommission.sh", ["bluebell", "--export-confirmed"], {
      dir: f.dir,
      env: f.env,
      answers: [says("suspended")],
    });
    expect(readFileSync(f.env.LUME_INVENTORY, "utf8")).toMatch(/status: decommissioned/);
    expect(existsSync(path.join(f.clients, "bluebell.env"))).toBe(false);
  });

  it("a remote step that fails stops it, and the client stays as it was", () => {
    const f = fleet();
    const r = run("scripts/decommission.sh", ["bluebell", "--export-confirmed"], {
      dir: f.dir,
      env: f.env,
      answers: [says("suspended"), { match: /compose down/, code: 1 }],
    });
    expect(r.code).not.toBe(0);
    expect(at(r.calls, /authorized_keys/)).toBe(-1);
    expect(readFileSync(f.env.LUME_INVENTORY, "utf8")).toMatch(/status: active/);
    expect(existsSync(path.join(f.clients, "bluebell.env"))).toBe(true);
  });

  it("--dry-run calls nothing and changes nothing", () => {
    const f = fleet();
    const r = run("scripts/decommission.sh", ["bluebell", "--export-confirmed", "--dry-run"], {
      dir: f.dir,
      env: f.env,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.stdout).toMatch(/\[dry-run\] ssh .* docker compose down/);
    expect(readFileSync(f.env.LUME_INVENTORY, "utf8")).toMatch(/status: active/);
  });
});
