import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "../..");
const STUBS = path.join(ROOT, "scripts/fleet/stubs");

/**
 * A staged answer: a call whose words match `match` exits with `code` and prints `out`. First match wins;
 * with `times`, only for its first that many matches.
 */
export type Answer = { match: RegExp; code?: number; out?: string; times?: number };

export type Run = { code: number; stdout: string; stderr: string; calls: string[]; dir: string };

/** The inventory the scripts see in a test (deploy/clients.yml's shape). */
export function inventory(dir: string, clients: Record<string, string>[]): string {
  const file = path.join(dir, "clients.yml");
  const body = clients
    .map((c) =>
      Object.entries(c)
        .map(([k, v], i) => `${i === 0 ? "  - " : "    "}${k}: ${v}`)
        .join("\n"),
    )
    .join("\n");
  writeFileSync(file, `# test fleet\nclients:\n${body}${clients.length ? "\n" : ""}`);
  return file;
}

export const tempDir = () => mkdtempSync(path.join(tmpdir(), "fleet-"));

/**
 * Runs a fleet script as bash with stub ssh, scp, docker and curl first on the PATH: every call is recorded
 * ("ssh lume-deploy@203.0.113.10 docker compose …") and answered from the staged answers.
 */
export function run(
  script: string,
  args: string[],
  o: { dir?: string; answers?: Answer[]; env?: Record<string, string> } = {},
): Run {
  const dir = o.dir ?? tempDir();
  const log = path.join(dir, "calls.log");
  const answers = path.join(dir, "answers.tsv");
  writeFileSync(log, "");
  writeFileSync(
    answers,
    (o.answers ?? [])
      // \x1f (the unit separator), not a tab: bash's read would merge an empty field away.
      .map((a) =>
        [a.match.source, a.code ?? 0, (a.out ?? "").replace(/\n/g, "\\n"), a.times ?? ""].join("\x1f"),
      )
      .join("\n") + "\n",
  );
  for (const s of ["_stub", "ssh", "scp", "docker", "curl", "dig"])
    if (existsSync(path.join(STUBS, s))) chmodSync(path.join(STUBS, s), 0o755);
  const r = spawnSync("bash", [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${STUBS}:${process.env.PATH}`,
      STUB_LOG: log,
      STUB_ANSWERS: answers,
      STUB_UPLOADS: path.join(dir, "uploads"),
      LUME_FLEET_DIR: dir,
      ...o.env,
    },
  });
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr, calls, dir };
}
