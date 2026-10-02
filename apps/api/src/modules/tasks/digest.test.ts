import { ALL_GRANTS, newId, type Grant } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Mailer, OutgoingMail } from "../../mail/mailer";
import { createHarness, type Harness } from "../../../test/harness";
import { runDigests } from "./digest";

let h: Harness;
const repGrants: Grant[] = (["leads.view", "leads.edit"] as const).map((key) => ({
  key,
  scope: "own" as const,
}));
const sent: OutgoingMail[] = [];
const mailer: Mailer = { send: async (m: OutgoingMail) => void sent.push(m) };
const run = (now: string, m: Mailer = mailer) =>
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
  return { ...u, lead };
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

  it("overdue from earlier today reads as its time; from an earlier day, with the day", async () => {
    const u = await person("Asia/Kolkata");
    const id = newId();
    await h.queryAll(
      "INSERT INTO tasks (id, lead_id, assignee_id, title, due_at, series_id) VALUES ($1, $2, $3, 'Send the plan', '2026-10-05T02:00:00Z', $1)",
      [id, u.lead, u.id],
    );
    await run("2026-10-05T03:00:00Z"); // Monday 08:30 in Kolkata
    const [m] = to(u.email);
    expect(m!.text).toContain("Aisha: Call back (27 Sep 11:30)"); // more than six days ago: its date
    expect(m!.text).toContain("Aisha: Send the plan (07:30)");
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

  it("6A: a security admin's digest says how many alerts need them, with a link; a rep's never", async () => {
    const secAdmin = await person("Asia/Dubai", { grants: [{ key: "security.manage", scope: null }] });
    const rep = await person("Asia/Dubai");
    for (let i = 0; i < 2; i++)
      await h.ownerPool.query(
        `INSERT INTO security_alerts (id, user_id, rule, observed, threshold, window_start, window_end, action)
         VALUES ($1, $2, 'reveals', 31, 30, now() - interval '50 minutes', now(), 'suspended')`,
        [newId(), rep.id],
      );
    await run("2026-10-05T04:00:00Z"); // Monday, 08:00 in Dubai
    const [m] = to(secAdmin.email);
    expect(m!.text).toContain("2 security alerts need you https://crm.example.test/settings/security");
    expect(to(rep.email)[0]!.text).not.toMatch(/security alert/);
    await h.ownerPool.query("DELETE FROM security_alerts WHERE user_id = $1", [rep.id]);
  });

  it("within the week, an overdue follow-up says its weekday", async () => {
    const u = await person("Asia/Kolkata");
    await run("2026-09-29T03:00:00Z"); // Tuesday 08:30; the follow-up was Sunday 11:30
    expect(to(u.email)[0]!.text).toContain("Aisha: Call back (Sun 11:30)");
  });

  it("Review Focus 1, exactly: 23:30 on someone's day before, in the same UTC hour as Kolkata's 08:00", async () => {
    const kolkata = await person("Asia/Kolkata");
    const saoPaulo = await person("America/Sao_Paulo"); // UTC-3
    await run("2026-10-06T02:31:00Z"); // Tuesday 08:01 in Kolkata; Monday 23:31 in São Paulo
    expect(to(kolkata.email)).toHaveLength(1);
    expect(to(saoPaulo.email)).toHaveLength(1); // Monday's, late in their own Monday
    await run("2026-10-06T03:00:00Z");
    expect(to(saoPaulo.email)).toHaveLength(1);
    await run("2026-10-06T11:05:00Z"); // Tuesday 08:05 in São Paulo: Tuesday's
    expect(to(saoPaulo.email)).toHaveLength(2);
    expect(to(kolkata.email)).toHaveLength(1);
  });
});

