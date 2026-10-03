import { ALL_GRANTS, newId, type Grant } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../../../test/harness";

/** Phase 6C Task 3: Security activity — today's tiles, contacts opened per person, who is signed in now. */
let h: Harness;
let admin: AuthedClient;
let adminUser: SeededUser;
let tzWas: string;
const sales: Grant[] = [
  { key: "leads.view", scope: "own" },
  { key: "leads.contact.reveal", scope: "own" },
];
const TZ = "Asia/Dubai";

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true, name: "Maya Kapoor" });
  adminUser = await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Hana Ito" });
  admin = await h.signIn(adminUser);
  tzWas = (await h.ownerPool.query("SELECT timezone FROM settings WHERE id = 1")).rows[0].timezone;
  await h.ownerPool.query("UPDATE settings SET timezone = $1 WHERE id = 1", [TZ]);
});
afterAll(async () => {
  await h.ownerPool.query("UPDATE settings SET timezone = $1 WHERE id = 1", [tzWas]);
  await h.close();
});

const activity = async () => {
  const r = await admin.inject({ method: "GET", url: "/api/v1/security/activity" });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
/** `n` audit rows by `who`, each on its own lead unless `lead` is given, `mins` from the start of the business's day. */
async function acts(who: string, action: string, n: number, mins: number, lead?: string) {
  await h.ownerPool.query(
    `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, at)
     SELECT $3, $4, 'lead', coalesce($5::uuid, gen_random_uuid()), (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1) + make_interval(mins => $2) FROM generate_series(1, $6)`,
    [TZ, mins, who, action, lead ?? null, n],
  );
}
const DAY = 24 * 60;

describe("Security activity (6C Task 3)", () => {
  it("buckets days on the business's clock: a reveal at 23:30 in Dubai counts on that Dubai day (Review Focus 5)", async () => {
    const late = await h.seedUser({ grants: sales, name: "Lena Late" });
    // Yesterday, 23:30 Dubai: thirty minutes before today began there.
    await acts(late.id, "lead.contact.reveal", 2, -30);
    const a = await activity();
    const row = a.reveals.find((p: { id: string }) => p.id === late.id);
    expect(row.days).toHaveLength(14);
    expect(row.days[12]).toBe(2);
    expect(row.days[13]).toBe(0);
    expect(row.total).toBe(2);
  });

  it("today's tiles: contacts opened and by how many, leads opened against the usual, exports, failed sign-ins", async () => {
    const rory = await h.seedUser({ grants: sales, name: "Rory Reid" });
    const sam = await h.seedUser({ grants: sales, name: "Sam Okafor" });
    const lead = newId();
    // Rory opens 3 different contacts (one twice), Sam 2: 5 contacts by 2 people.
    await acts(rory.id, "lead.contact.reveal", 2, 1);
    await acts(rory.id, "lead.contact.reveal", 2, 2, lead);
    await acts(sam.id, "lead.contact.reveal", 2, 3);
    // Leads opened: 4 a day for the last 14 days, 12 today.
    for (let d = 1; d <= 14; d++) await acts(sam.id, "lead.view", 4, -d * DAY + 120);
    await acts(sam.id, "lead.view", 12, 4);
    // One export this week, by Hana.
    await h.ownerPool.query(
      `INSERT INTO lead_exports (id, user_id, code, label, format, columns, row_count, check_name, check_email,
                                 check_phone, check_position, expires_at)
       VALUES ($1, $2, 'PX7Q-4MRA', 'All leads', 'csv', '{name}', 3, 'Ana Bell', 'ana.bell.0a1b2c@example.invalid',
               '+447700900123', 1, now() + interval '1 day')`,
      [newId(), adminUser.id],
    );
    // Two failed sign-ins for Rory today, then he signs in.
    await h.ownerPool.query(
      `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, at)
       VALUES (NULL, 'user.login.failed', 'user', $4, (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1) + make_interval(mins => $2)),
              (NULL, 'user.login.failed', 'user', $4, (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1) + make_interval(mins => $2) + interval '1 minute'),
              ($3::uuid, 'user.login', 'user', $4, (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1) + make_interval(mins => $2) + interval '2 minutes')`,
      [TZ, 5, rory.id, rory.id],
    );
    const t = (await activity()).today;
    expect(t.reveals).toEqual({ count: 5, people: 2 });
    expect(t.leadsOpened).toEqual({ count: 12, usual: 4 });
    expect(t.exports).toEqual({ count: 1, by: "Hana Ito" });
    expect(t.failedSignIns).toEqual({ count: 2, name: "Rory Reid", thenSignedIn: true });
    expect(t.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("contacts opened per person: the top six over 14 days, today last, an alert today marked", async () => {
    const people: SeededUser[] = [];
    for (let i = 0; i < 7; i++) {
      const u = await h.seedUser({ grants: sales, name: `Top ${String.fromCharCode(65 + i)}` });
      await acts(u.id, "lead.contact.reveal", 20 + i, -3 * DAY);
      people.push(u);
    }
    const busiest = people[6]!;
    await acts(busiest.id, "lead.contact.reveal", 4, 10);
    await h.ownerPool.query(
      `INSERT INTO security_alerts (id, user_id, rule, observed, threshold, window_start, window_end, action)
       VALUES ($1, $2, 'reveals', 31, 30, now() - interval '1 hour', now(), 'alerted')`,
      [newId(), busiest.id],
    );
    const r = (await activity()).reveals as {
      id: string;
      name: string;
      role: string | null;
      total: number;
      days: number[];
      alertToday: boolean;
    }[];
    expect(r).toHaveLength(6);
    expect(r.map((x) => x.total)).toEqual([...r.map((x) => x.total)].sort((a, b) => b - a));
    expect(r[0]).toMatchObject({ id: busiest.id, total: 30, alertToday: true });
    expect(r[0]!.days[13]).toBe(4);
    expect(r[0]!.days[10]).toBe(26);
    expect(r.find((x) => x.id === people[0]!.id)).toBeUndefined();
    expect(r.filter((x) => x.id !== busiest.id).every((x) => !x.alertToday)).toBe(true);
  });

  it("who is signed in now: live sessions, newest first, yours marked; ended ones never", async () => {
    const priya = await h.seedUser({ grants: sales, name: "Priya Lal" });
    await h.signIn(priya);
    const gone = await h.seedUser({ grants: sales, name: "Gone Person" });
    await h.signIn(gone);
    await h.ownerPool.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1", [gone.id]);
    const s = (await activity()).sessions as {
      userId: string;
      name: string;
      device: string;
      since: string;
      you: boolean;
    }[];
    expect(s.find((x) => x.userId === adminUser.id)).toMatchObject({ name: "Hana Ito", you: true });
    expect(s.find((x) => x.userId === priya.id)).toMatchObject({ name: "Priya Lal", you: false });
    expect(s.find((x) => x.userId === gone.id)).toBeUndefined();
    const times = s.map((x) => Date.parse(x.since));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});
