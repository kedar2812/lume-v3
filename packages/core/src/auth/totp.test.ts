import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode } from "./base32";
import { generateRecoveryCodes, hashRecoveryCode, normalizeRecoveryCode } from "./recovery";
import { newTotpSecret, otpauthUri, totpCode, verifyTotp } from "./totp";

// RFC 6238 Appendix B uses the ASCII secret "12345678901234567890" (SHA-1).
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("base32 (RFC 4648)", () => {
  it("matches the RFC test vectors and round-trips", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Decode("MZXW6YTBOI").toString()).toBe("foobar");
    expect(base32Decode("mzxw 6ytb oi").toString()).toBe("foobar");
  });
});

describe("TOTP (RFC 6238)", () => {
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ])("t=%is → %s", (t, code) => {
    expect(totpCode(RFC_SECRET, t * 1000)).toBe(code);
  });

  it("accepts ±1 step of clock drift and nothing beyond", () => {
    const now = 1_700_000_000_000;
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now - 30_000), { nowMs: now })).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now + 30_000), { nowMs: now })).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now - 90_000), { nowMs: now })).toBeNull();
  });

  it("refuses a code at or before the last used step (no replay)", () => {
    const now = 1_700_000_000_000;
    const code = totpCode(RFC_SECRET, now);
    const step = verifyTotp(RFC_SECRET, code, { nowMs: now })!;
    expect(verifyTotp(RFC_SECRET, code, { nowMs: now, lastUsedStep: step })).toBeNull();
  });

  it("rejects malformed codes", () => {
    expect(verifyTotp(RFC_SECRET, "12345", { nowMs: 0 })).toBeNull();
    expect(verifyTotp(RFC_SECRET, "abcdef", { nowMs: 0 })).toBeNull();
  });

  it("makes 160-bit secrets and a standard otpauth URI", () => {
    const s = newTotpSecret();
    expect(base32Decode(s)).toHaveLength(20);
    const uri = otpauthUri({ secret: s, account: "tasneem@nupuur.com", issuer: "LUME · Nupuur Coaching" });
    expect(uri).toMatch(/^otpauth:\/\/totp\/LUME%20%C2%B7%20Nupuur%20Coaching:tasneem%40nupuur\.com\?/);
    expect(uri).toContain(`secret=${s}`);
    expect(uri).toContain("algorithm=SHA1&digits=6&period=30");
  });
});

describe("recovery codes", () => {
  it("makes 10 distinct, unambiguous codes", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
  });

  it("normalises user input before hashing", () => {
    const [c] = generateRecoveryCodes(1);
    expect(hashRecoveryCode(normalizeRecoveryCode(` ${c!.toLowerCase().replace("-", " ")} `))).toBe(
      hashRecoveryCode(c!),
    );
  });
});