describe("the daily digest: 3B final review", () => {
  it("Important 1: two runs at once send one mail per person", async () => {
    const u = await person("Asia/Kolkata");
    const slow = {
      send: async (m: OutgoingMail) => {
        await new Promise((r) => setTimeout(r, 200));
        sent.push(m);
      },
    };
    await Promise.all([run("2026-10-07T03:00:00Z", slow), run("2026-10-07T03:00:00Z", slow)]);
    expect(to(u.email)).toHaveLength(1);
  });

  it("Important 6: a follow-up's own words never carry a phone number or an email out", async () => {
    const u = await person("Asia/Kolkata");
    const id = newId();
    await h.queryAll(
      "INSERT INTO tasks (id, lead_id, assignee_id, title, due_at, series_id) VALUES ($1, $2, $3, 'Call +971 50 765 4321 or aisha.secret@leads.test', '2026-10-08T02:00:00Z', $1)",
      [id, u.lead, u.id],
    );
    await run("2026-10-08T03:00:00Z");
    const [m] = to(u.email);
    expect(m!.text).toContain("Aisha: Call");
    // Links carry ids (random hex, which can hold "765"): the words are what's checked.
    for (const body of [m!.text, m!.html])
      expect(body.replace(/https?:\/\/[^\s"'<>]+/g, "")).not.toMatch(/765|4321|aisha\.secret|@leads/);
  });

  it("Important 7: someone LUME can't read doesn't stop anyone else's", async () => {
    const broken = await person("Asia/Kolkata");
    await h.ownerPool.query("UPDATE users SET timezone = 'Nowhere/Invalid' WHERE id = $1", [broken.id]);
    const fine = await person("Asia/Kolkata");
    const logged: unknown[] = [];
    await runDigests(
      {
        pool: h.pool,
        mailer,
        publicUrl: "https://crm.example.test",
        log: { error: (o: unknown) => void logged.push(o) },
      },
      new Date("2026-10-09T03:00:00Z"),
    );
    expect(to(fine.email)).toHaveLength(1);
    expect(JSON.stringify(logged)).toContain(broken.id);
    await h.ownerPool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [broken.id]);
  });

  it("Important 8: switched off for everyone in Settings, or with no mail server, nobody gets one", async () => {
    const u = await person("Asia/Kolkata");
    await h.ownerPool.query(
      `UPDATE settings SET follow_ups = follow_ups || '{"digest":{"enabled":false}}'::jsonb WHERE id = 1`,
    );
    await run("2026-10-12T03:00:00Z");
    expect(to(u.email)).toHaveLength(0);
    await h.ownerPool.query(
      `UPDATE settings SET follow_ups = follow_ups || '{"digest":{"enabled":true}}'::jsonb WHERE id = 1`,
    );
    const unconfigured = { configured: false, send: async (m: OutgoingMail) => void sent.push(m) };
    await run("2026-10-12T03:15:00Z", unconfigured);
    expect(to(u.email)).toHaveLength(0);
    await run("2026-10-12T03:30:00Z");
    expect(to(u.email)).toHaveLength(1);
  });

  it("each item leads to its lead in LUME, and new leads for you are named (first names)", async () => {
    const u = await person("Asia/Kolkata");
    const given = await h.seedLead({ ownerId: u.id, name: "Ravi Mehta" });
    await h.queryAll(
      "INSERT INTO lead_assignment_history (lead_id, to_user_id, changed_at) VALUES ($1, $2, '2026-10-05T01:00:00Z')",
      [given, u.id],
    );
    await run("2026-10-05T03:00:00Z"); // Monday 08:30 in Kolkata
    const [m] = to(u.email);
    expect(m!.text).toContain(`https://crm.example.test/leads?lead=${u.lead}`);
    expect(m!.html).toContain(`href="https://crm.example.test/leads?lead=${u.lead}"`);
    expect(m!.text).toMatch(/New for you\n- Ravi/);
    expect(m!.text).not.toContain("Mehta");
  });

  it("a digest time in the last quarter hour of the day still goes, just after midnight", async () => {
    const u = await person("Asia/Kolkata");
    await h.ownerPool.query(
      `UPDATE users SET preferences = preferences || '{"digestTime":"23:50"}'::jsonb WHERE id = $1`,
      [u.id],
    );
    await run("2026-10-06T18:15:00Z"); // Tuesday 23:45 in Kolkata: not yet
    expect(to(u.email)).toHaveLength(0);
    await run("2026-10-06T18:30:00Z"); // Wednesday 00:00: Tuesday's, which the 15-minute runs stepped over
    expect(to(u.email)).toHaveLength(1);
    await run("2026-10-06T18:45:00Z");
    expect(to(u.email)).toHaveLength(1);
  });

  it("a digest that goes late in the day doesn't say good morning", async () => {
    const u = await person("Asia/Kolkata");
    await run("2026-10-08T08:30:00Z"); // Thursday 14:00 in Kolkata (LUME was down all morning)
    const [m] = to(u.email);
    expect(m!.text).toMatch(/^Good afternoon, /);
    expect(m!.text).not.toContain("Good morning");
  });
});
