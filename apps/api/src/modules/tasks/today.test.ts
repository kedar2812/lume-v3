import { ALL_GRANTS, newId, type Grant } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";

let h: Harness;
const H = 3_600_000;
const repGrants: Grant[] = (["leads.view", "leads.edit"] as const).map((key) => ({
  key,
  scope: "own" as const,
}));

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
});
afterAll(() => h.close());

/** A person in a timezone, with follow-ups due at these offsets from the harness's now (in hours). */
async function person(tz: string, due: number[], done = 0) {
  const u = await h.seedUser({ grants: repGrants, totp: true });
  await h.queryAll("UPDATE users SET timezone = $2 WHERE id = $1", [u.id, tz]);
  const lead = await h.seedLead({ ownerId: u.id, name: `Lead of ${tz}` });
  const now = h.clock.now.getTime();
  for (const [i, off] of [
    ...due.map((d) => [d, false] as const),
    ...Array.from({ length: done }, () => [-1, true] as const),
  ].entries()) {
    const id = newId();
    await h.queryAll(
      `INSERT INTO tasks (id, lead_id, assignee_id, title, due_at, series_id, status, done_at, done_by)
       VALUES ($1, $2, $3, $4, $5, $1, $6, $7, $8)`,
      [
        id,
        lead,
        u.id,
        `Task ${i}`,
        new Date(now + off[0] * H),
        off[1] ? "done" : "open",
        off[1] ? h.clock.now : null,
        off[1] ? u.id : null,
      ],
    );
  }
  return h.signIn(u);
}
const today = async (c: AuthedClient) => (await c.inject({ method: "GET", url: "/api/v1/today" })).json();
const titles = (xs: { title: string }[]) => xs.map((x) => x.title);

describe("Today (Phase 3 spec §6)", () => {
  // The harness's now is 2026-09-21 09:00Z: 13:00 in Dubai, 14:30 in Kolkata.
  it("groups in the person's own day: overdue, due within two hours, later today", async () => {
    const dubai = await person("Asia/Dubai", [-3, 1, 5, 10.5, 30]); // +10.5h is 23:30 in Dubai: still today
    const t = await today(dubai);
    expect(titles(t.overdue)).toEqual(["Task 0"]);
    expect(titles(t.soon)).toEqual(["Task 1"]);
    expect(titles(t.later)).toEqual(["Task 2", "Task 3"]); // tomorrow's isn't on Today
    expect(t.overdue[0]).toMatchObject({ leadName: "Lead of Asia/Dubai" });
  });

  it("the same instant is a different day in Kolkata", async () => {
    const kolkata = await person("Asia/Kolkata", [10.5]); // 01:00 tomorrow in Kolkata
    expect(titles((await today(kolkata)).later)).toEqual([]);
  });

  it("counts what's done today toward the day's progress", async () => {
    const t = await today(await person("Asia/Dubai", [1, 2], 3));
    expect(t).toMatchObject({ done: 3, total: 5 });
  });

  it("admins also see what needs them; a rep doesn't", async () => {
    const admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
    await h.seedLead({ ownerId: null, name: "Nobody's Yet" });
    const a = await today(admin);
    expect(a.needsYou.unassigned).toBeGreaterThanOrEqual(1);
    expect(a.needsYou.sources).toEqual([]);
    expect((await today(await person("Asia/Dubai", []))).needsYou).toBeUndefined();
  });

  it("admins who look after security see open alerts there too (frontend spec §8.2)", async () => {
    const someone = await h.seedUser({ grants: [] });
    await h.ownerPool.query(
      `INSERT INTO security_alerts (id, user_id, rule, observed, threshold, window_start, window_end, action)
       VALUES (gen_random_uuid(), $1, 'reveals', 31, 30, now() - interval '50 minutes', now(), 'alerted')`,
      [someone.id],
    );
    const admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
    expect((await today(admin)).needsYou.alerts).toBe(1);
    const leadsOnly = await h.signIn(await h.seedUser({ grants: [{ key: "leads.view", scope: "all" }] }));
    expect((await today(leadsOnly)).needsYou.alerts).toBe(0);
  });
});
