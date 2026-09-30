import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inventory, run, tempDir, type Answer } from "./harness";

const CLIENT = {
  slug: "harbour-clinic",
  host: "203.0.113.10",
  user: "lume-deploy",
  version: "none",
  licence: "subscription",
  instance: "LUME-H4RB-8C2L",
  status: "new",
};
const TOKEN = "ghp_readonlypulltoken123";
const INPUTS = [
  "LUME_LICENSE_KEY=LUME-K7PX-2MWD-9RTA-4QZC-7Q2F",
  "GHCR_USER=lume-pull",
  `GHCR_TOKEN=${TOKEN}`,
  "OWNER_AGE_RECIPIENT=age1owneroffline",
].join("\n");
const ANSWERS: Answer[] = [
  { match: /^dig /, out: "203.0.113.10" },
  { match: /age-keygen -y/, out: "age1restorepub" },
  {
    match: /compose logs api/,
    out: "LUME first-run setup token: TOK123abc (open /setup and paste it; valid until the owner account exists)",
  },
];

function fleet(o: { inputs?: string | null; client?: Record<string, string> } = {}) {
  const dir = tempDir();
  inventory(dir, [o.client ?? CLIENT]);
  const clients = path.join(dir, "clients");
  mkdirSync(clients, { recursive: true });
  if (o.inputs !== null) writeFileSync(path.join(clients, "harbour-clinic.env"), `${o.inputs ?? INPUTS}\n`);
  const env = {
    LUME_INVENTORY: path.join(dir, "clients.yml"),
    LUME_CLIENTS_DIR: clients,
    LUME_WAIT_SECONDS: "0",
  };
  const envFile = () => readFileSync(path.join(clients, "harbour-clinic.env"), "utf8");
  return { dir, env, envFile };
}
const at = (calls: string[], re: RegExp) => calls.findIndex((c) => re.test(c));

