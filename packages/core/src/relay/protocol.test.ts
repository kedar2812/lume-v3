import { describe, expect, it } from "vitest";
import { instanceIdOf, seal, sign, unseal, verify } from "./protocol";

const token = "t".repeat(48);
const other = "o".repeat(48);

describe("the relay protocol (Review Focus 1)", () => {
  it("names an instance by its token without revealing it", () => {
    expect(instanceIdOf(token)).toMatch(/^[0-9a-f]{16}$/);
    expect(instanceIdOf(token)).not.toBe(instanceIdOf(other));
  });
  it("signs and verifies; any change or another token fails", () => {
    const s = sign(token, "nonce-1");
    expect(verify(token, "nonce-1", s)).toBe(true);
    expect(verify(token, "nonce-2", s)).toBe(false);
    expect(verify(other, "nonce-1", s)).toBe(false);
    expect(verify(token, "nonce-1", "garbage")).toBe(false);
  });
  it("seals so only the same token opens it, and tampering is caught", () => {
    const sealed = seal(token, { refreshToken: "rt-123", n: 1 });
    expect(unseal(token, sealed)).toEqual({ refreshToken: "rt-123", n: 1 });
    expect(unseal(other, sealed)).toBeNull();
    const flipped = sealed.slice(0, -2) + (sealed.endsWith("A") ? "B" : "A") + sealed.slice(-1);
    expect(unseal(token, flipped)).toBeNull();
    expect(unseal(token, "not-sealed")).toBeNull();
  });
});
