import pg from "pg";
import { ALL_GRANTS, newId } from "@lume/core";
import { adminUrl } from "@lume/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startCalendlyFake, type CalendlyFake } from "../../../test/calendly-fake";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../../../test/harness";

/** Schedule a meeting on Calendly (owner 2026-11-27: "allow lume to schedule calls in calendly"). */
let h: Harness;
let fake: CalendlyFake;
let admin: SeededUser;
let adminC: AuthedClient;
let viewer: AuthedClient;
let host: SeededUser;
let sourceId: string;
const DISC = "https://api.calendly.com/event_types/DISC";
const HOUR = 3_600_000;
const at = (hours: number) =>
  new Date(Math.ceil(h.clock.now.getTime() / HOUR) * HOUR + hours * HOUR).toISOString();

beforeAll(async () => {
  fake = await startCalendlyFake();
  h = await createHarness({ preset: "coaching", calendlyEndpoint: fake.url });
  admin = await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Ada Admin" });
  adminC = await h.signIn(admin);
  host = await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Hana Host" });
  viewer = await h.signIn(await h.seedUser({ grants: [{ key: "leads.view", scope: "all" }], totp: true }));
  expect(
    (
      await adminC.inject({
        method: "POST",
        url: "/api/v1/integrations/calendly",
        payload: { token: fake.token },
      })
    ).statusCode,
  ).toBe(200);
  sourceId = (await h.ownerPool.query<{ id: string }>("SELECT id FROM lead_sources WHERE type = 'calendly'"))
    .rows[0]!.id;
});
afterAll(async () => {
  await h.close();
  await fake.close();
});
beforeEach(async () => {
  fake.links = [
    {
      uri: DISC,
      name: "Discovery call",
      duration: 30,
      owner: "Ada Admin",
      locations: [{ kind: "google_conference" }],
      free: [at(26), at(27), at(50)],
    },
  ];
  fake.bookings.length = 0;
  fake.cancelled.length = 0;
  await adminC.inject({
    method: "PATCH",
    url: "/api/v1/integrations/calendly",
    payload: { links: [DISC], bookWith: DISC },
  });
});
const options = (leadId?: string) =>
  adminC.inject({
    method: "GET",
    url: `/api/v1/meetings/schedule/calendly${leadId ? `?leadId=${leadId}` : ""}`,
  });
const book = (leadId: string, startsAt: string, c = adminC) =>
  c.inject({ method: "POST", url: "/api/v1/meetings/schedule/calendly", payload: { leadId, startsAt } });
const meetingsOf = (leadId: string) =>
  h.queryAll<{ source: string; matched_by: string; external_id: string; title: string; link: string | null }>(
    "SELECT source, matched_by, external_id, title, link FROM meetings WHERE lead_id = $1",
    [leadId],
  );

/** Past row-level security (the test database's superuser): a meeting as Calendly's post would leave it. */
async function asSuper(sql: string, params: unknown[]) {
  const u = new URL(adminUrl());
  u.pathname = new URL(h.url("lume_owner")).pathname;
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try {
    await c.query(sql, params);
  } finally {
    await c.end();
  }
}

