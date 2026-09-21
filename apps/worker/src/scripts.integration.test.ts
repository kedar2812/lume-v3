import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUE_NAMES, backupName } from "@lume/core";
import {
  MIGRATIONS_DIR_DEFAULT,
  createTestDatabase,
  installQueueSchema,
  listMigrations,
  migrate,
  roleUrl,
  type TestDatabase,
} from "@lume/db";
import { realExec } from "./exec";

const SCRIPTS = path.resolve(import.meta.dirname, "../../../infra/scripts");
let db: TestDatabase;
let work: string;
let offline: { pub: string; file: string };
let restore: { pub: string; file: string };

async function agekey(name: string) {
  const file = path.join(work, `${name}.key`);
  const out = await realExec("age-keygen", ["-o", file]);
  const pub = /age1[0-9a-z]+/.exec(out + (await realExec("age-keygen", ["-y", file])))?.[0];
  if (!pub) throw new Error("no public key");
  return { pub, file };
}

beforeAll(async () => {
  work = await mkdtemp(path.join(tmpdir(), "bk-"));
  db = await createTestDatabase();
  await installQueueSchema(db.url("lume_owner"), QUEUE_NAMES);
  await migrate(db.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);
  offline = await agekey("offline");
  restore = await agekey("restore");
});
afterAll(async () => {
  await db.drop();
  await rm(work, { recursive: true, force: true });
});

describe("backup.sh → restore-test.sh", () => {
  it("writes an encrypted dump both keys can open, and the restore test passes", async () => {
    const remoteDir = path.join(work, "offsite");
    const rclone = { RCLONE_CONFIG_OFFSITE_TYPE: "local" };
    const remote = `offsite:${remoteDir}`;
    const name = backupName(new Date());

    const out = await realExec(path.join(SCRIPTS, "backup.sh"), [], {
      ...rclone,
      DATABASE_URL_BACKUP: roleUrl("lume_readonly_backup", db.name),
      BACKUP_AGE_RECIPIENTS: `${offline.pub},${restore.pub}`,
      RCLONE_REMOTE: remote,
      BACKUP_NAME: name,
    });
    expect(JSON.parse(out.trim())).toMatchObject({ backup: name });
    expect(await readdir(remoteDir)).toEqual([name]);

    // The owner's offline key can open it and it is a real custom-format dump.
    const plain = path.join(work, "check.dump");
    await realExec("age", ["-d", "-i", offline.file, "-o", plain, path.join(remoteDir, name)]);
    expect(await realExec("pg_restore", ["--list", plain])).toMatch(/schema_migrations/);

    const result = JSON.parse(
      (
        await realExec(path.join(SCRIPTS, "restore-test.sh"), [], {
          ...rclone,
          DATABASE_URL_RESTORE: roleUrl("lume_restore", "postgres"),
          BACKUP_AGE_IDENTITY_FILE: restore.file,
          RCLONE_REMOTE: remote,
        })
      ).trim(),
    );
    const migrations = (await listMigrations(MIGRATIONS_DIR_DEFAULT)).length;
    expect(result).toMatchObject({ ok: true, backup: name, migrations });
    expect(result.tables).toBeGreaterThanOrEqual(3);
  });

  it("restore-test.sh fails cleanly when there is no backup", async () => {
    const empty = path.join(work, "empty");
    await writeFile(path.join(work, ".keep"), "");
    await expect(
      realExec(path.join(SCRIPTS, "restore-test.sh"), [], {
        RCLONE_CONFIG_OFFSITE_TYPE: "local",
        DATABASE_URL_RESTORE: roleUrl("lume_restore", "postgres"),
        BACKUP_AGE_IDENTITY_FILE: restore.file,
        RCLONE_REMOTE: `offsite:${empty}`,
      }),
    ).rejects.toMatchObject({ stdout: expect.stringContaining('"ok":false') });
  });
});
