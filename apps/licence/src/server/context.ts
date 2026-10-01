import { readFileSync, statSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { LICENCE_KEYS, masterKeyFromBase64 } from "@lume/core";
import pg from "pg";
import { Limiter } from "@/lib/limit";
import { signerProblem, type Signer } from "@/lib/sign";

/** What every handler works with: the database, the signing key, the clock, and the limits. */
export type Ctx = {
  db: pg.Pool;
  signer: Signer;
  now: () => Date;
  limits: { ip: Limiter; instance: Limiter; wrongKey: Limiter; signIn: Limiter };
  /** LICENCE_MASTER_KEY: seals the admin's two-step secret. */
  master: Buffer;
  /** How the server reaches the exchange-rate service (a test's stand-in). */
  fetch: typeof fetch;
};

const HOUR = 3_600_000;
let made: Ctx | null = null;

/** A secret from the file NAME_FILE points at (compose mounts it read-only), else from NAME itself. */
export function secretFrom(env: Record<string, string | undefined>, name: string): string | null {
  const file = env[`${name}_FILE`];
  if (file) {
    // Compose makes a folder where a mounted file was missing: say so, not EISDIR.
    if (statSync(/*turbopackIgnore: true*/ file).isDirectory())
      throw new Error(
        `${name}_FILE (${file}) is a folder, not the key file: put the key there (see the runbook, "Upgrading")`,
      );
    return readFileSync(/*turbopackIgnore: true*/ file, "utf8").trim() || null;
  }
  return env[name]?.trim() || null;
}

/** The running server's context, from its environment (read once). */
export function context(): Ctx {
  if (made) return made;
  const env = process.env;
  const url = env.DATABASE_URL;
  const keyFile = env.LICENCE_SIGNING_KEY_FILE ?? "/run/secrets/signing.pem";
  const kid = env.LICENCE_KID;
  if (!url) throw new Error("DATABASE_URL is not set");
  if (!kid) throw new Error("LICENCE_KID is not set (the id keygen printed with the public key)");
  const masterKey = secretFrom(env, "LICENCE_MASTER_KEY");
  if (!masterKey) throw new Error("LICENCE_MASTER_KEY_FILE (or LICENCE_MASTER_KEY) is not set");
  const signer: Signer = {
    kid,
    privateKey: createPrivateKey(readFileSync(/*turbopackIgnore: true*/ keyFile)),
  };
  // Only e2e, with its own throwaway key, turns this off (LICENCE_KEY_CHECK=off).
  const problem = env.LICENCE_KEY_CHECK === "off" ? null : signerProblem(signer, LICENCE_KEYS);
  if (problem) throw new Error(`Refusing to start: ${problem}`);
  made = {
    db: new pg.Pool({ connectionString: url, max: 10 }),
    signer,
    now: () => new Date(),
    limits: {
      ip: new Limiter(300, HOUR),
      instance: new Limiter(60, HOUR),
      wrongKey: new Limiter(10, HOUR),
      signIn: new Limiter(10, 15 * 60_000),
    },
    master: masterKeyFromBase64(masterKey),
    fetch: globalThis.fetch,
  };
  return made;
}
