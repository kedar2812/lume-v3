import { readFileSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { masterKeyFromBase64 } from "@lume/core";
import pg from "pg";
import { Limiter } from "@/lib/limit";
import type { Signer } from "@/lib/sign";

/** What every handler works with: the database, the signing key, the clock, and the limits. */
export type Ctx = {
  db: pg.Pool;
  signer: Signer;
  now: () => Date;
  limits: { ip: Limiter; instance: Limiter; signIn: Limiter };
  /** LICENCE_MASTER_KEY: seals the admin's two-step secret. */
  master: Buffer;
  /** How the server reaches the exchange-rate service (a test's stand-in). */
  fetch: typeof fetch;
};

const HOUR = 3_600_000;
let made: Ctx | null = null;

/** The running server's context, from its environment (read once). */
export function context(): Ctx {
  if (made) return made;
  const env = process.env;
  const url = env.DATABASE_URL;
  const keyFile = env.LICENCE_SIGNING_KEY_FILE ?? "/run/secrets/signing.pem";
  const kid = env.LICENCE_KID;
  if (!url) throw new Error("DATABASE_URL is not set");
  if (!kid) throw new Error("LICENCE_KID is not set (the id keygen printed with the public key)");
  if (!env.LICENCE_MASTER_KEY) throw new Error("LICENCE_MASTER_KEY is not set");
  made = {
    db: new pg.Pool({ connectionString: url, max: 10 }),
    signer: { kid, privateKey: createPrivateKey(readFileSync(keyFile)) },
    now: () => new Date(),
    limits: {
      ip: new Limiter(300, HOUR),
      instance: new Limiter(60, HOUR),
      signIn: new Limiter(10, 15 * 60_000),
    },
    master: masterKeyFromBase64(env.LICENCE_MASTER_KEY),
    fetch: globalThis.fetch,
  };
  return made;
}
