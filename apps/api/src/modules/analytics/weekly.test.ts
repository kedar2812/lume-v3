import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OutgoingMail } from "../../mail/mailer";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { reference, seedFixture, FIXTURE_TZ, type Fixture } from "../../../test/fixtures/analytics";
import { rollupDays } from "./rollup";
import { runWeekly } from "./weekly";

let h: Harness;
let fx: Fixture;
let admin: SeededUser;
let quiet: SeededUser;
const sent: OutgoingMail[] = [];
const mailer = { configured: true, send: async (m: OutgoingMail) => void sent.push(m) };
// Monday June 29, 10:00 in Kolkata: last week is June 22–28.
const MONDAY = new Date("2026-06-29T04:30:00Z");

beforeAll(async () => {
  h = await createHarness();
  fx = await seedFixture(h);
  admin = await h.seedUser({
    name: "Maya Kapoor",
    grants: [
      { key: "analytics.view", scope: "all" },
      { key: "leads.view", scope: "all" },
    ],
  });
  quiet = await h.seedUser({ grants: [{ key: "analytics.view", scope: "all" }] });
  // Saved before the weekly switch existed: no answer for it, so it's on.
  await h.ownerPool.query("UPDATE users SET preferences = $2 WHERE id = $1", [
    admin.id,
    { alerts: { assigned: true, dueFollowUps: true, emailDigest: true } },
  ]);
  await h.ownerPool.query(
    `UPDATE users SET preferences = '{"alerts":{"weeklyAnalytics":false}}' WHERE id = $1`,
    [quiet.id],
  );
  const days: string[] = [];
  for (let t = Date.UTC(2026, 4, 25); t <= Date.UTC(2026, 6, 5); t += 86_400_000)
    days.push(new Date(t).toISOString().slice(0, 10));
  await rollupDays(h.pool, days, FIXTURE_TZ);
}, 240_000);
afterAll(async () => h.close());

describe("the Monday email (8B)", () => {
  it("goes at 09:00 on Mondays to those who see all analytics, once, with last week's numbers and no lead's details", async () => {
    const d = { pool: h.pool, mailer, publicUrl: "https://lume.test" };
    expect(await runWeekly(d, new Date("2026-06-29T03:00:00Z"))).toBe(0); // 08:30 there: not yet
    expect(await runWeekly(d, new Date("2026-06-30T04:30:00Z"))).toBe(0); // a Tuesday
    expect(await runWeekly(d, MONDAY)).toBeGreaterThanOrEqual(1); // the admin, and the owner the install began with
    expect(await runWeekly(d, MONDAY)).toBe(0); // once a week
    const mail = sent.find((m) => m.to === (admin as { email: string }).email)!;
    expect(mail.subject).toMatch(/^Last week at .+: New leads \d+/);
    const want = reference("2026-06-22", "2026-06-28", null);
    expect(mail.text).toContain(`Good morning, Maya. Here's last week (June 22 – 28).`);
    expect(mail.text).toContain(`- New leads ${want.new_leads}`);
    expect(mail.text).toContain(`- Won ${want.won}`);
    expect(mail.text).toMatch(/follow-ups? (is|are) overdue now|No follow-ups are overdue/);
    expect(mail.text).not.toMatch(/Fixture Lead|@|\+\d{6}/); // aggregates only
    expect(sent.map((m) => m.to)).not.toContain((quiet as { email: string }).email);
    for (const p of fx.people) expect(sent.map((m) => m.to)).not.toContain((p as { email: string }).email); // own reach
  });
});
