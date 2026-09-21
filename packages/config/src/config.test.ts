import { describe, expect, it } from "vitest";
import { ConfigError, apiSchema, isWeakSecret, loadConfig, migrateSchema, workerSchema } from "./index";

const PW = "k3yP4ssw0rdL0ngEnough9";
const KEY = Buffer.alloc(32, 7).toString("base64");
const AGE_A = "age1" + "q".repeat(58);
const AGE_B = "age1" + "p".repeat(58);
const url = (role: string, pw = PW) => `postgres://${role}:${pw}@db:5432/lume`;

const apiEnv = {
  LUME_PUBLIC_HOST: "lume.localhost",
  LUME_MASTER_KEY: KEY,
  DATABASE_URL_APP: url("lume_app"),
};
const workerEnv = {
  LUME_MASTER_KEY: KEY,
  DATABASE_URL_WORKER: url("lume_worker"),
  DATABASE_URL_BACKUP: url("lume_readonly_backup"),
  DATABASE_URL_RESTORE: url("lume_restore"),
  BACKUP_AGE_RECIPIENTS: `${AGE_A}, ${AGE_B}`,
  BACKUP_AGE_IDENTITY_FILE: "/run/secrets/restore_agekey",
};

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e.issues;
    throw e;
  }
  throw new Error("expected ConfigError");
}

describe("loadConfig", () => {
  it("accepts a valid api env and applies defaults", () => {
    const c = loadConfig(apiSchema, apiEnv);
    expect(c.API_PORT).toBe(3001);
    expect(c.NODE_ENV).toBe("production");
  });

  it("reports every missing variable at once", () => {
    const issues = issuesOf(() => loadConfig(apiSchema, {}));
    expect(issues.length).toBeGreaterThanOrEqual(3);
    expect(issues.join("\n")).toMatch(/DATABASE_URL_APP/);
    expect(issues.join("\n")).toMatch(/LUME_MASTER_KEY/);
    expect(issues.join("\n")).toMatch(/LUME_PUBLIC_HOST/);
  });

  it("rejects a master key shorter than 32 bytes", () => {
    const issues = issuesOf(() =>
      loadConfig(apiSchema, { ...apiEnv, LUME_MASTER_KEY: Buffer.alloc(16, 1).toString("base64") }),
    );
    expect(issues.join()).toMatch(/LUME_MASTER_KEY/);
  });

  it("rejects weak database passwords and the wrong role", () => {
    expect(
      issuesOf(() =>
        loadConfig(apiSchema, { ...apiEnv, DATABASE_URL_APP: url("lume_app", "postgres") }),
      ).join(),
    ).toMatch(/too weak/);
    expect(
      issuesOf(() => loadConfig(apiSchema, { ...apiEnv, DATABASE_URL_APP: url("lume_owner") })).join(),
    ).toMatch(/lume_app/);
  });

  it("never echoes secret values in errors", () => {
    const err = issuesOf(() =>
      loadConfig(apiSchema, { ...apiEnv, DATABASE_URL_APP: url("lume_owner"), LUME_MASTER_KEY: "c2hvcnQ=" }),
    ).join();
    expect(err).not.toContain(PW);
    expect(err).not.toContain("c2hvcnQ=");
  });

  it("parses worker recipients and requires two keys", () => {
    expect(loadConfig(workerSchema, workerEnv).BACKUP_AGE_RECIPIENTS).toEqual([AGE_A, AGE_B]);
    expect(
      issuesOf(() => loadConfig(workerSchema, { ...workerEnv, BACKUP_AGE_RECIPIENTS: AGE_A })).join(),
    ).toMatch(/offline key and the restore-test key/);
  });

  it("treats empty optional api variables as unset and validates them when present", () => {
    const cfg = loadConfig(apiSchema, { ...apiEnv, LUME_PUBLIC_URL: "", SMTP_URL: "", MAIL_FROM: "" });
    expect(cfg.LUME_PUBLIC_URL).toBeUndefined();
    expect(cfg.SMTP_URL).toBeUndefined();
    expect(cfg.BREACHED_LIST_FILE).toBe("/app/data/breached-sha1.bin");
    const ok = loadConfig(apiSchema, {
      ...apiEnv,
      LUME_PUBLIC_URL: "https://lume.localhost:8443",
      SMTP_URL: "smtp://mailpit:1025",
    });
    expect(ok.SMTP_URL).toBe("smtp://mailpit:1025");
    const bad = issuesOf(() =>
      loadConfig(apiSchema, { ...apiEnv, SMTP_URL: "http://mail", LUME_PUBLIC_URL: "ftp://x" }),
    );
    expect(bad.join("\n")).toMatch(/SMTP_URL/);
    expect(bad.join("\n")).toMatch(/LUME_PUBLIC_URL/);
  });

  it("validates the migrate env", () => {
    expect(loadConfig(migrateSchema, { DATABASE_URL_OWNER: url("lume_owner") }).MIGRATIONS_DIR).toBe(
      "/app/migrations",
    );
  });
});

describe("isWeakSecret", () => {
  it("flags short, common and repeated secrets", () => {
    expect(isWeakSecret("short")).toBe(true);
    expect(isWeakSecret("changeme")).toBe(true);
    expect(isWeakSecret("aaaaaaaaaaaaaaaaaaaa")).toBe(true);
    expect(isWeakSecret(PW)).toBe(false);
  });
});
