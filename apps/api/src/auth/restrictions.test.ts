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

  it("every limit applies: a role without limits adds nothing, so no extra role lifts a limit Security set (owner, 2026-10-26)", () => {
    // Under "any role allows", adding a role without limits lifted the others' (review 2026-10-25, slice 1 F4).
    const hours = { loginHours: { days: [1], from: "09:00", to: "10:00" }, ipAllowlist: null };
    const open = { loginHours: null, ipAllowlist: null };
    // Tuesday 23:00 UTC: outside the Monday 09:00 to 10:00 hours, whatever else the person holds.
    expect(
      checkLoginRestrictions({
        roles: [hours, open],
        ip: "1.1.1.1",
        now: at("2026-09-22T23:00:00Z"),
        timezone: "UTC",
      }),
    ).toBe("hours");
    // Monday 09:30 UTC: inside them.
    expect(
      checkLoginRestrictions({
        roles: [hours, open],
        ip: "1.1.1.1",
        now: at("2026-09-21T09:30:00Z"),
        timezone: "UTC",
      }),
    ).toBe("ok");
  });

  it("two roles with limits: both must allow; a network limit and an hours limit each hold", () => {
    const office = { loginHours: null, ipAllowlist: ["203.0.113.0/24"] };
    const weekdays = { loginHours: { days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" }, ipAllowlist: null };
    const monday10 = at("2026-09-21T10:00:00Z");
    const sunday10 = at("2026-09-20T10:00:00Z");
    const check = (ip: string, now: Date) =>
      checkLoginRestrictions({ roles: [office, weekdays], ip, now, timezone: "UTC" });
    expect(check("203.0.113.9", monday10)).toBe("ok");
    expect(check("198.51.100.1", monday10)).toBe("ip");
    expect(check("203.0.113.9", sunday10)).toBe("hours");
  });

  it("6A R5: business hours follow Settings' working hours at the moment, not the hours saved", () => {
    // Saved when the business closed at 10:00; it now closes at 19:00 (Mon–Sat).
    const roles = [
      { loginHours: { business: true as const, days: [1], from: "09:00", to: "10:00" }, ipAllowlist: null },
    ];
    const workingHours = { days: [1, 2, 3, 4, 5, 6], start: "09:00", end: "19:00" };
    const check = (iso: string) =>
      checkLoginRestrictions({ roles, ip: "1.1.1.1", now: at(iso), timezone: "Asia/Dubai", workingHours });
    // Monday 21 Sep 2026: 18:30 Dubai = 14:30Z allowed; 19:30 Dubai = 15:30Z refused. Saturday 10:00 allowed.
    expect(check("2026-09-21T14:30:00Z")).toBe("ok");
    expect(check("2026-09-21T15:30:00Z")).toBe("hours");
    expect(check("2026-09-26T06:00:00Z")).toBe("ok");
  });
});
