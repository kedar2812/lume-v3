import { execFile } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { rawPublicKey } from "@lume/core";
import { describe, expect, it } from "vitest";
import { hashKey, keyMatches, lastFour, maskedKey, newInstanceId, newLicenceKey } from "./keys";

const run = promisify(execFile);
const KEYGEN = path.resolve(import.meta.dirname, "../../scripts/keygen.mjs");

describe("instance ids and licence keys", () => {
  it("an instance id is LUME-XXXX-XXXX in letters that can't be misread", () => {
    for (let i = 0; i < 50; i++)
      expect(newInstanceId()).toMatch(/^LUME-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  });
  it("a licence key is LUME and five groups of four (100 bits), different every time", () => {
    const a = newLicenceKey();
    expect(a).toMatch(/^LUME(-[0-9A-HJKMNP-TV-Z]{4}){5}$/);
    expect(newLicenceKey()).not.toBe(a);
    expect(lastFour(a)).toBe(a.slice(-4));
    expect(maskedKey(a.slice(-4))).toBe(`LUME-••••-••••-••••-••••-${a.slice(-4)}`);
  });
  it("only a hash is kept; the key matches however it was typed, and nothing else does", () => {
    const k = newLicenceKey();
    const h = hashKey(k);
    expect(h).toHaveLength(32);
    expect(keyMatches(` ${k.toLowerCase()} `, h)).toBe(true);
    expect(keyMatches(k.replace(/-/g, ""), h)).toBe(false);
    expect(keyMatches(newLicenceKey(), h)).toBe(false);
    expect(keyMatches(k, null)).toBe(false);
  });
});

describe("keygen", () => {
  it("writes a private key readable only by its owner, prints the public one, and never overwrites", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "keygen-"));
    const file = path.join(dir, "signing.pem");
    const { stdout } = await run(process.execPath, [KEYGEN, file, "--kid", "lume-1"]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const pub = rawPublicKey(createPublicKey(createPrivateKey(await readFile(file))));
    expect(stdout).toContain(`"lume-1": "${pub}"`);
    expect(stdout).not.toContain("PRIVATE");
    await expect(run(process.execPath, [KEYGEN, file, "--kid", "lume-2"])).rejects.toThrow(/already exists/);
  });
});
