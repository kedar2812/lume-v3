import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";

/**
 * Working hours are the sign-in hours of every role set to "Business hours" (6A ruling R5). Changing them is changing
 * those roles' access: it may not lock out the person saving, as Settings → Security already refuses (review
 * 2026-10-25).
 */
let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());

const ALL_DAY = { days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" };

async function today(): Promise<number> {
  const { rows } = await h.pool.query<{ timezone: string }>("SELECT timezone FROM settings WHERE id = 1");
  const name = new Intl.DateTimeFormat("en-GB", { timeZone: rows[0]!.timezone, weekday: "short" }).format(
    h.clock.now,
  );
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

describe("working hours, as sign-in hours", () => {
  it("won't save hours that would sign out the person saving them; anyone else's hours aren't theirs to check", async () => {
    await h.ownerPool.query("UPDATE settings SET working_hours = $1 WHERE id = 1", [JSON.stringify(ALL_DAY)]);
    const u = await h.seedUser({ grants: [{ key: "settings.manage", scope: null }], totp: true });
    await h.ownerPool.query(
      `UPDATE roles SET login_hours = '{"business": true, "days": [0,1,2,3,4,5,6], "from": "00:00", "to": "23:59"}'
        WHERE id IN (SELECT role_id FROM user_roles WHERE user_id = $1)`,
      [u.id],
    );
    const c = await h.signIn(u);
    const d = await today();
    const elsewhere = { ...ALL_DAY, days: [(d + 1) % 7] };
    const r = await c.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      payload: { workingHours: elsewhere },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toEqual({
      code: "WOULD_LOCK_YOU_OUT",
      message: "Saving this would sign you out: your sign-in hours follow these working hours.",
    });
    const kept = await h.pool.query("SELECT working_hours FROM settings WHERE id = 1");
    expect(kept.rows[0].working_hours).toEqual(ALL_DAY);
    // Hours that still include now are saved.
    const fine = await c.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      payload: { workingHours: { ...ALL_DAY, days: [d, (d + 1) % 7] } },
    });
    expect(fine.statusCode, fine.body).toBe(200);
    await h.ownerPool.query("UPDATE settings SET working_hours = $1 WHERE id = 1", [JSON.stringify(ALL_DAY)]);
  });

  it("the owner, never restricted at sign-in, changes working hours freely, even with a business-hours role", async () => {
    await h.ownerPool.query("UPDATE settings SET working_hours = $1 WHERE id = 1", [JSON.stringify(ALL_DAY)]);
    const u = await h.seedUser({
      owner: true,
      grants: [{ key: "settings.manage", scope: null }],
      totp: true,
    });
    await h.ownerPool.query(
      `UPDATE roles SET login_hours = '{"business": true, "days": [0,1,2,3,4,5,6], "from": "00:00", "to": "23:59"}'
        WHERE id IN (SELECT role_id FROM user_roles WHERE user_id = $1)`,
      [u.id],
    );
    const c = await h.signIn(u);
    const d = await today();
    const r = await c.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      payload: { workingHours: { ...ALL_DAY, days: [(d + 1) % 7] } },
    });
    expect(r.statusCode, r.body).toBe(200);
    await h.ownerPool.query("UPDATE settings SET working_hours = $1 WHERE id = 1", [JSON.stringify(ALL_DAY)]);
  });

  it("someone whose sign-in hours are their own, not the business's, can change working hours freely", async () => {
    const u = await h.seedUser({ grants: [{ key: "settings.manage", scope: null }], totp: true });
    const c = await h.signIn(u);
    const d = await today();
    const r = await c.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      payload: { workingHours: { ...ALL_DAY, days: [(d + 1) % 7] } },
    });
    expect(r.statusCode, r.body).toBe(200);
    await h.ownerPool.query("UPDATE settings SET working_hours = $1 WHERE id = 1", [JSON.stringify(ALL_DAY)]);
  });
});
