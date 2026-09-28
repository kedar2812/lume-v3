import { ALL_GRANTS, newId, type Grant } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OutgoingMail } from "../../mail/mailer";
import { createHarness, type Harness } from "../../../test/harness";
import { runDigests } from "./digest";

let h: Harness;
const repGrants: Grant[] = (["leads.view", "leads.edit"] as const).map((key) => ({
  key,
  scope: "own" as const,
}));
const sent: OutgoingMail[] = [];
const mailer = { send: async (m: OutgoingMail) => void sent.push(m) };
const run = (now: string, m = mailer) =>
  runDigests({ pool: h.pool, mailer: m, publicUrl: "https://crm.example.test" }, new Date(now));
const to = (email: string) => sent.filter((m) => m.to === email);

/** A person in a timezone with one follow-up already overdue (so their digest has something in it). */
async function person(tz: string, o: { alerts?: Record<string, boolean>; grants?: Grant[] } = {}) {
  const u = await h.seedUser({
    grants: o.grants ?? repGrants,
    totp: true,
    email: `${newId().slice(-8)}@people.test`,
  });
  await h.ownerPool.query("UPDATE users SET timezone = $2 WHERE id = $1", [u.id, tz]);
  if (o.alerts)
    await h.ownerPool.query(
      "UPDATE users SET preferences = jsonb_build_object('alerts', $2::jsonb) WHERE id = $1",
      [u.id, JSON.stringify({ assigned: true, dueFollowUps: true, emailDigest: true, ...o.alerts })],
    );
  const lead = await h.seedLead({
    ownerId: u.id,
    name: "Aisha Khan",
    phone: "+971507654321",
    email: "aisha.secret@leads.test",
  });
  const id = newId();
  await h.queryAll(
    "INSERT INTO tasks (id, lead_id, assignee_id, title, due_at, series_id) VALUES ($1, $2, $3, 'Call back', '2026-09-27T06:00:00Z', $1)",
    [id, lead, u.id],
  );
  return u;
}

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
});
afterAll(() => h.close());

describe("the daily digest (3B Task 4)", () => {
  it("Review Focus 1: at 08:00 in each person's own morning, once for their own date", async () => {
    const kolkata = await person("Asia/Kolkata");
    const dubai = await person("Asia/Dubai");
    const london = await person("Europe/London");
    await run("2026-09-28T02:31:00Z"); // Monday: 08:01 Kolkata, 06:31 Dubai, 03:31 London
    expect(to(kolkata.email)).toHaveLength(1);
    expect(to(dubai.email)).toHaveLength(0);
    await run("2026-09-28T02:46:00Z");
    expect(to(kolkata.email)).toHaveLength(1); // once a day
    await run("2026-09-28T04:05:00Z"); // 08:05 Dubai
    expect(to(dubai.email)).toHaveLength(1);
    await run("2026-09-28T07:05:00Z"); // 08:05 London (BST)
    expect(to(london.email)).toHaveLength(1);
    expect(to(kolkata.email)).toHaveLength(1);
  });

  it("not at weekends, and not for someone who switched it off", async () => {
    const weekend = await person("Asia/Kolkata");
    await run("2026-10-03T03:00:00Z"); // Saturday 08:30 in Kolkata
    expect(to(weekend.email)).toHaveLength(0);
    const off = await person("Asia/Kolkata", { alerts: { emailDigest: false } });
    await run("2026-09-29T03:00:00Z");
    expect(to(off.email)).toHaveLength(0);
  });

  it("first names and times only: never a phone number or an email", async () => {
    const u = await person("Asia/Kolkata");
    await run("2026-09-30T03:00:00Z");
    const [m] = to(u.email);
    expect(m!.text).toContain("Aisha");
    expect(m!.text).not.toContain("Khan");
    for (const body of [m!.text, m!.html]) {
      expect(body).not.toMatch(/7654321|aisha\.secret/);
    }
    expect(m!.text).toContain("https://crm.example.test/today");
  });

  it("Review Focus 5: a mail that fails is sent next time, and only once", async () => {
    const u = await person("Asia/Kolkata");
    const broken = { send: async () => Promise.reject(new Error("SMTP down")) };
    await run("2026-10-01T03:00:00Z", broken);
    expect(to(u.email)).toHaveLength(0);
    await run("2026-10-01T03:15:00Z");
    await run("2026-10-01T03:30:00Z");
    expect(to(u.email)).toHaveLength(1);
  });

  it("an admin's digest also has what needs them", async () => {
    const admin = await person("Asia/Kolkata", { grants: ALL_GRANTS });
    await h.seedLead({ ownerId: null, name: "Nobody's Yet" });
    await run("2026-10-02T03:00:00Z");
    const [m] = to(admin.email);
    expect(m!.text).toMatch(/new leads? (has|have) no one yet/);
  });
});
