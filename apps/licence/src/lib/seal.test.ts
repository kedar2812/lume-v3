import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { seal, unseal } from "./seal";

describe("a secret sealed with the master key (AES-256-GCM, bound to what it's for)", () => {
  const master = randomBytes(32);
  it("opens again for the same purpose", () => {
    expect(unseal(master, seal(master, "LUME-7K2P-Q9XD-4MRT-H8VC-7Q2K", "key:c1"), "key:c1")).toBe(
      "LUME-7K2P-Q9XD-4MRT-H8VC-7Q2K",
    );
  });
  it("never opens for another purpose, another master key, or with a byte changed", () => {
    const blob = seal(master, "secret", "key:c1");
    expect(() => unseal(master, blob, "key:c2")).toThrow();
    expect(() => unseal(randomBytes(32), blob, "key:c1")).toThrow();
    const bent = Buffer.from(blob);
    bent[bent.length - 1]! ^= 1;
    expect(() => unseal(master, bent, "key:c1")).toThrow();
  });
  it("seals the same secret differently each time", () => {
    expect(seal(master, "secret", "key:c1").equals(seal(master, "secret", "key:c1"))).toBe(false);
  });
});
