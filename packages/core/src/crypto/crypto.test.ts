import { describe, expect, it } from "vitest";
import { newId } from "../ids";
import { Keyring, masterKeyFromBase64, newStoredKey } from "./keyring";
import { randomToken, safeEqual, sha256Hex } from "./tokens";

const master = masterKeyFromBase64(Buffer.alloc(32, 9).toString("base64"));

describe("tokens", () => {
  it("random tokens are url-safe and unique", () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(a);
  });
  it("sha256Hex matches the known vector", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("safeEqual compares without early exit and handles length mismatch", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("ids", () => {
  it("are time-ordered UUID v7", () => {
    const a = newId();
    const b = newId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});

describe("Keyring", () => {
  const k1 = newStoredKey(master);
  const ring = Keyring.create(master, [k1]);

  it("round-trips and binds ciphertext to its context", () => {
    const blob = ring.encrypt("JBSWY3DPEHPK3PXP", "totp:user-1");
    expect(ring.decrypt(blob, "totp:user-1")).toBe("JBSWY3DPEHPK3PXP");
    expect(() => ring.decrypt(blob, "totp:user-2")).toThrow();
  });

  it("detects tampering", () => {
    const blob = ring.encrypt("secret", "ctx");
    blob.writeUInt8(blob.at(-1)! ^ 1, blob.length - 1);
    expect(() => ring.decrypt(blob, "ctx")).toThrow();
  });

  it("decrypts data written with a retired key after rotation", () => {
    const old = ring.encrypt("before rotation", "ctx");
    const k2 = newStoredKey(master);
    const rotated = Keyring.create(master, [{ ...k1, active: false }, k2]);
    expect(rotated.activeKeyId).toBe(k2.id);
    expect(rotated.decrypt(old, "ctx")).toBe("before rotation");
  });

  it("refuses a wrong master key", () => {
    const other = masterKeyFromBase64(Buffer.alloc(32, 1).toString("base64"));
    expect(() => Keyring.create(other, [k1])).toThrow();
  });

  it("rejects short master keys", () => {
    expect(() => masterKeyFromBase64(Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
  });
});
