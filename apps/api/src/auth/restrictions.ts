import { BlockList, isIPv6 } from "node:net";
import type { WorkingHours } from "@lume/core";
import type { LoginHours } from "@lume/db";

type RoleRestriction = { loginHours: LoginHours | null; ipAllowlist: string[] | null };

function localParts(now: Date, timezone: string): { day: number; hm: string } {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(f.formatToParts(now).map((p) => [p.type, p.value]));
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday!);
  return { day, hm: `${parts.hour}:${parts.minute}` };
}

function ipAllowed(ip: string, cidrs: string[]): boolean {
  const list = new BlockList();
  for (const c of cidrs) {
    const [net, bits] = c.split("/");
    list.addSubnet(net!, Number(bits ?? (isIPv6(net!) ? 128 : 32)), isIPv6(net!) ? "ipv6" : "ipv4");
  }
  return list.check(ip, isIPv6(ip) ? "ipv6" : "ipv4");
}

/**
 * Report §12.1 optional per-role restrictions. Every limit applies (owner, 2026-10-26): each of the user's roles that has
 * limits must allow the sign-in, now and from this network; a role without limits adds nothing. So no extra role ever
 * lifts a limit Security set (before, "any role allows" let one; review 2026-10-25). The owner is never restricted
 * (checked by caller).
 */
export function checkLoginRestrictions(a: {
  roles: RoleRestriction[];
  ip: string;
  now: Date;
  timezone: string;
  /** Settings' working hours: a role set to "Business hours" follows them at this moment (6A ruling R5). */
  workingHours?: WorkingHours;
}): "ok" | "ip" | "hours" {
  for (const r of a.roles) {
    if (r.ipAllowlist?.length && !ipAllowed(a.ip, r.ipAllowlist)) return "ip";
    if (r.loginHours) {
      const { day, hm } = localParts(a.now, a.timezone);
      const h =
        r.loginHours.business && a.workingHours
          ? { days: a.workingHours.days, from: a.workingHours.start, to: a.workingHours.end }
          : r.loginHours;
      if (!h.days.includes(day) || hm < h.from || hm >= h.to) return "hours";
    }
  }
  return "ok";
}
