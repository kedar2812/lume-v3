import { z } from "zod";

const COMMON = new Set(["postgres", "password", "changeme", "lume", "secret", "admin", "root", "12345678"]);

/** Too short, a well-known default, or one repeated character. */
export function isWeakSecret(s: string): boolean {
  return s.length < 16 || COMMON.has(s.toLowerCase()) || /^(.)\1+$/.test(s);
}

const pgUrl = (role: string) =>
  z.string().superRefine((value, ctx) => {
    let u: URL;
    try {
      u = new URL(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "must be a postgres:// URL" });
      return;
    }
    if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
      ctx.addIssue({ code: "custom", message: "must be a postgres:// URL" });
    }
    if (decodeURIComponent(u.username) !== role) {
      ctx.addIssue({ code: "custom", message: `must connect as ${role}` });
    }
    if (isWeakSecret(decodeURIComponent(u.password))) {
      ctx.addIssue({ code: "custom", message: "password is missing or too weak (min 16 chars)" });
    }
  });

const masterKey = z
  .string()
  .refine(
    (v) => /^[A-Za-z0-9+/]+={0,2}$/.test(v) && Buffer.from(v, "base64").length >= 32,
    "must be base64 of at least 32 random bytes",
  );

const AGE_PUBLIC_KEY = /^age1[02-9ac-hj-np-z]{58}$/;

const base = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export const apiSchema = base.extend({
  LUME_PUBLIC_HOST: z.string().min(1),
  LUME_MASTER_KEY: masterKey,
  DATABASE_URL_APP: pgUrl("lume_app"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  SMTP_URL: z.string().url().optional(),
});

export const workerSchema = base.extend({
  LUME_MASTER_KEY: masterKey,
  DATABASE_URL_WORKER: pgUrl("lume_worker"),
  DATABASE_URL_BACKUP: pgUrl("lume_readonly_backup"),
  DATABASE_URL_RESTORE: pgUrl("lume_restore"),
  BACKUP_AGE_RECIPIENTS: z
    .string()
    .transform((s) =>
      s
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean),
    )
    .pipe(
      z
        .array(z.string().regex(AGE_PUBLIC_KEY, "must be an age public key (age1…)"))
        .min(2, "needs the offline key and the restore-test key"),
    ),
  BACKUP_AGE_IDENTITY_FILE: z.string().min(1),
  RCLONE_REMOTE: z.string().min(1).default("offsite:/var/lib/lume/offsite"),
  OPS_SCRIPTS_DIR: z.string().min(1).default("/app/scripts"),
});

export const migrateSchema = base.extend({
  DATABASE_URL_OWNER: pgUrl("lume_owner"),
  MIGRATIONS_DIR: z.string().min(1).default("/app/migrations"),
});

export type ApiConfig = z.infer<typeof apiSchema>;
export type WorkerConfig = z.infer<typeof workerSchema>;
export type MigrateConfig = z.infer<typeof migrateSchema>;
