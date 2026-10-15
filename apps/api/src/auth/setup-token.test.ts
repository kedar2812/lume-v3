import { describe, expect, it, vi } from "vitest";
import { processSetupTokens } from "./setup-token";

describe("the first-run setup token (report §15.3)", () => {
  it("is printed at boot for an installation with no users", () => {
    const log = vi.fn();
    const t = processSetupTokens(true, log);
    expect(t.current()).toMatch(/.{20,}/);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]![0]).toContain(t.current());
  });

  it("asking for the product key, it's never printed: approval hands it to that browser only (spec 2026-10-15 §1.1)", () => {
    const log = vi.fn();
    const t = processSetupTokens(true, log, { keyMode: true });
    expect(t.current()).toBeNull();
    const handed = t.ensure();
    expect(handed).toMatch(/.{20,}/);
    expect(t.current()).toBe(handed);
    expect(log).not.toHaveBeenCalled();
  });
});
