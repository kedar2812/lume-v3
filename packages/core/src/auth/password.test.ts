import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createBreachedChecker, loadBreachedChecker } from "./breached";
import {
  ARGON2_PRODUCTION,
  hashPassword,
  needsRehash,
  passwordProblems,
  verifyPassword,
  type Argon2Params,
} from "./password";

const FAST: Argon2Params = { memoryCost: 1024, timeCost: 1, parallelism: 1 }; // tests only
const sha1 = (s: string) => createHash("sha1").update(s).digest();

describe("argon2id", () => {
  it("hashes, verifies and rejects the wrong password", async () => {
    const h = await hashPassword("correct horse battery", FAST);
    expect(h.startsWith("$argon2id$v=19$m=1024,t=1,p=1$")).toBe(true);
    expect(await verifyPassword(h, "correct horse battery")).toBe(true);
    expect(await verifyPassword(h, "Correct horse battery")).toBe(false);
  });

  it("treats a malformed stored hash as a failed verify, never a throw", async () => {
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
  });

  it("flags hashes made with other parameters for rehash", async () => {
    const h = await hashPassword("correct horse battery", FAST);
    expect(needsRehash(h, FAST)).toBe(false);
    expect(needsRehash(h, ARGON2_PRODUCTION)).toBe(true);
    expect(needsRehash("$2b$10$legacybcrypt", ARGON2_PRODUCTION)).toBe(true);
  });

  it("uses the report's production cost (≥ 64 MB)", () => {
    expect(ARGON2_PRODUCTION.memoryCost).toBeGreaterThanOrEqual(65536);
  });
});

describe("password policy (report §12.1: length + breach list, no composition rules)", () => {
  const isBreached = createBreachedChecker(
    Buffer.concat([sha1("passwordpassword"), sha1("qwertyuiop123")].sort(Buffer.compare)),
  );

  it("accepts a long passphrase with no symbols", () => {
    expect(passwordProblems("sunset over the dunes", { isBreached })).toEqual([]);
  });

  it("reports every problem", () => {
    expect(passwordProblems("short", { isBreached })).toEqual(["too_short"]);
    expect(passwordProblems("passwordpassword", { isBreached })).toEqual(["breached"]);
    expect(passwordProblems("x".repeat(257), { isBreached })).toEqual(["too_long"]);
    expect(passwordProblems("tasneem.work!2026", { email: "tasneem@nupuur.com", isBreached })).toEqual([
      "contains_email",
    ]);
  });
});

describe("breached list", () => {
  it("binary-searches the bundled NCSC list", async () => {
    const check = await loadBreachedChecker(
      path.resolve(import.meta.dirname, "../../data/breached-sha1.bin"),
    );
    expect(check("password")).toBe(true);
    expect(check("123456")).toBe(true);
    expect(check("a completely unusual lume passphrase 7731")).toBe(false);
  });
});