describe("provision.sh (L-C Task 3)", () => {
  it("a first run: every step in order, then the setup link, and the inventory says so", () => {
    const f = fleet();
    const r = run("scripts/provision.sh", ["harbour-clinic", "--version", "1.0.0"], {
      dir: f.dir,
      env: f.env,
      answers: ANSWERS,
    });
    expect(r.code, r.stderr).toBe(0);
    const order = [
      /^dig \+short harbour-clinic\.lumecrm\.in/,
      /^scp .*bootstrap-server\.sh/,
      /^ssh .*sudo bash \/tmp\/lume-bootstrap\.sh/,
      /^scp .*docker-compose\.yml .*:\/opt\/lume\/docker-compose\.yml/,
      /^ssh .*docker login ghcr\.io -u lume-pull --password-stdin/,
      /^ssh .*age-keygen -o/,
      /^scp .*:\/opt\/lume\/\.env/,
      /^ssh .*docker compose pull/,
      /^ssh .*docker compose run --rm migrate/,
      /^ssh .*docker compose up -d/,
      /^curl .*https:\/\/harbour-clinic\.lumecrm\.in\/healthz/,
    ].map((re) => at(r.calls, re));
    expect(
      order.every((i) => i >= 0),
      JSON.stringify(r.calls, null, 1),
    ).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(r.stdout).toContain("https://harbour-clinic.lumecrm.in/setup");
    expect(r.stdout).toContain("TOK123abc");
    const inv = readFileSync(f.env.LUME_INVENTORY, "utf8");
    expect(inv).toMatch(/version: 1\.0\.0/);
    expect(inv).toMatch(/status: active/);
  });

  it("the server's .env: the pinned version, the licence, both backup keys, secrets; never the registry token", () => {
    const f = fleet();
    const r = run("scripts/provision.sh", ["harbour-clinic", "--version", "1.0.0"], {
      dir: f.dir,
      env: f.env,
      answers: ANSWERS,
    });
    const server = readFileSync(path.join(r.dir, "uploads", ".env"), "utf8");
    expect(server).toMatch(/^LUME_TAG=1\.0\.0$/m);
    expect(server).toMatch(/^LUME_IMAGE_PREFIX=ghcr\.io\/kedar2812\/lume-v3$/m);
    expect(server).toMatch(/^LUME_PUBLIC_HOST=harbour-clinic\.lumecrm\.in$/m);
    expect(server).toMatch(/^LUME_INSTANCE_ID=LUME-H4RB-8C2L$/m);
    expect(server).toMatch(/^LUME_LICENSE_KEY=LUME-K7PX-2MWD-9RTA-4QZC-7Q2F$/m);
    expect(server).toMatch(/^BACKUP_AGE_RECIPIENTS=age1owneroffline,age1restorepub$/m);
    expect(server).toMatch(/^LUME_MASTER_KEY=.{40,}$/m);
    expect(server).toMatch(/^LUME_SECRETS_DIR=\/opt\/lume\/secrets$/m);
    expect(server).not.toContain(TOKEN);
    // The token goes to docker login on its stdin: never in a command line or the output.
    expect(r.calls.join("\n")).not.toContain(TOKEN);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });

  it("run again: nothing new is generated (a new master key would lock every encrypted value)", () => {
    const f = fleet();
    run("scripts/provision.sh", ["harbour-clinic", "--version", "1.0.0"], {
      dir: f.dir,
      env: f.env,
      answers: ANSWERS,
    });
    const first = f.envFile();
    expect(first).toMatch(/^LUME_MASTER_KEY=/m);
    const again = run("scripts/provision.sh", ["harbour-clinic", "--version", "1.0.0"], {
      dir: f.dir,
      env: f.env,
      answers: ANSWERS,
    });
    expect(again.code).toBe(0);
    expect(f.envFile()).toBe(first);
    expect(again.calls.some((c) => /test -s \/opt\/lume\/secrets\/restore\.agekey/.test(c))).toBe(true);
  });

  it("--dry-run prints the steps and calls nothing", () => {
    const f = fleet();
    const r = run("scripts/provision.sh", ["harbour-clinic", "--version", "1.0.0", "--dry-run"], {
      dir: f.dir,
      env: f.env,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.stdout).toMatch(/\[dry-run\] ssh lume-deploy@203\.0\.113\.10 .*docker compose up -d/);
    expect(f.envFile()).not.toMatch(/LUME_MASTER_KEY/);
  });

  it("stops before touching the server when the DNS record isn't there yet", () => {
    const f = fleet();
    const r = run("scripts/provision.sh", ["harbour-clinic", "--version", "1.0.0"], {
      dir: f.dir,
      env: f.env,
      answers: [{ match: /^dig /, out: "198.51.100.99" }],
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/harbour-clinic\.lumecrm\.in points at 198\.51\.100\.99, not 203\.0\.113\.10/);
    expect(r.calls.filter((c) => !c.startsWith("dig "))).toEqual([]);
  });

  it("refuses without the client's inputs, a decommissioned client, or a version that isn't one", () => {
    const none = fleet({ inputs: null });
    const a = run("scripts/provision.sh", ["harbour-clinic", "--version", "1.0.0"], {
      dir: none.dir,
      env: none.env,
    });
    expect(a.code).not.toBe(0);
    expect(a.stderr).toMatch(/harbour-clinic\.env/);
    expect(a.calls).toEqual([]);
    const partial = fleet({ inputs: "GHCR_USER=x" });
    const b = run("scripts/provision.sh", ["harbour-clinic", "--version", "1.0.0"], {
      dir: partial.dir,
      env: partial.env,
    });
    expect(b.stderr).toMatch(/LUME_LICENSE_KEY/);
    expect(b.calls).toEqual([]);
    const gone = fleet({ client: { ...CLIENT, status: "decommissioned" } });
    const c = run("scripts/provision.sh", ["harbour-clinic", "--version", "1.0.0"], {
      dir: gone.dir,
      env: gone.env,
    });
    expect(c.stderr).toMatch(/decommissioned/);
    const d = run("scripts/provision.sh", ["harbour-clinic", "--version", "latest"], {
      dir: none.dir,
      env: none.env,
    });
    expect(d.stderr).toMatch(/version/);
    expect(existsSync(path.join(none.dir, "uploads"))).toBe(false);
  });

  it("the health check waits, and a server that never comes up is a failure (with no inventory change)", () => {
    const f = fleet();
    const r = run("scripts/provision.sh", ["harbour-clinic", "--version", "1.0.0"], {
      dir: f.dir,
      env: { ...f.env, LUME_HEALTH_TRIES: "3" },
      answers: [...ANSWERS, { match: /^curl /, code: 7 }],
    });
    expect(r.code).not.toBe(0);
    expect(r.calls.filter((c) => c.startsWith("curl "))).toHaveLength(3);
    expect(r.stderr).toMatch(/didn't come up/);
    expect(readFileSync(f.env.LUME_INVENTORY, "utf8")).toMatch(/status: new/);
  });
});
