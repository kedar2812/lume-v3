import { describe, expect, it } from "vitest";
import { checkLoginRestrictions } from "./restrictions";

const at = (iso: string) => new Date(iso);

describe("per-role login restrictions (report §12.1)", () => {
  it("passes when no role restricts anything", () => {
    expect(
      checkLoginRestrictions({
        roles: [{ loginHours: null, ipAllowlist: null }],
        ip: "1.2.3.4",
        now: at("2026-09-21T03:00:00Z"),
        timezone: "Asia/Dubai",
      }),
    ).toBe("ok");
  });

  it("uses the business timezone for allowed hours", () => {
    const roles = [{ loginHours: { days: [1, 2, 3, 4, 5], from: "09:00", to: "21:00" }, ipAllowlist: null }];
    // Monday 21 Sep 2026, 08:30 in Dubai = 04:30Z → blocked; 09:30 Dubai = 05:30Z → allowed
    expect(
      checkLoginRestrictions({
        roles,
        ip: "1.1.1.1",
        now: at("2026-09-21T04:30:00Z"),
        timezone: "Asia/Dubai",
      }),
    ).toBe("hours");
    expect(
      checkLoginRestrictions({
        roles,
        ip: "1.1.1.1",
        now: at("2026-09-21T05:30:00Z"),
        timezone: "Asia/Dubai",
      }),
    ).toBe("ok");
    // Sunday is not an allowed day
    expect(
      checkLoginRestrictions({
        roles,
        ip: "1.1.1.1",
        now: at("2026-09-20T08:00:00Z"),
        timezone: "Asia/Dubai",
      }),
    ).toBe("hours");
  });

  it("checks IPv4 and IPv6 allowlists", () => {
    const roles = [{ loginHours: null, ipAllowlist: ["203.0.113.0/24", "2001:db8::/32"] }];
    expect(
      checkLoginRestrictions({ roles, ip: "203.0.113.9", now: at("2026-09-21T09:00:00Z"), timezone: "UTC" }),
    ).toBe("ok");
    expect(
      checkLoginRestrictions({ roles, ip: "2001:db8::1", now: at("2026-09-21T09:00:00Z"), timezone: "UTC" }),
    ).toBe("ok");
    expect(
      checkLoginRestrictions({ roles, ip: "198.51.100.1", now: at("2026-09-21T09:00:00Z"), timezone: "UTC" }),
    ).toBe("ip");
  });

  it("follows the union rule: if any of the user's roles is unrestricted, they may sign in", () => {
    const roles = [
      { loginHours: { days: [1], from: "09:00", to: "10:00" }, ipAllowlist: null },
      { loginHours: null, ipAllowlist: null },
    ];
    expect(
      checkLoginRestrictions({ roles, ip: "1.1.1.1", now: at("2026-09-22T23:00:00Z"), timezone: "UTC" }),
    ).toBe("ok");
  });
});
