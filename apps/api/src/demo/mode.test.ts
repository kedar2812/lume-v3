import { describe, expect, it } from "vitest";
import { demoMode } from "./mode";

describe("demo mode", () => {
  it("is on only with the flag on LUME's own demo address", () => {
    expect(demoMode({ LUME_DEMO_MODE: "true", LUME_PUBLIC_HOST: "demo.lumecrm.in" })).toBe(true);
    expect(demoMode({ LUME_DEMO_MODE: "true", LUME_PUBLIC_HOST: " Demo.LumeCRM.in " })).toBe(true);
  });
  it("can't be turned on by a client's install, even with the flag copied over", () => {
    expect(demoMode({ LUME_DEMO_MODE: "true", LUME_PUBLIC_HOST: "acme.lumecrm.in" })).toBe(false);
    expect(demoMode({ LUME_DEMO_MODE: "true", LUME_PUBLIC_HOST: "app.lumecrm.in" })).toBe(false);
    expect(demoMode({ LUME_DEMO_MODE: "true", LUME_PUBLIC_HOST: "demo.lumecrm.in.evil.example" })).toBe(
      false,
    );
    expect(demoMode({ LUME_DEMO_MODE: "true" })).toBe(false);
  });
  it("is off without the flag, or with anything but exactly true", () => {
    expect(demoMode({ LUME_PUBLIC_HOST: "demo.lumecrm.in" })).toBe(false);
    expect(demoMode({ LUME_DEMO_MODE: "1", LUME_PUBLIC_HOST: "demo.lumecrm.in" })).toBe(false);
    expect(demoMode({ LUME_DEMO_MODE: "false", LUME_PUBLIC_HOST: "demo.lumecrm.in" })).toBe(false);
  });
});