describe("Schedule a meeting on Calendly", () => {
  it("ready: the booking link, and its own free times for two weeks", async () => {
    const lead = await h.seedLead({ ownerId: admin.id, name: "Meera Shah", email: "meera@leads.test" });
    const r = (await options(lead)).json();
    expect(r.ready).toEqual({ ready: true, link: { name: "Discovery call", duration: 30 } });
    expect(r.times).toEqual([at(26), at(27), at(50)]);
  });

  it("books the lead in Calendly, as Calendly needs it, and keeps the meeting on the lead at once", async () => {
    const lead = await h.seedLead({ ownerId: admin.id, name: "Meera Shah", email: "meera@leads.test" });
    const r = await book(lead, at(26));
    expect(r.statusCode).toBe(201);
    expect(fake.bookings).toHaveLength(1);
    expect(fake.bookings[0]!.body).toMatchObject({
      event_type: DISC,
      start_time: at(26),
      invitee: { name: "Meera Shah", email: "meera@leads.test" },
      location: { kind: "google_conference" },
    });
    expect(await meetingsOf(lead)).toEqual([
      {
        source: "calendly",
        matched_by: "lume",
        external_id: fake.bookings[0]!.uri,
        title: "Discovery call",
        link: null,
      },
    ]);
    expect(r.json().meeting).toMatchObject({ title: "Discovery call", matchedBy: "lume" });
    const rows = await h.queryAll("SELECT 1 FROM activities WHERE lead_id = $1 AND type = 'meeting_booked'", [
      lead,
    ]);
    expect(rows).toHaveLength(1);
  });

  it("Calendly's post about a booking LUME made: no second meeting, no new lead; it brings the join link", async () => {
    const lead = await h.seedLead({ ownerId: admin.id, name: "Ravi Iyer", email: "ravi@leads.test" });
    await book(lead, at(27));
    const b = fake.bookings[0]!;
    const sub = fake.subscriptions[0]!;
    const { headers, payload } = fake.signed(
      sub,
      {
        event: "invitee.created",
        created_at: new Date().toISOString(),
        payload: {
          email: "ravi@leads.test",
          name: "Ravi Iyer",
          uri: b.uri,
          status: "active",
          questions_and_answers: [],
          scheduled_event: {
            uri: b.event,
            event_type: DISC,
            name: "Discovery call",
            start_time: at(27),
            end_time: new Date(Date.parse(at(27)) + 30 * 60_000).toISOString(),
            location: { type: "google_conference", join_url: "https://meet.example/ravi" },
            event_memberships: [{ user_email: admin.email }],
          },
        },
      },
      h.clock.now.getTime(),
    );
    expect(
      (await h.app.inject({ method: "POST", url: new URL(sub.callbackUrl).pathname, headers, payload }))
        .statusCode,
    ).toBe(202);
    await h.runWebhooks();
    const m = await meetingsOf(lead);
    expect(m).toHaveLength(1);
    expect(m[0]!.link).toBe("https://meet.example/ravi");
    const rows = await h.queryAll<{ n: number }>(
      "SELECT count(*)::int AS n FROM leads WHERE email = 'ravi@leads.test'",
    );
    expect(rows[0]!.n).toBe(1);
  });

  // Review 2026-11-28: Calendly's post can be handled before LUME's own booking is kept.
  it("Calendly's post got there first: LUME's booking finds its meeting, never a second one, never cancels it", async () => {
    const lead = await h.seedLead({ ownerId: admin.id, name: "Asha Rao", email: "asha@leads.test" });
    fake.nextBookingId = "RACE1";
    const uri = "https://api.calendly.com/scheduled_events/EVRACE1/invitees/INRACE1";
    await asSuper(
      `INSERT INTO meetings (id, lead_id, owner_id, source, external_id, matched_by, title, starts_at, ends_at, status)
       VALUES ($1, $2, $3, 'calendly', $4, 'calendly', 'Discovery call', $5, $5::timestamptz + interval '30 minutes', 'scheduled')`,
      [newId(), lead, host.id, uri, at(50)],
    );
    const r = await book(lead, at(50));
    expect(r.statusCode).toBe(201);
    expect(await meetingsOf(lead)).toHaveLength(1);
    expect(fake.cancelled).toEqual([]);
  });

  it("a time taken in Calendly meanwhile: said, nothing kept", async () => {
    const lead = await h.seedLead({ ownerId: admin.id, email: "late@leads.test" });
    const r = await book(lead, at(30));
    expect([r.statusCode, r.json().error.code]).toEqual([409, "CALENDLY_TIME_TAKEN"]);
    expect(await meetingsOf(lead)).toEqual([]);
  });

  it("a lead with no email: not ready, said in words; booking is refused and Calendly is never asked", async () => {
    const lead = await h.seedLead({ ownerId: admin.id, name: "Phone Only", phone: "+971501234567" });
    const r = (await options(lead)).json();
    expect(r.ready).toMatchObject({ ready: false, why: "no_email" });
    expect(r.ready.message).toBe(
      "Phone has no email, and Calendly needs one to book. Add it to the lead, or book on Google Calendar.",
    );
    expect((await book(lead, at(26))).statusCode).toBe(409);
    expect(fake.bookings).toEqual([]);
  });

  it("no booking link chosen: not ready, and where an admin chooses one", async () => {
    await adminC.inject({
      method: "PATCH",
      url: "/api/v1/integrations/calendly",
      payload: { bookWith: null },
    });
    const r = (await options()).json();
    expect(r.ready).toMatchObject({ ready: false, why: "no_link" });
    expect(r.ready.message).toMatch(/Settings → Integrations → Calendly/);
  });

  it("the link turned off in Calendly since: not ready, says so", async () => {
    fake.links[0]!.active = false;
    const lead = await h.seedLead({ ownerId: admin.id, email: "gone@leads.test" });
    expect((await options(lead)).json().ready).toMatchObject({ ready: false, why: "link_gone" });
  });

  // Review 2026-11-28: every drawer and the Calendar ask whether Calendly can book; that never costs a Calendly call.
  it("no lead yet: ready from LUME's own settings alone, Calendly never asked", async () => {
    const before = fake.calls.length;
    expect((await options()).json()).toEqual({ ready: { ready: true, link: null }, times: [] });
    expect(fake.calls.length).toBe(before);
  });

  it("someone who may see the Calendar but not schedule (no calendar.connect) can't book either", async () => {
    const seer = await h.signIn(
      await h.seedUser({
        grants: [
          { key: "leads.view", scope: "all" },
          { key: "calendar.view", scope: "all" },
        ],
        totp: true,
      }),
    );
    const lead = await h.seedLead({ ownerId: admin.id, email: "seer@leads.test" });
    expect((await book(lead, at(26), seer)).statusCode).toBe(403);
    expect(fake.bookings).toEqual([]);
  });

  it("someone who doesn't see the Calendar can't book", async () => {
    const lead = await h.seedLead({ ownerId: admin.id, email: "nope@leads.test" });
    expect((await book(lead, at(26), viewer)).statusCode).toBe(403);
    expect(fake.bookings).toEqual([]);
  });

  it("a time already gone by is refused before Calendly is asked", async () => {
    const lead = await h.seedLead({ ownerId: admin.id, email: "past@leads.test" });
    const r = await book(lead, new Date(h.clock.now.getTime() - HOUR).toISOString());
    expect(r.json().error.code).toBe("MEETING_PAST");
    expect(fake.bookings).toEqual([]);
  });
  void sourceId;
});
